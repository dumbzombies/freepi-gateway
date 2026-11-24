// Unit tests for the translation and cache modules — the edge cases the
// end-to-end worker tests cannot reach cheaply.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AnthropicStreamTranslator, countInputTokens, mapStopReason, translateAnthropicRequest } from "../src/translate.ts";
import { ResponseCache } from "../src/cache.ts";
import { AccountPool, isSessionTooLong } from "../src/pool.ts";

describe("Anthropic request translation", () => {
  it("maps Claude family names onto free catalog slots", () => {
    const t = translateAnthropicRequest(null, {
      model: "claude-3-5-haiku-latest",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(t.model, "deepseek-v4-flash"); // haiku slot fallback
    assert.equal(t.body.max_tokens, 10);
    assert.equal(t.body.model, t.model);
  });

  it("accepts free-pi ids and freepi/ prefixes verbatim", () => {
    const t = translateAnthropicRequest(null, {
      model: "freepi/glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(t.model, "glm-5.3-flash");
  });

  it("hoists system prompts and preserves tool_result ordering", () => {
    const t = translateAnthropicRequest(null, {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }, { type: "text", text: "what is it?" }] },
      ],
      system: "sys",
    });
    const messages = t.body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].role, "tool");
    assert.equal(messages[2].role, "user");
  });

  it("counts input tokens across system, messages and tools", () => {
    const n = countInputTokens({
      system: "abcd", // 1 token
      messages: [{ role: "user", content: "abcdabcd" }], // 2 + 4 message overhead
      tools: [{ name: "f", input_schema: { type: "object" } }],
    });
    assert.ok(n > 5);
  });
});

describe("stop reason mapping", () => {
  it("prefers max_tokens over tool_use", () => {
    assert.equal(mapStopReason("length", true), "max_tokens");
    assert.equal(mapStopReason("tool_calls", false), "tool_use");
    assert.equal(mapStopReason("stop", false), "end_turn");
    assert.equal(mapStopReason(null, false), "end_turn");
  });
});

describe("Anthropic stream translator", () => {
  it("drops frames that arrive after [DONE]", () => {
    const t = new AnthropicStreamTranslator("m", 10);
    let out = t.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    out += t.push("data: [DONE]\n\n");
    out += t.push('data: {"choices":[{"delta":{"content":"LATE"}}]}\n\n');
    out += t.finish();
    const stop = out.indexOf("event: message_stop");
    assert.ok(stop !== -1);
    assert.equal(out.indexOf("LATE", stop), -1);
  });

  it("still processes a trailing data line with no final newline", () => {
    const t = new AnthropicStreamTranslator("m", 10);
    let out = t.push('data: {"choices":[{"delta":{"content":"tail"}}]}\n\n');
    out += t.push('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}');
    out += t.finish();
    assert.match(out, /"input_tokens":5,"output_tokens":2/);
    assert.match(out, /event: message_stop/);
  });

  it("buffers tool call deltas into one sequential block", () => {
    const t = new AnthropicStreamTranslator("m", 10);
    let out = t.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\""}}]}}]}\n\n');
    out += t.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n');
    out += t.push("data: [DONE]\n\n");
    assert.match(out, /"name":"f"/);
    assert.match(out, /"partial_json":"{\\"a\\":1}"/);
    const start = out.indexOf("content_block_start");
    const stop = out.indexOf("content_block_stop");
    assert.ok(start !== -1 && stop > start);
  });
});

describe("response cache", () => {
  it("returns null keys for non-JSON bodies", async () => {
    const c = new ResponseCache({ enabled: true });
    assert.equal(await c.key("not json {"), null);
    assert.ok(await c.key('{"a":1}'));
  });

  it("serves a stored payload and never calls produce again", async () => {
    const c = new ResponseCache({ enabled: true });
    const key = (await c.key('{"n":1}'))!;
    const produce = async () => ({
      status: 200,
      ctype: "application/json",
      upstream: new Response('{"n":1}', { status: 200 }),
      cacheable: true,
    });
    const first = await c.run(key, produce);
    assert.equal(first.hit, false);
    const payload = await first.done;
    assert.ok(payload);
    const second = await c.run(key, produce);
    assert.equal(second.hit, true);
    assert.deepEqual((second as { payload: { body: Uint8Array } }).payload.body, new TextEncoder().encode('{"n":1}'));
  });

  it("expires entries past the TTL", async () => {
    let now = 1000;
    const c = new ResponseCache({ enabled: true, ttlMs: 500, now: () => now });
    const key = (await c.key('{"t":1}'))!;
    const produce = async () => ({
      status: 200,
      ctype: "application/json",
      upstream: new Response('{"t":1}', { status: 200 }),
      cacheable: true,
    });
    const first = await c.run(key, produce);
    await first.done;
    now = 1001; // within TTL
    assert.equal((await c.run(key, produce)).hit, true);
    now = 2000; // past TTL
    assert.equal((await c.run(key, produce)).hit, false);
  });

  it("coalesces concurrent identical requests onto one produce", async () => {
    const c = new ResponseCache({ enabled: true });
    const key = (await c.key('{"s":1}'))!;
    let calls = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const produce = async () => {
      calls++;
      await gate;
      return { status: 200, ctype: "application/json", upstream: new Response('{"s":1}', { status: 200 }), cacheable: true };
    };
    const first = c.run(key, produce);
    const second = c.run(key, produce); // must join the in-flight build
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(a.hit, false);
    assert.equal(b.hit, true);
  });
});

describe("session classification and pool parsing", () => {
  it("treats session-exhaustion as rotatable and concurrent_session as not", () => {
    assert.ok(isSessionTooLong(400, "session is too long: 130000 > 80000"));
    assert.ok(!isSessionTooLong(409, "concurrent_session: all 4 slots occupied"));
    assert.ok(!isSessionTooLong(200, "session is too long"));
  });

  it("parses the token pool from every documented shape", () => {
    const tokens = AccountPool.tokensOf({
      FREEPI_TOKENS: '["jwt-1","jwt-2"]',
      FREEPI_TOKEN: "jwt-3",
      FREEPI_TOKEN_ALT: "jwt-4",
    });
    assert.deepEqual(tokens, ["jwt-1", "jwt-2", "jwt-3", "jwt-4"]);
    const deduped = AccountPool.tokensOf({ FREEPI_TOKENS: "jwt-1 jwt-1\n,jwt-2" });
    assert.deepEqual(deduped, ["jwt-1", "jwt-2"]);
  });
});

// Anthropic SSE translation edge cases. The translator turns OpenAI chunks
// into a strict Anthropic event sequence; agent clients (Claude Code) break if
// block indices, ordering, or stop reasons drift.

import { test } from "bun:test";
import assert from "node:assert/strict";
import { AnthropicStreamTranslator, mapStopReason, toAnthropicResponse } from "../src/anthropic.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Ev { event?: string; data: Json }

/** Read a nested value from parsed SSE JSON without trusting its shape. */
function at(value: Json, ...path: Array<string | number>): Json {
  let cur: Json = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return null;
    cur = Array.isArray(cur) ? (cur[Number(key)] ?? null) : (cur[key] ?? null);
  }
  return cur;
}

function parse(sse: string): Ev[] {
  return sse.split("\n\n").filter((b) => b.trim()).map((block) => {
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const raw = lines.find((l) => l.startsWith("data: "))?.slice(6);
    return { event, data: raw ? JSON.parse(raw) as Json : null };
  });
}

function chunk(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

const names = (events: Ev[], name: string): Ev[] => events.filter((e) => e.event === name);

test("text stream emits a valid, ordered event sequence", () => {
  const t = new AnthropicStreamTranslator("claude-test", 100);
  const events = parse(
    t.push(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] })) +
      t.push(chunk({ choices: [{ index: 0, delta: { content: "lo" } }] })) +
      t.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })) +
      t.finish(),
  );
  assert.deepEqual(events.map((e) => e.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(at(events[0]!.data, "message", "role"), "assistant");
  assert.equal(at(events[0]!.data, "message", "usage", "input_tokens"), 100);
  assert.equal(at(events[2]!.data, "delta", "text"), "Hel");
  assert.equal(at(events[3]!.data, "delta", "text"), "lo");
  assert.equal(at(events[5]!.data, "delta", "stop_reason"), "end_turn");
  assert.equal(at(events[5]!.data, "usage", "input_tokens"), 100);
});

test("a tool call split across chunks becomes one tool_use block", () => {
  const t = new AnthropicStreamTranslator("m", 0);
  const out =
    t.push(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "" } }] } }] })) +
    t.push(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file' } }] } }] })) +
    t.push(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"a"}' } }] } }] })) +
    t.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })) +
    t.finish();
  const events = parse(out);
  const start = events.find((e) => e.event === "content_block_start" && at(e.data, "content_block", "type") === "tool_use");
  assert.ok(start, "tool_use block start");
  assert.equal(at(start!.data, "content_block", "name"), "Read");
  assert.equal(at(start!.data, "content_block", "id"), "call_1");
  const delta = events.find((e) => e.event === "content_block_delta" && at(e.data, "delta", "type") === "input_json_delta");
  assert.deepEqual(JSON.parse(String(at(delta!.data, "delta", "partial_json"))), { file_path: "a" });
  const stop = names(events, "content_block_stop")[0];
  assert.equal(at(stop!.data, "index"), at(start!.data, "index"));
  assert.equal(at(names(events, "message_delta")[0]!.data, "delta", "stop_reason"), "tool_use");
  assert.equal(events.filter((e) => at(e.data, "content_block", "type") === "tool_use").length, 1);
});

test("parallel tool calls keep index order and distinct blocks", () => {
  const t = new AnthropicStreamTranslator("m");
  const out =
    t.push(chunk({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "c0", function: { name: "A", arguments: "{}" } },
      { index: 1, id: "c1", function: { name: "B", arguments: '{"x":1}' } },
    ] } }] })) +
    t.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })) +
    t.finish();
  const starts = parse(out).filter((e) => e.event === "content_block_start");
  assert.deepEqual(starts.map((s) => at(s.data, "content_block", "name")), ["A", "B"]);
  assert.deepEqual(starts.map((s) => at(s.data, "index")), [0, 1]);
});

test("text before a tool call closes its block first", () => {
  const t = new AnthropicStreamTranslator("m");
  const out =
    t.push(chunk({ choices: [{ index: 0, delta: { content: "thinking" } }] })) +
    t.push(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "X", arguments: "{}" } }] } }] })) +
    t.finish();
  const events = parse(out);
  const textStart = events.findIndex((e) => e.event === "content_block_start" && at(e.data, "content_block", "type") === "text");
  const textIndex = at(events[textStart]!.data, "index");
  const textStop = events.findIndex((e) => e.event === "content_block_stop" && at(e.data, "index") === textIndex);
  const toolStart = events.findIndex((e) => e.event === "content_block_start" && at(e.data, "content_block", "type") === "tool_use");
  assert.ok(textStart < textStop && textStop < toolStart, `order ${textStart}/${textStop}/${toolStart}`);
  assert.equal(at(events[toolStart]!.data, "index"), Number(textIndex) + 1);
});

test("usage-only chunks update the final message_delta without duplicating start", () => {
  const t = new AnthropicStreamTranslator("m", 7);
  const out =
    t.push(chunk({ choices: [{ index: 0, delta: { content: "hi" } }] })) +
    t.push(chunk({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 9 } })) +
    t.finish();
  const events = parse(out);
  assert.equal(names(events, "message_start").length, 1);
  const msgDelta = names(events, "message_delta")[0]!;
  assert.equal(at(msgDelta.data, "usage", "input_tokens"), 42);
  assert.equal(at(msgDelta.data, "usage", "output_tokens"), 9);
});

test("malformed data lines are ignored and finish still closes the stream", () => {
  const t = new AnthropicStreamTranslator("m");
  const out = t.push("data: {not json\n\n") + t.push(chunk({ choices: [{ index: 0, delta: { content: "ok" } }] })) + t.finish();
  const events = parse(out);
  assert.equal(events[0]!.event, "message_start");
  assert.equal(events.at(-1)!.event, "message_stop");
});

test("finish is idempotent and [DONE] finishes once", () => {
  const t = new AnthropicStreamTranslator("m");
  const first = t.push(chunk({ choices: [{ index: 0, delta: { content: "x" } }] })) +
    t.push("data: [DONE]\n\n");
  const second = t.finish();
  assert.equal(second, "");
  assert.equal(names(parse(first), "message_stop").length, 1);
});

test("stop reasons map to Anthropic vocabulary", () => {
  assert.equal(mapStopReason("stop", false), "end_turn");
  assert.equal(mapStopReason("length", false), "max_tokens");
  assert.equal(mapStopReason("tool_calls", true), "tool_use");
  assert.equal(mapStopReason("content_filter", false), "end_turn");
  assert.equal(mapStopReason(null, true), "tool_use");
});

test("non-stream translation carries text, tool calls and stop reason", () => {
  const res = toAnthropicResponse({
    choices: [{
      message: {
        content: "done",
        tool_calls: [{ id: "c1", function: { name: "Bash", arguments: '{"cmd":"ls"}' } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }, "claude-x") as unknown as Json;
  assert.equal(at(res, "type"), "message");
  assert.equal(at(res, "role"), "assistant");
  assert.equal(at(res, "model"), "claude-x");
  assert.equal(at(res, "content", 0, "type"), "text");
  assert.equal(at(res, "content", 0, "text"), "done");
  assert.equal(at(res, "content", 1, "type"), "tool_use");
  assert.equal(at(res, "content", 1, "name"), "Bash");
  assert.deepEqual(at(res, "content", 1, "input"), { cmd: "ls" });
  assert.equal(at(res, "stop_reason"), "tool_use");
  assert.equal(at(res, "usage", "input_tokens"), 5);
  assert.equal(at(res, "usage", "output_tokens"), 2);
});

test("empty response still yields one text block", () => {
  const res = toAnthropicResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }, "claude-x") as unknown as Json;
  assert.equal(at(res, "content").length, 1);
  assert.equal(at(res, "content", 0, "type"), "text");
  assert.equal(at(res, "content", 0, "text"), "");
  assert.equal(at(res, "stop_reason"), "end_turn");
});

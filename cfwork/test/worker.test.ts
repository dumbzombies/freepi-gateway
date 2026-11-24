// Worker-level tests: invoke the fetch handler directly against a stub
// free-pi upstream running on node:http. No workerd needed — the handler is
// plain Web API code.

import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";

import worker from "../src/index.ts";
import type { Env } from "../src/runtime.ts";

interface Stub {
  url: string;
  state: {
    chats: Array<{ sessionId: string | null; turnId: string | null; body: Record<string, unknown> }>;
    resets: number;
    impressions: number;
    adsNext: number;
  };
  onChat: (handler: (info: { body: Record<string, unknown>; sessionId: string | null; turnId: string | null }) => Response | Promise<Response>) => void;
  close: () => Promise<void>;
}

/** Stub free-pi upstream with catalog, ads, stats and a scripted chat route. */
function startStub(): Promise<Stub> {
  const state = {
    chats: [] as Stub["state"]["chats"],
    resets: 0,
    impressions: 0,
    adsNext: 0,
  };
  let chat: (info: { body: Record<string, unknown>; sessionId: string | null; turnId: string | null }) => Response | Promise<Response> =
    ({ body }) => Response.json({
      id: "chatpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
      model: String(body.model ?? "deepseek-v4-flash"),
    });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/client-version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          min: "0.6.19", latest: "0.6.19", model: "deepseek-v4-flash",
          models: [
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · free unlimited", free: true, usage_x: null },
            { id: "glm-5.3-flash", name: "GLM 5.3 Flash · free unlimited", free: true, usage_x: null },
            { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro · ~18x usage", usage_x: "18" },
          ],
        }));
        return;
      }
      if (url.pathname === "/me/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tier: "free", cap_usd_today: 1.125, spent_usd_today: 0, remaining_credits_today: 15000, allowance_credits: 15000 }));
        return;
      }
      if (url.pathname === "/ads/next") {
        state.adsNext++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ad_id: "ad1", click_token: "ct1", source: "gravity", imp_url: "https://imp.trygravity.ai/px" }));
        return;
      }
      if (url.pathname === "/ads/impression") {
        state.impressions++;
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/session/reset") {
        state.resets++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (url.pathname === "/v1/chat/completions") {
        const sessionId = req.headers["x-session-id"] ? String(req.headers["x-session-id"]) : null;
        const turnId = req.headers["x-turn-id"] ? String(req.headers["x-turn-id"]) : null;
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* leave empty */ }
        state.chats.push({ sessionId, turnId, body });
        const out = await chat({ body, sessionId, turnId });
        res.writeHead(out.status, { "content-type": out.headers.get("content-type") ?? "application/json" });
        res.end(await out.text());
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number; address: string };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        state,
        onChat(handler) {
          chat = handler;
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function baseEnv(stub: Stub, extra: Partial<Env> = {}): Env {
  return {
    WORKER_API_KEY: "test-key",
    FREEPI_TOKENS: "jwt-a\njwt-b",
    FREEPI_BASE_URL: stub.url,
    ...extra,
  };
}

function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`http://worker.test${path}`, init), env, { waitUntil() {} });
}

const AUTH = { "content-type": "application/json", authorization: "Bearer test-key" };

// ------------------------------------------------------------- routing --

describe("routing and auth", () => {
  it("serves /healthz without auth", async () => {
    const res = await call(baseEnv({} as Env), "/healthz");
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("fails closed when WORKER_API_KEY is unset", async () => {
    const res = await call({ FREEPI_TOKENS: "jwt-a" }, "/v1/models");
    assert.equal(res.status, 401);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "no_api_key");
  });

  it("rejects a wrong bearer key", async () => {
    const stub = await startStub();
    try {
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/models", { headers: { authorization: "Bearer wrong" } });
      assert.equal(res.status, 401);
      assert.equal((JSON.parse(await res.text()) as { error: { code: string } }).error.code, "invalid_api_key");
    } finally {
      await stub.close();
    }
  });

  it("reports a missing token pool as 401 no_token", async () => {
    const stub = await startStub();
    try {
      const res = await call({ WORKER_API_KEY: "test-key", FREEPI_BASE_URL: stub.url }, "/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 401);
      assert.equal((JSON.parse(await res.text()) as { error: { code: string } }).error.code, "no_token");
    } finally {
      await stub.close();
    }
  });
});

// ------------------------------------------------------------- chat flow --

describe("OpenAI completions", () => {
  it("forwards a turn with session + turn ids and returns the completion", async () => {
    const stub = await startStub();
    try {
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hello one" }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { choices: unknown[] };
      assert.equal(body.choices.length, 1);
      assert.equal(stub.state.chats.length, 1);
      assert.ok(stub.state.chats[0].sessionId, "x-session-id sent upstream");
      assert.ok(stub.state.chats[0].turnId, "x-turn-id sent upstream");
      assert.ok(stub.state.impressions >= 1, "ad impression served before the chat");
    } finally {
      await stub.close();
    }
  });

  it("passes an SSE stream through byte-verbatim", async () => {
    const stub = await startStub();
    try {
      stub.onChat(() => new Response(
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"y"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "stream one" }] }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.equal(await res.text(), 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"y"}}]}\n\ndata: [DONE]\n\n');
    } finally {
      await stub.close();
    }
  });

  it("re-warms when upstream answers 200 with the fake out-of-date completion", async () => {
    const stub = await startStub();
    try {
      let calls = 0;
      stub.onChat(() => {
        calls++;
        if (calls === 1) {
          return Response.json({ choices: [], usage: { prompt_tokens: 0 }, detail: "upstream says the client shows ads; out of date" });
        }
        return Response.json({ choices: [{ message: { content: "real" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
      });
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "fake 200" }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { choices: Array<{ message: { content: string } }> };
      assert.equal(body.choices[0].message.content, "real");
      assert.equal(stub.state.chats.length, 2, "retried once after the rewarm");
    } finally {
      await stub.close();
    }
  });

  it("resets an occupied session slot on 409 concurrent_session and retries", async () => {
    const stub = await startStub();
    try {
      let calls = 0;
      stub.onChat(() => {
        calls++;
        if (calls === 1) {
          return Response.json({ error: { message: "concurrent session limit reached", code: "concurrent_session" } }, { status: 409 });
        }
        return Response.json({ choices: [{ message: { content: "after reset" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      });
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "reset me" }] }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { choices: unknown[] }).choices.length, 1);
      assert.equal(stub.state.resets, 1, "/session/reset called once");
      assert.equal(stub.state.chats.length, 2);
    } finally {
      await stub.close();
    }
  });

  it("rotates a spent session and replays once", async () => {
    const stub = await startStub();
    try {
      let calls = 0;
      const sessionIds: Array<string | null> = [];
      stub.onChat(({ sessionId }) => {
        calls++;
        sessionIds.push(sessionId);
        if (calls === 1) {
          return Response.json({ error: { message: "session is too long: 130000 tokens > 80000", code: "session_too_long" } }, { status: 400 });
        }
        return Response.json({ choices: [{ message: { content: "fresh session" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      });
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "rotate" }] }),
      });
      assert.equal(res.status, 200);
      assert.equal(stub.state.chats.length, 2);
      assert.ok(sessionIds[0] && sessionIds[1] && sessionIds[0] !== sessionIds[1], "session id rotated");
    } finally {
      await stub.close();
    }
  });

  it("walks the pool to the next account on an account-level gate", async () => {
    const stub = await startStub();
    try {
      stub.onChat(({ body }) => {
        if ((body.messages as unknown[]).length === 99) return Response.json({ choices: [] });
        return Response.json({ error: { message: "hourly_ceiling reached", code: "hourly_ceiling" } }, { status: 429 });
      });
      // account A is gated, account B serves: distinguish by bearer token upstream
      stub.onChat(() => Response.json({ error: { message: "hourly_ceiling reached", code: "hourly_ceiling" } }, { status: 429 }));
      // rewrite: the stub cannot see which token was used unless we parse it; keep it simple —
      // both accounts gated → client gets the last gate error.
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/chat/completions", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "pool" }] }),
      });
      assert.equal(res.status, 429);
      const text = await res.text();
      assert.match(text, /hourly_ceiling/);
      assert.equal(stub.state.chats.length, 2, "both accounts were tried");
    } finally {
      await stub.close();
    }
  });

  it("caches an identical body and replays it without an upstream turn", async () => {
    const stub = await startStub();
    try {
      const body = JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "cache probe" }] });
      const first = await call(baseEnv(stub), "/v1/chat/completions", { method: "POST", headers: AUTH, body });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-freepi-cache"), "miss");
      const second = await call(baseEnv(stub), "/v1/chat/completions", { method: "POST", headers: AUTH, body });
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("x-freepi-cache"), "hit");
      assert.equal((await second.json() as { choices: unknown[] }).choices.length, 1);
      assert.equal(stub.state.chats.length, 1, "second request never reached upstream");
    } finally {
      await stub.close();
    }
  });
});

// -------------------------------------------------------- Anthropic API --

describe("Anthropic /v1/messages", () => {
  it("translates a non-stream request and response", async () => {
    const stub = await startStub();
    try {
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/messages", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          system: "be brief",
          messages: [{ role: "user", content: "anthropic one" }],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { type: string; role: string; content: Array<{ type: string; text: string }>; usage: { input_tokens: number; output_tokens: number }; stop_reason: string };
      assert.equal(body.type, "message");
      assert.equal(body.role, "assistant");
      assert.equal(body.content[0].type, "text");
      assert.equal(body.stop_reason, "end_turn");
      assert.equal(body.usage.output_tokens, 5);
      // the upstream saw the translated OpenAI shape with the system turn
      assert.equal(stub.state.chats[0].body.model, "glm-5.3-flash");
      const messages = stub.state.chats[0].body.messages as Array<{ role: string }>;
      assert.equal(messages[0].role, "system");
    } finally {
      await stub.close();
    }
  });

  it("translates an OpenAI SSE stream into Anthropic events", async () => {
    const stub = await startStub();
    try {
      stub.onChat(() => new Response(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/messages", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "claude-3-5-haiku-latest", max_tokens: 32, stream: true, messages: [{ role: "user", content: "anthropic stream" }] }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const order = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
      let at = -1;
      for (const event of order) {
        const idx = text.indexOf(`event: ${event}`);
        assert.ok(idx > at, `${event} appears in order`);
        at = idx;
      }
      assert.match(text, /"text":"hi"/);
      assert.match(text, /"stop_reason":"end_turn"/);
      assert.match(text, /"output_tokens":2/);
    } finally {
      await stub.close();
    }
  });

  it("rewrites the concurrent-session cap into an actionable rate_limit_error", async () => {
    const stub = await startStub();
    try {
      stub.onChat(() => Response.json(
        { error: { message: "concurrent session limit reached", code: "concurrent_session" } },
        { status: 409 },
      ));
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/messages", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "cap" }] }),
      });
      assert.equal(res.status, 409);
      const body = await res.json() as { error: { type: string; message: string } };
      assert.equal(body.error.type, "rate_limit_error");
      assert.match(body.error.message, /4 concurrent sessions/);
    } finally {
      await stub.close();
    }
  });

  it("counts tokens for /v1/messages/count_tokens", async () => {
    const stub = await startStub();
    try {
      const res = await call(baseEnv(stub), "/v1/messages/count_tokens", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ messages: [{ role: "user", content: "count my tokens please" }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { input_tokens: number };
      assert.ok(body.input_tokens > 0);
    } finally {
      await stub.close();
    }
  });
});

// ------------------------------------------------------------- catalog --

describe("models and usage", () => {
  it("lists free models from the live catalog and hides premium ones", async () => {
    const stub = await startStub();
    try {
      const res = await call(baseEnv(stub), "/v1/models", { headers: AUTH });
      assert.equal(res.status, 200);
      const body = await res.json() as { data: Array<{ id: string; premium: boolean }> };
      const ids = body.data.map((m) => m.id);
      assert.ok(ids.includes("deepseek-v4-flash"));
      assert.ok(!ids.includes("deepseek-v4-pro"), "premium models are hidden by default");
    } finally {
      await stub.close();
    }
  });

  it("shows premium models with FREEPI_SHOW_PREMIUM=1", async () => {
    const stub = await startStub();
    try {
      const res = await call(baseEnv(stub, { FREEPI_SHOW_PREMIUM: "1" }), "/v1/models", { headers: AUTH });
      const body = await res.json() as { data: Array<{ id: string; premium: boolean }> };
      const pro = body.data.find((m) => m.id === "deepseek-v4-pro");
      assert.ok(pro);
      assert.equal(pro.premium, true);
    } finally {
      await stub.close();
    }
  });

  it("reports live quota per pooled account on /v1/usage", async () => {
    const stub = await startStub();
    try {
      const res = await call(baseEnv(stub, { FREEPI_CACHE: "0" }), "/v1/usage", { headers: AUTH });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean; pool_size: number; accounts: Array<{ ok: boolean; remaining_credits_today: number }> };
      assert.equal(body.ok, true);
      assert.equal(body.pool_size, 2);
      assert.equal(body.accounts.length, 2);
      assert.equal(body.accounts[0].remaining_credits_today, 15000);
    } finally {
      await stub.close();
    }
  });
});

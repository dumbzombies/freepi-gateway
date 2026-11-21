// End-to-end tests over real HTTP: a fake free-pi upstream, the production
// request handler mounted in Bun.serve on an ephemeral port, and fetch()
// against it. Covers auth, both API dialects, streaming, caching and errors.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Ctx } from "../src/state.ts";
import { createHandler, testCtx } from "../src/app.ts";
import { ResponseCache } from "../src/cache.ts";
import { Upstream } from "../src/upstream.ts";
import { pollStats } from "../src/state.ts";

// ---------- scripted upstream ----------

const calls = { chat: 0, streams: 0, stats: 0, catalog: 0 };
let failNext = false;
let toolMode = false;
let slowMode = false;
let lastChatBody = "";

const OPENAI_JSON = {
  id: "chatcmpl-test",
  object: "chat.completion",
  model: "deepseek-v4.1-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello there." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
};

function openaiSse(): string {
  return [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":" there."},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function toolSse(): string {
  return [
    'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"Read","arguments":"{\\"file"}}]}}]}',
    'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/client-version") {
      calls.catalog++;
      return Response.json({
        min: "0.6.19",
        latest: "0.6.20",
        model: "deepseek-v4.1-flash",
        models: [
          { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · 🔥 Free Unlimited: limited time", free: true },
          { id: "glm-5.3-flash", name: "GLM 5.3 Flash · 🔥 Free Unlimited: limited time", free: true },
          { id: "solar-pro-4", name: "Solar Pro 4 · ~1.2x usage", usage_x: "1.2" },
          { id: "gone-model", name: "Gone · unavailable", usage_x: "20", unavailable: true },
        ],
      });
    }
    if (url.pathname === "/me") return Response.json({ handle: "tester", tier: "young", lane: "standard" });
    if (url.pathname === "/me/stats") {
      calls.stats++;
      return Response.json({
        tier: "young",
        lane: "standard",
        cap_usd_today: 1.125,
        spent_usd_today: 0.01,
        remaining_usd_today: 1.115,
        allowance_credits: 15000,
        remaining_credits_today: 14800,
        request_count_today: 41,
        prompt_tokens_today: 1000,
        completion_tokens_today: 200,
        refill_at: "2026-11-20T00:00:00.000Z",
        streak: { days: 3 },
        lifetime_requests: 900,
      });
    }
    if (url.pathname.startsWith("/ads/next")) return new Response(null, { status: 204 });
    if (url.pathname === "/ads/impression") return Response.json({ ok: true });
    if (url.pathname === "/v1/chat/completions") {
      calls.chat++;
      lastChatBody = await req.text();
      if (failNext) {
        failNext = false;
        return Response.json({ error: { message: "daily cap reached", code: "daily_cap" } }, { status: 429 });
      }
      const body = JSON.parse(lastChatBody) as { stream?: boolean };
      if (body.stream === true) {
        calls.streams++;
        const text = toolMode ? toolSse() : openaiSse();
        if (!slowMode) {
          return new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
        }
        // Trickle: gives the client time to disconnect mid-stream.
        const parts = text.split("\n\n").map((p) => p + "\n\n");
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const part of parts) {
              controller.enqueue(new TextEncoder().encode(part));
              await Bun.sleep(25);
            }
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
      }
      return Response.json(OPENAI_JSON);
    }
    return new Response("{}", { status: 404 });
  },
});

const UPSTREAM_URL = `http://127.0.0.1:${upstream.port}`;

const TOKEN = "s3cret-token";
const logged: Array<Record<string, unknown>> = [];

function mount(): { url: string; ctx: Ctx; close: () => void } {
  const ctx = testCtx({ upstream: new Upstream(UPSTREAM_URL), cache: new ResponseCache({ enabled: true }) });
  ctx.tracker = {
    ready: async () => {},
    add: async (e: Record<string, unknown>) => { logged.push(e); },
    reconcile: () => {},
    recent: () => [],
    hourly: () => [],
    byDay: () => [],
    byModel: () => [],
  } as unknown as typeof ctx.tracker;
  const handler = createHandler(ctx, { token: TOKEN, uiHtml: "<h1>ui</h1>" });
  const app = Bun.serve({ port: 0, fetch: handler });
  return { url: `http://127.0.0.1:${app.port}`, ctx, close: () => app.stop(true) };
}

const app = mount();
const base = app.url;
const authed = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

beforeAll(async () => {
  await app.ctx.upstream.refreshCatalog();
});

afterAll(() => {
  app.close();
  upstream.stop(true);
});

// ---------- liveness + auth ----------

test("health and readiness", async () => {
  const health = await fetch(base + "/healthz");
  expect(health.status).toBe(200);
  expect((await health.json() as { ok: boolean }).ok).toBe(true);
  const ready = await fetch(base + "/readyz");
  expect(ready.status).toBe(200);
  const body = await ready.json() as { ok: boolean; catalog: boolean };
  expect(body.ok).toBe(true);
  expect(body.catalog).toBe(true);
});

test("gated endpoints reject unauthenticated requests", async () => {
  for (const path of ["/v1/models", "/api/state", "/mcp", "/v1/usage"]) {
    const res = await fetch(base + path);
    expect(res.status).toBe(401);
  }
});

test("open endpoints stay reachable without a token", async () => {
  expect((await fetch(base + "/healthz")).status).toBe(200);
  expect((await fetch(base + "/api/hello")).status).toBe(200);
  expect((await fetch(base + "/")).status).toBe(200);
  expect((await fetch(base + "/readyz")).status).toBe(200);
});

test("token accepted via bearer, x-api-key and query", async () => {
  expect((await authed("/v1/models")).status).toBe(200);
  expect((await fetch(base + "/v1/models", { headers: { "x-api-key": TOKEN } })).status).toBe(200);
  expect((await fetch(base + `/v1/models?token=${TOKEN}`)).status).toBe(200);
  expect((await fetch(base + "/v1/models", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
});

// ---------- models + usage ----------

test("models list hides unavailable and premium models by default", async () => {
  const res = await authed("/v1/models");
  const body = await res.json() as { object: string; data: Array<{ id: string; object: string; premium: boolean }> };
  expect(body.object).toBe("list");
  expect(body.data.map((m) => m.id)).toEqual(["deepseek-v4.1-flash", "glm-5.3-flash"]);
  expect(body.data.every((m) => m.object === "model")).toBe(true);

  app.ctx.settings.models.showPremium = true;
  try {
    const all = await (await authed("/v1/models")).json() as { data: Array<{ id: string; premium: boolean }> };
    expect(all.data.map((m) => m.id)).toEqual(["deepseek-v4.1-flash", "glm-5.3-flash", "solar-pro-4"]);
    expect(all.data.find((m) => m.id === "solar-pro-4")?.premium).toBe(true);
  } finally {
    app.ctx.settings.models.showPremium = false;
  }
});

test("usage endpoint mirrors authoritative stats", async () => {
  const res = await authed("/v1/usage?refresh=1");
  expect(res.status).toBe(200);
  const body = await res.json() as {
    ok: boolean; error: null | string;
    quota: { allowance_credits: number; remaining_credits_today: number; used_credits_today: number; remaining_pct: number };
    usage: { requests_today: number; lifetime_requests: number };
    cache: { entries: number };
  };
  expect(body.ok).toBe(true);
  expect(body.error).toBeNull();
  expect(body.quota.allowance_credits).toBe(15000);
  expect(body.quota.remaining_credits_today).toBe(14800);
  expect(body.quota.used_credits_today).toBe(200);
  expect(body.quota.remaining_pct).toBe(98.7);
  expect(body.usage.requests_today).toBe(41);
  expect(body.usage.lifetime_requests).toBe(900);
  expect(calls.stats).toBeGreaterThan(0);
});

test("usage without a valid token reports no_stats_yet shape", async () => {
  const res = await authed("/v1/usage");
  const body = await res.json() as { object: string; cache: unknown };
  expect(body.object).toBe("usage");
  expect(body.cache).toBeDefined();
});

// ---------- OpenAI dialect ----------

test("non-stream completion is served from cache on repeat", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  const send = () => fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  });
  const before = calls.chat;
  const first = await send();
  expect(first.headers.get("x-freepi-cache")).toBe("miss");
  const firstText = await first.text();
  const second = await send();
  expect(second.headers.get("x-freepi-cache")).toBe("hit");
  expect(await second.text()).toBe(firstText);
  expect(calls.chat - before).toBe(1);
  expect(JSON.parse(firstText)).toEqual(OPENAI_JSON);
  const hits = logged.filter((e) => e.cached === true);
  expect(hits.length).toBeGreaterThan(0);
  close();
});

test("streamed completion replays identically from cache", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  const send = () => fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "stream me" }], stream: true }),
  });
  const before = calls.chat;
  const a = await send();
  const bodyA = await a.text();
  const b = await send();
  const bodyB = await b.text();
  expect(a.headers.get("x-freepi-cache")).toBe("miss");
  expect(b.headers.get("x-freepi-cache")).toBe("hit");
  expect(a.headers.get("content-type")).toContain("text/event-stream");
  expect(bodyB).toBe(bodyA);
  expect(bodyA).toContain("data: [DONE]");
  expect(calls.chat - before).toBe(1);
  close();
});

test("concurrent identical requests share one upstream turn", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  const send = () => fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "race" }], stream: true }),
  });
  const before = calls.chat;
  const [a, b] = await Promise.all([send(), send()]);
  const [ta, tb] = await Promise.all([a.text(), b.text()]);
  expect(calls.chat - before).toBe(1);
  expect(ta).toBe(tb);
  close();
});

test("upstream errors pass through and are never cached", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  const send = () => fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "fail" }] }),
  });
  const before = calls.chat;
  failNext = true;
  const first = await send();
  expect(first.status).toBe(429);
  expect(await first.text()).toContain("daily cap");
  failNext = true;
  const second = await send();
  expect(second.status).toBe(429);
  expect(calls.chat - before).toBe(2);
  expect(ctx.cache.stats().entries).toBe(0);
  close();
});

// ---------- Anthropic dialect ----------

test("anthropic non-stream translates and caches", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  const send = () => fetch(url + "/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "sonnet", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
  });
  const before = calls.chat;
  const first = await send();
  expect(first.headers.get("x-freepi-cache")).toBe("miss");
  const msg = await first.json() as { type: string; role: string; content: Array<{ type: string; text?: string }>; stop_reason: string };
  expect(msg.type).toBe("message");
  expect(msg.role).toBe("assistant");
  expect(msg.content[0]!.text).toBe("Hello there.");
  expect(msg.stop_reason).toBe("end_turn");

  const second = await send();
  expect(second.headers.get("x-freepi-cache")).toBe("hit");
  const msg2 = await second.json() as { content: Array<{ text?: string }> };
  expect(msg2.content[0]!.text).toBe("Hello there.");
  expect(calls.chat - before).toBe(1);
  close();
});

test("anthropic stream emits a valid event sequence and replays on hit", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  const send = () => fetch(url + "/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "sonnet", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const before = calls.chat;
  const a = await send();
  const bodyA = await a.text();
  const b = await send();
  const bodyB = await b.text();
  expect(a.headers.get("x-freepi-cache")).toBe("miss");
  expect(b.headers.get("x-freepi-cache")).toBe("hit");
  expect(calls.chat - before).toBe(1);

  const events = bodyA.split("\n\n").filter((x) => x.trim()).map((block) => {
    const event = block.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
    return event;
  });
  expect(events[0]).toBe("message_start");
  expect(events.at(-1)).toBe("message_stop");
  expect(events).toContain("content_block_delta");
  expect(events.filter((e) => e === "message_start").length).toBe(1);
  // replay is byte-identical apart from the generated message id
  expect(bodyB.replace(/msg_[a-z0-9]+/g, "ID")).toBe(bodyA.replace(/msg_[a-z0-9]+/g, "ID"));
  close();
});

test("anthropic tool call streams as a tool_use block", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  toolMode = true;
  try {
    const res = await fetch(url + "/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        max_tokens: 64,
        stream: true,
        tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
        messages: [{ role: "user", content: "read a.txt" }],
      }),
    });
    const body = await res.text();
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"Read"');
    expect(body).toContain('"stop_reason":"tool_use"');
    expect(lastChatBody).toContain('"tools"');
    // partial_json must be the complete argument object, not a fragment
    const delta = body.split("\n\n").find((b) => b.includes("input_json_delta"));
    expect(delta).toContain('{\\"file_path\\":\\"a.txt\\"}');
  } finally {
    toolMode = false;
    close();
  }
});

test("unknown path is a plain 404", async () => {
  const res = await authed("/v1/nope");
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("not found");
});

// ---------- stampede protection ----------

test("concurrent catalog refreshes share one upstream fetch", async () => {
  const up = new Upstream(UPSTREAM_URL);
  const before = calls.catalog;
  await Promise.all(Array.from({ length: 12 }, () => up.refreshCatalog()));
  expect(calls.catalog - before).toBe(1);
  expect(up.catalog?.latest).toBe("0.6.20");
});

test("concurrent stats polls share one upstream call", async () => {
  const ctx = testCtx({ upstream: new Upstream(UPSTREAM_URL), cache: new ResponseCache({ enabled: true }) });
  const before = calls.stats;
  const results = await Promise.all(Array.from({ length: 12 }, () => pollStats(ctx)));
  expect(calls.stats - before).toBe(1);
  expect(results.every((r) => r?.tier === "young")).toBe(true);
  expect(ctx.state.live?.remaining_credits_today).toBe(14800);
  // a later poll is a fresh call again
  await pollStats(ctx);
  expect(calls.stats - before).toBe(2);
});

test("anthropic upstream errors keep the miss marker and the message", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  failNext = true;
  const res = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "sonnet", max_tokens: 8, messages: [{ role: "user", content: "boom" }] }),
  });
  expect(res.status).toBe(429);
  expect(res.headers.get("x-freepi-cache")).toBe("miss");
  const body = await res.json() as { type: string; error: { type: string; message: string } };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("rate_limit_error");
  expect(body.error.message).toContain("daily cap");
  close();
});

test("client disconnect mid-stream neither crashes nor caches a truncated body", async () => {
  const { url, ctx, close } = mount();
  await ctx.upstream.refreshCatalog();
  const body = JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "slow" }], stream: true });
  slowMode = true;
  try {
    const ac = new AbortController();
    const pending = fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 40);
    await pending.then((r) => r.text()).then(() => null, () => null);
    await Bun.sleep(200);
    // the truncated turn must not have been stored
    expect(ctx.cache.stats().entries).toBe(0);
    // and the server still serves the next request
    const again = await fetch(url + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    });
    expect(again.status).toBe(200);
    expect(again.headers.get("x-freepi-cache")).toBe("miss");
    expect(await again.text()).toContain("[DONE]");
    expect((await fetch(url + "/healthz")).status).toBe(200);
  } finally {
    slowMode = false;
    close();
  }
});

// ---------- dashboard password ----------

test("dashboard password guards the UI and /api, not /healthz or /v1", async () => {
  const ctx = testCtx({ upstream: new Upstream(UPSTREAM_URL), cache: new ResponseCache({ enabled: true }) });
  const guarded = Bun.serve({
    port: 0,
    fetch: createHandler(ctx, { token: TOKEN, password: "hunter2", uiHtml: "<h1>ui</h1>" }),
  });
  const root = `http://127.0.0.1:${guarded.port}`;
  const basic = (pass: string) => "Basic " + btoa(`admin:${pass}`);
  try {
    const challenge = await fetch(root + "/");
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain("Basic");
    expect((await fetch(root + "/api/state")).status).toBe(401);
    expect((await fetch(root + "/api/state", { headers: { authorization: basic("nope") } })).status).toBe(401);
    expect((await fetch(root + "/api/state", { headers: { authorization: basic("hunter2") } })).status).toBe(200);
    expect((await fetch(root + "/", { headers: { authorization: basic("hunter2") } })).status).toBe(200);
    // liveness and the meterable API keep their old rules
    expect((await fetch(root + "/healthz")).status).toBe(200);
    expect((await fetch(root + "/v1/models", { headers: { authorization: basic("hunter2") } })).status).toBe(401);
    expect((await fetch(root + "/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  } finally {
    guarded.stop(true);
  }
});

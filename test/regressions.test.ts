// Regression tests for defects found by bug-hunter (2026-11-23) and fixed in
// the same session. Each test fails against the old behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../src/state.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "pässwörd";

function basic(pw: string): Record<string, string> {
  return { authorization: "basic " + Buffer.from("user:" + pw, "utf8").toString("base64") };
}

/** Minimal free-pi upstream: device flow, consent, token poll, stats. */
async function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/auth/github/device") {
        return json({ session_id: "s1", user_code: "ABCD-1234", verification_uri: "https://example.test", interval: 5, expires_in: 60 });
      }
      if (req.url === "/auth/consent") return json({});
      if (req.url === "/auth/token") return json({ code: "authorization_pending" });
      if (req.url?.startsWith("/me/stats")) return json({ tier: "free", cap_usd_today: 1.125, spent_usd_today: 0 });
      if (req.url?.startsWith("/me")) return json({ handle: "tester" });
      if (req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(409, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "concurrent session limit reached", code: "concurrent_session" } }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  const listening = Promise.withResolvers<void>();
  srv.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const addr = srv.address() as { port: number }; // AddressInfo: server is listening on TCP
  const port = addr.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

/** Spawn the real proxy on an ephemeral port and wait until it answers. */
async function startProxy(upstreamUrl: string, credentials?: unknown): Promise<{ base: string; stop: () => void; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "freepi-regress-"));
  await mkdir(join(dir, "data"), { recursive: true });
  if (credentials !== undefined) {
    await writeFile(join(dir, "credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(ROOT, "src/main.ts")], {
    env: {
      ...process.env,
      FREEPI_BASE_URL: upstreamUrl,
      FREEPI_PROXY_PORT: String(port),
      FREEPI_DATA_DIR: join(dir, "data"),
      FREEPI_CREDENTIALS_PATH: join(dir, "credentials.json"),
      FREEPI_DASHBOARD_PASSWORD: PASSWORD,
      FREEPI_CACHE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base + "/api/hello");
      return { base, stop: () => child.kill("SIGKILL"), dir };
    } catch {
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 100); // real delay: waiting for a child process to bind its port
      await tick.promise;
    }
  }
  child.kill("SIGKILL");
  throw new Error("proxy did not start");
}

test("login/start returns 200 with a session payload", async () => {
  const stub = await startStub();
  const { base, stop, dir } = await startProxy(stub.url);
  try {
    const res = await fetch(base + "/api/login/start", { method: "POST", headers: basic(PASSWORD) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assert.equal(typeof body.ok, "boolean");
  } finally {
    stop();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dashboard password accepts non-ASCII passwords", async () => {
  const stub = await startStub();
  const { base, stop, dir } = await startProxy(stub.url);
  try {
    const res = await fetch(base + "/api/state", { headers: basic(PASSWORD) });
    assert.equal(res.status, 200);
  } finally {
    stop();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("usage log keeps one line per request under concurrent reconcile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freepi-track-"));
  process.env.FREEPI_DATA_DIR = dir;
  try {
    // Dynamic import: config.ts resolves DATA_DIR at import time, so the temp
    // env above must be set first.
    const { newTracker } = await import("../src/track.ts");
    const { REQUESTS_PATH } = await import("../src/config.ts");
    const tracker = newTracker();
    await tracker.ready();
    const N = 60;
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      jobs.push(tracker.add({
        ts: Date.now() - 1_000 - i, kind: "chat", model: "m", pt: 1, ct: 1,
        credits: 0.1, ms: 1, status: 200, source: "api",
      }));
      if (i % 3 === 0) tracker.reconcile(5, 0);
      if (i % 7 === 0) await Promise.resolve(); // let pending fs callbacks interleave
    }
    await Promise.all(jobs);
    const flush = Promise.withResolvers<void>();
    setTimeout(flush.resolve, 300); // rewrites are fire-and-forget; give them a fixed window
    await flush.promise;
    const lines = (await readFile(REQUESTS_PATH, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, N);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ad calls honour the Upstream baseUrl, not the global BASE_URL", async () => {
  const orig = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const { Upstream } = await import("../src/upstream.ts");
    const up = new Upstream("http://127.0.0.1:1");
    await up.fetchAdNext("jwt", "banner", "session");
    await up.postImpression("jwt", "ad", "click", "session");
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((u) => u.startsWith("http://127.0.0.1:1")), `unexpected hosts: ${seen.join(", ")}`);
  } finally {
    globalThis.fetch = orig;
  }
});

test("the ad cycle completes before the completion is sent", async () => {
  const events: string[] = [];
  const ctx = {
    state: {
      token: { token: "jwt", status: "ok", checkedAt: 0 }, sessionId: "session",
      live: null, liveAt: 0, startedAt: 0, lastCreditDiffAt: 0, lastCreditDiff: 0,
      notice: null, lastSettledUsd: null, lastSettleAt: 0,
    },
    upstream: {
      runAdCycle: async () => { events.push("ad-start"); await Promise.resolve(); events.push("ad-end"); },
      completions: async () => { events.push("completions"); return new Response("{}", { status: 200 }); },
    },
  } as unknown as Ctx;
  // Dynamic: the tracker test above sets FREEPI_DATA_DIR first, and state.ts
  // pulls in config.ts (which resolves paths at import).
  const { completeWithSessionRetry } = await import("../src/state.ts");
  await completeWithSessionRetry(ctx, "jwt", "{}", new AbortController().signal);
  assert.deepEqual(events, ["ad-start", "ad-end", "completions"]);
});

test("root upstream calls abort instead of hanging on a dead server", async () => {
  const orig = globalThis.fetch;
  const signals: Array<AbortSignal | undefined> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { Upstream } = await import("../src/upstream.ts");
    const { checkToken } = await import("../src/token.ts");
    await new Upstream("http://127.0.0.1:1").stats("jwt");
    await checkToken("jwt");
    assert.equal(signals.length, 2);
    assert.ok(signals.every((s) => s instanceof AbortSignal));
  } finally {
    globalThis.fetch = orig;
  }
});

test("both endpoints rewrite the 409 concurrent-session cap into an actionable error", async () => {
  const stub = await startStub();
  // The stub never completes the device flow; seed a token the proxy accepts.
  const { base, stop, dir } = await startProxy(stub.url, { token: "test-jwt" });
  try {
    const anthropic = await fetch(base + "/v1/messages", {
      method: "POST",
      headers: basic(PASSWORD),
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(anthropic.status, 409);
    const aBody = (await anthropic.json()) as { error?: { type?: string; message?: string } };
    assert.equal(aBody.error?.type, "rate_limit_error");
    assert.match(aBody.error?.message ?? "", /4 concurrent sessions/);

    const openai = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: basic(PASSWORD),
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(openai.status, 409);
    const oBody = (await openai.json()) as { error?: { code?: string; message?: string } };
    assert.equal(oBody.error?.code, "session_limit");
    assert.match(oBody.error?.message ?? "", /4 concurrent sessions/);
  } finally {
    stop();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

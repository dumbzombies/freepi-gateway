// Entry point for the always-on Bun build.
//
// Bun.serve handles both directions natively: the handler receives the client
// Request and returns a Response whose body may be a live upstream stream, so
// SSE is forwarded without a node:http hop, a body re-buffer, or a second copy.
//
// 24/7 behaviour: timers are cleared on shutdown, in-flight requests drain
// (server.stop), every loop is bounded by a fetch timeout, and neither an
// unhandled rejection nor a single bad request takes the process down.

import { BASE_URL, HOST, IDLE_TIMEOUT_S, MAX_BODY_BYTES, PORT, PROXY_TOKEN } from "./config.ts";
import { Upstream } from "./upstream.ts";
import { newTracker } from "./track.ts";
import { bootState, onLoginToken, startBackgroundLoops } from "./state.ts";
import type { Ctx } from "./state.ts";
import { ResponseCache } from "./cache.ts";
import { LoginManager } from "./token.ts";
import { startGravityPixel } from "./gravity.ts";
import { createHandler } from "./app.ts";
// Embedded at build time so `bun build --compile` ships a single file with the
// dashboard inside it (no runtime path lookup).
import uiHtml from "./ui.html" with { type: "text" };

const upstream = new Upstream();
const tracker = newTracker();
await tracker.ready();
const state = await bootState();
const cache = new ResponseCache();
let gravityGetter: (() => string | undefined) | undefined;
const ctx: Ctx = { upstream, tracker, state, cache, getGravityContext: () => gravityGetter?.() };

const login = new LoginManager();
login.onToken = (token: string) => {
  onLoginToken(ctx)(token);
  gravityGetter = startGravityPixel(token);
};
if (state.token.token) gravityGetter = startGravityPixel(state.token.token);

// Catalog first: /readyz should be truthful right after boot, and model ids are
// needed by the very first Claude Code request. A failure here is not fatal.
await upstream.refreshCatalog().catch(() => {});

const stopLoops = startBackgroundLoops(ctx, () => {});

const handler = createHandler(ctx, { uiHtml, login, token: PROXY_TOKEN });

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // Bun caps idleTimeout at 255s. Long SSE streams sit idle between tokens on
  // slow models; the default 10s would cut them.
  idleTimeout: IDLE_TIMEOUT_S,
  maxRequestBodySize: MAX_BODY_BYTES,
  // Keep-alive with a generous cap for agent clients that reuse connections.
  fetch: handler,
  error(err) {
    console.error(`[freepi-proxy] unhandled request error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return new Response(
      JSON.stringify({ error: { message: "proxy internal error", type: "freepi_proxy_error" } }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  },
});

// ---------- process-level resilience ----------

// A stray rejection must not kill a server that is holding live streams. Every
// background loop already catches its own errors; this is the last resort.
process.on("unhandledRejection", (reason) => {
  console.error(`[freepi-proxy] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[freepi-proxy] uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[freepi-proxy] ${signal}: draining`);
  stopLoops();
  login.stop();
  // Hard deadline so a stuck upstream stream cannot hold the process hostage.
  const kill = setTimeout(() => {
    console.error("[freepi-proxy] drain timed out; exiting");
    process.exit(1);
  }, 10_000);
  kill.unref?.();
  try {
    await server.stop();
  } catch { /* already stopped */ }
  clearTimeout(kill);
  console.log("[freepi-proxy] stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`freepi-proxy (bun)  →  http://${HOST}:${PORT}`);
console.log(`  completions : http://${HOST}:${PORT}/v1  (OpenAI-compatible)`);
console.log(`  messages    : http://${HOST}:${PORT}/v1/messages  (Anthropic-compatible)`);
console.log(`  usage       : http://${HOST}:${PORT}/v1/usage`);
console.log(`  health      : http://${HOST}:${PORT}/healthz  ready: /readyz`);
console.log(`  dashboard   : http://${HOST}:${PORT}`);
console.log(`  upstream    : ${BASE_URL}`);
if (PROXY_TOKEN) console.log("  auth        : bearer token required on /v1, /api, /mcp");
else if (HOST !== "127.0.0.1" && HOST !== "localhost") {
  console.warn("  ⚠ bound to a non-loopback address with no FREEPI_PROXY_TOKEN — anyone who can reach this port spends your allowance");
}
if (!state.token.token) console.log("  ⚠ no free-pi token — open the dashboard to log in");

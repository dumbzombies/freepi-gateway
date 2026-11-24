// HTTP surface for the always-on Bun build: one pure `fetch` handler over a
// Ctx, so it can be mounted by Bun.serve in production and by Bun.serve on an
// ephemeral port in tests. No node:http bridge, no body re-buffering.

import { ACCESS_LOG, DASHBOARD_PASSWORD, DASHBOARD_URL, PORT, PROXY_TOKEN } from "./config.ts";
import { Upstream } from "./upstream.ts";
import { newTracker } from "./track.ts";
import type { Ctx } from "./state.ts";
import { defaultSettings } from "./settings.ts";
import { isModelVisible, isPremiumOnly } from "./visibility.ts";
import { pollStats } from "./state.ts";
import { handleCompletions, handleModels, handleUsage } from "./proxy.ts";
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
  handleApiHello,
  handleClaudeConfig,
} from "./anthropic.ts";
import { handleMcp } from "./mcp.ts";
import type { LoginManager } from "./token.ts";

/** Endpoints that cost money, mutate state, or expose account data. */
const GATED_PREFIXES = ["/v1/", "/mcp", "/api/"] as const;
/** Never gated: liveness, the dashboard shell, and read-only probes. */
const OPEN_PATHS: Record<string, true> = {
  "/": true,
  "/index.html": true,
  "/healthz": true,
  "/readyz": true,
  "/api/hello": true,
  "/api/claude/config": true,
};

export interface HandlerOptions {
  /** Bearer token clients must present. Empty = open (loopback default). */
  token?: string;
  /** HTTP Basic password for the dashboard UI + /api/*. Empty = open. */
  password?: string;
  /** One line per request on stdout. */
  accessLog?: boolean;
  /** Login manager backing /api/login/*. Omitted in tests. */
  login?: LoginManager;
  /** Served for GET /. */
  uiHtml?: string;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function unauthorized(): Response {
  return json(
    401,
    { error: { message: "Missing or invalid proxy token.", type: "authentication_error", code: "unauthorized" } },
    { "www-authenticate": "Bearer" },
  );
}

/** Constant-time-ish compare; tokens are short and this is not a secret oracle
 * worth side channels, but do not leak length either. */
function tokenMatches(given: string | null, expected: string): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function presentedToken(req: Request, url: URL): string | null {
  const header = req.headers.get("authorization");
  if (header && /^bearer /i.test(header)) return header.slice(7).trim();
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const own = req.headers.get("x-freepi-token");
  if (own) return own.trim();
  return url.searchParams.get("token");
}

/** Routes that belong to the dashboard (Basic auth when a password is set). */
function isDashboardPath(path: string): boolean {
  if (path === "/" || path === "/index.html") return true;
  return path.startsWith("/api/") && !OPEN_PATHS[path];
}

/** `Authorization: Basic base64(user:password)`. The user is ignored. */
function basicOk(req: Request, password: string): boolean {
  const header = req.headers.get("authorization");
  if (!header || !/^basic /i.test(header)) return false;
  let decoded: string;
  try {
    // Credentials are UTF-8 on the wire; atob() would yield one char per byte
    // and a non-ASCII password could never match.
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  return colon >= 0 && tokenMatches(decoded.slice(colon + 1), password);
}

function basicChallenge(): Response {
  return json(
    401,
    { error: { message: "Dashboard password required.", type: "authentication_error", code: "unauthorized" } },
    { "www-authenticate": 'Basic realm="freepi-proxy", charset="UTF-8"' },
  );
}

export function isGated(path: string): boolean {
  if (OPEN_PATHS[path]) return false;
  if (path === "/mcp" || path.startsWith("/mcp/")) return true;
  return GATED_PREFIXES.some((p) => p.endsWith("/") ? path.startsWith(p) : path === p);
}

/** Build the request handler. Stateless apart from the Ctx it closes over. */
export function createHandler(ctx: Ctx, opts: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const token = opts.token ?? PROXY_TOKEN;
  const password = opts.password ?? DASHBOARD_PASSWORD;
  const accessLog = opts.accessLog ?? ACCESS_LOG;
  const ui = opts.uiHtml;

  async function route(req: Request, url: URL): Promise<Response> {
    const p = url.pathname;

    if (p === "/healthz") {
      return json(200, { ok: true, uptime_ms: Date.now() - ctx.state.startedAt });
    }
    if (p === "/readyz") {
      const tokenReady = Boolean(ctx.state.token.token);
      const catalogReady = ctx.upstream.catalog !== null;
      return json(tokenReady && catalogReady ? 200 : 503, {
        ok: tokenReady && catalogReady,
        token: ctx.state.token.status,
        catalog: catalogReady,
        cache_entries: ctx.cache.stats().entries,
      });
    }

    if (p === "/v1/chat/completions" && req.method === "POST") return handleCompletions(req, ctx);
    if (p === "/v1/messages" && req.method === "POST") return handleAnthropicMessages(req, ctx);
    if (p === "/v1/messages/count_tokens" && req.method === "POST") return handleAnthropicCountTokens(req);
    if (p === "/v1/models" && req.method === "GET") return handleModels(ctx, req);
    if (p === "/v1/usage" && req.method === "GET") return handleUsage(ctx, req);
    if (p === "/mcp" && (req.method === "POST" || req.method === "GET" || req.method === "DELETE")) {
      return handleMcp(req, ctx);
    }

    // Claude Code probes this before opening the Messages stream.
    if (p === "/api/hello" && (req.method === "GET" || req.method === "HEAD")) return handleApiHello(req);
    if (p === "/api/claude/config" && req.method === "GET") return handleClaudeConfig(ctx);

    if (p === "/" || p === "/index.html") {
      return new Response(ui ?? "dashboard not bundled", { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (p === "/api/state" && req.method === "GET") return json(200, apiState(ctx));

    if (p === "/api/login/start" && req.method === "POST") {
      if (!opts.login) return json(503, { ok: false, error: "login disabled" });
      const s = opts.login.start();
      return json(200, { ok: s.state !== "error", error: s.error ?? null });
    }

    if (p === "/api/login/status" && req.method === "GET") {
      const s = opts.login?.current;
      if (!s) return json(200, { state: "idle" });
      return json(200, {
        state: s.state,
        error: s.error ?? null,
        user_code: s.flow?.user_code ?? null,
        verification_uri: s.flow?.verification_uri ?? null,
      });
    }

    // Ad endpoints (legitimate: dashboard shows the ad and reports impressions
    // so completions aren't paused for "ads not showing").
    if (p === "/api/ads/next" && req.method === "GET") {
      const jwt = ctx.state.token.token;
      if (!jwt) return json(200, { ad: null, reason: "no_token" });
      const slot = url.searchParams.get("slot") || "banner";
      const ad = await ctx.upstream.fetchAdNext(jwt, slot, ctx.state.sessionId, ctx.getGravityContext?.());
      if (!ad) return new Response(null, { status: 204 });
      return json(200, ad);
    }

    if (p === "/api/ads/impression" && req.method === "POST") {
      const jwt = ctx.state.token.token;
      if (!jwt) return json(200, { ok: false });
      try {
        const b = await req.json() as { ad_id: string; click_token: string; imp_fired?: boolean };
        await ctx.upstream.postImpression(jwt, b.ad_id, b.click_token, ctx.state.sessionId, b.imp_fired === true);
        return json(200, { ok: true });
      } catch {
        return json(200, { ok: false });
      }
    }

    if (p === "/api/stats/refresh" && req.method === "POST") {
      await pollStats(ctx).catch(() => {});
      return json(200, { ok: true });
    }

    return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const started = performance.now();
    let res: Response;
    try {
      const dashboard = isDashboardPath(url.pathname);
      // Dashboard routes answer to the password when one is set; the bearer
      // token keeps guarding the meterable /v1/* and /mcp surfaces.
      if (password && dashboard && !basicOk(req, password)) {
        res = basicChallenge();
      } else if (!(password && dashboard) && token && isGated(url.pathname) && !tokenMatches(presentedToken(req, url), token)) {
        res = unauthorized();
      } else {
        res = await route(req, url);
      }
    } catch (e) {
      console.error(`[freepi-proxy] ${req.method} ${url.pathname} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      res = json(500, {
        error: { message: `proxy internal error: ${e instanceof Error ? e.message : String(e)}`, type: "freepi_proxy_error" },
      });
    }
    if (accessLog) {
      const ms = (performance.now() - started).toFixed(1);
      console.log(`${req.method} ${url.pathname} ${res.status} ${ms}ms`);
    }
    return res;
  };
}

/** Dashboard payload. Separate from /v1/usage: this one carries chart series. */
export function apiState(ctx: Ctx): Record<string, unknown> {
  const live = ctx.state.live;
  const tracker = ctx.tracker;
  return {
    status: {
      token: ctx.state.token.status,
      handle: ctx.state.token.handle,
      tier: live?.tier,
      lane: live?.lane,
      notice: ctx.state.notice,
      lifetimeRequests: live?.lifetime_requests,
    },
    live: {
      allowance_credits: live?.allowance_credits ?? null,
      remaining_credits_today: live?.remaining_credits_today ?? null,
      spent_usd_today: live?.spent_usd_today ?? null,
      cap_usd_today: live?.cap_usd_today ?? null,
      request_count_today: live?.request_count_today ?? null,
      prompt_tokens_today: live?.prompt_tokens_today ?? null,
      completion_tokens_today: live?.completion_tokens_today ?? null,
      refill_at: live?.refill_at ?? null,
      streak_days: live?.streak?.days ?? null,
      fetchedAgoMs: live ? Date.now() - ctx.state.liveAt : null,
    },
    recent: tracker.recent(250),
    hourly: tracker.hourly(24),
    days: tracker.byDay(14),
    models: tracker.byModel(3),
    catalog: ctx.upstream.catalog
      ? {
        fetchedAt: ctx.upstream.catalog.fetchedAt,
        defaultModel: ctx.upstream.catalog.defaultModel,
        latest: ctx.upstream.catalog.latest,
        min: ctx.upstream.catalog.min,
        models: ctx.upstream.catalog.models
          .filter((m) => isModelVisible(m, ctx.settings))
          .map((m) => ({ ...m, premium: isPremiumOnly(m) })),
      }
      : null,
    server: {
      baseUrl: DASHBOARD_URL,
      startedAt: ctx.state.startedAt,
      uptimeMs: Date.now() - ctx.state.startedAt,
      proxyPort: PORT,
      lastCreditDiff: ctx.state.lastCreditDiff,
    },
    cache: ctx.cache.stats(),
  };
}

/** Convenience for tests: a handler over a fresh Ctx with a stub tracker. */
export function testCtx(overrides: Partial<Ctx> = {}): Ctx {
  const tracker = {
    ready: async () => {},
    add: async () => {},
    reconcile: () => {},
    recent: () => [],
    hourly: () => [],
    byDay: () => [],
    byModel: () => [],
  } as unknown as Ctx["tracker"];
  return {
    upstream: new Upstream(),
    tracker,
    cache: overrides.cache ?? (undefined as unknown as Ctx["cache"]),
    state: {
      token: { token: "fake-jwt", status: "ok", checkedAt: 0 },
      live: null,
      liveAt: 0,
      sessionId: "test-session",
      startedAt: Date.now(),
      lastCreditDiffAt: 0,
      lastCreditDiff: 0,
      notice: null,
      lastSettledUsd: null,
      lastSettleAt: Date.now(),
    },
    settings: defaultSettings(),
    ...overrides,
  };
}

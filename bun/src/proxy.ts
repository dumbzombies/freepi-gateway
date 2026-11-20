// /v1/chat/completions proxy: forwards to free-pi with injected auth, streams
// the response through untouched, and tees usage (tokens) out of the SSE/JSON
// body for the dashboard. Also serves /v1/models from the live catalog.

import { CREDIT_DIFF_MIN_MS, DASHBOARD_URL, EST_CREDITS_PER_TOKEN } from "./config.ts";
import type { Ctx } from "./state.ts";
import { completeWithSessionRetry, pollStats, settleSpend } from "./state.ts";
import type { CacheRun } from "./cache.ts";

/** Instant local estimate: tokens × model multiplier × calibrated base rate. */
export function estimateCredits(ctx: Ctx, model: string, pt: number, ct: number): number {
  return Math.round((pt + ct) * ctx.upstream.multiplier(model) * EST_CREDITS_PER_TOKEN * 10) / 10;
}

interface Usage { prompt_tokens?: number; completion_tokens?: number }

/** Extract usage from a full non-stream JSON body. */
function usageFromJson(body: string): Usage | null {
  try {
    const j = JSON.parse(body) as { usage?: Usage };
    return j.usage ? { prompt_tokens: j.usage.prompt_tokens, completion_tokens: j.usage.completion_tokens } : null;
  } catch {
    return null;
  }
}

/** Extract the last non-null usage object from an SSE stream text. */
function usageFromSse(buf: string): Usage | null {
  let found: Usage | null = null;
  for (const line of buf.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload) as { usage?: Usage | null };
      if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) found = j.usage;
    } catch { /* partial line */ }
  }
  return found;
}

/** Min gap between client-forced catalog refreshes (?refresh=1). */
const CATALOG_FORCE_MIN_MS = 5_000;

export async function handleModels(ctx: Ctx, req?: Request): Promise<Response> {
  // The background loop refreshes every CATALOG_REFRESH_MS; a client that wants
  // the list right now can ask, rate-limited so a poll loop cannot hammer it.
  if (req && new URL(req.url).searchParams.has("refresh")) {
    const age = Date.now() - (ctx.upstream.catalog?.fetchedAt ?? 0);
    if (age > CATALOG_FORCE_MIN_MS) await ctx.upstream.refreshCatalog();
  }
  const models = (ctx.upstream.catalog?.models ?? [])
    .filter((m) => !m.unavailable)
    .map((m) => ({
      // OpenAI fields
      id: m.id,
      object: "model",
      owned_by: "free-pi",
      // Anthropic fields (Claude Code and other Anthropic clients read these)
      type: "model",
      display_name: m.display_name || m.name.split(" · ")[0] || m.id,
      created_at: new Date(ctx.upstream.catalog?.fetchedAt ?? Date.now()).toISOString(),
    }));
  return Response.json({
    object: "list",
    data: models,
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models[models.length - 1]?.id ?? null,
  });
}

/** Min gap between client-forced /me/stats refreshes (?refresh=1). */
const USAGE_FORCE_MIN_MS = 5_000;

/** Authoritative quota/usage view, stable for external clients. The dashboard
 * uses /api/state; agents and launchers can poll this instead. */
export async function handleUsage(ctx: Ctx, req: Request): Promise<Response> {
  if (new URL(req.url).searchParams.has("refresh") && Date.now() - ctx.state.liveAt > USAGE_FORCE_MIN_MS) {
    await pollStats(ctx).catch(() => {});
  }
  const live = ctx.state.live;
  const allowance = live?.allowance_credits ?? null;
  const remaining = live?.remaining_credits_today ?? null;
  const refillAt = live?.refill_at ?? null;
  let refillInMs: number | null = null;
  if (refillAt) {
    const ms = Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(refillAt) ? refillAt : refillAt + "Z");
    if (Number.isFinite(ms)) refillInMs = Math.max(0, ms - Date.now());
  }
  const hasToken = Boolean(ctx.state.token.token);
  return Response.json({
    object: "usage",
    ok: live !== null,
    error: live ? null : (hasToken ? "no_stats_yet" : "no_token"),
    handle: ctx.state.token.handle ?? null,
    tier: live?.tier ?? null,
    lane: live?.lane ?? null,
    notice: ctx.state.notice,
    quota: {
      allowance_credits: allowance,
      remaining_credits_today: remaining,
      used_credits_today: allowance != null && remaining != null
        ? Math.round((allowance - remaining) * 10) / 10
        : null,
      remaining_pct: allowance != null && remaining != null && allowance > 0
        ? Math.round((remaining / allowance) * 1000) / 10
        : null,
      spent_usd_today: live?.spent_usd_today ?? null,
      cap_usd_today: live?.cap_usd_today ?? null,
      refill_at: refillAt,
      refill_in_ms: refillInMs,
    },
    usage: {
      requests_today: live?.request_count_today ?? null,
      prompt_tokens_today: live?.prompt_tokens_today ?? null,
      completion_tokens_today: live?.completion_tokens_today ?? null,
      lifetime_requests: live?.lifetime_requests ?? null,
      streak_days: live?.streak?.days ?? null,
    },
    cache: ctx.cache.stats(),
    proxy: {
      uptime_ms: Date.now() - ctx.state.startedAt,
      catalog_fetched_at: ctx.upstream.catalog?.fetchedAt ?? null,
      // how old the authoritative figures are: poll /me/stats yourself if stale
      stale_ms: ctx.state.liveAt ? Date.now() - ctx.state.liveAt : null,
    },
  }, { headers: { "cache-control": "no-store" } });
}

export async function handleCompletions(req: Request, ctx: Ctx): Promise<Response> {
  const started = Date.now();
  const jwt = ctx.state.token.token;
  if (!jwt) {
    return Response.json(
      { error: { message: "No free-pi token. Open the dashboard to log in: " + DASHBOARD_URL, type: "freepi_proxy_error", code: "no_token" } },
      { status: 401 },
    );
  }

  const raw = await req.text();
  let model = "unknown";
  let isStream = false;
  try {
    const parsed = JSON.parse(raw) as { model?: string; stream?: boolean };
    model = parsed.model ?? model;
    isStream = parsed.stream === true;
  } catch { /* let upstream reject */ }

  const source = new URL(req.url).searchParams.get("source") || "api";

  // Exact-response cache. A body we cannot parse gets a unique key that is
  // never stored, so those requests keep the old pure-forwarding behaviour.
  const cacheKey = ctx.cache.key(raw);

  // Every proxied request is a new CLI-style "turn": the free-pi server links
  // completions to the turn id whose ad cycle ran (measured: a fresh turn id
  // without an ad cycle is paused with ads_required; the turn id that had one
  // completes freely). completeWithSessionRetry mints that turn id, runs the ad
  // cycle, and replays the request on a fresh session if upstream reports that
  // the current session (not this request) is spent. The cache wraps that, so
  // ad cycles and session rotation only run on misses.
  let out: CacheRun;
  try {
    out = await ctx.cache.run(
      cacheKey ?? crypto.randomUUID(),
      async () => {
        const up = (await completeWithSessionRetry(ctx, jwt, raw, req.signal)).upstream;
        return {
          status: up.status,
          ctype: up.headers.get("content-type") || "application/json",
          upstream: up,
          cacheable: up.ok,
        };
      },
      { store: cacheKey !== null },
    );
  } catch (e) {
    await ctx.tracker.add({
      ts: started, kind: "chat", model, pt: 0, ct: 0, credits: null, ms: Date.now() - started,
      status: 0, source, error: e instanceof Error ? e.message : String(e),
    });
    return Response.json(
      { error: { message: `Upstream connection failed: ${String(e)}`, type: "freepi_proxy_error", code: "network" } },
      { status: 502 },
    );
  }

  if (out.hit) {
    const { payload } = out;
    // No upstream turn ran, so there is no spend to settle.
    await ctx.tracker.add({
      ts: started, kind: "chat", model, pt: 0, ct: 0, credits: 0, ms: Date.now() - started,
      status: payload.status, source, cached: true,
    });
    return new Response(payload.body, {
      status: payload.status,
      headers: {
        "content-type": payload.ctype,
        "cache-control": "no-cache",
        "x-freepi-cache": "hit",
      },
    });
  }

  if (out.status < 200 || out.status >= 300) {
    // Errors are never cached; the drain still gives us the body to pass through.
    const failed = await out.done;
    const text = failed
      ? new TextDecoder().decode(failed.body)
      : await new Response(out.stream).text().catch(() => "");
    await ctx.tracker.add({
      ts: started, kind: "chat", model, pt: 0, ct: 0, credits: null, ms: Date.now() - started,
      status: out.status, source, error: text.slice(0, 300),
    });
    // pass upstream error shape through (401 daily caps etc.)
    return new Response(text || JSON.stringify({ error: { message: `upstream HTTP ${out.status}`, type: "freepi_proxy_error" } }), {
      status: out.status,
      headers: { "content-type": out.ctype, "x-freepi-cache": "miss" },
    });
  }

  // ---------- miss: stream through; the cache drain supplies usage ----------
  const response = new Response(out.stream, {
    status: out.status,
    headers: {
      "content-type": out.ctype,
      "cache-control": "no-cache",
      "x-freepi-cache": "miss",
    },
  });

  // record with an instant estimate; reconcile later when the server settles
  void (async () => {
    const payload = await out.done;
    if (!payload) return; // too large to buffer, or the body broke off
    const text = new TextDecoder().decode(payload.body);
    const usage = isStream ? usageFromSse(text) : usageFromJson(text);
    const pt = usage?.prompt_tokens ?? 0;
    const ct = usage?.completion_tokens ?? 0;
    await ctx.tracker.add({
      ts: started, kind: "chat", model,
      pt, ct,
      credits: estimateCredits(ctx, model, pt, ct),
      ms: Date.now() - started, status: out.status, source,
    });
    const settle = await settleSpend(ctx, CREDIT_DIFF_MIN_MS);
    if (settle) ctx.tracker.reconcile(settle.credits, settle.sinceTs);
  })();

  return response;
}

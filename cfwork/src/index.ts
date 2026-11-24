// freepi-proxy for Cloudflare Workers: turns free-pi account credits into
// OpenAI- and Anthropic-compatible APIs. Zero dependencies, no build step.
//
//   POST /v1/chat/completions   OpenAI (streaming + non-streaming)
//   POST /v1/messages           Anthropic / Claude Code (streaming + non-streaming)
//   POST /v1/messages/count_tokens
//   GET  /v1/models             live catalog
//   GET  /v1/usage              live quota per pooled account
//   GET  /healthz               open health probe
//
// Secrets: FREEPI_TOKENS (account pool), WORKER_API_KEY (client bearer key).

import { EST_CREDITS_PER_TOKEN } from "./config.ts";
import { type CacheRun, type CachedPayload } from "./cache.ts";
import { type Account, AccountPool, chatAcrossPool, SESSION_LIMIT_MESSAGE } from "./pool.ts";
import { accounts, cache, getUpstream, recordUsage, stats, type Env } from "./runtime.ts";
import { isFreeModel } from "./models.ts";
import type { Upstream } from "./upstream.ts";
import {
  AnthropicStreamTranslator,
  anthropicError,
  countInputTokens,
  errorTypeForStatus,
  toAnthropicResponse,
  translateAnthropicRequest,
  type AnthropicRequest,
  type TranslatedRequest,
} from "./translate.ts";

/** Instant local estimate: tokens × model multiplier × calibrated base rate. */
function estimateCredits(up: Upstream, model: string, pt: number, ct: number): number {
  return Math.round((pt + ct) * up.multiplier(model) * EST_CREDITS_PER_TOKEN * 10) / 10;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

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

/** The friendly session-cap message when a 409/429 is the account's
 * concurrent-session rejection (upstream uses both statuses). */
function sessionLimitMessage(status: number, text: string): string | null {
  if (status !== 409 && status !== 429) return null;
  if (!/session|concurrent|limit/i.test(text)) return null;
  return SESSION_LIMIT_MESSAGE;
}

// ---------------------------------------------------------------- routing --

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "freepi-proxy-cf" });
    }

    if (!url.pathname.startsWith("/v1/")) {
      return Response.json({ error: { message: "not found", code: "not_found" } }, { status: 404 });
    }

    // Bearer gate. Fail closed: an unset WORKER_API_KEY must not expose an
    // open proxy that burns the account's credits.
    const key = env.WORKER_API_KEY;
    if (!key) {
      return Response.json(
        { error: { message: "WORKER_API_KEY secret is not set; refusing to serve an open proxy.", code: "no_api_key" } },
        { status: 401 },
      );
    }
    const auth = request.headers.get("authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (provided !== key) {
      return Response.json(
        { error: { message: "Invalid API key. Send Authorization: Bearer <WORKER_API_KEY>.", code: "invalid_api_key" } },
        { status: 401 },
      );
    }

    const baseUrl = env.FREEPI_BASE_URL || "https://api.freepi.ai";
    const up = getUpstream(baseUrl);
    cache.enabled = env.FREEPI_CACHE !== "0";

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /v1/chat/completions":
          return await handleCompletions(request, env, up);
        case "POST /v1/messages":
          return await handleMessages(request, env, up);
        case "POST /v1/messages/count_tokens":
          return handleCountTokens(request);
        case "GET /v1/models":
          return await handleModels(env, up);
        case "GET /v1/usage":
          return await handleUsage(env, up);
        default:
          return Response.json({ error: { message: "not found", code: "not_found" } }, { status: 404 });
      }
    } catch (e) {
      return Response.json(
        { error: { message: `proxy error: ${e instanceof Error ? e.message : String(e)}`, code: "internal" } },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;

// --------------------------------------------------------- shared pieces --

function poolAccounts(env: Env): Account[] {
  const tokens = AccountPool.tokensOf(env);
  if (!tokens.length) return [];
  return tokens.map((jwt) => accounts.account(jwt));
}

function noTokenError(): Response {
  return Response.json(
    { error: { message: "No free-pi token configured. Set the FREEPI_TOKENS secret (see README).", code: "no_token" } },
    { status: 401 },
  );
}

class NoToken extends Error {
  constructor() {
    super("no free-pi token configured");
  }
}

/** Run one completion across the account pool, wrapped by the cache. */
async function runTurn(
  env: Env,
  up: Upstream,
  body: string,
  signal: AbortSignal | undefined,
  cacheKey: string | null,
): Promise<CacheRun> {
  const accts = poolAccounts(env);
  if (!accts.length) throw new NoToken();

  const produce = async () => {
    await up.ensureCatalog();
    const walk = await chatAcrossPool(up, accts, body, signal);
    return {
      status: walk.response.status,
      ctype: walk.response.headers.get("content-type") || "application/json",
      upstream: walk.response,
      cacheable: walk.response.ok,
    };
  };

  const key = cacheKey ?? crypto.randomUUID();
  return cache.run(key, produce, { store: cacheKey !== null && cache.enabled });
}

// ------------------------------------------------------ OpenAI endpoint --

function parseModelAndStream(raw: string): { model: string; isStream: boolean } {
  try {
    const parsed = JSON.parse(raw) as { model?: string; stream?: boolean };
    return { model: parsed.model ?? "unknown", isStream: parsed.stream === true };
  } catch {
    return { model: "unknown", isStream: false };
  }
}

async function handleCompletions(request: Request, env: Env, up: Upstream): Promise<Response> {
  const raw = await request.text();
  const { model, isStream } = parseModelAndStream(raw);

  const cacheKey = await cache.key(raw);

  let out: CacheRun;
  try {
    out = await runTurn(env, up, raw, request.signal, cacheKey);
  } catch (e) {
    if (e instanceof NoToken) return noTokenError();
    recordUsage(model, 0, 0, 0, false, false);
    return Response.json(
      { error: { message: `Upstream connection failed: ${String(e)}`, type: "freepi_proxy_error", code: "network" } },
      { status: 502 },
    );
  }

  if (out.hit) {
    const { payload } = out;
    recordUsage(model, 0, 0, 0, true, true);
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
    recordUsage(model, 0, 0, 0, false, false);
    // pass upstream error shape through (401 daily caps etc.), but make the
    // account's 4-session cap actionable: upstream's raw reply is cryptic.
    const limit = sessionLimitMessage(out.status, text);
    return new Response(limit ?? (text || JSON.stringify({ error: { message: `upstream HTTP ${out.status}`, type: "freepi_proxy_error" } })), {
      status: out.status,
      headers: { "content-type": limit ? "application/json; charset=utf-8" : out.ctype, "x-freepi-cache": "miss" },
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

  void (async () => {
    const payload = await out.done;
    if (!payload) return; // too large to buffer, or the body broke off
    const text = new TextDecoder().decode(payload.body);
    const usage = isStream ? usageFromSse(text) : usageFromJson(text);
    const pt = usage?.prompt_tokens ?? 0;
    const ct = usage?.completion_tokens ?? 0;
    recordUsage(model, pt, ct, estimateCredits(up, model, pt, ct), false, true);
  })();

  return response;
}

// ---------------------------------------------------- Anthropic endpoint --

async function handleMessages(request: Request, env: Env, up: Upstream): Promise<Response> {
  let input: AnthropicRequest;
  try {
    input = await request.json() as AnthropicRequest;
  } catch {
    return anthropicError(400, "invalid_request_error", "Request body must be valid JSON.");
  }

  let translated: TranslatedRequest;
  try {
    translated = translateAnthropicRequest(up.catalog, input);
  } catch (e) {
    return anthropicError(400, "invalid_request_error", e instanceof Error ? e.message : String(e));
  }

  const cacheKey = await cache.key(JSON.stringify(translated.body));

  let out: CacheRun;
  try {
    out = await runTurn(env, up, JSON.stringify(translated.body), request.signal, cacheKey);
  } catch (e) {
    if (e instanceof NoToken) return noTokenError();
    recordUsage(translated.model, 0, 0, 0, false, false);
    return anthropicError(502, "api_error", `Upstream connection failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (out.hit) return replayCached(translated, out.payload);

  if (out.status < 200 || out.status >= 300) {
    const failed = await out.done;
    const text = failed
      ? new TextDecoder().decode(failed.body)
      : await new Response(out.stream).text().catch(() => "");
    recordUsage(translated.model, 0, 0, 0, false, false);
    // Same actionable rewrite the OpenAI endpoint does: the account's
    // 4-session cap is the one failure an agent can fix itself, so name it.
    const limitMessage = sessionLimitMessage(out.status, text);
    return anthropicError(
      out.status,
      limitMessage ? "rate_limit_error" : errorTypeForStatus(out.status),
      limitMessage ?? upstreamErrorMessage(text, out.status),
    );
  }

  if (!translated.stream) {
    const payload = await out.done;
    const text = payload ? new TextDecoder().decode(payload.body) : await new Response(out.stream).text();
    let json: Record<string, any>;
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      recordUsage(translated.model, 0, 0, 0, false, false);
      return anthropicError(502, "api_error", `Upstream returned invalid JSON: ${text.slice(0, 200)}`);
    }
    const usage = json.usage ?? null;
    const pt = usage?.prompt_tokens ?? 0;
    const ct = usage?.completion_tokens ?? 0;
    recordUsage(translated.model, pt, ct, estimateCredits(up, translated.model, pt, ct), false, true);
    return Response.json(toAnthropicResponse(json, translated.displayModel), {
      headers: { "x-freepi-cache": "miss" },
    });
  }

  const translator = new AnthropicStreamTranslator(translated.displayModel, translated.estimatedInputTokens);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const convert = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const out = translator.push(decoder.decode(chunk, { stream: true }));
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      const tail = translator.push(decoder.decode()) + translator.finish();
      if (tail) controller.enqueue(encoder.encode(tail));
      // The body is fully translated here, so the usage figures are final.
      const u = translator.usage;
      recordUsage(translated.model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0,
        estimateCredits(up, translated.model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0), false, true);
    },
  });

  return new Response(out.stream.pipeThrough(convert), {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-freepi-cache": "miss",
    },
  });
}

/** Serve a stored OpenAI-shaped completion as an Anthropic response. */
function replayCached(translated: TranslatedRequest, payload: CachedPayload): Response {
  const text = new TextDecoder().decode(payload.body);

  if (!translated.stream) {
    let json: Record<string, any>;
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      return anthropicError(502, "api_error", `Cached response was not valid JSON: ${text.slice(0, 200)}`);
    }
    recordUsage(translated.model, 0, 0, 0, true, true);
    return Response.json(toAnthropicResponse(json, translated.displayModel), {
      headers: { "x-freepi-cache": "hit" },
    });
  }

  // Replay the stored OpenAI SSE through a fresh translator, so the client
  // sees exactly the event sequence it would have got from upstream.
  const translator = new AnthropicStreamTranslator(translated.displayModel, translated.estimatedInputTokens);
  let sse = "";
  for (const chunk of text.split("\n\n")) {
    if (chunk) sse += translator.push(chunk + "\n\n");
  }
  sse += translator.finish();
  const u = translator.usage;
  recordUsage(translated.model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, 0, true, true);
  return new Response(sse, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-freepi-cache": "hit",
    },
  });
}

function upstreamErrorMessage(text: string, status: number): string {
  if (!text) return `Upstream returned HTTP ${status}.`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message) return message;
  } catch { /* not JSON */ }
  return text.slice(0, 500);
}

async function handleCountTokens(request: Request): Promise<Response> {
  let input: AnthropicRequest;
  try {
    input = await request.json() as AnthropicRequest;
  } catch {
    return anthropicError(400, "invalid_request_error", "Request body must be valid JSON.");
  }
  return Response.json({ input_tokens: countInputTokens(input) });
}

// ------------------------------------------------------- models & usage --

async function handleModels(env: Env, up: Upstream): Promise<Response> {
  await up.ensureCatalog();
  const showPremium = env.FREEPI_SHOW_PREMIUM === "1";
  const models = (up.catalog?.models ?? [])
    .filter((m) => !m.unavailable)
    .filter((m) => showPremium || !isPremiumOnly(m))
    .map((m) => ({
      // OpenAI fields
      id: m.id,
      object: "model",
      owned_by: "free-pi",
      // Anthropic fields (Claude Code and other Anthropic clients read these)
      type: "model",
      display_name: m.display_name || m.name.split(" · ")[0] || m.id,
      created_at: new Date(up.catalog?.fetchedAt ?? Date.now()).toISOString(),
      // Billing class: `free` is catalog no-charge, `premium` needs purchased
      // credits (403 model_requires_credits without them).
      free: m.free === true,
      premium: isPremiumOnly(m),
      multiplier: m.multiplier,
    }));
  return Response.json({
    object: "list",
    data: models,
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models[models.length - 1]?.id ?? null,
  });
}

/** Premium = anything the catalog does not mark free-unlimited: it burns the
 * account's purchased credits. */
function isPremiumOnly(m: { free?: boolean }): boolean {
  return m.free !== true;
}

async function handleUsage(env: Env, up: Upstream): Promise<Response> {
  const tokens = AccountPool.tokensOf(env);
  const rows = await Promise.all(tokens.map(async (jwt) => {
    const s = await up.stats(jwt);
    return s
      ? { ok: true, handle: s.handle ?? null, tier: s.tier ?? null, remaining_credits_today: s.remaining_credits_today ?? null, spent_usd_today: s.spent_usd_today ?? null, cap_usd_today: s.cap_usd_today ?? null, refill_at: s.refill_at ?? null }
      : { ok: false, error: "no_stats_yet" };
  }));
  const primary = rows[0] ?? null;
  return Response.json({
    object: "usage",
    ok: primary?.ok === true,
    error: rows.length ? null : "no_token",
    pool_size: tokens.length,
    primary,
    accounts: rows,
    proxy: {
      started_at: stats.startedAt,
      requests: stats.requests,
      cached: stats.cached,
      errors: stats.errors,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      estimated_credits: Math.round(stats.credits * 10) / 10,
      by_model: Object.fromEntries(stats.byModel),
      cache: cache.stats(),
    },
  }, { headers: { "cache-control": "no-store" } });
}

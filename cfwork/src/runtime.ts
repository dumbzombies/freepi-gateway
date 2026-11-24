// Per-isolate runtime state: memoized upstream clients, the account pool, the
// response cache, and local usage counters. Isolates recycle freely on
// Workers, so everything here is best-effort — correctness never depends on
// it surviving.

import { AccountPool } from "./pool.ts";
import { ResponseCache } from "./cache.ts";
import { Upstream } from "./upstream.ts";
import { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "./config.ts";

export interface Env {
  /** Secrets: the account pool (one secret, newline/comma separated or a JSON
   * array) and the key clients must send as `Authorization: Bearer <key>`. */
  FREEPI_TOKENS?: string;
  FREEPI_TOKEN?: string;
  FREEPI_TOKEN_ALT?: string;
  WORKER_API_KEY?: string;
  /** Vars/dev overrides. */
  FREEPI_BASE_URL?: string;
  FREEPI_CACHE?: string;
  FREEPI_SHOW_PREMIUM?: string;
}

const upstreams = new Map<string, Upstream>();

export function getUpstream(baseUrl: string): Upstream {
  let up = upstreams.get(baseUrl);
  if (!up) {
    up = new Upstream(baseUrl, 10 * 60 * 1000);
    upstreams.set(baseUrl, up);
  }
  return up;
}

export const accounts = new AccountPool();

export const cache = new ResponseCache({
  ttlMs: CACHE_TTL_MS,
  maxEntries: CACHE_MAX_ENTRIES,
  maxBytes: CACHE_MAX_BYTES,
});

/** Local usage counters since this isolate booted. The authoritative quota
 * view is upstream's /me/stats, served live by /v1/usage. */
export const stats = {
  startedAt: Date.now(),
  requests: 0,
  cached: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  credits: 0,
  byModel: new Map<string, { requests: number; promptTokens: number; completionTokens: number; credits: number }>(),
};

export function recordUsage(model: string, pt: number, ct: number, credits: number, cached: boolean, ok: boolean): void {
  stats.requests++;
  if (cached) stats.cached++;
  if (!ok) stats.errors++;
  stats.promptTokens += pt;
  stats.completionTokens += ct;
  stats.credits += credits;
  let m = stats.byModel.get(model);
  if (!m) {
    m = { requests: 0, promptTokens: 0, completionTokens: 0, credits: 0 };
    stats.byModel.set(model, m);
  }
  m.requests++;
  m.promptTokens += pt;
  m.completionTokens += ct;
  m.credits += credits;
}

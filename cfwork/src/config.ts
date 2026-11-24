// Constants for the Cloudflare Worker variant. No filesystem, no process —
// everything that Node's variant reads from disk lives in secrets/vars or
// per-isolate memory.

/** free-pi backend, overridable so tests can point at a stub server. */
export const DEFAULT_BASE_URL = "https://api.freepi.ai";

/** Header the server's forced-update gate reads; we send the catalog's latest
 * (refreshed live), or this floor if the catalog fetch fails. */
export const FALLBACK_CLIENT_VERSION = "0.6.19";

/** Consent version free-pi-cli 0.6.x submits during login. */
export const CONSENT_VERSION = "4";

export const UA = "freepi-proxy-cf/1.0";

/** Local instant estimate: credits per token at 1x multiplier (calibrated from
 * a live measurement: glm-flash 1x, $0.000421 for 2,526 tokens). */
export const EST_CREDITS_PER_TOKEN = 0.00222;

/** Server peg: $1.125 daily cap = 15,000 credits. */
export const CREDITS_PER_USD = 15_000 / 1.125;

/** How long a fetched catalog stays fresh before the next request refetches. */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Exact-response cache defaults (per isolate; isolates recycle freely). */
export const CACHE_ENABLED = true;
export const CACHE_TTL_MS = 3_600_000;
export const CACHE_MAX_ENTRIES = 300;
export const CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** The impression record lands asynchronously upstream; a chat fired the same
 * instant still reads the session as ad-less. Verified pause-free value. */
export const AD_WARM_DELAY_MS = 400;

/** Fingerprint headers the 0.6.18+ CLI sends on its ads requests. */
export const CLIENT_OS = "linux";
export const CLIENT_ARCH = "x64";

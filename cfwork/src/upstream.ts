// free-pi upstream client for Workers: catalog/version gate, stats, ads warm,
// completions, session reset. Ported from the Node variant minus filesystem
// persistence — version adoption and catalogs live in isolate memory.

import { CLIENT_ARCH, CLIENT_OS, CONSENT_VERSION, FALLBACK_CLIENT_VERSION, UA } from "./config.ts";

/** Compare dotted versions: negative when a < b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const VERSION_RE = /\b(\d+\.\d+\.\d+)\b/;

export interface CatalogModel {
  id: string;
  name: string;
  display_name?: string;
  free?: boolean;
  usage_x?: string | null;
  note?: string | null;
  unavailable?: boolean;
  section?: string;
  /** parsed "~Nx usage" multiplier, default 1 */
  multiplier: number;
}

export interface Catalog {
  models: CatalogModel[];
  latest: string;
  min: string;
  defaultModel: string;
  fetchedAt: number;
}

export interface MeStats {
  tier?: string;
  cap_usd_today?: number;
  spent_usd_today?: number;
  remaining_usd_today?: number;
  remaining_credits_today?: number;
  allowance_credits?: number;
  refill_at?: string;
  lane?: string;
  handle?: string;
}

export class Upstream {
  catalog: Catalog | null = null;
  catalogFetchedAt = 0;
  private clientVersion = FALLBACK_CLIENT_VERSION;
  private modelIndex = new Map<string, number>();
  private catalogInflight: Promise<void> | null = null;
  private readonly baseUrl: string;
  private readonly catalogTtlMs: number;

  constructor(baseUrl: string, catalogTtlMs: number) {
    this.baseUrl = baseUrl;
    this.catalogTtlMs = catalogTtlMs;
  }

  get version(): string {
    return this.clientVersion;
  }

  /** Adopt a client version when it is newer than the one in use. */
  adoptVersion(v: string | null | undefined): void {
    if (!v || !VERSION_RE.test(v) || compareVersions(v, this.clientVersion) <= 0) return;
    this.clientVersion = v;
  }

  /** Learn the required version from an upgrade-gate error body. */
  noteRequiredVersion(body: string): void {
    const m = VERSION_RE.exec(body);
    if (m) this.adoptVersion(m[1]);
  }

  /** Authenticated fetch that survives the forced-update gate: upstream answers
   * 426 upgrade_required when x-client-version is below its minimum. Learn the
   * required version, refresh the catalog, then replay the call once. */
  private async authedFetch(url: URL, init: () => RequestInit): Promise<Response> {
    const res = await fetch(url, init());
    if (res.status !== 426) return res;
    const text = await res.text().catch(() => "");
    this.noteRequiredVersion(text);
    await this.refreshCatalog(true);
    return fetch(url, init());
  }

  authHeaders(jwt: string): Record<string, string> {
    return {
      authorization: `Bearer ${jwt}`,
      "x-client-version": this.clientVersion,
      "user-agent": UA,
    };
  }

  /** GET /client-version — public; parses usage multipliers out of names. */
  async refreshCatalog(force = false): Promise<Catalog | null> {
    if (!force && this.catalog && Date.now() - this.catalogFetchedAt < this.catalogTtlMs) {
      return this.catalog;
    }
    // Single-flight: concurrent requests share one catalog fetch.
    if (this.catalogInflight) {
      await this.catalogInflight.catch(() => {});
      return this.catalog;
    }
    this.catalogInflight = (async () => {
      try {
        const res = await fetch(new URL("/client-version", this.baseUrl), {
          headers: { "user-agent": UA },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return;
        const d = (await res.json()) as {
          min: string; latest: string; model: string;
          models: Array<Omit<CatalogModel, "multiplier">>;
        };
        this.adoptVersion(d.latest);
        this.adoptVersion(d.min);
        const models = (d.models || []).map((m) => ({
          ...m,
          // Empty-string usage_x must not become multiplier 0 (premium gate
          // reads multiplier >= 1); fall through to the name or 1.
          multiplier: Number(m.usage_x || /~([\d.]+)x/.exec(m.name)?.[1] || 1),
        }));
        const index = new Map<string, number>();
        for (const m of models) index.set(m.id, m.multiplier);
        this.modelIndex = index;
        this.catalog = {
          latest: d.latest,
          min: d.min,
          defaultModel: d.model,
          fetchedAt: Date.now(),
          models,
        };
        this.catalogFetchedAt = Date.now();
      } catch { /* keep the previous catalog */ }
    })();
    try {
      await this.catalogInflight;
    } finally {
      this.catalogInflight = null;
    }
    return this.catalog;
  }

  /** Ensure a catalog exists before serving a request that needs one. */
  async ensureCatalog(): Promise<Catalog | null> {
    return this.refreshCatalog(this.catalog === null);
  }

  multiplier(id: string): number {
    return this.modelIndex.get(id) ?? 1;
  }

  /** GET /me/stats with the JWT. */
  async stats(jwt: string): Promise<MeStats | null> {
    try {
      const res = await this.authedFetch(new URL("/me/stats", this.baseUrl), () => ({
        headers: this.authHeaders(jwt),
        signal: AbortSignal.timeout(10_000),
      }));
      if (!res.ok) return null;
      return (await res.json()) as MeStats;
    } catch {
      return null;
    }
  }

  /** Locale/os headers the 0.6.19 CLI attaches to ad calls (only /ads/next
   * carries them upstream). Values mirror the CLI on a common desktop. */
  clientEnvHeaders(sessionId: string, turnId: string): Record<string, string> {
    let tz = "UTC";
    let locale = "en-US";
    try {
      const o = new Intl.DateTimeFormat().resolvedOptions();
      if (o.timeZone) tz = o.timeZone;
      if (o.locale) locale = o.locale;
    } catch { /* ignore */ }
    return {
      "x-client-os": CLIENT_OS,
      "x-client-arch": CLIENT_ARCH,
      "x-client-locale": locale,
      "x-client-timezone": tz,
      "x-session-id": sessionId,
      "x-turn-id": turnId,
    };
  }

  /** GET /ads/next?slot=... — 204/!ok => null. */
  async fetchAdNext(jwt: string, slot: string, sessionId: string, turnId: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(new URL(`/ads/next?slot=${encodeURIComponent(slot)}`, this.baseUrl), {
        headers: { ...this.authHeaders(jwt), ...this.clientEnvHeaders(sessionId, turnId) },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 204 || !res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** POST /ads/impression (best-effort). */
  async postImpression(jwt: string, adId: string, clickToken: string, sessionId: string, turnId: string): Promise<void> {
    try {
      await fetch(new URL("/ads/impression", this.baseUrl), {
        method: "POST",
        headers: { ...this.authHeaders(jwt), "content-type": "application/json", "x-session-id": sessionId },
        body: JSON.stringify({ ad_id: adId, click_token: clickToken, imp_fired: true }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch { /* best-effort */ }
  }

  /**
   * CLI-shaped ad cycle for one turn: fetch the banner slot ad, fire the
   * Gravity impression pixel, and report the impression with imp_fired. The
   * CLI shows an ad before every foreground chat; serving one impression pair
   * per turn keeps the ads gate from ever tripping.
   */
  async warmAds(jwt: string, sessionId: string, turnId: string): Promise<void> {
    try {
      const ad = await this.fetchAdNext(jwt, "banner", sessionId, turnId);
      if (!ad || !ad.ad_id || !ad.click_token) return;
      const isGravityImp = ad.source === "gravity" && typeof ad.imp_url === "string"
        && /^https:\/\/[^/]*trygravity\.(ai|com)\//.test(ad.imp_url);
      if (isGravityImp) {
        void fetch(ad.imp_url, { signal: AbortSignal.timeout(3_000) }).catch(() => {});
      }
      await this.postImpression(jwt, String(ad.ad_id), String(ad.click_token), sessionId, turnId);
    } catch { /* best-effort */ }
  }

  /** POST /v1/chat/completions — returns the raw upstream Response. */
  completions(jwt: string, body: string, sessionId: string, turnId: string, signal?: AbortSignal): Promise<Response> {
    return this.authedFetch(new URL("/v1/chat/completions", this.baseUrl), () => ({
      method: "POST",
      signal,
      headers: {
        ...this.authHeaders(jwt),
        "content-type": "application/json",
        "x-session-id": sessionId,
        "x-turn-id": turnId,
      },
      body,
    }));
  }

  /** POST /session/reset — releases an occupied concurrent-session slot. */
  async resetSession(jwt: string): Promise<void> {
    try {
      await fetch(new URL("/session/reset", this.baseUrl), {
        method: "POST",
        headers: this.authHeaders(jwt),
        signal: AbortSignal.timeout(5_000),
      });
    } catch { /* best-effort */ }
  }
}

export { CONSENT_VERSION };

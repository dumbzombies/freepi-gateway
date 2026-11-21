// Persistent proxy settings. Read once at startup; environment variables seed
// the defaults, so existing deployments keep working without this file.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CACHE_ENABLED,
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  DATA_DIR,
} from "./config.ts";

export interface Settings {
  models: { showPremium: boolean };
  cache: { enabled: boolean; ttlMs: number; maxEntries: number; maxBytes: number };
  ads: { gravity: boolean };
}

export const SETTINGS_PATH = join(DATA_DIR, "settings.json");

export function defaultSettings(): Settings {
  return {
    models: { showPremium: process.env.FREEPI_SHOW_PREMIUM === "1" },
    cache: {
      enabled: CACHE_ENABLED,
      ttlMs: CACHE_TTL_MS,
      maxEntries: CACHE_MAX_ENTRIES,
      maxBytes: CACHE_MAX_BYTES,
    },
    ads: { gravity: process.env.FREEPI_NO_GRAVITY_PIXEL !== "1" },
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Merge the settings file over defaults. Unknown or invalid fields are ignored. */
export async function loadSettings(): Promise<Settings> {
  const s = defaultSettings();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch {
    return s;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return s;
  const obj = raw as Record<string, unknown>;
  const models = (obj.models ?? {}) as Record<string, unknown>;
  const cache = (obj.cache ?? {}) as Record<string, unknown>;
  const ads = (obj.ads ?? {}) as Record<string, unknown>;
  s.models.showPremium = bool(models.showPremium, s.models.showPremium);
  s.cache.enabled = bool(cache.enabled, s.cache.enabled);
  s.cache.ttlMs = positiveInt(cache.ttlMs, s.cache.ttlMs, 1000, 30 * 24 * 3_600_000);
  s.cache.maxEntries = positiveInt(cache.maxEntries, s.cache.maxEntries, 1, 100_000);
  s.cache.maxBytes = positiveInt(cache.maxBytes, s.cache.maxBytes, 1024, 1024 ** 3);
  s.ads.gravity = bool(ads.gravity, s.ads.gravity);
  return s;
}

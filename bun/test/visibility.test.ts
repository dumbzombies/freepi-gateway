import { test, expect } from "bun:test";
import { defaultSettings } from "../src/settings.ts";
import { isModelVisible, isPremiumOnly } from "../src/visibility.ts";
import { sessionLimitError } from "../src/proxy.ts";

const base = { name: "Model", multiplier: 0 };

test("premium-only classification follows the 403 bucket", () => {
  expect(isPremiumOnly({ ...base, id: "free", free: true })).toBe(false);
  expect(isPremiumOnly({ ...base, id: "charged", free: false })).toBe(false);
  expect(isPremiumOnly({ ...base, id: "big", free: false, multiplier: 1 })).toBe(true);
  expect(isPremiumOnly({ ...base, id: "mimo-v2.6-flash", free: false, multiplier: 0.8 })).toBe(true);
});

test("premium models are hidden unless settings opt in", () => {
  const settings = defaultSettings();
  const premium = { ...base, id: "big", free: false, multiplier: 2 };
  expect(isModelVisible(premium, settings)).toBe(false);
  expect(isModelVisible(premium, { ...settings, models: { showPremium: true } })).toBe(true);
  expect(isModelVisible({ ...premium, unavailable: true }, { ...settings, models: { showPremium: true } })).toBe(false);
});

test("session cap 409 becomes an actionable error", () => {
  const raw = JSON.stringify({ error: { code: "session_limit", message: "too many active sessions" } });
  const out = sessionLimitError(409, raw);
  expect(out).not.toBeNull();
  const parsed = JSON.parse(out as string) as { error: { code: string; message: string; upstream: unknown } };
  expect(parsed.error.code).toBe("session_limit");
  expect(parsed.error.message).toContain("4 concurrent sessions");
  expect(parsed.error.upstream).toBeDefined();

  expect(sessionLimitError(409, "quota exceeded")).toBeNull();
  expect(sessionLimitError(401, raw)).toBeNull();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings } from "../src/settings.ts";
import { isModelVisible, isPremiumOnly } from "../src/visibility.ts";
import { sessionLimitError } from "../src/proxy.ts";

const base = { name: "Model", multiplier: 0 };

test("premium-only classification follows the 403 bucket", () => {
  assert.equal(isPremiumOnly({ ...base, id: "free", free: true }), false);
  assert.equal(isPremiumOnly({ ...base, id: "charged", free: false }), false);
  assert.equal(isPremiumOnly({ ...base, id: "big", free: false, multiplier: 1 }), true);
  assert.equal(isPremiumOnly({ ...base, id: "mimo-v2.6-flash", free: false, multiplier: 0.8 }), true);
});

test("premium models are hidden unless settings opt in", () => {
  const settings = defaultSettings();
  const premium = { ...base, id: "big", free: false, multiplier: 2 };
  assert.equal(isModelVisible(premium, settings), false);
  assert.equal(isModelVisible(premium, { ...settings, models: { showPremium: true } }), true);
  assert.equal(isModelVisible({ ...premium, unavailable: true }, { ...settings, models: { showPremium: true } }), false);
});

test("session cap 409 becomes an actionable error", () => {
  const raw = JSON.stringify({ error: { code: "session_limit", message: "too many active sessions" } });
  const out = sessionLimitError(409, raw);
  assert.ok(out);
  const parsed = JSON.parse(out) as { error: { code: string; message: string; upstream: unknown } };
  assert.equal(parsed.error.code, "session_limit");
  assert.match(parsed.error.message, /4 concurrent sessions/);
  assert.ok(parsed.error.upstream);

  assert.equal(sessionLimitError(409, "quota exceeded"), null);
  assert.equal(sessionLimitError(401, raw), null);
});

# Memory

Append-only. Dated decisions and gotchas. No secrets.

## 2026-11-21 — Memory bank initialized

- Created `.agents/` with `README.md`, `state.md`, this file, per the memory-bank
  protocol. Root `AGENTS.md` already existed and is authoritative for conventions.
- Canonical tree is root `src/` (Node); `bun/src/` mirrors behavior and adds auth,
  health probes, and container packaging. A behavior fix lands in both.
- Tests must isolate state by setting `HOME` and `FREEPI_DATA_DIR` to a temp dir
  before importing `config.ts`; config resolves paths at import time.
- Root has no bearer auth and always binds loopback. Auth and `/healthz`/`/readyz`
  exist only in the Bun variant; the root README's health-probe claim is stale.
- Never bypass, spoof, or hide ad/impression reporting or metering.

## 2026-11-21 — Billing visibility, probes, Docker docs

- `src/visibility.ts` (mirrored in `bun/src/`) hides premium-only models by default: non-free with
  `multiplier >= 1`, plus 17 observed sub-1x outliers (`mimo-v2.6-flash` et al.). `models.showPremium`
  in `~/.freepi-proxy/settings.json` or `FREEPI_SHOW_PREMIUM=1` exposes them. Provider registration and
  `/v1/models` share `isModelVisible`; `/v1/models` and `/api/state` now carry `premium`, plus
  `free`/`multiplier` on OpenAI entries.
- `src/settings.ts` reads cache caps, `models.showPremium`, and `ads.gravity` at startup, seeded by the
  existing env defaults. Both variants construct `ResponseCache(settings.cache)` and skip Gravity when
  disabled.
- Upstream's 4-concurrent-session `409` is rewritten by `sessionLimitError` to
  `code: "session_limit"` with a recovery hint; upstream detail is preserved under `.error.upstream`.
  Reset command: `POST https://api.freepi.ai/session/reset` with the JWT.
- `scripts/probe-context.mjs` and `scripts/probe-billing.mjs` were ported from `freepi-plugin`. They read
  `FREEPI_CREDENTIALS_PATH` (JSON `.token`), spend credits, and write probe JSON into `FREEPI_DATA_DIR`.
- Docker docs added under README Install → Docker (`cd bun`, `.env`, `docker compose up -d --build`,
  dashboard on `127.0.0.1:18095`). Installer/raw URLs now point at `dumbzombies/freepi-gateway` (the original `freepi-proxy` repo is disabled by GitHub).

## 2026-11-21 — Service removed; public repo moved

- The local proxy ran as a Termux `runsv` service at `$PREFIX/var/service/freepi-proxy`
  (`cd ~/projects/freepi-proxy && exec bun src/main.ts`). Removed with `sv-disable`,
  `sv down`, then `rm -rf` of the service and `$PREFIX/var/log/freepi-proxy`; port 8452
  now closed. `~/.freepi-proxy` state was kept.
- `dumbzombies/freepi-proxy` was deleted from GitHub on 2026-11-23 (previously
  disabled, 403 on push/edit). `origin` was repointed at `dumbzombies/freepi-gateway`.
- `freepi-plugin` is a separate product: in-process loopback server on `8473+`, own token
  `~/.freepi-plugin/token`, direct upstream calls, no gateway import or port dependency.
  Running both splits the same account's credits and 4-session cap.

## 2026-11-23 — Bug-hunt fixes

- `LoginManager.start()` returns a provisional session synchronously; `#run` fills
  the device code and checks ownership, so `/api/login/start` answers 200 instead of
  500 and a second start cannot revive a stopped flow.
- `track.ts` serializes appends and rewrites on one promise queue and rewrites from a
  snapshot taken at enqueue time; concurrent `reconcile()` no longer duplicates or
  drops `requests.jsonl` entries.
- `Upstream.runAdCycle` is awaited before the completion: the ad cycle must land for
  the turn id first, or upstream answers `ads_required`. The Gravity pixel stays
  fire-and-forget.
- Root `Upstream` ads calls use `this.baseUrl` (tests injecting a fake upstream no
  longer hit production), and root token/upstream fetches carry `AbortSignal` timeouts
  like the Bun variant.
- Dashboard Basic auth decodes credentials as UTF-8 (`Buffer.from(...,"base64")`);
  `atob()` made non-ASCII passwords impossible to match.
- `settleSpend` stamps `lastCreditDiffAt` before awaiting stats, so concurrent
  completions cannot reconcile the same window twice.

## 2026-11-24 — session-limit rewrite reaches /v1/messages; translator post-[DONE] guard

- `sessionLimitText` (exported from `src/proxy.ts` and `bun/src/proxy.ts`) is the shared 409
  concurrent-session detector. `sessionLimitError` wraps it for the OpenAI shape; the Anthropic
  error path in both `anthropic.ts` files reuses it and answers 409 with `rate_limit_error` and
  the friendly message. Symptom fixed: Claude Code saw raw "concurrent session limit reached"
  as a generic `api_error` and could not self-recover.
- `AnthropicStreamTranslator.handleLine` now drops frames arriving after `[DONE]` so no events
  emit past `message_stop`. Gotcha: `finish()` flushes its trailing partial line through the
  unguarded `handleDataLine` — putting the guard on the shared path would silently drop a final
  data line that lacks a trailing newline.
- Regression coverage: `test/regressions.test.ts` drives the real proxy against a stub that
  answers 409 and asserts both endpoint rewrites (credentials seeded via the new
  `startProxy(url, { token })` parameter, because the JWT is read once at boot). Translator
  regressions live in `test/anthropic.test.ts` and `bun/test/anthropic.test.ts`.

## 2026-11-24 — cfwork/ Cloudflare Worker variant

- New third variant `cfwork/`: same gateway behavior on Workers free tier.
  Secrets: `FREEPI_TOKENS` (pool: JSON array or newline/comma separated, plus
  `FREEPI_TOKEN`/`FREEPI_TOKEN_ALT` shapes) and `WORKER_API_KEY` (fail-closed
  bearer gate — unset key refuses every /v1 request).
- Gate semantics ported from proven production use (pingmike2/freepi2api):
  per-turn `x-turn-id` shared by ads+chat; 400 ms beat after the impression
  (upstream records asynchronously); fake-200 detection = HTTP 200 + JSON
  content-type + `"prompt_tokens":0` + "shows ads"/"out of date" (never read a
  streaming body for it); `concurrent_session` arrives as 409 OR 429 →
  `POST /session/reset` then retry once; account gates (`ads_required`,
  `hourly_ceiling`, `credits_exhausted`, `daily_ceiling`, `quota_exhausted`)
  walk the pool instead of failing the request.
- Session id is per-isolate per-account (lazy uuid); a recycle silently mints
  a new one — safe because concurrent_session self-heals via /session/reset.
- Deliberately unported (cfwork/UNPORTED.md): login UI, dashboard, MCP, tools
  endpoints, requests.jsonl, settle reconciliation, canonical cache keys
  (Worker hashes raw bytes — canonicalizing large prompts would blow the
  10 ms CPU cap).
- Tests: `cd cfwork && npm test` invokes the fetch handler directly against a
  node:http stub upstream — no workerd needed, runs on Node ≥ 22.

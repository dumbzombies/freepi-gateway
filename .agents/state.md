# State

Last updated: 2026-11-24 (cfwork)

Goal: keep `freepi-proxy` as a zero-dependency gateway (OpenAI/Anthropic APIs,
dashboard, MCP) with billing-aware model visibility, across three variants:
canonical Node `src/`, Bun `bun/src/`, and Cloudflare Workers `cfwork/`.

## Progress

- **New: `cfwork/` Cloudflare Worker variant** — 24/7 on Workers free tier.
  OpenAI + Anthropic endpoints (streaming both), `/v1/models`, `/v1/usage`,
  `/v1/messages/count_tokens`, `/healthz`; account pool with in-place gate
  handling (ads warm + 400 ms beat, fake-200 "out of date" rewarm,
  concurrent_session → /session/reset retry, session-too-long rotation,
  account-gate pool walk); 426 version gate; per-isolate response cache and
  usage counters. Fail-closed `WORKER_API_KEY` bearer gate. Deploy with
  `npx wrangler deploy` (see `cfwork/README.md`); deliberately-missing features
  listed in `cfwork/UNPORTED.md`. Tests: 32 pass (`cd cfwork && npm test`,
  handler invoked directly against a node:http stub — no workerd).
- Premium-gated models hidden by default (`src/visibility.ts`, mirrored in
  `bun/src/`); `cfwork` mirrors this via `FREEPI_SHOW_PREMIUM`.
- Upstream 409 session-cap replies are rewritten to an actionable error on
  BOTH endpoints in root and Bun (`sessionLimitText` in `src/proxy.ts` /
  `bun/src/proxy.ts`); the Anthropic path emits `rate_limit_error`. In
  `cfwork/` the same rewrite exists and additionally covers the 429 variant.
- `AnthropicStreamTranslator` drops SSE frames arriving after `[DONE]` in all
  three trees; the trailing-buffer flush goes through unguarded
  `handleDataLine`.
- Probes `scripts/probe-context.mjs` and `scripts/probe-billing.mjs` read
  `FREEPI_CREDENTIALS_PATH` (JSON `.token`).
- Test counts: root 42 pass / 3 skip, Bun 72 pass, cfwork 32 pass.
- bug-hunter 2026-11-23 fixes still in place (uncommitted): login/start 500,
  tracker append/rewrite corruption, ad-cycle race, root ads base URL,
  non-ASCII basic auth, missing timeouts, settle double-count.
- Published public at `https://github.com/dumbzombies/freepi-gateway`
  (`origin/main` == `79ecb97`). Local Termux `runsv` service deleted; port
  8452 closed. Plugin `~/projects/freepi-plugin` remains independent.

## Blockers

- Docker daemon unavailable in this environment; container build documented
  but not run.
- No Cloudflare account/token here: `cfwork/` is verified by the 32-test
  handler suite only; a real `wrangler deploy` + `wrangler tail` smoke is
  still pending.

## Next actions

- Commit and push the pending work (2026-11-23/24 fixes + `cfwork/`) to
  `origin main` (`dumbzombies/freepi-gateway`).
- Deploy `cfwork/` once a Cloudflare account is available: `wrangler deploy`,
  set the two secrets, smoke `/healthz` + one completion, check
  `Metrics → CPU Time` p99 stays under 10 ms.
- If the local proxy is restarted, run `node src/main.ts` / `bun src/main.ts`
  manually; no service currently exists.

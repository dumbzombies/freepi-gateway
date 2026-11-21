# State

Last updated: 2026-11-21

Goal: keep `freepi-proxy` as a zero-dependency local gateway (OpenAI/Anthropic APIs,
dashboard, MCP) with billing-aware model visibility, and keep `bun/src/` in sync with
root `src/`.

## Progress

- Premium-gated models hidden by default (`src/visibility.ts`, mirrored in `bun/src/`).
  `/v1/models` exposes `free`, `premium`, `multiplier`; `/api/state` catalog carries
  `premium`. Opt in with `models.showPremium` or `FREEPI_SHOW_PREMIUM=1`.
- `src/settings.ts` and `bun/src/settings.ts` load `~/.freepi-proxy/settings.json` at
  startup: cache caps, model visibility, Gravity toggle. Env seeds defaults.
- Upstream 409 session-cap replies are rewritten to `code: "session_limit"` with
  recovery text by `sessionLimitError` in both proxies.
- Probes `scripts/probe-context.mjs` and `scripts/probe-billing.mjs` read
  `FREEPI_CREDENTIALS_PATH` (JSON `.token`).
- Tests: `test/visibility.test.ts` and `bun/test/visibility.test.ts`; Bun
  `test/app.test.ts` verifies hidden-by-default and opt-in listing.
- Published public at `https://github.com/dumbzombies/freepi-gateway` (`public/main`
  == `d025216`). Original `dumbzombies/freepi-proxy` is GitHub-disabled; do not push
  to `origin`. Remote `public` points at the live repo.
- Local Termux `runsv` service `freepi-proxy` was stopped, disabled, and deleted
  (`$PREFIX/var/service/freepi-proxy`, `$PREFIX/var/log/freepi-proxy`). Port 8452 is
  closed. `~/.freepi-proxy` state remains.
- Plugin `~/projects/freepi-plugin` is independent: own loopback server `8473+`,
  `~/.freepi-plugin/token`, no gateway dependency.

## Blockers

- Docker daemon unavailable in this environment; container build documented but not
  run.
- `gh repo edit dumbzombies/freepi-proxy --visibility public` and pushes to `origin`
  fail with HTTP 403 (repo disabled). Use remote `public`.

## Next actions

- Push future commits to `public main`, not `origin`.
- If the proxy is restarted, run `node src/main.ts` / `bun src/main.ts` manually or
  reinstall a service; no service currently exists.
- Verify Docker build on a host with a running daemon when needed.

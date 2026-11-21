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
- `dumbzombies/freepi-proxy` is GitHub-disabled: edits and pushes return 403 even though
  the listing shows public. Live code is `dumbzombies/freepi-gateway`; installer/raw URLs
  and remote `public` point there. Do not push to `origin`.
- `freepi-plugin` is a separate product: in-process loopback server on `8473+`, own token
  `~/.freepi-plugin/token`, direct upstream calls, no gateway import or port dependency.
  Running both splits the same account's credits and 4-session cap.

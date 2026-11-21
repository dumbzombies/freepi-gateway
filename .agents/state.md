# State

Last updated: 2026-11-21

`freepi-proxy` is a zero-dependency local gateway that exposes a free-pi account as
OpenAI- and Anthropic-compatible APIs, plus a dashboard and MCP server.

## Two variants

- `src/` — canonical Node build (`node:http`, Node >= 22.19). Binds `127.0.0.1` only,
  no bearer auth, no `/healthz`.
- `bun/src/` — always-on Bun build (`Bun.serve`, Bun >= 1.2). Adds bearer token
  (`FREEPI_PROXY_TOKEN`), `/healthz`, `/readyz`, access log, idle timeout, Docker image.

Shared behavior must be fixed in both trees.

## Modules (root)

|Module|Responsibility|
|---|---|
|`main.ts`|Router, dashboard auth, `node:http` ↔ Fetch bridge, body cap|
|`proxy.ts`|OpenAI completions/models/usage; token gate, cache, streaming replay|
|`anthropic.ts`|Anthropic↔OpenAI translation; shared cache keys; SSE translator|
|`state.ts`|Session id, spent-session retirement/replay (one retry), stats poll, settle|
|`upstream.ts`|free-pi client: catalog, version negotiation and 426 gate, `/me`, stats, tools, completions, ads|
|`token.ts`|Credentials load/save, `/me` validation, device login|
|`cache.ts`|Exact-response LRU: TTL, byte cap, single-flight; SSE replay via fresh translator|
|`settings.ts`|Startup settings file: cache caps, `models.showPremium`, Gravity toggle|
|`visibility.ts`|Premium-403 model classification, shared by `/v1/models` and `/api/state`|
|`models.ts`|Aliases, free-model filtering, slot mapping|
|`mcp.ts`|JSON-RPC over POST: `initialize`, `ping`, `tools/list`, `tools/call`|
|`track.ts`|`requests.jsonl` append + in-memory aggregates for `/api/state`|
|`gravity.ts`|Optional Gravity ad-context bridge|
|`ui.html`|Single self-contained dashboard; polls `/api/state` every 5 s|

Bun: `bun/src/app.ts` replaces `main.ts` routing/auth/health; `bun/src/token.ts`
adds bearer scoping.

## Runtime paths

- Data: `FREEPI_DATA_DIR` (default `~/.freepi-proxy`) — `requests.jsonl`,
  `session-id`, `client-version`.
- Credentials: `~/.free-pi/agent/credentials.json` (0600), shared with free-pi-cli.
- Root always binds `127.0.0.1`. Bun honors `FREEPI_HOST`.
- Env is read at module import time, so tests must set `HOME`/`FREEPI_DATA_DIR`
  before dynamic import.

## Request flow

auth gate → exact-response cache (sha256 of canonical body) → session-retry wrapper →
ads → upstream → tee (client stream untouched, local drain for usage) → estimate,
then settle against server spend → `requests.jsonl`.

Metering estimate: `(prompt + completion) * model multiplier * 0.00222` credits,
reconciled with settled spend. Ad/impression reporting must never be bypassed.

## Tests

- Root: `npm test` → `node --test test/*.test.ts`. Opt-in live e2e:
  `FREEPI_E2E=1` (spends credits; never in routine runs).
- Bun: `cd bun && bun test`; preload (`bun/test/setup.ts`) isolates state globally.
- Bun `test/app.test.ts` uses `testCtx()` + `createHandler()` against a fake upstream.
- Visibility/session-cap coverage: `test/visibility.test.ts` and `bun/test/visibility.test.ts`.
- Thin coverage: `mcp.ts`, `proxy.ts`, `token.ts`, `track.ts`, `gravity.ts`,
  `upstream.ts`.
- Probes: `node scripts/probe-context.mjs`, `node scripts/probe-billing.mjs` (spend credits).

## Known constraints

- Upstream is unofficial and can change without notice.
- `FREEPI_DASHBOARD_PASSWORD` gates `/` and `/api/*` except `/api/hello` and
  `/api/claude/config`; the launcher's `status` probe assumes no password.
- Launcher prefers Node, pins pid/log to `~/.freepi-proxy`, ignores `FREEPI_DATA_DIR`.
- Windows `install.ps1` shim is foreground-only.
- No linter, formatter, CI, or coverage gate.
- Docker daemon is unavailable in this environment; the container build is documented but unverified here.
- Default `/v1/models` exposes 10 models (4 free + 6 allowance-charged); premium needs an opt-in.

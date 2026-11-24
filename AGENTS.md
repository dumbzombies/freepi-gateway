# Repository Guidelines

## Project Overview

`freepi-proxy` is a gateway that turns a free-pi (freepi.ai) account into
OpenAI- and Anthropic-compatible APIs. It also serves a dashboard/chat UI and an
MCP server. Unofficial; it uses the same backend as `free-pi-cli` and upstream
behavior can change. Zero runtime dependencies, no build step for source runs.
Three variants share behavior but not code:

- **Root `src/`** — canonical Node.js build (`node:http`). This is what `freepi-proxy` installs and runs.
- **`bun/src/`** — always-on Bun variant (`Bun.serve`), adds bearer auth, health probes, Docker packaging.
- **`cfwork/`** — Cloudflare Workers free-tier variant (24/7, no server); account-pool gate handling per `cfwork/README.md`; see `cfwork/UNPORTED.md` for what is deliberately absent.

## Architecture & Data Flow

```
OpenAI  POST /v1/chat/completions ─┐
Anthropic POST /v1/messages ───────┤
                                   ▼
                        auth gate (variant-specific)
                                   ▼
                    exact-response cache (sha256 canonical body)
                                   ▼
             session-retry wrapper → ad cycle → upstream request
                                   ▼
              tee: client stream untouched | local drain for usage
                                   ▼
          usage estimate + stats settle → requests.jsonl aggregates
```

- `src/main.ts` routes all HTTP, bridges `node:http` to Web `Request`/`Response`, caps bodies, binds
  loopback. `bun/src/app.ts` does the equivalent for `Bun.serve` and adds `/healthz`, `/readyz`.
- `src/proxy.ts` handles OpenAI completions/models/usage: token gate, cache wrapper, streaming replay,
  upstream error passthrough, async usage accounting.
- `src/anthropic.ts` is the Anthropic↔OpenAI translator. Cache keys use the translated OpenAI body, so
  both APIs share entries. Streaming runs through `AnthropicStreamTranslator`.
- `src/state.ts` owns session id, retirement/replay on spent sessions, stats polling, and settle
  reconciliation. Only known spent-session errors retry, once, with a fresh session.
- `src/upstream.ts` is the free-pi client: catalog/version negotiation (including the 426
  `upgrade_required` gate), `/me`, stats, tools, completions, ads.
- `src/cache.ts` is an in-memory LRU with TTL, byte cap, and single-flight. Cached SSE replays through a
  fresh translator.
- `src/mcp.ts` serves JSON-RPC over POST: `initialize`, `ping`, `tools/list`, `tools/call`.
- `src/track.ts` appends `requests.jsonl` and maintains in-memory aggregates; `src/ui.html` polls
  `/api/state` every 5 s and talks to the proxy as a normal client.
- Metering estimate is `(prompt + completion tokens) * model multiplier * 0.00222` credits; settled
  spend reconciles the estimate. Never bypass, spoof, or hide ad/impression reporting or metering.

## Key Directories

| Path | Purpose |
|---|---|
|`src/`|Canonical Node implementation, HTML dashboard, MCP server|
|`bun/src/`|Bun variant; `app.ts` replaces `main.ts`, plus token/auth and health endpoints|
|`cfwork/`|Cloudflare Worker variant; `src/index.ts` router, `wrangler.jsonc`, secrets are `FREEPI_TOKENS` + `WORKER_API_KEY`|
| `test/` | Root `node:test` suites |
| `bun/test/` | `bun:test` suites, including real HTTP integration and dashboard extraction tests |
| `bun/` | Bun package metadata, Dockerfile, compose file, Bun-specific README |
| `freepi-proxy` | Bash launcher: `start`, `stop`, `restart`, `status`, `logs`, `open`, `models`, `claude` |
| `install.sh`, `install.ps1` | User-local installers that fetch `main` and link a command |

## Development Commands

```sh
# canonical Node run and tests
node src/main.ts
npm test                              # node --test test/*.test.ts
node --test test/cache.test.ts
FREEPI_E2E=1 node --test test/e2e.test.ts   # live proxy, spends credits

# Bun variant: always run from bun/ (bunfig.toml preloads test/setup.ts)
cd bun
bun src/main.ts
bun test
bun test test/app.test.ts
bun build --compile src/main.ts --outfile dist/freepi-proxy

# container (build context is bun/)
cd bun && cp .env.example .env && docker compose up -d --build
```

There is no linter, formatter, CI, or `npm install`. `npm run start:bun` exists at root but the Bun
variant's source and tests live under `bun/`.

## Code Conventions & Common Patterns

- **Standard library only.** Node built-ins use `node:` prefixes; HTTP work uses Web `fetch`,
  `Request`, `Response`, and streams. Do not add runtime dependencies or a build step.
- **ESM everywhere** (`"type": "module"`). Root runs TypeScript directly via Node type stripping.
- **Module per concern, lowercase filenames**, `camelCase` functions/variables, `UPPER_SNAKE`
  constants, `PascalCase` types. Match surrounding style; there is no formatter.
- **Config is read at module import time.** `DATA_DIR` and derived paths are constants; keep pure
  modules (cache, models, translator) free of side effects so they stay trivially testable.
- **Errors:** pass upstream 4xx/5xx through and never cache them. Retry only the documented
  spent-session classes with exactly one replay. Do not convert failures into empty successes.
- **Streaming:** do not buffer a response that should stream. The cache tees the body so the client
  branch is returned untouched; the local branch is drained only for usage.
- **State mutation:** session ids, client version, and usage logs live under `FREEPI_DATA_DIR`
  (default `~/.freepi-proxy`). Credentials live at `FREEPI_CREDENTIALS_PATH`
  (default `~/.free-pi/agent/credentials.json`, written `0600`).
- **Dashboard:** one self-contained `src/ui.html`; no external requests, fonts, or assets. Shared UI
  helpers are extracted in tests, so keep them as named functions.
- **Two trees:** a behavior fix in `src/` usually needs the same fix in `bun/src/` (and vice versa).
  Root is canonical, but installed users may run either.

## Important Files

| File | Role |
|---|---|
| `src/main.ts` | Node entry, router, dashboard auth, HTTP↔fetch bridge |
| `src/proxy.ts` | OpenAI-compatible handlers and cache flow |
| `src/anthropic.ts` | Anthropic translation, non-stream and SSE handlers |
| `src/state.ts` | Session lifecycle, retries, stats polling |
| `src/upstream.ts` | free-pi API client, catalog, version/426 gate, ads |
| `src/token.ts` | credentials load/save, `/me` validation, device login |
| `src/cache.ts` | exact-response LRU + single-flight |
| `src/config.ts` | Constants, paths, environment defaults |
| `src/models.ts` | Aliases, free-model filtering, slot mapping |
| `src/mcp.ts` | MCP JSON-RPC tools |
| `src/track.ts` | JSONL request log and aggregates |
| `src/gravity.ts` | Optional Gravity ad-context SDK bridge |
| `bun/src/app.ts` | Bun router, bearer gate, health probes, access log |
| `bun/src/main.ts` | Bun entry; embeds `ui.html` via text import |
| `freepi-proxy` | Launcher and runtime selection |
| `bun/Dockerfile`, `bun/compose.yml` | Container build, `/data` volume, port 8452 |

## Runtime/Tooling Preferences

- **Node ≥ 22.19** for the root build (Node 22 type stripping). **Bun ≥ 1.2** for `bun/`.
- Root ignores `FREEPI_HOST` and always binds `127.0.0.1`; it has no bearer token and no
  `/healthz`/`/readyz`. Those exist only in the Bun variant. Root README's health probe claim is stale.
- Bun adds `FREEPI_HOST`, `FREEPI_PROXY_TOKEN`, `FREEPI_IDLE_TIMEOUT_S`, `FREEPI_ACCESS_LOG`,
  `FREEPI_MAX_BODY_BYTES`. `.env` files are auto-loaded by Bun, not Node.
- `FREEPI_DASHBOARD_PASSWORD` gates `/` and `/api/*` except `/api/hello` and `/api/claude/config`.
  The launcher probes `/api/state` without credentials, so `status`/`start -d` break when it is set.
- The launcher prefers `node` whenever present and pins pid/log to `~/.freepi-proxy`, ignoring
  `FREEPI_DATA_DIR`. The Windows shim is foreground-only and ignores subcommands.
- Docker: image runs as `bun`, listens `0.0.0.0:8452`, publishes `127.0.0.1:18095`, stores state in
  the `freepi-data` volume at `/data`, requires `FREEPI_PROXY_TOKEN`, and healthchecks `/healthz`.

## Testing & QA

- Root: `npm test` (`node:test` + `node:assert/strict`), auto-discovers `test/*.test.ts`. Bun:
  `cd bun && bun test`, preloaded by `bun/test/setup.ts`.
- **State isolation is mandatory.** `config.ts` resolves paths at import. For disk-touching tests, set
  `HOME` and `FREEPI_DATA_DIR` to a `mkdtemp` directory *before* dynamic import
  (`test/upgrade.test.ts`, `test/session.test.ts`). Bun's preload already does this globally.
- Root e2e is opt-in with `FREEPI_E2E=1`, needs a running proxy, and spends credits. Never enable it
  in routine runs.
- Bun `test/app.test.ts` uses `testCtx()` + `createHandler()` against a fake `Bun.serve` upstream —
  extend that seam for routing/auth/streaming tests. Dashboard tests slice named functions out of
  `ui.html`; keep helper functions extractable.
- Direct coverage is thin for `mcp.ts`, `proxy.ts`, `token.ts`, `track.ts`, `gravity.ts`, and
  `upstream.ts`; `main.ts` and `app.ts` are covered mainly by integration. Add the narrowest test for
  changed behavior and run the suite for the variant you touched.
- No CI and no coverage gate. Before finishing: run the affected suite, plus the other variant's suite
  when shared behavior changed, and state which commands ran.

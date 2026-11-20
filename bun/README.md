# freepi-proxy (Bun, always-on)

Same free-pi backend as the parent build, but the HTTP surface is `Bun.serve`
instead of a `node:http` bridge: the handler receives the client `Request` and
returns a `Response` whose body is the live upstream stream. No body
re-buffering, no second copy of every SSE chunk, one process for the whole app.

Measured on the same machine and code shape: ~43 MB RSS under Bun vs ~94 MB
under Node 26 — which is why this build exists.

## Run

```sh
bun src/main.ts                       # foreground
FREEPI_PROXY_TOKEN=$(openssl rand -hex 24) bun src/main.ts   # with auth
bun build --compile src/main.ts --outfile dist/freepi-proxy  # single binary
```

## Endpoints

| Path | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI dialect (stream + non-stream) |
| `POST /v1/messages` | Anthropic dialect, translated both ways (stream + non-stream, tool use) |
| `POST /v1/messages/count_tokens` | Anthropic token estimate |
| `GET /v1/models` | Live catalog (`?refresh=1` forces a re-fetch) |
| `GET /v1/usage` | Authoritative quota/usage JSON (`?refresh=1` forces a poll) |
| `GET /healthz` | Liveness, never touches upstream |
| `GET /readyz` | 200 only when a token and the catalog are both loaded |
| `/mcp` | MCP tools (image, web search, docs, usage) |
| `/` | Dashboard |

Every response on `/v1/*` carries `x-freepi-cache: hit|miss`.

## Auth

Set `FREEPI_PROXY_TOKEN` to require a bearer token on `/v1/*`, `/api/*` and
`/mcp`. Accepted as `authorization: Bearer <token>`, `x-api-key: <token>`,
`x-freepi-token: <token>`, or `?token=<token>`.

Clients:

```sh
# OpenAI-compatible
OPENAI_BASE_URL=http://127.0.0.1:8452/v1
OPENAI_API_KEY=$FREEPI_PROXY_TOKEN

# Anthropic-compatible
ANTHROPIC_BASE_URL=http://127.0.0.1:8452
ANTHROPIC_AUTH_TOKEN=$FREEPI_PROXY_TOKEN

# Dashboard: open once with the token, it is remembered by the browser
open "http://127.0.0.1:8452/?token=$FREEPI_PROXY_TOKEN"
```

`/healthz`, `/readyz`, `/`, `/api/hello` and `/api/claude/config` stay open.

Separately, `FREEPI_DASHBOARD_PASSWORD` puts an HTTP Basic prompt in front of the
dashboard itself (`/`, `/index.html`, `/api/*` except the read-only probes).
Browsers cache the prompt, so no JS change is needed; `/v1/*` and `/mcp` are
untouched and keep answering to the bearer token.

**The proxy holds your free-pi credentials.** Without `FREEPI_PROXY_TOKEN`,
anyone who can reach the port spends your daily allowance — bind `127.0.0.1`,
use a TLS reverse proxy, or set the token.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FREEPI_PROXY_PORT` | `8452` | Listen port |
| `FREEPI_HOST` | `127.0.0.1` | Bind address |
| `FREEPI_PROXY_TOKEN` | *(empty)* | Bearer token required when set |
| `FREEPI_DASHBOARD_PASSWORD` | *(empty)* | HTTP Basic password for the dashboard and `/api/*`; `/v1/*` and `/mcp` keep the bearer rule |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | Upstream backend |
| `FREEPI_IDLE_TIMEOUT_S` | `120` | Socket idle timeout (max 255; SSE needs headroom) |
| `FREEPI_MAX_BODY_BYTES` | `67108864` | Max accepted request body |
| `FREEPI_CATALOG_REFRESH_MS` | `600000` | Model catalog refresh cadence |
| `FREEPI_CACHE` | *(on)* | `0` disables the exact-response cache |
| `FREEPI_CACHE_TTL_MS` | `3600000` | Cached response lifetime |
| `FREEPI_CACHE_MAX_ENTRIES` | `300` | Entry cap (LRU) |
| `FREEPI_CACHE_MAX_BYTES` | `33554432` | Total cached body bytes |
| `FREEPI_ACCESS_LOG` | *(off)* | `1` logs one line per request |
| `FREEPI_CREDENTIALS_PATH` | `~/.free-pi/agent/credentials.json` | Token file |
| `FREEPI_DATA_DIR` | `~/.freepi-proxy` | Data dir (persisted client version, session id) |
| `FREEPI_NO_GRAVITY_PIXEL` | *(unset)* | `1` disables the ad-attribution pixel |

## 24/7 behaviour

- `SIGTERM`/`SIGINT` drain in-flight requests (`server.stop`) with a 10s hard
  deadline, then clear every background timer and exit 0.
- Every upstream call is bounded by a fetch timeout (catalog/`/me`/stats 10s,
  auth 15s, tools 30s), so a hung upstream cannot wedge a loop.
- A thrown handler returns a JSON 500; `unhandledRejection` and
  `uncaughtException` are logged and do not exit the process.
- The cache is bounded by entry count and bytes; a response larger than the
  byte cap streams to the client and is simply not stored.
- The catalog is fetched before the port opens, so `/readyz` is truthful at
  boot; a failed fetch is retried on the normal cadence.

## systemd

```ini
[Unit]
Description=freepi-proxy (bun)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/freepi-proxy
Environment=FREEPI_PROXY_PORT=8452
Environment=FREEPI_HOST=127.0.0.1
Environment=FREEPI_PROXY_TOKEN=replace-me
Environment=FREEPI_ACCESS_LOG=0
Restart=always
RestartSec=2
TimeoutStopSec=15
# optional hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`ProtectHome=read-only` still allows reading `~/.free-pi/agent/credentials.json`
and writing nothing; add `ReadWritePaths=%h/.freepi-proxy` if you want the
request log and session id to persist.

## Tests

```sh
bun test                # 56 tests: cache, models, sessions, translation, HTTP
bun test test/app.test.ts
```

`test/app.test.ts` mounts the production handler in `Bun.serve` on an ephemeral
port against a scripted fake upstream: auth matrix, both dialects, streaming,
cache hit/miss, single-flight storms, error passthrough, tool-call translation,
and a client disconnect mid-stream (truncated turns are never cached).

`test/translator.test.ts` pins the Anthropic event sequence: ordering, block
indices, fragmented and parallel tool calls, usage-only chunks, malformed
lines, stop-reason mapping.

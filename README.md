# freepi-proxy

**A local OpenAI- and Anthropic-compatible gateway for [free-pi](https://freepi.ai),
with a dashboard, a chat UI and an MCP server — zero dependencies, no build step.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Node.js%20%E2%89%A5%2022.19%20%7C%20Bun-informational)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

free-pi funds inference with ads and hands every account a daily credit allowance. `freepi-proxy`
turns that account into a normal API endpoint: any OpenAI- or Anthropic-speaking agent, and
Claude Code, can talk to it on `127.0.0.1:8452` while the proxy handles authentication, ad
attribution, metering, caching and session rotation.

> **Unofficial.** Not affiliated with free-pi / freepi.ai. It uses the same backend as
> `free-pi-cli`; upstream behaviour and client checks can change.

---

## Contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Endpoints](#endpoints)
- [CLI](#cli)
- [Connect an agent](#connect-an-agent)
- [MCP tools](#mcp-tools)
- [Dashboard](#dashboard)
- [Credits, metering and cache](#credits-metering-and-cache)
- [Configuration](#configuration)
- [Security notes](#security-notes)
- [Development](#development)
- [License](#license)

## Features

| | |
|---|---|
| **OpenAI-compatible** | `POST /v1/chat/completions`, `GET /v1/models` — streaming and non-streaming |
| **Anthropic-compatible** | `POST /v1/messages`, `/v1/messages/count_tokens` — Claude Code runs unmodified |
| **MCP server** | Streamable HTTP at `/mcp`: `generate_image`, `web_search`, `docs_lookup`, `check_usage` |
| **Dashboard** | Credits and allowance, burn charts, request log, live model catalog, built-in chat UI |
| **Exact response cache** | Byte-identical requests are served from memory; `x-freepi-cache: hit\|miss` |
| **Auth handled** | GitHub device-flow login in the dashboard; shares `~/.free-pi/agent/credentials.json` with `free-pi-cli` |
| **Resilient sessions** | Single stable session id, automatic retirement and replay when upstream expires a session |
| **Zero dependencies** | Pure Node/Bun standard library, TypeScript executed directly |

## Install

Both installers need **Node.js ≥ 22.19 or Bun** on `PATH`. They download the latest `main`
archive, install to a user directory, and expose a `freepi-proxy` command. No admin rights.

### Linux / macOS / Termux

```sh
curl -fsSL https://raw.githubusercontent.com/therealfreddied/freepi-proxy/main/install.sh | bash
```

Installs to `${XDG_DATA_HOME:-$HOME/.local/share}/freepi-proxy` and links
`$HOME/.local/bin/freepi-proxy`. Override with `FREEPI_HOME` and `FREEPI_BIN`.

### Windows

```powershell
irm https://raw.githubusercontent.com/therealfreddied/freepi-proxy/main/install.ps1 | iex
```

Installs to `%LOCALAPPDATA%\freepi-proxy` and writes `freepi-proxy.cmd` into
`%LOCALAPPDATA%\Microsoft\WindowsApps`, which is already on `PATH`. On Windows the command runs
the proxy in the foreground; close the window or press `Ctrl+C` to stop it.

### From source

```sh
git clone https://github.com/therealfreddied/freepi-proxy.git
cd freepi-proxy

node src/main.ts      # or: bun src/main.ts
./freepi-proxy start -d
```

There is nothing to install: no `npm install`, no build step.

## Quick start

```sh
freepi-proxy start -d      # background proxy on port 8452
freepi-proxy open          # dashboard → log in with GitHub
freepi-proxy status        # account, credits, refill time
```

Open **http://127.0.0.1:8452**, complete the GitHub device-flow login, and the proxy is ready to
serve. The token is written to `~/.free-pi/agent/credentials.json` (mode `0600`) and is reused by
`free-pi-cli`. The proxy binds to `127.0.0.1` only and needs no API key of its own.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI-compatible completions; `stream: true` supported |
| `GET` | `/v1/models` | Live catalog; `?refresh=1` forces an upstream fetch (5 s floor) |
| `GET` | `/v1/usage` | Authoritative quota, usage and cache counters as one stable JSON object |
| `POST` | `/v1/messages` | Anthropic Messages API, translated to the OpenAI backend |
| `POST` | `/v1/messages/count_tokens` | Anthropic token counting |
| `GET` | `/mcp` | Streamable-HTTP MCP server |
| `GET` | `/` | Dashboard (single self-contained HTML file) |
| `GET` | `/api/state` | Dashboard state snapshot (credits, catalog, log, cache stats) |
| `GET` | `/healthz`, `/readyz` | Liveness and readiness probes |

`/v1/usage` example:

```json
{
  "object": "usage", "ok": true, "error": null,
  "handle": "…", "tier": "young", "lane": "standard", "notice": null,
  "quota": { "allowance_credits": 15000, "remaining_credits_today": 14905,
             "used_credits_today": 95, "remaining_pct": 99.4,
             "spent_usd_today": 0.007, "cap_usd_today": 1.125,
             "refill_at": "2026-11-21T00:00:00.000Z", "refill_in_ms": 1250225 },
  "usage": { "requests_today": 355, "prompt_tokens_today": 21187327,
             "completion_tokens_today": 197106, "lifetime_requests": 4021, "streak_days": 0 },
  "cache": { "hits": 12, "misses": 40, "entries": 9, "bytes": 184320, "hitRate": 0.23 },
  "proxy": { "uptime_ms": 6218, "catalog_fetched_at": 1795131544972, "stale_ms": 4808 }
}
```

`ok: false` with `error: "no_token" | "no_stats_yet"` means nothing authoritative exists yet;
fields are `null`, never absent.

## CLI

| Command | Description |
|---|---|
| `freepi-proxy start` | Run in the foreground (`Ctrl+C` to stop) |
| `freepi-proxy start -d` | Start in the background |
| `freepi-proxy stop` / `restart` | Stop or restart the background proxy |
| `freepi-proxy status` | Running state plus account and credits summary |
| `freepi-proxy logs [-f] [n]` | Show or follow `~/.freepi-proxy/proxy.log` |
| `freepi-proxy open` | Open the dashboard in a browser |
| `freepi-proxy models` | Print the live model list |
| `freepi-proxy claude` | Launch Claude Code against the proxy |

The Bash launcher is used on Linux, macOS and Termux. The Windows installer exposes a
foreground-only `freepi-proxy` command; use `start "" /b node "%LOCALAPPDATA%\freepi-proxy\src\main.ts"`
to detach it.

## Connect an agent

Point any OpenAI-format client at the proxy. Use **any non-empty** API key: the proxy injects your
real credential.

```sh
OPENAI_BASE_URL=http://127.0.0.1:8452/v1
OPENAI_API_KEY=local
```

Model IDs come from the live catalog (`glm-5.3-flash`, `deepseek-v4-flash`, `particle`, …). The
Models tab and `freepi-proxy models` show the current list, multipliers and availability.

### OpenCode

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "freepi/glm-5.3-flash",
  "providers": {
    "freepi": {
      "name": "free-pi (via local proxy)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8452/v1", "apiKey": "local" },
      "models": {
        "glm-5.3-flash": { "name": "GLM 5.3 Flash · 1.5x", "limit": { "context": 1048576, "output": 8192 } },
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash · 1x", "limit": { "context": 1048576, "output": 8192 } }
      }
    }
  },
  "mcp": {
    "freepi-tools": { "type": "remote", "url": "http://127.0.0.1:8452/mcp", "enabled": true }
  }
}
```

### Claude Code

```sh
freepi-proxy claude                  # start the proxy if needed and launch Claude Code
freepi-proxy claude --list           # current model mapping
freepi-proxy claude --model glm-5.3-flash
freepi-proxy claude -- -p "say hi"   # flags after -- go to Claude Code
```

The command builds a temporary settings profile and leaves `~/.claude/settings.json` untouched.
Slots are mapped from the live catalog: main → `deepseek-v4.1-flash`, Sonnet → `glm-5.3-flash`,
Haiku → `deepseek-v4-flash`, Fable → `particle`.

## MCP tools

| Tool | Description |
|---|---|
| `generate_image` | Generates an image and saves it under `./images/` (returns the path) |
| `web_search` | Live web search |
| `docs_lookup` | Library and framework documentation |
| `check_usage` | Read-only allowance snapshot |

Tool calls are metered against the daily allowance.

## Dashboard

One self-contained HTML file, no external requests, four tabs:

- **Overview** — credits remaining, daily cap, refill time, 24 h burn chart, ad panel
- **Activity** — paginated request log (model, tokens, estimated credits, status)
- **Models** — live catalog grouped into Free Unlimited, Standard, Uncensored, Premium, Unavailable
- **Chat** — streaming chat with any model: markdown, code copy, temperature/max-tokens/system
  prompt, regenerate, export; history kept in `localStorage`

Set `FREEPI_DASHBOARD_PASSWORD` to put the dashboard and `/api/*` behind HTTP Basic; `/v1/*` and
`/mcp` are unaffected. The layout is mobile-first and works down to 320 px.

## Credits, metering and cache

- Accounts have a **daily credit allowance** shared by every client. The dashboard and `/v1/usage`
  report the authoritative upstream `/me/stats` figures.
- **Models are priced by multiplier** (`0.2×` value tiers up to premium/heavy). Credit-gated models
  are enforced upstream. Per-request credits shown in the log are an instant estimate that
  reconciles to the settled spend when the server meter catches up.
- **Exact response cache.** The key is the canonical parsed request body (sorted object keys, array
  order preserved, `stream` included). `/v1/chat/completions` and `/v1/messages` share entries
  because the Anthropic handler keys on the translated OpenAI body. Hits cost nothing, are logged
  with `cached: true`, and concurrent identical requests are single-flighted. Non-2xx responses are
  never stored. `FREEPI_CACHE=0` disables the cache.
- **Client version self-heals.** Upstream rejects a stale `x-client-version` with `426 upgrade_required`.
  The proxy reads the required version out of that error (or the catalog), persists it to
  `~/.freepi-proxy/client-version`, and replays the call once — so an upstream minimum bump never
  reaches your client, and a restart no longer regresses to a compiled floor.
- **Sessions.** The proxy pins one session id per install (`~/.freepi-proxy/session-id`). When the
  backend retires a spent session (`session is too long`), the proxy mints a new one and replays
  the request once.
- Local data lives in `~/.freepi-proxy/` (`requests.jsonl`, `session-id`, `proxy.pid`, `proxy.log`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FREEPI_PROXY_PORT` | `8452` | Listen port |
| `FREEPI_PROXY_URL` | `http://127.0.0.1:<port>` | Base URL shown in messages |
| `FREEPI_DASHBOARD_PASSWORD` | *(unset)* | HTTP Basic password for the dashboard and `/api/*` |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | Upstream backend |
| `FREEPI_CREDENTIALS_PATH` | `~/.free-pi/agent/credentials.json` | Credential file |
| `FREEPI_DATA_DIR` | `~/.freepi-proxy` | Data dir (request log, session id, cached client version) |
| `FREEPI_NO_GRAVITY_PIXEL` | *(unset)* | `1` disables the ad pixel (not recommended) |
| `FREEPI_GRAVITY_SDK` | *(unset)* | Explicit path to the `@gravity-ai/api` module |
| `FREEPI_CATALOG_REFRESH_MS` | `600000` | Catalog refresh interval |
| `FREEPI_CACHE` | *(on)* | `0` disables the response cache |
| `FREEPI_CACHE_TTL_MS` | `3600000` | Cache entry lifetime |
| `FREEPI_CACHE_MAX_ENTRIES` | `300` | LRU entry cap |
| `FREEPI_CACHE_MAX_BYTES` | `33554432` | Cache size cap; larger responses stream but are not stored |

## Security notes

- The proxy listens on `127.0.0.1` only. Do not expose the port to a network without
  `FREEPI_DASHBOARD_PASSWORD` and, for the API, your own reverse proxy with TLS.
- The dashboard can read your account state and spend credits through the chat UI.
- Tokens expire after months; re-login from the dashboard when `/v1/usage` returns `no_token`.
- Android/Termux: install with the same command; if `#!/usr/bin/env` shebangs are unavailable in
  your shell, run `bash ~/.local/share/freepi-proxy/freepi-proxy start -d`.

## Development

```sh
bun test                       # 64 tests, 7 files (unit + HTTP integration)
node --test test/*.test.ts     # Node runner for the root suite
FREEPI_E2E=1 node --test test/e2e.test.ts   # opt-in live-backend test
```

`bun/` holds an optional single-binary build (`Bun.serve`, bearer auth, graceful shutdown,
`bun test`). See [`bun/README.md`](bun/README.md). The root `src/` tree is the canonical
implementation.

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Keep the project zero-dependency and
build-free.

## License

[MIT](LICENSE) · free-pi uses ads to fund inference; see <https://freepi.ai/privacy>.

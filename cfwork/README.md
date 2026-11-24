# freepi-proxy — Cloudflare Worker variant

Turns a free-pi (freepi.ai) account into OpenAI- and Anthropic-compatible APIs,
running 24/7 on Cloudflare Workers **free tier**. Zero runtime dependencies, no
build step. The Node (`src/`) and Bun (`bun/src/`) variants share behavior but
not code with this tree; upstream gate semantics here are verified against
free-pi-cli 0.6.19 behavior in production use (see `pingmike2/freepi2api`).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dumbzombies/freepi-gateway/tree/main/cfwork)

## Differences from the local versions

**This is not the local version.** It is a leaner re-implementation of the same
gateway for the edge. Same API surface (`/v1/chat/completions`, `/v1/messages`,
`/v1/models`, `/v1/usage`), same model catalog, and the same upstream gate
handling. What differs:

| | Local (`src/`, `bun/src/`) | Workers (`cfwork/`) |
|---|---|---|
| Runs on | Your machine (Node/Bun), `127.0.0.1:8452` | Cloudflare edge, 24/7, free tier |
| Login | GitHub device-flow UI in the dashboard | JWT pasted into the `FREEPI_TOKENS` secret |
| Dashboard + chat UI | Yes (`src/ui.html`) | None (would eat the request quota) |
| MCP server + tools | Yes (`src/mcp.ts`) | None |
| Request history | `requests.jsonl`, 14 days | In-isolate counters only, no persistence |
| Usage numbers | Instant estimate + server-settle reconciliation | Instant estimate only; `/v1/usage` shows upstream's live figures |
| Response cache | Long-lived in-memory, canonical keys | Per-isolate, best-effort, raw-byte keys (CPU budget) |
| Multiple accounts | Single account | Pool of accounts with automatic failover |
| Auth | Optional dashboard password / bearer (Bun) | Mandatory `WORKER_API_KEY` bearer on every `/v1/*` route |

## Deploy

```sh
cd cfwork
npx wrangler login                      # once
npx wrangler deploy                     # uploads wrangler.jsonc + src/index.ts
```

## Secrets

```sh
npx wrangler secret put WORKER_API_KEY   # any string; clients send it as Bearer
npx wrangler secret put FREEPI_TOKENS    # the account pool, see below
```

`FREEPI_TOKENS` — one secret holding every account, newline/comma/space
separated, or a JSON array `["jwt1","jwt2"]`. `FREEPI_TOKEN` /
`FREEPI_TOKEN_ALT` stay supported as the two-account shape. Get a JWT via the
GitHub device flow (90-day validity, 15000 credits/day per account):

```sh
# 1. start a device session
curl -s -X POST https://api.freepi.ai/auth/github/device -H "content-type: application/json" -d '{}'
# 2. open https://github.com/login/device?user_code=<user_code> and authorize
# 3. poll for the token
curl -s -X POST https://api.freepi.ai/auth/token -H "content-type: application/json" \
  -d '{"session_id":"<session_id>"}'
```

Optional var (in `wrangler.jsonc` `vars`): `FREEPI_SHOW_PREMIUM` = `"1"` lists
premium models in `/v1/models` (default hidden).

## Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible, streaming + non-streaming |
| `POST /v1/messages` | Anthropic-compatible (Claude Code), streaming + non-streaming |
| `POST /v1/messages/count_tokens` | Anthropic token counting |
| `GET /v1/models` | live catalog; premium hidden unless `FREEPI_SHOW_PREMIUM=1` |
| `GET /v1/usage` | live quota per pooled account + local counters |
| `GET /healthz` | open health probe (no key) |

All `/v1/*` routes require `Authorization: Bearer <WORKER_API_KEY>`. Fail
closed: an unset `WORKER_API_KEY` refuses every request rather than serve an
open proxy that burns the account's credits.

## What the Worker does per turn

1. **Ad cycle** — `GET /ads/next?slot=banner` → fire the Gravity impression
   pixel → `POST /ads/impression` (`imp_fired: true`), then a 400 ms beat.
   This is what keeps the free quota from being paused (`ads_required`).
2. **Completion** — `POST /v1/chat/completions` upstream with `Authorization`,
   `x-session-id`, `x-turn-id`, `x-client-version`.
3. **Gate handling in place**:
   - `403 ads_required` → rewarm the ads and retry once.
   - HTTP 200 wrapped around a fake "out of date" completion
     (`prompt_tokens: 0`) → rewarm and retry once (JSON-only check; streaming
     bodies are never buffered for this).
   - `409/429 concurrent_session` → `POST /session/reset` releases the
     occupied slot, then retry once.
   - `session is too long` → rotate the session id and replay once (what makes
     compaction work for long agent runs).
4. **Account pool** — account-level gates (`ads_required`,
   `hourly_ceiling`, `credits_exhausted`, `daily_ceiling`,
   `quota_exhausted`) hand the request to the next account instead of ending
   it. If every account is session-occupied, the client gets an actionable
   409 `session_limit` error.
5. **426 version gate** — the client version starts at `0.6.19` and adopts the
   catalog's `latest`/`min`; a 426 reply is replayed once with the learned
   version.

## Free-tier fit

- 100k req/day: a completion costs 1 worker request + 3-4 upstream subrequests
  (ads + chat, well under the 50 subrequest cap). The daily quota of one
  account (≈ $1.125 of credits) runs out long before the request quota does.
- 10 ms CPU: the client branch is a byte passthrough; the only parsing is the
  small usage tee and (for `/v1/messages`) the SSE translation.
- Isolate state (response cache, session ids, usage counters) is best-effort —
  a recycle costs a cache miss and a fresh session id, never correctness.

## Local development

```sh
cd cfwork
npx wrangler dev            # real workerd
npm test                    # node --test test/*.test.ts — no workerd needed
```

The tests invoke the fetch handler directly against a stub upstream, so they
run on any machine with Node ≥ 22.

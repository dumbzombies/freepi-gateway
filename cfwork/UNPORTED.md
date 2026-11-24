# UNPORTED — what the Worker variant deliberately does not have

Compared with the canonical Node build (`src/`) and the Bun variant
(`bun/src/`), `cfwork/` omits:

| Feature | Why | Where it lives elsewhere |
|---|---|---|
| Device-flow login UI (`/api/login/*`) | No background polling on Workers; a JWT is pasted into `FREEPI_TOKENS` instead (90-day validity) | `src/token.ts`, launcher `freepi-proxy` |
| Dashboard (`src/ui.html`, `/api/state`, `/api/ads/*`) | Static serving + 5 s polling would eat the 100k/day request budget; `/v1/usage` covers the operational need | `src/main.ts`, `src/ui.html` |
| MCP server (`initialize`/`tools/list`/`tools/call`) | No client demand on a 24/7 deployment yet; tools endpoints would follow | `src/mcp.ts` |
| Tools endpoints (`/tools/web-search`, `/tools/docs`, `/tools/image`) | Only consumed by the MCP server today | `src/upstream.ts` `tool()` |
| `requests.jsonl` history + D1/KV persistence | 14 days of history needs a storage binding; local per-isolate counters cover `/v1/usage` until someone asks | `src/track.ts` |
| Server-settle reconciliation (`settleSpend` + `reconcile`) | No persistent ledger to reconcile; `/v1/usage` reports upstream's authoritative numbers live | `src/state.ts` |
| Gravity SDK context bridge (`x-gravity-context`) | The SDK bridge reads local state that does not exist here; the plain impression pixel still fires | `src/gravity.ts` |
| Canonical cache keys | Root sorts object keys so semantically identical bodies share an entry; the Worker hashes raw bytes to stay inside the 10 ms CPU budget on large prompts | `src/cache.ts` `key()` |
| Claude settings config (`/api/claude/config`) | Tied to the dashboard/launcher flow; Claude Code works through `/v1/messages` model mapping | `src/anthropic.ts` |

Adding any of these back starts with picking the storage binding (D1 for rows,
KV for config, DO for session state) — see `../AGENTS.md` for the project's
conventions.

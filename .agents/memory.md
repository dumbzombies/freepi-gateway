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

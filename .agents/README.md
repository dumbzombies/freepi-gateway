# House rules

Project memory for `freepi-proxy`. Read `state.md` and `memory.md` before substantive work.

## Files

|File|Rule|
|---|---|
|`state.md`|Describes the code as it is now. Rewrite when behavior changes.|
|`memory.md`|Append-only. Dated decisions and gotchas. Never delete history.|
|`README.md`|This file. How the bank is maintained.|

## Working rules

- Root `src/` is canonical; every behavior fix lands in `bun/src/` too.
- Zero runtime dependencies, no build step, ESM, `node:` prefixes.
- Never commit credentials, tokens, or `.env` files. `.env.example` is safe.
- Tests isolate state: `HOME` and `FREEPI_DATA_DIR` point at a temp dir before
  importing `config.ts`.
- Verify with the narrowest suite: `npm test` (root), `cd bun && bun test`.
- After a large verified change, append a `memory.md` entry and update
  `state.md`.
- No secrets in memory files.

## Entry format

```md
## YYYY-MM-DD — short title

- Decision or gotcha.
- Why it matters.
```

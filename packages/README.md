# packages

Created in S0 (`docs/handoffs/S00-contract-and-scaffold.md`). Ownership is the rule executors and reviewers enforce.

| Package | Owner agent | Runs on | Purpose |
|---------|-------------|---------|---------|
| `contract` | sd-executor-contract (normalize.ts: sd-executor-hub) | both | envelope schema, state reducer, snapshot and transcript types, statusLine schema, fixtures |
| `probe` | sd-executor-probe | laptop (Windows first) | hook, statusline, spool, daemon (forward, tail, liveness, archive import), redaction, installer |
| `hub` | sd-executor-hub | box (laptop in Phase 2) | ingest, store, reducer wiring, REST, WebSocket, history, replay |
| `web` | sd-executor-web | box, viewed in browser | board, content view, atlas, layouts, launcher |
| `runner` (Phase 8) | sd-executor-probe | laptop | launches sessions on request from the hub |
| `electron` (Phase 8, optional) | sd-executor-web | laptop | desktop shell |

Dependency direction: `contract` ← everything. Nothing else imports across packages.

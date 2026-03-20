# Cortex V2 Settings Effectiveness Matrix

Date: 2026-03-20
Status: Active review baseline for the V2 release candidate

## Scope

This matrix defines which Dashboard settings are allowed to be edited in V2, how they are expected to take effect, where they are consumed, and how each change is verified.

Effect modes:

- `live_apply`: persisted and applied immediately to the running process
- `read_only`: visible in Dashboard, but not editable because the current V2 runtime does not safely consume it live
- `manual_action`: triggered by explicit buttons or workflows, not ordinary form fields

## Matrix

| Group | Config path | UI entry | Effect mode | Actual consumer | Verification method |
| --- | --- | --- | --- | --- | --- |
| LLM / Embedding | `llm.extraction.*` | Settings > Basic > LLM / Embedding | `live_apply` | `CortexApp.llmExtraction`, `CortexRecordsV2`, legacy engines when enabled | `PATCH /api/v2/config` returns `runtime_applied=true`, `applied_sections` includes `llm.extraction`; provider instance changes; extraction tests still pass |
| LLM / Embedding | `embedding.*` | Settings > Basic > LLM / Embedding | `live_apply` | `CortexApp.embeddingProvider`, `CortexRecordsV2`, vector consumers | `PATCH /api/v2/config` returns `applied_sections` includes `embedding`; embedding provider instance changes; vector-backed tests still pass |
| LLM / Embedding | `llm.lifecycle.*` | Settings > Basic > LLM / Embedding | `read_only` in V2-only | Legacy lifecycle engine only | Visible with `当前 V2 主链未使用 / Not used by the current V2 runtime`; not editable in V2-only UI |
| LLM / Embedding | `search.reranker.*` | Settings > Basic > LLM / Embedding | `read_only` in V2-only | Legacy gate/search pipeline only | Visible but not editable in V2-only UI; no fake runtime apply reported |
| Gate | `gate.*` | Settings > Expert > Gate | `read_only` in V2-only | Legacy `MemoryGate` only | Section remains visible for deployment reference, but no edit controls in V2-only UI |
| Search | `search.vectorWeight`, `search.textWeight`, `search.minSimilarity`, `search.reranker.*` | Settings > Expert > Search | `read_only` in V2-only | Legacy `HybridSearchEngine` only | Section visible without edit controls in V2-only UI |
| Sieve | `sieve.*` | Settings > Expert > Sieve | `read_only` in V2-only | Legacy `MemorySieve` only | Section visible without edit controls in V2-only UI |
| Lifecycle | `lifecycle.schedule` | Settings > Expert > Lifecycle | `live_apply` | `Lifecycle V2` scheduler | `PATCH /api/v2/config` returns `applied_sections` includes `lifecycle.schedule`; scheduler status and next run update immediately |
| Log level | log level route | Settings > Basic > Log level | `live_apply` | Global logger runtime | `PATCH /api/v2/log-level` followed by `GET /api/v2/log-level` reflects new level immediately |
| Auth | `/api/v2/auth/*` | Settings > Basic > Auth | `manual_action` | Auth security routes | Setup, verify, and change-token are validated via auth endpoints, not config patching |
| Data management | import / export / reindex / update | Settings > Basic > Data management | `manual_action` | Dedicated admin routes | Verified through button-driven actions and route responses |
| Runtime | `runtime.*` | Settings > Basic > Runtime | `read_only` | Process startup mode | Always visible as status only; no edit controls |
| Server / Storage | `port`, `host`, `storage.*`, `vectorBackend.*` | Settings > Basic > Server config | `read_only` | Process startup / deployment | Visible for inspection only; not editable from Dashboard |

## Current V2 Release-Candidate Rules

1. Any field that remains editable in Dashboard must apply immediately after save.
2. Fields that are deployment-only are shown as read-only and are never reported as runtime-applied.
3. `PATCH /api/v2/config` must report:
   - `runtime_applied`
   - `applied_sections`
   - `restart_required_sections`
4. In the normal V2-only path, `restart_required_sections` should be empty for ordinary Dashboard edits.

## Verification Coverage

The current automated coverage includes:

- `tests/api.test.ts`
  - extraction and embedding timeout changes persist and live-apply
  - lifecycle schedule persists and updates scheduler status immediately
  - unchanged deployment-only sections do not pollute `restart_required_sections`
  - log level changes apply immediately
- `tests/dashboard-e2e.test.ts`
  - settings source uses live-apply messaging instead of restart messaging
  - only `llm` and `lifecycle` are exposed as live-edit sections in V2-only mode

## Release Gate Notes

- The current V2-only product surface does **not** promise live-apply for `Gate`, `Search`, or `Sieve`; they are deployment-reference sections until or unless the V2 runtime consumes those knobs directly.
- The top-left self-update entry is a separate release mechanism and must not be conflated with settings application semantics.

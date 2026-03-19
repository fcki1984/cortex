# Cortex V2 Release Gate Checklist

Date: 2026-03-19
Branch: `codex/cortex-v2`
Commit baseline: `07ee3da`

## Gate Status

Release candidate status: **BLOCKED**

Rule:

- No production freeze while `Recall / Relations / Lifecycle` still contain architecture blockers.

## Architecture Blockers

- [ ] Durable normalization admits stable location facts such as `我住大阪` as `fact_slot(location)`
- [ ] Cross-language recall works through the natural-language write path, not only explicit `attribute_key` writes
- [ ] Formal relation truth source is `record_relations_v2` only
- [ ] Automatic relation extraction no longer writes formal graph facts to old sqlite relations or Neo4j
- [ ] V2 relation flow supports `candidate -> preview/edit -> confirm -> formal relation`
- [ ] Lifecycle is forgetting-first, not summary-first
- [ ] `session_note` summaries do not replace truth-bearing notes by default

## Production Blockers

- [ ] `note-only` queries return empty context or persona-only context
- [ ] `vector-only` durable candidates do not enter `relevance_basis`
- [ ] supersede recall returns only the newest truth
- [ ] `/api/v1/*` remains fully retired and returns `404`
- [ ] Chinese UI no longer exposes obvious English product labels in main views or expert settings
- [ ] Dashboard pages no longer contain V1-shaped assumptions or stale shapes
- [ ] Release-facing docs match the actual V2 architecture

## Verified Good So Far

- [x] Public REST product surface is `/api/v2/*`
- [x] MCP primary endpoint is `/mcp`, with `/mcp/message` compatibility
- [x] Auth is on `/api/v2/auth/*`
- [x] V2 scheduler runs in V2-only mode
- [x] V2 feedback uses supersede/patch semantics instead of in-place mutation
- [x] V2 relations are record/evidence-bound at the storage layer
- [x] Dashboard primary product flows use V2 API shapes

## Mandatory Regression Scenarios

### Write / Recall

- [ ] `POST /api/v2/records` with `kind=fact_slot` and content `我住大阪` writes a durable `fact_slot`
- [ ] `POST /api/v2/recall` with query `Where does the user live?` returns that fact
- [ ] `POST /api/v2/records` with ambiguous content such as `最近也许会考虑换方案` still downgrades to `session_note`
- [ ] `note-only` recall keeps `reason=low_relevance`
- [ ] `subject_only_match` and `vector_only_match` stay out of `relevance_basis`

### Relations

- [ ] every formal relation can be traced to `source_record_id`
- [ ] every formal relation can be traced to evidence when evidence exists
- [ ] no automatic V2 relation write bypasses confirmation
- [ ] Dashboard Relations shows only V2 formal relations, not old graph edges

### Lifecycle

- [ ] lifecycle maintenance only targets `session_note`
- [ ] no fact/rule/task-state is retired, decayed, or summarized by lifecycle
- [ ] preview/run/log output contains no working/core/archive semantics
- [ ] summary behavior, if present, is audit-only and does not become a new truth surrogate

### Platform / UI

- [ ] `/api/v1/*` endpoints return `404` with and without auth
- [ ] `Memory Browser`, `Agents`, `Stats`, `Relations`, `Lifecycle`, `Feedback`, `Extraction Logs`, and `Settings` have no obvious English UI leaks in Chinese mode
- [ ] no page white-screens due to old API shape assumptions

### Release Validation

- [ ] fresh DB deployment passes
- [ ] small real-data sample passes
- [ ] after probe cleanup, `stats.total_records=0`
- [ ] only default system agents remain after cleanup

## Notes

- `Neo4j` is not a release gate by itself. It becomes a blocker only if it remains part of the formal truth path.
- `Import/Export v2` remains post-release work and does not block release candidate.
- Documentation pages for terminology and architecture remain post-release work; only inline clarity and release-facing docs matter now.

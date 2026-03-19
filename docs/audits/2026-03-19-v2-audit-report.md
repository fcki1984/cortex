# Cortex V2 Audit Report

Date: 2026-03-19
Branch: `codex/cortex-v2`
Commit baseline: `07ee3da`

## Summary

This audit reviews Cortex V2 as a standalone architecture, not as a compatibility layer for V1.

Current conclusion:

- V2 already owns the primary product surface: `/api/v2/*`, `/mcp`, structured records, V2-only Dashboard, V2 `relations/lifecycle/feedback`, and V2 scheduler.
- V2 is **not yet ready for production freeze** because there are still unresolved architecture blockers in `write normalization`, `relations`, and `lifecycle`.
- The most important pattern behind the remaining issues is the same one discussed during the refactor: a few subsystems still allow inferred or transformed artifacts to act like authoritative truth.

The release gate should stay closed until all architecture blockers in `Recall / Relations / Lifecycle` are cleared.

## Audit Matrix

| Subsystem | Truth Source | Main Entrypoints | Legacy Influence | Audit Result |
| --- | --- | --- | --- | --- |
| V2 record model | `record_registry` + V2 subtype tables | `/api/v2/records`, `/api/v2/ingest`, `/api/v2/recall`, MCP remember/recall | Legacy migration still exists via `legacy_record_map`, but not public | Stable, but normalization still rejects some durable facts |
| Write normalization | `packages/server/src/v2/normalize.ts` | manual write, ingest, MCP remember | Legacy categories still appear during migration only | Architecture blocker |
| Recall | `packages/server/src/v2/service.ts` | REST recall, MCP recall, Recall Tester | Legacy gate/search only runs when `legacyMode=true` | Mostly aligned, but depends on correct durable writes |
| Relations | `record_relations_v2` for V2 UI/API | `/api/v2/relations`, Dashboard Relations, MCP relations | Old `sieve/flush` still writes relations to sqlite/Neo4j; Neo4j still initializes at startup | Architecture blocker |
| Lifecycle | `session_note` records + lifecycle logs | `/api/v2/lifecycle/*`, scheduler, Dashboard Lifecycle | Old lifecycle routes are disabled publicly, but V2 lifecycle still uses summary compression as a primary action | Architecture blocker |
| Feedback | `record_feedback_v2` + supersede path | `/api/v2/feedback`, Dashboard Feedback | No public V1 dependency | Aligned with V2 design |
| Platform/admin | `/api/v2/*` | config, health, logs, metrics, agents, extraction logs | Public `/api/v1/*` is retired | Stable |
| Auth | `/api/v2/auth/*` | setup, verify, status, change-token | V1 auth is retired publicly | Stable |
| Dashboard | V2 REST shapes only | Stats, Memory Browser, Agents, Relations, Lifecycle, Feedback, Settings | Some legacy wording and stale docs remain | Production blocker |
| MCP | `/mcp`, `/mcp/message` | initialize, tools/list, tools/call | No public V1 dependency | Stable |

## Findings

### Architecture Blockers

#### 1. Stable location facts are still being downgraded to `session_note`

V2 durable admissibility is currently too strict for a core fact pattern: plain location statements such as `我住大阪`.

Observed behavior:

- manual V2 record write requesting `fact_slot`
- content `我住大阪`
- normalized result becomes `session_note`
- `reason_code=unstable_attribute`

Why this is an architecture blocker:

- `location` is a first-class durable attribute in V2.
- the input is user-confirmed, updateable, and should map to `fact_slot(entity_key=user, attribute_key=location)`.
- once downgraded, cross-language recall cannot work, even if recall itself is correctly bridged.

Evidence:

- `packages/server/src/v2/normalize.ts`
  - `inferFactAttribute()` only recognizes patterns like `我住在`, `住在`, `live in`, `from`
  - it misses plain forms like `我住大阪`
- `packages/server/src/v2/service.ts`
  - recall intent bridging already includes `location`, but it cannot help if the record never becomes durable
- existing tests cover location recall when `attribute_key=location` is passed explicitly, but not the plain-language normalization path

Required fix direction:

- broaden durable normalization for stable user-stated location facts
- add regression tests on the plain natural-language path, not only explicit-key writes

#### 2. V2 formal relations and automatic relation extraction are split across two systems

V2 formal relations are stored in `record_relations_v2`, but automatic relation extraction still lives in old `sieve/flush` and writes to old sqlite relations or Neo4j.

Why this is an architecture blocker:

- V2 claims that formal relations are record-bound and evidence-bound.
- the current automatic path does not produce `record_relations_v2`.
- this means the current V2 relation page is effectively a manual audit/batch-entry tool, not the actual home of automatically extracted relations.
- it creates dual truth sources for graph-shaped knowledge.

Evidence:

- `packages/server/src/v2/relations.ts`
  - V2 formal relation storage is `record_relations_v2`
  - every relation is bound to `source_record_id` and optional `source_evidence_id`
- `packages/server/src/core/sieve.ts`
  - extracted relations are still written via `neo4jUpsertRelation()` or sqlite relation upsert
- `packages/server/src/index.ts`
  - Neo4j is still initialized at startup when configured
- there is no V2 relation candidate pipeline in `recordsV2.ingest()`

Required fix direction:

- formal relation truth source must stay `record_relations_v2`
- automatic extraction should produce `relation candidates`, not directly write formal relations
- user preview/edit/confirm should promote candidates into `record_relations_v2`
- Neo4j, if kept, must become a derived graph index only

#### 3. Lifecycle still treats summary compression as a primary maintenance action

V2 lifecycle only targets `session_note`, which is correct, but its main maintenance behavior is still summary generation and superseding original notes.

Why this is an architecture blocker:

- V2 should prefer controlled forgetting over abstract summary substitution.
- current compression creates a new `session_note` whose content is `Lifecycle summary: ...`
- original notes are superseded by the summary note
- this can blur scope, timing, and validity boundaries, especially when summary text later re-enters the system as if it were a normal note

Evidence:

- `packages/server/src/v2/lifecycle.ts`
  - `buildSummary()` concatenates note summaries
  - `run()` writes a replacement note tagged `lifecycle_compressed`
  - original notes are superseded by the replacement record
- scheduler now correctly runs V2 lifecycle, so this behavior is no longer dormant; it is active system behavior

Required fix direction:

- lifecycle should become forgetting-first:
  - retire from recall
  - dormant/stale states
  - purge policy
- summary should be optional audit material, not the primary replacement mechanism
- summary notes must not replace truth-bearing notes by default

### Production Blockers

#### 4. Cross-language recall regresses whenever durable normalization fails

Cross-language recall for location facts only works when the fact reaches the durable layer. Because plain `我住大阪` is currently downgraded, the user-visible effect is that `Where does the user live?` returns low relevance and no fact.

This is a production blocker because the V2 product promise already includes cross-language durable recall.

#### 5. Chinese UI still contains visible English terms in expert settings and system terminology

The main screens are mostly localized, but the Chinese UI still exposes user-visible English terms such as:

- `Gate`
- `Search`
- `Sieve`
- `tokens`
- `topK`
- `semantic`
- `variants`
- `LLM (extraction model)`

This is not a core architecture problem, but it is a release-blocking UI consistency issue for a Chinese-first deployment.

#### 6. Documentation and architecture descriptions are still partially V1-shaped

The public README files still describe or illustrate older concepts such as:

- Search Debug / Graph View as if they are still first-class default surfaces
- Neo4j as a direct graph feature in the main architecture story
- older lifecycle language in some architecture narrative

This is a production blocker for release confidence because it makes the shipped architecture harder to understand and audit.

### Post-Release Optimizations

#### 7. Legacy-only code and tests still exist in the repo as maintenance overhead

Examples:

- old V1 API route files remain in `packages/server/src/api/*`
- old lifecycle, gate, sieve, search, and relation tests remain in the test tree
- Neo4j dependency and code remain linked into runtime startup

This is not a release blocker if it stays non-public and non-default, but it increases cognitive load and audit cost.

#### 8. The dashboard still carries a few V1/legacy-facing terms in locale and runtime status text

Examples include `legacyModeOn` / `legacyModeOff` locale entries and other references that no longer matter to a V2-only product story.

This should be cleaned up after the production candidate is stable.

## Subsystem Notes

### Write Normalization

Current shape is directionally correct:

- durable kinds are narrow
- assistant-only writes are downgraded
- explicit downgrade metadata is returned

But durable eligibility is still underpowered for several natural-language forms. This subsystem should be treated as a truth admission gate, not as a formatting helper. Coverage needs to be expanded around:

- location without prepositions
- language preference in mixed Chinese/English phrasing
- task-state phrasing that does not use explicit keywords

### Recall

Recall has improved significantly:

- `subject_only_match` and `vector_only_match` exist
- note-only recall is mostly blocked
- `relevance_basis` is much more explicit

However, recall quality still depends on the correctness of durable writes. This means recall cannot be signed off independently from normalization.

### Relations

V2 relation storage shape is correct; ingestion architecture is not yet correct.

The right V2 posture is:

- `relation candidates`
- user preview/edit/confirm
- formal write to `record_relations_v2`
- optional derived sync to Neo4j

Anything else keeps formal graph truth split across systems.

### Lifecycle

V2 already made the correct first cut by scoping lifecycle to `session_note`, but the actual maintenance policy still behaves like a carry-over from the old archive/compress mindset.

The next design step should be:

- active note
- dormant note
- stale note
- purged note

with summary moved out of the truth path.

## Release Recommendation

Do **not** enter production freeze yet.

Required before release candidate:

1. fix durable normalization for stable location facts and any equivalent class of durable miss
2. define and implement V2 relation candidate flow, or explicitly disable automatic relation extraction from the production story until it exists
3. replace summary-first lifecycle behavior with forgetting-first lifecycle behavior, or at minimum block compressed summary notes from becoming truth-like replacements
4. finish Chinese-first UI cleanup for visible product terminology
5. update release-facing docs to describe the actual V2 architecture, not the old mixed model

If these are not fixed, the result will still behave like a half-migrated architecture even though the API surface is mostly V2.

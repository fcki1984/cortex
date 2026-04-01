# Cortex V2 Colloquial Profile Rule Auto-Commit Design

## Summary

This batch deepens the automation-first memory pipeline without opening a new product surface, schema, or API family.

The current baseline already has:

- an automation-first split between direct durable writes and review inbox fallbacks
- a shared contract that stabilizes canonical explicit inputs
- a precision-first policy that keeps ambiguous inputs out of durable truth

The next step is to expand **deterministic auto-commit coverage for explicit but colloquial preference inputs** so users do not need to manually correct obvious profile rules that the system should already understand.

This batch stays intentionally narrow:

- only `profile_rule`
- only three existing stable keys
- only short explicit clause-level inputs
- no new public API
- no new dashboard workflow

## Goals

1. Auto-commit more clearly stable colloquial preference inputs instead of dropping them to final `session_note`.
2. Keep `manual write`, `live ingest`, and `import preview` on the same shared contract result for comparable inputs.
3. Reuse the existing automation-first split so borderline cases still go to review or note rather than widening durable truth.
4. Keep canonical truth content and review-assist rewrites aligned so auto-commit and review do not drift.

## Non-Goals

- No new `profile_rule` keys.
- No expansion to `fact_slot` or `task_state` in this batch.
- No new prompt-led durable behavior.
- No long-form narration or cross-clause inference.
- No schema change.
- No dashboard interaction change beyond test or copy synchronization if needed.
- No changes to canonical JSON import/export semantics, `confirmed_restore`, or `all_agents` filtering.

## Product Direction

The product remains automation-first with human review as a backstop, not the primary authoring mode.

This batch reduces user pressure by making the system automatically accept more **already-clear** preference statements. It does not attempt to make the system more aggressive about truth. The win here is narrower and safer:

- fewer obvious profile rules fall into `session_note`
- fewer obvious profile rules require inbox review
- shared contract parity improves across all three write-like entry paths

## Scope

The batch covers only these `profile_rule` keys:

- `language_preference`
- `response_length`
- `solution_complexity`

The batch covers only these input classes:

- short explicit single-clause or clause-splittable user statements
- colloquial but clearly stable preference wording

Examples in scope:

- `后续交流中文就行`
- `之后都用中文`
- `后面请用中文`
- `三句话内就行`
- `回答控制在三句话内`
- `方案简单点`
- `别搞太复杂`

Examples intentionally out of direct durable scope:

- `中文就行吧`
- `可能简单点更好`
- `看情况用中文`
- `也许三句话内更合适`

## Design Principles

### 1. Precision First

Weakening language must not be normalized into durable truth. If the statement contains tentative or hedged intent, it must not auto-commit just because the base preference is recognizable.

### 2. Shared Contract First

The contract must remain authoritative across:

- manual/API writes
- live ingest
- text / `MEMORY.md` import preview
- review-assist canonical rewrite output

This batch reduces drift. It must not create a new decision engine.

### 3. Deterministic Before Prompt

This batch expands deterministic/shared-contract recognition. Prompt guidance is only synchronized afterward so deep extraction does not contradict deterministic outcomes. Prompt behavior must not become the primary reason an input becomes durable.

### 4. Canonical Truth Content

When a colloquial input is accepted as stable durable truth, the final stored record content should use the same canonical phrasing that review-assist would suggest for that same stable key.

That means auto-commit and review inbox converge on one durable sentence template instead of two parallel wordings.

## Supported Canonical Outcomes

V1 canonical durable output for this batch is fixed to these meanings:

- `profile_rule(language_preference)` -> `请用中文回答`
- `profile_rule(response_length)` -> `请把回答控制在三句话内`
- `profile_rule(solution_complexity)` -> `不要复杂方案`

These are canonical truth templates, not a general natural-language rewriting system.

## Architecture

### New Shared Internal Unit

Add or extract a small shared helper focused specifically on colloquial `profile_rule` stabilization.

Suggested responsibilities:

- detect stable colloquial variants for the three in-scope keys
- reject tentative or hedged wording for direct durable commit
- produce canonical durable content
- produce a shared disposition for downstream routing

Suggested helper surface:

- `matchConversationalProfileRule(...)`
- `canonicalizeProfileRuleContent(...)`
- `classifyProfileRuleDisposition(...)`

Suggested primary file locations:

- `packages/server/src/v2/contract.ts`
- `packages/server/src/v2/normalize.ts`
- `packages/server/src/v2/service.ts`
- `packages/server/src/v2/import-export.ts`
- `packages/server/src/v2/review-assist.ts`
- `packages/server/src/v2/prompts.ts`

The implementation may place the helper in one of these files or a narrow adjacent internal helper module, but the external behavior must remain centralized rather than duplicated.

## Disposition Model

The existing automation-first routing should converge on a simple internal result:

- `auto_commit`
- `review`
- `note`

For this batch:

- clearly stable colloquial in-scope preference input -> `auto_commit`
- stable-looking but not safe-enough prompt/deep-only durable -> `review`
- speculative / hedged / ambiguous preference -> `note` or existing downgrade path

The important change is that the final decision should come from the validated shared contract result, not merely from candidate origin (`deterministic`, `fast`, `deep`).

## Path-by-Path Behavior

### Manual Write / `POST /api/v2/records`

`normalizeManualInput()` remains the atomic-write baseline.

Behavior change:

- in-scope colloquial preference phrasing should normalize to the same stable key and canonical content as the canonical sentence
- weak or tentative phrasing should not be silently elevated to durable truth

This route keeps its existing atomic boundary. It does not become a multi-record or review-batch route.

### Live Ingest / `POST /api/v2/ingest`

Clause-level ingest should use the same shared helper before final routing.

Behavior change:

- previously note-only outcomes for clearly stable colloquial preference inputs should now resolve to `auto_commit`
- deep-only durable suggestions that are still not deterministic/safe stay in review
- weak phrasing stays in `session_note` rather than being over-promoted

### Import Preview / `POST /api/v2/import/preview`

`text` and `memory_md` preview should use the same clause-level colloquial preference detection before presenting candidates.

Behavior change:

- preview should show the same `profile_rule` kind, stable key, and canonical content that ingest would actually commit for the same input
- preview should not show durable candidates for hedged/tentative preference inputs just because the wording is close

`memory_md` heading hints remain advisory only. They must not override content stability.

## Prompt Synchronization

`prompts.ts` should be updated only to align extraction examples and negative examples with the deterministic/shared contract baseline.

The prompt update is constrained:

- reinforce positive examples already supported deterministically
- reinforce negative examples that must remain non-durable
- do not add new product behavior that deterministic logic cannot defend

## Review Assist Alignment

Review assist should use the same canonical phrase helper for these three keys.

That means:

- auto-committed durable content
- review inbox `suggested_rewrite`
- import preview candidate content

should all converge on the same canonical phrasing when they refer to the same stabilized truth.

This avoids a confusing split where auto-commit stores colloquial raw text while review suggests a different canonical sentence.

## Testing Strategy

### Positive Shared-Contract Cases

The following samples must converge across `manual write`, `ingest`, and `import preview`:

- `后续交流中文就行` -> `profile_rule(language_preference)` -> `请用中文回答`
- `之后都用中文` -> `profile_rule(language_preference)` -> `请用中文回答`
- `三句话内就行` -> `profile_rule(response_length)` -> `请把回答控制在三句话内`
- `回答控制在三句话内` -> `profile_rule(response_length)` -> `请把回答控制在三句话内`
- `方案简单点` -> `profile_rule(solution_complexity)` -> `不要复杂方案`
- `别搞太复杂` -> `profile_rule(solution_complexity)` -> `不要复杂方案`

### Negative Precision Cases

The following samples must not auto-commit as durable profile rules:

- `中文就行吧`
- `可能简单点更好`
- `看情况用中文`
- `也许三句话内更合适`

Expected routing:

- `review` only if there is still a safe reviewable durable representation
- otherwise `session_note` / note downgrade

### Regression Protection

The batch must preserve:

- canonical JSON round-trip
- `confirmed_restore` without pending duplicate
- `all_agents` filtering semantics
- current review inbox behavior for non-profile-rule items
- current dashboard review inbox and import/export interaction tests

### Rewrite Parity

If review assist offers a rewrite for one of the in-scope keys, that rewrite must match the canonical content used by direct auto-commit for the same stabilized meaning.

## Risks And Mitigations

### Risk: Over-promoting Soft Preference Language

Mitigation:

- explicit negative tests for hedged forms
- deterministic weak-language gate before any auto-commit

### Risk: Path Drift Between Ingest And Preview

Mitigation:

- parity tests that assert the same key/content result for comparable inputs across all three paths

### Risk: Review/Auto-Commit Content Drift

Mitigation:

- shared canonical phrase helper
- rewrite parity regression tests

## Batch Boundary After This Work

Once this batch lands, the next two planned slices can build on it in order:

1. review inbox load reduction and batch-review ergonomics
2. deeper import automation within the same automation-first model

This batch intentionally comes first because it improves automation quality without expanding product shape.

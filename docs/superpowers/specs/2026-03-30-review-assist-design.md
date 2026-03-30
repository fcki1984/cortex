# Cortex V2 Review Assist Design

## Summary

This batch deepens the new automation-first memory pipeline without opening a new product surface or a new API family.

The current baseline already splits Cortex V2 writes into:

- deterministic / stable items that auto-commit through the existing v2 truth path
- ambiguous or deep-only items that persist into the unified review inbox

The next step is to make the review inbox meaningfully lighter-weight for humans. The focus is not "more extraction" and not "more CRUD". The focus is **precision-first review assistance**:

- produce a safer `suggested_action`
- produce a safe `suggested_rewrite` for stable-but-colloquial explicit inputs
- make the dashboard prefill that safe rewrite so review becomes "scan and accept" instead of "rewrite by hand"

This batch stays within the current Route B strategy:

- automation-first
- conservative auto-commit
- human review only for items that still require judgment

## Goals

1. Reduce manual editing work inside the review inbox for stable-but-non-canonical explicit inputs.
2. Keep precision-first guarantees intact: unclear inputs must still stay in `session_note` or in the inbox.
3. Reuse the existing shared contract, clause split, arbitration, review inbox, and v2 write path instead of adding a second decision engine.
4. Preserve current public API paths and the current deterministic truth path semantics.

## Non-Goals

- No new page family beyond the current review inbox and system pages.
- No schema expansion beyond the existing `review_batches_v2` / `review_items_v2`.
- No second LLM roundtrip dedicated to review suggestions.
- No cross-clause or cross-turn inference in rewrite generation.
- No change to canonical JSON import/export semantics.
- No change to `/api/v2/records` atomic-write boundary.

## Product Direction

The review inbox remains the main product entry. This batch does not change that product shape.

The product shift here is subtler:

- today, the inbox already groups review work
- after this batch, safe inbox items should arrive with a **ready-to-submit suggested rewrite**
- for most stable explicit inputs, the user should be able to review by scanning and accepting instead of composing canonical text themselves

That reduces pressure without making the system more aggressive about durable truth.

## Design Principles

### 1. Precision First

If the system is unsure, it must not raise confidence by rewriting. Unclear inputs remain:

- `session_note`
- or pending inbox items with explanation only

Rewrite exists to normalize wording, not to invent truth.

### 2. Rewrite Cannot Change Semantics

`suggested_rewrite` is allowed only when all of the following remain unchanged:

- record kind
- stable key identity
- subject/entity scope
- truth direction

If any of these would change, rewrite is not allowed.

### 3. Single Shared Contract

The same internal contract remains authoritative for:

- manual/API writes
- ingest
- import preview
- review inbox assistance

This batch should reduce drift, not add another branch of behavior.

### 4. Review Assist Is Advisory, Not a Bypass

Review assist can:

- rank actions
- propose a normalized user-facing sentence

Review assist cannot:

- bypass the v2 write path
- bypass admissibility checks
- bypass relation restore rules

## Scope

This batch covers three areas:

1. server-side review assistance for inbox items
2. dashboard prefill and batch-apply behavior
3. regression protection for safe rewrite and bulk accept flows

## Existing Baseline To Preserve

The following behaviors are already established and must not regress:

- deterministic shared contract winners auto-commit directly
- final `session_note` outcomes auto-commit rather than being needlessly routed to inbox
- deep-only durable candidates are routed to inbox
- canonical JSON import/export remains deterministic
- `confirmed_restore` restores formal relations without leaving pending duplicates
- `all_agents` export filtering behavior stays unchanged

## Architecture

### New Internal Unit: Review Assist

Add an internal helper module on the server side that is responsible for turning normalized candidates into review guidance.

Suggested location:

- `packages/server/src/v2/review-assist.ts`

Responsibilities:

- determine `suggested_action`
- determine whether a safe `suggested_rewrite` exists
- explain why the suggestion is safe or why human judgment is still required

Inputs:

- normalized candidate payload
- source metadata already available from ingest/import preview
- contract-derived warnings / origin / source type

Outputs:

- `suggested_action`
- `suggested_reason`
- `suggested_rewrite?`

Consumers:

- `CortexReviewInboxV2.createBatch()`
- `CortexReviewInboxV2.createImportBatch()`

The existing review inbox table shape is enough; no new columns are required.

### Review Assist Categories

Each inbox item falls into one of three internal buckets.

#### A. `auto_commit`

These items do not enter the review inbox and are not changed by this batch.

Examples:

- `请用中文回答`
- `我住大阪`
- `当前任务是重构 Cortex recall`
- final downgraded `session_note` outcomes that the existing pipeline already commits safely

#### B. `review_acceptable`

These are items that still go to inbox, but are stable enough that the system can safely propose a normalized sentence.

Characteristics:

- kind is stable
- stable key is stable
- candidate meaning is explicit enough
- only wording is colloquial, indirect, or not canonical enough for the clearest durable submission

Examples:

- `后续交流中文就行` -> `profile_rule(language_preference)` with rewrite `请用中文回答`
- `回答控制在三句话内` -> `profile_rule(response_length)` with rewrite `请把回答控制在三句话内`

Default guidance:

- `suggested_action = accept` or `edit`
- `suggested_rewrite = canonical sentence`

#### C. `review_judgment_required`

These items still need real human judgment and should not receive a truth-elevating rewrite.

Characteristics:

- speculative or tentative
- assistant-only
- conflict exists without safe deterministic resolution
- would require cross-clause synthesis or extra inferred facts
- stable key is not truly safe yet

Examples:

- `最近也许会考虑换方案`
- `我可能在 OpenAI`
- assistant interpretation that the user never confirmed

Default guidance:

- `suggested_action = reject` or `edit`
- no aggressive rewrite
- `suggested_reason` explains why this still needs judgment

## Safe Rewrite Rules

### Rewrite Strategy (v1)

This batch uses **deterministic rewrite construction only**. It does not add a second LLM review pass and it does not ask the extraction model to generate an extra rewrite payload after the fact.

Rewrite sources are limited to:

1. existing normalized contract output fields already present on the candidate payload
2. deterministic per-kind canonical sentence templates
3. already-supported short proposal rewrite helpers where they fit the same semantics

V1 supported record kinds for safe rewrite are intentionally narrow:

- `profile_rule`
  - `language_preference`
  - `response_length`
  - `solution_complexity`
- `fact_slot`
  - `location`
  - `organization`
- `task_state`
  - only if the existing deterministic/shared contract already stabilizes the same `subject_key + state_key + status/summary` without extra inference

V1 canonical sentence construction examples:

- `profile_rule(subject_key=user, attribute_key=language_preference)` -> `请用中文回答`
- `profile_rule(subject_key=user, attribute_key=response_length)` -> `请把回答控制在三句话内`
- `profile_rule(subject_key=user, attribute_key=solution_complexity)` -> `不要复杂方案`
- `fact_slot(entity_key=user, attribute_key=location)` -> `我住东京`
- `fact_slot(entity_key=user, attribute_key=organization)` -> `我在 OpenAI 工作`

If the required canonical sentence cannot be produced deterministically from the existing normalized payload, V1 does not emit `suggested_rewrite`.

### Rewrite Locale Rule (v1)

V1 rewrite output follows a conservative locale rule:

1. If the candidate already implies a stable language preference and the rewrite template supports that language, emit in that language.
2. Otherwise, emit in the source content language if the deterministic template set supports it.
3. Otherwise, emit no `suggested_rewrite`.

V1 must **not** translate content based on dashboard UI locale alone.

That keeps rewrite tied to truth-bearing content rather than presentation settings.

Practical V1 constraint:

- Chinese source / Chinese preference cases are first-class and explicitly supported in this batch
- non-Chinese rewrites are allowed only if a deterministic template already exists for that kind/value pair
- otherwise the item can still receive `suggested_action` and `suggested_reason`, but no rewrite

### Supported Values And Fallbacks (v1)

V1 rewrite support is intentionally whitelist-based.

#### `profile_rule(language_preference)`

Required fields:

- `normalized_kind=profile_rule`
- `subject_key=user`
- `attribute_key=language_preference`
- content or normalized value that deterministically maps to a supported language label

Supported rewrite values in this batch:

- 中文 -> `请用中文回答`
- 英文 -> `Please answer in English`
- 日文 -> `日本語で答えてください`

Fallback:

- if the language value cannot be mapped exactly, emit no rewrite

#### `profile_rule(response_length)`

Required fields:

- `normalized_kind=profile_rule`
- `subject_key=user`
- `attribute_key=response_length`
- content/value that deterministically preserves a supported sentence-count style constraint

Supported rewrite values in this batch:

- explicit "N 句话内 / N 句以内" style constraints already normalized from the source

Fallback:

- if the value is vague (`简短一点`, `不要太长`) or requires interpretation beyond the normalized constraint, emit no rewrite

#### `profile_rule(solution_complexity)`

Required fields:

- `normalized_kind=profile_rule`
- `subject_key=user`
- `attribute_key=solution_complexity`

Supported rewrite values in this batch:

- explicit simple-solution constraint equivalent to `不要复杂方案`

Fallback:

- if the wording implies nuance (`先别太复杂`, `尽量简单但不绝对`) and cannot be preserved exactly, emit no rewrite

#### `fact_slot(location)`

Required fields:

- `normalized_kind=fact_slot`
- `entity_key=user`
- `attribute_key=location`
- a stable, explicit location value already normalized from the source

Supported rewrite values in this batch:

- current-residence/current-location statements that the shared contract already stabilizes as `location`

Fallback:

- if the source is tentative, historical, comparative, or otherwise ambiguous about current truth, emit no rewrite

#### `fact_slot(organization)`

Required fields:

- `normalized_kind=fact_slot`
- `entity_key=user`
- `attribute_key=organization`
- a stable, explicit organization value already normalized from the source

Supported rewrite values in this batch:

- current-employment/current-affiliation statements that the shared contract already stabilizes as `organization`

Fallback:

- if the source implies possibility, history, or uncertain affiliation, emit no rewrite

#### `task_state`

Required fields:

- `normalized_kind=task_state`
- stable `subject_key`
- stable `state_key`
- status/summary already stabilized without extra inference

Supported rewrite values in this batch:

- only canonical cases already covered by the deterministic/shared contract baseline

Fallback:

- if canonical wording cannot be regenerated directly from the normalized payload, emit no rewrite

### Meaning Of Stable Key Identity And Truth Direction

These terms are strict and testable in this batch.

**Stable key identity** means the rewrite preserves the exact contract identity fields for the target kind:

- `profile_rule`: `subject_key + attribute_key`
- `fact_slot`: `entity_key + attribute_key`
- `task_state`: `subject_key + state_key`
- `session_note`: no durable rewrite allowed in this batch

**Truth direction** means the rewrite preserves who/what the statement is about and what durable claim is being made. In practice, for this batch it means:

- the same subject/entity remains the owner of the truth
- the same attribute/state key remains the thing being asserted
- the value stays equivalent instead of being strengthened, broadened, or reversed

Examples:

- allowed: colloquial language preference -> canonical language preference sentence
- allowed: colloquial current employer phrasing -> canonical current employer sentence
- forbidden: tentative employer phrasing -> definite employer sentence
- forbidden: changing `location` into `organization`
- forbidden: changing `user` scope into `agent` scope
- forbidden: converting a summary-like note into a new durable fact

### Rewrite Allowed Only If

All of the following are true:

1. The candidate is a `record` item.
2. The candidate is based on explicit user content, or on a user-confirmed interpretation already normalized by the pipeline.
3. The final candidate kind is already stable under the shared contract.
4. The rewrite keeps the same:
   - `requested_kind`
   - `normalized_kind`
   - `attribute_key` or `state_key`
   - `subject_key` or `entity_key`
5. The rewrite does not add a new fact that was not explicit in the source.
6. The rewrite does not combine multiple clauses into one new synthesized durable truth.
7. The rewrite is constructible through the V1 deterministic template set described above.

### Rewrite Forbidden If

Any of the following are true:

- candidate is `assistant_inferred` only
- warnings indicate unstable or speculative content
- the rewrite would convert a `session_note` into a durable sentence
- the rewrite would change a record’s stable key
- the rewrite would require resolving cross-clause ambiguity that the contract did not already resolve
- item is a relation candidate

## Source Coverage

### Live Ingest

The live ingest split remains:

- auto-commit deterministic/stable winners
- inbox for deep-only or judgment-required items

This batch adds better assistance for the inboxed portion only.

### Import To Review Inbox

For `text` and `memory_md` review-import:

- preview extraction still happens through the existing import preview contract
- items inserted into review inbox now also pass through review assist
- stable record items can receive safe rewrite suggestions
- relation items keep action/reason only

### Canonical JSON

Canonical JSON stays outside the main review inbox flow and remains deterministic.

## Dashboard Behavior

### Default Prefill

For review inbox `record` items:

- textarea value defaults to `suggested_rewrite ?? payload.content`
- the original content still remains visible via source preview / excerpt

This means the default editing surface becomes the recommended submit-ready text, not the raw extracted phrase.

### Visual Context To Keep

Each item card should continue to show:

- source preview / source excerpt
- original candidate metadata
- suggested reason
- warnings

This preserves user trust. The rewrite should feel inspectable, not magical.

### Batch Accept Semantics

`Accept All` must respect the same final text a user sees in the textarea.

Required behavior:

- if a record item has a safe `suggested_rewrite` and the user has not manually changed the draft, the client should send that visible draft as `payload_override.content`
- if the user edited the draft, the user’s draft wins and is sent as `payload_override.content`
- relation items continue to use their current payload without rewrite semantics

This keeps batch accept and item-level accept aligned.

### Apply API Behavior Note

This batch does not add a new review-apply API.

`POST /api/v2/review-inbox/:id/apply` already accepts:

- `accept_all`
- `reject_all`
- `item_actions[]`
- `item_actions[].payload_override`

The required frontend/backend contract for this batch is:

- `Accept All` may still call the same route with `accept_all: true`
- if the page has visible draft text for record items, the client may expand `Accept All` into explicit `item_actions[]` with `action=edit_then_accept` plus `payload_override.content` for each record item whose visible draft differs from the persisted payload content
- alternatively, the server may gain a narrow internal enhancement to use persisted `suggested_rewrite` for unchanged record items during `accept_all`

For planning clarity, V1 should prefer the **client-driven explicit draft submission** path because:

- it avoids hidden server/client divergence
- it makes “what the user saw” equal to “what got submitted”
- it requires no public API shape change

As a result, the implementation plan should treat unchanged suggested rewrites and manual edits the same at submission time: both become explicit `payload_override.content` values on the apply call.

## API And Data Contract Impact

### Public API

No route path changes are required.

Existing review inbox APIs remain:

- `GET /api/v2/review-inbox`
- `GET /api/v2/review-inbox/:id`
- `POST /api/v2/review-inbox/:id/apply`
- `POST /api/v2/review-inbox/import`

Wire-shape additions are allowed only if they fit the existing item payload shape already persisted by review inbox. The preferred approach is to continue using:

- `suggested_action`
- `suggested_reason`
- `suggested_rewrite`

without adding a second review-specific API family.

### Persistence

No new tables or columns are required.

The existing `review_items_v2.suggested_rewrite` field is sufficient for this batch.

## Candidate Examples

### Safe Rewrite Examples

- `后续交流中文就行`
  - inferred durable: `profile_rule(language_preference)`
  - safe rewrite: `请用中文回答`

- `回答控制在三句话内`
  - inferred durable: `profile_rule(response_length)`
  - safe rewrite: `请把回答控制在三句话内`

- `OpenAI 那边现在还在职`
  - inferred durable: `fact_slot(organization)`
  - safe rewrite is allowed only if current stable key and truth direction are already deterministic

### Rewrite Must Stay Disabled

- `最近也许会考虑换方案`
  - stays `session_note`
  - no durable rewrite

- `我可能在 OpenAI`
  - no rewrite to `我在 OpenAI 工作`

- assistant-only interpretation not confirmed by the user
  - no durable rewrite

## Error Handling

### Server Side

If a suggested rewrite later fails the current write path checks:

- the item must remain pending or failed in the batch
- the failure must be visible through the current apply result
- the system must not silently downgrade or silently commit a different durable record

### Dashboard

If batch apply fails for some items:

- successful items should still commit
- failed items should remain actionable in the batch
- the user-visible result should match the actual apply summary

## Testing Strategy

### Server Unit Tests

Add direct tests for review assist classification:

- safe rewrite for stable colloquial explicit inputs
- no rewrite for speculative content
- no rewrite for assistant-only durable suggestions
- no rewrite when stable key would change

### Server API Tests

Cover:

- `accept_all` uses safe `suggested_rewrite`
- manual item edit overrides `suggested_rewrite`
- review-import for `text` / `memory_md` receives the same review assist semantics

### Dashboard Tests

Cover:

- review inbox record textarea defaults to `suggested_rewrite`
- source excerpt/original context remains visible
- `Accept All` applies the same visible draft
- manual edits still override the default prefill

### Regression Protection

Keep the following green:

- shared contract precision-first cases
- canonical JSON round-trip
- confirmed relation restore
- inbox vs auto-commit split
- relation candidate behavior

## Implementation Boundaries

Expected primary touch points:

- `packages/server/src/v2/review-assist.ts` (new)
- `packages/server/src/v2/review-inbox.ts`
- `packages/server/src/v2/contract.ts`
- `packages/server/src/v2/service.ts`
- `packages/server/tests/review-inbox-v2.test.ts`
- `packages/server/tests/v2-api.test.ts`
- `packages/dashboard/src/pages/ReviewInbox.tsx`
- `packages/dashboard/src/pages/ReviewInbox.test.tsx`

Potential secondary touch points:

- `packages/server/src/v2/prompts.ts` if canonical examples need to stay aligned
- `packages/dashboard/src/i18n/locales/zh.ts`
- `packages/dashboard/src/i18n/locales/en.ts`

## Rollout Notes

This batch is intentionally narrow:

- no new surface area
- no new persistence complexity
- no second LLM pass

If this works, the likely follow-up batch is not "more manual tooling". The likely follow-up is:

- expanding safe rewrite coverage for more stable explicit patterns
- improving bulk review efficiency
- possibly adding stronger assistant-proposal handling only after this safer review-assist baseline is proven

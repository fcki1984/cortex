# Review Assist Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic review assistance so stable-but-colloquial inbox items get safe suggested rewrites and the dashboard can submit those drafts with minimal human editing.

**Architecture:** Keep the existing automation-first split intact: deterministic winners still auto-commit, while inbox items gain a new server-side `review-assist` helper that computes `suggested_action`, `suggested_reason`, and safe `suggested_rewrite` without a second LLM call. The dashboard then treats `suggested_rewrite ?? payload.content` as the visible draft and submits explicit `payload_override.content` values so bulk apply and item-level apply always match what the user saw.

**Tech Stack:** Fastify, better-sqlite3, React, React Router, Vitest, Testing Library, TypeScript

---

## File Map

- Create: `packages/server/src/v2/review-assist.ts`
  Purpose: Pure deterministic helper for review guidance and safe rewrite generation.
- Create: `packages/server/tests/review-assist.test.ts`
  Purpose: Unit-test the whitelist rewrite matrix and blocked rewrite cases.
- Modify: `packages/server/src/v2/review-inbox.ts`
  Purpose: Replace inline suggestion logic with `review-assist`, persist rewrites for live/import batches, keep apply path on existing truth chain.
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
  Purpose: Cover persisted rewrites and explicit override submission.
- Modify: `packages/server/tests/v2-api.test.ts`
  Purpose: Guard shared-contract and inbox API behavior from regression.
- Modify: `packages/server/tests/helpers/v2-contract-fixtures.ts`
  Purpose: Add deterministic mock cases for rewrite-friendly and rewrite-forbidden candidates.
- Modify: `packages/dashboard/src/pages/ReviewInbox.tsx`
  Purpose: Prefill visible drafts from `suggested_rewrite`, show original content, and send explicit per-item apply payloads.
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
  Purpose: Lock the new prefill and bulk-accept semantics.
- Modify: `packages/dashboard/src/i18n/locales/zh.ts`
  Purpose: Add any missing labels for original content / suggestion wording.
- Modify: `packages/dashboard/src/i18n/locales/en.ts`
  Purpose: Keep the English locale shape aligned.

### Task 1: Build The Pure Review Assist Helper

**Files:**
- Create: `packages/server/src/v2/review-assist.ts`
- Create: `packages/server/tests/review-assist.test.ts`
- Modify: `packages/server/tests/helpers/v2-contract-fixtures.ts`

**Supported rewrite matrix (v1):**
- `profile_rule(language_preference)`:
  - 中文 -> `请用中文回答`
  - 英文 -> `Please answer in English`
  - 日文 -> `日本語で答えてください`
- `profile_rule(response_length)`:
  - only explicit normalized `N 句话内 / N sentences / N sentence max` style constraints already preserved by the payload
- `profile_rule(solution_complexity)`:
  - only explicit simple-solution constraint equivalent to `不要复杂方案`
- `fact_slot(location)`:
  - only explicit current `location` truths already stabilized by the shared contract
- `fact_slot(organization)`:
  - only explicit current `organization` truths already stabilized by the shared contract
- `task_state`:
  - only one canonical narrow case is in scope for V1:
    - `normalized_kind=task_state`
    - `subject_key=cortex`
    - `state_key=refactor_status`
    - `summary` already matches the current Cortex recall refactor truth
    - canonical rewrite: `当前任务是重构 Cortex recall`
- `relation` items:
  - never emit `suggested_rewrite`
- warned / unstable items:
  - never emit `suggested_rewrite`

**Payload fields relied upon for deterministic templates:**
- `profile_rule(language_preference)`:
  - `normalized_kind`
  - `subject_key`
  - `attribute_key`
  - normalized language-bearing content/value
- `profile_rule(response_length)`:
  - `normalized_kind`
  - `subject_key`
  - `attribute_key`
  - normalized sentence-count-bearing content/value
- `profile_rule(solution_complexity)`:
  - `normalized_kind`
  - `subject_key`
  - `attribute_key`
  - normalized simple-solution content/value
- `fact_slot(location)`:
  - `normalized_kind`
  - `entity_key`
  - `attribute_key`
  - explicit normalized location value
- `fact_slot(organization)`:
  - `normalized_kind`
  - `entity_key`
  - `attribute_key`
  - explicit normalized organization value
- `task_state(refactor_status)`:
  - `normalized_kind`
  - `subject_key`
  - `state_key`
  - `summary`
  - `status`

**Source type / suggested action defaults:**
- `assistant_inferred` record -> default `suggested_action=reject`
- warned but still reviewable record -> default `suggested_action=edit`
- stable explicit reviewable record with safe rewrite -> default `suggested_action=accept`
- relation item -> default `suggested_action=accept`

**Rewrite eligibility gate (must be encoded as table-driven tests):**
- rewrite allowed only when all are true:
  - `item_type=record`
  - `normalized_kind` is one of the V1 whitelist kinds above
  - `source_type` is `user_explicit` or `user_confirmed`
  - payload is not speculative
  - `warnings` is empty
  - stable key identity is preserved for the kind
  - truth direction is preserved
- rewrite blocked when any are true:
  - `item_type=relation`
  - `normalized_kind=session_note`
  - `source_type=assistant_inferred`
  - speculative content / tentative phrasing
  - non-empty `warnings`
  - missing required normalized payload fields for the target template
  - output would require translation or synthesis outside the locale rule below

**Rewrite locale rule (v1):**
- prefer payload-derived stable language preference if the deterministic template exists
- otherwise use the source content language if the deterministic template exists
- otherwise emit no `suggested_rewrite`
- never choose rewrite language from dashboard UI locale

- [ ] **Step 1: Write the failing helper tests**

Add helper-level tests that cover:
- `后续交流中文就行` -> `suggested_action=accept`, `suggested_rewrite=请用中文回答`
- `Please answer in English` or equivalent normalized payload -> `suggested_rewrite=Please answer in English`
- `日本語で答えて` or equivalent normalized payload -> `suggested_rewrite=日本語で答えてください`
- `回答控制在三句话内` -> `suggested_action=accept`, `suggested_rewrite=请把回答控制在三句话内`
- `不要复杂方案` -> `suggested_rewrite=不要复杂方案`
- stable `location` payload -> canonical `我住东京`
- stable `organization` payload -> canonical `我在 OpenAI 工作`
- canonical `task_state(refactor_status)` payload -> `suggested_rewrite=当前任务是重构 Cortex recall`
- relation payload -> no rewrite
- `最近也许会考虑换方案` -> no durable rewrite
- `我可能在 OpenAI` -> no durable rewrite
- a candidate with non-empty `warnings` -> no rewrite even if the raw content looks rewriteable
- unsupported or vague values return reason-only guidance
- rewrite language follows payload/source-derived locale, not UI locale

```ts
it('creates a safe rewrite for stable colloquial language preference', () => {
  const result = buildRecordReviewAssist({
    normalized_kind: 'profile_rule',
    source_type: 'user_explicit',
    subject_key: 'user',
    attribute_key: 'language_preference',
    content: '后续交流中文就行',
    warnings: [],
  });

  expect(result.suggested_action).toBe('accept');
  expect(result.suggested_rewrite).toBe('请用中文回答');
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `pnpm --dir packages/server test -- review-assist.test.ts`
Expected: FAIL because `review-assist.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal deterministic helper**

Add a pure helper module with small, explicit functions:
- `buildRecordReviewAssist(payload)`
- `buildRelationReviewAssist(payload)`
- deterministic whitelist-based rewrite builders by kind/key
- explicit eligibility gate helpers for `source_type`, speculative content, warnings, stable key presence, and locale rule
- no LLM calls

```ts
export function buildRecordReviewAssist(payload: Record<string, unknown>) {
  if (payload.source_type === 'assistant_inferred') {
    return { suggested_action: 'reject', suggested_reason: '...' };
  }

  const suggestedRewrite = buildSuggestedRewrite(payload);
  if (suggestedRewrite) {
    return { suggested_action: 'accept', suggested_reason: '...', suggested_rewrite: suggestedRewrite };
  }

  return fallbackRecordSuggestion(payload);
}
```

- [ ] **Step 4: Re-run the helper tests to verify they pass**

Run: `pnpm --dir packages/server test -- review-assist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/v2/review-assist.ts packages/server/tests/review-assist.test.ts packages/server/tests/helpers/v2-contract-fixtures.ts
git commit -m "feat: add deterministic review assist helper"
```

### Task 2: Wire Review Assist Into Review Inbox Persistence

**Files:**
- Modify: `packages/server/src/v2/review-inbox.ts`
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/server/tests/v2-api.test.ts`
- Modify: `packages/server/tests/helpers/v2-contract-fixtures.ts`

- [ ] **Step 1: Write the failing inbox/API tests**

Extend current review inbox tests to assert:
- live ingest batches persist `suggested_rewrite`
- import-review batches persist `suggested_rewrite`
- assistant-only or speculative items keep `suggested_rewrite=null`
- warned items keep `suggested_rewrite=null`
- explicit `payload_override.content` commits the override through `apply`

```ts
expect(detailBody.items[0]).toEqual(expect.objectContaining({
  suggested_action: 'accept',
  suggested_rewrite: '请用中文回答',
}));
```

- [ ] **Step 2: Run the targeted inbox tests to verify they fail**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts v2-api.test.ts`
Expected: FAIL because review inbox still uses the old inline suggestion logic.

- [ ] **Step 3: Replace inline suggestion logic with `review-assist`**

Update `review-inbox.ts` so:
- live batches call `buildRecordReviewAssist`
- import batches call `buildRecordReviewAssist` / `buildRelationReviewAssist`
- persisted `suggested_rewrite` comes from the helper, not from raw `payload.content`
- apply behavior stays on `confirmImport()` and existing v2 write rules

```ts
const suggestion = item.item_type === 'record'
  ? buildRecordReviewAssist(payload)
  : buildRelationReviewAssist(payload);
```

- [ ] **Step 4: Re-run the targeted inbox tests**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts v2-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/v2/review-inbox.ts packages/server/tests/review-inbox-v2.test.ts packages/server/tests/v2-api.test.ts packages/server/tests/helpers/v2-contract-fixtures.ts
git commit -m "feat: persist review assist suggestions in inbox batches"
```

### Task 3: Prefill Review Inbox Drafts And Make Bulk Apply Explicit

**Files:**
- Modify: `packages/dashboard/src/pages/ReviewInbox.tsx`
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
- Modify: `packages/dashboard/src/i18n/locales/zh.ts`
- Modify: `packages/dashboard/src/i18n/locales/en.ts`

- [ ] **Step 1: Write the failing dashboard tests**

Extend the page tests to assert:
- textarea defaults to `suggested_rewrite` when present
- original extracted content remains visible
- “全部接受” sends explicit `item_actions[]` with `edit_then_accept` + `payload_override.content` for visible drafts
- manual edits still override the suggested draft
- no dashboard test depends on raw `accept_all: true` server semantics for V1

```ts
await user.click(screen.getByRole('button', { name: '全部接受' }));

expect(apiMocks.applyReviewInboxBatchV2).toHaveBeenCalledWith('batch_1', {
  item_actions: [{
    item_id: 'item_1',
    action: 'edit_then_accept',
    payload_override: { content: '请用中文回答' },
  }],
});
```

- [ ] **Step 2: Run the targeted dashboard tests to verify they fail**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx`
Expected: FAIL because the current page hydrates drafts from `payload.content` and bulk accept uses `accept_all: true`.

- [ ] **Step 3: Implement the dashboard draft and submit behavior**

Update `ReviewInbox.tsx` so:
- draft initialization uses `suggested_rewrite ?? payload.content`
- original content is shown in read-only context text
- bulk accept constructs explicit `item_actions[]` for pending record items using the visible draft
- relation items still use `accept`
- raw callers that still send only `accept_all: true` remain unchanged in V1; dashboard bulk accept moves to explicit `item_actions[]`

```ts
const initialDraft = item.suggested_rewrite ?? rawContent;

const itemActions = pendingItems.map((item) => (
  item.item_type === 'record'
    ? { item_id: item.id, action: 'edit_then_accept', payload_override: { content: draftContent[item.id] } }
    : { item_id: item.id, action: 'accept' }
));
```

- [ ] **Step 4: Re-run the targeted dashboard tests**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/pages/ReviewInbox.tsx packages/dashboard/src/pages/ReviewInbox.test.tsx packages/dashboard/src/i18n/locales/zh.ts packages/dashboard/src/i18n/locales/en.ts
git commit -m "feat: prefill review inbox drafts from safe rewrites"
```

### Task 4: Guard End-To-End Review-Assist Regressions

**Files:**
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
- Modify: `packages/dashboard/src/pages/ImportExport.test.tsx`

- [ ] **Step 1: Add cross-surface regression tests**

Cover:
- live ingest -> inbox detail shows safe rewrite
- import-review -> inbox detail shows safe rewrite
- import/export system page stays unchanged for JSON and still works for text/MEMORY.md handoff

```ts
expect(detailBody.items[0].suggested_rewrite).toBe('请用中文回答');
expect(screen.getByText('来源摘录')).toBeTruthy();
```

- [ ] **Step 2: Run the targeted regression tests to verify they fail only where expected**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts`
Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx ImportExport.test.tsx`
Expected: FAIL until all rewrites and visible-draft behaviors are aligned.

- [ ] **Step 3: Implement the minimal fixes**

Only fix behavior needed for the tests:
- no new API family
- no new dashboard mode
- no schema changes

- [ ] **Step 4: Re-run the targeted regression tests**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts`
Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx ImportExport.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/tests/review-inbox-v2.test.ts packages/dashboard/src/pages/ReviewInbox.test.tsx packages/dashboard/src/pages/ImportExport.test.tsx
git commit -m "test: cover review assist rewrite regressions"
```

### Task 5: Batch Verification

**Files:**
- Modify: any touched files from Tasks 1-4

- [ ] **Step 1: Run the full server test suite**

Run: `pnpm --dir packages/server test`
Expected: PASS

- [ ] **Step 2: Run the server type/lint gate**

Run: `pnpm --dir packages/server lint`
Expected: PASS

- [ ] **Step 3: Run the server build**

Run: `pnpm --dir packages/server build`
Expected: PASS

- [ ] **Step 4: Run the full dashboard test suite**

Run: `pnpm --dir packages/dashboard test`
Expected: PASS

- [ ] **Step 5: Run the dashboard build**

Run: `pnpm --dir packages/dashboard build`
Expected: PASS

- [ ] **Step 6: Commit the final integrated batch**

```bash
git add packages/server packages/dashboard
git commit -m "feat: add precision-first review assist rewrites"
```

# Colloquial Profile Rule Auto-Commit Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand automation-first durable writes so stable colloquial `profile_rule` inputs for three existing keys auto-commit consistently across manual write, live ingest, and import preview.

**Architecture:** Centralize colloquial `profile_rule` recognition, canonical phrasing, and disposition routing in one shared internal contract helper. Then wire `normalizeManualInput()`, ingest routing, import preview, and review-assist to that same helper so the same explicit input lands on the same stable key and canonical content no matter which entry path is used.

**Tech Stack:** TypeScript, Fastify, Vitest, existing v2 shared contract, review inbox, and import/export services

---

## File Map

- Modify: `packages/server/src/v2/contract.ts`
  Purpose: Centralize colloquial `profile_rule` matching, weak-language rejection, canonical phrase generation, and disposition helpers for the three in-scope keys.
- Modify: `packages/server/src/v2/normalize.ts`
  Purpose: Route manual/API writes through the shared colloquial helper so atomic writes stabilize to the same canonical truth content.
- Modify: `packages/server/src/v2/service.ts`
  Purpose: Make ingest and import preview routing use the shared disposition result instead of relying only on `deterministic/fast/deep` origin.
- Modify: `packages/server/src/v2/review-assist.ts`
  Purpose: Reuse the same canonical phrase helper so review rewrites match direct auto-commit truth content.
- Modify: `packages/server/src/v2/prompts.ts`
  Purpose: Synchronize positive and negative examples with the new deterministic/shared baseline, without adding new product behavior.
- Modify: `packages/server/tests/contract.test.ts`
  Purpose: Lock shared helper behavior and weak-language blocking at the contract layer.
- Modify: `packages/server/tests/v2-records.test.ts`
  Purpose: Guard manual/API write normalization for colloquial profile rules.
- Modify: `packages/server/tests/v2-api.test.ts`
  Purpose: Guard ingest/API response counts and manual write parity.
- Modify: `packages/server/tests/import-export-v2.test.ts`
  Purpose: Guard text / `MEMORY.md` preview parity and drift protection.
- Modify: `packages/server/tests/review-assist.test.ts`
  Purpose: Assert review-assist rewrite parity with auto-commit canonical content.
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
  Purpose: Only if canonical phrasing expectations change for existing review-assisted items.
- Modify: `packages/dashboard/src/pages/ImportExport.test.tsx`
  Purpose: Only if preview content expectations need to follow the new canonical phrasing.

### Task 1: Centralize Colloquial `profile_rule` Matching In The Shared Contract

**Files:**
- Modify: `packages/server/src/v2/contract.ts`
- Modify: `packages/server/tests/contract.test.ts`

- [ ] **Step 1: Write the failing shared-contract tests**

Add tests that explicitly cover the new supported colloquial variants and blocked weak-language variants:

- `后续交流中文就行` -> `profile_rule(language_preference)` + canonical content `请用中文回答`
- `之后都用中文` -> `profile_rule(language_preference)` + canonical content `请用中文回答`
- `三句话内就行` -> `profile_rule(response_length)` + canonical content `请把回答控制在三句话内`
- `方案简单点` -> `profile_rule(solution_complexity)` + canonical content `不要复杂方案`
- `中文就行吧` stays non-durable
- `可能简单点更好` stays non-durable

Add direct assertions around the new helper output so the test does not only depend on downstream normalization.

```ts
expect(resolveAtomicContractDecision('后续交流中文就行').requested_kind).toBe('profile_rule');
expect(canonicalizeDurableContent({
  kind: 'profile_rule',
  content: '后续交流中文就行',
  owner_scope: 'user',
  subject_key: 'user',
  attribute_key: 'language_preference',
})).toBe('请用中文回答');
```

- [ ] **Step 2: Run the targeted shared-contract tests**

Run: `pnpm --dir packages/server test -- contract.test.ts`
Expected: FAIL because the current logic still treats some weak phrasing too loosely and does not expose a single shared colloquial helper/disposition boundary.

- [ ] **Step 3: Extract a narrow shared colloquial helper in `contract.ts`**

Add or refactor a small internal helper set that:

- recognizes only the three in-scope `profile_rule` keys
- distinguishes strong explicit phrasing from hedged/tentative phrasing
- returns a canonical phrase for accepted durable outcomes
- exposes a small disposition result that downstream callers can reuse

Suggested internal shape:

```ts
type ColloquialProfileRuleMatch = {
  attribute_key: 'language_preference' | 'response_length' | 'solution_complexity';
  canonical_content: string;
  disposition: 'auto_commit' | 'review' | 'note';
};
```

Keep this helper internal to the v2 contract layer; do not add a new public API type.

- [ ] **Step 4: Re-run the shared-contract tests**

Run: `pnpm --dir packages/server test -- contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/v2/contract.ts packages/server/tests/contract.test.ts
git commit -m "feat: centralize colloquial profile rule contract"
```

### Task 2: Pull Manual Write And Review Assist Onto The Same Canonical Truth Content

**Files:**
- Modify: `packages/server/src/v2/normalize.ts`
- Modify: `packages/server/src/v2/review-assist.ts`
- Modify: `packages/server/tests/v2-records.test.ts`
- Modify: `packages/server/tests/review-assist.test.ts`

- [ ] **Step 1: Write the failing manual-write and review-assist tests**

Extend tests so they prove:

- `POST /api/v2/records`-style normalization of `后续交流中文就行` lands as `profile_rule(language_preference)` with value/content `请用中文回答`
- `三句话内就行` lands as `请把回答控制在三句话内`
- `方案简单点` lands as `不要复杂方案`
- review assist for the same stabilized keys produces the exact same `suggested_rewrite`
- weak-language variants do not produce an auto-commit-ready canonical rewrite

```ts
expect(buildRecordReviewAssist(createReviewAssistRecordPayload({
  content: '后续交流中文就行',
  source_excerpt: '后续交流中文就行',
  normalized_kind: 'profile_rule',
  attribute_key: 'language_preference',
})).suggested_rewrite).toBe('请用中文回答');
```

- [ ] **Step 2: Run the targeted tests**

Run: `pnpm --dir packages/server test -- v2-records.test.ts review-assist.test.ts`
Expected: FAIL because manual normalization and review assist are still sharing canonicalization only loosely, without the new explicit weak-language gate.

- [ ] **Step 3: Wire `normalize.ts` and `review-assist.ts` to the shared helper**

Make `normalizeManualInput()` consume the new shared colloquial helper before falling back to broader logic.

Make `review-assist.ts` use the same canonical phrase helper rather than its own slightly separate understanding of safe rewrites.

Keep these boundaries:

- no new `profile_rule` keys
- no change to fact/task canonicalization behavior in this batch
- no public API shape changes

- [ ] **Step 4: Re-run the targeted tests**

Run: `pnpm --dir packages/server test -- v2-records.test.ts review-assist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/v2/normalize.ts packages/server/src/v2/review-assist.ts packages/server/tests/v2-records.test.ts packages/server/tests/review-assist.test.ts
git commit -m "feat: align manual writes and review assist for profile rules"
```

### Task 3: Replace Origin-Only Routing With Shared Disposition In Ingest And Import Preview

**Files:**
- Modify: `packages/server/src/v2/service.ts`
- Modify: `packages/server/src/v2/prompts.ts`
- Modify: `packages/server/tests/v2-api.test.ts`
- Modify: `packages/server/tests/import-export-v2.test.ts`

- [ ] **Step 1: Write the failing ingest and import-preview parity tests**

Add tests that lock:

- `后续交流中文就行` ingests as an auto-committed `profile_rule(language_preference)` with content `请用中文回答`
- ingest response still reports `auto_committed_count=1`, `review_pending_count=0`
- `最近也许会考虑换方案。后续交流中文就行` yields `session_note + profile_rule(language_preference)` rather than dropping the stable preference to note
- text import preview for `后续交流中文就行` returns `profile_rule(language_preference)` with canonical content `请用中文回答`
- `MEMORY.md` preview of the same phrase returns the same candidate
- weak-language variants do not surface as stable durable preview candidates

```ts
expect(body.records[0]?.written_kind).toBe('profile_rule');
expect(body.records[0]?.content).toBe('请用中文回答');
expect(body.auto_committed_count).toBe(1);
expect(body.review_pending_count).toBe(0);
```

- [ ] **Step 2: Run the targeted tests**

Run: `pnpm --dir packages/server test -- v2-api.test.ts import-export-v2.test.ts`
Expected: FAIL because live ingest still routes too heavily by origin and import preview parity is not fully locked to the new colloquial helper.

- [ ] **Step 3: Update `service.ts` to route by validated shared disposition**

Refactor the ingest detail routing so the final decision comes from the validated shared contract result rather than just:

- `deterministic`
- `fast`
- `deep`

For this batch:

- stable colloquial in-scope profile rules -> `auto_commit`
- deep-only but not deterministic-safe profile-rule durable -> `review`
- weak/tentative preference language -> `note`

Keep compound-input arbitration unchanged except for consuming the new per-clause shared disposition result.

- [ ] **Step 4: Synchronize prompt examples without widening product behavior**

Update `prompts.ts` so extraction guidance includes the new colloquial positive and negative examples, but only in ways already supported by the deterministic/shared contract.

Examples to include:

- `后续交流中文就行`
- `三句话内就行`
- `方案简单点`
- `中文就行吧`
- `可能简单点更好`

- [ ] **Step 5: Re-run the targeted tests**

Run: `pnpm --dir packages/server test -- v2-api.test.ts import-export-v2.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/v2/service.ts packages/server/src/v2/prompts.ts packages/server/tests/v2-api.test.ts packages/server/tests/import-export-v2.test.ts
git commit -m "feat: route colloquial profile rules through shared disposition"
```

### Task 4: Batch Verification And Dashboard Expectation Sync

**Files:**
- Modify only if needed: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
- Modify only if needed: `packages/dashboard/src/pages/ImportExport.test.tsx`
- Verify all touched files from Tasks 1-3

- [ ] **Step 1: Sync dashboard tests only if canonical phrasing assertions changed**

If current dashboard tests assert on old raw colloquial content where the server now returns canonical content, update only those expectations. Do not add new UI behavior in this batch.

- [ ] **Step 2: Run server tests**

Run: `pnpm --dir packages/server test`
Expected: PASS

- [ ] **Step 3: Run server lint**

Run: `pnpm --dir packages/server lint`
Expected: PASS

- [ ] **Step 4: Run server build**

Run: `pnpm --dir packages/server build`
Expected: PASS

- [ ] **Step 5: Run dashboard tests**

Run: `pnpm --dir packages/dashboard test`
Expected: PASS

- [ ] **Step 6: Run dashboard build**

Run: `pnpm --dir packages/dashboard build`
Expected: PASS

- [ ] **Step 7: Run smoke gate**

Run: `SMOKE_ROUNDS=3 node scripts/smoke-v2.mjs`
Expected: PASS, with no regression in ingress observability or review-inbox/import-export mainline behavior.

- [ ] **Step 8: Prepare next-batch handoff**

Summarize:

- which colloquial profile-rule variants now auto-commit
- which weak-language variants still route to review/note
- whether review-assist rewrites match direct durable content
- what remains for the next slice: review inbox load reduction

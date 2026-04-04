# Automation-First Review Load Reduction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce manual review pressure by suppressing no-op / duplicate review work, expanding deterministic short follow-up arbitration, and hardening the release gate around the real automation-first path.

**Architecture:** Keep the current automation-first shape: shared-contract-safe winners still auto-commit, review-only or ambiguous items still enter the review inbox, and speculative content still downgrades to `session_note`. The new work stays inside the existing v2 write and review-routing path by adding one shared suppression/arbitration layer before inbox persistence, then tightening tests and smoke so browser-visible behavior and remote validation stay aligned.

**Tech Stack:** Fastify, TypeScript, Vitest, React, Vite

---

## Planned File Map

- `packages/server/src/v2/service.ts`
  - Own shared ingest/import routing decisions, clause winner arbitration, and short follow-up handling.
- `packages/server/src/v2/review-inbox.ts`
  - Own batch creation, item persistence, suppression of empty/no-op review batches, and apply semantics.
- `packages/server/src/v2/review-assist.ts`
  - Own suggested action / reason / rewrite generation for the surviving review items.
- `packages/server/src/v2/contract.ts`
  - Own deterministic canonical-case boundaries for short explicit follow-ups when the shared contract can safely auto-decide.
- `packages/server/tests/review-inbox-v2.test.ts`
  - Lock review-routing, suppression, and apply-path behavior.
- `packages/server/tests/v2-api.test.ts`
  - Lock public API parity for ingest/import/export after suppression and follow-up arbitration.
- `packages/server/tests/contract.test.ts`
  - Lock deterministic acceptance/rejection boundaries for new short follow-up cases.
- `packages/server/tests/helpers/v2-contract-fixtures.ts`
  - Add mocked extraction drift fixtures only where needed to prove suppression/arbitration survives deep-output noise.
- `packages/server/scripts` and `scripts/smoke-v2.mjs`
  - Keep remote smoke aligned with real deployment constraints, including the current IPv4-safe validation path.
- `packages/dashboard/src/pages/ReviewInbox.test.tsx`
  - Verify current product surface does not regress when inbox batches are reduced or omitted.
- `packages/dashboard/src/pages/ImportExport.test.tsx`
  - Verify system-page import notices remain aligned when a send-to-inbox operation resolves to auto-commit-only or no remaining batch.

### Task 1: Lock no-op suppression and reduced review load with failing tests

**Files:**
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/server/tests/v2-api.test.ts`
- Modify: `packages/server/tests/contract.test.ts`
- Modify: `packages/server/tests/helpers/v2-contract-fixtures.ts`
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
- Modify: `packages/dashboard/src/pages/ImportExport.test.tsx`

- [ ] **Step 1: Add a failing live-ingest regression for canonical no-op suppression**

Create a server test where an agent already has `请用中文回答`, then another ingest with `后续交流中文就行` produces no review batch and no duplicate review work.

- [ ] **Step 2: Run the focused no-op suppression test and verify it fails for the right reason**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts -t "canonical no-op suppression"`
Expected: FAIL because the current pipeline still creates redundant review or duplicate write work.

- [ ] **Step 3: Add a failing import-side regression for empty-batch suppression**

Create a test where `POST /api/v2/review-inbox/import` receives only content already covered by existing truth, and assert it returns no pending batch.

- [ ] **Step 4: Run the focused import suppression test and verify it fails correctly**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts -t "empty-batch suppression"`
Expected: FAIL because the current import path still persists review work that should collapse away.

- [ ] **Step 5: Add a failing compound regression for same-key winner suppression**

Create a test where a compound input contains two clauses for the same stable key and verify only the final winner survives into auto-commit/review routing.

- [ ] **Step 6: Run the focused compound winner test and verify it fails correctly**

Run: `pnpm --dir packages/server test -- v2-api.test.ts -t "same-key winner suppression"`
Expected: FAIL because superseded earlier clauses are still visible in downstream review work.

- [ ] **Step 7: Add failing deterministic follow-up tests for short confirmations and keep-drop**

Add contract/API cases such as short confirm/update/drop follow-ups that should resolve without manual inbox work when the target durable is already explicit and stable.

- [ ] **Step 8: Run the focused follow-up tests and verify they fail for the right reason**

Run: `pnpm --dir packages/server test -- contract.test.ts -t "short follow-up arbitration"`
Expected: FAIL because the current contract still leaves some clear follow-ups in review or note fallback.

- [ ] **Step 9: Add dashboard tests that assert reduced batch count does not break the current UI**

Cover:
- `ReviewInbox` empty state after suppressed batches
- `ImportExport` send-to-inbox success when no batch remains after safe auto-commit / suppression

- [ ] **Step 10: Run focused dashboard tests and verify they fail correctly**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx ImportExport.test.tsx`
Expected: FAIL because current UI assertions still assume a persisted batch in cases that should now collapse away.

- [ ] **Step 11: Commit the failing-test checkpoint**

```bash
git add packages/server/tests/review-inbox-v2.test.ts \
  packages/server/tests/v2-api.test.ts \
  packages/server/tests/contract.test.ts \
  packages/server/tests/helpers/v2-contract-fixtures.ts \
  packages/dashboard/src/pages/ReviewInbox.test.tsx \
  packages/dashboard/src/pages/ImportExport.test.tsx
git commit -m "test: lock automation-first review suppression regressions"
```

### Task 2: Add shared suppression before review inbox persistence

**Files:**
- Modify: `packages/server/src/v2/service.ts`
- Modify: `packages/server/src/v2/review-inbox.ts`
- Modify: `packages/server/src/v2/review-assist.ts`
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/server/tests/v2-api.test.ts`

- [ ] **Step 1: Add a shared “reviewable vs no-op” decision helper**

Implement a helper in the existing v2 routing path that compares the final canonical winner against current agent truth and pending batch context before inbox persistence.

- [ ] **Step 2: Treat exact canonical matches as no-op, not new review work**

When `kind + stable key + canonical content` already matches active truth, skip inbox persistence and do not create a surviving review item.

- [ ] **Step 3: Collapse superseded same-key candidates before creating review items**

For one input or one import segment, keep only the final clause winner for each stable key before review-assist suggestions are generated.

- [ ] **Step 4: Prevent empty or no-op-only batches from being persisted**

If every surviving item was auto-committed or suppressed as no-op, return a no-batch result and keep current API shape stable.

- [ ] **Step 5: Keep review-only kinds review-only after suppression**

Ensure `response_style` and other review-only survivors still go through review inbox with the current canonical rewrite and apply path.

- [ ] **Step 6: Run focused server regressions until Task 1 tests pass**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts v2-api.test.ts`
Expected: PASS for the newly added suppression and empty-batch cases.

- [ ] **Step 7: Commit the suppression/routing slice**

```bash
git add packages/server/src/v2/service.ts \
  packages/server/src/v2/review-inbox.ts \
  packages/server/src/v2/review-assist.ts \
  packages/server/tests/review-inbox-v2.test.ts \
  packages/server/tests/v2-api.test.ts
git commit -m "feat: suppress redundant automation-first review work"
```

### Task 3: Expand deterministic short follow-up arbitration

**Files:**
- Modify: `packages/server/src/v2/contract.ts`
- Modify: `packages/server/src/v2/service.ts`
- Modify: `packages/server/tests/contract.test.ts`
- Modify: `packages/server/tests/v2-api.test.ts`
- Modify: `packages/server/tests/helpers/v2-contract-fixtures.ts`

- [ ] **Step 1: Extend the deterministic contract only for short explicit follow-ups**

Add the minimum additional short follow-up patterns needed to resolve “yes/update/drop/keep” cases where the referenced durable is already explicit and stable.

- [ ] **Step 2: Reuse the same winner arbitration for manual write, ingest, and import preview**

Keep the existing precision-first policy: no new long-form inference, no assistant-only promotion, and no widening of speculative durability.

- [ ] **Step 3: Make review routing consume the follow-up outcome, not raw extraction origin**

If a short follow-up deterministically resolves to keep/update/drop, auto-commit or suppress accordingly; only remaining ambiguous cases may enter review.

- [ ] **Step 4: Re-run focused contract/API tests until the new follow-up matrix passes**

Run: `pnpm --dir packages/server test -- contract.test.ts v2-api.test.ts`
Expected: PASS for short confirm/update/drop/keep cases without regression to `session_note` or inbox spam.

- [ ] **Step 5: Commit the deterministic follow-up expansion**

```bash
git add packages/server/src/v2/contract.ts \
  packages/server/src/v2/service.ts \
  packages/server/tests/contract.test.ts \
  packages/server/tests/v2-api.test.ts \
  packages/server/tests/helpers/v2-contract-fixtures.ts
git commit -m "feat: expand deterministic automation-first follow-up arbitration"
```

### Task 4: Align current UI expectations with reduced inbox load

**Files:**
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
- Modify: `packages/dashboard/src/pages/ImportExport.test.tsx`
- Modify: `packages/dashboard/src/pages/ImportExport.tsx` (only if existing notice copy must change)

- [ ] **Step 1: Update ReviewInbox tests for suppressed/omitted batches**

Verify the page stays stable when the backend now returns fewer persisted batches for no-op inputs.

- [ ] **Step 2: Update ImportExport tests for “auto-commit only” and “no remaining batch” outcomes**

Keep the current send-to-inbox workflow, but make assertions match the reduced-review semantics.

- [ ] **Step 3: Change UI copy only if a current assertion is now misleading**

Do not add a new page or a new workflow; limit changes to wording that would otherwise misrepresent no-batch outcomes.

- [ ] **Step 4: Run focused dashboard tests until they pass**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx ImportExport.test.tsx`
Expected: PASS with no new interaction surface.

- [ ] **Step 5: Commit the dashboard sync slice**

```bash
git add packages/dashboard/src/pages/ReviewInbox.test.tsx \
  packages/dashboard/src/pages/ImportExport.test.tsx \
  packages/dashboard/src/pages/ImportExport.tsx
git commit -m "test: align system surfaces with reduced review load"
```

### Task 5: Standardize the release gate around the real deployment path

**Files:**
- Modify: `scripts/smoke-v2.mjs`
- Modify: `packages/server/tests/smoke-v2-lib.test.ts`
- Modify: `docs/superpowers/plans/2026-04-04-automation-first-review-load-reduction.md`

- [ ] **Step 1: Reproduce the current remote validation constraint in code**

Document and encode the current remote validation requirement so smoke does not misreport application regressions because of the known shell-path network instability.

- [ ] **Step 2: Update smoke to use the stable remote path explicitly**

Keep the current 3-round gate and cleanup semantics, but make the remote check path deterministic for deployed verification.
Use an explicit validation target (`CORTEX_SMOKE_VALIDATION_URL`) when the release gate must hit the deployed ingress rather than the local/default shell path.

- [ ] **Step 3: Add/adjust smoke tests so this validation path is locked**

Prevent future release loops where environment transport noise is mistaken for review-inbox regressions.

- [ ] **Step 4: Run the smoke-focused test and then the real smoke gate**

Run: `pnpm --dir packages/server test -- smoke-v2-lib.test.ts`
Expected: PASS

Run: `SMOKE_ROUNDS=3 node scripts/smoke-v2.mjs`
Expected: PASS against the intended validation path.

- [ ] **Step 5: Commit the release-gate hardening**

```bash
git add scripts/smoke-v2.mjs \
  packages/server/tests/smoke-v2-lib.test.ts \
  docs/superpowers/plans/2026-04-04-automation-first-review-load-reduction.md
git commit -m "chore: harden automation-first remote smoke gate"
```

### Task 6: Full batch verification

**Files:**
- Verify only

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

- [ ] **Step 6: Run the 3-round smoke gate**

Run: `SMOKE_ROUNDS=3 node scripts/smoke-v2.mjs`
Expected: PASS

- [ ] **Step 7: Commit the verification checkpoint**

```bash
git add -A
git commit -m "chore: verify automation-first review load reduction batch"
```

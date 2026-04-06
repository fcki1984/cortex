# Mixed Active Pending Follow-up Unification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one short user follow-up resolve both active truths and pending live review items in the same ingest, so automation-first memory can drop or keep the right survivors without forcing extra manual cleanup.

**Architecture:** Keep the existing v2 shapes and review inbox tables. The change stays inside the current ingest follow-up path by teaching the selection flow to combine active-truth cleanup with pending-review apply/reject work, then locking the behavior with inject, real HTTP, and smoke regressions.

**Tech Stack:** Fastify, TypeScript, Vitest

---

## Planned File Map

- `packages/server/src/v2/service.ts`
  - Own short follow-up ingest arbitration, active truth deletion, and final response assembly.
- `packages/server/src/v2/review-inbox.ts`
  - Own pending live review follow-up resolution and batch apply/reject semantics.
- `packages/server/tests/review-inbox-v2.test.ts`
  - Lock mixed active + pending follow-up behavior at the service/inject level.
- `packages/server/tests/review-followup-http.test.ts`
  - Lock the same behavior over real HTTP transport.
- `scripts/smoke-v2.mjs`
  - Keep the release gate aligned with the new mixed follow-up automation path.
- `packages/server/tests/platform-surface.test.ts`
  - Lock the smoke gate coverage string so the new scenario cannot silently drop out.

### Task 1: Add failing mixed follow-up regressions

**Files:**
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/server/tests/review-followup-http.test.ts`

- [ ] **Step 1: Add a failing inject test for mixed keep-drop across active truth and pending review**

Create a scenario with an active `location` truth plus a pending live `organization` review item, then assert `就公司，别记住址` deletes the active location and accepts the pending organization in one ingest.

- [ ] **Step 2: Run the focused inject test and verify it fails for the right reason**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts -t "mixed active and pending fact follow-up"`
Expected: FAIL because the current ingest path only resolves one side of the state.

- [ ] **Step 3: Add a failing real-HTTP regression for mixed drop-all across active truth and pending review**

Create a scenario with an active durable plus a pending live review item, then assert `都去掉` clears both the active truth and the pending batch over real HTTP transport.

- [ ] **Step 4: Run the focused HTTP test and verify it fails correctly**

Run: `pnpm --dir packages/server test -- review-followup-http.test.ts -t "mixed active and pending"`
Expected: FAIL because the current transport path still leaves one side unresolved.

### Task 2: Unify active and pending short follow-up handling

**Files:**
- Modify: `packages/server/src/v2/service.ts`
- Modify: `packages/server/src/v2/review-inbox.ts`
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/server/tests/review-followup-http.test.ts`

- [ ] **Step 1: Let short follow-up selection produce deletions even when local survivors live on the other side**

Adjust the active/pending selection helpers so explicit keep-drop directives can still drop local items when the kept survivor exists only in the other state bucket.

- [ ] **Step 2: Resolve active truth cleanup and pending review apply/reject in the same ingest call**

Remove the current “handled one side, skip the other side” behavior so short follow-ups can commit accepted pending items and delete/reject the right active or pending survivors together.

- [ ] **Step 3: Keep fallback-note suppression and response shape stable**

The ingest response should still report committed records and avoid creating a fallback `session_note` when the short directive fully resolves state.

- [ ] **Step 4: Re-run the focused regressions until they pass**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts review-followup-http.test.ts`
Expected: PASS for the new mixed follow-up scenarios.

### Task 3: Promote the behavior into smoke and batch verification

**Files:**
- Modify: `scripts/smoke-v2.mjs`
- Modify: `packages/server/tests/platform-surface.test.ts`

- [ ] **Step 1: Add a smoke scenario for mixed active/pending keep-drop or drop-all**

Cover one browser-visible path that proves automation-first cleanup now works without manual inbox cleanup.

- [ ] **Step 2: Lock the smoke log string in the platform-surface test**

Make sure the new scenario stays part of the release gate summary.

- [ ] **Step 3: Run the gate commands**

Run:
- `pnpm --dir packages/server test`
- `pnpm --dir packages/server lint`
- `env CORTEX_BASE_URL=http://127.0.0.1:21101 SMOKE_ROUNDS=3 node scripts/smoke-v2.mjs`

Expected: PASS with the mixed follow-up scenario included.

# Review Inbox Apply Suggested Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single automation-first batch action that applies safe review suggestions in one step while leaving edit-required items pending.

**Architecture:** Reuse the existing `POST /api/v2/review-inbox/:id/apply` path by adding an optional `apply_suggested` mode. The server resolves per-item actions from persisted `suggested_action` and `suggested_rewrite`, and the dashboard triggers that mode through one button instead of reconstructing mixed accept/reject actions client-side.

**Tech Stack:** Fastify, TypeScript, Vitest, React, Vite

---

### Task 1: Lock apply-suggested behavior with failing tests

**Files:**
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`

- [ ] **Step 1: Add a failing server test for mixed accept/reject suggestion application**

Cover a batch containing:
- one `suggested_action=accept` record with `suggested_rewrite`
- one `suggested_action=reject` record
- one `suggested_action=edit` record

Assert `POST /api/v2/review-inbox/:id/apply` with `{ apply_suggested: true }`:
- commits the accept item using the persisted rewrite
- rejects the reject item
- leaves the edit item pending

- [ ] **Step 2: Run the focused server test and verify it fails for the right reason**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts -t "apply_suggested"`
Expected: FAIL because the route does not yet understand `apply_suggested`.

- [ ] **Step 3: Add a failing dashboard test for the new batch action**

Assert the page shows an `应用建议动作` button and calls `applyReviewInboxBatchV2(batchId, { apply_suggested: true })`.

- [ ] **Step 4: Run the focused dashboard test and verify it fails for the right reason**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx -t "apply suggested"`
Expected: FAIL because the button and request path do not exist yet.

### Task 2: Add server-side apply-suggested routing

**Files:**
- Modify: `packages/server/src/api/review-inbox-v2.ts`
- Modify: `packages/server/src/v2/review-inbox.ts`
- Modify: `packages/server/tests/review-inbox-v2.test.ts`

- [ ] **Step 1: Extend the apply route payload with optional `apply_suggested`**

Keep the existing route and response shape. Reject ambiguous combinations like `apply_suggested` with `accept_all`, `reject_all`, or explicit `item_actions`.

- [ ] **Step 2: Resolve suggested actions on the server**

For pending/failed items:
- `accept` -> accept, using `suggested_rewrite` for record content when available
- `reject` -> reject
- `edit` -> no-op, keep pending

- [ ] **Step 3: Reuse the existing confirm/apply truth path**

Do not add a new write path. Feed resolved items back through `confirmImport()` and current outcome bookkeeping.

- [ ] **Step 4: Run focused server tests until they pass**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts`
Expected: PASS for new apply-suggested cases with no regressions to existing apply behavior.

### Task 3: Add the one-click dashboard action

**Files:**
- Modify: `packages/dashboard/src/pages/ReviewInbox.tsx`
- Modify: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
- Modify: `packages/dashboard/src/i18n/locales/zh.ts`
- Modify: `packages/dashboard/src/i18n/locales/en.ts`

- [ ] **Step 1: Add a top-level `Apply Suggested` action**

The action should be enabled only when the current batch has at least one actionable item with `suggested_action=accept|reject`.

- [ ] **Step 2: Keep existing granular actions available**

Do not remove per-item accept/reject/edit flows or the current batch-wide accept-all/reject-all flows in this slice.

- [ ] **Step 3: Run focused dashboard tests until they pass**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx`
Expected: PASS, including the new one-click path and existing granular action regressions.

### Task 4: Batch verification

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

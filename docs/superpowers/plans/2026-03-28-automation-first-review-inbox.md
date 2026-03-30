# Automation-First Review Inbox Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automation-first review inbox so deterministic v2 writes still auto-commit, while ambiguous live-ingest and text/MEMORY.md import candidates persist into a unified human review flow.

**Architecture:** Extend the v2 server with a minimal persisted review inbox (`review_batches_v2`, `review_items_v2`) and a dedicated service that reuses the existing v2 write/import truth paths. Update ingest to classify candidates into `auto_commit` vs `review`, add review-inbox APIs, and make the dashboard default to a new `/review-inbox` page while keeping Import / Export as a system tool.

**Tech Stack:** Fastify, better-sqlite3, React, React Router, Vitest, Testing Library

---

### Task 1: Persist Review Inbox Schema And Service Shell

**Files:**
- Create: `packages/server/src/v2/review-inbox.ts`
- Modify: `packages/server/src/db/connection.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/tests/review-inbox-v2.test.ts`

- [ ] **Step 1: Write the failing schema/service tests**

Add tests that expect:
- review inbox tables to exist after DB init
- a live-ingest or import batch can be persisted and loaded back
- batch status rolls up from item status (`pending`, `partially_applied`, `completed`, `dismissed`)

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts`
Expected: FAIL because the inbox service and schema do not exist yet.

- [ ] **Step 3: Add migration `017_review_inbox_v2`**

Create the two minimal tables and supporting indexes:
- `review_batches_v2`
- `review_items_v2`

- [ ] **Step 4: Implement the review inbox service shell**

Add helpers to:
- create batches/items
- list batches
- load batch detail
- recalculate batch status from item states

- [ ] **Step 5: Run the targeted tests to verify they pass**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts`
Expected: PASS

### Task 2: Split Ingest Into Auto-Commit And Review Inbox

**Files:**
- Modify: `packages/server/src/v2/service.ts`
- Modify: `packages/server/src/api/ingest-v2.ts`
- Modify: `packages/server/tests/v2-api.test.ts`
- Modify: `packages/server/tests/helpers/v2-contract-fixtures.ts`
- Test: `packages/server/tests/review-inbox-v2.test.ts`

- [ ] **Step 1: Write the failing ingest tests**

Add tests that cover:
- deterministic/stable canonical cases still auto-commit and create no review batch
- LLM-only durable suggestions create a review batch instead of direct records
- ingest response includes `review_batch_id`, `review_pending_count`, `auto_committed_count`

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts v2-api.test.ts`
Expected: FAIL because ingest still commits every candidate directly.

- [ ] **Step 3: Refactor candidate collection to expose enough provenance for routing**

Keep deterministic-first behavior, but return enough metadata to distinguish:
- deterministic/fast/stable auto-commit winners
- deep-only or ambiguous candidates that must go to review

- [ ] **Step 4: Update `ingest()` and the route response**

Make ingest:
- auto-commit deterministic/stable winners through existing write paths
- persist non-auto items into a new live-ingest review batch
- return the new counters/IDs without changing existing committed record payload shape

- [ ] **Step 5: Re-run the ingest tests**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts v2-api.test.ts`
Expected: PASS

### Task 3: Add Review Inbox APIs And Import-To-Inbox Flow

**Files:**
- Create: `packages/server/src/api/review-inbox-v2.ts`
- Modify: `packages/server/src/api/router.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/v2/import-export.ts`
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/server/tests/v2-api.test.ts`

- [ ] **Step 1: Write the failing API tests**

Cover:
- `GET /api/v2/review-inbox`
- `GET /api/v2/review-inbox/:id`
- `POST /api/v2/review-inbox/import`
- `POST /api/v2/review-inbox/:id/apply`
- import batch record/relation apply semantics, including `confirmed_restore`

- [ ] **Step 2: Run the API tests to verify they fail**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts v2-api.test.ts`
Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement inbox APIs by reusing existing truth paths**

Requirements:
- text / memory_md import creates inbox batches
- canonical JSON remains on current deterministic import/export path
- apply uses existing record commit / relation candidate / confirmed restore behavior
- `confirmed_restore` still leaves no pending duplicate

- [ ] **Step 4: Re-run the API tests**

Run: `pnpm --dir packages/server test -- review-inbox-v2.test.ts v2-api.test.ts`
Expected: PASS

### Task 4: Make Review Inbox The Dashboard Default Entry

**Files:**
- Create: `packages/dashboard/src/pages/ReviewInbox.tsx`
- Create: `packages/dashboard/src/pages/ReviewInbox.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/i18n/locales/zh.ts`
- Modify: `packages/dashboard/src/i18n/locales/en.ts`

- [ ] **Step 1: Write the failing dashboard tests**

Cover:
- `/` redirects to `/review-inbox`
- batch list and detail load
- `全部接受` and per-item edit/accept flows hit the new APIs
- summary refreshes after apply

- [ ] **Step 2: Run the targeted dashboard tests to verify they fail**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx`
Expected: FAIL because the page and API methods do not exist.

- [ ] **Step 3: Implement the new page and client endpoints**

Keep the first version simple:
- batch list
- batch detail
- accept all / reject all
- edit then accept for record items
- source summary and model suggestion display

- [ ] **Step 4: Update routing and navigation**

Make `/` redirect to `/review-inbox`, promote review inbox to the first primary nav item, and keep Import / Export plus other ops pages in the system area.

- [ ] **Step 5: Re-run the dashboard tests**

Run: `pnpm --dir packages/dashboard test -- ReviewInbox.test.tsx`
Expected: PASS

### Task 5: Integrate Import / Export With Review Inbox

**Files:**
- Modify: `packages/dashboard/src/pages/ImportExport.tsx`
- Modify: `packages/dashboard/src/pages/ImportExport.test.tsx`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/i18n/locales/zh.ts`
- Modify: `packages/dashboard/src/i18n/locales/en.ts`

- [ ] **Step 1: Write the failing Import / Export tests**

Cover:
- text / MEMORY.md can be sent to review inbox
- canonical JSON remains preview/confirm based
- success notice includes created batch summary

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `pnpm --dir packages/dashboard test -- ImportExport.test.tsx`
Expected: FAIL because no inbox handoff exists.

- [ ] **Step 3: Implement the system-page handoff**

Add a “发送到审查箱” action for `text` and `memory_md`, keep JSON on deterministic preview/confirm, and preserve current export behavior.

- [ ] **Step 4: Re-run the targeted tests**

Run: `pnpm --dir packages/dashboard test -- ImportExport.test.tsx`
Expected: PASS

### Task 6: Batch Verification

**Files:**
- Modify: any touched files from Tasks 1-5

- [ ] **Step 1: Run server tests**

Run: `pnpm --dir packages/server test`
Expected: PASS

- [ ] **Step 2: Run server lint**

Run: `pnpm --dir packages/server lint`
Expected: PASS

- [ ] **Step 3: Run server build**

Run: `pnpm --dir packages/server build`
Expected: PASS

- [ ] **Step 4: Run dashboard tests**

Run: `pnpm --dir packages/dashboard test`
Expected: PASS

- [ ] **Step 5: Run dashboard build**

Run: `pnpm --dir packages/dashboard build`
Expected: PASS

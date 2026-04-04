# Import Review Inbox Automation-First Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/v2/review-inbox/import` auto-commit shared-contract-safe import candidates and send only the uncertain remainder into the review inbox.

**Architecture:** Reuse the shared contract/disposition logic already used by `ingest()` instead of treating import preview as a separate review-only path. Preserve existing canonical import/export semantics and keep review-only kinds like `response_style` in the inbox.

**Tech Stack:** Fastify, TypeScript, Vitest, React, Vite

---

### Task 1: Lock behavior with failing tests

**Files:**
- Modify: `packages/server/tests/review-inbox-v2.test.ts`
- Modify: `packages/dashboard/src/pages/ImportExport.test.tsx`

- [ ] Add a server test where `POST /api/v2/review-inbox/import` with `后续交流中文就行` returns no review batch, auto-commits one record, and writes `请用中文回答`.
- [ ] Run the focused server test and verify it fails for the right reason.
- [ ] Add a mixed server test where safe import content auto-commits but `response_style` remains pending in a review batch.
- [ ] Run the focused server tests and verify the mixed case also fails correctly.
- [ ] Add dashboard tests for auto-commit-only and mixed notice wording.
- [ ] Run the focused dashboard tests and verify they fail correctly.

### Task 2: Reuse shared disposition for import routing

**Files:**
- Modify: `packages/server/src/v2/service.ts`
- Modify: `packages/server/src/v2/import-export.ts`
- Modify: `packages/server/src/v2/review-inbox.ts`
- Modify: `packages/server/src/api/review-inbox-v2.ts`

- [ ] Extend internal import preview detail flow so import-side logic can see origin/disposition information instead of only flattened preview payloads.
- [ ] Factor a shared helper that classifies import candidate details using the same contract gate as `ingest()`.
- [ ] Update `createImportBatch()` to auto-commit safe record candidates through the existing write path and keep only reviewable record/relation items.
- [ ] Return batch metadata that supports three outcomes: auto-commit only, mixed auto-commit plus review batch, and review-only.
- [ ] Run focused server tests until they pass.

### Task 3: Sync Import/Export notices

**Files:**
- Modify: `packages/dashboard/src/pages/ImportExport.tsx`
- Modify: `packages/dashboard/src/i18n/locales/zh.ts`
- Modify: `packages/dashboard/src/i18n/locales/en.ts`

- [ ] Adjust the review-inbox import success notice for auto-commit-only and mixed outcomes.
- [ ] Keep the existing “open batch” action only when a batch remains.
- [ ] Run the focused dashboard tests until they pass.

### Task 4: Batch verification

**Files:**
- Verify only

- [ ] Run `pnpm --dir packages/server test`
- [ ] Run `pnpm --dir packages/server lint`
- [ ] Run `pnpm --dir packages/server build`
- [ ] Run `pnpm --dir packages/dashboard test`
- [ ] Run `pnpm --dir packages/dashboard build`

# Ingress Stability Smoke Gate Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ingress smoke gate diagnosable and less prone to false negatives from opaque network failures, without weakening the real release checks for non-idempotent writes.

**Architecture:** Keep the product surface unchanged. Add request trace metadata to observed V2/MCP routes, then refactor the smoke gate into a small reusable helper that adds per-step labels, safe-read retry policy, request-id capture, and best-effort cleanup reporting.

**Tech Stack:** Fastify, Vitest, Node ESM scripts, existing V2 observability wrapper.

---

### Task 1: Add observed-route trace metadata

**Files:**
- Modify: `packages/server/src/api/observability.ts`
- Modify: `packages/server/tests/v2-api.test.ts`

- [ ] **Step 1: Write the failing API test**

Add a test to `packages/server/tests/v2-api.test.ts` that calls `GET /api/v2/health` with `x-cortex-smoke-run`, then asserts:
- response status is `200`
- response header `x-cortex-request-id` exists
- response header `x-cortex-smoke-run` echoes the inbound smoke-run value

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `pnpm --dir packages/server test -- tests/v2-api.test.ts`

Expected: the new header assertions fail because the headers are not emitted yet.

- [ ] **Step 3: Implement trace header emission**

Update `packages/server/src/api/observability.ts` to:
- extract `req.id`
- extract optional `x-cortex-smoke-run`
- set `x-cortex-request-id` on observed responses
- echo `x-cortex-smoke-run` when present
- include `request_id` and `smoke_run_id` in success/failure logs

- [ ] **Step 4: Re-run the targeted API test**

Run: `pnpm --dir packages/server test -- tests/v2-api.test.ts`

Expected: PASS

### Task 2: Refactor smoke request handling into a tested helper

**Files:**
- Create: `scripts/smoke-v2-lib.mjs`
- Modify: `scripts/smoke-v2.mjs`
- Create: `packages/server/tests/smoke-v2-lib.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Add `packages/server/tests/smoke-v2-lib.test.ts` covering:
- retryable safe read retries one transient `fetch failed`
- non-retryable write fails immediately with a detailed message containing label/method/path
- best-effort cleanup runner records warnings and continues later cleanup steps

- [ ] **Step 2: Run the helper test to verify it fails**

Run: `pnpm --dir packages/server test -- tests/smoke-v2-lib.test.ts`

Expected: FAIL because `scripts/smoke-v2-lib.mjs` does not exist yet.

- [ ] **Step 3: Implement the minimal smoke helper**

Create `scripts/smoke-v2-lib.mjs` with focused exports for:
- per-request execution with step label
- optional one-retry policy for safe reads / import preview
- detailed network failure formatting including `cause.code` when available
- response header capture for `x-cortex-request-id`
- best-effort cleanup step runner that collects warnings instead of throwing

- [ ] **Step 4: Rewire the smoke script**

Update `scripts/smoke-v2.mjs` to:
- use the helper for all requests
- attach a per-round smoke-run id header
- keep non-idempotent writes single-shot
- treat cleanup failures as warnings in the final report instead of aborting the whole smoke run
- print the failing step label and request id when a request fails

- [ ] **Step 5: Re-run the helper tests**

Run: `pnpm --dir packages/server test -- tests/smoke-v2-lib.test.ts`

Expected: PASS

### Task 3: Verify the batch end-to-end

**Files:**
- Verify only

- [ ] **Step 1: Run focused server regression**

Run: `pnpm --dir packages/server test -- tests/v2-api.test.ts tests/import-export-v2.test.ts tests/smoke-v2-lib.test.ts`

Expected: PASS

- [ ] **Step 2: Run full server lint**

Run: `pnpm --dir packages/server lint`

Expected: PASS

- [ ] **Step 3: Run dashboard regression**

Run: `pnpm --dir packages/dashboard test`

Expected: PASS

- [ ] **Step 4: Run dashboard build**

Run: `pnpm --dir packages/dashboard build`

Expected: PASS

- [ ] **Step 5: Run the smoke gate locally against the deployed URL**

Run: `CORTEX_BASE_URL=<deployed-url> CORTEX_AUTH_TOKEN=<token> SMOKE_ROUNDS=3 node scripts/smoke-v2.mjs`

Expected:
- successful rounds still pass unchanged
- if ingress flakes, the error names the exact step and path
- cleanup warnings do not erase an otherwise successful main-path run

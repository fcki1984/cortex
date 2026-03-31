# Ingress Stability Observability Batch Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ingress-side transport timeouts diagnosable and keep the release gate focused on actionable evidence instead of ambiguous smoke failures.

**Architecture:** Keep the product surface unchanged. Strengthen the server's route-level observability for the critical read/write paths, then tighten smoke output so failures clearly separate "request never reached Node" from "request reached Node and failed inside the app". Finish by documenting the release decision path so deployment-side debugging does not get mixed back into feature work.

**Tech Stack:** Fastify, TypeScript, Vitest, existing `observedRoute` wrapper, Node smoke scripts.

## Fixed Batch Boundaries

- No new public API.
- No new Dashboard workflow or navigation changes.
- No retry expansion for non-idempotent writes.
- Deployment-layer instability stays classified as a release blocker; it is not prompt-contract work and should not be refiled into product behavior batches.

## Triage Rule

- If a failing request has no matching Node route-entry log, classify it first as proxy / ingress / network transport instability.
- If a failing request has a route-entry log but the completion / failure log stalls or arrives late, classify it first as app-side latency, upstream dependency delay, or container resource pressure.
- Minimum evidence to collect for each release-blocking timeout:
  - the failing smoke output line
  - proxy / ingress logs
  - app logs correlated by `request_id`

---

### Task 1: Expand Critical Route Observability

**Files:**
- Modify: `packages/server/src/api/observability.ts`
- Modify: `packages/server/src/api/records-v2.ts`
- Modify: `packages/server/src/api/mcp.ts`
- Test: `packages/server/tests/v2-api.test.ts`

- [ ] **Step 1: Write the failing route-entry observability tests**

Add or extend tests so they prove:
- critical routes emit the request id header
- route wrappers are used on `POST /api/v2/records`
- route wrappers are used on `GET /mcp`
- route wrappers are used on `GET /mcp/tools`

Run: `pnpm --dir packages/server test -- --run packages/server/tests/v2-api.test.ts`
Expected: FAIL on the new coverage before implementation.

- [ ] **Step 2: Add entry-stage logging to `observedRoute()`**

Update `packages/server/src/api/observability.ts` so the wrapper logs an "entered" event before handler execution with:
- `route`
- `method`
- `agent_id`
- `request_id`
- `smoke_run_id`
- `timeout_ms`

Keep completion and failure logs intact. Do not change public response shapes.

- [ ] **Step 3: Wrap the remaining critical routes**

Apply `observedRoute()` to:
- `POST /api/v2/records`
- `GET /mcp`
- `GET /mcp/tools`

Keep existing route behavior unchanged apart from trace headers / logs / metrics.

- [ ] **Step 4: Re-run the focused server tests**

Run: `pnpm --dir packages/server test -- --run packages/server/tests/v2-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/observability.ts packages/server/src/api/records-v2.ts packages/server/src/api/mcp.ts packages/server/tests/v2-api.test.ts
git commit -m "feat: expand ingress route observability"
```

### Task 2: Tighten Smoke Failure Evidence

**Files:**
- Modify: `scripts/smoke-v2-lib.mjs`
- Modify: `scripts/smoke-v2.mjs`
- Test: `packages/server/tests/smoke-v2-lib.test.ts`
- Test: `packages/server/tests/platform-surface.test.ts`

- [ ] **Step 1: Write the failing smoke evidence tests**

Add tests that lock:
- transport timeout failures preserve route/method/path/attempt metadata
- write-path timeouts are classified distinctly from read-path timeouts
- the smoke script source contains the new evidence logging branch

Run: `pnpm --dir packages/server test -- --run packages/server/tests/smoke-v2-lib.test.ts packages/server/tests/platform-surface.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 2: Extend `runSmokeRequest()` metadata**

Enhance the thrown smoke errors so they include:
- `smokeClass`
- `smokePhase`
- `attemptsUsed`
- `method`
- `path`
- `label`
- `operationKind` (`read` or `write`)

Do not add automatic retries for non-idempotent writes.

- [ ] **Step 3: Improve top-level smoke output**

Update `scripts/smoke-v2.mjs` so a failure prints:
- failure class
- route and method
- operation kind
- attempts used
- whether it failed during entry or cleanup

Keep the current three-round gate and cleanup semantics.

- [ ] **Step 4: Re-run the focused smoke tests**

Run: `pnpm --dir packages/server test -- --run packages/server/tests/smoke-v2-lib.test.ts packages/server/tests/platform-surface.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-v2-lib.mjs scripts/smoke-v2.mjs packages/server/tests/smoke-v2-lib.test.ts packages/server/tests/platform-surface.test.ts
git commit -m "feat: enrich smoke timeout evidence"
```

### Task 3: Lock the Release Decision Path

**Files:**
- Modify: `RELEASE_TEST_PLAN.md`
- Modify: `docs/superpowers/plans/2026-03-31-ingress-stability-observability-batch.md`

- [ ] **Step 1: Document the deployment-side triage**

Update `RELEASE_TEST_PLAN.md` so transport timeout failures are explicitly triaged as:
- likely proxy / ingress issue if the request never reaches Node
- likely app-side latency issue if entry logs exist but completion/failure logs are delayed

Document the minimum artifacts to collect:
- proxy / ingress logs
- app request id logs
- failing smoke output line

- [ ] **Step 2: Keep the batch scope clear**

Make sure the plan and release doc both state:
- no new public API
- no new Dashboard workflow
- no retry expansion for writes
- deployment-layer instability is a release blocker, not a prompt-contract task

- [ ] **Step 3: Commit**

```bash
git add RELEASE_TEST_PLAN.md docs/superpowers/plans/2026-03-31-ingress-stability-observability-batch.md
git commit -m "docs: codify ingress timeout triage"
```

### Task 4: Batch Verification

**Files:**
- Verify only

- [ ] **Step 1: Run server tests**

Run: `pnpm --dir packages/server test`
Expected: PASS.

- [ ] **Step 2: Run server lint**

Run: `pnpm --dir packages/server lint`
Expected: PASS.

- [ ] **Step 3: Run dashboard tests**

Run: `pnpm --dir packages/dashboard test`
Expected: PASS.

- [ ] **Step 4: Run dashboard build**

Run: `pnpm --dir packages/dashboard build`
Expected: PASS.

- [ ] **Step 5: Run the smoke gate**

Run: `SMOKE_ROUNDS=3 node scripts/smoke-v2.mjs`
Expected: local or deployment-target smoke output includes the richer failure evidence; if all three rounds pass, record that explicitly.

- [ ] **Step 6: Prepare deployment handoff**

Summarize:
- which critical routes now emit entry/completion/failure evidence
- whether smoke passes or which exact timeout class remains
- whether the next action belongs to repo code or deployment config

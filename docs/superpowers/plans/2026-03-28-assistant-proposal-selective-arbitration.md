# Assistant Proposal Selective Arbitration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow short user follow-ups to selectively keep or drop durable winners from a prior assistant proposal without widening the public contract surface.

**Architecture:** Keep the existing `assistant proposal -> short confirmation/rewrite/rejection` path in `packages/server/src/v2/service.ts`, and add one narrow arbitration helper that only operates on already-deterministic proposal winners. Preserve the current precision-first rule: if a short follow-up cannot be mapped to existing winners conservatively, it still lands as `session_note`.

**Tech Stack:** TypeScript, Vitest, existing Cortex V2 contract / normalize / ingest pipeline.

---

### Task 1: Define selective keep/drop behavior with red tests

**Files:**
- Modify: `packages/server/tests/import-export-v2.test.ts`
- Modify: `packages/server/tests/v2-api.test.ts`

- [ ] **Step 1: Write the failing service-level tests**

Add focused tests for these cases:

```ts
it('keeps only language_preference when a short follow-up drops the response_length part of a prior proposal', async () => {
  // assistant: "之后请始终用中文回答，并把回答控制在三句话内。"
  // user: "就中文，别加三句话限制"
  // expect one profile_rule(language_preference)
});

it('keeps only response_length when a short follow-up keeps the length constraint from a prior proposal', async () => {
  // assistant: "之后请始终用中文回答，并把回答控制在三句话内。"
  // user: "只保留三句话限制"
  // expect one profile_rule(response_length)
});

it('keeps a short selective follow-up as session_note when it drops every stable winner', async () => {
  // assistant: "之后请始终用中文回答，并把回答控制在三句话内。"
  // user: "都不要"
  // expect one session_note
});
```

- [ ] **Step 2: Write the failing API-level parity test**

Run the same positive path through `/api/v2/ingest`:

```ts
it('commits only the selected durable winner when a short follow-up keeps one part of a prior assistant proposal', async () => {
  // expect body.records to contain exactly one profile_rule(language_preference)
});
```

- [ ] **Step 3: Run the targeted tests to verify RED**

Run:

```bash
pnpm --dir packages/server test -- --run packages/server/tests/import-export-v2.test.ts -t "keeps only language_preference|keeps only response_length|drops every stable winner"
pnpm --dir packages/server test -- --run packages/server/tests/v2-api.test.ts -t "commits only the selected durable winner"
```

Expected: FAIL because selective keep/drop is not implemented yet.

### Task 2: Implement the minimal selective arbitration helper

**Files:**
- Modify: `packages/server/src/v2/contract.ts`
- Modify: `packages/server/src/v2/service.ts`

- [ ] **Step 1: Add narrow short-follow-up parsing helpers in `contract.ts`**

Add conservative helpers for:
- detecting “keep only X” intent
- detecting “drop X” intent
- mapping short follow-up text only to already-supported proposal winner keys

Keep the parsing scope limited to:
- `language_preference`
- `response_length`
- existing short rejection keywords

- [ ] **Step 2: Implement a proposal-winner arbitration helper in `service.ts`**

Build a helper that:
- takes the previously extracted deterministic proposal winners
- applies keep/drop directives conservatively
- returns:
  - one durable winner when exactly one survives
  - `null` when the follow-up cannot be resolved safely
  - an explicit “drop all” signal that falls back to `session_note`

- [ ] **Step 3: Wire the helper into the existing assistant proposal branch**

In `ingest()`:
- run selective arbitration after the current explicit rewrite attempt
- prefer selective arbitration only when it maps to existing proposal winners
- keep evidence handling unchanged
- preserve the current short confirmation / rewrite / rejection semantics

- [ ] **Step 4: Run the targeted tests to verify GREEN**

Run:

```bash
pnpm --dir packages/server test -- --run packages/server/tests/import-export-v2.test.ts -t "keeps only language_preference|keeps only response_length|drops every stable winner"
pnpm --dir packages/server test -- --run packages/server/tests/v2-api.test.ts -t "commits only the selected durable winner"
```

Expected: PASS.

### Task 3: Regression and batch verification

**Files:**
- Modify: `packages/server/tests/import-export-v2.test.ts`
- Modify: `packages/server/tests/v2-api.test.ts`

- [ ] **Step 1: Re-run the existing short confirmation/rewrite/rejection tests**

Run:

```bash
pnpm --dir packages/server test -- --run packages/server/tests/import-export-v2.test.ts -t "short user confirmation|short user rewrite"
pnpm --dir packages/server test -- --run packages/server/tests/v2-api.test.ts -t "user_confirmed durable|short user rewrite"
```

Expected: PASS.

- [ ] **Step 2: Run the full local server and dashboard gate**

Run:

```bash
pnpm --dir packages/server lint
pnpm --dir packages/server build
pnpm --dir packages/server test
pnpm --dir packages/dashboard test
pnpm --dir packages/dashboard build
```

Expected: PASS. Non-blocking dashboard chunk-size warning may remain.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-03-28-assistant-proposal-selective-arbitration.md packages/server/src/v2/contract.ts packages/server/src/v2/service.ts packages/server/tests/import-export-v2.test.ts packages/server/tests/v2-api.test.ts
git commit -m "feat: support selective arbitration for short assistant follow-ups"
```

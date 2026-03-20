# Cortex V2 RC Freeze Decision

Date: 2026-03-20
Branch: `codex/cortex-v2`
Baseline: `137d86a`

## Summary

This document records the release decision after the V2 audit and the latest production-style validation.

Current conclusion:

- Cortex V2 core is now in **release-candidate freeze**.
- OpenClaw is **not** treated as a code-level blocker for Cortex core release anymore.
- OpenClaw remains a **separate host-side signoff item** that must be validated on a Windows host before it is advertised as part of the production launch story.

Why:

- The remaining OpenClaw failures observed in WSL are now attributed to host/runtime network conditions between WSL and the model endpoint, not to a Cortex V2 architecture defect.
- Cortex core already owns the production surface:
  - `/api/v2/*`
  - `/mcp`
  - V2 records / recall / relations / lifecycle / feedback
  - V2-only Dashboard
  - zero public `/api/v1/*`

## Release Decision

### Cortex Core

From this point onward:

- no new schema work
- no new public APIs
- no new Dashboard product pages
- no new recall enhancements
- no new bridge features

Allowed changes:

- production-blocking Cortex fixes
- release process / regression / documentation cleanup

### OpenClaw

OpenClaw is moved out of the Cortex code-critical path.

Release policy:

- Cortex core may ship once the core release gate passes
- OpenClaw is signed off separately on a Windows host
- WSL remains a debugging environment only, not the final acceptance environment

If OpenClaw host-side validation fails:

- OpenClaw is marked as "not signed off for first production launch"
- Cortex core release is not blocked by that alone

## Mandatory Core Release Gate

Before Cortex core is released:

1. fresh DB core regression passes
2. small real-data sample passes
3. `/api/v1/*` remains fully retired
4. `/api/v2/config` remains sanitized and respects read-only boundaries
5. probe cleanup returns the system to a clean state

The core release gate does **not** require WSL OpenClaw parity.

## Separate OpenClaw Signoff

The only supported final validation surface for OpenClaw is the Windows host runtime:

- `http://localhost:18790/chat?session=main`
- `/cortex_status`
- `/cortex_remember`
- `/cortex_search`
- `/cortex_recent`
- one real `before_agent_start` recall
- one real `agent_end` ingest

This signoff remains important, but it is tracked separately from Cortex core release readiness.

## Post-Release Priorities

After Cortex V2 core ships:

1. `Import/Export v2`
2. prompt contract hardening for write normalization and relation candidates
3. documentation pages:
   - terminology
   - architecture
   - parameter guide
   - release notes

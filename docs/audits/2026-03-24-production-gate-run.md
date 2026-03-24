# Cortex V2 Production Gate Run

Date: 2026-03-24
Branch: `codex/cortex-v2`
Baseline: `7565e9f`
Verdict: `NO-GO`

## Summary

This document records the production-gate run attempted after syncing the current
`codex/cortex-v2` baseline.

Result:

- Cortex V2 core was **not** promoted to `1.0.0`.
- No version bump, tag, release artifact publication, or GitHub Release creation
  was performed.
- The gate was blocked by **deployment ingress failure**, not by a newly
  identified Cortex V2 code regression.

## Evidence

### Shell-side smoke run

Command:

```bash
CORTEX_BASE_URL=https://mem.dctma.vip \
CORTEX_AUTH_TOKEN=*** \
CORTEX_AGENT_ID=rc-gate-smoke-20260324 \
pnpm --dir /root/cortex-v2 smoke:v2
```

Observed result:

- `GET /api/v2/stats` failed immediately
- smoke output reported: `GET /api/v2/stats returned 502`

### Direct ingress probes

The following requests all returned nginx `502 Bad Gateway`:

- `GET /`
- `GET /api/v2/health`
- `GET /api/v2/stats`

This indicates a site-wide ingress or upstream availability problem, not a
single Cortex feature failure.

## Gate status

### Not signed off in this run

- full Cortex core release gate
- fresh DB regression completion
- browser-side production validation
- final probe cleanup verification
- version bump to `1.0.0`
- Docker tag/release publication

### No new code regression identified

This run does **not** introduce evidence of a new Cortex V2 architecture or API
regression. The blocker is environmental availability at the deployed ingress.

## Release decision

Do not promote the RC baseline to a production version until:

1. `mem.dctma.vip` no longer returns `502` at the ingress
2. the full Cortex core release gate completes successfully
3. post-test cleanup is verified on a clean stats baseline

## Next action

Once ingress is restored:

1. rerun the full production gate from `7565e9f`
2. if the gate passes, bump to `1.0.0`
3. create tag `v1.0.0`
4. trigger Docker publish
5. create the formal GitHub Release

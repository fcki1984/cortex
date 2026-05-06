# Changelog

## 2.0.0 - Cortex V2.0 Product Release

- Promoted Review Inbox to the default product entry at `/review-inbox`.
- Added automation-first memory routing with conservative auto-commit, review inbox fallback, and retain mission filtering.
- Added the Dashboard Quality Center at `/quality` for probe-agent recall quality checks.
- Added V2 recall quality release gates via `recall-eval:v2` and `release:gate:v2`.
- Unified health and MCP version reporting with the package version.
- Kept OpenClaw validation as an independent host-side signoff item outside the Cortex core release gate.

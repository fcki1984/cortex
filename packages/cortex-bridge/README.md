# @cortexmem/openclaw

Bridge plugin that connects [OpenClaw](https://github.com/openclaw) agents to [Cortex](https://github.com/fcki1984/cortex) memory service.

Uses OpenClaw's standard `register(api)` plugin interface.

## Install

```bash
openclaw plugins install @cortexmem/openclaw
```

## Configure

Plugin config via OpenClaw settings or environment variables:

| Config Key | Env Variable | Default | Description |
|------------|-------------|---------|-------------|
| `cortexUrl` | `CORTEX_URL` | `http://localhost:21100` | Cortex server URL |
| `agentId` | — | `openclaw` | Agent identifier for memory isolation |
| `debug` | `CORTEX_DEBUG` | `false` | Enable debug logging |

## Windows host-side runtime validation

Before treating OpenClaw integration as release-ready, validate it from the Windows host that actually runs OpenClaw rather than from WSL.

Open this page in the Windows browser:

`http://localhost:18790/chat?session=main`

Then complete this minimum gate:

1. Run `/cortex_status` and confirm Cortex is shown as online.
2. Run `/cortex_remember 请用中文回答`.
3. Run `/cortex_search What language should the assistant use?` and confirm the remembered rule is recalled.
4. Run `/cortex_recent` and confirm the remembered item is visible.
5. Complete one real conversation round-trip:
   - first turn writes a memorable fact
   - second turn verifies `before_agent_start` recall
   - conversation end verifies `agent_end` ingest

If any of those steps fail on the Windows host, treat the bridge as a release blocker even if WSL-side smoke checks pass.

## Tools

These tools are always available and work reliably:

| Tool | Description |
|------|-------------|
| `cortex_recall` | Search long-term memory for relevant past conversations, facts, and preferences |
| `cortex_remember` | Store a V2 record request. Clear facts, preferences, constraints, and task state become durable records; ambiguous input is downgraded to `session_note`. |
| `cortex_ingest` | Send a conversation pair for automatic LLM memory extraction |
| `cortex_health` | Check if the Cortex memory server is reachable (optional) |

### Slash Command

- `/cortex_status` — Quick check if Cortex server is online
- `/cortex_search` — Search recalled memories for the current agent
- `/cortex_remember` — Store a memory request using V2 semantics
- `/cortex_recent` — Show recent records for the current agent

## Hooks

The plugin registers lifecycle hooks for automatic memory management:

| Hook | Status | Description |
|------|--------|-------------|
| `before_agent_start` | **Working** | Recalls relevant memories and injects as context before each response |
| `agent_end` | **Best-effort** | Auto-ingests meaningful user/assistant turns when the host runtime dispatches the hook |
| `before_compaction` | Best-effort | Emergency flush before context compression |

## Known Issues

### `agent_end` hook can still be skipped by the host runtime

**Status:** Upstream bug — [openclaw/openclaw#21863](https://github.com/openclaw/openclaw/issues/21863)

In streaming mode (used by Telegram and other gateway channels), the `agent_end` hook is not dispatched to plugins. The `handleAgentEnd()` function in OpenClaw's streaming event handler does not call `hookRunner.runAgentEnd()`.

This means automatic conversation ingestion may be skipped in some host/runtime combinations even though memory recall (`before_agent_start`) works correctly.

**Workarounds:**

1. **Use `cortex_ingest` tool** — Instruct your Agent (via system prompt) to call `cortex_ingest` after meaningful conversations. Example system prompt addition:
   ```
   After each conversation, use the cortex_ingest tool to save the exchange
   for long-term memory. Pass the user's message and your response.
   ```

2. **Use non-streaming mode** — If your setup supports it, use a non-streaming channel where `agent_end` fires correctly.

3. **Use `cortex_remember` tool** — For specific facts or preferences, the Agent can call `cortex_remember` directly during conversation.

## License

MIT

# 🧠 Cortex — Give Your AI a Real Memory

**English** | [中文](./README.zh-CN.md)

Your AI forgets everything the moment a conversation ends. Ask it tomorrow what you told it today — blank stare.

**Cortex fixes this.** It's a memory service that runs alongside any AI agent, silently learning who you are, what you care about, and how you work. It remembers your name, your preferences, your decisions, your projects — and recalls exactly the right context when you need it.

> Think of it as upgrading your AI from a goldfish to a real assistant.

```
"My name is Alex, I'm a backend dev, I prefer Rust over Go."
                    ↓  Cortex extracts & stores
          [identity] Alex, backend developer
          [preference] Prefers Rust over Go

    ... 3 weeks later, new conversation ...

"What language should I use for this new service?"
                    ↓  Cortex recalls
    "You've mentioned preferring Rust over Go for backend work."
```

---

## How It Works

```
┌────────────────────────────────────────────────────────────┐
│                    WRITE PATH (every turn)                  │
│                                                            │
│  Conversation ──→ Fast Channel (regex, 0ms)                │
│                   + Deep Channel (LLM, 2-5s)               │
│                          ↓                                 │
│                  Extracted memories                         │
│                          ↓                                 │
│              ┌─ 4-tier dedup ──────────────┐               │
│              │ exact dup → skip            │               │
│              │ near-exact → auto-replace   │               │
│              │ semantic overlap → LLM judge│               │
│              │ new info → insert           │               │
│              └────────────────────────────┘               │
│                          ↓                                 │
│              Working (48h) or Core (permanent)             │
├────────────────────────────────────────────────────────────┤
│                    READ PATH (every turn)                   │
│                                                            │
│  User message ──→ Query Expansion (optional)               │
│                          ↓                                 │
│              BM25 + Vector → RRF Fusion                    │
│                          ↓                                 │
│              LLM Reranker (optional)                       │
│                          ↓                                 │
│              Priority inject → AI context                  │
│              (constraints & persona first)                  │
├────────────────────────────────────────────────────────────┤
│                    LIFECYCLE (daily)                        │
│                                                            │
│  Working → promote → Core → decay → Archive → compress     │
│                                      ↓                     │
│                              back to Core (nothing lost)   │
└────────────────────────────────────────────────────────────┘
```

---

## Features

- **Three-layer memory** — Working (48h) → Core (permanent) → Archive (compressed back to Core)
- **Dual-channel extraction** — Fast regex + deep LLM, with batch smart dedup
- **20 memory categories** — Identity, preferences, constraints, agent persona, and more
- **Hybrid search** — BM25 + vector with Reciprocal Rank Fusion
- **Query expansion** — LLM-generated search variants for better recall
- **LLM reranker** — Re-score results for improved relevance
- **Entity relations** — Auto-extracted knowledge graph
- **Extraction feedback** — Rate memories good/bad/corrected, track quality
- **Multi-provider** — OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, Ollama
- **Multi-agent** — Per-agent config, isolated memory namespaces
- **Dashboard** — Full management UI with search debug, lifecycle preview, extraction logs
- **~$0.55/month** — With gpt-4o-mini + text-embedding-3-small at 50 conversations/day

---

## 30-Second Setup

```bash
# Clone and start (Docker)
git clone https://github.com/rikouu/cortex.git
cd cortex
docker compose up -d
```

Open **http://localhost:21100** → Dashboard → **Settings** → choose your LLM/Embedding provider and enter your API key.

That's it. No `.env` files, no environment variables.

<details>
<summary>Or run from source (without Docker)</summary>

```bash
git clone https://github.com/rikouu/cortex.git
cd cortex && pnpm install
pnpm dev    # http://localhost:21100
```

</details>

---

## Connect Your AI

### Option A: OpenClaw 🔥

[OpenClaw](https://github.com/openclaw/openclaw) is an open-source AI agent framework with built-in tool use, memory, and multi-channel support. Cortex has a dedicated bridge plugin for seamless integration.

```bash
# 1. Install the bridge plugin
openclaw plugins install @cortexmem/openclaw

# 2. Set Cortex URL (pick one)
echo 'CORTEX_URL=http://localhost:21100' >> .env
# or: openclaw env set CORTEX_URL http://localhost:21100
```

**Done.** Your agent now automatically recalls memories before every response and saves important facts after each conversation turn.

The bridge hooks into OpenClaw's lifecycle:

| Hook | When | What |
|------|------|------|
| `onBeforeResponse` | Before AI responds | Recalls & injects relevant memories |
| `onAfterResponse` | After AI responds | Extracts & saves key info |
| `onBeforeCompaction` | Before context compression | Emergency saves before info is lost |

Plus `cortex_recall` and `cortex_remember` tools for on-demand use.

See the full guide: **[OpenClaw Quick Start](#openclaw-quick-start)**.

### Option B: Claude Desktop (MCP)

Open **Settings** → **Developer** → **Edit Config**, paste and restart:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp", "--server-url", "http://localhost:21100"]
    }
  }
}
```

### Option C: Cursor / Claude Code / Other MCP Clients

<details>
<summary>Cursor</summary>

**Settings** → **MCP** → **+ Add new global MCP server**:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp"],
      "env": { "CORTEX_URL": "http://localhost:21100" }
    }
  }
}
```

</details>

<details>
<summary>Claude Code</summary>

```bash
claude mcp add cortex -- npx @cortexmem/mcp --server-url http://localhost:21100
```

</details>

<details>
<summary>Windsurf / Cline / Other</summary>

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp", "--server-url", "http://localhost:21100"],
      "env": { "CORTEX_AGENT_ID": "default" }
    }
  }
}
```

</details>

### Option D: Any App (REST API)

```bash
# Store a memory
curl -X POST http://localhost:21100/api/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{"user_message":"I love sushi","assistant_message":"Got it!","agent_id":"default"}'

# Recall memories
curl -X POST http://localhost:21100/api/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"What food do I like?","agent_id":"default"}'
```

### Verify It Works

Tell your AI something memorable (e.g., *"My favorite color is blue"*). Start a **new conversation** and ask *"What's my favorite color?"*. If it answers correctly, Cortex is working.

---

## OpenClaw Quick Start

A complete beginner-friendly guide for adding persistent memory to your OpenClaw agent.

### What You'll Get

After following these steps, your OpenClaw agent will:
- Automatically **recall** relevant memories before every response
- Automatically **save** important facts from conversations
- **Emergency save** key info before context compression
- Have `cortex_recall` and `cortex_remember` tools available for on-demand use

### Step 1: Start Cortex

If you haven't already, get Cortex running first:

```bash
# Option A: From source
git clone https://github.com/rikouu/cortex.git
cd cortex && pnpm install
cp .env.example .env     # add your OPENAI_API_KEY
pnpm dev

# Option B: Docker (one line)
OPENAI_API_KEY=sk-xxx docker compose up -d
```

Verify it's running:
```bash
curl http://localhost:21100/api/v1/health
# Should return: {"status":"ok", ...}
```

### Step 2: Install the Plugin

```bash
openclaw plugins install @cortexmem/openclaw
```

That's it — no config files, no manual setup.

### Step 3: Tell the Plugin Where Cortex Is

Pick **one** of the two methods:

**Method A — `.env` file (recommended)**

Add this line to your project's `.env` file:

```
CORTEX_URL=http://localhost:21100
```

**Method B — Shell profile**

```bash
echo 'export CORTEX_URL=http://localhost:21100' >> ~/.zshrc
source ~/.zshrc
```

### Step 4: Test It

1. Start a conversation with your agent and say something memorable:
   > *"My favorite programming language is Rust and I work at Acme Corp."*

2. Start a **new conversation** and ask:
   > *"What do you know about me?"*

3. If the agent mentions Rust and Acme Corp, everything is working!

You can also type `/cortex-status` in OpenClaw to check the connection.

### What Happens Under the Hood

The plugin uses OpenClaw's `register(api)` interface to automatically set up:

| Hook | When | What it does |
|------|------|-------------|
| `onBeforeResponse` | Before AI responds | Recalls relevant memories and injects them as context |
| `onAfterResponse` | After AI responds | Extracts and saves important information (fire-and-forget) |
| `onBeforeCompaction` | Before context compression | Emergency saves key info before it's lost |

Two tools are also registered:

| Tool | What it does |
|------|-------------|
| `cortex_recall` | Agent can search memories on demand |
| `cortex_remember` | Agent can store important facts explicitly |

### Deploying for Production

For a persistent setup (server + OpenClaw agent always running):

```bash
# 1. Run Cortex with Docker (auto-restarts, data persisted)
OPENAI_API_KEY=sk-xxx docker compose up -d

# 2. Optional: set auth token for security
echo 'CORTEX_AUTH_TOKEN=your-secret-token' >> .env
docker compose up -d  # restart to apply

# 3. In your OpenClaw project, set the URL
echo 'CORTEX_URL=http://your-server-ip:21100' >> .env
```

> **Tip:** If running Cortex and OpenClaw on the same machine, use `http://localhost:21100`. If on different machines, replace with your server's IP or domain.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Agent doesn't recall memories | Check `curl http://localhost:21100/api/v1/health` returns OK |
| Plugin not loading | Run `openclaw plugins list` to verify `@cortexmem/openclaw` is installed |
| Memories not saving after responses | Known upstream issue in streaming mode — see [Known Issues](#known-issues) |
| Connection refused | Make sure `CORTEX_URL` is set and Cortex is running |

---

## Architecture

```
┌─ Client Layer ─────────────────────────────────────────┐
│  OpenClaw (Bridge) │ Claude Desktop (MCP) │ Any (REST)  │
└────────────────────┼──────────────────────┼─────────────┘
                     ▼                      ▼
┌─ Cortex Server (:21100) ───────────────────────────────┐
│  REST API │ MCP Server │ Dashboard                      │
│  Memory Gate (recall) │ Memory Sieve (ingest)           │
│  Memory Flush+ │ Lifecycle Engine                       │
│  SQLite + FTS5 │ Vector Backend │ Markdown Exporter     │
└─────────────────────────────────────────────────────────┘
```

### Search (Recall Pipeline)

The complete recall flow when your AI receives a message:

```
User message
     │
     ▼
Clean query (strip system tags, metadata)
     │
     ▼
Small-talk detection ──yes──→ Skip (no search)
     │no
     ▼
┌─ Query Expansion (1 LLM call) ──────────────┐
│  "how was server deployed"                    │
│   → variant 1: "server deployment steps"      │
│   → variant 2: "backend setup and config"     │
└──────────────────────────────────────────────┘
     │
     ▼  Each variant searched independently (no LLM)
┌──────────┐    ┌──────────────┐
│ BM25 FTS │    │ Vector embed │
│ keywords │    │  semantics   │
└────┬─────┘    └──────┬───────┘
     └──── RRF Fusion ─┘
     layer weight × recency × access freq = finalScore
     │
     ▼
┌─ Merge & Deduplicate ───────────────────────┐
│  Same memory from multiple variants:         │
│   → keep highest finalScore as base          │
│   → multi-hit boost: +8% × ln(hits)         │
│     2 hits +5.5% / 3 hits +8.8%             │
│  Result: union of all variants (~30+ items)  │
└──────────────────────────────────────────────┘
     │
     ▼
┌─ LLM Reranker (1 LLM call) ────────────────┐
│  All merged results → LLM scores 0-1        │
│  Final = rerankerScore × w                   │
│        + originalScore × (1-w)               │
│  w = 0.5 default, adjustable in Dashboard   │
│  Output: top 15 results                      │
└──────────────────────────────────────────────┘
     │
     ▼
Priority inject: constraint/persona first
→ fill remaining budget → inject into AI context

Total: 2 LLM calls, ~5-7s latency
```

**Query Expansion** (optional): The LLM generates 2-3 variant queries using synonyms and rephrasings. Each variant is searched separately, expanding the candidate pool. Memories hit by multiple variants receive a logarithmic boost (diminishing returns). Enable in Dashboard → Gate → Query Expansion.

**LLM Reranker** (optional): After merging all variant results, the LLM re-scores them for query-specific relevance. The final score fuses the reranker score with the original score using a configurable weight (default 50:50), preserving signals like layer priority, recency, and access frequency. Supports `llm` (extraction model) and `cohere` (Cohere Rerank API). Enable in Dashboard → Search → Reranker.

**Priority injection**: When formatting results for context injection, `constraint` and `agent_persona` memories are injected first to ensure critical rules and persona are never truncated by the token budget.

### MCP Tools

When connected via MCP, the AI automatically gets these tools:

| Tool | What it does |
|------|-------------|
| `cortex_recall` | Search memories with priority injection (constraints and persona first) |
| `cortex_remember` | Store a memory: user facts, constraints, policies, or agent self-observations |
| `cortex_forget` | Remove or correct a memory |
| `cortex_search_debug` | Debug search scoring details |
| `cortex_stats` | Get memory statistics |

---

## Supported Providers

### LLM Providers

| Provider | Models | Notes |
|----------|--------|-------|
| **OpenAI** | gpt-4o-mini, gpt-4.1-nano/mini, gpt-4o, o3/o4-mini | Default. Best cost-performance ratio |
| **Anthropic** | claude-haiku-4-5, claude-sonnet-4-5, claude-opus-4-5 | Highest extraction quality |
| **Google Gemini** | gemini-2.5-flash/pro, gemini-2.0-flash | Free tier available on AI Studio |
| **DeepSeek** | deepseek-chat, deepseek-reasoner | Cheapest. OpenAI-compatible API |
| **OpenRouter** | 100+ models from all providers | Unified gateway |
| **Ollama** | qwen2.5, llama3.2, mistral, deepseek-r1, etc. | Fully local, no API key |

### Embedding Providers

| Provider | Models | Notes |
|----------|--------|-------|
| **OpenAI** | text-embedding-3-small/large | Default (1536d). Most reliable |
| **Google Gemini** | gemini-embedding-001, text-embedding-004 | Free on AI Studio |
| **Voyage AI** | voyage-3, voyage-3-lite, voyage-code-3 | High quality |
| **Ollama** | bge-m3, nomic-embed-text, mxbai-embed-large | Local, zero cost |

All providers are configurable via the Dashboard UI or `cortex.json`. See `cortex-provider-reference.md` for detailed model comparisons and pricing.

> **Warning: Changing embedding models**
>
> Each embedding model produces vectors of a specific dimension. If you switch to a model with different dimensions, **all existing vectors become incompatible**. After changing the embedding model or dimensions:
> 1. Go to Dashboard → Settings → Data Management → **Reindex Vectors**
> 2. This regenerates all vectors using the new model (requires API calls for every stored memory)
> 3. Until reindexed, vector search (recall, dedup, smart update) will not work correctly

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/recall` | Search memories and get injection context |
| `POST` | `/api/v1/ingest` | Ingest conversation for memory extraction |
| `POST` | `/api/v1/flush` | Emergency flush before compaction |
| `POST` | `/api/v1/search` | Hybrid search with debug info |
| `GET/POST/PATCH/DELETE` | `/api/v1/memories` | Memory CRUD |
| `GET/POST/DELETE` | `/api/v1/relations` | Entity relation CRUD |
| `GET/POST/PATCH/DELETE` | `/api/v1/agents` | Agent management |
| `GET` | `/api/v1/agents/:id/config` | Agent merged configuration |
| `GET` | `/api/v1/extraction-logs` | Extraction quality audit logs |
| `POST` | `/api/v1/lifecycle/run` | Trigger lifecycle engine |
| `GET` | `/api/v1/lifecycle/preview` | Dry-run preview |
| `GET` | `/api/v1/health` | Health check |
| `GET` | `/api/v1/stats` | Memory statistics |
| `GET/PATCH` | `/api/v1/config` | Configuration |

---

## Configuration

Cortex works out of the box with just an `OPENAI_API_KEY`. For advanced setups:

| Option | Description |
|--------|-------------|
| **LLM Provider** | OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, Ollama |
| **Embedding Provider** | OpenAI, Google, Voyage AI, Ollama |
| **Vector Backend** | SQLite vec0 (default), Qdrant, Milvus |
| **Per-Agent Config** | Each agent can override global LLM/embedding settings |
| **Offline Mode** | Use Ollama for fully local, no-API-key setup |

See `DESIGN.md` for full configuration options and `cortex-provider-reference.md` for provider selection guide.

---

## Project Structure

```
cortex/
├── packages/
│   ├── server/          # Core service (Fastify + SQLite)
│   ├── mcp-client/      # MCP stdio adapter (npm: @cortexmem/mcp)
│   ├── cortex-bridge/   # OpenClaw plugin (npm: @cortexmem/openclaw)
│   └── dashboard/       # React management SPA
├── docker-compose.yml
├── DESIGN.md            # Full technical design document
└── cortex-provider-reference.md  # LLM/Embedding provider guide
```

## Cost

With default settings (gpt-4o-mini + text-embedding-3-small):
- ~$0.55/month at 50 conversations/day
- Scales linearly; even 3x usage stays under $2/month
- With DeepSeek + Google Embedding: as low as ~$0.10/month

## Known Issues

### ~~OpenClaw: `agent_end` hook not firing in streaming mode~~ (Fixed)

~~**Upstream bug:** [openclaw/openclaw#21863](https://github.com/openclaw/openclaw/issues/21863)~~

**Resolved** — Fixed upstream in commit `72d1d36`. The `agent_end` hook now fires correctly in streaming mode. Automatic memory extraction works in all modes.

## License

MIT

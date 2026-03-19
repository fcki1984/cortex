<p align="center">
  <img src="https://raw.githubusercontent.com/rikouu/cortex/main/.github/assets/logo.png" width="80" alt="Cortex Logo" />
</p>

<h1 align="center">Cortex</h1>
<p align="center"><strong>Your AI forgets. Cortex doesn't.</strong></p>
<p align="center"><sub>Memory that lives, learns, and recalls.</sub></p>

<p align="center">
  <a href="https://github.com/rikouu/cortex/releases"><img src="https://img.shields.io/github/v/release/rikouu/cortex?style=flat-square&color=6366f1" alt="Release" /></a>
  <a href="https://github.com/rikouu/cortex/blob/main/LICENSE"><img src="https://img.shields.io/github/license/rikouu/cortex?style=flat-square" alt="License" /></a>
  <a href="https://hub.docker.com/r/rikouu/cortex"><img src="https://img.shields.io/docker/pulls/rikouu/cortex?style=flat-square" alt="Docker Pulls" /></a>
  <a href="https://www.npmjs.com/package/@cortexmem/mcp"><img src="https://img.shields.io/npm/v/@cortexmem/mcp?style=flat-square&label=MCP" alt="npm MCP" /></a>
</p>

<p align="center">
  <a href="#how-it-works">How It Works</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#connect-your-ai">Integrations</a> •
  <a href="#key-features">Features</a> •
  <a href="#api-reference">API</a> •
  <a href="./README.zh-CN.md">中文</a>
</p>

---

Ever told your AI something important, only to have it completely forget by the next conversation?

> "Hey, I switched to decaf last week."
>
> *...two days later...*
>
> "Want me to recommend some espresso drinks?"

**Your AI has no memory.** Every conversation starts from zero. No matter how many times you explain your preferences, your projects, your constraints — it's gone the moment the chat window closes.

**Cortex changes that.** It runs alongside your AI, quietly learning from every conversation. It knows your name, your preferences, your ongoing projects, the decisions you've made — and surfaces exactly the right context when it matters.

```
Monday:    "I'm allergic to shellfish and I just moved to Tokyo."

Wednesday: "Can you find me a good restaurant nearby?"
    Agent:  Searches for Tokyo restaurants, automatically
            excludes seafood-heavy options.
            (Cortex recalled: allergy + location)
```

No manual tagging. No "save this." It just works.

## Why Cortex?

| | Cortex | Mem0 | Zep | LangMem |
|---|---|---|---|---|
| **Structured memory model** | ✅ Facts / rules / task state / session notes | ❌ Flat store | Partial | ❌ |
| **Memory lifecycle** | ✅ Note retention + forgetting-first | ❌ Flat store | Partial | ❌ |
| **Relations** | ✅ Record-bound, evidence-traceable | ✅ Basic | ❌ | ❌ |
| **Self-hosted** | ✅ Single Docker container | Cloud-first | Cloud-first | Framework-bound |
| **Data ownership** | ✅ Your SQLite database | Their cloud | Their cloud | Varies |
| **Dashboard** | ✅ Full management UI | ❌ | Partial | ❌ |
| **MCP support** | ✅ Native | ❌ | ❌ | ❌ |
| **Multi-agent** | ✅ Isolated namespaces | ✅ | ✅ | ❌ |
| **Cost** | ~$0.55/mo | $99+/mo | $49+/mo | Varies |

## Key Features

### 🧬 V2 Record Model + Note Retention
V2 separates durable truth from disposable session context.

```
profile_rule / fact_slot / task_state  → durable truth
session_note                           → short-lived context

active → dormant → stale → purge
```

- **Durable records** keep stable user facts, rules, and task state
- **Session notes** are the only lifecycle-managed objects
- **Forgetting-first**: old notes retire and purge instead of becoming auto-written summaries
- **Supersede over decay**: durable truth is updated explicitly, not "forgotten"

### 🔍 Hybrid Search with Multi-Stage Ranking

```
Query → BM25 (keywords) + Vector (semantics) → RRF Fusion
     → Query Expansion (LLM variants)
     → LLM Reranker (optional)
     → Priority injection (constraints & persona first)
```

- **Dual-channel**: keyword precision + semantic understanding
- **Query expansion**: LLM generates search variants, multi-hit boost
- **Reranker**: LLM, Cohere, Voyage AI, Jina AI, or SiliconFlow re-scores for relevance
- **Smart injection**: constraints and persona always injected first, never truncated

### 🕸️ Relation Candidates + Confirmed Relations
Relations are traceable, auditable, and tied to source records.

```
candidate relation ──review/confirm──→ confirmed relation
         │                                      │
         └──── source record + evidence ────────┘
```

- Auto extraction produces **relation candidates**, not formal truth
- Confirmed relations are stored in `record_relations_v2`
- Formal relations must point back to a source record and evidence
- Neo4j, if enabled, is a derived graph index, not the formal truth source

### 🛡️ Structured Extraction + Durable Admissibility

```
Conversation ──→ Fast Signals (regex) ──→ Merge ──→ Normalize ──→ Upsert
             ──→ Deep Extraction (LLM) ──┘              │ durable fact/rule/state
                                                        │ or downgrade to session_note
                                                        └ evidence + reason codes
```

- **Stable-key upsert**: explicit updates supersede old truth instead of piling up duplicates
- **Reasoned downgrades**: ambiguous input is accepted but stored as `session_note`
- **Evidence-first**: every durable record stays tied to conversation evidence
- **Relation candidates**: extraction suggests relations for review instead of auto-writing formal truth

### 📊 Full Dashboard
Every record is searchable. Every write, relation, and lifecycle action is auditable.

- Memory browser with V2 record kinds, normalization metadata, and agent filters
- Recall tester with durable/note candidate counts, normalized intents, and relevance basis
- Extraction logs with requested/written kind, normalization result, and reason code
- Relation review with candidate approval flow and confirmed-relation audit trail
- Lifecycle monitor focused on note retention: active, dormant, stale, purge
- Feedback review for good/bad/corrected outcomes and supersede chains
- Multi-agent management with per-agent config and health visibility

### 🔌 Works Everywhere

| Integration | Setup |
|---|---|
| **OpenClaw** | `openclaw plugins install @cortexmem/openclaw` |
| **Claude Desktop** | Add MCP config → restart |
| **Cursor / Windsurf** | Add MCP server in settings |
| **Claude Code** | `claude mcp add cortex -- npx @cortexmem/mcp` |
| **Any app** | REST API: `/api/v2/recall` + `/api/v2/ingest` |

---

## How It Works

### Write Path — every conversation turn
```
Conversation ──→ Fast signals + Deep extraction
                          ↓
                 Normalize into profile_rule / fact_slot / task_state / session_note
                          ↓
                 Durable admissibility gate
                 (stable fact/rule/state or downgrade to session_note)
                          ↓
                 Upsert record + evidence + conversation refs
                          ↓
                 Derive relation candidates (pending review)
```

### Read Path — every conversation turn
```
User message ──→ FTS + Vector candidate retrieval
                          ↓
                 Intent normalization
                 (subject + attribute/state anchors)
                          ↓
                 Durable-first eligibility gate
                 (anchor / lexical first, vector only boosts)
                          ↓
                 Optional 1 related session note ride-along
                          ↓
                 Context packing → persona → durable records → note
```

### Lifecycle — runs daily
```
session_note only:

active ──retire──→ dormant ──age──→ stale ──expire──→ purge

profile_rule / fact_slot / task_state stay outside lifecycle truth management
```

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/rikouu/cortex/main/.github/assets/architecture-en.png" alt="Cortex Architecture" width="800" />
</p>

```
┌─ Clients ──────────────────────────────────────────────────────────┐
│  OpenClaw (Bridge)  │  Claude Desktop (MCP)  │  Cursor  │  REST   │
└─────────────────────┴────────────────────────┴──────────┴─────────┘
                              │
                              ▼
┌─ Cortex Server (:21100) ───────────────────────────────────────────┐
│                                                                     │
│  ┌─ Recall Engine ───────┐    ┌─ Write Engine ──────────────────┐  │
│  │ FTS + Vector Search   │    │ Fast Signals + Deep Extraction  │  │
│  │ Intent Normalization  │    │ Durable Admissibility Gate      │  │
│  │ Durable Eligibility   │    │ Stable-key Upsert               │  │
│  │ Note Ride-along       │    │ Evidence + Conversation Refs    │  │
│  │ Context Packing       │    │ Relation Candidate Derivation   │  │
│  └───────────────────────┘    └─────────────────────────────────┘  │
│                                                                     │
│  ┌─ Lifecycle V2 ────────┐    ┌─ Storage ───────────────────────┐  │
│  │ Note Retention        │    │ SQLite + FTS5 (records)         │  │
│  │ Retire / Stale / Purge│    │ sqlite-vec (embeddings)         │  │
│  │ Scheduler             │    │ record_relations_v2             │  │
│  │ Audit Logs            │    │ relation_candidates_v2          │  │
│  └───────────────────────┘    └─────────────────────────────────┘  │
│                                                                     │
│  ┌─ Dashboard (React SPA) ──────────────────────────────────────┐  │
│  │ Memory Browser │ Recall Tester │ Extraction Logs │ Feedback   │  │
│  │ Relation Review │ Lifecycle Monitor │ Agent Config            │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
git clone https://github.com/rikouu/cortex.git
cd cortex
docker compose up -d
```

Open **http://localhost:21100** → Dashboard → **Settings** → pick your LLM provider, paste API key. Done.

> No `.env` files required for local use. Everything is configurable from the Dashboard.

By default, the Dashboard and API have **no auth token** — anyone who can reach port 21100 has full access. This is fine for localhost, but **read the security section below before exposing to a network.**

<details>
<summary><b>Without Docker</b></summary>

**Production mode** (recommended):

```bash
git clone https://github.com/rikouu/cortex.git
cd cortex
pnpm install
pnpm build        # Build server + dashboard
pnpm start        # → http://localhost:21100
```

**Development mode** (for contributors):

```bash
pnpm dev           # API only → http://localhost:21100
# Dashboard runs separately:
cd packages/dashboard && pnpm dev  # → http://localhost:5173
```

> ⚠️ In dev mode, visiting `http://localhost:21100` in browser will show a 404 — that's normal. The Dashboard dev server runs on a separate port.

**Requirements:** Node.js ≥ 18, pnpm ≥ 8

</details>

---

## Configuration

### Environment Variables

Create a `.env` file in the project root (or set in `docker-compose.yml` → `environment`):

| Variable | Default | Description |
|---|---|---|
| `CORTEX_PORT` | `21100` | Server port |
| `CORTEX_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `CORTEX_AUTH_TOKEN` | *(empty)* | **Auth token** — protects Dashboard + API |
| `CORTEX_DB_PATH` | `cortex/brain.db` | SQLite database path |
| `CORTEX_LLM_EXTRACTION_PROVIDER` | `openai` | Extraction LLM provider. Keep `openai` and set a custom base URL for OpenAI-compatible gateways. |
| `CORTEX_LLM_EXTRACTION_MODEL` | `gpt-4o` | Extraction LLM model name |
| `CORTEX_LLM_EXTRACTION_API_KEY` | — | Extraction LLM API key |
| `CORTEX_LLM_EXTRACTION_BASE_URL` | — | Extraction LLM base URL for OpenAI-compatible endpoints |
| `CORTEX_LLM_LIFECYCLE_PROVIDER` | `openai` | Lifecycle LLM provider |
| `CORTEX_LLM_LIFECYCLE_MODEL` | `gpt-4o-mini` | Lifecycle LLM model name |
| `CORTEX_LLM_LIFECYCLE_API_KEY` | — | Lifecycle LLM API key |
| `CORTEX_LLM_LIFECYCLE_BASE_URL` | — | Lifecycle LLM base URL |
| `CORTEX_EMBEDDING_PROVIDER` | `openai` | Embedding provider |
| `CORTEX_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name |
| `CORTEX_EMBEDDING_API_KEY` | — | Embedding API key |
| `CORTEX_EMBEDDING_BASE_URL` | — | Embedding base URL for OpenAI-compatible endpoints |
| `CORTEX_EMBEDDING_DIMENSIONS` | `1536` | Embedding vector dimensions |
| `OPENAI_API_KEY` | — | Legacy fallback key for the default OpenAI provider |
| `OLLAMA_BASE_URL` | — | Legacy fallback base URL for Ollama providers |
| `TZ` | `UTC` | Timezone (e.g. `Asia/Tokyo`) |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `NEO4J_URI` | — | Neo4j connection (optional) |
| `NEO4J_USER` | — | Neo4j user |
| `NEO4J_PASSWORD` | — | Neo4j password |

> 💡 Dashboard → Settings still works for all model settings. These env vars are useful when you want Docker/bootstrap-time defaults or need to wire an OpenAI-compatible endpoint before first login.
>
> If extraction and lifecycle should use the same model, set both `CORTEX_LLM_*` groups to the same values. Changing `CORTEX_EMBEDDING_MODEL` or `CORTEX_EMBEDDING_DIMENSIONS` requires a full vector reindex.

### Auth Token — How It Works

When `CORTEX_AUTH_TOKEN` is set:

1. **Dashboard** prompts for the token on first visit (saved in browser)
2. **All API calls** require `Authorization: Bearer <your-token>` header
3. **MCP clients** and **Bridge plugins** must include the token in their config

When `CORTEX_AUTH_TOKEN` is **not set** (default):
- No auth required — open access
- Fine for `localhost` / personal use
- ⚠️ **Dangerous** if the port is exposed to the internet

**Where to find your token:** It's whatever you set in `CORTEX_AUTH_TOKEN`. You choose it — there's no auto-generated token. Write it down and use the same value in all client configs.

### 🔒 Security Checklist

If you're exposing Cortex beyond localhost (LAN, VPN, or internet):

- [ ] **Set `CORTEX_AUTH_TOKEN`** — use a strong random string (32+ chars)
- [ ] **Use HTTPS/SSL** — put a reverse proxy (Caddy, Nginx, Traefik) in front with TLS
- [ ] **Restrict `CORTEX_HOST`** — bind to `127.0.0.1` or your Tailscale/VPN IP, not `0.0.0.0`
- [ ] **Firewall rules** — only allow trusted IPs to reach the port
- [ ] **Keep updated** — check Dashboard for version updates

```bash
# Example: strong random token
openssl rand -hex 24
# → e.g. 3a7f2b...  (use this as CORTEX_AUTH_TOKEN)
```

> ⚠️ **Without HTTPS, your token is sent in plaintext.** Always use TLS for non-localhost deployments.

<details>
<summary><b>With Neo4j (knowledge graph)</b></summary>

Add to your `docker-compose.yml`:

```yaml
neo4j:
  image: neo4j:5-community
  ports:
    - "7474:7474"
    - "7687:7687"
  environment:
    NEO4J_AUTH: neo4j/your-password
```

Set env vars for Cortex:
```
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
```

</details>

---

## Connect Your AI

> 💡 If you set `CORTEX_AUTH_TOKEN`, include it in every client config below. Examples show both with and without auth.

### OpenClaw (Recommended)

```bash
openclaw plugins install @cortexmem/openclaw
```

Configure in OpenClaw's plugin settings (Dashboard or `openclaw.json`):

```json
{
  "cortexUrl": "http://localhost:21100",
  "authToken": "your-token-here",
  "agentId": "my-agent"
}
```

> Without auth: omit `authToken`. Without custom agent: omit `agentId` (defaults to `"openclaw"`).

The plugin auto-hooks into OpenClaw's lifecycle:

| Hook | When | What |
|---|---|---|
| `before_agent_start` | Before AI responds | Recalls & injects relevant memories |
| `agent_end` | After AI responds | Extracts & stores key information |
| `before_compaction` | Before context compression | Emergency save before info is lost |

Plus `cortex_recall` and `cortex_remember` tools for on-demand use.

### Claude Desktop (MCP)

Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp", "--server-url", "http://localhost:21100"],
      "env": {
        "CORTEX_AUTH_TOKEN": "your-token-here",
        "CORTEX_AGENT_ID": "my-agent"
      }
    }
  }
}
```

> Without auth: remove the `CORTEX_AUTH_TOKEN` line from `env`.

### Other MCP Clients

<details>
<summary><b>Cursor</b></summary>

Settings → MCP → Add new global MCP server:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp"],
      "env": {
        "CORTEX_URL": "http://localhost:21100",
        "CORTEX_AUTH_TOKEN": "your-token-here",
        "CORTEX_AGENT_ID": "my-agent"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
# Without auth
claude mcp add cortex -- npx @cortexmem/mcp --server-url http://localhost:21100

# With auth + agent ID
CORTEX_AUTH_TOKEN=your-token-here CORTEX_AGENT_ID=my-agent \
  claude mcp add cortex -- npx @cortexmem/mcp --server-url http://localhost:21100
```
</details>

<details>
<summary><b>Windsurf / Cline / Others</b></summary>

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp", "--server-url", "http://localhost:21100"],
      "env": {
        "CORTEX_AGENT_ID": "my-agent",
        "CORTEX_AUTH_TOKEN": "your-token-here"
      }
    }
  }
}
```
</details>

### REST API

```bash
# Without auth
curl -X POST http://localhost:21100/api/v2/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"What food do I like?","agent_id":"default"}'

# With auth
curl -X POST http://localhost:21100/api/v2/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token-here" \
  -d '{"user_message":"I love sushi","assistant_message":"Noted!","agent_id":"default"}'
```

For Cortex V2 record writes, durable kinds are reserved for clear, updateable user facts, rules, and task state. Ambiguous natural-language input is accepted, but it will be normalized down to `session_note` instead of forcing a durable record.

---

## MCP Tools

| Tool | Description |
|---|---|
| `cortex_recall` | Search memories with priority injection |
| `cortex_remember` | Store a specific memory |
| `cortex_forget` | Remove or correct a memory |
| `cortex_search_debug` | Debug search scoring |
| `cortex_stats` | Memory statistics |

---

## Supported Providers

### LLM (for extraction & reranking)

| Provider | Recommended Models | Notes |
|---|---|---|
| **OpenAI** | gpt-4o-mini, gpt-5.2 | Default. Best cost/quality |
| **Anthropic** | claude-haiku-4-5, claude-sonnet-4-6 | Highest extraction quality |
| **Google Gemini** | gemini-2.5-flash | Free tier on AI Studio |
| **DeepSeek** | deepseek-chat, deepseek-v4 | Cheapest option |
| **DashScope** | qwen-plus, qwen-turbo | 通义千问, OpenAI-compatible |
| **Ollama** | qwen2.5, llama3.2 | Fully local, zero cost |
| **OpenRouter** | Any of 100+ models | Unified gateway |

### Embedding (for vector search)

| Provider | Recommended Models | Notes |
|---|---|---|
| **OpenAI** | text-embedding-3-small/large | Default. Most reliable |
| **Google Gemini** | gemini-embedding-2, gemini-embedding-001 | Free on AI Studio |
| **Voyage AI** | voyage-4-large, voyage-4-lite | High quality (shared embedding space) |
| **DashScope** | text-embedding-v3 | 通义千问, good for Chinese |
| **Ollama** | bge-m3, nomic-embed-text | Local, zero cost |

> ⚠️ **Changing embedding models** requires reindexing all vectors. Use Dashboard → Settings → Reindex Vectors.

### Reranker (optional, improves search relevance)

| Provider | Recommended Models | Free Tier | Notes |
|---|---|---|---|
| **LLM** | (your extraction model) | — | Highest quality, ~2-3s latency |
| **Cohere** | rerank-v3.5 | 1000 req/mo | Established, reliable |
| **Voyage AI** | rerank-2.5, rerank-2.5-lite | 200M tokens | Best free tier |
| **Jina AI** | jina-reranker-v2-base-multilingual | 1M tokens | Best for Chinese/multilingual |
| **SiliconFlow** | BAAI/bge-reranker-v2-m3 | Free tier | Open-source, low latency |

> 💡 Dedicated rerankers are **10-50x faster** than LLM reranking (~100ms vs ~2s). Configure in Dashboard → Settings → Search.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v2/recall` | Structured recall blocks + packed context |
| `POST` | `/api/v2/ingest` | Extract and write V2 records from a conversation turn |
| `CRUD` | `/api/v2/records` | V2 record management |
| `GET` | `/api/v2/stats` | V2 record and runtime statistics |
| `CRUD` | `/api/v2/relation-candidates` | Review relation candidates before confirmation |
| `CRUD` | `/api/v2/relations` | Confirmed record-bound relations |
| `POST` | `/api/v2/lifecycle/run` | Run note-only lifecycle maintenance |
| `GET` | `/api/v2/lifecycle/preview` | Preview dormant/stale/purge note transitions |
| `GET` | `/api/v2/lifecycle/log` | Lifecycle execution history |
| `POST` | `/api/v2/feedback` | Review or correct a record |
| `GET` | `/api/v2/feedback` | Feedback history and aggregates |
| `CRUD` | `/api/v2/agents` | Agent management |
| `GET` | `/api/v2/agents/:id/config` | Agent merged config |
| `GET` | `/api/v2/extraction-logs` | Extraction audit logs |
| `GET` | `/api/v2/health` | Health check |
| `GET` | `/api/v2/health/components` | Provider/component health details |
| `GET/PATCH` | `/api/v2/config` | Global config |
| `GET` | `/api/v2/config/export` | Export effective config |
| `GET` | `/api/v2/logs` | Runtime logs |
| `POST` | `/api/v2/log-level` | Update log level |
| `POST` | `/api/v2/import` | Legacy/admin import utility |
| `GET` | `/api/v2/export` | Legacy/admin export utility |
| `POST` | `/api/v2/reindex` | Rebuild search/vector indexes |
| `POST` | `/api/v2/update` | Trigger app self-update |
| `GET` | `/api/v2/metrics` | Prometheus metrics |
| `GET` | `/api/v2/metrics/json` | JSON metrics snapshot |
| `POST` | `/mcp` | MCP JSON-RPC main entrypoint |
| `POST` | `/mcp/message` | MCP compatibility entrypoint |
| `GET` | `/mcp/sse` | MCP SSE transport |
| `GET` | `/mcp/tools` | MCP tool catalog |

> Production V2 uses `/api/v2/*` across the public REST surface, including `/api/v2/auth/*`.

## Cost

| Setup | Monthly Cost |
|---|---|
| gpt-4o-mini + text-embedding-3-small | ~$0.55 |
| DeepSeek + Google Embedding | ~$0.10 |
| Ollama (fully local) | $0.00 |

*Based on 50 conversations/day. Scales linearly.*

---

## License

MIT

---

<p align="center">
  <sub>Built with obsessive attention to how memory should work.</sub>
</p>

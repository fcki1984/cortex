<p align="center">
  <img src="https://raw.githubusercontent.com/rikouu/cortex/main/.github/assets/logo.png" width="80" alt="Cortex Logo" />
</p>

<h1 align="center">Cortex</h1>
<p align="center"><strong>你的 AI 会遗忘，Cortex 不会。</strong></p>
<p align="center"><sub>会生长、会学习、会回忆的记忆系统。</sub></p>

<p align="center">
  <a href="https://github.com/rikouu/cortex/releases"><img src="https://img.shields.io/github/v/release/rikouu/cortex?style=flat-square&color=6366f1" alt="Release" /></a>
  <a href="https://github.com/rikouu/cortex/blob/main/LICENSE"><img src="https://img.shields.io/github/license/rikouu/cortex?style=flat-square" alt="License" /></a>
  <a href="https://hub.docker.com/r/rikouu/cortex"><img src="https://img.shields.io/docker/pulls/rikouu/cortex?style=flat-square" alt="Docker Pulls" /></a>
  <a href="https://www.npmjs.com/package/@cortexmem/mcp"><img src="https://img.shields.io/npm/v/@cortexmem/mcp?style=flat-square&label=MCP" alt="npm MCP" /></a>
</p>

<p align="center">
  <a href="#工作原理">工作原理</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#接入你的-ai">接入方式</a> •
  <a href="#核心特性">特性</a> •
  <a href="#api-参考">API</a> •
  <a href="./README.md">English</a>
</p>

---

你有没有这种经历——跟 AI 聊了半天，结果第二天它全忘了？

> "我上周开始戒咖啡了。"
>
> *……两天后……*
>
> "要不要我推荐几款浓缩咖啡？"

**你的 AI 没有记忆。** 每次对话都是从零开始。不管你解释过多少次你的偏好、你的项目、你的约束——关掉窗口，全没了。

**Cortex 改变这一切。** 它在你的 AI 旁边默默运行，从每次对话中学习。它记得你的名字、你的偏好、你正在做的项目、你做过的决定——并在需要的时候精准地提供上下文。

```
周一：   "我对虾过敏，刚搬到东京。"

周三：   "帮我找个好吃的餐厅？"
  AI：    搜索东京附近的餐厅，
          自动排除海鲜为主的选项。
          （Cortex 回忆起了：过敏 + 所在地）
```

不用手动标记，不用说"记住这个"。它就是能记住。

## 为什么选 Cortex？

| | Cortex | Mem0 | Zep | LangMem |
|---|---|---|---|---|
| **结构化记忆模型** | ✅ 事实 / 规则 / 任务状态 / 会话笔记 | ❌ 扁平存储 | 部分 | ❌ |
| **记忆生命周期** | ✅ 会话笔记保留与遗忘 | ❌ 扁平存储 | 部分 | ❌ |
| **关系层** | ✅ 绑定记录与证据、可审计 | ✅ 基础 | ❌ | ❌ |
| **自部署** | ✅ 一个 Docker 容器 | 云优先 | 云优先 | 框架绑定 |
| **数据主权** | ✅ 你的 SQLite 数据库 | 他们的云 | 他们的云 | 不一定 |
| **管理面板** | ✅ 完整 UI | ❌ | 部分 | ❌ |
| **MCP 支持** | ✅ 原生 | ❌ | ❌ | ❌ |
| **多 Agent** | ✅ 隔离命名空间 | ✅ | ✅ | ❌ |
| **成本** | ~¥4/月 | $99+/月 | $49+/月 | 不等 |

## 核心特性

### 🧬 V2 结构化记录 + 会话笔记保留

V2 把“长期真相”和“短期上下文”彻底分开。

```
profile_rule / fact_slot / task_state  → 持久真相
session_note                           → 短期上下文

active → dormant → stale → purge
```

- **持久记录** 保存稳定的用户事实、规则和任务状态
- **会话笔记** 是唯一进入生命周期管理的对象
- **遗忘优先**：旧笔记先退役、再陈旧化、最后清理，不再自动写回摘要
- **显式替代**：长期真相依赖 supersede / invalidation，而不是“衰减失真”

### 🔍 混合搜索 + 多级排序

```
查询 → BM25 (关键词) + 向量 (语义) → RRF 融合
    → 查询扩展 (LLM 变体)
    → LLM 重排序 (可选)
    → 优先注入 (约束和人设优先)
```

- **双通道**：关键词精确匹配 + 语义理解
- **查询扩展**：LLM 生成搜索变体，多命中加权
- **重排序**：LLM、Cohere、Voyage AI、Jina AI 或 SiliconFlow 二次评分
- **智能注入**：约束和人设始终优先注入，永远不会被截断

### 🕸️ 关系候选与已确认关系

关系必须可追溯、可审计，并绑定到来源记录。

```
关系候选 ──审核/确认──→ 已确认关系
   │                          │
   └──── 来源记录 + 证据 ─────┘
```

- 自动抽取先写入**关系候选**，不直接成为正式关系
- 已确认关系写入 `record_relations_v2`
- 每条正式关系都必须能追溯到来源记录和证据
- Neo4j 如启用，只是派生图索引，不是正式真相源

### 🛡️ 结构化提取 + Durable 准入

```
对话 ──→ 快信号 (正则) ──→ 合并 ──→ 归一 ──→ Upsert
     ──→ 深提取 (LLM) ──┘               │ 稳定事实/规则/状态
                                        │ 或降级为 session_note
                                        └ 证据 + 原因码
```

- **稳定键 Upsert**：明确更新会 supersede 旧真相，而不是不断堆重复项
- **可解释降级**：模糊输入仍可接受，但会写成 `session_note`
- **证据优先**：每条 durable 记录都绑定对话证据
- **关系候选**：自动提取只生成候选，正式关系必须先审核确认

### 📊 全功能管理面板

每条记录可搜索，每次写入、关系确认和生命周期动作都可审计。

- 记忆浏览器：查看 V2 记录类型、归一结果和 Agent 过滤
- 召回测试器：展示 durable / note 候选数、归一意图和 relevance basis
- 提取日志：显示 requested / written kind、normalization 和 reason code
- 关系审查：先审核候选，再确认正式关系
- 生命周期监控：聚焦会话笔记保留，查看 active / dormant / stale / purge
- 反馈审核：查看 good / bad / corrected 及 supersede 链
- 多 Agent 管理、独立配置与系统健康状态

### 🔌 接入一切

| 集成方式 | 接入 |
|---|---|
| **OpenClaw** | `openclaw plugins install @cortexmem/openclaw` |
| **Claude Desktop** | 添加 MCP 配置 → 重启 |
| **Cursor / Windsurf** | 在设置中添加 MCP 服务器 |
| **Claude Code** | `claude mcp add cortex -- npx @cortexmem/mcp` |
| **任何应用** | REST API: `/api/v2/recall` + `/api/v2/ingest` |

---

## 工作原理

### 写入路径 — 每轮对话自动执行
```
对话 ──→ 快信号 + 深提取
                   ↓
          归一为 profile_rule / fact_slot / task_state / session_note
                   ↓
          Durable 准入判断
          （稳定事实/规则/状态或降级为 session_note）
                   ↓
          Upsert 记录 + 证据 + 对话引用
                   ↓
          派生关系候选（等待人工确认）
```

### 读取路径 — 每轮对话自动执行
```
用户消息 ──→ FTS + 向量候选召回
                   ↓
          意图归一
          （主体 + 属性/状态锚点）
                   ↓
          Durable-first 资格门
          （先看锚点/词法，再用向量辅助）
                   ↓
          最多补 1 条相关 session_note
                   ↓
          上下文打包 → persona → durable 记录 → note
```

### 生命周期 — 每日自动调度
```
仅 `session_note` 进入生命周期：

active ──退役──→ dormant ──继续老化──→ stale ──到期──→ purge

profile_rule / fact_slot / task_state 不参与生命周期真假管理
```

---

## 架构

<p align="center">
  <img src="https://raw.githubusercontent.com/rikouu/cortex/main/.github/assets/architecture-zh.png" alt="Cortex 架构图" width="800" />
</p>

```
┌─ 客户端 ───────────────────────────────────────────────────────────┐
│  OpenClaw (Bridge)  │  Claude Desktop (MCP)  │  Cursor  │  REST   │
└─────────────────────┴────────────────────────┴──────────┴─────────┘
                              │
                              ▼
┌─ Cortex 服务端 (:21100) ───────────────────────────────────────────┐
│                                                                     │
│  ┌─ 召回引擎 ────────────┐    ┌─ 写入引擎 ─────────────────────┐  │
│  │ FTS + 向量搜索        │    │ 快信号 + 深提取                 │  │
│  │ 意图归一              │    │ Durable 准入判断                │  │
│  │ Durable 资格门        │    │ 稳定键 Upsert                   │  │
│  │ Note 跟随             │    │ 证据 + 对话引用                 │  │
│  │ 上下文打包            │    │ 关系候选派生                    │  │
│  └───────────────────────┘    └─────────────────────────────────┘  │
│                                                                     │
│  ┌─ 生命周期 V2 ─────────┐    ┌─ 存储 ─────────────────────────┐  │
│  │ 笔记保留策略           │    │ SQLite + FTS5 (records)        │  │
│  │ retire / stale / purge│    │ sqlite-vec (向量)              │  │
│  │ 定时调度               │    │ record_relations_v2            │  │
│  │ 审计日志               │    │ relation_candidates_v2         │  │
│  └───────────────────────┘    └─────────────────────────────────┘  │
│                                                                     │
│  ┌─ 管理面板 (React SPA) ───────────────────────────────────────┐  │
│  │ 记忆浏览 │ 召回测试 │ 提取日志 │ 反馈审核                     │  │
│  │ 关系审查 │ 生命周期监控 │ Agent 配置                        │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 快速开始

```bash
git clone https://github.com/rikouu/cortex.git
cd cortex
docker compose up -d
```

打开 **http://localhost:21100** → 管理面板 → **设置** → 选择 LLM 提供商，填入 API Key。搞定。

> 本地使用不需要 `.env` 文件。所有 LLM 配置都在面板里完成。

默认情况下，面板和 API **没有访问密码** —— 任何能访问 21100 端口的人都可以完全操作。本地使用没问题，但**对外开放前请务必阅读下方安全配置。**

<details>
<summary><b>不用 Docker</b></summary>

**生产模式**（推荐）：

```bash
git clone https://github.com/rikouu/cortex.git
cd cortex
pnpm install
pnpm build        # 构建服务器 + 控制台
pnpm start        # → http://localhost:21100
```

**开发模式**（开发者/贡献者）：

```bash
pnpm dev           # 仅 API → http://localhost:21100
# 控制台需要单独启动：
cd packages/dashboard && pnpm dev  # → http://localhost:5173
```

> ⚠️ 开发模式下，浏览器访问 `http://localhost:21100` 会显示 404 —— 这是正常的。控制台开发服务器运行在单独的端口。

**依赖：** Node.js ≥ 18, pnpm ≥ 8

</details>

---

## 配置

### 环境变量

在项目根目录创建 `.env` 文件（或在 `docker-compose.yml` 的 `environment` 中设置）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CORTEX_PORT` | `21100` | 服务端口 |
| `CORTEX_HOST` | `127.0.0.1` | 绑定地址（`0.0.0.0` 开放局域网） |
| `CORTEX_AUTH_TOKEN` | *(空)* | **访问令牌** — 保护面板和 API |
| `CORTEX_DB_PATH` | `cortex/brain.db` | SQLite 数据库路径 |
| `CORTEX_LLM_EXTRACTION_PROVIDER` | `openai` | 提取 LLM 提供商。接 OpenAI 兼容网关时保持 `openai`，再设置自定义 base URL。 |
| `CORTEX_LLM_EXTRACTION_MODEL` | `gpt-4o` | 提取 LLM 模型名 |
| `CORTEX_LLM_EXTRACTION_API_KEY` | — | 提取 LLM 的 API Key |
| `CORTEX_LLM_EXTRACTION_BASE_URL` | — | 提取 LLM 的 OpenAI-compatible 接口地址 |
| `CORTEX_LLM_LIFECYCLE_PROVIDER` | `openai` | 生命周期 LLM 提供商 |
| `CORTEX_LLM_LIFECYCLE_MODEL` | `gpt-4o-mini` | 生命周期 LLM 模型名 |
| `CORTEX_LLM_LIFECYCLE_API_KEY` | — | 生命周期 LLM 的 API Key |
| `CORTEX_LLM_LIFECYCLE_BASE_URL` | — | 生命周期 LLM 接口地址 |
| `CORTEX_EMBEDDING_PROVIDER` | `openai` | Embedding 提供商 |
| `CORTEX_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding 模型名 |
| `CORTEX_EMBEDDING_API_KEY` | — | Embedding API Key |
| `CORTEX_EMBEDDING_BASE_URL` | — | Embedding 的 OpenAI-compatible 接口地址 |
| `CORTEX_EMBEDDING_DIMENSIONS` | `1536` | Embedding 向量维度 |
| `OPENAI_API_KEY` | — | 默认 OpenAI Provider 的兼容旧变量 |
| `OLLAMA_BASE_URL` | — | Ollama Provider 的兼容旧变量 |
| `TZ` | `UTC` | 时区（如 `Asia/Tokyo`、`Asia/Shanghai`） |
| `LOG_LEVEL` | `info` | 日志级别（`debug`/`info`/`warn`/`error`） |
| `NEO4J_URI` | — | Neo4j 连接地址（可选） |
| `NEO4J_USER` | — | Neo4j 用户名 |
| `NEO4J_PASSWORD` | — | Neo4j 密码 |

> 💡 面板 → 设置仍然可以配置所有模型参数；这些环境变量适合 Docker 首次启动时直接注入默认值，或在首次登录前就接好 OpenAI-compatible 接口。
>
> 如果提取和生命周期想共用同一个模型，把两组 `CORTEX_LLM_*` 填成相同值即可。修改 `CORTEX_EMBEDDING_MODEL` 或 `CORTEX_EMBEDDING_DIMENSIONS` 后，需要执行一次全量向量重建。

### 访问令牌说明

设置了 `CORTEX_AUTH_TOKEN` 后：

1. **面板**首次访问需要输入令牌（浏览器会保存）
2. **所有 API** 调用需要 `Authorization: Bearer <令牌>` 请求头
3. **MCP 客户端**和 **Bridge 插件**需要在配置中填入令牌

没有设置 `CORTEX_AUTH_TOKEN` 时（默认）：
- 无需认证 — 完全开放
- 适合 `localhost` / 个人使用
- ⚠️ 如果端口暴露到网络上则**非常危险**

**令牌在哪里找？** 就是你自己设的 `CORTEX_AUTH_TOKEN` 值。没有自动生成的令牌——你设什么就是什么，在所有客户端配置中填相同的值即可。

### 🔒 安全清单

如果你要把 Cortex 暴露到局域网、VPN 或公网：

- [ ] **设置 `CORTEX_AUTH_TOKEN`** — 使用强随机字符串（32位以上）
- [ ] **启用 HTTPS/SSL** — 在前面放反向代理（Caddy、Nginx、Traefik）配置 TLS
- [ ] **限制 `CORTEX_HOST`** — 绑定到 `127.0.0.1` 或 Tailscale/VPN IP，不要用 `0.0.0.0`
- [ ] **防火墙** — 只允许可信 IP 访问端口
- [ ] **保持更新** — 面板会自动检测新版本

```bash
# 生成一个强随机令牌
openssl rand -hex 24
# → 例如 3a7f2b...（把这个设为 CORTEX_AUTH_TOKEN）
```

> ⚠️ **没有 HTTPS 的话，令牌是明文传输的。** 非本地部署务必配置 TLS。

<details>
<summary><b>启用知识图谱 (Neo4j)</b></summary>

在 `docker-compose.yml` 中添加：

```yaml
neo4j:
  image: neo4j:5-community
  ports:
    - "7474:7474"
    - "7687:7687"
  environment:
    NEO4J_AUTH: neo4j/your-password
```

为 Cortex 设置环境变量：
```
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
```
</details>

---

## 接入你的 AI

> 💡 如果设置了 `CORTEX_AUTH_TOKEN`，需要在下面每个客户端配置中加上令牌。示例同时展示了有/无认证的写法。

### OpenClaw（推荐）

```bash
openclaw plugins install @cortexmem/openclaw
```

在 OpenClaw 插件设置中配置（Dashboard 或 `openclaw.json`）：

```json
{
  "cortexUrl": "http://localhost:21100",
  "authToken": "你的令牌",
  "agentId": "my-agent"
}
```

> 不用认证：省略 `authToken`。不需要自定义 agent：省略 `agentId`（默认 `"openclaw"`）。

插件自动接入 OpenClaw 生命周期：

| Hook | 时机 | 做什么 |
|---|---|---|
| `before_agent_start` | AI 回复前 | 回忆并注入相关记忆 |
| `agent_end` | AI 回复后 | 提取并保存关键信息 |
| `before_compaction` | 上下文压缩前 | 紧急保存即将丢失的信息 |

另有 `cortex_recall` 和 `cortex_remember` 工具供按需使用。

### Claude Desktop (MCP)

设置 → 开发者 → 编辑配置：

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp", "--server-url", "http://localhost:21100/mcp"],
      "env": {
        "CORTEX_AUTH_TOKEN": "你的令牌",
        "CORTEX_AGENT_ID": "my-agent"
      }
    }
  }
}
```

> 不用认证：删除 `env` 中的 `CORTEX_AUTH_TOKEN` 行。
>
> MCP 主入口是 `/mcp`，`/mcp/message` 继续保留为兼容入口。

### 其他 MCP 客户端

<details>
<summary><b>Cursor</b></summary>

设置 → MCP → 添加全局 MCP 服务器：

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp"],
      "env": {
        "CORTEX_URL": "http://localhost:21100/mcp",
        "CORTEX_AUTH_TOKEN": "你的令牌",
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
# 不用认证
claude mcp add cortex -- npx @cortexmem/mcp --server-url http://localhost:21100/mcp

# 带认证 + agent ID
CORTEX_AUTH_TOKEN=你的令牌 CORTEX_AGENT_ID=my-agent \
  claude mcp add cortex -- npx @cortexmem/mcp --server-url http://localhost:21100/mcp
```
</details>

<details>
<summary><b>Windsurf / Cline / 其他</b></summary>

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@cortexmem/mcp", "--server-url", "http://localhost:21100/mcp"],
      "env": {
        "CORTEX_AGENT_ID": "my-agent",
        "CORTEX_AUTH_TOKEN": "你的令牌"
      }
    }
  }
}
```
</details>

### REST API

```bash
# 不用认证
curl -X POST http://localhost:21100/api/v2/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"我喜欢什么食物？","agent_id":"default"}'

# 带认证
curl -X POST http://localhost:21100/api/v2/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的令牌" \
  -d '{"user_message":"我喜欢寿司","assistant_message":"记住了！","agent_id":"default"}'
```

### 部署冒烟测试

```bash
CORTEX_BASE_URL=http://localhost:21100 \
CORTEX_AUTH_TOKEN=你的令牌 \
pnpm smoke:v2
```

> 这套脚本会检查 V2-only 运行标志、legacy 路由已关闭、V2 REST 正常，以及 `/mcp` 和 `/mcp/message` 两个 JSON-RPC 入口行为一致。

### WSL 下的 Dashboard 浏览器验证

如果 Cortex 跑在 WSL 里，默认用 Windows Chrome 做浏览器验证，不要再优先找发行版里的 Linux 浏览器：

```bash
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="C:\\temp\\cortex-devtools"
```

建议验证这几项：
- 首页不再显示 `Legacy compatibility ON`
- V2-only 模式下导航里没有 `Relations` 和 `Lifecycle`
- Settings 页面显示 Runtime 状态卡
- 全局搜索和 Memory Browser 正常

---

## MCP 工具

| 工具 | 说明 |
|---|---|
| `cortex_recall` | 搜索记忆，优先注入约束和人设 |
| `cortex_remember` | 存储一条特定记忆 |
| `cortex_forget` | 删除或修正记忆 |
| `cortex_search_debug` | 调试搜索评分 |
| `cortex_stats` | 记忆统计 |

---

## 支持的提供商

### LLM（用于提取和重排序）

| 提供商 | 推荐模型 | 备注 |
|---|---|---|
| **OpenAI** | gpt-4o-mini, gpt-4.1-nano | 默认，性价比最优 |
| **Anthropic** | claude-haiku-4-5, claude-sonnet-4-5 | 提取质量最高 |
| **Google Gemini** | gemini-2.5-flash | AI Studio 有免费额度 |
| **DeepSeek** | deepseek-chat | 最便宜 |
| **Ollama** | qwen2.5, llama3.2 | 完全本地，零成本 |
| **OpenRouter** | 100+ 模型 | 统一网关 |

### Embedding（用于向量搜索）

| 提供商 | 推荐模型 | 备注 |
|---|---|---|
| **OpenAI** | text-embedding-3-small/large | 默认，最稳定 |
| **Google Gemini** | gemini-embedding-2, gemini-embedding-001 | AI Studio 免费 |
| **Voyage AI** | voyage-4-large, voyage-4-lite | 高质量（共享嵌入空间）|
| **DashScope** | text-embedding-v3 | 通义千问，中文友好 |
| **Ollama** | bge-m3, nomic-embed-text | 本地，零成本 |

> ⚠️ **更换 embedding 模型**后需要重建所有向量索引。在面板 → 设置 → 重建向量索引。

### 重排序（可选，提升搜索相关性）

| 提供商 | 推荐模型 | 免费额度 | 备注 |
|---|---|---|---|
| **LLM** | （使用提取模型）| — | 质量最高，延迟 ~2-3s |
| **Cohere** | rerank-v3.5 | 1000次/月 | 老牌稳定 |
| **Voyage AI** | rerank-2.5 | 2亿 token | 免费额度最大 |
| **Jina AI** | jina-reranker-v2 | 100万 token | 中文/多语言最佳 |
| **SiliconFlow** | bge-reranker-v2-m3 | 有免费额度 | 开源模型，延迟低 |

> 💡 专用重排序比 LLM 重排序快 **10-50 倍**（~100ms vs ~2s）。在面板 → 设置 → 搜索中配置。

---

## API 参考

| 方法 | 端点 | 说明 |
|---|---|---|
| `POST` | `/api/v2/recall` | 结构化召回块 + 打包上下文 |
| `POST` | `/api/v2/ingest` | 将对话写入 V2 records |
| `CRUD` | `/api/v2/records` | V2 record 管理 |
| `GET` | `/api/v2/stats` | V2 record 与运行态统计 |
| `CRUD` | `/api/v2/relation-candidates` | 审查与确认关系候选 |
| `CRUD` | `/api/v2/relations` | 已确认的 record/evidence 关系 |
| `POST` | `/api/v2/lifecycle/run` | 执行 note-only 生命周期维护 |
| `GET` | `/api/v2/lifecycle/preview` | 预览会话笔记的休眠/陈旧/清理 |
| `GET` | `/api/v2/lifecycle/log` | 生命周期执行日志 |
| `POST` | `/api/v2/feedback` | 对 record 提交 good/bad/corrected |
| `GET` | `/api/v2/feedback` | 反馈历史与聚合统计 |
| `POST` | `/mcp` | MCP JSON-RPC 主入口 |
| `POST` | `/mcp/message` | MCP 兼容入口 |
| `GET` | `/mcp/tools` | MCP 工具列表 |
| `GET` | `/mcp/sse` | MCP SSE 传输 |
| `CRUD` | `/api/v2/agents` | Agent 管理 |
| `GET` | `/api/v2/agents/:id/config` | Agent 合并配置 |
| `GET` | `/api/v2/extraction-logs` | 提取审计日志 |
| `GET` | `/api/v2/health` | 健康检查 |
| `GET` | `/api/v2/health/components` | 各组件健康详情 |
| `GET/PATCH` | `/api/v2/config` | 全局配置 |
| `GET` | `/api/v2/config/export` | 导出当前有效配置 |
| `GET` | `/api/v2/logs` | 运行日志 |
| `POST` | `/api/v2/log-level` | 更新日志级别 |
| `POST` | `/api/v2/import` | 兼容期导入工具 |
| `GET` | `/api/v2/export` | 兼容期导出工具 |
| `POST` | `/api/v2/reindex` | 重建索引 |
| `POST` | `/api/v2/update` | 触发程序更新 |
| `GET` | `/api/v2/metrics` | Prometheus 指标 |
| `GET` | `/api/v2/metrics/json` | JSON 指标快照 |

> V2 生产版的公开 REST 接口统一使用 `/api/v2/*`，包括 `/api/v2/auth/*`。

## 成本

| 方案 | 月费 |
|---|---|
| gpt-4o-mini + text-embedding-3-small | ~¥4 |
| DeepSeek + Google Embedding | ~¥0.7 |
| Ollama（完全本地） | ¥0 |

*基于每天 50 次对话。线性增长。*

---

## 开源协议

MIT

---

<p align="center">
  <sub>用做记忆该有的方式，做记忆。</sub>
</p>

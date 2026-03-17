import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import { MCPServer, type MCPServerDeps } from '../mcp/server.js';
import { ensureAgent, listRelations } from '../db/index.js';
import { getV2Stats } from '../v2/store.js';
import { observedRoute } from './observability.js';

export function registerMCPRoutes(app: FastifyInstance, cortex: CortexApp): void {
  const deps: MCPServerDeps = {
    recall: async (query, agentId, maxResults) => {
      const result = await cortex.recordsV2.recall({
        query,
        agent_id: agentId || 'mcp',
      });
      return {
        context: result.context,
        rules: result.rules.slice(0, maxResults || 5),
        facts: result.facts.slice(0, maxResults || 5),
        task_state: result.task_state.slice(0, maxResults || 5),
        session_notes: result.session_notes.slice(0, 1),
        meta: result.meta,
      };
    },

    remember: async (content, kind, priority, agentId, sourceType, tags) => {
      const aid = agentId || 'mcp';
      ensureAgent(aid);
      const result = await cortex.recordsV2.remember({
        agent_id: aid,
        kind,
        content,
        priority,
        source_type: sourceType as any,
        tags,
      });
      return {
        id: result.record.id,
        status: result.decision,
        requested_kind: result.requested_kind,
        written_kind: result.written_kind,
        normalization: result.normalization,
        reason_code: result.reason_code,
        record: result.record,
      };
    },

    forget: async (recordId, reason) => {
      const ok = await cortex.recordsV2.deleteRecord(recordId);
      if (!ok) return { status: 'not_found', id: recordId };
      return { status: 'forgotten', id: recordId, reason };
    },

    search: async (query, debug, agentId) => {
      const results = await cortex.recordsV2.search(query, { agent_id: agentId || 'mcp', limit: 10 });
      return { results, debug };
    },

    stats: async () => {
      return getV2Stats();
    },

    listRelations: async (subject, object, limit, agentId) => {
      return listRelations({ subject, object, limit: limit || 20, agent_id: agentId || 'mcp' });
    },
  };

  const mcpServer = new MCPServer(deps);
  const injectAgentId = (req: any, msg: any) => {
    const agentIdFromHeader = req.headers['x-agent-id'] as string | undefined;
    const agentIdFromToken = req.tokenInfo?.isMaster ? undefined : req.tokenInfo?.agentId;
    const effectiveAgentId = agentIdFromHeader || agentIdFromToken;
    if (effectiveAgentId && msg?.method === 'tools/call' && msg?.params?.arguments) {
      if (!msg.params.arguments.agent_id || msg.params.arguments.agent_id === 'mcp') {
        msg.params.arguments.agent_id = effectiveAgentId;
      }
    }
  };
  const handleJsonRpcMessage = async (req: any) => {
    const msg = req.body as any;
    injectAgentId(req, msg);
    return mcpServer.handleMessage(msg);
  };
  const registerJsonRpcEndpoint = (route: '/mcp' | '/mcp/message') => {
    app.post(route, observedRoute({
      route,
      method: 'POST',
      timeoutMs: cortex.config.llm.extraction.timeoutMs || 15000,
      metricPrefix: 'mcp_route',
    }, handleJsonRpcMessage));
  };

  app.get('/mcp', async () => {
    return {
      name: 'cortex',
      protocol: 'jsonrpc',
      endpoints: {
        jsonrpc_post: '/mcp',
        compat_jsonrpc_post: '/mcp/message',
        sse: '/mcp/sse',
        tools: '/mcp/tools',
      },
    };
  });

  // SSE endpoint for MCP over HTTP
  app.get('/mcp/sse', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send server info
    reply.raw.write(`data: ${JSON.stringify({ type: 'server_info', name: 'cortex', version: '0.1.0' })}\n\n`);

    // Send tools list
    reply.raw.write(`data: ${JSON.stringify({ type: 'tools', tools: mcpServer.getTools() })}\n\n`);

    // Keep alive
    const interval = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, 15000);

    req.raw.on('close', () => clearInterval(interval));
  });

  // JSON-RPC endpoint for MCP tool calls
  registerJsonRpcEndpoint('/mcp');
  registerJsonRpcEndpoint('/mcp/message');

  // MCP tools list
  app.get('/mcp/tools', async () => {
    return { tools: mcpServer.getTools() };
  });
}

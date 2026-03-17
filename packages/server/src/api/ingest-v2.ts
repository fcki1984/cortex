import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import { ensureAgent } from '../db/index.js';
import { observedRoute } from './observability.js';

export function registerV2IngestRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.post('/api/v2/ingest', observedRoute({
    route: '/api/v2/ingest',
    method: 'POST',
    timeoutMs: cortex.config.llm.extraction.timeoutMs || 15000,
    metricPrefix: 'v2_route',
  }, async (req, reply) => {
    const body = req.body as any;
    if (body.agent_id) ensureAgent(body.agent_id);

    const result = await cortex.recordsV2.ingest({
      user_message: body.user_message || '',
      assistant_message: body.assistant_message || '',
      messages: body.messages,
      agent_id: body.agent_id,
      session_id: body.session_id,
    });

    reply.code(201);
    return result;
  }));
}

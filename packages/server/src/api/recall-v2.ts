import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';

export function registerV2RecallRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.post('/api/v2/recall', async (req) => {
    const body = req.body as any;
    return cortex.recordsV2.recall({
      query: body.query,
      agent_id: body.agent_id,
      max_tokens: body.max_tokens,
    });
  });
}

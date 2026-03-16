import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';

export function registerSearchRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.post('/api/v1/search', {
    schema: {
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          layers: { type: 'array', items: { type: 'string' } },
          categories: { type: 'array', items: { type: 'string' } },
          agent_id: { type: 'string' },
          owner_type: { type: 'string', enum: ['user', 'agent', 'system'] },
          recall_scope: { type: 'string', enum: ['global', 'topic'] },
          limit: { type: 'number' },
          debug: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const body = req.body as any;
    return cortex.searchEngine.search({
      query: body.query,
      layers: body.layers,
      categories: body.categories,
      agent_id: body.agent_id,
      owner_type: body.owner_type,
      recall_scope: body.recall_scope,
      limit: body.limit,
      debug: body.debug,
    });
  });
}

import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';

export function registerV2LifecycleRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.get('/api/v2/lifecycle/preview', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return cortex.lifecycleV2.preview(query.agent_id);
  });

  app.post('/api/v2/lifecycle/run', async (req) => {
    const body = req.body as Record<string, string | undefined> | undefined;
    return cortex.lifecycleV2.run(body?.agent_id);
  });

  app.get('/api/v2/lifecycle/log', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return cortex.lifecycleV2.logs(
      query.limit ? parseInt(query.limit, 10) : undefined,
      query.offset ? parseInt(query.offset, 10) : undefined,
      query.agent_id,
    );
  });
}

import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import { getV2Stats } from '../v2/store.js';
import { observedRoute } from './observability.js';

export function registerV2StatsRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.get('/api/v2/stats', observedRoute({
    route: '/api/v2/stats',
    method: 'GET',
    timeoutMs: 5000,
    metricPrefix: 'v2_route',
  }, async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return {
      ...getV2Stats(query.agent_id),
      runtime: {
        legacy_mode: cortex.config.runtime.legacyMode,
        v1_routes_enabled: cortex.config.runtime.legacyMode,
      },
    };
  }));
}

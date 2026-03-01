import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';

export function registerLifecycleRoutes(app: FastifyInstance, cortex: CortexApp): void {
  // Manual trigger
  app.post('/api/v1/lifecycle/run', async (req) => {
    const body = req.body as any || {};
    const agentId = body.agent_id || undefined;
    const report = await cortex.lifecycle.run(body.dry_run || false, 'manual', agentId);
    return report;
  });

  // Preview (dry-run)
  app.get('/api/v1/lifecycle/preview', async (req) => {
    const q = req.query as any;
    return cortex.lifecycle.preview(q.agent_id || undefined);
  });

  // Get logs
  app.get('/api/v1/lifecycle/log', async (req) => {
    const q = req.query as any;
    const { getLifecycleLogs } = await import('../db/index.js');
    const limit = q.limit ? parseInt(q.limit) : 50;
    const logs = getLifecycleLogs(limit);

    // Filter by agent_id if provided
    if (q.agent_id) {
      return logs.filter((l: any) => {
        try {
          const details = l.details ? JSON.parse(l.details) : {};
          const logAgent = details.agent_id;
          // Match: exact agent or global runs ('all'); legacy logs without agent_id only show in unfiltered view
          return logAgent === q.agent_id || logAgent === 'all';
        } catch { return true; }
      });
    }

    return logs;
  });
}

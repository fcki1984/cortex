import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import { getAgentById } from '../db/agent-queries.js';
import { createLogger } from '../utils/logger.js';
import { observedRoute } from './observability.js';
import {
  extractRetainMissionFromConfigOverride,
  resolveEffectiveRetainMission,
} from '../v2/retain-mission.js';

const log = createLogger('review-inbox-v2');

export function registerV2ReviewInboxRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.get('/api/v2/review-inbox', observedRoute({
    route: '/api/v2/review-inbox',
    method: 'GET',
    timeoutMs: 20000,
    metricPrefix: 'v2_route',
  }, async (req) => {
    const query = req.query as {
      agent_id?: string;
      status?: 'pending' | 'partially_applied' | 'completed' | 'dismissed';
      source_kind?: 'live_ingest' | 'import_preview';
      limit?: string;
      offset?: string;
      cursor?: string;
    };

    return cortex.reviewInboxV2.listBatches({
      agent_id: query.agent_id,
      status: query.status,
      source_kind: query.source_kind,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      cursor: query.cursor,
    });
  }));

  app.get('/api/v2/review-inbox/:id', observedRoute({
    route: '/api/v2/review-inbox/:id',
    method: 'GET',
    timeoutMs: 20000,
    metricPrefix: 'v2_route',
  }, async (req, reply) => {
    const params = req.params as { id: string };
    const batch = cortex.reviewInboxV2.getBatch(params.id);
    if (!batch) {
      reply.code(404);
      return { error: 'review batch not found' };
    }
    return batch;
  }));

  app.post('/api/v2/review-inbox/import', async (req, reply) => {
    const body = req.body as {
      agent_id?: string;
      format?: 'text' | 'memory_md' | 'json';
      content?: string;
      filename?: string;
    };

    if (!body.agent_id) {
      reply.code(400);
      return { error: 'agent_id is required' };
    }
    if (!body.content?.trim()) {
      reply.code(400);
      return { error: 'content is required' };
    }
    if (body.format !== 'text' && body.format !== 'memory_md') {
      reply.code(400);
      return { error: 'review inbox import only supports text and memory_md' };
    }

    try {
      const agent = getAgentById(body.agent_id);
      const retainMission = resolveEffectiveRetainMission({
        globalMission: cortex.config.sieve?.retainMission,
        agentOverride: extractRetainMissionFromConfigOverride(
          agent?.config_override ? JSON.parse(agent.config_override) : null,
        ),
      });
      const result = await cortex.reviewInboxV2.createImportBatch({
        agent_id: body.agent_id,
        format: body.format,
        content: body.content,
        source_label: body.filename,
        retain_mission: retainMission,
      });
      reply.code(201);
      return {
        batch_id: result.batch?.id || null,
        source_preview: result.batch?.source_preview || null,
        auto_committed_count: result.auto_committed_count,
        mission_filtered_count: result.mission_filtered_count,
        summary: result.summary,
      };
    } catch (error: any) {
      log.warn({ error: error.message }, 'review inbox import failed');
      reply.code(400);
      return { error: error.message };
    }
  });

  app.post('/api/v2/review-inbox/:id/apply', async (req, reply) => {
    const params = req.params as { id: string };
    const body = req.body as {
      apply_suggested?: boolean;
      accept_all?: boolean;
      reject_all?: boolean;
      item_actions?: Array<{
        item_id: string;
        action: 'accept' | 'reject' | 'edit_then_accept';
        payload_override?: Record<string, unknown>;
      }>;
    };

    try {
      return await cortex.reviewInboxV2.applyBatch({
        batch_id: params.id,
        apply_suggested: body?.apply_suggested,
        accept_all: body?.accept_all,
        reject_all: body?.reject_all,
        item_actions: Array.isArray(body?.item_actions) ? body.item_actions : [],
      });
    } catch (error: any) {
      const statusCode = error.message === 'review batch not found' ? 404 : 400;
      reply.code(statusCode);
      return { error: error.message };
    }
  });
}

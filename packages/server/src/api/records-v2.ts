import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import { ensureAgent } from '../db/index.js';

export function registerV2RecordRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.get('/api/v2/records', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return cortex.recordsV2.listRecords({
      agent_id: query.agent_id,
      kind: query.kind as any,
      source_type: query.source_type as any,
      include_inactive: query.include_inactive === 'true',
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
      order_by: query.order_by as any,
      order_dir: query.order_dir as any,
      query: query.query,
    });
  });

  app.get('/api/v2/records/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = cortex.recordsV2.getRecord(id);
    if (!record) {
      reply.code(404);
      return { error: 'Record not found' };
    }
    return {
      ...record,
      evidence: cortex.recordsV2.getEvidence(id),
    };
  });

  app.post('/api/v2/records', async (req, reply) => {
    const body = req.body as any;
    if (body.agent_id) ensureAgent(body.agent_id);
    const result = await cortex.recordsV2.remember({
      agent_id: body.agent_id,
      kind: body.kind,
      content: body.content,
      source_type: body.source_type,
      tags: body.tags,
      priority: body.priority,
      subject_key: body.subject_key,
      attribute_key: body.attribute_key,
      entity_key: body.entity_key,
      state_key: body.state_key,
      owner_scope: body.owner_scope,
      status: body.status,
      session_id: body.session_id,
    });
    reply.code(201);
    return {
      record: result.record,
      decision: result.decision,
      previous_record_id: result.previous_record_id,
    };
  });

  app.patch('/api/v2/records/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const record = await cortex.recordsV2.updateRecord(id, {
      content: body.content,
      tags: body.tags,
      priority: body.priority,
      source_type: body.source_type,
      status: body.status,
    });
    if (!record) {
      reply.code(404);
      return { error: 'Record not found' };
    }
    return record;
  });

  app.delete('/api/v2/records/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await cortex.recordsV2.deleteRecord(id);
    if (!ok) {
      reply.code(404);
      return { error: 'Record not found' };
    }
    return { ok: true, id };
  });
}

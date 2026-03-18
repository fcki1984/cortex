import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';

export function registerV2RelationsRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.get('/api/v2/relations', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return cortex.relationsV2.listRelations({
      agent_id: query.agent_id,
      subject: query.subject,
      object: query.object,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  });

  app.post('/api/v2/relations', async (req, reply) => {
    const body = req.body as any;
    const relation = cortex.relationsV2.createRelation({
      agent_id: body.agent_id,
      source_record_id: body.source_record_id,
      source_evidence_id: body.source_evidence_id,
      subject_key: body.subject_key,
      predicate: body.predicate,
      object_key: body.object_key,
      confidence: body.confidence,
      metadata: body.metadata,
    });
    reply.code(201);
    return relation;
  });

  app.delete('/api/v2/relations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = cortex.relationsV2.deleteRelation(id);
    if (!ok) {
      reply.code(404);
      return { error: 'Relation not found' };
    }
    return { ok: true, id };
  });
}

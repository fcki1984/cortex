import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';

function parseOptionalJsonBody(_req: any, body: string, done: (error: Error | null, value?: unknown) => void): void {
  const trimmed = body.trim();
  if (!trimmed) {
    done(null, {});
    return;
  }

  try {
    done(null, JSON.parse(trimmed));
  } catch (error) {
    done(error as Error);
  }
}

export function registerV2RelationsRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.get('/api/v2/relation-candidates', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return cortex.relationsV2.listCandidates({
      agent_id: query.agent_id,
      subject: query.subject,
      object: query.object,
      status: query.status as 'pending' | 'confirmed' | 'rejected' | undefined,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  });

  app.post('/api/v2/relation-candidates', async (req, reply) => {
    const body = req.body as any;
    const candidate = cortex.relationsV2.createCandidate({
      agent_id: body.agent_id,
      source_record_id: body.source_record_id,
      source_evidence_id: body.source_evidence_id,
      subject_key: body.subject_key,
      predicate: body.predicate,
      object_key: body.object_key,
      confidence: body.confidence,
      status: body.status,
      metadata: body.metadata,
    });
    reply.code(201);
    return candidate;
  });

  app.patch('/api/v2/relation-candidates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const candidate = cortex.relationsV2.updateCandidate(id, {
      subject_key: body.subject_key,
      predicate: body.predicate,
      object_key: body.object_key,
      confidence: body.confidence,
      status: body.status,
      metadata: body.metadata,
    });
    if (!candidate) {
      reply.code(404);
      return { error: 'Relation candidate not found' };
    }
    return candidate;
  });

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, parseOptionalJsonBody);

    scope.post('/api/v2/relation-candidates/:id/confirm', async (req, reply) => {
      const { id } = req.params as { id: string };
      const confirmed = cortex.relationsV2.confirmCandidate(id);
      if (!confirmed) {
        reply.code(404);
        return { error: 'Relation candidate not found' };
      }
      reply.code(201);
      return confirmed;
    });
  });

  app.delete('/api/v2/relation-candidates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = cortex.relationsV2.deleteCandidate(id);
    if (!ok) {
      reply.code(404);
      return { error: 'Relation candidate not found' };
    }
    return { ok: true, id };
  });

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

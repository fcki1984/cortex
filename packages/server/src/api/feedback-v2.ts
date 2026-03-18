import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';

export function registerV2FeedbackRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.post('/api/v2/feedback', async (req, reply) => {
    const body = req.body as any;
    const result = cortex.feedbackV2.submitFeedback({
      agent_id: body.agent_id,
      record_id: body.record_id,
      evidence_id: body.evidence_id,
      extraction_log_id: body.extraction_log_id,
      feedback: body.feedback,
      reason: body.reason,
      corrected_content: body.corrected_content,
    });
    reply.code(201);
    return result;
  });

  app.get('/api/v2/feedback/stats', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return cortex.feedbackV2.stats(query.agent_id);
  });
}

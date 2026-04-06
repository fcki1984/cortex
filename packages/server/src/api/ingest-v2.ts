import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import { ensureAgent } from '../db/index.js';
import { insertExtractionLog } from '../core/extraction-log.js';

function logCategoryFromKind(kind: string): 'preference' | 'fact' | 'goal' | 'summary' {
  switch (kind) {
    case 'profile_rule':
      return 'preference';
    case 'fact_slot':
      return 'fact';
    case 'task_state':
      return 'goal';
    default:
      return 'summary';
  }
}

function logSourceFromSourceType(sourceType: string): 'user_stated' | 'user_implied' | 'observed_pattern' {
  switch (sourceType) {
    case 'user_explicit':
    case 'user_confirmed':
      return 'user_stated';
    case 'assistant_inferred':
      return 'user_implied';
    default:
      return 'observed_pattern';
  }
}

export function registerV2IngestRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.post('/api/v2/ingest', async (req, reply) => {
    const startedAt = Date.now();
    const body = req.body as any;
    if (body.agent_id) ensureAgent(body.agent_id);

    const result = await cortex.recordsV2.ingest({
      user_message: body.user_message || '',
      assistant_message: body.assistant_message || '',
      messages: body.messages,
      agent_id: body.agent_id,
      session_id: body.session_id,
    });
    const reviewBatch = result.review_record_candidates.length > 0
      ? cortex.reviewInboxV2.createLiveBatch({
          agent_id: body.agent_id || 'default',
          conversation_ref_id: result.conversation_ref_id,
          session_id: body.session_id,
          source_preview: [body.user_message || '', body.assistant_message || ''].filter(Boolean).join('\n').slice(0, 500),
          items: result.review_record_candidates,
        })
      : null;
    cortex.reviewInboxV2.reconcileLiveBatchesAgainstActiveTruth(body.agent_id || 'default');
    const refreshedReviewBatch = reviewBatch?.batch?.id
      ? cortex.reviewInboxV2.getBatch(reviewBatch.batch.id)
      : null;

    if (cortex.config.sieve.extractionLogging) {
      insertExtractionLog(body.agent_id || 'default', body.session_id, {
        channel: 'v2',
        exchange_preview: [body.user_message || '', body.assistant_message || ''].filter(Boolean).join('\n').slice(0, 500),
        raw_output: JSON.stringify(result.records),
        parsed_memories: result.records.map((record) => ({
          content: record.content,
          category: logCategoryFromKind(record.written_kind),
          importance: 0.7,
          source: logSourceFromSourceType(record.source_type),
          reasoning: `${record.decision}${record.reason_code ? ` (${record.reason_code})` : ''}`,
          requested_kind: record.requested_kind,
          written_kind: record.written_kind,
          normalization: record.normalization,
          reason_code: record.reason_code,
        })),
        memories_written: result.records.filter(record => record.decision !== 'ignored').length,
        memories_deduped: result.records.filter(record => record.decision === 'ignored').length,
        memories_smart_updated: result.records.filter(record => record.decision === 'updated').length,
        latency_ms: Date.now() - startedAt,
      });
    }

    reply.code(201);
    return {
      records: result.records,
      conversation_ref_id: result.conversation_ref_id,
      skipped: result.skipped,
      review_batch_id: refreshedReviewBatch?.batch.id || reviewBatch?.batch?.id || null,
      review_pending_count: refreshedReviewBatch?.summary.pending || reviewBatch?.summary.pending || 0,
      review_source_preview: refreshedReviewBatch?.batch.source_preview || reviewBatch?.batch?.source_preview || null,
      review_summary: refreshedReviewBatch?.summary || reviewBatch?.summary || null,
      auto_committed_count: result.records.length,
    };
  });
}

import { getDb } from '../db/connection.js';
import { generateId } from '../utils/helpers.js';
import { getRecordById, listEvidence, supersedeRecordById } from './store.js';
import type { CortexRecord, RecordUpsertResult, SourceType } from './types.js';
import type { CortexRecordsV2 } from './service.js';

type FeedbackKind = 'good' | 'bad' | 'corrected';

type FeedbackRow = {
  id: string;
  agent_id: string;
  record_id: string;
  evidence_id: number | null;
  extraction_log_id: string | null;
  feedback: FeedbackKind;
  reason: string | null;
  corrected_content: string | null;
  correction_record_id: string | null;
  created_at: string;
};

function rememberInputFromRecord(record: CortexRecord, content: string): Record<string, unknown> {
  const tags = [...new Set([...record.tags, 'feedback_corrected'])];
  const sourceType: SourceType = record.kind === 'session_note' ? 'system_derived' : 'user_confirmed';

  switch (record.kind) {
    case 'profile_rule':
      return {
        kind: 'profile_rule',
        agent_id: record.agent_id,
        source_type: sourceType,
        tags,
        priority: record.priority,
        content,
        owner_scope: record.owner_scope,
        subject_key: record.subject_key,
        attribute_key: record.attribute_key,
      };
    case 'fact_slot':
      return {
        kind: 'fact_slot',
        agent_id: record.agent_id,
        source_type: sourceType,
        tags,
        priority: record.priority,
        content,
        entity_key: record.entity_key,
        attribute_key: record.attribute_key,
      };
    case 'task_state':
      return {
        kind: 'task_state',
        agent_id: record.agent_id,
        source_type: sourceType,
        tags,
        priority: record.priority,
        content,
        subject_key: record.subject_key,
        state_key: record.state_key,
        status: record.status,
      };
    case 'session_note':
      return {
        kind: 'session_note',
        agent_id: record.agent_id,
        source_type: sourceType,
        tags,
        priority: record.priority,
        content,
        session_id: record.session_id,
      };
  }
}

export class CortexFeedbackV2 {
  constructor(private records: CortexRecordsV2) {}

  submitFeedback(input: {
    agent_id?: string;
    record_id: string;
    evidence_id?: number | null;
    extraction_log_id?: string | null;
    feedback: FeedbackKind;
    reason?: string;
    corrected_content?: string;
  }): Promise<{ feedback: FeedbackRow; correction: RecordUpsertResult | null }> {
    const db = getDb();
    const record = getRecordById(input.record_id);
    if (!record) {
      throw new Error('Record not found');
    }
    if (input.agent_id && input.agent_id !== record.agent_id) {
      throw new Error('Record agent does not match feedback agent');
    }
    if (input.feedback === 'corrected' && !input.corrected_content?.trim()) {
      throw new Error('corrected_content is required');
    }

    let correction: RecordUpsertResult | null = null;
    if (input.feedback === 'corrected') {
      const result = this.records.remember(rememberInputFromRecord(record, input.corrected_content!.trim()) as any);
      return Promise.resolve(result).then((resolved) => {
        correction = resolved;
        if (record.kind === 'session_note' && resolved.record.id !== record.id) {
          supersedeRecordById(record.id, resolved.record.id);
          correction = {
            ...resolved,
            decision: 'superseded',
            previous_record_id: record.id,
          };
        }

        const evidence = listEvidence(record.id);
        const chosenEvidenceId = input.evidence_id ?? evidence[0]?.id ?? null;
        if (chosenEvidenceId != null && !evidence.some(item => item.id === chosenEvidenceId)) {
          throw new Error('Evidence does not belong to record');
        }

        const id = generateId();
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO record_feedback_v2 (
            id, agent_id, record_id, evidence_id, extraction_log_id, feedback, reason, corrected_content, correction_record_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          input.agent_id || record.agent_id,
          record.id,
          chosenEvidenceId,
          input.extraction_log_id || null,
          input.feedback,
          input.reason || null,
          input.corrected_content || null,
          resolved.record.id,
          now,
        );

        const feedback = db.prepare('SELECT * FROM record_feedback_v2 WHERE id = ?').get(id) as FeedbackRow | undefined;
        if (!feedback) {
          throw new Error('Failed to store feedback');
        }

        return { feedback, correction };
      });
    }

    const evidence = listEvidence(record.id);
    const chosenEvidenceId = input.evidence_id ?? evidence[0]?.id ?? null;
    if (chosenEvidenceId != null && !evidence.some(item => item.id === chosenEvidenceId)) {
      throw new Error('Evidence does not belong to record');
    }

    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO record_feedback_v2 (
        id, agent_id, record_id, evidence_id, extraction_log_id, feedback, reason, corrected_content, correction_record_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agent_id || record.agent_id,
      record.id,
      chosenEvidenceId,
      input.extraction_log_id || null,
      input.feedback,
      input.reason || null,
      input.corrected_content || null,
      null,
      now,
    );

    const feedback = db.prepare('SELECT * FROM record_feedback_v2 WHERE id = ?').get(id) as FeedbackRow | undefined;
    if (!feedback) {
      throw new Error('Failed to store feedback');
    }

    return Promise.resolve({ feedback, correction });
  }

  stats(agentId?: string): Record<string, number> {
    const db = getDb();
    const rows = agentId
      ? db.prepare('SELECT feedback, COUNT(*) as cnt FROM record_feedback_v2 WHERE agent_id = ? GROUP BY feedback').all(agentId) as Array<{ feedback: FeedbackKind; cnt: number }>
      : db.prepare('SELECT feedback, COUNT(*) as cnt FROM record_feedback_v2 GROUP BY feedback').all() as Array<{ feedback: FeedbackKind; cnt: number }>;

    const summary = { good: 0, bad: 0, corrected: 0 };
    for (const row of rows) {
      summary[row.feedback] = row.cnt;
    }
    return summary;
  }
}

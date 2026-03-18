import { getDb } from '../db/connection.js';
import { generateId } from '../utils/helpers.js';
import { getRecordById, listEvidence } from './store.js';
import type { CortexRecord, RecordEvidence } from './types.js';

type RelationRow = {
  id: string;
  agent_id: string;
  source_record_id: string;
  source_evidence_id: number | null;
  subject_key: string;
  predicate: string;
  object_key: string;
  confidence: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
};

export type V2Relation = RelationRow & {
  source_record: CortexRecord | null;
  source_evidence: RecordEvidence | null;
};

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_\-\u4e00-\u9fff]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 120);
}

function normalizePredicate(value: string): string {
  return normalizeKey(value).replace(/_+/g, '_');
}

function inflateRelation(row: RelationRow): V2Relation {
  const sourceEvidence = row.source_evidence_id == null
    ? null
    : listEvidence(row.source_record_id).find(item => item.id === row.source_evidence_id) || null;

  return {
    ...row,
    source_record: getRecordById(row.source_record_id),
    source_evidence: sourceEvidence,
  };
}

export class CortexRelationsV2 {
  listRelations(opts: { agent_id?: string; subject?: string; object?: string; limit?: number; offset?: number } = {}): { items: V2Relation[]; total: number } {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.agent_id) {
      conditions.push('agent_id = ?');
      params.push(opts.agent_id);
    }
    if (opts.subject) {
      conditions.push('subject_key = ?');
      params.push(normalizeKey(opts.subject));
    }
    if (opts.object) {
      conditions.push('object_key = ?');
      params.push(normalizeKey(opts.object));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM record_relations_v2 ${where}`).get(...params) as { cnt: number }).cnt;
    const rows = db.prepare(`
      SELECT *
      FROM record_relations_v2
      ${where}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RelationRow[];

    return {
      items: rows.map(inflateRelation),
      total,
    };
  }

  createRelation(input: {
    agent_id?: string;
    source_record_id: string;
    source_evidence_id?: number | null;
    subject_key: string;
    predicate: string;
    object_key: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): V2Relation {
    const db = getDb();
    const sourceRecord = getRecordById(input.source_record_id);
    if (!sourceRecord) {
      throw new Error('Source record not found');
    }

    const agentId = input.agent_id || sourceRecord.agent_id;
    if (sourceRecord.agent_id !== agentId) {
      throw new Error('Source record agent does not match relation agent');
    }

    const evidence = listEvidence(sourceRecord.id);
    const sourceEvidenceId = input.source_evidence_id ?? evidence[0]?.id ?? null;
    const evidenceIsValid = sourceEvidenceId == null || evidence.some(item => item.id === sourceEvidenceId);
    if (!evidenceIsValid) {
      throw new Error('Source evidence does not belong to source record');
    }

    const id = generateId();
    const subjectKey = normalizeKey(input.subject_key);
    const objectKey = normalizeKey(input.object_key);
    const predicate = normalizePredicate(input.predicate);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO record_relations_v2 (
        id, agent_id, source_record_id, source_evidence_id, subject_key, predicate, object_key, confidence, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, source_record_id, subject_key, predicate, object_key)
      DO UPDATE SET
        source_evidence_id = excluded.source_evidence_id,
        confidence = excluded.confidence,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      id,
      agentId,
      sourceRecord.id,
      sourceEvidenceId,
      subjectKey,
      predicate,
      objectKey,
      input.confidence ?? 0.8,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    );

    const row = db.prepare(`
      SELECT *
      FROM record_relations_v2
      WHERE agent_id = ? AND source_record_id = ? AND subject_key = ? AND predicate = ? AND object_key = ?
      LIMIT 1
    `).get(agentId, sourceRecord.id, subjectKey, predicate, objectKey) as RelationRow | undefined;

    if (!row) {
      throw new Error('Failed to create relation');
    }

    return inflateRelation(row);
  }

  deleteRelation(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM record_relations_v2 WHERE id = ?').run(id);
    return result.changes > 0;
  }
}

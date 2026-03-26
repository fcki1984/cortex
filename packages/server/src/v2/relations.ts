import { getDb } from '../db/connection.js';
import { generateId } from '../utils/helpers.js';
import { relationPredicateForFactAttribute } from './contract.js';
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

type RelationCandidateStatus = 'pending' | 'confirmed' | 'rejected';

type RelationCandidateRow = {
  id: string;
  agent_id: string;
  source_record_id: string;
  source_evidence_id: number | null;
  subject_key: string;
  predicate: string;
  object_key: string;
  confidence: number;
  status: RelationCandidateStatus;
  metadata: string | null;
  created_at: string;
  updated_at: string;
};

export type V2Relation = RelationRow & {
  source_record: CortexRecord | null;
  source_evidence: RecordEvidence | null;
};

export type V2RelationCandidate = RelationCandidateRow & {
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

function inflateCandidate(row: RelationCandidateRow): V2RelationCandidate {
  const sourceEvidence = row.source_evidence_id == null
    ? null
    : listEvidence(row.source_record_id).find(item => item.id === row.source_evidence_id) || null;

  return {
    ...row,
    source_record: getRecordById(row.source_record_id),
    source_evidence: sourceEvidence,
  };
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function extractTail(content: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }
  return content.trim();
}

function deriveObjectKey(record: CortexRecord): string | null {
  const content = record.content.trim();
  if (!content) return null;

  if (record.kind === 'fact_slot') {
    switch (record.attribute_key) {
      case 'location':
        return normalizeKey(extractTail(content, [
          /(?:我|用户)?住(?:在)?\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
          /\blive(?:s|d|ing)?\s+in\s+([a-z0-9_\- ]+)/i,
          /\bbased in\s+([a-z0-9_\- ]+)/i,
          /\bfrom\s+([a-z0-9_\- ]+)/i,
          /来自\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
          /位于\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        ]));
      case 'organization':
        return normalizeKey(extractTail(content, [
          /(?:我|用户)?在\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*工作/i,
          /\bwork(?:s|ed|ing)?\s+(?:at|for|in)\s+([a-z0-9_\- ]+)/i,
        ]));
      case 'occupation':
        return normalizeKey(extractTail(content, [
          /(?:我|用户)?是\s*(.+)$/i,
          /\bi(?:'m| am)\s+(?:a |an )?(.+)$/i,
        ]));
      case 'relationship':
      case 'skill':
        return normalizeKey(content);
      default:
        return null;
    }
  }
  return null;
}

function deriveSubjectKey(record: CortexRecord): string | null {
  switch (record.kind) {
    case 'fact_slot':
      return normalizeKey(record.entity_key);
    case 'task_state':
      return normalizeKey(record.subject_key);
    default:
      return null;
  }
}

function derivePredicate(record: CortexRecord): string | null {
  switch (record.kind) {
    case 'fact_slot':
      return relationPredicateForFactAttribute(record.attribute_key);
    default:
      return null;
  }
}

function defaultEvidenceId(recordId: string): number | null {
  const evidence = listEvidence(recordId);
  return evidence.find(item => item.role === 'user')?.id ?? evidence[0]?.id ?? null;
}

function candidateMetadata(input: {
  derived_from?: string;
  confirmed_relation_id?: string;
  [key: string]: unknown;
}): string | null {
  const next = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return Object.keys(next).length > 0 ? JSON.stringify(next) : null;
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

  listCandidates(opts: {
    agent_id?: string;
    subject?: string;
    object?: string;
    status?: RelationCandidateStatus;
    limit?: number;
    offset?: number;
  } = {}): { items: V2RelationCandidate[]; total: number } {
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
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM relation_candidates_v2 ${where}`).get(...params) as { cnt: number }).cnt;
    const rows = db.prepare(`
      SELECT *
      FROM relation_candidates_v2
      ${where}
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
        updated_at DESC,
        created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RelationCandidateRow[];

    return {
      items: rows.map(inflateCandidate),
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

  createCandidate(input: {
    agent_id?: string;
    source_record_id: string;
    source_evidence_id?: number | null;
    subject_key: string;
    predicate: string;
    object_key: string;
    confidence?: number;
    status?: RelationCandidateStatus;
    metadata?: Record<string, unknown>;
  }): V2RelationCandidate {
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
    const status = input.status || 'pending';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO relation_candidates_v2 (
        id, agent_id, source_record_id, source_evidence_id, subject_key, predicate, object_key, confidence, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, source_record_id, subject_key, predicate, object_key)
      DO UPDATE SET
        source_evidence_id = excluded.source_evidence_id,
        confidence = excluded.confidence,
        status = excluded.status,
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
      status,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    );

    const row = db.prepare(`
      SELECT *
      FROM relation_candidates_v2
      WHERE agent_id = ? AND source_record_id = ? AND subject_key = ? AND predicate = ? AND object_key = ?
      LIMIT 1
    `).get(agentId, sourceRecord.id, subjectKey, predicate, objectKey) as RelationCandidateRow | undefined;

    if (!row) {
      throw new Error('Failed to create relation candidate');
    }

    return inflateCandidate(row);
  }

  updateCandidate(id: string, patch: {
    subject_key?: string;
    predicate?: string;
    object_key?: string;
    confidence?: number;
    status?: RelationCandidateStatus;
    metadata?: Record<string, unknown>;
  }): V2RelationCandidate | null {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM relation_candidates_v2 WHERE id = ?').get(id) as RelationCandidateRow | undefined;
    if (!existing) return null;

    const nextSubject = normalizeKey(patch.subject_key || existing.subject_key);
    const nextPredicate = normalizePredicate(patch.predicate || existing.predicate);
    const nextObject = normalizeKey(patch.object_key || existing.object_key);
    const nextConfidence = patch.confidence ?? existing.confidence;
    const nextStatus = patch.status || existing.status;
    const nextMetadata = patch.metadata ? JSON.stringify(patch.metadata) : existing.metadata;

    db.prepare(`
      UPDATE relation_candidates_v2
      SET subject_key = ?, predicate = ?, object_key = ?, confidence = ?, status = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextSubject,
      nextPredicate,
      nextObject,
      nextConfidence,
      nextStatus,
      nextMetadata,
      new Date().toISOString(),
      id,
    );

    const row = db.prepare('SELECT * FROM relation_candidates_v2 WHERE id = ?').get(id) as RelationCandidateRow | undefined;
    return row ? inflateCandidate(row) : null;
  }

  confirmCandidate(id: string): { candidate: V2RelationCandidate; relation: V2Relation } | null {
    const db = getDb();
    const candidate = db.prepare('SELECT * FROM relation_candidates_v2 WHERE id = ?').get(id) as RelationCandidateRow | undefined;
    if (!candidate) return null;

    const relation = this.createRelation({
      agent_id: candidate.agent_id,
      source_record_id: candidate.source_record_id,
      source_evidence_id: candidate.source_evidence_id,
      subject_key: candidate.subject_key,
      predicate: candidate.predicate,
      object_key: candidate.object_key,
      confidence: candidate.confidence,
      metadata: {
        ...parseMetadata(candidate.metadata),
        candidate_id: candidate.id,
      },
    });

    const nextMetadata = candidateMetadata({
      ...parseMetadata(candidate.metadata),
      confirmed_relation_id: relation.id,
    });
    db.prepare(`
      UPDATE relation_candidates_v2
      SET status = 'confirmed', metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(nextMetadata, new Date().toISOString(), id);

    const updated = db.prepare('SELECT * FROM relation_candidates_v2 WHERE id = ?').get(id) as RelationCandidateRow | undefined;
    if (!updated) {
      throw new Error('Confirmed relation candidate not found');
    }

    return {
      candidate: inflateCandidate(updated),
      relation,
    };
  }

  deleteRelation(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM record_relations_v2 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteCandidate(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM relation_candidates_v2 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deletePendingCandidateForTriple(input: {
    agent_id: string;
    source_record_id: string;
    subject_key: string;
    predicate: string;
    object_key: string;
  }): number {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM relation_candidates_v2
      WHERE agent_id = ?
        AND source_record_id = ?
        AND subject_key = ?
        AND predicate = ?
        AND object_key = ?
        AND status = 'pending'
    `).run(
      input.agent_id,
      input.source_record_id,
      normalizeKey(input.subject_key),
      normalizePredicate(input.predicate),
      normalizeKey(input.object_key),
    );
    return result.changes;
  }

  createDerivedCandidates(recordId: string): V2RelationCandidate[] {
    const record = getRecordById(recordId);
    if (!record || record.kind !== 'fact_slot') return [];
    if (record.source_type !== 'user_explicit' && record.source_type !== 'user_confirmed') return [];

    const subjectKey = deriveSubjectKey(record);
    const predicate = derivePredicate(record);
    const objectKey = deriveObjectKey(record);
    if (!subjectKey || !predicate || !objectKey) return [];

    return [
      this.createCandidate({
        agent_id: record.agent_id,
        source_record_id: record.id,
        source_evidence_id: defaultEvidenceId(record.id),
        subject_key: subjectKey,
        predicate,
        object_key: objectKey,
        confidence: 0.78,
        status: 'pending',
        metadata: {
          derived_from: record.kind,
        },
      }),
    ];
  }

  refreshDerivedCandidates(recordId: string): V2RelationCandidate[] {
    const db = getDb();
    db.prepare("DELETE FROM relation_candidates_v2 WHERE source_record_id = ? AND status = 'pending'").run(recordId);
    return this.createDerivedCandidates(recordId);
  }
}

import { getDb } from '../db/connection.js';
import { generateId } from '../utils/helpers.js';
import { tokenize, tokenizeQuery } from '../utils/tokenizer.js';
import type { Memory } from '../db/index.js';
import type {
  CortexRecord,
  EvidenceInput,
  FactSlotCandidate,
  FactSlotRecord,
  ProfileRuleCandidate,
  ProfileRuleRecord,
  RecordCandidate,
  RecordEvidence,
  RecordKind,
  RecordListOptions,
  RecordUpsertResult,
  SessionNoteCandidate,
  SessionNoteRecord,
  SourceType,
  TaskStateCandidate,
  TaskStateRecord,
} from './types.js';
import { legacyMemoryToCandidate } from './normalize.js';

type RegistryRow = {
  id: string;
  kind: RecordKind;
  agent_id: string;
  source_type: SourceType;
  searchable_text: string;
  tags_json: string;
  priority: number;
  is_active: number;
  created_at: string;
  updated_at: string;
};

type SearchHit = { id: string; score: number };

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    return [];
  }
}

function uniqueTags(tags: string[] | undefined): string[] {
  return [...new Set((tags || []).map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
}

function recordContent(candidate: RecordCandidate): string {
  switch (candidate.kind) {
    case 'profile_rule':
      return candidate.value_text.trim();
    case 'fact_slot':
      return candidate.value_text.trim();
    case 'task_state':
      return candidate.summary.trim();
    case 'session_note':
      return candidate.summary.trim();
  }
}

function searchableText(candidate: RecordCandidate): string {
  const explicit = candidate.searchable_text?.trim();
  if (explicit) return explicit;

  switch (candidate.kind) {
    case 'profile_rule':
      return [
        candidate.value_text,
        candidate.subject_key,
        candidate.attribute_key,
        candidate.owner_scope,
        ...(candidate.tags || []),
      ].join(' ');
    case 'fact_slot':
      return [
        candidate.value_text,
        candidate.entity_key,
        candidate.attribute_key,
        ...(candidate.tags || []),
      ].join(' ');
    case 'task_state':
      return [
        candidate.summary,
        candidate.subject_key,
        candidate.state_key,
        candidate.status,
        ...(candidate.tags || []),
      ].join(' ');
    case 'session_note':
      return [candidate.summary, ...(candidate.tags || [])].join(' ');
  }
}

function sanitizeFtsQuery(query: string): string {
  return tokenizeQuery(query)
    .replace(/["\*\(\)\{\}\[\]\+\~\^\:\;\!\?\<\>\=\&\|\\\/@#\$%`',._-]/g, ' ')
    .replace(/[\u3000-\u303F\uFF00-\uFF60\u2000-\u206F\u2E00-\u2E7F\u00A0-\u00BF\u2018-\u201F\u2026\u2014\u2013]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function normalizeScoreFromRank(rank: number): number {
  const abs = Math.abs(rank);
  return 1 / (1 + abs);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function syncFtsDeleteById(id: string): void {
  const db = getDb();
  const row = db.prepare('SELECT rowid FROM record_registry WHERE id = ?').get(id) as { rowid: number } | undefined;
  if (!row) return;
  try {
    db.prepare('DELETE FROM record_registry_fts WHERE rowid = ?').run(row.rowid);
  } catch {
    // ignore if the row was never indexed
  }
}

function syncFtsInsert(id: string, searchable: string, kind: RecordKind, tags: string[]): void {
  const db = getDb();
  const row = db.prepare('SELECT rowid FROM record_registry WHERE id = ?').get(id) as { rowid: number } | undefined;
  if (!row) return;
  db.prepare('INSERT INTO record_registry_fts(rowid, searchable_text, kind, tags) VALUES (?, ?, ?, ?)')
    .run(row.rowid, tokenize(searchable), kind, tags.join(' '));
}

function syncFtsUpdate(id: string, searchable: string, kind: RecordKind, tags: string[]): void {
  syncFtsDeleteById(id);
  syncFtsInsert(id, searchable, kind, tags);
}

function getRegistryById(id: string): RegistryRow | null {
  const db = getDb();
  return db.prepare('SELECT * FROM record_registry WHERE id = ?').get(id) as RegistryRow | null;
}

function getProfileRuleById(base: RegistryRow): ProfileRuleRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM profile_rules WHERE id = ?').get(base.id) as {
    owner_scope: 'user' | 'agent';
    subject_key: string;
    attribute_key: string;
    value_text: string;
    value_json: string | null;
    confidence: number;
    last_confirmed_at: string | null;
    superseded_by: string | null;
    metadata: string | null;
  } | undefined;
  if (!row) return null;
  return {
    ...base,
    kind: 'profile_rule',
    tags: parseTags(base.tags_json),
    content: row.value_text,
    owner_scope: row.owner_scope,
    subject_key: row.subject_key,
    attribute_key: row.attribute_key,
    value_text: row.value_text,
    value_json: row.value_json,
    confidence: row.confidence,
    last_confirmed_at: row.last_confirmed_at,
    superseded_by: row.superseded_by,
    metadata: row.metadata,
  };
}

function getFactSlotById(base: RegistryRow): FactSlotRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM fact_slots WHERE id = ?').get(base.id) as {
    entity_key: string;
    attribute_key: string;
    value_text: string;
    value_json: string | null;
    confidence: number;
    valid_from: string | null;
    valid_to: string | null;
    superseded_by: string | null;
    metadata: string | null;
  } | undefined;
  if (!row) return null;
  return {
    ...base,
    kind: 'fact_slot',
    tags: parseTags(base.tags_json),
    content: row.value_text,
    entity_key: row.entity_key,
    attribute_key: row.attribute_key,
    value_text: row.value_text,
    value_json: row.value_json,
    confidence: row.confidence,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    superseded_by: row.superseded_by,
    metadata: row.metadata,
  };
}

function getTaskStateById(base: RegistryRow): TaskStateRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM task_states WHERE id = ?').get(base.id) as {
    subject_key: string;
    state_key: string;
    status: string;
    summary: string;
    confidence: number;
    last_confirmed_at: string | null;
    valid_to: string | null;
    superseded_by: string | null;
    metadata: string | null;
  } | undefined;
  if (!row) return null;
  return {
    ...base,
    kind: 'task_state',
    tags: parseTags(base.tags_json),
    content: row.summary,
    subject_key: row.subject_key,
    state_key: row.state_key,
    status: row.status,
    summary: row.summary,
    confidence: row.confidence,
    last_confirmed_at: row.last_confirmed_at,
    valid_to: row.valid_to,
    superseded_by: row.superseded_by,
    metadata: row.metadata,
  };
}

function getSessionNoteById(base: RegistryRow): SessionNoteRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM session_notes WHERE id = ?').get(base.id) as {
    session_id: string | null;
    summary: string;
    confidence: number;
    expires_at: string | null;
    superseded_by: string | null;
    metadata: string | null;
  } | undefined;
  if (!row) return null;
  return {
    ...base,
    kind: 'session_note',
    tags: parseTags(base.tags_json),
    content: row.summary,
    session_id: row.session_id,
    summary: row.summary,
    confidence: row.confidence,
    expires_at: row.expires_at,
    superseded_by: row.superseded_by,
    metadata: row.metadata,
  };
}

export function getRecordById(id: string): CortexRecord | null {
  const base = getRegistryById(id);
  if (!base) return null;
  switch (base.kind) {
    case 'profile_rule':
      return getProfileRuleById(base);
    case 'fact_slot':
      return getFactSlotById(base);
    case 'task_state':
      return getTaskStateById(base);
    case 'session_note':
      return getSessionNoteById(base);
  }
}

function recordIdsFromRegistryQuery(sql: string, params: unknown[]): string[] {
  const db = getDb();
  return (db.prepare(sql).all(...params) as { id: string }[]).map(row => row.id);
}

function orderedRecords(ids: string[]): CortexRecord[] {
  return ids
    .map(id => getRecordById(id))
    .filter((record): record is CortexRecord => !!record);
}

export function listRecords(opts: RecordListOptions = {}): { items: CortexRecord[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!opts.include_inactive) conditions.push('is_active = 1');
  if (opts.agent_id) {
    conditions.push('(agent_id = ? OR agent_id = \'\' OR agent_id IS NULL)');
    params.push(opts.agent_id);
  }
  if (opts.kind) {
    conditions.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.source_type) {
    conditions.push('source_type = ?');
    params.push(opts.source_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  if (opts.query?.trim()) {
    const hits = searchFts(opts.query, {
      agent_id: opts.agent_id,
      kind: opts.kind,
      source_type: opts.source_type,
      include_inactive: !!opts.include_inactive,
      limit: opts.limit || 50,
    });
    const ids = hits.map(hit => hit.id);
    return { items: orderedRecords(ids), total: hits.length };
  }

  const orderBy = opts.order_by || 'created_at';
  const orderDir = opts.order_dir || 'desc';
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM record_registry ${where}`).get(...params) as { cnt: number }).cnt;
  const ids = recordIdsFromRegistryQuery(
    `SELECT id FROM record_registry ${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { items: orderedRecords(ids), total };
}

function updateRegistryTimestamp(id: string): void {
  const db = getDb();
  db.prepare('UPDATE record_registry SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

function updateRegistryCommon(id: string, data: { searchable_text?: string; tags?: string[]; priority?: number; source_type?: SourceType; is_active?: number }): void {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (data.searchable_text !== undefined) {
    sets.push('searchable_text = ?');
    params.push(data.searchable_text);
  }
  if (data.tags !== undefined) {
    sets.push('tags_json = ?');
    params.push(JSON.stringify(uniqueTags(data.tags)));
  }
  if (data.priority !== undefined) {
    sets.push('priority = ?');
    params.push(data.priority);
  }
  if (data.source_type !== undefined) {
    sets.push('source_type = ?');
    params.push(data.source_type);
  }
  if (data.is_active !== undefined) {
    sets.push('is_active = ?');
    params.push(data.is_active);
  }
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  db.prepare(`UPDATE record_registry SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function insertRegistry(candidate: RecordCandidate, id: string, searchText: string, tags: string[]): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO record_registry (
      id, kind, agent_id, source_type, searchable_text, tags_json, priority, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    candidate.kind,
    candidate.agent_id,
    candidate.source_type,
    searchText,
    JSON.stringify(tags),
    candidate.priority ?? 0.7,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

function insertProfileRule(id: string, candidate: ProfileRuleCandidate): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO profile_rules (
      id, agent_id, owner_scope, subject_key, attribute_key, value_text, value_json,
      confidence, last_confirmed_at, superseded_by, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    candidate.agent_id,
    candidate.owner_scope,
    candidate.subject_key,
    candidate.attribute_key,
    candidate.value_text,
    candidate.value_json || null,
    candidate.confidence,
    candidate.last_confirmed_at || new Date().toISOString(),
    candidate.metadata || null,
  );
}

function insertFactSlot(id: string, candidate: FactSlotCandidate): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO fact_slots (
      id, agent_id, entity_key, attribute_key, value_text, value_json,
      confidence, valid_from, valid_to, superseded_by, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    candidate.agent_id,
    candidate.entity_key,
    candidate.attribute_key,
    candidate.value_text,
    candidate.value_json || null,
    candidate.confidence,
    candidate.valid_from || new Date().toISOString(),
    candidate.valid_to || null,
    candidate.metadata || null,
  );
}

function insertTaskState(id: string, candidate: TaskStateCandidate): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_states (
      id, agent_id, subject_key, state_key, status, summary, confidence,
      last_confirmed_at, valid_to, superseded_by, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    candidate.agent_id,
    candidate.subject_key,
    candidate.state_key,
    candidate.status,
    candidate.summary,
    candidate.confidence,
    candidate.last_confirmed_at || new Date().toISOString(),
    candidate.valid_to || null,
    candidate.metadata || null,
  );
}

function insertSessionNote(id: string, candidate: SessionNoteCandidate): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO session_notes (
      id, agent_id, session_id, summary, confidence, expires_at, superseded_by, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    candidate.agent_id,
    candidate.session_id || null,
    candidate.summary,
    candidate.confidence,
    candidate.expires_at || null,
    candidate.metadata || null,
  );
}

function insertRecordDetails(id: string, candidate: RecordCandidate): void {
  switch (candidate.kind) {
    case 'profile_rule':
      insertProfileRule(id, candidate);
      return;
    case 'fact_slot':
      insertFactSlot(id, candidate);
      return;
    case 'task_state':
      insertTaskState(id, candidate);
      return;
    case 'session_note':
      insertSessionNote(id, candidate);
      return;
  }
}

function updateExistingContent(candidate: RecordCandidate, existing: CortexRecord): void {
  const db = getDb();
  if (candidate.kind === 'profile_rule' && existing.kind === 'profile_rule') {
    db.prepare(`
      UPDATE profile_rules
      SET value_text = ?, value_json = ?, confidence = ?, last_confirmed_at = ?, metadata = ?
      WHERE id = ?
    `).run(candidate.value_text, candidate.value_json || null, candidate.confidence, new Date().toISOString(), candidate.metadata || null, existing.id);
  } else if (candidate.kind === 'fact_slot' && existing.kind === 'fact_slot') {
    db.prepare(`
      UPDATE fact_slots
      SET value_text = ?, value_json = ?, confidence = ?, valid_from = ?, valid_to = ?, metadata = ?
      WHERE id = ?
    `).run(candidate.value_text, candidate.value_json || null, candidate.confidence, candidate.valid_from || new Date().toISOString(), candidate.valid_to || null, candidate.metadata || null, existing.id);
  } else if (candidate.kind === 'task_state' && existing.kind === 'task_state') {
    db.prepare(`
      UPDATE task_states
      SET summary = ?, status = ?, confidence = ?, last_confirmed_at = ?, valid_to = ?, metadata = ?
      WHERE id = ?
    `).run(candidate.summary, candidate.status, candidate.confidence, new Date().toISOString(), candidate.valid_to || null, candidate.metadata || null, existing.id);
  } else if (candidate.kind === 'session_note' && existing.kind === 'session_note') {
    db.prepare(`
      UPDATE session_notes
      SET summary = ?, confidence = ?, expires_at = ?, metadata = ?
      WHERE id = ?
    `).run(candidate.summary, candidate.confidence, candidate.expires_at || null, candidate.metadata || null, existing.id);
  }
}

function supersedeRecord(existing: CortexRecord, newId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  switch (existing.kind) {
    case 'profile_rule':
      db.prepare('UPDATE profile_rules SET superseded_by = ?, last_confirmed_at = ? WHERE id = ?').run(newId, now, existing.id);
      break;
    case 'fact_slot':
      db.prepare('UPDATE fact_slots SET superseded_by = ?, valid_to = ? WHERE id = ?').run(newId, now, existing.id);
      break;
    case 'task_state':
      db.prepare('UPDATE task_states SET superseded_by = ?, valid_to = ?, last_confirmed_at = ? WHERE id = ?').run(newId, now, now, existing.id);
      break;
    case 'session_note':
      db.prepare('UPDATE session_notes SET superseded_by = ? WHERE id = ?').run(newId, existing.id);
      break;
  }
  updateRegistryCommon(existing.id, { is_active: 0 });
  deleteRecordVector(existing.id);
}

function equivalentContent(candidate: RecordCandidate, existing: CortexRecord): boolean {
  const left = recordContent(candidate).trim();
  const right = existing.content.trim();
  return left === right;
}

function mergeTagsFromExisting(candidate: RecordCandidate, existing: CortexRecord): string[] {
  return uniqueTags([...(existing.tags || []), ...(candidate.tags || [])]);
}

function findActiveMatch(candidate: RecordCandidate): CortexRecord | null {
  const db = getDb();
  if (candidate.kind === 'profile_rule') {
    const row = db.prepare(`
      SELECT id FROM profile_rules
      WHERE agent_id = ? AND owner_scope = ? AND subject_key = ? AND attribute_key = ? AND superseded_by IS NULL
      LIMIT 1
    `).get(candidate.agent_id, candidate.owner_scope, candidate.subject_key, candidate.attribute_key) as { id: string } | undefined;
    return row ? getRecordById(row.id) : null;
  }
  if (candidate.kind === 'fact_slot') {
    const row = db.prepare(`
      SELECT id FROM fact_slots
      WHERE agent_id = ? AND entity_key = ? AND attribute_key = ? AND superseded_by IS NULL AND valid_to IS NULL
      LIMIT 1
    `).get(candidate.agent_id, candidate.entity_key, candidate.attribute_key) as { id: string } | undefined;
    return row ? getRecordById(row.id) : null;
  }
  if (candidate.kind === 'task_state') {
    const row = db.prepare(`
      SELECT id FROM task_states
      WHERE agent_id = ? AND subject_key = ? AND state_key = ? AND superseded_by IS NULL AND valid_to IS NULL
      LIMIT 1
    `).get(candidate.agent_id, candidate.subject_key, candidate.state_key) as { id: string } | undefined;
    return row ? getRecordById(row.id) : null;
  }

  const notes = db.prepare(`
    SELECT sn.id, sn.summary
    FROM session_notes sn
    JOIN record_registry rr ON rr.id = sn.id
    WHERE sn.agent_id = ? AND COALESCE(sn.session_id, '') = COALESCE(?, '')
      AND rr.is_active = 1
      AND sn.superseded_by IS NULL
    ORDER BY rr.updated_at DESC
    LIMIT 5
  `).all(candidate.agent_id, candidate.session_id || null) as { id: string; summary: string }[];
  const matched = notes.find(note => note.summary.trim() === candidate.summary.trim());
  return matched ? getRecordById(matched.id) : null;
}

export function upsertRecord(candidate: RecordCandidate): RecordUpsertResult {
  const db = getDb();
  const tags = uniqueTags(candidate.tags);
  const searchText = searchableText(candidate);
  const matched = findActiveMatch(candidate);

  if (matched) {
    const mergedTags = mergeTagsFromExisting(candidate, matched);
    if (equivalentContent(candidate, matched)) {
      db.transaction(() => {
        updateExistingContent(candidate, matched);
        updateRegistryCommon(matched.id, {
          searchable_text: searchText,
          tags: mergedTags,
          priority: Math.max(matched.priority, candidate.priority ?? matched.priority),
          source_type: candidate.source_type,
          is_active: 1,
        });
        syncFtsUpdate(matched.id, searchText, matched.kind, mergedTags);
      })();
      const updated = getRecordById(matched.id);
      if (!updated) throw new Error('Updated record not found');
      return { decision: 'updated', record: updated };
    }

    const id = generateId();
    db.transaction(() => {
      supersedeRecord(matched, id);
      insertRegistry(candidate, id, searchText, mergedTags);
      insertRecordDetails(id, { ...candidate, tags: mergedTags });
      syncFtsInsert(id, searchText, candidate.kind, mergedTags);
      updateRegistryTimestamp(matched.id);
    })();
    const inserted = getRecordById(id);
    if (!inserted) throw new Error('Inserted record not found');
    return { decision: 'superseded', record: inserted, previous_record_id: matched.id };
  }

  const id = generateId();
  db.transaction(() => {
    insertRegistry(candidate, id, searchText, tags);
    insertRecordDetails(id, candidate);
    syncFtsInsert(id, searchText, candidate.kind, tags);
  })();
  const inserted = getRecordById(id);
  if (!inserted) throw new Error('Inserted record not found');
  return { decision: 'inserted', record: inserted };
}

export function insertConversationRef(data: {
  agent_id: string;
  session_id?: string;
  user_message: string;
  assistant_message: string;
  messages_json?: string;
}): string {
  const db = getDb();
  const id = generateId();
  db.prepare(`
    INSERT INTO conversation_refs (id, agent_id, session_id, user_message, assistant_message, messages_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.agent_id,
    data.session_id || null,
    data.user_message,
    data.assistant_message,
    data.messages_json || null,
    new Date().toISOString(),
  );
  return id;
}

export function insertEvidence(recordId: string, agentId: string, sourceType: SourceType, evidence: EvidenceInput[]): void {
  if (evidence.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO record_evidence (record_id, agent_id, source_type, role, content, conversation_ref_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const item of evidence) {
      stmt.run(recordId, agentId, sourceType, item.role, item.content, item.conversation_ref_id || null, now);
    }
  });
  tx();
}

export function listEvidence(recordId: string): RecordEvidence[] {
  const db = getDb();
  return db.prepare('SELECT * FROM record_evidence WHERE record_id = ? ORDER BY created_at DESC').all(recordId) as RecordEvidence[];
}

export function upsertRecordVector(recordId: string, embedding: number[]): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO record_vectors_v2 (record_id, embedding)
    VALUES (?, ?)
  `).run(recordId, JSON.stringify(embedding));
}

export function deleteRecordVector(recordId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM record_vectors_v2 WHERE record_id = ?').run(recordId);
}

export function searchFts(query: string, opts: { agent_id?: string; kind?: RecordKind; source_type?: SourceType; include_inactive?: boolean; limit?: number } = {}): SearchHit[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  const db = getDb();
  const conditions = ['record_registry_fts MATCH ?'];
  const params: unknown[] = [sanitized];
  if (!opts.include_inactive) conditions.push('rr.is_active = 1');
  if (opts.agent_id) {
    conditions.push('(rr.agent_id = ? OR rr.agent_id = \'\' OR rr.agent_id IS NULL)');
    params.push(opts.agent_id);
  }
  if (opts.kind) {
    conditions.push('rr.kind = ?');
    params.push(opts.kind);
  }
  if (opts.source_type) {
    conditions.push('rr.source_type = ?');
    params.push(opts.source_type);
  }

  const rows = db.prepare(`
    SELECT rr.id, bm25(record_registry_fts) as rank
    FROM record_registry_fts
    JOIN record_registry rr ON rr.rowid = record_registry_fts.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank
    LIMIT ?
  `).all(...params, opts.limit || 20) as { id: string; rank: number }[];

  return rows.map(row => ({ id: row.id, score: normalizeScoreFromRank(row.rank) }));
}

export function searchVectors(queryEmbedding: number[], opts: { agent_id?: string; limit?: number; include_inactive?: boolean } = {}): SearchHit[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!opts.include_inactive) conditions.push('rr.is_active = 1');
  if (opts.agent_id) {
    conditions.push('(rr.agent_id = ? OR rr.agent_id = \'\' OR rr.agent_id IS NULL)');
    params.push(opts.agent_id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT rv.record_id, rv.embedding
    FROM record_vectors_v2 rv
    JOIN record_registry rr ON rr.id = rv.record_id
    ${where}
  `).all(...params) as { record_id: string; embedding: string }[];

  return rows
    .map(row => {
      const embedding = JSON.parse(row.embedding) as number[];
      return { id: row.record_id, score: cosineSimilarity(queryEmbedding, embedding) };
    })
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit || 20);
}

export function updateRecord(
  id: string,
  patch: {
    content?: string;
    tags?: string[];
    priority?: number;
    source_type?: SourceType;
    status?: string;
  },
): CortexRecord | null {
  const existing = getRecordById(id);
  if (!existing) return null;

  const content = patch.content?.trim() || existing.content;
  const mergedTags = uniqueTags(patch.tags ? [...existing.tags, ...patch.tags] : existing.tags);
  const sourceType = patch.source_type || existing.source_type;
  const priority = patch.priority ?? existing.priority;

  const db = getDb();
  db.transaction(() => {
    switch (existing.kind) {
      case 'profile_rule':
        db.prepare('UPDATE profile_rules SET value_text = ?, last_confirmed_at = ?, metadata = metadata WHERE id = ?')
          .run(content, new Date().toISOString(), id);
        break;
      case 'fact_slot':
        db.prepare('UPDATE fact_slots SET value_text = ?, metadata = metadata WHERE id = ?')
          .run(content, id);
        break;
      case 'task_state':
        db.prepare('UPDATE task_states SET summary = ?, status = ?, last_confirmed_at = ? WHERE id = ?')
          .run(content, patch.status || existing.status, new Date().toISOString(), id);
        break;
      case 'session_note':
        db.prepare('UPDATE session_notes SET summary = ? WHERE id = ?').run(content, id);
        break;
    }
    updateRegistryCommon(id, {
      searchable_text: `${content} ${mergedTags.join(' ')}`.trim(),
      tags: mergedTags,
      priority,
      source_type: sourceType,
    });
    syncFtsUpdate(id, `${content} ${mergedTags.join(' ')}`.trim(), existing.kind, mergedTags);
  })();

  return getRecordById(id);
}

export function deleteRecord(id: string): boolean {
  const existing = getRecordById(id);
  if (!existing) return false;
  const db = getDb();
  syncFtsDeleteById(id);
  deleteRecordVector(id);
  const result = db.prepare('DELETE FROM record_registry WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listAgentPersona(agentId?: string): ProfileRuleRecord[] {
  const db = getDb();
  const params: unknown[] = [];
  const agentFilter = agentId ? ' AND (rr.agent_id = ? OR rr.agent_id = \'\' OR rr.agent_id IS NULL)' : '';
  if (agentId) params.push(agentId);
  const ids = recordIdsFromRegistryQuery(`
    SELECT pr.id
    FROM profile_rules pr
    JOIN record_registry rr ON rr.id = pr.id
    WHERE rr.is_active = 1
      AND pr.owner_scope = 'agent'
      AND pr.attribute_key LIKE 'persona%'
      ${agentFilter}
    ORDER BY rr.priority DESC, rr.updated_at DESC
    LIMIT 10
  `, params);
  return orderedRecords(ids).filter((record): record is ProfileRuleRecord => record.kind === 'profile_rule');
}

export function migrateLegacyMemories(): { migrated: number; skipped: number } {
  const db = getDb();
  const existingMap = new Set(
    (db.prepare('SELECT legacy_memory_id FROM legacy_record_map').all() as { legacy_memory_id: string }[]).map(row => row.legacy_memory_id),
  );
  const legacy = db.prepare(`
    SELECT * FROM memories
    WHERE superseded_by IS NULL
    ORDER BY created_at ASC
  `).all() as Memory[];

  let migrated = 0;
  let skipped = 0;
  const insertMap = db.prepare(`
    INSERT OR REPLACE INTO legacy_record_map (legacy_memory_id, record_id, migrated_at)
    VALUES (?, ?, ?)
  `);

  for (const memory of legacy) {
    if (existingMap.has(memory.id)) {
      skipped++;
      continue;
    }
    const candidate = legacyMemoryToCandidate(memory);
    const result = upsertRecord(candidate);
    insertMap.run(memory.id, result.record.id, new Date().toISOString());
    migrated++;
  }

  return { migrated, skipped };
}

export function getRecordsCount(agentId?: string): number {
  const db = getDb();
  if (agentId) {
    return (db.prepare('SELECT COUNT(*) as cnt FROM record_registry WHERE is_active = 1 AND agent_id = ?').get(agentId) as { cnt: number }).cnt;
  }
  return (db.prepare('SELECT COUNT(*) as cnt FROM record_registry WHERE is_active = 1').get() as { cnt: number }).cnt;
}

export function getV2Stats(agentId?: string): {
  totals: {
    total_records: number;
    active_records: number;
    inactive_records: number;
    total_agents: number;
  };
  distributions: {
    kinds: Record<string, number>;
    sources: Record<string, number>;
  };
  agents: Array<{ agent_id: string; active_records: number }>;
} {
  const db = getDb();
  const filter = agentId ? ' WHERE agent_id = ?' : '';
  const activeFilter = agentId ? ' WHERE agent_id = ? AND is_active = 1' : ' WHERE is_active = 1';
  const params = agentId ? [agentId] : [];

  const totalRecords = (db.prepare(`SELECT COUNT(*) as cnt FROM record_registry${filter}`).get(...params) as { cnt: number }).cnt;
  const activeRecords = (db.prepare(`SELECT COUNT(*) as cnt FROM record_registry${activeFilter}`).get(...params) as { cnt: number }).cnt;
  const totalAgents = (db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number }).cnt;
  const kinds = Object.fromEntries(
    (db.prepare(`SELECT kind, COUNT(*) as cnt FROM record_registry${activeFilter} GROUP BY kind`).all(...params) as { kind: string; cnt: number }[])
      .map(row => [row.kind, row.cnt]),
  );
  const sources = Object.fromEntries(
    (db.prepare(`SELECT source_type, COUNT(*) as cnt FROM record_registry${activeFilter} GROUP BY source_type`).all(...params) as { source_type: string; cnt: number }[])
      .map(row => [row.source_type, row.cnt]),
  );
  const agents = (db.prepare(`
    SELECT COALESCE(NULLIF(agent_id, ''), 'default') as agent_id, COUNT(*) as active_records
    FROM record_registry
    WHERE is_active = 1
    ${agentId ? 'AND agent_id = ?' : ''}
    GROUP BY COALESCE(NULLIF(agent_id, ''), 'default')
    ORDER BY active_records DESC, agent_id ASC
    LIMIT 12
  `).all(...params) as { agent_id: string; active_records: number }[]);

  return {
    totals: {
      total_records: totalRecords,
      active_records: activeRecords,
      inactive_records: Math.max(0, totalRecords - activeRecords),
      total_agents: totalAgents,
    },
    distributions: {
      kinds,
      sources,
    },
    agents,
  };
}

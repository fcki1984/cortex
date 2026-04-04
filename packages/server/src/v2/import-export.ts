import { AUTO_CREATED_AGENT_DESCRIPTION, getAgentById, listAgents } from '../db/agent-queries.js';
import { getDb } from '../db/connection.js';
import { ensureAgent } from '../db/index.js';
import { normalizeEntity } from '../utils/helpers.js';
import {
  extractFactRelationObjectValue,
  relationPredicateForFactAttribute,
  shouldApplyRequestedKindHint,
} from './contract.js';
import { normalizeManualInput } from './normalize.js';
import { getRecordsCount } from './store.js';
import type { CortexRelationsV2, V2Relation } from './relations.js';
import type { CortexRecordsV2, PreviewImportCandidateDetail } from './service.js';
import type {
  CortexRecord,
  EvidenceInput,
  NormalizedRecordCandidate,
  RecordKind,
  SessionNoteLifecycleState,
  SourceType,
} from './types.js';

export type ImportFormat = 'json' | 'memory_md' | 'text';
export type ExportFormat = 'json' | 'memory_md';
export type ExportScope = 'current_agent' | 'all_agents';
export type ImportRelationMode = 'candidate' | 'confirmed_restore';

export type PreviewRecordCandidate = {
  candidate_id: string;
  selected: boolean;
  requested_kind: RecordKind;
  normalized_kind: RecordKind;
  content: string;
  source_type: SourceType;
  tags: string[];
  priority: number;
  confidence: number;
  owner_scope?: 'user' | 'agent';
  subject_key?: string;
  attribute_key?: string;
  entity_key?: string;
  state_key?: string;
  status?: string;
  session_id?: string | null;
  expires_at?: string | null;
  lifecycle_state?: SessionNoteLifecycleState;
  retired_at?: string | null;
  purge_after?: string | null;
  source_excerpt: string;
  warnings: string[];
  evidence: EvidenceInput[];
  original_record_id?: string;
};

type PreviewRelationCandidate = {
  candidate_id: string;
  selected: boolean;
  source_candidate_id?: string;
  subject_key: string;
  predicate: string;
  object_key: string;
  source_excerpt: string;
  confidence: number;
  mode: ImportRelationMode;
  warnings: string[];
  source_evidence?: {
    role: 'user' | 'assistant' | 'system';
    content: string;
  } | null;
};

type PreviewCarryContext = {
  entity_key?: string;
};

type PreviewImportSegment = {
  content: string;
  requested_kind?: RecordKind;
};

type PreviewRecordDetailEntry = {
  detail: PreviewImportCandidateDetail;
  preview: PreviewRecordCandidate;
  order: number;
};

export type ReviewInboxImportPreview = {
  auto_commit_record_candidates: PreviewRecordCandidate[];
  review_record_candidates: PreviewRecordCandidate[];
  review_relation_candidates: PreviewRelationCandidate[];
  warnings: string[];
  stats: {
    format: ImportFormat;
    total_segments: number;
    record_candidates: number;
    relation_candidates: number;
  };
};

export type ImportPreviewResponse = {
  record_candidates: PreviewRecordCandidate[];
  relation_candidates: PreviewRelationCandidate[];
  warnings: string[];
  stats: {
    format: ImportFormat;
    total_segments: number;
    record_candidates: number;
    relation_candidates: number;
  };
};

export type ConfirmImportResponse = {
  summary: {
    committed: number;
    skipped: number;
    failed: number;
    relation_candidates_created: number;
    confirmed_relations_restored: number;
  };
  committed: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  failed: Array<Record<string, unknown>>;
};

type ExportedAgent = {
  id: string;
  name: string;
  description: string | null;
};

type ExportedRecord = CortexRecord & {
  evidence: ReturnType<CortexRecordsV2['getEvidence']>;
};

export type CanonicalExportBundle = {
  schema_version: 'cortex_v2_export';
  exported_at: string;
  scope: ExportScope;
  agents: ExportedAgent[];
  records: {
    profile_rules: ExportedRecord[];
    fact_slots: ExportedRecord[];
    task_states: ExportedRecord[];
    session_notes: ExportedRecord[];
  };
  confirmed_relations: V2Relation[];
};

type RelationTriple = {
  subject_key: string;
  predicate: string;
  object_key: string;
};

const PROFILE_SECTION_RE = /profile rules?|画像|规则|画像\/规则/i;
const FACT_SECTION_RE = /fact slots?|事实槽|事实/i;
const TASK_SECTION_RE = /task states?|任务状态|任务/i;
const NOTE_SECTION_RE = /session notes?|会话笔记|笔记/i;

function generateCandidateId(prefix: string, index: number): string {
  return `${prefix}_${index + 1}`;
}

function normalizeRelationKey(value: string): string {
  return normalizeEntity(value)
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function normalizeRelationPredicate(value: string): string {
  return normalizeRelationKey(value);
}

function normalizeEvidence(raw: unknown, fallbackContent: string, sourceType: SourceType): EvidenceInput[] {
  if (Array.isArray(raw)) {
    const parsed = raw.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const role = (item as Record<string, unknown>).role;
      const content = (item as Record<string, unknown>).content;
      if ((role === 'user' || role === 'assistant' || role === 'system') && typeof content === 'string' && content.trim()) {
        return [{
          role,
          content: content.trim(),
          conversation_ref_id: typeof (item as Record<string, unknown>).conversation_ref_id === 'string'
            ? (item as Record<string, unknown>).conversation_ref_id as string
            : undefined,
        } satisfies EvidenceInput];
      }
      return [];
    });
    if (parsed.length > 0) return parsed;
  }

  const role = sourceType === 'system_derived' ? 'system' : 'user';
  return fallbackContent.trim()
    ? [{ role, content: fallbackContent.trim() }]
    : [];
}

function kindFromHeading(line: string): RecordKind | null {
  if (PROFILE_SECTION_RE.test(line)) return 'profile_rule';
  if (FACT_SECTION_RE.test(line)) return 'fact_slot';
  if (TASK_SECTION_RE.test(line)) return 'task_state';
  if (NOTE_SECTION_RE.test(line)) return 'session_note';
  return null;
}

function splitPlainTextSegments(content: string): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const segments: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    if (bullet) {
      if (bullet[1]?.trim()) segments.push(bullet[1].trim());
      continue;
    }

    segments.push(line);
  }
  return segments;
}

function parseMemoryMdSegments(content: string): PreviewImportSegment[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const segments: PreviewImportSegment[] = [];
  let currentKind: RecordKind | undefined;
  let buffer: string[] = [];
  let inFrontmatter = false;

  const flush = () => {
    const text = buffer.join(' ').trim();
    if (text) segments.push({ content: text, requested_kind: currentKind });
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '---') {
      if (buffer.length === 0) {
        inFrontmatter = !inFrontmatter;
        continue;
      }
      flush();
      continue;
    }
    if (inFrontmatter || !line) {
      flush();
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      flush();
      const heading = line.replace(/^#{1,6}\s+/, '').trim();
      currentKind = kindFromHeading(heading) || currentKind;
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    if (bullet) {
      flush();
      if (bullet[1]?.trim()) segments.push({ content: bullet[1].trim(), requested_kind: currentKind });
      continue;
    }

    buffer.push(line);
  }

  flush();
  return segments;
}

function recordContentFromObject(raw: Record<string, unknown>): string {
  if (typeof raw.content === 'string' && raw.content.trim()) return raw.content.trim();
  if (typeof raw.value_text === 'string' && raw.value_text.trim()) return raw.value_text.trim();
  if (typeof raw.summary === 'string' && raw.summary.trim()) return raw.summary.trim();
  return '';
}

function parseSourceType(raw: unknown): SourceType {
  if (raw === 'user_explicit' || raw === 'user_confirmed' || raw === 'assistant_inferred' || raw === 'system_derived') {
    return raw;
  }
  return 'user_confirmed';
}

function parseRequestedKind(raw: unknown): RecordKind | undefined {
  if (raw === 'profile_rule' || raw === 'fact_slot' || raw === 'task_state' || raw === 'session_note') {
    return raw;
  }
  return undefined;
}

function previewRecordFromNormalized(
  normalized: NormalizedRecordCandidate,
  index: number,
  sourceExcerpt: string,
  evidence: EvidenceInput[],
  originalRecordId?: string,
): PreviewRecordCandidate {
  const candidate = normalized.candidate;
  const warnings = normalized.reason_code ? [normalized.reason_code] : [];
  return {
    candidate_id: generateCandidateId('record', index),
    selected: true,
    requested_kind: normalized.requested_kind,
    normalized_kind: normalized.written_kind,
    content: candidate.kind === 'task_state'
      ? candidate.summary
      : candidate.kind === 'session_note'
        ? candidate.summary
        : candidate.value_text,
    source_type: candidate.source_type,
    tags: candidate.tags || [],
    priority: candidate.priority ?? 0.7,
    confidence: candidate.confidence,
    owner_scope: candidate.kind === 'profile_rule' ? candidate.owner_scope : undefined,
    subject_key: candidate.kind === 'profile_rule'
      ? candidate.subject_key
      : candidate.kind === 'task_state'
        ? candidate.subject_key
        : undefined,
    attribute_key: candidate.kind === 'profile_rule'
      ? candidate.attribute_key
      : candidate.kind === 'fact_slot'
        ? candidate.attribute_key
        : undefined,
    entity_key: candidate.kind === 'fact_slot' ? candidate.entity_key : undefined,
    state_key: candidate.kind === 'task_state' ? candidate.state_key : undefined,
    status: candidate.kind === 'task_state' ? candidate.status : undefined,
    session_id: candidate.kind === 'session_note' ? candidate.session_id || null : undefined,
    expires_at: candidate.kind === 'session_note' ? candidate.expires_at || null : undefined,
    lifecycle_state: candidate.kind === 'session_note' ? candidate.lifecycle_state : undefined,
    retired_at: candidate.kind === 'session_note' ? candidate.retired_at || null : undefined,
    purge_after: candidate.kind === 'session_note' ? candidate.purge_after || null : undefined,
    source_excerpt: sourceExcerpt,
    warnings,
    evidence,
    original_record_id: originalRecordId,
  };
}

function deriveRelationTriple(candidate: PreviewRecordCandidate): RelationTriple | null {
  if (candidate.normalized_kind === 'fact_slot') {
    const subjectKey = candidate.entity_key ? normalizeRelationKey(candidate.entity_key) : '';
    const predicate = relationPredicateForFactAttribute(candidate.attribute_key) || '';
    if (!subjectKey || !predicate) return null;

    const objectValue = extractFactRelationObjectValue(candidate.attribute_key, candidate.content);
    const objectKey = objectValue ? normalizeRelationKey(objectValue) : '';
    if (!objectKey) return null;
    return { subject_key: subjectKey, predicate, object_key: objectKey };
  }

  return null;
}

function previewRelationFromRecord(
  recordCandidate: PreviewRecordCandidate,
  index: number,
): PreviewRelationCandidate | null {
  const triple = deriveRelationTriple(recordCandidate);
  if (!triple) return null;
  return {
    candidate_id: generateCandidateId('relation', index),
    selected: true,
    source_candidate_id: recordCandidate.candidate_id,
    subject_key: triple.subject_key,
    predicate: normalizeRelationPredicate(triple.predicate),
    object_key: triple.object_key,
    source_excerpt: recordCandidate.source_excerpt,
    confidence: 0.78,
    mode: 'candidate',
    warnings: [],
    source_evidence: recordCandidate.evidence[0]
      ? {
          role: recordCandidate.evidence[0].role,
          content: recordCandidate.evidence[0].content,
        }
      : null,
  };
}

function relationCandidateKey(candidate: PreviewRelationCandidate): string {
  return [
    candidate.source_candidate_id || '',
    normalizeRelationKey(candidate.subject_key),
    normalizeRelationPredicate(candidate.predicate),
    normalizeRelationKey(candidate.object_key),
  ].join(':');
}

function dedupeRelationCandidates(candidates: PreviewRelationCandidate[]): PreviewRelationCandidate[] {
  const deduped = new Map<string, PreviewRelationCandidate>();

  for (const candidate of candidates) {
    const key = relationCandidateKey(candidate);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, candidate);
      continue;
    }
    if (existing.mode !== 'confirmed_restore' && candidate.mode === 'confirmed_restore') {
      deduped.set(key, candidate);
    }
  }

  return Array.from(deduped.values());
}

function previewRecordStableKey(candidate: PreviewRecordCandidate): string | null {
  switch (candidate.normalized_kind) {
    case 'fact_slot':
      if (!candidate.entity_key || !candidate.attribute_key) return null;
      return `fact_slot:${candidate.entity_key}:${candidate.attribute_key}`;
    case 'profile_rule':
      if (!candidate.subject_key || !candidate.attribute_key || !candidate.owner_scope) return null;
      return `profile_rule:${candidate.owner_scope}:${candidate.subject_key}:${candidate.attribute_key}`;
    case 'task_state':
      if (!candidate.subject_key || !candidate.state_key) return null;
      return `task_state:${candidate.subject_key}:${candidate.state_key}`;
    default:
      return null;
  }
}

function arbitratePreviewRecordCandidates(candidates: PreviewRecordCandidate[]): PreviewRecordCandidate[] {
  const ordered = new Map<string, { candidate: PreviewRecordCandidate; order: number }>();
  const passthrough: Array<{ candidate: PreviewRecordCandidate; order: number }> = [];

  for (const [index, candidate] of candidates.entries()) {
    const stableKey = previewRecordStableKey(candidate);
    if (!stableKey) {
      passthrough.push({ candidate, order: index });
      continue;
    }
    ordered.set(stableKey, { candidate, order: index });
  }

  return [...passthrough, ...ordered.values()]
    .sort((left, right) => left.order - right.order)
    .map(entry => entry.candidate);
}

function arbitratePreviewRecordEntries(entries: PreviewRecordDetailEntry[]): PreviewRecordDetailEntry[] {
  const ordered = new Map<string, PreviewRecordDetailEntry>();
  const passthrough: PreviewRecordDetailEntry[] = [];

  for (const entry of entries) {
    const stableKey = previewRecordStableKey(entry.preview);
    if (!stableKey) {
      passthrough.push(entry);
      continue;
    }
    ordered.set(stableKey, entry);
  }

  return [...passthrough, ...ordered.values()]
    .sort((left, right) => left.order - right.order);
}

function updatePreviewCarryContext(
  carry: PreviewCarryContext,
  normalized: NormalizedRecordCandidate,
): PreviewCarryContext {
  const record = normalized.candidate;
  if (record.kind === 'fact_slot') {
    return {
      ...carry,
      entity_key: record.entity_key,
    };
  }

  if (record.kind === 'profile_rule' && record.owner_scope === 'user' && record.subject_key === 'user') {
    return {
      ...carry,
      entity_key: carry.entity_key || 'user',
    };
  }

  return carry;
}

async function buildPreviewFromSegments(
  recordsV2: CortexRecordsV2,
  agentId: string,
  format: ImportFormat,
  segments: Array<{ content: string; requested_kind?: RecordKind }>,
): Promise<ImportPreviewResponse> {
  const entries: PreviewRecordDetailEntry[] = [];
  let carry: PreviewCarryContext = {};

  for (const segment of segments) {
    const candidateDetails = await recordsV2.previewImportCandidateDetails({
      agent_id: agentId,
      content: segment.content,
      requested_kind: shouldApplyRequestedKindHint(segment.content, segment.requested_kind)
        ? segment.requested_kind
        : undefined,
      source_type: 'user_confirmed',
      carry_context: carry,
    });

    for (const detail of candidateDetails) {
      carry = updatePreviewCarryContext(carry, detail.candidate);
      entries.push({
        detail,
        preview: previewRecordFromNormalized(
          detail.candidate,
          entries.length,
          detail.source_excerpt,
          normalizeEvidence(undefined, detail.source_excerpt, 'user_confirmed'),
        ),
        order: entries.length,
      });
    }
  }

  const winningRecordCandidates = arbitratePreviewRecordEntries(entries).map((entry) => entry.preview);
  const relationCandidates = dedupeRelationCandidates(
    winningRecordCandidates
      .map((candidate, index) => previewRelationFromRecord(candidate, index))
      .filter((item): item is PreviewRelationCandidate => !!item),
  );

  return {
    record_candidates: winningRecordCandidates,
    relation_candidates: relationCandidates,
    warnings: [],
    stats: {
      format,
      total_segments: segments.length,
      record_candidates: winningRecordCandidates.length,
      relation_candidates: relationCandidates.length,
    },
  };
}

export async function previewImportForReviewInbox(
  recordsV2: CortexRecordsV2,
  input: {
    agent_id: string;
    format: 'text' | 'memory_md';
    content: string;
  },
): Promise<ReviewInboxImportPreview> {
  ensureAgent(input.agent_id);

  const segments: PreviewImportSegment[] = input.format === 'text'
    ? splitPlainTextSegments(input.content).map((content) => ({ content, requested_kind: undefined }))
    : parseMemoryMdSegments(input.content);

  const entries: PreviewRecordDetailEntry[] = [];
  let carry: PreviewCarryContext = {};

  for (const segment of segments) {
    const candidateDetails = await recordsV2.previewImportCandidateDetails({
      agent_id: input.agent_id,
      content: segment.content,
      requested_kind: shouldApplyRequestedKindHint(segment.content, segment.requested_kind)
        ? segment.requested_kind
        : undefined,
      source_type: 'user_confirmed',
      carry_context: carry,
    });

    for (const detail of candidateDetails) {
      carry = updatePreviewCarryContext(carry, detail.candidate);
      entries.push({
        detail,
        preview: previewRecordFromNormalized(
          detail.candidate,
          entries.length,
          detail.source_excerpt,
          normalizeEvidence(undefined, detail.source_excerpt, 'user_confirmed'),
        ),
        order: entries.length,
      });
    }
  }

  const winningEntries = arbitratePreviewRecordEntries(entries);
  const autoCommitRecordCandidates = winningEntries
    .filter((entry) => entry.detail.disposition !== 'review')
    .map((entry) => entry.preview);
  const reviewRecordCandidates = winningEntries
    .filter((entry) => entry.detail.disposition === 'review')
    .map((entry) => entry.preview);
  const reviewRelationCandidates = dedupeRelationCandidates(
    reviewRecordCandidates
      .map((candidate, index) => previewRelationFromRecord(candidate, index))
      .filter((item): item is PreviewRelationCandidate => !!item),
  );

  return {
    auto_commit_record_candidates: autoCommitRecordCandidates,
    review_record_candidates: reviewRecordCandidates,
    review_relation_candidates: reviewRelationCandidates,
    warnings: [],
    stats: {
      format: input.format,
      total_segments: segments.length,
      record_candidates: winningEntries.length,
      relation_candidates: reviewRelationCandidates.length,
    },
  };
}

function flattenExportRecords(records: CanonicalExportBundle['records'] | Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray((records as Record<string, unknown>).records)) {
    return (records as Record<string, unknown>).records as Record<string, unknown>[];
  }

  const source = records as Record<string, unknown>;
  return [
    ...(Array.isArray(source.profile_rules) ? source.profile_rules as Record<string, unknown>[] : []),
    ...(Array.isArray(source.fact_slots) ? source.fact_slots as Record<string, unknown>[] : []),
    ...(Array.isArray(source.task_states) ? source.task_states as Record<string, unknown>[] : []),
    ...(Array.isArray(source.session_notes) ? source.session_notes as Record<string, unknown>[] : []),
  ];
}

function previewRecordFromJsonObject(
  raw: Record<string, unknown>,
  agentId: string,
  index: number,
): PreviewRecordCandidate | null {
  const content = recordContentFromObject(raw);
  if (!content) return null;

  const requestedKind = parseRequestedKind(raw.requested_kind) || parseRequestedKind(raw.kind);
  const sourceType = parseSourceType(raw.source_type);
  const evidence = normalizeEvidence(raw.evidence, content, sourceType);
  const normalized = normalizeManualInput(agentId, {
    kind: requestedKind,
    content,
    source_type: sourceType,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === 'string') : undefined,
    priority: typeof raw.priority === 'number' ? raw.priority : undefined,
    subject_key: typeof raw.subject_key === 'string' ? raw.subject_key : undefined,
    attribute_key: typeof raw.attribute_key === 'string' ? raw.attribute_key : undefined,
    entity_key: typeof raw.entity_key === 'string' ? raw.entity_key : undefined,
    state_key: typeof raw.state_key === 'string' ? raw.state_key : undefined,
    owner_scope: raw.owner_scope === 'agent' ? 'agent' : raw.owner_scope === 'user' ? 'user' : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    session_id: typeof raw.session_id === 'string' ? raw.session_id : undefined,
    expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : undefined,
    lifecycle_state: raw.lifecycle_state === 'active' || raw.lifecycle_state === 'dormant' || raw.lifecycle_state === 'stale'
      ? raw.lifecycle_state
      : undefined,
    retired_at: typeof raw.retired_at === 'string' ? raw.retired_at : undefined,
    purge_after: typeof raw.purge_after === 'string' ? raw.purge_after : undefined,
  });

  return previewRecordFromNormalized(
    normalized,
    index,
    content,
    evidence,
    typeof raw.id === 'string' ? raw.id : undefined,
  );
}

function previewRelationsFromJson(
  rawRelations: unknown,
  recordCandidates: PreviewRecordCandidate[],
): PreviewRelationCandidate[] {
  if (!Array.isArray(rawRelations)) return [];
  const recordCandidateByOriginalId = new Map<string, PreviewRecordCandidate>();
  for (const candidate of recordCandidates) {
    if (candidate.original_record_id) {
      recordCandidateByOriginalId.set(candidate.original_record_id, candidate);
    }
  }

  return rawRelations.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const relation = item as Record<string, unknown>;
    const sourceRecordId = typeof relation.source_record_id === 'string' ? relation.source_record_id : undefined;
    const linkedRecord = sourceRecordId ? recordCandidateByOriginalId.get(sourceRecordId) : undefined;
    if (!linkedRecord) return [];

    const subjectKey = typeof relation.subject_key === 'string' ? normalizeRelationKey(relation.subject_key) : '';
    const predicate = typeof relation.predicate === 'string' ? normalizeRelationPredicate(relation.predicate) : '';
    const objectKey = typeof relation.object_key === 'string' ? normalizeRelationKey(relation.object_key) : '';
    if (!subjectKey || !predicate || !objectKey) return [];

    const sourceEvidence = relation.source_evidence && typeof relation.source_evidence === 'object'
      && ((relation.source_evidence as Record<string, unknown>).role === 'user'
        || (relation.source_evidence as Record<string, unknown>).role === 'assistant'
        || (relation.source_evidence as Record<string, unknown>).role === 'system')
      && typeof (relation.source_evidence as Record<string, unknown>).content === 'string'
        ? {
            role: (relation.source_evidence as Record<string, unknown>).role as 'user' | 'assistant' | 'system',
            content: ((relation.source_evidence as Record<string, unknown>).content as string).trim(),
          }
        : linkedRecord.evidence[0]
          ? {
              role: linkedRecord.evidence[0].role,
              content: linkedRecord.evidence[0].content,
            }
          : null;

    return [{
      candidate_id: generateCandidateId('relation_restore', index),
      selected: true,
      source_candidate_id: linkedRecord.candidate_id,
      subject_key: subjectKey,
      predicate,
      object_key: objectKey,
      source_excerpt: linkedRecord.source_excerpt,
      confidence: typeof relation.confidence === 'number' ? relation.confidence : 0.8,
      mode: relation.source_record ? 'confirmed_restore' : 'candidate',
      warnings: [],
      source_evidence: sourceEvidence,
    } satisfies PreviewRelationCandidate];
  });
}

export async function previewImport(recordsV2: CortexRecordsV2, input: {
  agent_id: string;
  format: ImportFormat;
  content: string;
}): Promise<ImportPreviewResponse> {
  ensureAgent(input.agent_id);

  if (input.format === 'text') {
    const segments = splitPlainTextSegments(input.content).map((content) => ({ content }));
    return buildPreviewFromSegments(recordsV2, input.agent_id, input.format, segments);
  }

  if (input.format === 'memory_md') {
    const segments = parseMemoryMdSegments(input.content);
    return buildPreviewFromSegments(recordsV2, input.agent_id, input.format, segments);
  }

  const parsed = JSON.parse(input.content) as Record<string, unknown>;
  const recordPayload = Array.isArray(parsed.records)
    ? parsed.records as Record<string, unknown>[]
    : parsed.records && typeof parsed.records === 'object'
      ? flattenExportRecords(parsed.records as Record<string, unknown>)
      : flattenExportRecords(parsed);

  const recordCandidates = recordPayload
    .map((record, index) => previewRecordFromJsonObject(record, input.agent_id, index))
    .filter((item): item is PreviewRecordCandidate => !!item);

  const relationCandidates = dedupeRelationCandidates([
    ...recordCandidates
      .map((candidate, index) => previewRelationFromRecord(candidate, index))
      .filter((item): item is PreviewRelationCandidate => !!item),
    ...previewRelationsFromJson(
      Array.isArray(parsed.confirmed_relations)
        ? parsed.confirmed_relations
        : Array.isArray(parsed.relations)
          ? parsed.relations
          : [],
      recordCandidates,
    ),
  ]);

  return {
    record_candidates: recordCandidates,
    relation_candidates: relationCandidates,
    warnings: [],
    stats: {
      format: input.format,
      total_segments: recordCandidates.length,
      record_candidates: recordCandidates.length,
      relation_candidates: relationCandidates.length,
    },
  };
}

function exportedAgentsFromIds(agentIds: string[]): ExportedAgent[] {
  return agentIds.map((agentId) => {
    const agent = getAgentById(agentId);
    if (agent) {
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
      };
    }
    return {
      id: agentId,
      name: agentId,
      description: agentId === 'default' ? 'System default agent using global configuration' : null,
    };
  });
}

function listExportEligibleAgentIds(): string[] {
  const db = getDb();

  return listAgents()
    .filter((agent) => {
      if (agent.id === 'default' || agent.id === 'mcp') return true;
      if (agent.name !== agent.id) return true;
      if (agent.description !== AUTO_CREATED_AGENT_DESCRIPTION) return true;
      if (agent.config_override) return true;

      const recordCount = (db.prepare('SELECT COUNT(*) as cnt FROM record_registry WHERE agent_id = ?').get(agent.id) as { cnt: number }).cnt;
      if (recordCount > 0) return true;

      const relationCount = (db.prepare('SELECT COUNT(*) as cnt FROM record_relations_v2 WHERE agent_id = ?').get(agent.id) as { cnt: number }).cnt;
      if (relationCount > 0) return true;

      const candidateCount = (db.prepare('SELECT COUNT(*) as cnt FROM relation_candidates_v2 WHERE agent_id = ?').get(agent.id) as { cnt: number }).cnt;
      if (candidateCount > 0) return true;

      const feedbackCount = (db.prepare('SELECT COUNT(*) as cnt FROM record_feedback_v2 WHERE agent_id = ?').get(agent.id) as { cnt: number }).cnt;
      return feedbackCount > 0;
    })
    .map((agent) => agent.id);
}

export function buildCanonicalExportBundle(
  recordsV2: CortexRecordsV2,
  relationsV2: CortexRelationsV2,
  opts: { scope: ExportScope; agent_id?: string },
): CanonicalExportBundle {
  const agentId = opts.scope === 'current_agent' ? (opts.agent_id || 'default') : undefined;
  const allowedAgentIds = opts.scope === 'all_agents'
    ? new Set(listExportEligibleAgentIds())
    : new Set(agentId ? [agentId] : []);
  const totalRecords = getRecordsCount(agentId);
  const records = recordsV2.listRecords({
    ...(agentId ? { agent_id: agentId } : {}),
    include_inactive: false,
    limit: Math.max(50, totalRecords + 10),
    order_by: 'updated_at',
    order_dir: 'desc',
  }).items.filter((record) => (
    allowedAgentIds.size === 0 || allowedAgentIds.has(record.agent_id)
  ));

  const db = getDb();
  const relationWhere = agentId ? 'WHERE agent_id = ?' : '';
  const relationParams = agentId ? [agentId] : [];
  const relationCount = (db.prepare(`SELECT COUNT(*) as cnt FROM record_relations_v2 ${relationWhere}`).get(...relationParams) as { cnt: number }).cnt;
  const relations = relationsV2.listRelations({
    ...(agentId ? { agent_id: agentId } : {}),
    limit: Math.max(20, relationCount + 10),
  }).items.filter((relation) => (
    allowedAgentIds.size === 0 || allowedAgentIds.has(relation.agent_id)
  ));

  const agentIds = Array.from(new Set([
    ...allowedAgentIds,
    ...records.map((record) => record.agent_id),
    ...relations.map((relation) => relation.agent_id),
    ...(agentId ? [agentId] : []),
  ])).sort();

  const bundle: CanonicalExportBundle = {
    schema_version: 'cortex_v2_export',
    exported_at: new Date().toISOString(),
    scope: opts.scope,
    agents: exportedAgentsFromIds(agentIds),
    records: {
      profile_rules: [],
      fact_slots: [],
      task_states: [],
      session_notes: [],
    },
    confirmed_relations: relations,
  };

  for (const record of records) {
    const exportedRecord = {
      ...record,
      evidence: recordsV2.getEvidence(record.id),
    };
    if (record.kind === 'profile_rule') bundle.records.profile_rules.push(exportedRecord);
    if (record.kind === 'fact_slot') bundle.records.fact_slots.push(exportedRecord);
    if (record.kind === 'task_state') bundle.records.task_states.push(exportedRecord);
    if (record.kind === 'session_note') bundle.records.session_notes.push(exportedRecord);
  }

  return bundle;
}

export function buildMemoryMarkdown(bundle: CanonicalExportBundle): string {
  const lines: string[] = [
    '# Cortex V2 Export',
    '',
    `> Exported at ${bundle.exported_at}`,
    `> Scope: ${bundle.scope}`,
    `> Agents: ${bundle.agents.map((agent) => agent.name || agent.id).join(', ') || 'default'}`,
    '',
  ];

  const sections: Array<{ title: string; items: ExportedRecord[] }> = [
    { title: 'Profile Rules', items: bundle.records.profile_rules },
    { title: 'Fact Slots', items: bundle.records.fact_slots },
    { title: 'Task States', items: bundle.records.task_states },
    { title: 'Session Notes', items: bundle.records.session_notes },
  ];

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    if (section.items.length === 0) {
      lines.push('- (empty)');
      lines.push('');
      continue;
    }
    for (const item of section.items) {
      lines.push(`- ${item.content}`);
    }
    lines.push('');
  }

  lines.push('## Confirmed Relations');
  if (bundle.confirmed_relations.length === 0) {
    lines.push('- (empty)');
  } else {
    for (const relation of bundle.confirmed_relations) {
      lines.push(`- ${relation.subject_key} -- ${relation.predicate} --> ${relation.object_key}`);
    }
  }

  return lines.join('\n');
}

function importedEvidenceId(
  recordsV2: CortexRecordsV2,
  recordId: string,
  expected?: { role: 'user' | 'assistant' | 'system'; content: string } | null,
): number | null {
  const evidence = recordsV2.getEvidence(recordId);
  if (evidence.length === 0) return null;
  if (!expected) return evidence[0]?.id ?? null;
  return evidence.find((item) => item.role === expected.role && item.content === expected.content)?.id
    ?? evidence.find((item) => item.content === expected.content)?.id
    ?? evidence[0]?.id
    ?? null;
}

export async function confirmImport(
  recordsV2: CortexRecordsV2,
  relationsV2: CortexRelationsV2,
  input: {
    agent_id: string;
    record_candidates: PreviewRecordCandidate[];
    relation_candidates: PreviewRelationCandidate[];
  },
): Promise<ConfirmImportResponse> {
  ensureAgent(input.agent_id);

  const committed: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  const recordMap = new Map<string, { record_id: string }>();
  const confirmedRestoreBySourceCandidate = new Map<string, PreviewRelationCandidate[]>();
  let relationCandidatesCreated = 0;
  let confirmedRelationsRestored = 0;

  for (const relation of input.relation_candidates || []) {
    if (!relation?.selected || relation.mode !== 'confirmed_restore' || !relation.source_candidate_id) continue;
    const current = confirmedRestoreBySourceCandidate.get(relation.source_candidate_id) || [];
    current.push(relation);
    confirmedRestoreBySourceCandidate.set(relation.source_candidate_id, current);
  }

  for (const candidate of input.record_candidates || []) {
    if (!candidate?.selected) {
      skipped.push({ candidate_id: candidate?.candidate_id, type: 'record', reason: 'not_selected' });
      continue;
    }

    try {
      const normalized = normalizeManualInput(input.agent_id, {
        kind: candidate.requested_kind,
        content: candidate.content,
        source_type: candidate.source_type,
        tags: candidate.tags,
        priority: candidate.priority,
        subject_key: candidate.subject_key,
        attribute_key: candidate.attribute_key,
        entity_key: candidate.entity_key,
        state_key: candidate.state_key,
        owner_scope: candidate.owner_scope,
        status: candidate.status,
        session_id: candidate.session_id || undefined,
        expires_at: candidate.expires_at || undefined,
        lifecycle_state: candidate.lifecycle_state,
        retired_at: candidate.retired_at || undefined,
        purge_after: candidate.purge_after || undefined,
      });

      const result = await recordsV2.commitNormalizedCandidate(
        normalized,
        normalizeEvidence(candidate.evidence, candidate.content, candidate.source_type),
        {
          deriveRelationCandidates: !confirmedRestoreBySourceCandidate.has(candidate.candidate_id),
        },
      );
      recordMap.set(candidate.candidate_id, { record_id: result.record.id });
      committed.push({
        candidate_id: candidate.candidate_id,
        type: 'record',
        requested_kind: result.requested_kind,
        written_kind: result.written_kind,
        normalization: result.normalization,
        decision: result.decision,
        record: result.record,
      });
    } catch (error: any) {
      failed.push({
        candidate_id: candidate?.candidate_id,
        type: 'record',
        error: error.message,
      });
    }
  }

  for (const relation of input.relation_candidates || []) {
    if (!relation?.selected) {
      skipped.push({ candidate_id: relation?.candidate_id, type: 'relation', reason: 'not_selected' });
      continue;
    }

    const sourceRef = relation.source_candidate_id ? recordMap.get(relation.source_candidate_id) : undefined;
    if (!sourceRef) {
      skipped.push({
        candidate_id: relation.candidate_id,
        type: 'relation',
        reason: 'missing_source_record',
      });
      continue;
    }

    try {
      if (relation.mode === 'confirmed_restore') {
        const sourceEvidenceId = importedEvidenceId(recordsV2, sourceRef.record_id, relation.source_evidence);
        const restored = relationsV2.createRelation({
          agent_id: input.agent_id,
          source_record_id: sourceRef.record_id,
          source_evidence_id: sourceEvidenceId,
          subject_key: relation.subject_key,
          predicate: relation.predicate,
          object_key: relation.object_key,
          confidence: relation.confidence,
          metadata: {
            imported_mode: relation.mode,
          },
        });
        relationsV2.deletePendingCandidateForTriple({
          agent_id: input.agent_id,
          source_record_id: sourceRef.record_id,
          subject_key: relation.subject_key,
          predicate: relation.predicate,
          object_key: relation.object_key,
        });
        confirmedRelationsRestored++;
        committed.push({
          candidate_id: relation.candidate_id,
          type: 'relation',
          mode: relation.mode,
          relation: restored,
        });
      } else {
        const sourceEvidenceId = importedEvidenceId(recordsV2, sourceRef.record_id, relation.source_evidence);
        const created = relationsV2.createCandidate({
          agent_id: input.agent_id,
          source_record_id: sourceRef.record_id,
          source_evidence_id: sourceEvidenceId,
          subject_key: relation.subject_key,
          predicate: relation.predicate,
          object_key: relation.object_key,
          confidence: relation.confidence,
          status: 'pending',
          metadata: {
            imported_mode: relation.mode,
          },
        });
        relationCandidatesCreated++;
        committed.push({
          candidate_id: relation.candidate_id,
          type: 'relation',
          mode: relation.mode,
          candidate: created,
        });
      }
    } catch (error: any) {
      failed.push({
        candidate_id: relation.candidate_id,
        type: 'relation',
        error: error.message,
      });
    }
  }

  return {
    summary: {
      committed: committed.filter((item) => item.type === 'record').length,
      skipped: skipped.length,
      failed: failed.length,
      relation_candidates_created: relationCandidatesCreated,
      confirmed_relations_restored: confirmedRelationsRestored,
    },
    committed,
    skipped,
    failed,
  };
}

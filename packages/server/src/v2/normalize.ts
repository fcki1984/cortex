import { normalizeEntity } from '../utils/helpers.js';
import type { DetectedSignal } from '../signals/index.js';
import type { Memory, MemoryCategory } from '../db/index.js';
import {
  canonicalizeDurableContent,
  inferFactSlotAttribute,
  inferProfileRuleAttribute,
  inferRequestedKindFromContent,
  inferTaskStateKey,
  isWeakConversationalProfileRule,
  isSpeculativeContent,
} from './contract.js';
import type {
  NormalizedRecordCandidate,
  RecordCandidate,
  RecordKind,
  RecordReasonCode,
  SessionNoteLifecycleState,
  SessionNoteCandidate,
  SourceType,
  FactSlotCandidate,
  ProfileRuleCandidate,
  TaskStateCandidate,
} from './types.js';

const PROFILE_RULE_KEYS = new Set([
  'display_name',
  'persona_boundary',
  'persona_rule',
  'persona_style',
  'language_preference',
  'response_length',
  'response_style',
  'risk_tolerance',
  'solution_complexity',
]);

const PROFILE_RULE_KEY_ALIASES: Record<string, string> = {
  name: 'display_name',
  preferred_name: 'display_name',
  persona: 'persona_rule',
  persona_response_style: 'persona_style',
  preferred_language: 'language_preference',
  reply_language: 'language_preference',
  response_tone: 'response_style',
  response_constraint: 'response_style',
  brevity_preference: 'response_length',
};

const FACT_SLOT_KEYS = new Set([
  'capability',
  'location',
  'occupation',
  'organization',
  'relationship',
  'skill',
]);

const FACT_SLOT_KEY_ALIASES: Record<string, string> = {
  lives_in: 'location',
  residence: 'location',
  works_at: 'organization',
  company: 'organization',
  role: 'occupation',
  works_as: 'occupation',
  employer: 'organization',
};

const TASK_STATE_KEYS = new Set([
  'current_decision',
  'current_goal',
  'deployment_status',
  'migration_status',
  'open_todo',
  'project_status',
  'refactor_status',
]);

const TASK_STATE_KEY_ALIASES: Record<string, string> = {
  decision: 'current_decision',
  goal: 'current_goal',
  todo: 'open_todo',
  task_state: 'project_status',
  project_state: 'project_status',
  rewrite_status: 'refactor_status',
};

const USER_SUBJECT_RE = /(?:我|我的|用户|user\b|i\b|my\b)/i;
const AGENT_SUBJECT_RE = /(?:agent\b|助手|assistant\b)/i;
const IMPLICIT_USER_FOLLOWUP_PREFIX_RE = /^(?:现在|目前|如今|currently|now)\s*/i;

type ManualInput = {
  kind?: string;
  content: string;
  source_type?: SourceType;
  tags?: string[];
  priority?: number;
  subject_key?: string;
  attribute_key?: string;
  entity_key?: string;
  state_key?: string;
  owner_scope?: 'user' | 'agent';
  status?: string;
  session_id?: string;
  expires_at?: string;
  lifecycle_state?: SessionNoteLifecycleState;
  retired_at?: string;
  purge_after?: string;
};

type PartialExtractedRecord = {
  kind?: string;
  confidence?: number;
  priority?: number;
  tags?: unknown;
  source_type?: string;
  owner_scope?: 'user' | 'agent' | string;
  subject_key?: string;
  attribute_key?: string;
  value_text?: string;
  entity_key?: string;
  state_key?: string;
  summary?: string;
  status?: string;
};

interface BaseNormalizationInput {
  agentId: string;
  content: string;
  sourceType: SourceType;
  tags: string[];
  priority: number;
  confidence: number;
  sessionId?: string;
  expiresAt?: string;
  lifecycleState?: SessionNoteLifecycleState;
  retiredAt?: string;
  purgeAfter?: string;
}

interface ManualProfileRuleInput extends BaseNormalizationInput {
  ownerScope?: 'user' | 'agent';
  subjectKey?: string;
  attributeKey?: string;
}

interface ManualFactSlotInput extends BaseNormalizationInput {
  entityKey?: string;
  attributeKey?: string;
}

interface ManualTaskStateInput extends BaseNormalizationInput {
  subjectKey?: string;
  stateKey?: string;
  status?: string;
}

function clamp01(value: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(value, 1));
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeReasonCode(raw: RecordReasonCode | null | undefined): RecordReasonCode | null {
  if (
    raw === 'assistant_only_evidence' ||
    raw === 'unstable_attribute' ||
    raw === 'ambiguous_subject' ||
    raw === 'insufficient_structure' ||
    raw === 'unsupported_kind' ||
    raw === 'fallback_summary'
  ) {
    return raw;
  }
  return null;
}

function normalizeKey(text: string, fallback = 'note'): string {
  const normalized = normalizeEntity(text)
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return normalized || fallback;
}

function isRecordKind(kind: string | undefined): kind is RecordKind {
  return kind === 'profile_rule' || kind === 'fact_slot' || kind === 'task_state' || kind === 'session_note';
}

function outcome(candidate: RecordCandidate, requestedKind: RecordKind, reasonCode: RecordReasonCode | null = null): NormalizedRecordCandidate {
  const writtenKind = candidate.kind;
  return {
    candidate,
    requested_kind: requestedKind,
    written_kind: writtenKind,
    normalization: requestedKind !== 'session_note' && writtenKind === 'session_note'
      ? 'downgraded_to_session_note'
      : 'durable',
    reason_code: normalizeReasonCode(reasonCode),
  };
}

function buildSessionNote(
  input: BaseNormalizationInput,
  requestedKind: RecordKind,
  reasonCode: RecordReasonCode | null,
  summary = input.content,
): NormalizedRecordCandidate {
  return outcome(
    {
      kind: 'session_note',
      agent_id: input.agentId,
      session_id: input.sessionId,
      summary,
      source_type: input.sourceType,
      tags: input.tags,
      priority: input.priority,
      confidence: input.confidence,
      expires_at: input.expiresAt,
      lifecycle_state: input.lifecycleState,
      retired_at: input.retiredAt,
      purge_after: input.purgeAfter,
    } satisfies SessionNoteCandidate,
    requestedKind,
    reasonCode,
  );
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function inferUserSubject(content: string): string | null {
  const trimmed = content.trim();
  if (USER_SUBJECT_RE.test(trimmed)) return 'user';
  if (IMPLICIT_USER_FOLLOWUP_PREFIX_RE.test(trimmed) && inferRequestedKindFromContent(trimmed) === 'fact_slot') {
    return 'user';
  }
  return null;
}

function inferSubjectKey(content: string): string | null {
  if (USER_SUBJECT_RE.test(content)) return 'user';
  if (/\bcortex\b/i.test(content)) return 'cortex';
  if (AGENT_SUBJECT_RE.test(content)) return 'agent';
  return null;
}

function stableSubject(raw: string | undefined, fallbackContent: string): string | null {
  if (raw?.trim()) return normalizeKey(raw, 'subject');
  return inferSubjectKey(fallbackContent);
}

function stableEntity(raw: string | undefined, fallbackContent: string): string | null {
  if (raw?.trim()) return normalizeKey(raw, 'entity');
  return inferUserSubject(fallbackContent);
}

function normalizeProfileAttribute(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const normalized = normalizeKey(raw);
  return PROFILE_RULE_KEYS.has(normalized) ? normalized : (PROFILE_RULE_KEY_ALIASES[normalized] || null);
}

function normalizeFactAttribute(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const normalized = normalizeKey(raw);
  return FACT_SLOT_KEYS.has(normalized) ? normalized : (FACT_SLOT_KEY_ALIASES[normalized] || null);
}

function normalizeTaskStateKey(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const normalized = normalizeKey(raw);
  return TASK_STATE_KEYS.has(normalized) ? normalized : (TASK_STATE_KEY_ALIASES[normalized] || null);
}

function inferTaskStatus(content: string, explicitStatus?: string): string {
  if (explicitStatus?.trim()) return normalizeKey(explicitStatus, 'active');
  if (/决定|decided|choose|定了/i.test(content)) return 'decided';
  if (/待办|todo|remember to|别忘了/i.test(content)) return 'open';
  if (/计划|goal|plan|打算/i.test(content)) return 'planned';
  return 'active';
}

function reasonForMissingStructure(content: string, missing: 'attribute' | 'subject'): RecordReasonCode {
  if (isSpeculativeContent(content)) return 'insufficient_structure';
  return missing === 'attribute' ? 'unstable_attribute' : 'ambiguous_subject';
}

function sourceAllowsProfileRule(sourceType: SourceType, ownerScope: 'user' | 'agent'): RecordReasonCode | null {
  if (ownerScope === 'agent') {
    return sourceType === 'system_derived' ? null : 'unsupported_kind';
  }
  if (sourceType === 'assistant_inferred') return 'assistant_only_evidence';
  if (sourceType !== 'user_explicit' && sourceType !== 'user_confirmed') return 'unsupported_kind';
  return null;
}

function sourceAllowsDurable(sourceType: SourceType): RecordReasonCode | null {
  if (sourceType === 'assistant_inferred') return 'assistant_only_evidence';
  if (sourceType !== 'user_explicit' && sourceType !== 'user_confirmed') return 'unsupported_kind';
  return null;
}

function normalizeProfileRule(input: ManualProfileRuleInput, requestedKind: RecordKind): NormalizedRecordCandidate {
  const ownerScope = input.ownerScope === 'agent' ? 'agent' : 'user';
  const sourceReason = sourceAllowsProfileRule(input.sourceType, ownerScope);
  if (sourceReason) return buildSessionNote(input, requestedKind, sourceReason);
  if (isSpeculativeContent(input.content)) return buildSessionNote(input, requestedKind, 'insufficient_structure');

  const attributeKey = firstDefined(
    normalizeProfileAttribute(input.attributeKey),
    inferProfileRuleAttribute(input.content, ownerScope),
  );
  if (!attributeKey) return buildSessionNote(input, requestedKind, reasonForMissingStructure(input.content, 'attribute'));
  if (
    ownerScope === 'user' &&
    (attributeKey === 'language_preference' || attributeKey === 'response_length' || attributeKey === 'solution_complexity') &&
    isWeakConversationalProfileRule(input.content)
  ) {
    return buildSessionNote(input, requestedKind, 'insufficient_structure');
  }

  const subjectKey = ownerScope === 'agent'
    ? normalizeKey(input.subjectKey || 'agent', 'agent')
    : stableSubject(input.subjectKey, input.content) || 'user';
  const valueText = canonicalizeDurableContent({
    kind: 'profile_rule',
    content: input.content,
    owner_scope: ownerScope,
    subject_key: subjectKey,
    attribute_key: attributeKey,
  }) || input.content;

  return outcome(
    {
      kind: 'profile_rule',
      agent_id: input.agentId,
      owner_scope: ownerScope,
      subject_key: subjectKey,
      attribute_key: attributeKey,
      value_text: valueText,
      source_type: input.sourceType,
      tags: input.tags,
      priority: input.priority,
      confidence: input.confidence,
    } satisfies ProfileRuleCandidate,
    requestedKind,
  );
}

function normalizeFactSlot(input: ManualFactSlotInput, requestedKind: RecordKind): NormalizedRecordCandidate {
  const sourceReason = sourceAllowsDurable(input.sourceType);
  if (sourceReason) return buildSessionNote(input, requestedKind, sourceReason);
  if (isSpeculativeContent(input.content)) return buildSessionNote(input, requestedKind, 'insufficient_structure');

  const entityKey = stableEntity(input.entityKey, input.content);
  if (!entityKey) return buildSessionNote(input, requestedKind, reasonForMissingStructure(input.content, 'subject'));

  const attributeKey = firstDefined(
    normalizeFactAttribute(input.attributeKey),
    inferFactSlotAttribute(input.content),
  );
  if (!attributeKey) return buildSessionNote(input, requestedKind, reasonForMissingStructure(input.content, 'attribute'));
  const valueText = canonicalizeDurableContent({
    kind: 'fact_slot',
    content: input.content,
    entity_key: entityKey,
    attribute_key: attributeKey,
  }) || input.content;

  return outcome(
    {
      kind: 'fact_slot',
      agent_id: input.agentId,
      entity_key: entityKey,
      attribute_key: attributeKey,
      value_text: valueText,
      source_type: input.sourceType,
      tags: input.tags,
      priority: input.priority,
      confidence: input.confidence,
    } satisfies FactSlotCandidate,
    requestedKind,
  );
}

function normalizeTaskState(input: ManualTaskStateInput, requestedKind: RecordKind): NormalizedRecordCandidate {
  const sourceReason = sourceAllowsDurable(input.sourceType);
  if (sourceReason) return buildSessionNote(input, requestedKind, sourceReason);
  if (isSpeculativeContent(input.content)) return buildSessionNote(input, requestedKind, 'insufficient_structure');

  const subjectKey = stableSubject(input.subjectKey, input.content);
  if (!subjectKey) return buildSessionNote(input, requestedKind, reasonForMissingStructure(input.content, 'subject'));

  const stateKey = firstDefined(
    normalizeTaskStateKey(input.stateKey),
    inferTaskStateKey(input.content),
  );
  if (!stateKey) return buildSessionNote(input, requestedKind, reasonForMissingStructure(input.content, 'attribute'));
  const summary = canonicalizeDurableContent({
    kind: 'task_state',
    content: input.content,
    subject_key: subjectKey,
    state_key: stateKey,
  }) || input.content;

  return outcome(
    {
      kind: 'task_state',
      agent_id: input.agentId,
      subject_key: subjectKey,
      state_key: stateKey,
      status: inferTaskStatus(input.content, input.status),
      summary,
      source_type: input.sourceType,
      tags: input.tags,
      priority: input.priority,
      confidence: input.confidence,
    } satisfies TaskStateCandidate,
    requestedKind,
  );
}

function normalizeSessionNote(input: BaseNormalizationInput, requestedKind: RecordKind, reasonCode: RecordReasonCode | null = null): NormalizedRecordCandidate {
  return buildSessionNote(input, requestedKind, reasonCode);
}

function normalizeByRequestedKind(
  requestedKind: RecordKind,
  input: BaseNormalizationInput & {
    ownerScope?: 'user' | 'agent';
    subjectKey?: string;
    attributeKey?: string;
    entityKey?: string;
    stateKey?: string;
    status?: string;
  },
): NormalizedRecordCandidate {
  switch (requestedKind) {
    case 'profile_rule':
      return normalizeProfileRule({
        ...input,
        ownerScope: input.ownerScope,
        subjectKey: input.subjectKey,
        attributeKey: input.attributeKey,
      }, requestedKind);
    case 'fact_slot':
      return normalizeFactSlot({
        ...input,
        entityKey: input.entityKey,
        attributeKey: input.attributeKey,
      }, requestedKind);
    case 'task_state':
      return normalizeTaskState({
        ...input,
        subjectKey: input.subjectKey,
        stateKey: input.stateKey,
        status: input.status,
      }, requestedKind);
    case 'session_note':
    default:
      return normalizeSessionNote(input, requestedKind);
  }
}

function legacySourceType(memory: Memory): SourceType {
  if (memory.category.startsWith('agent_')) return 'system_derived';
  if (memory.layer === 'core') return 'user_confirmed';
  return 'user_explicit';
}

function requestedKindFromCategory(category: MemoryCategory, content: string): RecordKind {
  if (category === 'preference' || category === 'constraint' || category === 'agent_persona') return 'profile_rule';
  if (category === 'decision' || category === 'goal' || category === 'project_state' || category === 'todo') return 'task_state';
  if (category === 'identity') {
    return /我叫|名字|my name|call me/i.test(content) ? 'profile_rule' : 'fact_slot';
  }
  if (category === 'correction' || category === 'fact' || category === 'skill' || category === 'relationship') return 'fact_slot';
  return 'session_note';
}

export function signalToCandidate(signal: DetectedSignal, agentId: string): NormalizedRecordCandidate {
  const sourceType: SourceType = signal.category.startsWith('agent_')
    ? 'assistant_inferred'
    : signal.category === 'agent_persona'
      ? 'system_derived'
      : 'user_explicit';
  const requestedKind = requestedKindFromCategory(signal.category, signal.content);
  return normalizeByRequestedKind(requestedKind, {
    agentId,
    content: signal.content.trim(),
    sourceType,
    tags: [signal.category],
    priority: clamp01(signal.importance, 0.7),
    confidence: clamp01(signal.confidence, 0.85),
    ownerScope: signal.category === 'agent_persona' ? 'agent' : 'user',
  });
}

export function legacyMemoryToCandidate(memory: Memory): RecordCandidate {
  const normalized = normalizeByRequestedKind(
    requestedKindFromCategory(memory.category, memory.content),
    {
      agentId: memory.agent_id || 'default',
      content: memory.content.trim(),
      sourceType: legacySourceType(memory),
      tags: [memory.category, `legacy_${memory.layer}`],
      priority: clamp01(memory.importance ?? 0.6, 0.6),
      confidence: clamp01(memory.importance ?? 0.75, 0.75),
      ownerScope: memory.category === 'agent_persona' ? 'agent' : 'user',
    },
  );
  return normalized.candidate;
}

function parseSourceType(raw: string | undefined): SourceType {
  if (raw === 'user_explicit' || raw === 'user_confirmed' || raw === 'assistant_inferred' || raw === 'system_derived') {
    return raw;
  }
  return 'user_explicit';
}

function contentFromExtracted(raw: PartialExtractedRecord): string {
  if (typeof raw.value_text === 'string' && raw.value_text.trim()) return raw.value_text.trim();
  if (typeof raw.summary === 'string' && raw.summary.trim()) return raw.summary.trim();
  return '';
}

export function extractedRecordToCandidate(
  raw: PartialExtractedRecord,
  agentId: string,
  fallbackSessionId?: string,
): NormalizedRecordCandidate | null {
  const content = contentFromExtracted(raw);
  if (!content) return null;

  const requestedKind = isRecordKind(raw.kind) ? raw.kind : 'session_note';
  const invalidKind = raw.kind && !isRecordKind(raw.kind);
  const base = {
    agentId,
    content,
    sourceType: parseSourceType(raw.source_type),
    tags: normalizeTags(raw.tags),
    priority: clamp01(raw.priority ?? 0.7, 0.7),
    confidence: clamp01(raw.confidence ?? 0.8, 0.8),
    sessionId: fallbackSessionId,
  };

  if (invalidKind) {
    return buildSessionNote(base, 'session_note', 'unsupported_kind');
  }

  if (requestedKind === 'profile_rule') {
    return normalizeProfileRule({
      ...base,
      ownerScope: raw.owner_scope === 'agent' ? 'agent' : 'user',
      subjectKey: typeof raw.subject_key === 'string' ? raw.subject_key : undefined,
      attributeKey: typeof raw.attribute_key === 'string' ? raw.attribute_key : undefined,
    }, requestedKind);
  }

  if (requestedKind === 'fact_slot') {
    return normalizeFactSlot({
      ...base,
      entityKey: typeof raw.entity_key === 'string' ? raw.entity_key : undefined,
      attributeKey: typeof raw.attribute_key === 'string' ? raw.attribute_key : undefined,
    }, requestedKind);
  }

  if (requestedKind === 'task_state') {
    return normalizeTaskState({
      ...base,
      subjectKey: typeof raw.subject_key === 'string' ? raw.subject_key : undefined,
      stateKey: typeof raw.state_key === 'string' ? raw.state_key : undefined,
      status: typeof raw.status === 'string' ? raw.status : undefined,
    }, requestedKind);
  }

  return normalizeSessionNote(base, requestedKind);
}

export function normalizeManualInput(agentId: string, input: ManualInput): NormalizedRecordCandidate {
  const content = input.content.trim();
  const sourceType = input.source_type || 'user_confirmed';
  const priority = clamp01(input.priority ?? 0.8, 0.8);
  const tags = Array.isArray(input.tags) ? input.tags.filter(Boolean).slice(0, 8) : [];

  const requestedKind = isRecordKind(input.kind)
    ? input.kind
    : input.kind
      ? 'session_note'
      : inferRequestedKindFromContent(content);

  const base = {
    agentId,
    content,
    sourceType,
    tags,
    priority,
    confidence: 0.95,
    sessionId: input.session_id,
    expiresAt: input.expires_at,
    lifecycleState: input.lifecycle_state,
    retiredAt: input.retired_at,
    purgeAfter: input.purge_after,
  };

  if (input.kind && !isRecordKind(input.kind)) {
    return buildSessionNote(base, 'session_note', 'unsupported_kind');
  }

  return normalizeByRequestedKind(requestedKind, {
    ...base,
    ownerScope: input.owner_scope,
    subjectKey: input.subject_key,
    attributeKey: input.attribute_key,
    entityKey: input.entity_key,
    stateKey: input.state_key,
    status: input.status,
  });
}

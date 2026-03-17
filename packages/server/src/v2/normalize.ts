import { createHash } from 'node:crypto';
import { normalizeEntity, extractEntityTokens } from '../utils/helpers.js';
import type { DetectedSignal } from '../signals/index.js';
import type { Memory, MemoryCategory } from '../db/index.js';
import type {
  RecordCandidate,
  SessionNoteCandidate,
  SourceType,
  FactSlotCandidate,
  ProfileRuleCandidate,
  TaskStateCandidate,
} from './types.js';

const STOP_KEYS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'have', 'from',
  '用户', '自己', '一个', '这个', '那个', '已经', '以后', '之前',
]);

function shortHash(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 8);
}

export function normalizeKey(text: string, fallback = 'note'): string {
  const normalized = normalizeEntity(text)
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return normalized || fallback;
}

function tokensToKey(text: string, fallback: string): string {
  const tokens = extractEntityTokens(text)
    .map(token => normalizeKey(token))
    .filter(token => token && token.length >= 2 && !STOP_KEYS.has(token))
    .slice(0, 3);
  if (tokens.length === 0) return `${fallback}_${shortHash(text)}`;
  return tokens.join('_');
}

function canonicalizeUserNarration(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const replacements: Array<[RegExp, string]> = [
    [/^我的名字是/u, '用户的名字是'],
    [/^我的名字叫/u, '用户的名字叫'],
    [/^我叫/u, '用户叫'],
    [/^我住在/u, '用户住在'],
    [/^我在(.+?)(工作|上班)/u, '用户在$1$2'],
    [/^我喜欢/u, '用户喜欢'],
    [/^我偏好/u, '用户偏好'],
    [/^我讨厌/u, '用户讨厌'],
    [/^我不想/u, '用户不想'],
    [/^我不要/u, '用户不要'],
    [/^我希望/u, '用户希望'],
    [/^我需要/u, '用户需要'],
    [/^我是/u, '用户是'],
    [/^I am\b/i, 'User is'],
    [/^I'm\b/i, 'User is'],
    [/^My name is\b/i, 'User name is'],
    [/^Call me\b/i, 'User is called'],
    [/^I live in\b/i, 'User lives in'],
    [/^I work (?:at|in)\b/i, 'User works at'],
    [/^I prefer\b/i, 'User prefers'],
    [/^I like\b/i, 'User likes'],
    [/^I love\b/i, 'User likes'],
    [/^I hate\b/i, 'User dislikes'],
    [/^I do not want\b/i, 'User does not want'],
    [/^I don't want\b/i, 'User does not want'],
    [/^I need\b/i, 'User needs'],
    [/^I want\b/i, 'User wants'],
  ];

  for (const [pattern, replacement] of replacements) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement);
  }

  return trimmed;
}

function profileAttributeFromContent(category: MemoryCategory | null, content: string): string | null {
  if (/我叫|我的名字|my name|call me|name is/i.test(content)) return 'display_name';
  if (/住在|live in|lives in|位于|location|在.+工作|work at|work in/i.test(content)) return 'location';
  if (/喜欢|偏好|prefer|like|讨厌|hate|不想|不要|风格|tone|格式|style/i.test(content)) {
    return `preference_${tokensToKey(content, 'rule')}`;
  }
  if (/禁止|必须|always|never|不要|别|constraint|rule|必须先/i.test(content)) {
    return `constraint_${tokensToKey(content, 'rule')}`;
  }
  if (/policy|策略|流程|优先|default/i.test(content)) return `policy_${tokensToKey(content, 'rule')}`;
  if (category === 'agent_persona') return `persona_${tokensToKey(content, 'persona')}`;
  if (category === 'identity') return `identity_${tokensToKey(content, 'identity')}`;
  return null;
}

function buildSessionNote(
  agentId: string,
  summary: string,
  sourceType: SourceType,
  tags: string[],
  priority: number,
): SessionNoteCandidate {
  return {
    kind: 'session_note',
    agent_id: agentId,
    summary,
    source_type: sourceType,
    tags,
    priority,
    confidence: Math.max(0.4, Math.min(priority, 0.95)),
  };
}

function profileRuleFromCategory(
  agentId: string,
  category: MemoryCategory,
  content: string,
  priority: number,
  sourceType: SourceType,
): ProfileRuleCandidate | null {
  const owner_scope = category === 'agent_persona' ? 'agent' : 'user';
  const normalizedContent = owner_scope === 'user' ? canonicalizeUserNarration(content) : content.trim();
  const attribute = profileAttributeFromContent(category, normalizedContent);
  if (!attribute) return null;

  return {
    kind: 'profile_rule',
    agent_id: agentId,
    owner_scope,
    subject_key: owner_scope === 'agent' ? 'agent' : 'user',
    attribute_key: normalizeKey(attribute, `${category}_rule`),
    value_text: normalizedContent,
    source_type: sourceType,
    priority,
    confidence: Math.max(0.5, Math.min(priority, 0.98)),
    tags: [category],
  };
}

function factSlotFromCategory(
  agentId: string,
  category: MemoryCategory,
  content: string,
  priority: number,
  sourceType: SourceType,
): FactSlotCandidate | null {
  const entityTokens = extractEntityTokens(content).filter(token => token.length >= 2);
  const entityKey = entityTokens.length > 0 ? normalizeKey(entityTokens[0]!, 'user') : 'user';
  let attributeKey = '';

  if (/住在|live in|location|位于/i.test(content)) attributeKey = 'location';
  else if (/工作|work at|works at|company|公司/i.test(content)) attributeKey = 'organization';
  else if (/skill|熟悉|擅长|会|experience|uses/i.test(content)) attributeKey = category === 'skill' ? 'skill' : 'capability';
  else if (/关系|朋友|同事|boss|partner|mentor/i.test(content)) attributeKey = 'relationship';
  else if (/不是|更正|纠正|actually/i.test(content)) attributeKey = 'corrected_fact';
  else if (category === 'fact' || category === 'entity') attributeKey = `${category}_${tokensToKey(content, category)}`;

  if (!attributeKey) return null;

  return {
    kind: 'fact_slot',
    agent_id: agentId,
    entity_key: entityKey,
    attribute_key: normalizeKey(attributeKey, category),
    value_text: content,
    source_type: sourceType,
    priority,
    confidence: Math.max(0.45, Math.min(priority, 0.95)),
    tags: [category],
  };
}

function taskStateFromCategory(
  agentId: string,
  category: MemoryCategory,
  content: string,
  priority: number,
  sourceType: SourceType,
): TaskStateCandidate | null {
  if (!['decision', 'goal', 'project_state', 'todo'].includes(category)) return null;

  const subjectKey = normalizeKey(extractEntityTokens(content)[0] || 'user', 'user');
  const stateKey = normalizeKey(`${category}_${tokensToKey(content, category)}`, category);
  const status = category === 'decision'
    ? 'decided'
    : category === 'goal'
      ? 'planned'
      : category === 'todo'
        ? 'open'
        : 'active';

  return {
    kind: 'task_state',
    agent_id: agentId,
    subject_key: subjectKey,
    state_key: stateKey,
    status,
    summary: content,
    source_type: sourceType,
    priority,
    confidence: Math.max(0.45, Math.min(priority, 0.95)),
    tags: [category],
  };
}

export function signalToCandidate(signal: DetectedSignal, agentId: string): RecordCandidate {
  const sourceType: SourceType = signal.category === 'agent_persona' ? 'system_derived' : 'user_explicit';
  const priority = signal.importance;

  const profile = profileRuleFromCategory(agentId, signal.category, signal.content, priority, sourceType);
  if (profile) return profile;

  const fact = factSlotFromCategory(agentId, signal.category, signal.content, priority, sourceType);
  if (fact) return fact;

  const task = taskStateFromCategory(agentId, signal.category, signal.content, priority, sourceType);
  if (task) return task;

  return buildSessionNote(agentId, signal.content, sourceType, [signal.category], priority);
}

function legacySourceType(memory: Memory): SourceType {
  if (memory.category.startsWith('agent_')) return 'system_derived';
  if (memory.layer === 'core') return 'user_confirmed';
  return 'user_explicit';
}

export function legacyMemoryToCandidate(memory: Memory): RecordCandidate {
  const agentId = memory.agent_id || 'default';
  const sourceType = legacySourceType(memory);
  const priority = Math.max(memory.importance ?? 0.5, 0.4);
  const tags = [memory.category, `legacy_${memory.layer}`];

  const profile = profileRuleFromCategory(agentId, memory.category, memory.content, priority, sourceType);
  if (profile) return { ...profile, tags };

  const fact = factSlotFromCategory(agentId, memory.category, memory.content, priority, sourceType);
  if (fact) return { ...fact, tags };

  const task = taskStateFromCategory(agentId, memory.category, memory.content, priority, sourceType);
  if (task) return { ...task, tags };

  return buildSessionNote(agentId, memory.content, sourceType, tags, priority);
}

type PartialExtractedRecord = Partial<RecordCandidate> & {
  kind?: string;
  confidence?: number;
  priority?: number;
  tags?: unknown;
  source_type?: string;
};

function parseSourceType(raw: string | undefined): SourceType {
  if (raw === 'user_explicit' || raw === 'user_confirmed' || raw === 'assistant_inferred' || raw === 'system_derived') {
    return raw;
  }
  return 'user_explicit';
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function extractedRecordToCandidate(
  raw: PartialExtractedRecord,
  agentId: string,
  fallbackSessionId?: string,
): RecordCandidate | null {
  const kind = raw.kind;
  const sourceType = parseSourceType(raw.source_type);
  const priority = typeof raw.priority === 'number' ? Math.max(0, Math.min(raw.priority, 1)) : 0.7;
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(raw.confidence, 1)) : 0.8;
  const tags = parseTags(raw.tags);

  if (kind === 'profile_rule') {
    const owner_scope = raw.owner_scope === 'agent' ? 'agent' : 'user';
    const subject_key = typeof raw.subject_key === 'string' ? normalizeKey(raw.subject_key, owner_scope) : owner_scope;
    const value_text = typeof raw.value_text === 'string'
      ? (owner_scope === 'user' ? canonicalizeUserNarration(raw.value_text) : raw.value_text.trim())
      : '';
    const inferredAttribute = owner_scope === 'user' ? profileAttributeFromContent(null, value_text) : null;
    const attribute_key = normalizeKey(
      inferredAttribute || (typeof raw.attribute_key === 'string' ? raw.attribute_key : ''),
      owner_scope === 'agent' ? 'persona_rule' : 'user_rule',
    );
    if (!attribute_key || !value_text) return null;
    return {
      kind,
      agent_id: agentId,
      owner_scope,
      subject_key,
      attribute_key,
      value_text,
      source_type: sourceType,
      priority,
      confidence,
      tags,
    };
  }

  if (kind === 'fact_slot') {
    const entity_key = typeof raw.entity_key === 'string' ? normalizeKey(raw.entity_key, 'user') : 'user';
    const attribute_key = typeof raw.attribute_key === 'string' ? normalizeKey(raw.attribute_key) : '';
    const value_text = typeof raw.value_text === 'string' ? raw.value_text.trim() : '';
    if (!attribute_key || !value_text) return null;
    return {
      kind,
      agent_id: agentId,
      entity_key,
      attribute_key,
      value_text,
      source_type: sourceType,
      priority,
      confidence,
      tags,
    };
  }

  if (kind === 'task_state') {
    const subject_key = typeof raw.subject_key === 'string' ? normalizeKey(raw.subject_key, 'user') : 'user';
    const state_key = typeof raw.state_key === 'string' ? normalizeKey(raw.state_key) : '';
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const status = typeof raw.status === 'string' ? normalizeKey(raw.status, 'active') : 'active';
    if (!state_key || !summary) return null;
    return {
      kind,
      agent_id: agentId,
      subject_key,
      state_key,
      status,
      summary,
      source_type: sourceType,
      priority,
      confidence,
      tags,
    };
  }

  if (kind === 'session_note') {
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    if (!summary) return null;
    return {
      kind,
      agent_id: agentId,
      session_id: fallbackSessionId,
      summary,
      source_type: sourceType,
      priority,
      confidence,
      tags,
    };
  }

  return null;
}

export function normalizeManualInput(
  agentId: string,
  input: {
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
  },
): RecordCandidate {
  const content = input.content.trim();
  const sourceType = input.source_type || 'user_confirmed';
  const priority = input.priority ?? 0.8;
  const tags = input.tags || [];

  switch (input.kind) {
    case 'profile_rule': {
      const ownerScope = input.owner_scope || 'user';
      const normalizedContent = ownerScope === 'user' ? canonicalizeUserNarration(content) : content;
      const inferredAttribute = ownerScope === 'user' ? profileAttributeFromContent(null, normalizedContent) : null;
      return {
        kind: 'profile_rule',
        agent_id: agentId,
        owner_scope: ownerScope,
        subject_key: normalizeKey(input.subject_key || (ownerScope === 'agent' ? 'agent' : 'user'), 'user'),
        attribute_key: normalizeKey(input.attribute_key || inferredAttribute || tokensToKey(normalizedContent, 'rule'), 'rule'),
        value_text: normalizedContent,
        source_type: sourceType,
        priority,
        confidence: 0.95,
        tags,
      };
    }
    case 'fact_slot': {
      const entityKey = normalizeKey(input.entity_key || extractEntityTokens(content)[0] || 'user', 'user');
      const factContent = entityKey === 'user' ? canonicalizeUserNarration(content) : content;
      return {
        kind: 'fact_slot',
        agent_id: agentId,
        entity_key: entityKey,
        attribute_key: normalizeKey(input.attribute_key || tokensToKey(factContent, 'fact'), 'fact'),
        value_text: factContent,
        source_type: sourceType,
        priority,
        confidence: 0.95,
        tags,
      };
    }
    case 'task_state': {
      const subjectKey = normalizeKey(input.subject_key || extractEntityTokens(content)[0] || 'user', 'user');
      const summary = subjectKey === 'user' ? canonicalizeUserNarration(content) : content;
      return {
        kind: 'task_state',
        agent_id: agentId,
        subject_key: subjectKey,
        state_key: normalizeKey(input.state_key || tokensToKey(summary, 'task'), 'task'),
        status: normalizeKey(input.status || 'active', 'active'),
        summary,
        source_type: sourceType,
        priority,
        confidence: 0.95,
        tags,
      };
    }
    case 'session_note':
    default:
      return {
        kind: 'session_note',
        agent_id: agentId,
        session_id: input.session_id,
        summary: content,
        source_type: sourceType,
        priority,
        confidence: 0.95,
        tags,
      };
  }
}

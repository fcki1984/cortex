import { createLogger } from '../utils/logger.js';
import { extractEntityTokens, estimateTokens } from '../utils/helpers.js';
import { stripCodeFences, stripInjectedContent } from '../utils/sanitize.js';
import { detectHighSignals, isSmallTalk } from '../signals/index.js';
import type { LLMProvider } from '../llm/interface.js';
import type { EmbeddingProvider } from '../embedding/interface.js';
import { V2_EXTRACTION_SYSTEM_PROMPT } from './prompts.js';
import { canDeriveRelationCandidate, isSpeculativeContent } from './contract.js';
import { CortexRelationsV2 } from './relations.js';
import {
  deleteRecord,
  getRecordById,
  getRecordsCount,
  insertConversationRef,
  insertEvidence,
  listAgentPersona,
  listEvidence,
  listRecords,
  migrateLegacyMemories,
  searchFts,
  searchVectors,
  upsertRecord,
  upsertRecordVector,
  updateRecord,
} from './store.js';
import {
  extractedRecordToCandidate,
  normalizeManualInput,
  signalToCandidate,
} from './normalize.js';
import type {
  CortexRecord,
  NormalizedRecordCandidate,
  ProfileRuleRecord,
  RecallOptions,
  RecallResponse,
  RecordKind,
  RecordListOptions,
  RecordUpsertResult,
  SourceType,
} from './types.js';

const log = createLogger('v2');

type SearchResult = CortexRecord & {
  lexical_score: number;
  vector_score: number;
  overlap: number;
  final_score: number;
  intent_match: string[];
  eligible_for_recall: boolean;
  excluded_reason: string | null;
};

type NormalizedRecallIntents = {
  subjects: Set<string>;
  attributes: Set<string>;
  states: Set<string>;
  tokens: Set<string>;
};

type RecordIntentProfile = {
  subjects: Set<string>;
  attributes: Set<string>;
  states: Set<string>;
};

type DurableEligibility = {
  eligible: boolean;
  via: Array<'intent' | 'overlap' | 'lexical' | 'vector'>;
  excluded_reason: string | null;
};

type NoteEligibility = {
  matches_query: boolean;
  excluded_reason: string;
};

const SUBJECT_INTENT_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'user', patterns: [/\buser\b/i, /\bi\b/i, /\bme\b/i, /\bmy\b/i, /用户/i, /我/i, /我的/i] },
  { key: 'agent', patterns: [/\bagent\b/i, /\bassistant\b/i, /\byou\b/i, /助手/i, /你/i, /回答方式/i] },
];

const ATTRIBUTE_INTENT_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'location', patterns: [/\blive\b/i, /\blives\b/i, /\bliving\b/i, /\blocation\b/i, /\bresidence\b/i, /住在哪里/i, /住哪/i, /住在/i, /居住/i] },
  { key: 'organization', patterns: [/\bwork\b/i, /\bworks\b/i, /\bworking\b/i, /\bemployer\b/i, /\bcompany\b/i, /\borganization\b/i, /工作单位/i, /在哪.*工作/i, /在哪里上班/i, /为谁工作/i] },
  { key: 'response_style', patterns: [/\banswer style\b/i, /\bresponse style\b/i, /\brespond\b/i, /\breply\b/i, /\btone\b/i, /怎么回答/i, /如何回答/i, /回答方式/i, /回复方式/i, /回答风格/i, /回复风格/i, /简洁/i, /简短/i] },
  { key: 'persona_style', patterns: [/\bpersona\b/i, /\bresponse style\b/i, /\bassistant style\b/i, /人设/i, /回答方式/i, /回复方式/i, /回答风格/i, /回复风格/i, /助手风格/i] },
  { key: 'response_length', patterns: [/\bverbose\b/i, /\blong\b/i, /\bshort\b/i, /\bbrief\b/i, /\bconcise\b/i, /长篇/i, /冗长/i, /简洁/i, /简短/i] },
  { key: 'language_preference', patterns: [/\blanguage\b/i, /\benglish\b/i, /\bchinese\b/i, /\bjapanese\b/i, /语言/i, /中文/i, /英文/i, /日文/i] },
  { key: 'solution_complexity', patterns: [/\bsimple\b/i, /\blightweight\b/i, /\bcomplex\b/i, /\bsetup\b/i, /\bdeployment\b/i, /\bsolution\b/i, /简单/i, /复杂/i, /部署/i, /解决方案/i, /部署方案/i] },
  { key: 'risk_tolerance', patterns: [/\brisk\b/i, /\btolerance\b/i, /\bprofile\b/i, /风险/i] },
  { key: 'persona_boundary', patterns: [/\bconstraint\b/i, /\brequirement\b/i, /\bmust\b/i, /\bmust not\b/i, /\bavoid\b/i, /不要/i, /必须/i, /约束/i, /要求/i] },
];

const STATE_INTENT_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'current_task', patterns: [/\bcurrent task\b/i, /\bactive task\b/i, /\bcurrent work\b/i, /\bworking on\b/i, /当前任务/i, /现在.*任务/i, /正在做什么/i] },
  { key: 'current_goal', patterns: [/\bgoal\b/i, /\bplan\b/i, /\bwant\b/i, /\btarget\b/i, /目标/i, /计划/i, /打算/i, /想要/i] },
  { key: 'current_decision', patterns: [/\bdecision\b/i, /\bdecide\b/i, /\bchoose\b/i, /决定/i, /选定/i] },
  { key: 'open_todo', patterns: [/\btodo\b/i, /\bto do\b/i, /\bremember\b/i, /\bremind\b/i, /待办/i, /记得/i, /别忘了/i] },
  { key: 'project_status', patterns: [/\bstatus\b/i, /\bproject\b/i, /\bprogress\b/i, /状态/i, /项目/i, /进度/i] },
  { key: 'refactor_status', patterns: [/\brefactor\b/i, /\brewrite\b/i, /重构/i, /改写/i] },
  { key: 'deployment_status', patterns: [/\bdeploy\b/i, /\bdeployment\b/i, /部署/i] },
  { key: 'migration_status', patterns: [/\bmigrate\b/i, /\bmigration\b/i, /迁移/i] },
];

function dedupeKey(candidate: NormalizedRecordCandidate): string {
  const record = candidate.candidate;
  switch (record.kind) {
    case 'profile_rule':
      return `${record.kind}:${record.agent_id}:${record.owner_scope}:${record.subject_key}:${record.attribute_key}`;
    case 'fact_slot':
      return `${record.kind}:${record.agent_id}:${record.entity_key}:${record.attribute_key}`;
    case 'task_state':
      return `${record.kind}:${record.agent_id}:${record.subject_key}:${record.state_key}`;
    case 'session_note':
      return `${record.kind}:${record.agent_id}:${record.session_id || ''}:${record.summary}`;
  }
}

function candidateText(candidate: NormalizedRecordCandidate): string {
  switch (candidate.candidate.kind) {
    case 'profile_rule':
    case 'fact_slot':
      return candidate.candidate.value_text;
    case 'task_state':
    case 'session_note':
      return candidate.candidate.summary;
  }
}

function isAtomicDeterministicInput(content: string): boolean {
  return !/[\n\r,，;；]/.test(content);
}

function buildDeterministicCandidate(
  agentId: string,
  content: string,
  sourceType: SourceType,
  sessionId?: string,
  requestedKind?: RecordKind,
): NormalizedRecordCandidate | null {
  const trimmed = stripInjectedContent(content || '').trim();
  if (!trimmed || !isAtomicDeterministicInput(trimmed)) return null;

  const deterministic = normalizeManualInput(agentId, {
    kind: requestedKind,
    content: trimmed,
    source_type: sourceType,
    session_id: sessionId,
  });

  return deterministic.written_kind === 'session_note' ? null : deterministic;
}

function dropRedundantSessionNotes(
  candidates: NormalizedRecordCandidate[],
  deterministic: NormalizedRecordCandidate | null,
): NormalizedRecordCandidate[] {
  if (!deterministic) return candidates;
  const deterministicText = candidateText(deterministic).trim();
  if (!deterministicText) return candidates;

  return candidates.filter((candidate) => {
    if (candidate.written_kind !== 'session_note') return true;
    return candidateText(candidate).trim() !== deterministicText;
  });
}

function preferDeterministicAtomicCandidate(
  candidates: NormalizedRecordCandidate[],
  deterministic: NormalizedRecordCandidate | null,
): NormalizedRecordCandidate[] {
  if (!deterministic) return candidates;

  const deterministicKey = dedupeKey(deterministic);
  const winner = candidates.find(candidate => dedupeKey(candidate) === deterministicKey) || deterministic;
  return [winner];
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = stripCodeFences(raw).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function sourceAllowed(record: Pick<CortexRecord, 'kind' | 'source_type'> & Partial<Pick<ProfileRuleRecord, 'owner_scope' | 'attribute_key'>>): boolean {
  if (
    record.kind === 'profile_rule' &&
    record.owner_scope === 'agent' &&
    typeof record.attribute_key === 'string' &&
    record.attribute_key.startsWith('persona')
  ) {
    return true;
  }
  return record.source_type === 'user_explicit' || record.source_type === 'user_confirmed';
}

function recordIsActive(record: CortexRecord): boolean {
  if (!record.is_active) return false;
  if (record.kind === 'fact_slot') return !record.valid_to;
  if (record.kind === 'task_state') return !record.valid_to;
  if (record.kind === 'session_note') {
    if (record.lifecycle_state !== 'active') return false;
    if (!record.expires_at) return true;
    return new Date(record.expires_at).getTime() > Date.now();
  }
  return true;
}

function countOverlap(query: string, content: string): number {
  const queryTokens = new Set(extractEntityTokens(query));
  let overlap = 0;
  for (const token of extractEntityTokens(content)) {
    if (queryTokens.has(token)) overlap++;
  }
  return overlap;
}

function kindWeight(kind: RecordKind): number {
  switch (kind) {
    case 'profile_rule':
      return 1.15;
    case 'fact_slot':
      return 1.0;
    case 'task_state':
      return 0.9;
    case 'session_note':
      return 0.55;
  }
}

function sourceWeight(sourceType: SourceType): number {
  switch (sourceType) {
    case 'user_confirmed':
      return 1.05;
    case 'user_explicit':
      return 1.0;
    case 'assistant_inferred':
      return 0.65;
    case 'system_derived':
      return 0.6;
  }
}

function addIntentMatches(text: string, defs: Array<{ key: string; patterns: RegExp[] }>, target: Set<string>) {
  for (const def of defs) {
    if (def.patterns.some(pattern => pattern.test(text))) {
      target.add(def.key);
    }
  }
}

function normalizeRecallIntents(text: string): NormalizedRecallIntents {
  const raw = text.trim();
  const subjects = new Set<string>();
  const attributes = new Set<string>();
  const states = new Set<string>();
  const tokens = new Set<string>(extractEntityTokens(raw));

  addIntentMatches(raw, SUBJECT_INTENT_PATTERNS, subjects);
  addIntentMatches(raw, ATTRIBUTE_INTENT_PATTERNS, attributes);
  addIntentMatches(raw, STATE_INTENT_PATTERNS, states);

  return { subjects, attributes, states, tokens };
}

function serializeIntents(intents: NormalizedRecallIntents) {
  return {
    subjects: Array.from(intents.subjects),
    attributes: Array.from(intents.attributes),
    states: Array.from(intents.states),
    tokens: Array.from(intents.tokens),
  };
}

function intersectSets(left: Set<string>, right: Set<string>): string[] {
  const matches: string[] = [];
  for (const value of left) {
    if (right.has(value)) matches.push(value);
  }
  return matches;
}

function buildRecordIntentProfile(record: CortexRecord): RecordIntentProfile {
  const inferred = normalizeRecallIntents(record.content);
  switch (record.kind) {
    case 'profile_rule':
      return {
        subjects: new Set<string>([...inferred.subjects, record.owner_scope === 'agent' ? 'agent' : record.subject_key]),
        attributes: new Set<string>([...inferred.attributes, record.attribute_key]),
        states: inferred.states,
      };
    case 'fact_slot':
      return {
        subjects: new Set<string>([...inferred.subjects, record.entity_key]),
        attributes: new Set<string>([...inferred.attributes, record.attribute_key]),
        states: inferred.states,
      };
    case 'task_state':
      const taskStates = new Set<string>([...inferred.states, record.state_key]);
      if (
        record.state_key === 'current_goal' ||
        record.state_key === 'project_status' ||
        record.state_key === 'refactor_status' ||
        record.state_key === 'deployment_status' ||
        record.state_key === 'migration_status'
      ) {
        taskStates.add('current_task');
      }
      return {
        subjects: new Set<string>([...inferred.subjects, record.subject_key]),
        attributes: inferred.attributes,
        states: taskStates,
      };
    case 'session_note':
      return inferred;
  }
}

function collectIntentMatches(queryIntents: NormalizedRecallIntents, recordIntents: RecordIntentProfile): string[] {
  return [
    ...intersectSets(queryIntents.subjects, recordIntents.subjects).map(match => `subject:${match}`),
    ...intersectSets(queryIntents.attributes, recordIntents.attributes).map(match => `attribute:${match}`),
    ...intersectSets(queryIntents.states, recordIntents.states).map(match => `state:${match}`),
  ];
}

function splitIntentMatches(matches: string[]): { subject_match: string[]; anchor_match: string[] } {
  return {
    subject_match: matches.filter(match => match.startsWith('subject:')),
    anchor_match: matches.filter(match => match.startsWith('attribute:') || match.startsWith('state:')),
  };
}

function evaluateDurableEligibility(result: Pick<SearchResult, 'kind' | 'source_type' | 'overlap' | 'lexical_score' | 'vector_score' | 'intent_match'>): DurableEligibility {
  if (!sourceAllowed(result)) {
    return { eligible: false, via: [], excluded_reason: 'source_not_allowed' };
  }

  const { subject_match, anchor_match } = splitIntentMatches(result.intent_match);
  const via: Array<'intent' | 'overlap' | 'lexical' | 'vector'> = [];
  if (anchor_match.length > 0) via.push('intent');
  if (result.overlap > 0) via.push('overlap');
  if (result.lexical_score >= 0.12) via.push('lexical');
  if (result.vector_score >= 0.62 && via.length > 0) via.push('vector');
  return {
    eligible: via.length > 0,
    via,
    excluded_reason: via.length > 0
      ? null
      : result.vector_score >= 0.62
        ? 'vector_only_match'
        : subject_match.length > 0
          ? 'subject_only_match'
          : 'below_recall_threshold',
  };
}

function noteMatchesQuery(result: Pick<SearchResult, 'overlap' | 'vector_score' | 'intent_match'>): boolean {
  return evaluateNoteEligibility(result).matches_query;
}

function evaluateNoteEligibility(result: Pick<SearchResult, 'overlap' | 'vector_score' | 'intent_match'>): NoteEligibility {
  const { anchor_match } = splitIntentMatches(result.intent_match);
  if (result.overlap > 0 || anchor_match.length > 0) {
    return {
      matches_query: true,
      excluded_reason: 'session_note_requires_durable_match',
    };
  }
  if (result.vector_score >= 0.35) {
    return {
      matches_query: false,
      excluded_reason: 'vector_only_match',
    };
  }
  return {
    matches_query: false,
    excluded_reason: 'below_recall_threshold',
  };
}

function mergeIntentProfiles(records: CortexRecord[]): RecordIntentProfile {
  const merged: RecordIntentProfile = {
    subjects: new Set<string>(),
    attributes: new Set<string>(),
    states: new Set<string>(),
  };
  for (const record of records) {
    const profile = buildRecordIntentProfile(record);
    for (const value of profile.subjects) merged.subjects.add(value);
    for (const value of profile.attributes) merged.attributes.add(value);
    for (const value of profile.states) merged.states.add(value);
  }
  return merged;
}

function noteCanRideAlong(
  note: SearchResult,
  queryIntents: NormalizedRecallIntents,
  durableIntentProfile: RecordIntentProfile,
): boolean {
  if (note.overlap > 0) return true;
  const noteProfile = buildRecordIntentProfile(note);
  return (
    intersectSets(noteProfile.attributes, durableIntentProfile.attributes).length > 0 ||
    intersectSets(noteProfile.states, durableIntentProfile.states).length > 0 ||
    intersectSets(noteProfile.attributes, queryIntents.attributes).length > 0 ||
    intersectSets(noteProfile.states, queryIntents.states).length > 0
  );
}

function formatRuleLabel(record: CortexRecord): string {
  if (record.kind !== 'profile_rule') return 'Rule';
  if (record.owner_scope === 'agent') return 'Persona';
  if (record.attribute_key.startsWith('constraint')) return 'Constraint';
  if (record.attribute_key.startsWith('policy')) return 'Policy';
  return 'Rule';
}

export class CortexRecordsV2 {
  private readonly relations = new CortexRelationsV2();

  constructor(
    private llm: LLMProvider,
    private embeddingProvider: EmbeddingProvider,
  ) {}

  private createDerivedRelationCandidatesIfNeeded(record: CortexRecord): void {
    if (record.source_type !== 'user_explicit' && record.source_type !== 'user_confirmed') return;
    if (!canDeriveRelationCandidate(record.kind, record.kind === 'fact_slot' ? record.attribute_key : undefined)) return;
    this.relations.createDerivedCandidates(record.id);
  }

  private async collectExchangeCandidates(input: {
    agent_id: string;
    content: string;
    exchange: {
      user: string;
      assistant: string;
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };
    requested_kind?: RecordKind;
    source_type: SourceType;
    session_id?: string;
  }): Promise<{
    candidates: NormalizedRecordCandidate[];
    hintedFallback: NormalizedRecordCandidate;
  }> {
    const fast = detectHighSignals(input.exchange).map(signal => signalToCandidate(signal, input.agent_id));
    const deep = !isSmallTalk(input.content)
      ? await this.extractDeepCandidates(input.exchange, input.agent_id, input.session_id).catch((error: Error) => {
          log.warn({ error: error.message }, 'V2 extraction failed');
          return [] as NormalizedRecordCandidate[];
        })
      : [];

    const merged = new Map<string, NormalizedRecordCandidate>();
    for (const candidate of [...fast, ...deep]) {
      merged.set(dedupeKey(candidate), candidate);
    }

    const hintedFallback = normalizeManualInput(input.agent_id, {
      kind: input.requested_kind,
      content: input.content,
      source_type: input.source_type,
      session_id: input.session_id,
    });
    const deterministic = buildDeterministicCandidate(
      input.agent_id,
      input.content,
      input.source_type,
      input.session_id,
      input.requested_kind,
    );

    if (deterministic) {
      merged.set(dedupeKey(deterministic), deterministic);
    }

    return {
      candidates: preferDeterministicAtomicCandidate(
        dropRedundantSessionNotes(Array.from(merged.values()), deterministic),
        deterministic,
      ),
      hintedFallback,
    };
  }

  async previewImportCandidates(input: {
    agent_id: string;
    content: string;
    requested_kind?: RecordKind;
    source_type?: SourceType;
    session_id?: string;
  }): Promise<NormalizedRecordCandidate[]> {
    const content = stripInjectedContent(input.content || '').trim();
    if (!content) return [];

    const exchange = {
      user: content,
      assistant: '',
      messages: [{ role: 'user' as const, content }],
    };
    const { candidates, hintedFallback } = await this.collectExchangeCandidates({
      agent_id: input.agent_id,
      content,
      exchange,
      requested_kind: input.requested_kind,
      source_type: input.source_type || 'user_confirmed',
      session_id: input.session_id,
    });

    if (candidates.length === 0) {
      return [hintedFallback];
    }

    if (
      input.requested_kind &&
      hintedFallback.written_kind !== 'session_note' &&
      candidates.every(candidate => candidate.written_kind === 'session_note')
    ) {
      return [hintedFallback];
    }

    return candidates;
  }

  async initialize(): Promise<void> {
    const migration = migrateLegacyMemories();
    if (migration.migrated > 0) {
      log.info(migration, 'Migrated legacy memories into v2 records');
    }

    const active = listRecords({
      include_inactive: false,
      limit: Math.max(100, getRecordsCount() + 10),
      order_by: 'updated_at',
      order_dir: 'desc',
    }).items;

    for (const record of active) {
      await this.indexRecord(record).catch((error: Error) => {
        log.debug({ id: record.id, error: error.message }, 'Skipped v2 vector reindex');
      });
    }
  }

  private async indexRecord(record: CortexRecord): Promise<void> {
    const text = record.content.trim();
    if (!text) return;
    const embedding = await this.embeddingProvider.embed(text);
    if (embedding.length > 0) upsertRecordVector(record.id, embedding);
  }

  private async extractDeepCandidates(
    exchange: {
      user: string;
      assistant: string;
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
    agentId: string,
    sessionId?: string,
  ): Promise<NormalizedRecordCandidate[]> {
    if (!this.llm || typeof this.llm.complete !== 'function') return [];

    const segments = exchange.messages && exchange.messages.length > 0
      ? exchange.messages.map(message => `[${message.role.toUpperCase()}]\n${message.content}`).join('\n\n')
      : `[USER]\n${exchange.user}\n\n[ASSISTANT]\n${exchange.assistant}`;

    const raw = await this.llm.complete(segments, {
      maxTokens: 1200,
      temperature: 0.1,
      systemPrompt: V2_EXTRACTION_SYSTEM_PROMPT,
    });

    const parsed = parseJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.records)) return [];

    const records: NormalizedRecordCandidate[] = [];
    for (const item of parsed.records as Array<Record<string, unknown>>) {
      const candidate = extractedRecordToCandidate(item as never, agentId, sessionId);
      if (candidate) records.push(candidate);
    }
    return records;
  }

  async commitNormalizedCandidate(
    normalized: NormalizedRecordCandidate,
    evidence: Array<{ role: 'user' | 'assistant' | 'system'; content: string; conversation_ref_id?: string }> = [],
    opts: { deriveRelationCandidates?: boolean } = {},
  ): Promise<RecordUpsertResult> {
    const result = upsertRecord({
      ...normalized.candidate,
      evidence,
    }, normalized);
    if (evidence.length > 0) {
      insertEvidence(result.record.id, normalized.candidate.agent_id, normalized.candidate.source_type, evidence);
    }
    if (opts.deriveRelationCandidates !== false) {
      this.createDerivedRelationCandidatesIfNeeded(result.record);
    }
    await this.indexRecord(result.record);
    return result;
  }

  async ingest(req: {
    user_message: string;
    assistant_message: string;
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    agent_id?: string;
    session_id?: string;
  }): Promise<{
    records: Array<{
      record_id: string;
      requested_kind: RecordKind;
      written_kind: RecordKind;
      normalization: RecordUpsertResult['normalization'];
      reason_code: RecordUpsertResult['reason_code'];
      decision: RecordUpsertResult['decision'];
      source_type: SourceType;
      content: string;
    }>;
    conversation_ref_id?: string;
    skipped: boolean;
  }> {
    const agentId = req.agent_id || 'default';
    const user = stripInjectedContent(req.user_message || '').trim();
    const assistant = stripInjectedContent(req.assistant_message || '').trim();
    const messages = req.messages?.map(message => ({
      role: message.role,
      content: stripInjectedContent(message.content).trim(),
    })).filter(message => message.content.length > 0);

    if (user.length < 2 && assistant.length < 2) {
      return { records: [], skipped: true };
    }

    const conversationRefId = insertConversationRef({
      agent_id: agentId,
      session_id: req.session_id,
      user_message: user,
      assistant_message: assistant,
      messages_json: messages && messages.length > 0 ? JSON.stringify(messages) : undefined,
    });

    const exchange = { user, assistant, messages };
    let { candidates: normalizedCandidates, hintedFallback } = await this.collectExchangeCandidates({
      agent_id: agentId,
      content: user,
      exchange,
      source_type: 'user_explicit',
      session_id: req.session_id,
    });

    if (normalizedCandidates.length === 0 && !isSmallTalk(user) && hintedFallback.written_kind === 'session_note') {
      if (isSpeculativeContent(user)) {
        normalizedCandidates = [hintedFallback];
      } else if (user.length >= 12) {
        const fallback = normalizeManualInput(agentId, {
          kind: 'session_note',
          content: [user, assistant].filter(Boolean).join('\n').slice(0, 500),
          source_type: 'user_explicit',
          priority: 0.55,
          session_id: req.session_id,
          tags: ['fallback_note'],
        });
        normalizedCandidates = [{
          ...fallback,
          reason_code: 'fallback_summary',
        }];
      }
    }

    const evidence = [
      ...(user ? [{ role: 'user' as const, content: user, conversation_ref_id: conversationRefId }] : []),
      ...(assistant ? [{ role: 'assistant' as const, content: assistant, conversation_ref_id: conversationRefId }] : []),
    ];

    const results: Array<{
      record_id: string;
      requested_kind: RecordKind;
      written_kind: RecordKind;
      normalization: RecordUpsertResult['normalization'];
      reason_code: RecordUpsertResult['reason_code'];
      decision: RecordUpsertResult['decision'];
      source_type: SourceType;
      content: string;
    }> = [];

    for (const normalized of normalizedCandidates) {
      const result = await this.commitNormalizedCandidate(normalized, evidence).catch((error: Error) => {
        const content = normalized.candidate.kind === 'profile_rule' || normalized.candidate.kind === 'fact_slot'
          ? normalized.candidate.value_text
          : normalized.candidate.summary;
        log.debug({ content, error: error.message }, 'V2 record commit failed');
        throw error;
      });
      results.push({
        record_id: result.record.id,
        requested_kind: result.requested_kind,
        written_kind: result.written_kind,
        normalization: result.normalization,
        reason_code: result.reason_code,
        decision: result.decision,
        source_type: result.record.source_type,
        content: result.record.content,
      });
    }

    return {
      records: results,
      conversation_ref_id: conversationRefId,
      skipped: false,
    };
  }

  async remember(input: {
    agent_id?: string;
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
    lifecycle_state?: 'active' | 'dormant' | 'stale';
    retired_at?: string;
    purge_after?: string;
  }): Promise<RecordUpsertResult> {
    const normalized = normalizeManualInput(input.agent_id || 'default', input);
    return this.commitNormalizedCandidate(normalized);
  }

  async search(query: string, opts: { agent_id?: string; limit?: number; recall_only?: boolean } = {}): Promise<SearchResult[]> {
    const queryIntents = normalizeRecallIntents(query);
    const fts = searchFts(query, { agent_id: opts.agent_id, limit: Math.max(20, (opts.limit || 10) * 3) });
    let vectorHits: Array<{ id: string; score: number }> = [];

    try {
      const embedding = await this.embeddingProvider.embed(query);
      if (embedding.length > 0) {
        vectorHits = searchVectors(embedding, { agent_id: opts.agent_id, limit: Math.max(20, (opts.limit || 10) * 3) });
      }
    } catch (error: any) {
      log.debug({ error: error.message }, 'V2 vector search failed, using FTS only');
    }

    const scoreMap = new Map<string, { lexical: number; vector: number }>();
    for (const hit of fts) {
      const current = scoreMap.get(hit.id) || { lexical: 0, vector: 0 };
      current.lexical = Math.max(current.lexical, hit.score);
      scoreMap.set(hit.id, current);
    }
    for (const hit of vectorHits) {
      const current = scoreMap.get(hit.id) || { lexical: 0, vector: 0 };
      current.vector = Math.max(current.vector, hit.score);
      scoreMap.set(hit.id, current);
    }

    const fallbackPool = listRecords({
      agent_id: opts.agent_id,
      include_inactive: false,
      limit: Math.max(50, getRecordsCount(opts.agent_id) + 10),
      order_by: 'updated_at',
      order_dir: 'desc',
    }).items;

    for (const record of fallbackPool) {
      const overlap = countOverlap(query, record.content);
      const directContains = record.content.includes(query);
      const intentMatch = collectIntentMatches(queryIntents, buildRecordIntentProfile(record));
      const { subject_match, anchor_match } = splitIntentMatches(intentMatch);
      if (!directContains && overlap === 0 && intentMatch.length === 0) continue;
      const current = scoreMap.get(record.id) || { lexical: 0, vector: 0 };
      const lexical = directContains
        ? 0.95
        : anchor_match.length > 0
          ? Math.min(0.32 + anchor_match.length * 0.08, 0.72)
          : overlap > 0
            ? Math.min(0.2 + overlap * 0.15, 0.8)
            : Math.min(0.04 + subject_match.length * 0.01, 0.08);
      current.lexical = Math.max(current.lexical, lexical);
      scoreMap.set(record.id, current);
    }

    const results = Array.from(scoreMap.entries())
      .map(([id, score]) => {
        const record = getRecordById(id);
        if (!record || !recordIsActive(record)) return null;
        const intentMatch = collectIntentMatches(queryIntents, buildRecordIntentProfile(record));
        const overlap = countOverlap(query, record.content);
        const durability = record.kind === 'session_note'
          ? (() => {
              const noteEligibility = evaluateNoteEligibility({
                overlap,
                vector_score: score.vector,
                intent_match: intentMatch,
              });
              return {
                eligible: false,
                via: [] as Array<'intent' | 'overlap' | 'lexical' | 'vector'>,
                excluded_reason: noteEligibility.excluded_reason,
              };
            })()
          : evaluateDurableEligibility({
              kind: record.kind,
              source_type: record.source_type,
              overlap,
              lexical_score: score.lexical,
              vector_score: score.vector,
              intent_match: intentMatch,
            });
        const final = (score.lexical * 0.6 + score.vector * 0.4) * kindWeight(record.kind) * sourceWeight(record.source_type);
        return {
          ...record,
          lexical_score: score.lexical,
          vector_score: score.vector,
          overlap,
          final_score: final,
          intent_match: intentMatch,
          eligible_for_recall: durability.eligible,
          excluded_reason: durability.excluded_reason,
        } satisfies SearchResult;
      })
      .filter((result): result is SearchResult => !!result);

    const filtered = opts.recall_only
      ? results.filter(result => {
          if (result.kind === 'session_note') return noteMatchesQuery(result);
          return result.eligible_for_recall;
        })
      : results;

    return filtered
      .sort((a, b) => b.final_score - a.final_score)
      .slice(0, opts.limit || 10);
  }

  async recall(opts: RecallOptions): Promise<RecallResponse> {
    const start = Date.now();
    const query = stripInjectedContent(opts.query).trim();
    const persona = listAgentPersona(opts.agent_id);
    const queryIntents = normalizeRecallIntents(query);

    if (!query || isSmallTalk(query)) {
      const context = this.packContext(persona, [], [], [], opts.max_tokens || 800);
      return {
        context,
        rules: persona,
        facts: [],
        task_state: [],
        session_notes: [],
        meta: {
          query,
          total_candidates: 0,
          durable_candidate_count: 0,
          note_candidate_count: 0,
          injected_count: context ? context.split('\n').filter(line => line.startsWith('[')).length : 0,
          skipped: true,
          normalized_intents: serializeIntents(queryIntents),
          relevance_basis: [],
          reason: 'small_talk',
          latency_ms: Date.now() - start,
        },
      };
    }

    const searchResults = await this.search(query, { agent_id: opts.agent_id, limit: 12, recall_only: true });
    const durableCandidates = searchResults.filter((result): result is SearchResult & { kind: 'profile_rule' | 'fact_slot' | 'task_state' } =>
      result.kind !== 'session_note' && result.eligible_for_recall,
    );
    const noteCandidates = searchResults.filter((result): result is SearchResult & { kind: 'session_note' } => result.kind === 'session_note');
    const relevancePassed = durableCandidates.length > 0;

    const rules = durableCandidates
      .filter((result): result is SearchResult & { kind: 'profile_rule' } => result.kind === 'profile_rule')
      .map(result => result as SearchResult & { kind: 'profile_rule' })
      .filter(result => !(result.owner_scope === 'agent' && result.attribute_key.startsWith('persona')));

    const facts = durableCandidates.filter((result): result is SearchResult & { kind: 'fact_slot' } => result.kind === 'fact_slot');
    const taskState = durableCandidates.filter((result): result is SearchResult & { kind: 'task_state' } => result.kind === 'task_state');
    const durableIntentProfile = mergeIntentProfiles(durableCandidates);
    const notes = relevancePassed
      ? noteCandidates.filter(note => noteCanRideAlong(note, queryIntents, durableIntentProfile)).slice(0, 1)
      : [];

    const context = relevancePassed
      ? this.packContext(persona, rules, facts, [...taskState, ...notes], opts.max_tokens || 800)
      : this.packContext(persona, [], [], [], opts.max_tokens || 800);

    return {
      context,
      rules: [...persona, ...rules].slice(0, 8),
      facts,
      task_state: taskState,
      session_notes: notes,
      meta: {
        query,
        total_candidates: searchResults.length,
        durable_candidate_count: durableCandidates.length,
        note_candidate_count: noteCandidates.length,
        injected_count: context ? context.split('\n').filter(line => line.startsWith('[')).length : 0,
        skipped: false,
        normalized_intents: serializeIntents(queryIntents),
        relevance_basis: durableCandidates.map(result => {
          const { anchor_match } = splitIntentMatches(result.intent_match);
          const via: Array<'intent' | 'overlap' | 'lexical' | 'vector'> = [];
          if (anchor_match.length > 0) via.push('intent');
          if (result.overlap > 0) via.push('overlap');
          if (result.lexical_score >= 0.12) via.push('lexical');
          if (result.vector_score >= 0.62) via.push('vector');
          return {
            record_id: result.id,
            kind: result.kind,
            via,
            intent_match: result.intent_match,
          };
        }),
        ...(relevancePassed ? {} : { reason: 'low_relevance' }),
        latency_ms: Date.now() - start,
      },
    };
  }

  private packContext(
    persona: CortexRecord[],
    rules: CortexRecord[],
    facts: CortexRecord[],
    tail: CortexRecord[],
    maxTokens: number,
  ): string {
    const lines: string[] = ['<cortex_memory_v2>'];
    let tokens = estimateTokens(lines[0]!);
    const pushLine = (label: string, content: string) => {
      const line = `[${label}] ${content}`;
      const lineTokens = estimateTokens(line);
      if (tokens + lineTokens > maxTokens - 20) return false;
      lines.push(line);
      tokens += lineTokens;
      return true;
    };

    for (const record of persona) {
      if (!pushLine(formatRuleLabel(record), record.content)) break;
    }
    for (const record of rules) {
      if (!pushLine(formatRuleLabel(record), record.content)) break;
    }
    for (const record of facts) {
      if (!pushLine('Fact', record.content)) break;
    }
    for (const record of tail) {
      if (!pushLine(record.kind === 'task_state' ? 'Task' : 'Session', record.content)) break;
    }

    if (lines.length === 1) return '';
    lines.push('</cortex_memory_v2>');
    return lines.join('\n');
  }

  listRecords(opts: RecordListOptions) {
    return listRecords(opts);
  }

  getRecord(id: string) {
    return getRecordById(id);
  }

  getEvidence(id: string) {
    return listEvidence(id);
  }

  async updateRecord(
    id: string,
    patch: {
      content?: string;
      tags?: string[];
      priority?: number;
      source_type?: SourceType;
      status?: string;
    },
  ) {
    const updated = updateRecord(id, patch);
    if (updated) {
      this.relations.refreshDerivedCandidates(updated.id);
      await this.indexRecord(updated);
    }
    return updated;
  }

  async deleteRecord(id: string) {
    return deleteRecord(id);
  }
}

import { createLogger } from '../utils/logger.js';
import { extractEntityTokens, estimateTokens } from '../utils/helpers.js';
import { stripCodeFences, stripInjectedContent } from '../utils/sanitize.js';
import { detectHighSignals, isSmallTalk } from '../signals/index.js';
import type { LLMProvider } from '../llm/interface.js';
import type { EmbeddingProvider } from '../embedding/interface.js';
import { V2_EXTRACTION_SYSTEM_PROMPT } from './prompts.js';
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
  RecallOptions,
  RecallResponse,
  RecordCandidate,
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
};

function dedupeKey(candidate: RecordCandidate): string {
  switch (candidate.kind) {
    case 'profile_rule':
      return `${candidate.kind}:${candidate.agent_id}:${candidate.owner_scope}:${candidate.subject_key}:${candidate.attribute_key}`;
    case 'fact_slot':
      return `${candidate.kind}:${candidate.agent_id}:${candidate.entity_key}:${candidate.attribute_key}`;
    case 'task_state':
      return `${candidate.kind}:${candidate.agent_id}:${candidate.subject_key}:${candidate.state_key}`;
    case 'session_note':
      return `${candidate.kind}:${candidate.agent_id}:${candidate.session_id || ''}:${candidate.summary}`;
  }
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

function sourceAllowed(record: CortexRecord): boolean {
  if (record.kind === 'profile_rule' && record.owner_scope === 'agent' && record.attribute_key.startsWith('persona')) {
    return true;
  }
  return record.source_type === 'user_explicit' || record.source_type === 'user_confirmed';
}

function recordIsActive(record: CortexRecord): boolean {
  if (!record.is_active) return false;
  if (record.kind === 'fact_slot') return !record.valid_to;
  if (record.kind === 'task_state') return !record.valid_to;
  if (record.kind === 'session_note') {
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

function hasLexicalEvidence(result: SearchResult): boolean {
  return result.overlap > 0 || result.lexical_score >= 0.12;
}

function passesRecallAdmission(result: SearchResult): boolean {
  if (!sourceAllowed(result)) return false;
  if (result.kind === 'session_note') return result.overlap > 0 || result.lexical_score >= 0.18;
  return hasLexicalEvidence(result);
}

function formatRuleLabel(record: CortexRecord): string {
  if (record.kind !== 'profile_rule') return 'Rule';
  if (record.owner_scope === 'agent') return 'Persona';
  if (record.attribute_key.startsWith('constraint')) return 'Constraint';
  if (record.attribute_key.startsWith('policy')) return 'Policy';
  return 'Rule';
}

export class CortexRecordsV2 {
  constructor(
    private llm: LLMProvider,
    private embeddingProvider: EmbeddingProvider,
  ) {}

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
  ): Promise<RecordCandidate[]> {
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

    const records: RecordCandidate[] = [];
    for (const item of parsed.records as Array<Record<string, unknown>>) {
      const candidate = extractedRecordToCandidate(item as never, agentId, sessionId);
      if (candidate) records.push(candidate);
    }
    return records;
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
      kind: RecordKind;
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
    const fast = detectHighSignals(exchange).map(signal => signalToCandidate(signal, agentId));
    const deep = !isSmallTalk(user)
      ? await this.extractDeepCandidates(exchange, agentId, req.session_id).catch((error: Error) => {
          log.warn({ error: error.message }, 'V2 deep extraction failed');
          return [] as RecordCandidate[];
        })
      : [];

    const merged = new Map<string, RecordCandidate>();
    for (const candidate of [...fast, ...deep]) {
      merged.set(dedupeKey(candidate), candidate);
    }

    if (merged.size === 0 && !isSmallTalk(user) && user.length >= 12) {
      const fallback = normalizeManualInput(agentId, {
        kind: 'session_note',
        content: [user, assistant].filter(Boolean).join('\n').slice(0, 500),
        source_type: 'user_explicit',
        priority: 0.55,
        session_id: req.session_id,
        tags: ['fallback_note'],
      });
      merged.set(dedupeKey(fallback), fallback);
    }

    const evidence = [
      ...(user ? [{ role: 'user' as const, content: user, conversation_ref_id: conversationRefId }] : []),
      ...(assistant ? [{ role: 'assistant' as const, content: assistant, conversation_ref_id: conversationRefId }] : []),
    ];

    const results: Array<{
      record_id: string;
      kind: RecordKind;
      decision: RecordUpsertResult['decision'];
      source_type: SourceType;
      content: string;
    }> = [];

    for (const candidate of merged.values()) {
      const result = upsertRecord({
        ...candidate,
        evidence,
      });
      insertEvidence(result.record.id, agentId, candidate.source_type, evidence);
      await this.indexRecord(result.record).catch((error: Error) => {
        log.debug({ id: result.record.id, error: error.message }, 'V2 vector indexing failed');
      });
      results.push({
        record_id: result.record.id,
        kind: result.record.kind,
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
  }): Promise<RecordUpsertResult> {
    const candidate = normalizeManualInput(input.agent_id || 'default', input);
    const result = upsertRecord(candidate);
    await this.indexRecord(result.record);
    return result;
  }

  async search(query: string, opts: { agent_id?: string; limit?: number; recall_only?: boolean } = {}): Promise<SearchResult[]> {
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

    if (fts.length === 0) {
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
        if (!directContains && overlap === 0) continue;
        const current = scoreMap.get(record.id) || { lexical: 0, vector: 0 };
        const lexical = directContains ? 0.95 : Math.min(0.2 + overlap * 0.15, 0.8);
        current.lexical = Math.max(current.lexical, lexical);
        scoreMap.set(record.id, current);
      }
    }

    const results = Array.from(scoreMap.entries())
      .map(([id, score]) => {
        const record = getRecordById(id);
        if (!record || !recordIsActive(record)) return null;
        const overlap = countOverlap(query, record.content);
        const final = (score.lexical * 0.6 + score.vector * 0.4) * kindWeight(record.kind) * sourceWeight(record.source_type);
        return {
          ...record,
          lexical_score: score.lexical,
          vector_score: score.vector,
          overlap,
          final_score: final,
        } satisfies SearchResult;
      })
      .filter((result): result is SearchResult => !!result);

    const filtered = opts.recall_only ? results.filter(result => passesRecallAdmission(result)) : results;

    return filtered
      .sort((a, b) => b.final_score - a.final_score)
      .slice(0, opts.limit || 10);
  }

  async recall(opts: RecallOptions): Promise<RecallResponse> {
    const start = Date.now();
    const query = stripInjectedContent(opts.query).trim();
    const persona = listAgentPersona(opts.agent_id);

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
          injected_count: context ? context.split('\n').filter(line => line.startsWith('[')).length : 0,
          skipped: true,
          reason: 'small_talk',
          latency_ms: Date.now() - start,
        },
      };
    }

    const searchResults = await this.search(query, { agent_id: opts.agent_id, limit: 12, recall_only: true });
    const relevancePassed = searchResults.some(result => hasLexicalEvidence(result));

    const rules = searchResults
      .filter((result): result is SearchResult & { kind: 'profile_rule' } => result.kind === 'profile_rule')
      .map(result => result as SearchResult & { kind: 'profile_rule' })
      .filter(result => !(result.owner_scope === 'agent' && result.attribute_key.startsWith('persona')));

    const facts = searchResults.filter((result): result is SearchResult & { kind: 'fact_slot' } => result.kind === 'fact_slot');
    const taskState = searchResults.filter((result): result is SearchResult & { kind: 'task_state' } => result.kind === 'task_state');
    const notes = searchResults
      .filter((result): result is SearchResult & { kind: 'session_note' } => result.kind === 'session_note')
      .slice(0, 1);

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
        injected_count: context ? context.split('\n').filter(line => line.startsWith('[')).length : 0,
        skipped: false,
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
    if (updated) await this.indexRecord(updated);
    return updated;
  }

  async deleteRecord(id: string) {
    return deleteRecord(id);
  }
}

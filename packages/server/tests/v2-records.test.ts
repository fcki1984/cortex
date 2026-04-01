import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, closeDatabase, insertMemory } from '../src/db/index.js';
import { CortexRecordsV2 } from '../src/v2/service.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import type { LLMProvider } from '../src/llm/interface.js';

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock',
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([]),
    embedBatch: vi.fn().mockResolvedValue([]),
  };
}

function createVectorOnlyEmbedding(): EmbeddingProvider {
  const vector = [1, 0, 0, 0];
  return {
    name: 'vector-only-mock',
    dimensions: 4,
    embed: vi.fn().mockImplementation(async (text: string) => {
      if (
        text.includes('我住大阪') ||
        text.includes('我喜欢简洁回答') ||
        text.includes('最近也许会考虑换方案') ||
        text.includes('最近是否要换方案')
      ) {
        return vector;
      }
      return [];
    }),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(text => {
      if (
        text.includes('我住大阪') ||
        text.includes('我喜欢简洁回答') ||
        text.includes('最近也许会考虑换方案') ||
        text.includes('最近是否要换方案')
      ) {
        return vector;
      }
      return [];
    })),
  };
}

function createMockLLM(): LLMProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockResolvedValue('{"records":[],"nothing_extracted":true}'),
  };
}

describe('CortexRecordsV2', () => {
  let service: CortexRecordsV2;

  beforeAll(async () => {
    initDatabase(':memory:');
    insertMemory({
      layer: 'core',
      category: 'identity',
      content: '用户住在东京',
      agent_id: 'legacy-agent',
      importance: 0.9,
    });
    service = new CortexRecordsV2(createMockLLM(), createMockEmbedding());
    await service.initialize();
  });

  afterAll(() => {
    closeDatabase();
  });

  it('migrates legacy memories into v2 records on initialize', () => {
    const records = service.listRecords({ agent_id: 'legacy-agent', limit: 10 });
    expect(records.items.length).toBeGreaterThan(0);
    expect(records.items[0]?.kind).toBe('fact_slot');
  });

  it('supersedes existing fact slots when the same key receives a new value', async () => {
    const first = await service.remember({
      agent_id: 'test-agent',
      kind: 'fact_slot',
      content: '用户住在东京',
      entity_key: 'user',
      attribute_key: 'location',
    });

    const second = await service.remember({
      agent_id: 'test-agent',
      kind: 'fact_slot',
      content: '用户住在大阪',
      entity_key: 'user',
      attribute_key: 'location',
    });

    expect(first.decision).toBe('inserted');
    expect(second.decision).toBe('superseded');

    const recall = await service.recall({ query: '用户住在哪里', agent_id: 'test-agent' });
    expect(recall.facts.some(record => record.content.includes('大阪'))).toBe(true);
    expect(recall.facts.some(record => record.content.includes('东京'))).toBe(false);
  });

  it('recalls a Chinese durable fact for an English location query via intent bridging', async () => {
    await service.remember({
      agent_id: 'cross-language-fact-agent',
      kind: 'fact_slot',
      content: '我住大阪',
      entity_key: 'user',
      attribute_key: 'location',
    });

    const recall = await service.recall({ query: 'Where does the user live?', agent_id: 'cross-language-fact-agent' });
    expect(recall.facts.some(record => record.content.includes('大阪'))).toBe(true);
    expect(recall.context).toContain('大阪');
    expect((recall.meta as any).normalized_intents?.attributes).toContain('location');
    expect((recall.meta as any).relevance_basis?.some((item: any) => item.kind === 'fact_slot')).toBe(true);
  });

  it('recalls an English response-style rule for a Chinese recall query via intent bridging', async () => {
    await service.remember({
      agent_id: 'cross-language-rule-agent',
      kind: 'profile_rule',
      content: 'I prefer concise answers.',
      source_type: 'user_confirmed',
    });

    const recall = await service.recall({ query: '你应该怎么回答？', agent_id: 'cross-language-rule-agent' });
    expect(recall.rules.some(record => record.content.includes('concise answers'))).toBe(true);
    expect(recall.context).toContain('concise answers');
    expect((recall.meta as any).normalized_intents?.attributes?.some((item: string) => item === 'response_style' || item === 'persona_style')).toBe(true);
  });

  it('normalizes plain residence statements into durable location facts', async () => {
    const result = await service.remember({
      agent_id: 'plain-location-agent',
      kind: 'fact_slot',
      content: '我住大阪',
    });

    expect(result.record.kind).toBe('fact_slot');
    expect(result.record.attribute_key).toBe('location');
    expect(result.normalization).toBe('durable');

    const recall = await service.recall({ query: 'Where does the user live?', agent_id: 'plain-location-agent' });
    expect(recall.facts).toHaveLength(1);
    expect(recall.facts[0]?.content).toContain('大阪');
    expect(recall.meta.reason).toBeUndefined();
  });

  it('does not recall assistant inferred durable records by default', async () => {
    await service.remember({
      agent_id: 'inferred-agent',
      kind: 'fact_slot',
      content: '用户可能偏好咖啡',
      entity_key: 'user',
      attribute_key: 'drink_preference',
      source_type: 'assistant_inferred',
    });

    const recall = await service.recall({ query: '咖啡', agent_id: 'inferred-agent' });
    expect(recall.facts).toHaveLength(0);
    expect(recall.context).toBe('');
  });

  it('downgrades ambiguous manual durable writes to session_note with a reason code', async () => {
    const result = await service.remember({
      agent_id: 'ambiguous-agent',
      kind: 'fact_slot',
      content: '最近也许会考虑换方案',
    });

    expect(result.requested_kind).toBe('fact_slot');
    expect(result.written_kind).toBe('session_note');
    expect(result.normalization).toBe('downgraded_to_session_note');
    expect(result.reason_code).toBe('insufficient_structure');
    expect(result.record.kind).toBe('session_note');
  });

  it('keeps explicit preference writes on a single durable profile rule key', async () => {
    const first = await service.remember({
      agent_id: 'preference-agent',
      kind: 'profile_rule',
      content: '我喜欢简洁回答，不要长篇解释。',
    });

    const second = await service.remember({
      agent_id: 'preference-agent',
      kind: 'profile_rule',
      content: '用户偏好简洁回答，不要长篇解释。',
      source_type: 'user_confirmed',
    });

    expect(first.record.kind).toBe('profile_rule');
    expect(second.record.kind).toBe('profile_rule');
    expect(second.decision).toBe('superseded');

    const records = service.listRecords({ agent_id: 'preference-agent', kind: 'profile_rule', limit: 10 });
    expect(records.items).toHaveLength(1);
    expect(records.items[0]?.content).toContain('简洁回答');
  });

  it('stores colloquial stable profile-rule writes using canonical durable content', async () => {
    const language = await service.remember({
      agent_id: 'colloquial-profile-rule-agent',
      kind: 'profile_rule',
      content: '之后都用中文',
    });

    const length = await service.remember({
      agent_id: 'colloquial-profile-rule-agent',
      kind: 'profile_rule',
      content: '三句话内就行',
    });

    const complexity = await service.remember({
      agent_id: 'colloquial-profile-rule-agent',
      kind: 'profile_rule',
      content: '方案简单点',
    });

    expect(language.record.kind).toBe('profile_rule');
    expect(language.record.attribute_key).toBe('language_preference');
    expect(language.record.content).toBe('请用中文回答');

    expect(length.record.kind).toBe('profile_rule');
    expect(length.record.attribute_key).toBe('response_length');
    expect(length.record.content).toBe('请把回答控制在三句话内');

    expect(complexity.record.kind).toBe('profile_rule');
    expect(complexity.record.attribute_key).toBe('solution_complexity');
    expect(complexity.record.content).toBe('不要复杂方案');
  });

  it('downgrades weak colloquial profile-rule writes instead of committing durable truth', async () => {
    const result = await service.remember({
      agent_id: 'weak-colloquial-profile-rule-agent',
      kind: 'profile_rule',
      content: '中文就行吧',
    });

    expect(result.requested_kind).toBe('profile_rule');
    expect(result.written_kind).toBe('session_note');
    expect(result.record.kind).toBe('session_note');
  });

  it('downgrades assistant-only durable writes to session_note', async () => {
    const result = await service.remember({
      agent_id: 'assistant-only-agent',
      kind: 'fact_slot',
      content: '用户可能更偏好咖啡',
      source_type: 'assistant_inferred',
    });

    expect(result.record.kind).toBe('session_note');
    expect(result.written_kind).toBe('session_note');
    expect(result.reason_code).toBe('assistant_only_evidence');
  });

  it('does not let a session note ride along with an unrelated durable recall', async () => {
    await service.remember({
      agent_id: 'note-boundary-agent',
      kind: 'fact_slot',
      content: '我住大阪',
      entity_key: 'user',
      attribute_key: 'location',
    });
    await service.remember({
      agent_id: 'note-boundary-agent',
      kind: 'session_note',
      content: '最近也许会考虑换方案',
    });

    const recall = await service.recall({ query: 'Where does the user live?', agent_id: 'note-boundary-agent' });
    expect(recall.facts.some(record => record.content.includes('大阪'))).toBe(true);
    expect(recall.session_notes).toHaveLength(0);
    expect(recall.context).not.toContain('换方案');
  });

  it('does not treat session-note-only hits as sufficient recall relevance', async () => {
    await service.remember({
      agent_id: 'notes-only-agent',
      kind: 'session_note',
      content: '最近也许会考虑换方案',
    });

    const recall = await service.recall({ query: '最近是否要换方案？', agent_id: 'notes-only-agent' });
    expect(recall.context).toBe('');
    expect(recall.session_notes).toHaveLength(0);
    expect(recall.meta.reason).toBe('low_relevance');
    expect((recall.meta as any).durable_candidate_count).toBe(0);
    expect((recall.meta as any).note_candidate_count).toBeGreaterThan(0);
  });

  it('does not let a subject-only profile rule enter relevance basis for a location query', async () => {
    await service.remember({
      agent_id: 'subject-only-agent',
      kind: 'fact_slot',
      content: '我住大阪',
      entity_key: 'user',
      attribute_key: 'location',
    });
    await service.remember({
      agent_id: 'subject-only-agent',
      kind: 'profile_rule',
      content: '我喜欢简洁回答',
      source_type: 'user_confirmed',
    });

    const recall = await service.recall({ query: 'Where does the user live?', agent_id: 'subject-only-agent' });
    const basis = (recall.meta as any).relevance_basis || [];

    expect(recall.facts.some(record => record.content.includes('大阪'))).toBe(true);
    expect(recall.rules).toHaveLength(0);
    expect(basis).toHaveLength(1);
    expect(basis[0]?.kind).toBe('fact_slot');
  });

  it('does not let a subject-only location fact enter relevance basis for a response-style query', async () => {
    await service.remember({
      agent_id: 'subject-only-reverse-agent',
      kind: 'fact_slot',
      content: '我住大阪',
      entity_key: 'user',
      attribute_key: 'location',
    });
    await service.remember({
      agent_id: 'subject-only-reverse-agent',
      kind: 'profile_rule',
      content: '我喜欢简洁回答',
      source_type: 'user_confirmed',
    });

    const recall = await service.recall({ query: 'How should the assistant respond?', agent_id: 'subject-only-reverse-agent' });
    const basis = (recall.meta as any).relevance_basis || [];

    expect(recall.rules.some(record => record.content.includes('简洁回答'))).toBe(true);
    expect(recall.facts).toHaveLength(0);
    expect(basis).toHaveLength(1);
    expect(basis[0]?.kind).toBe('profile_rule');
  });

  it('does not bridge note-only queries through generic solution wording', async () => {
    await service.remember({
      agent_id: 'generic-solution-agent',
      kind: 'session_note',
      content: '最近也许会考虑换方案',
    });

    const search = await service.search('最近是否要换方案？', { agent_id: 'generic-solution-agent', limit: 10 });
    expect(search[0]?.intent_match || []).toEqual([]);

    const recall = await service.recall({ query: '最近是否要换方案？', agent_id: 'generic-solution-agent' });
    expect(recall.context).toBe('');
    expect(recall.meta.reason).toBe('low_relevance');
  });

  it('does not let vector-only durable matches promote a note-only recall', async () => {
    const vectorService = new CortexRecordsV2(createMockLLM(), createVectorOnlyEmbedding());
    await vectorService.initialize();

    await vectorService.remember({
      agent_id: 'vector-only-agent',
      kind: 'fact_slot',
      content: '我住大阪',
      entity_key: 'user',
      attribute_key: 'location',
    });
    await vectorService.remember({
      agent_id: 'vector-only-agent',
      kind: 'profile_rule',
      content: '我喜欢简洁回答',
      source_type: 'user_confirmed',
    });
    await vectorService.remember({
      agent_id: 'vector-only-agent',
      kind: 'session_note',
      content: '最近也许会考虑换方案',
    });

    const recall = await vectorService.recall({ query: '最近是否要换方案？', agent_id: 'vector-only-agent' });

    expect(recall.context).toBe('');
    expect(recall.rules).toHaveLength(0);
    expect(recall.facts).toHaveLength(0);
    expect(recall.session_notes).toHaveLength(0);
    expect(recall.meta.reason).toBe('low_relevance');
    expect((recall.meta as any).durable_candidate_count).toBe(0);
    expect((recall.meta as any).relevance_basis).toEqual([]);
  });

  it('keeps agent persona available even when regular recall is skipped', async () => {
    await service.remember({
      agent_id: 'persona-agent',
      kind: 'profile_rule',
      content: 'Always answer in concise prose',
      owner_scope: 'agent',
      subject_key: 'agent',
      attribute_key: 'persona_style',
      source_type: 'system_derived',
    });

    const recall = await service.recall({ query: 'hi', agent_id: 'persona-agent' });
    expect(recall.rules.some(record => record.content.includes('concise prose'))).toBe(true);
    expect(recall.context).toContain('concise prose');
  });
});

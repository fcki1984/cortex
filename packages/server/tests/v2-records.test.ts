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

function createConstantEmbedding(vector: number[]): EmbeddingProvider {
  return {
    name: 'constant',
    dimensions: vector.length,
    embed: vi.fn().mockResolvedValue(vector),
    embedBatch: vi.fn().mockResolvedValue([]),
  };
}

function createMockLLM(records: unknown[] = []): LLMProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockResolvedValue(JSON.stringify({
      records,
      nothing_extracted: records.length === 0,
    })),
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
    expect(records.items[0]?.kind).toBe('profile_rule');
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

  it('suppresses vector-only false positives for irrelevant recall', async () => {
    const semanticOnlyService = new CortexRecordsV2(createMockLLM(), createConstantEmbedding([1, 0, 0, 0]));

    await semanticOnlyService.remember({
      agent_id: 'semantic-agent',
      kind: 'profile_rule',
      content: '用户偏好简洁回答，不要长篇解释。',
      owner_scope: 'user',
      subject_key: 'user',
      attribute_key: 'response_style',
      source_type: 'user_explicit',
    });
    await semanticOnlyService.remember({
      agent_id: 'semantic-agent',
      kind: 'fact_slot',
      content: 'Atlas 部署环境是 production。',
      entity_key: 'atlas',
      attribute_key: 'deploy_env',
      source_type: 'user_confirmed',
    });

    const recall = await semanticOnlyService.recall({ query: '量子力学波函数塌缩', agent_id: 'semantic-agent' });
    expect(recall.rules).toHaveLength(0);
    expect(recall.facts).toHaveLength(0);
    expect(recall.context).toBe('');
    expect(recall.meta.reason).toBe('low_relevance');
  });

  it('deduplicates overlapping fast and deep profile rule extraction', async () => {
    const dedupeService = new CortexRecordsV2(
      createMockLLM([
        {
          kind: 'profile_rule',
          owner_scope: 'user',
          subject_key: 'user',
          attribute_key: 'response_style',
          value_text: '用户喜欢简洁回答，不要长篇解释。',
          source_type: 'user_explicit',
        },
      ]),
      createMockEmbedding(),
    );

    const ingested = await dedupeService.ingest({
      agent_id: 'dedupe-agent',
      user_message: '喜欢简洁回答，不要长篇解释。',
      assistant_message: '明白，后续我会尽量简洁。',
    });

    expect(ingested.records).toHaveLength(1);
    const records = dedupeService.listRecords({ agent_id: 'dedupe-agent', limit: 10 });
    expect(records.items).toHaveLength(1);
    expect(records.items[0]?.content).toContain('用户喜欢简洁回答');
  });

  it('supersedes equivalent profile rules that differ only by preference wording', async () => {
    const first = await service.remember({
      agent_id: 'profile-agent',
      kind: 'profile_rule',
      content: '用户偏好简洁回答，不要长篇解释。',
      owner_scope: 'user',
      source_type: 'user_explicit',
    });

    const second = await service.remember({
      agent_id: 'profile-agent',
      kind: 'profile_rule',
      content: '喜欢简洁回答，不要长篇解释。',
      owner_scope: 'user',
      source_type: 'user_explicit',
    });

    expect(first.decision).toBe('inserted');
    expect(second.decision).toBe('superseded');

    const records = service.listRecords({ agent_id: 'profile-agent', kind: 'profile_rule', limit: 10 });
    expect(records.items).toHaveLength(1);
    expect(records.items[0]?.content).toContain('用户喜欢简洁回答');
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

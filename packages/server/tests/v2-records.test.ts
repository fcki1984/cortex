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

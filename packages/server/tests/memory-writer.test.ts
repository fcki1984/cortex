import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, closeDatabase, getMemoryById, insertMemory } from '../src/db/index.js';
import { loadConfig } from '../src/utils/config.js';
import { MemoryWriter, type ExtractedMemory } from '../src/core/memory-writer.js';
import type { LLMProvider } from '../src/llm/interface.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import type { VectorBackend } from '../src/vector/interface.js';

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock',
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  };
}

function createMockVector(searchResults: Array<{ id: string; distance: number }>): VectorBackend {
  return {
    name: 'mock',
    initialize: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(searchResults),
    delete: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLLM(action: 'replace' | 'merge' | 'keep' | 'conflict' = 'replace'): LLMProvider {
  return {
    name: 'mock-llm',
    complete: vi.fn().mockResolvedValue(JSON.stringify({
      action,
      reasoning: 'test decision',
    })),
  };
}

describe('MemoryWriter update semantics', () => {
  beforeAll(() => {
    loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      sieve: {
        smartUpdate: true,
        exactDupThreshold: 0.1,
        similarityThreshold: 0.4,
      },
    });
    initDatabase(':memory:');
  });

  afterAll(() => {
    closeDatabase();
  });

  it('should supersede an existing topic constraint when a correction updates the same budget', async () => {
    const existing = insertMemory({
      layer: 'core',
      category: 'constraint',
      owner_type: 'user',
      recall_scope: 'topic',
      content: '购车预算为16万落地',
      agent_id: 'writer-test',
      importance: 0.95,
    });

    const writer = new MemoryWriter(
      createMockLLM('replace'),
      createMockEmbedding(),
      createMockVector([{ id: existing.id, distance: 0.18 }]),
      loadConfig(),
    );

    const extraction: ExtractedMemory = {
      content: '购车预算改为18万落地',
      category: 'correction',
      importance: 0.95,
      source: 'user_stated',
      reasoning: 'budget updated',
    };

    const result = await writer.processNewMemory(extraction, 'writer-test');

    expect(result.action).toBe('smart_updated');
    expect(result.memory).toBeDefined();
    expect(result.memory!.category).toBe('constraint');
    expect(result.memory!.content).toBe('购车预算改为18万落地');

    const oldVersion = getMemoryById(existing.id);
    expect(oldVersion?.superseded_by).toBe(result.memory!.id);
  });

  it('should preserve the topic slot when a decision updates an existing constraint', async () => {
    const existing = insertMemory({
      layer: 'core',
      category: 'constraint',
      owner_type: 'user',
      recall_scope: 'topic',
      content: '购车预算为20万落地',
      agent_id: 'writer-test',
      importance: 0.95,
    });

    const writer = new MemoryWriter(
      createMockLLM('replace'),
      createMockEmbedding(),
      createMockVector([{ id: existing.id, distance: 0.2 }]),
      loadConfig(),
    );

    const extraction: ExtractedMemory = {
      content: '决定把购车预算改成18万落地',
      category: 'decision',
      importance: 0.85,
      source: 'user_stated',
      reasoning: 'budget decision update',
    };

    const result = await writer.processNewMemory(extraction, 'writer-test');

    expect(result.action).toBe('smart_updated');
    expect(result.memory).toBeDefined();
    expect(result.memory!.category).toBe('constraint');
    expect(result.memory!.content).toBe('决定把购车预算改成18万落地');
    expect(getMemoryById(existing.id)?.superseded_by).toBe(result.memory!.id);
  });

  it('should not merge a user topic update into a global system rule', async () => {
    const existing = insertMemory({
      layer: 'core',
      category: 'policy',
      owner_type: 'system',
      recall_scope: 'global',
      content: '回答应使用自然、正式的中文',
      agent_id: 'writer-test',
      importance: 0.95,
    });

    const writer = new MemoryWriter(
      createMockLLM('replace'),
      createMockEmbedding(),
      createMockVector([{ id: existing.id, distance: 0.15 }]),
      loadConfig(),
    );

    const extraction: ExtractedMemory = {
      content: '购车预算改为18万落地',
      category: 'correction',
      importance: 0.95,
      source: 'user_stated',
      reasoning: 'budget updated',
    };

    const result = await writer.processNewMemory(extraction, 'writer-test');

    expect(result.action).toBe('inserted');
    expect(result.memory).toBeDefined();
    expect(result.memory!.category).toBe('correction');
    expect(getMemoryById(existing.id)?.superseded_by).toBeNull();
  });
});

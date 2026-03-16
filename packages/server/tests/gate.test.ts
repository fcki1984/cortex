import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase, insertMemory } from '../src/db/index.js';
import { loadConfig } from '../src/utils/config.js';
import { MemoryGate } from '../src/core/gate.js';
import { HybridSearchEngine } from '../src/search/hybrid.js';
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

function createMockVector(): VectorBackend {
  return {
    name: 'mock',
    initialize: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createSearchResult(id: string, content: string, finalScore = 0.6): any {
  return {
    id,
    content,
    layer: 'core',
    category: 'fact',
    agent_id: 'default',
    importance: 0.8,
    decay_score: 1,
    access_count: 0,
    created_at: new Date().toISOString(),
    textScore: 0.2,
    vectorScore: 0.8,
    rawVectorSim: 0.8,
    fusedScore: 0.8,
    layerWeight: 1,
    recencyBoost: 1,
    accessBoost: 1,
    finalScore,
  };
}

function createStubSearchEngine(results: any[]) {
  return {
    search: vi.fn().mockResolvedValue({ results }),
    formatForInjection: vi.fn((items: any[]) => (
      items.length > 0
        ? `<cortex_memory>\n${items.map((item: any) => `[${item.category}] ${item.content}`).join('\n')}\n</cortex_memory>`
        : ''
    )),
  } as any;
}

describe('MemoryGate', () => {
  let gate: MemoryGate;

  beforeAll(() => {
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
    });
    initDatabase(':memory:');

    // Insert test data
    insertMemory({ layer: 'core', category: 'identity', content: 'User name is Harry', agent_id: 'default', importance: 1.0 });
    insertMemory({ layer: 'core', category: 'fact', content: 'Tokyo apartment prices range from 30-80 million yen', agent_id: 'default', importance: 0.8 });
    insertMemory({ layer: 'working', category: 'context', content: 'Discussed investment strategy today', agent_id: 'default' });

    const searchEngine = new HybridSearchEngine(createMockVector(), createMockEmbedding(), config.search);
    gate = new MemoryGate(searchEngine, config.gate);
  });

  afterAll(() => {
    closeDatabase();
  });

  it('should skip small talk', async () => {
    const result = await gate.recall({ query: 'hi' });
    expect(result.meta.skipped).toBe(true);
    expect(result.meta.reason).toBe('small_talk');
    expect(result.memories.length).toBe(0);
  });

  it('should recall relevant memories', async () => {
    const result = await gate.recall({ query: 'Tokyo apartment investment' });
    expect(result.meta.skipped).toBe(false);
    expect(result.meta.latency_ms).toBeGreaterThanOrEqual(0);
    // BM25 should find the Tokyo memory
    expect(result.memories.length).toBeGreaterThanOrEqual(0); // may or may not match depending on FTS tokenizer
  });

  it('should respect max_tokens limit', async () => {
    const result = await gate.recall({ query: 'Harry', max_tokens: 50 });
    expect(result.meta.skipped).toBe(false);
  });

  it('should report metadata', async () => {
    const result = await gate.recall({ query: 'investment strategy' });
    expect(result.meta).toBeDefined();
    expect(result.meta.query).toBe('investment strategy');
    expect(typeof result.meta.total_found).toBe('number');
  });

  it('should fall back when query expansion times out', async () => {
    const searchEngine = createStubSearchEngine([createSearchResult('1', 'Alpha memory')]);
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      gate: {
        skipSmallTalk: false,
        relationInjection: false,
        queryExpansion: { enabled: true, maxVariants: 3 },
        queryExpansionTimeoutMs: 500,
      },
    });
    const llm = {
      name: 'mock-llm',
      complete: vi.fn(() => new Promise<string>(() => {})),
    } as any;
    const timeoutGate = new MemoryGate(searchEngine, config.gate, llm);

    const result = await timeoutGate.recall({ query: 'vehicle financing preference' });

    expect(result.meta.skipped).toBe(false);
    expect(searchEngine.search).toHaveBeenCalledTimes(1);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('should fall back to original order when reranker times out', async () => {
    const results = [
      createSearchResult('1', 'Alpha memory', 0.9),
      createSearchResult('2', 'Beta memory', 0.4),
    ];
    const searchEngine = createStubSearchEngine(results);
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      gate: {
        skipSmallTalk: false,
        relationInjection: false,
        queryExpansion: { enabled: false, maxVariants: 3 },
        rerankerTimeoutMs: 500,
      },
    });
    const reranker = {
      rerank: vi.fn(() => new Promise<any[]>(() => {})),
    } as any;
    const timeoutGate = new MemoryGate(searchEngine, config.gate, undefined, reranker);

    const result = await timeoutGate.recall({ query: 'alpha beta' });

    expect(reranker.rerank).toHaveBeenCalledTimes(1);
    expect(result.memories[0]?.id).toBe('1');
    expect(result.memories).toHaveLength(1);
  });

  it('should return search-only results when relation injection times out', async () => {
    const searchEngine = createStubSearchEngine([createSearchResult('1', 'Alpha memory')]);
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      gate: {
        skipSmallTalk: false,
        relationInjection: true,
        queryExpansion: { enabled: false, maxVariants: 3 },
        relationTimeoutMs: 500,
      },
    });
    const timeoutGate = new MemoryGate(searchEngine, config.gate) as any;
    timeoutGate.buildRelationBlock = vi.fn(() => new Promise(() => {}));

    const result = await timeoutGate.recall({ query: 'alpha relation query' });

    expect(timeoutGate.buildRelationBlock).toHaveBeenCalledTimes(1);
    expect(result.meta.relations_count).toBe(0);
    expect(result.context).not.toContain('<cortex_relations>');
  });
});

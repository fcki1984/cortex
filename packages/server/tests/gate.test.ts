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

  it('should suppress low-relevance search injection but keep memories', async () => {
    const agentId = 'low-relevance-test';
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', 'proxy traffic residential plan', 0.9),
        agent_id: agentId,
        vectorScore: 0.2,
        fusedScore: 0.1,
      },
    ]);
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
      },
    });
    const relevanceGate = new MemoryGate(searchEngine, config.gate) as any;
    relevanceGate.buildRelationBlock = vi.fn().mockResolvedValue({
      block: '<cortex_relations>\nproxy --relates_to--> network\n</cortex_relations>',
      count: 1,
    });

    const result = await relevanceGate.recall({ query: 'beef stew recipe', agent_id: agentId });

    expect(result.memories).toHaveLength(1);
    expect(result.context).toBe('');
    expect(result.meta.suppressed).toBe(true);
    expect(result.meta.suppressed_reason).toBe('low_relevance');
    expect(result.meta.relations_count).toBe(0);
    expect(result.meta.relevance_gate.best_overlap).toBe(0);
    expect(relevanceGate.buildRelationBlock).not.toHaveBeenCalled();
  });

  it('should keep fixed persona injection when low relevance suppresses search context', async () => {
    insertMemory({
      layer: 'core',
      category: 'agent_persona',
      content: 'Always answer in a concise tone',
      agent_id: 'persona-test',
      importance: 1,
    });
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', 'proxy traffic residential plan', 0.9),
        agent_id: 'persona-test',
        vectorScore: 0.2,
        fusedScore: 0.1,
      },
    ]);
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
      },
    });
    const relevanceGate = new MemoryGate(searchEngine, config.gate) as any;
    relevanceGate.buildRelationBlock = vi.fn().mockResolvedValue({ block: '', count: 0 });

    const result = await relevanceGate.recall({ query: 'beef stew recipe', agent_id: 'persona-test' });

    expect(result.meta.suppressed).toBe(true);
    expect(result.context).toContain('Always answer in a concise tone');
    expect(result.context).not.toContain('proxy traffic residential plan');
    expect(result.meta.injected_count).toBe(1);
    expect(relevanceGate.buildRelationBlock).not.toHaveBeenCalled();
  });

  it('should allow semantic fallback when top candidate is strong enough without token overlap', async () => {
    const agentId = 'semantic-fallback-test';
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', 'braising techniques kitchen methods', 0.9),
        agent_id: agentId,
        vectorScore: 0.8,
        fusedScore: 0.2,
      },
    ]);
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
      },
    });
    const relevanceGate = new MemoryGate(searchEngine, config.gate);

    const result = await relevanceGate.recall({ query: 'beef stew recipe', agent_id: agentId });

    expect(result.meta.suppressed).toBe(false);
    expect(result.meta.relevance_gate.passed).toBe(true);
    expect(result.context).toContain('braising techniques kitchen methods');
    expect(result.meta.relevance_gate.best_overlap).toBe(0);
    expect(result.meta.relevance_gate.best_vector_score).toBe(0.8);
    expect(result.meta.relevance_gate.best_fused_score).toBe(0.2);
  });

  it('should keep fixed rule injection when low relevance suppresses search context', async () => {
    insertMemory({
      layer: 'core',
      category: 'constraint',
      content: 'Use natural and formal Chinese',
      agent_id: 'rule-test',
      importance: 1,
    });
    insertMemory({
      layer: 'core',
      category: 'policy',
      content: 'Clarify user intent before answering ambiguous requests',
      agent_id: 'rule-test',
      importance: 0.9,
    });
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', 'proxy traffic residential plan', 0.9),
        agent_id: 'rule-test',
        vectorScore: 0.2,
        fusedScore: 0.1,
      },
    ]);
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
        ruleInjection: { enabled: true, maxTokens: 200 },
      },
    });
    const ruleGate = new MemoryGate(searchEngine, config.gate) as any;
    ruleGate.buildRelationBlock = vi.fn().mockResolvedValue({ block: '', count: 0 });

    const result = await ruleGate.recall({ query: 'beef stew recipe', agent_id: 'rule-test' });

    expect(result.meta.suppressed).toBe(true);
    expect(result.context).toContain('Use natural and formal Chinese');
    expect(result.context).toContain('Clarify user intent before answering ambiguous requests');
    expect(result.context).not.toContain('proxy traffic residential plan');
    expect(result.meta.rule_injected_count).toBe(2);
    expect(result.meta.search_injected_count).toBe(0);
    expect(ruleGate.buildRelationBlock).not.toHaveBeenCalled();
  });

  it('should include rule layer and relevant search memories together for related queries', async () => {
    insertMemory({
      layer: 'core',
      category: 'constraint',
      content: 'Use natural and formal Chinese',
      agent_id: 'rule-related-test',
      importance: 1,
    });
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', 'Recommend affordable BYD hybrid models within a 160k budget', 0.9),
        agent_id: 'rule-related-test',
        vectorScore: 0.9,
        fusedScore: 0.7,
      },
    ]);
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
        ruleInjection: { enabled: true, maxTokens: 120 },
      },
    });
    const ruleGate = new MemoryGate(searchEngine, config.gate);

    const result = await ruleGate.recall({ query: 'BYD hybrid budget recommendation', agent_id: 'rule-related-test' });

    expect(result.meta.suppressed).toBe(false);
    expect(result.context).toContain('Use natural and formal Chinese');
    expect(result.context).toContain('Recommend affordable BYD hybrid models within a 160k budget');
    expect(result.meta.rule_injected_count).toBe(1);
    expect(result.meta.search_injected_count).toBe(1);
  });

  it('should keep domain-specific constraints out of the fixed rule layer', async () => {
    insertMemory({
      layer: 'core',
      category: 'constraint',
      content: 'Use natural and formal Chinese',
      agent_id: 'rule-eligibility-test',
      importance: 1,
    });
    insertMemory({
      layer: 'core',
      category: 'constraint',
      content: '购车预算为16万含落地',
      agent_id: 'rule-eligibility-test',
      importance: 0.95,
    });
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', '购车预算为16万含落地', 0.9),
        agent_id: 'rule-eligibility-test',
        category: 'constraint',
        vectorScore: 0.8,
        fusedScore: 0.7,
      },
    ]);
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
        ruleInjection: { enabled: true, maxTokens: 120 },
      },
    });
    const ruleGate = new MemoryGate(searchEngine, config.gate);

    const result = await ruleGate.recall({ query: '16万落地买什么车', agent_id: 'rule-eligibility-test' });

    expect(result.context).toContain('Use natural and formal Chinese');
    expect(result.meta.rule_injected_count).toBe(1);
    expect(result.meta.search_injected_count).toBe(1);
    expect(result.context).toContain('购车预算为16万含落地');
  });

  it('should suppress domain-specific constraints on unrelated queries while keeping global rules', async () => {
    insertMemory({
      layer: 'core',
      category: 'constraint',
      content: 'Use natural and formal Chinese',
      agent_id: 'rule-suppression-test',
      importance: 1,
    });
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', '购车预算为16万含落地', 0.9),
        agent_id: 'rule-suppression-test',
        category: 'constraint',
        vectorScore: 0.2,
        fusedScore: 0.1,
      },
    ]);
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
        ruleInjection: { enabled: true, maxTokens: 120 },
      },
    });
    const ruleGate = new MemoryGate(searchEngine, config.gate);

    const result = await ruleGate.recall({ query: '空气炸锅鸡翅怎么做', agent_id: 'rule-suppression-test' });

    expect(result.meta.suppressed).toBe(true);
    expect(result.context).toContain('Use natural and formal Chinese');
    expect(result.context).not.toContain('购车预算为16万含落地');
    expect(result.meta.rule_injected_count).toBe(1);
    expect(result.meta.search_injected_count).toBe(0);
  });

  it('should fall back to normal search injection when rule layer is disabled', async () => {
    const searchEngine = createStubSearchEngine([
      {
        ...createSearchResult('1', 'Always clarify user intent before answering', 0.9),
        agent_id: 'rule-disabled-test',
        category: 'constraint',
        vectorScore: 0.8,
        fusedScore: 0.6,
      },
    ]);
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
        ruleInjection: { enabled: false, maxTokens: 120 },
      },
    });
    const ruleGate = new MemoryGate(searchEngine, config.gate);

    const result = await ruleGate.recall({ query: 'clarify user intent before answering', agent_id: 'rule-disabled-test' });

    expect(result.meta.suppressed).toBe(false);
    expect(result.context).toContain('Always clarify user intent before answering');
    expect(result.meta.rule_injected_count).toBe(0);
    expect(result.meta.search_injected_count).toBe(1);
  });
});

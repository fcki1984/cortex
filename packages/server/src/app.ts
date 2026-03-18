import { type CortexConfig, getConfig } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { MemoryGate } from './core/gate.js';
import { MemorySieve } from './core/sieve.js';
import { MemoryFlush } from './core/flush.js';
import { LifecycleEngine } from './decay/lifecycle.js';
import { HybridSearchEngine } from './search/hybrid.js';
import { MarkdownExporter } from './export/markdown.js';
import { createVectorBackend } from './vector/index.js';
import { createCascadeLLM } from './llm/cascade.js';
import { createCascadeEmbedding } from './embedding/cascade.js';
import { CachedEmbeddingProvider } from './embedding/cache.js';
import { createReranker } from './search/reranker.js';
import type { VectorBackend } from './vector/interface.js';
import type { LLMProvider } from './llm/interface.js';
import type { EmbeddingProvider } from './embedding/interface.js';
import { CortexRecordsV2 } from './v2/service.js';
import { CortexRelationsV2 } from './v2/relations.js';
import { CortexLifecycleV2 } from './v2/lifecycle.js';
import { CortexFeedbackV2 } from './v2/feedback.js';

const log = createLogger('app');

export class CortexApp {
  gate: MemoryGate | null;
  sieve: MemorySieve | null;
  flush: MemoryFlush | null;
  lifecycle: LifecycleEngine | null;
  searchEngine: HybridSearchEngine | null;
  exporter: MarkdownExporter | null;
  recordsV2: CortexRecordsV2;
  relationsV2: CortexRelationsV2;
  lifecycleV2: CortexLifecycleV2;
  feedbackV2: CortexFeedbackV2;
  readonly vectorBackend: VectorBackend;
  llmExtraction: LLMProvider;
  llmLifecycle: LLMProvider;
  embeddingProvider: EmbeddingProvider;

  constructor(public config: CortexConfig) {
    // Initialize providers
    this.llmExtraction = createCascadeLLM(config.llm.extraction);
    this.llmLifecycle = createCascadeLLM(config.llm.lifecycle);
    const baseEmbedding = createCascadeEmbedding(config.embedding);
    this.embeddingProvider = new CachedEmbeddingProvider(baseEmbedding, 2000);
    this.vectorBackend = createVectorBackend(config.vectorBackend as any);

    // Initialize engines
    this.searchEngine = null;
    this.gate = null;
    this.sieve = null;
    this.flush = null;
    this.lifecycle = null;
    this.exporter = null;
    this.rebuildLegacyEngines(config);
    this.recordsV2 = new CortexRecordsV2(this.llmExtraction, this.embeddingProvider);
    this.relationsV2 = new CortexRelationsV2();
    this.lifecycleV2 = new CortexLifecycleV2(this.recordsV2);
    this.feedbackV2 = new CortexFeedbackV2(this.recordsV2);

    log.info('CortexApp initialized');
  }

  /**
   * Reload LLM/Embedding providers and dependent engines when config changes.
   * Only recreates providers whose config actually changed.
   * vectorBackend is NOT reloaded (requires restart).
   */
  reloadProviders(newConfig: CortexConfig): string[] {
    const reloaded: string[] = [];

    // Check extraction LLM
    if (hasProviderChanged(this.config.llm.extraction, newConfig.llm.extraction)) {
      this.llmExtraction = createCascadeLLM(newConfig.llm.extraction);
      reloaded.push('llm.extraction');
      log.info('Reloaded extraction LLM provider');
    }

    // Check lifecycle LLM
    if (hasProviderChanged(this.config.llm.lifecycle, newConfig.llm.lifecycle)) {
      this.llmLifecycle = createCascadeLLM(newConfig.llm.lifecycle);
      reloaded.push('llm.lifecycle');
      log.info('Reloaded lifecycle LLM provider');
    }

    // Check embedding
    if (hasProviderChanged(this.config.embedding, newConfig.embedding)) {
      const baseEmbedding = createCascadeEmbedding(newConfig.embedding);
      this.embeddingProvider = new CachedEmbeddingProvider(baseEmbedding, 2000);
      reloaded.push('embedding');
      log.info('Reloaded embedding provider');
    }

    // Check if search/gate config changed (reranker, query expansion, etc.)
    const searchConfigChanged = JSON.stringify(this.config.search) !== JSON.stringify(newConfig.search);
    const gateConfigChanged = JSON.stringify(this.config.gate) !== JSON.stringify(newConfig.gate);
    const runtimeChanged = JSON.stringify(this.config.runtime) !== JSON.stringify(newConfig.runtime);
    if (searchConfigChanged) reloaded.push('search');
    if (gateConfigChanged) reloaded.push('gate');
    if (runtimeChanged) reloaded.push('runtime');

    // Rebuild dependent engines if any provider or config changed
    if (reloaded.length > 0) {
      this.rebuildLegacyEngines(newConfig);
      this.recordsV2 = new CortexRecordsV2(this.llmExtraction, this.embeddingProvider);
      this.relationsV2 = new CortexRelationsV2();
      this.lifecycleV2 = new CortexLifecycleV2(this.recordsV2);
      this.feedbackV2 = new CortexFeedbackV2(this.recordsV2);
      log.info({ reloaded }, 'Rebuilt dependent engines');
    }

    this.config = newConfig;
    return reloaded;
  }

  async initialize(): Promise<void> {
    // Initialize vector backend
    await this.vectorBackend.initialize(this.embeddingProvider.dimensions || 1536);
    log.info('Vector backend initialized');
    await this.recordsV2.initialize();
    log.info('V2 records initialized');
  }

  async shutdown(): Promise<void> {
    await this.vectorBackend.close();
    log.info('CortexApp shut down');
  }

  private rebuildLegacyEngines(config: CortexConfig): void {
    if (!config.runtime.legacyMode) {
      this.searchEngine = null;
      this.gate = null;
      this.sieve = null;
      this.flush = null;
      this.lifecycle = null;
      this.exporter = null;
      log.info('Legacy engines disabled');
      return;
    }

    const reranker = createReranker(config.search.reranker, this.llmExtraction);
    this.searchEngine = new HybridSearchEngine(this.vectorBackend, this.embeddingProvider, config.search);
    this.gate = new MemoryGate(this.searchEngine, config.gate, this.llmExtraction, reranker, config.search.reranker?.weight);
    this.sieve = new MemorySieve(this.llmExtraction, this.embeddingProvider, this.vectorBackend, config);
    this.flush = new MemoryFlush(this.llmExtraction, this.embeddingProvider, this.vectorBackend, config);
    this.lifecycle = new LifecycleEngine(this.llmLifecycle, this.embeddingProvider, this.vectorBackend, config);
    this.exporter = new MarkdownExporter(config);
  }
}

/** Compare old vs new provider config to decide if provider needs recreation */
function hasProviderChanged(
  oldCfg: { provider?: string; model?: string; apiKey?: string; baseUrl?: string; timeoutMs?: number; dimensions?: number },
  newCfg: { provider?: string; model?: string; apiKey?: string; baseUrl?: string; timeoutMs?: number; dimensions?: number },
): boolean {
  if (newCfg.provider !== oldCfg.provider) return true;
  if (newCfg.model !== oldCfg.model) return true;
  if (newCfg.dimensions !== oldCfg.dimensions) return true;
  if (newCfg.baseUrl !== oldCfg.baseUrl) return true;
  if (newCfg.timeoutMs !== oldCfg.timeoutMs) return true;
  // Only compare apiKey if the new config actually provides one (non-empty)
  if (newCfg.apiKey && newCfg.apiKey !== oldCfg.apiKey) return true;
  return false;
}

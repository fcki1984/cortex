import { type CortexConfig } from './utils/config.js';
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
import { CortexReviewInboxV2 } from './v2/review-inbox.js';

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
  reviewInboxV2: CortexReviewInboxV2;
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
    this.reviewInboxV2 = new CortexReviewInboxV2(this.recordsV2, this.relationsV2);
    this.recordsV2.setLiveReviewFollowupResolver(this.reviewInboxV2);

    log.info('CortexApp initialized');
  }

  async reloadProviders(newConfig: CortexConfig, runtimeSections: string[]): Promise<string[]> {
    const reloaded = new Set<string>();

    const runtimeSet = new Set(runtimeSections);
    const nextConfig = structuredClone(this.config) as CortexConfig;

    if (runtimeSet.has('llm.extraction') && hasProviderChanged(this.config.llm.extraction, newConfig.llm.extraction)) {
      this.llmExtraction = createCascadeLLM(newConfig.llm.extraction);
      nextConfig.llm.extraction = newConfig.llm.extraction;
      reloaded.add('llm.extraction');
      log.info('Reloaded extraction LLM provider');
    }

    if (runtimeSet.has('embedding') && hasEmbeddingProviderChanged(this.config.embedding, newConfig.embedding)) {
      const baseEmbedding = createCascadeEmbedding(newConfig.embedding);
      this.embeddingProvider = new CachedEmbeddingProvider(baseEmbedding, 2000);
      nextConfig.embedding = newConfig.embedding;
      reloaded.add('embedding');
      log.info('Reloaded embedding provider');
    }

    if (reloaded.has('llm.extraction') || reloaded.has('embedding')) {
      this.recordsV2 = new CortexRecordsV2(this.llmExtraction, this.embeddingProvider);
      await this.recordsV2.initialize();
      this.relationsV2 = new CortexRelationsV2();
      this.lifecycleV2 = new CortexLifecycleV2(this.recordsV2);
      this.feedbackV2 = new CortexFeedbackV2(this.recordsV2);
      this.reviewInboxV2 = new CortexReviewInboxV2(this.recordsV2, this.relationsV2);
      this.recordsV2.setLiveReviewFollowupResolver(this.reviewInboxV2);
      log.info('Reloaded V2 record services');
    }

    if (runtimeSet.has('lifecycle.schedule')) {
      nextConfig.lifecycle = {
        ...nextConfig.lifecycle,
        schedule: newConfig.lifecycle.schedule,
      };
      reloaded.add('lifecycle.schedule');
    }

    this.config = nextConfig;
    return Array.from(reloaded);
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

function hasProviderChanged(
  oldCfg: { provider?: string; model?: string; apiKey?: string; baseUrl?: string; timeoutMs?: number },
  newCfg: { provider?: string; model?: string; apiKey?: string; baseUrl?: string; timeoutMs?: number },
): boolean {
  if (newCfg.provider !== oldCfg.provider) return true;
  if (newCfg.model !== oldCfg.model) return true;
  if (newCfg.baseUrl !== oldCfg.baseUrl) return true;
  if (newCfg.timeoutMs !== oldCfg.timeoutMs) return true;
  if (newCfg.apiKey && newCfg.apiKey !== oldCfg.apiKey) return true;
  return false;
}

function hasEmbeddingProviderChanged(
  oldCfg: { provider?: string; model?: string; dimensions?: number; apiKey?: string; baseUrl?: string; timeoutMs?: number },
  newCfg: { provider?: string; model?: string; dimensions?: number; apiKey?: string; baseUrl?: string; timeoutMs?: number },
): boolean {
  return hasProviderChanged(oldCfg, newCfg) || newCfg.dimensions !== oldCfg.dimensions;
}

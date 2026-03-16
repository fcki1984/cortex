/**
 * MemoryWriter — shared memory persistence logic for Sieve and Flush.
 *
 * Handles:
 * - Three-tier dedup matching (exact → near-exact → similar → insert)
 * - Smart Update via LLM (keep / replace / merge)
 * - Vector indexing
 * - Cross-family awareness (agent_* vs user categories)
 */
import { createLogger } from '../utils/logger.js';
import { insertMemory, getMemoryById, updateMemory, type Memory, type MemoryCategory } from '../db/index.js';
import { parseDuration } from '../utils/helpers.js';
import { stripCodeFences } from '../utils/sanitize.js';
import type { LLMProvider } from '../llm/interface.js';
import type { EmbeddingProvider } from '../embedding/interface.js';
import type { VectorBackend } from '../vector/interface.js';
import type { CortexConfig } from '../utils/config.js';
import { SMART_UPDATE_SYSTEM_PROMPT } from './prompts.js';
import { insertExtractionFeedback } from '../db/index.js';
import { isLifecycleActive } from '../decay/lifecycle.js';
import {
  canSmartMergePlacement,
  classifyMemoryPlacement,
  getCategoryFamily,
  type MemoryOwnerType,
  type MemoryPlacement,
  type MemoryRecallScope,
} from '../utils/memory-placement.js';

const log = createLogger('memory-writer');

/** Legacy fallback threshold when smartUpdate is disabled */
const LEGACY_DEDUP_THRESHOLD = 0.15;

// Fix #6: Simple semaphore for smart update LLM concurrency control
class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    return new Promise<void>(resolve => this.queue.push(() => { this.running++; resolve(); }));
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}
const smartUpdateSemaphore = new Semaphore(2);

export interface ExtractedMemory {
  content: string;
  category: MemoryCategory;
  importance: number;
  source: 'user_stated' | 'user_implied' | 'observed_pattern' | 'system_defined' | 'self_reflection';
  scope_hint?: MemoryRecallScope;
  owner_type?: MemoryOwnerType;
  recall_scope?: MemoryRecallScope;
  reasoning: string;
}

export interface SimilarMemory {
  memory: Memory;
  distance: number;
}

export interface SmartUpdateDecision {
  action: 'keep' | 'replace' | 'merge' | 'conflict';
  merged_content?: string;
  reasoning: string;
}

export interface ProcessResult {
  action: 'inserted' | 'skipped' | 'smart_updated';
  memory?: Memory;
}

export class MemoryWriter {
  constructor(
    private llm: LLMProvider,
    private embeddingProvider: EmbeddingProvider,
    private vectorBackend: VectorBackend,
    private config: CortexConfig,
  ) {}

  private classifyExtraction(extraction: ExtractedMemory): ExtractedMemory & MemoryPlacement {
    const placement = classifyMemoryPlacement({
      category: extraction.category,
      content: extraction.content,
      source: extraction.source,
      scope_hint: extraction.scope_hint ?? null,
    });
    return {
      ...extraction,
      owner_type: placement.owner_type,
      recall_scope: placement.recall_scope,
    };
  }

  private canMerge(existing: Memory, incoming: ExtractedMemory & MemoryPlacement): boolean {
    if (getCategoryFamily(existing.category) !== getCategoryFamily(incoming.category)) return false;
    return canSmartMergePlacement(
      { owner_type: existing.owner_type, recall_scope: existing.recall_scope },
      { owner_type: incoming.owner_type, recall_scope: incoming.recall_scope },
    );
  }

  /**
   * Find similar memories via vector search.
   */
  async findSimilar(
    extraction: Pick<ExtractedMemory, 'content' | 'category' | 'owner_type' | 'recall_scope'>,
    agentId: string,
    categories?: string[],
    topK = 3,
  ): Promise<SimilarMemory[]> {
    try {
      const embedding = await this.embeddingProvider.embed(extraction.content);
      if (embedding.length === 0) return [];

      const results = await this.vectorBackend.search(embedding, topK, { agent_id: agentId });
      const similar: SimilarMemory[] = [];
      for (const r of results) {
        const mem = getMemoryById(r.id);
        if (mem && !mem.superseded_by && !mem.is_pinned) {
          if (categories && categories.length > 0 && !categories.includes(mem.category)) continue;
          if (!this.canMerge(mem, extraction as ExtractedMemory & MemoryPlacement)) continue;
          similar.push({ memory: mem, distance: r.distance });
        }
      }
      return similar;
    } catch {
      return [];
    }
  }

  /**
   * Ask LLM to decide: keep, replace, or merge (single pair).
   */
  async smartUpdateDecision(existing: Memory, incoming: ExtractedMemory & MemoryPlacement): Promise<SmartUpdateDecision> {
    const prompt = `EXISTING MEMORY:
content: ${existing.content}
category: ${existing.category}
owner_type: ${existing.owner_type}
recall_scope: ${existing.recall_scope}

NEW MEMORY:
content: ${incoming.content}
category: ${incoming.category}
owner_type: ${incoming.owner_type}
recall_scope: ${incoming.recall_scope}`;
    // Fix #6: Concurrency control for smart update LLM calls
    await smartUpdateSemaphore.acquire();
    try {
      const raw = await this.llm.complete(prompt, {
        maxTokens: 300,
        temperature: 0.1,
        systemPrompt: SMART_UPDATE_SYSTEM_PROMPT,
      });

      return this.parseSmartUpdateResponse(raw);
    } catch (e: any) {
      log.warn({ error: e.message }, 'Smart update LLM call failed, defaulting to replace');
      return { action: 'replace', reasoning: 'LLM call failed' };
    } finally {
      smartUpdateSemaphore.release();
    }
  }

  /**
   * Batch smart update: decide keep/replace/merge for multiple (existing, new) pairs in one LLM call.
   * Falls back to individual calls if batch parsing fails.
   */
  async batchSmartUpdateDecision(
    pairs: Array<{ existing: Memory; incoming: ExtractedMemory & MemoryPlacement }>,
  ): Promise<SmartUpdateDecision[]> {
    if (pairs.length === 0) return [];
    if (pairs.length === 1) {
      return [await this.smartUpdateDecision(pairs[0]!.existing, pairs[0]!.incoming)];
    }

    const pairBlocks = pairs.map((p, i) =>
      `--- PAIR ${i} ---
EXISTING MEMORY:
content: ${p.existing.content}
category: ${p.existing.category}
owner_type: ${p.existing.owner_type}
recall_scope: ${p.existing.recall_scope}

NEW MEMORY:
content: ${p.incoming.content}
category: ${p.incoming.category}
owner_type: ${p.incoming.owner_type}
recall_scope: ${p.incoming.recall_scope}`,
    ).join('\n\n');

    const batchPrompt = `You have ${pairs.length} pairs of (existing, new) memories to evaluate.\nFor each pair, decide: keep, replace, or merge.\n\n${pairBlocks}`;

    const batchSystem = `${SMART_UPDATE_SYSTEM_PROMPT}\n\nYou are given multiple pairs. Output a JSON array with one decision per pair, in order:\n[{"action": "keep|replace|merge", "merged_content": "...", "reasoning": "..."}, ...]`;

    try {
      const raw = await this.llm.complete(batchPrompt, {
        maxTokens: 200 * pairs.length,
        temperature: 0.1,
        systemPrompt: batchSystem,
      });

      const trimmed = stripCodeFences(raw);
      let arr: any[];
      try {
        arr = JSON.parse(trimmed);
      } catch {
        const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
        if (jsonMatch) arr = JSON.parse(jsonMatch[0]);
        else throw new Error('No JSON array found');
      }

      if (!Array.isArray(arr) || arr.length !== pairs.length) {
        throw new Error(`Expected ${pairs.length} decisions, got ${Array.isArray(arr) ? arr.length : 'non-array'}`);
      }

      return arr.map((obj: any) => {
        const action = ['keep', 'replace', 'merge', 'conflict'].includes(obj?.action) ? obj.action : 'replace';
        return {
          action: action as SmartUpdateDecision['action'],
          merged_content: obj?.merged_content,
          reasoning: obj?.reasoning || '',
        };
      });
    } catch (e: any) {
      log.warn({ error: e.message, count: pairs.length }, 'Batch smart update failed, falling back to individual calls');
      const results: SmartUpdateDecision[] = [];
      for (const pair of pairs) {
        results.push(await this.smartUpdateDecision(pair.existing, pair.incoming));
      }
      return results;
    }
  }

  private parseSmartUpdateResponse(raw: string): SmartUpdateDecision {
    const trimmed = stripCodeFences(raw);
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      const jsonMatch = trimmed.match(/\{[\s\S]*"action"[\s\S]*\}/);
      if (jsonMatch) obj = JSON.parse(jsonMatch[0]);
      else return { action: 'replace', reasoning: 'Failed to parse LLM response, defaulting to replace' };
    }

    const action = ['keep', 'replace', 'merge', 'conflict'].includes(obj.action) ? obj.action : 'replace';
    return {
      action: action as SmartUpdateDecision['action'],
      merged_content: obj.merged_content,
      reasoning: obj.reasoning || '',
    };
  }

  /**
   * Execute a smart update: replace or merge, superseding the old memory.
   */
  async executeSmartUpdate(
    decision: SmartUpdateDecision,
    existing: Memory,
    extraction: ExtractedMemory,
    agentId: string,
    sessionId?: string,
    confidenceOverride?: number,
    sourcePrefix = 'sieve',
    forceLayer?: 'working' | 'core',
  ): Promise<Memory> {
    const content = decision.action === 'merge' && decision.merged_content
      ? decision.merged_content
      : extraction.content;

    // Importance merge strategy: merge takes max, replace/conflict uses new
    const newImportance = decision.action === 'merge'
      ? Math.max(existing.importance, extraction.importance)
      : extraction.importance;

    const layer = forceLayer || (newImportance >= 0.8 ? 'core' : 'working');
    const ttlMs = parseDuration(this.config.layers.working.ttl);
    const expiresAt = layer === 'working' ? new Date(Date.now() + ttlMs).toISOString() : undefined;

    const metadata: Record<string, any> = {
      extraction_source: extraction.source,
      reasoning: extraction.reasoning,
      smart_update_type: decision.action,
      update_reasoning: decision.reasoning,
      supersedes: existing.id,
    };

    const newMem = insertMemory({
      layer,
      category: extraction.category,
      owner_type: extraction.owner_type!,
      recall_scope: extraction.recall_scope!,
      content,
      importance: newImportance,
      confidence: confidenceOverride ?? 0.8,
      agent_id: agentId,
      source: sessionId ? `${sourcePrefix}:${sessionId}` : sourcePrefix,
      expires_at: expiresAt,
      metadata: JSON.stringify(metadata),
    });

    updateMemory(existing.id, { superseded_by: newMem.id });

    // Conflict: mark old memory with expired metadata
    if (decision.action === 'conflict') {
      try {
        const existingMeta = JSON.parse(existing.metadata || '{}');
        updateMemory(existing.id, {
          metadata: JSON.stringify({
            ...existingMeta,
            expired_reason: 'contradicted',
            expired_by: newMem.id,
            expired_at: new Date().toISOString(),
          }),
        });
      } catch { /* best-effort */ }
    }

    await this.indexVector(newMem.id, content);

    // Auto-log feedback when a correction replaces an existing memory
    if (extraction.category === 'correction') {
      try {
        insertExtractionFeedback({
          memory_id: existing.id,
          agent_id: agentId,
          feedback: 'corrected',
          original_content: existing.content,
          corrected_content: content,
          category: existing.category,
          source_channel: 'auto:correction',
        });
      } catch { /* best-effort */ }
    }

    log.info({
      action: decision.action,
      old_id: existing.id,
      new_id: newMem.id,
      reasoning: decision.reasoning,
    }, 'Smart update executed');

    return newMem;
  }

  /**
   * Unified entry point for processing a new memory extraction.
   *
   * Three-tier matching with near-exact optimization:
   *   distance < exactDupThreshold         → exact duplicate, skip
   *   distance < exactDupThreshold * 1.5   → near-exact, auto-replace (no LLM)
   *   distance < similarityThreshold       → semantic overlap, LLM decides
   *   distance >= similarityThreshold      → unrelated, normal insert
   */
  async processNewMemory(
    extraction: ExtractedMemory,
    agentId: string,
    sessionId?: string,
    confidenceOverride?: number,
    sourcePrefix = 'sieve',
    forceLayer?: 'working' | 'core',
  ): Promise<ProcessResult> {
    const classified = this.classifyExtraction(extraction);

    // Gate: filter obvious noise before expensive operations
    const minImportance = this.config.sieve.minImportance ?? 0.3;
    if (classified.importance < minImportance) {
      log.debug({ content: classified.content.slice(0, 50), importance: classified.importance, threshold: minImportance }, 'Below minimum importance threshold, skipping');
      return { action: 'skipped' };
    }
    if (classified.content.length < 8) {
      log.info({ content: classified.content }, 'Content too short, skipping');
      return { action: 'skipped' };
    }
    if (classified.content.length > 500) {
      log.info({ content: classified.content.slice(0, 50) }, 'Content too long (not refined), skipping');
      return { action: 'skipped' };
    }

    const { smartUpdate, exactDupThreshold, similarityThreshold } = this.config.sieve;

    // During lifecycle runs, skip smart update to avoid data races with deduplicateCore
    const effectiveSmartUpdate = smartUpdate && !isLifecycleActive();

    // Corrections get a wider similarity window (1.5x)
    const effectiveThreshold = classified.category === 'correction'
      ? Math.min(similarityThreshold * 1.5, 0.6)
      : similarityThreshold;

    // Corrections search within related categories
    const correctionCategories = classified.category === 'correction'
      ? ['identity', 'fact', 'preference', 'decision', 'entity', 'skill', 'relationship', 'goal', 'project_state', 'correction']
      : undefined;

    // Corrections get wider search (top 10) to find the target memory
    const topK = classified.category === 'correction' ? 10 : 3;
    const similar = await this.findSimilar(classified, agentId, correctionCategories, topK);

    if (!effectiveSmartUpdate) {
      // Legacy behavior (or lifecycle active — skip smart update to avoid races)
      if (similar.length > 0 && similar[0]!.distance < LEGACY_DEDUP_THRESHOLD) {
        return { action: 'skipped' };
      }
      const mem = this.insertNewMemory(classified, agentId, sessionId, confidenceOverride, sourcePrefix);
      await this.indexVector(mem.id, classified.content);
      return { action: 'inserted', memory: mem };
    }

    // Three-tier + near-exact matching
    if (similar.length > 0) {
      const closest = similar[0]!;

      // Cross-family check
      const crossFamily = !this.canMerge(closest.memory, classified);

      if (!crossFamily) {
        // Tier 1: exact duplicate → skip
        if (closest.distance < exactDupThreshold) {
          log.info({ distance: closest.distance, existing_id: closest.memory.id }, 'Exact duplicate, skipping');
          return { action: 'skipped' };
        }

        // Tier 1.5: near-exact → auto-replace without LLM call
        const nearExactThreshold = exactDupThreshold * 1.5;
        if (closest.distance < nearExactThreshold) {
          log.info({ distance: closest.distance, existing_id: closest.memory.id }, 'Near-exact match, auto-replacing');
          const newMem = await this.executeSmartUpdate(
            { action: 'replace', reasoning: 'Near-exact match, auto-replaced without LLM' },
            closest.memory, extraction, agentId, sessionId, confidenceOverride, sourcePrefix,
          );
          return { action: 'smart_updated', memory: newMem };
        }

        // Tier 2: semantic overlap → LLM decides
        if (closest.distance < effectiveThreshold) {
          const decision = await this.smartUpdateDecision(closest.memory, classified);
          if (decision.action === 'keep') {
            log.info({ existing_id: closest.memory.id, reasoning: decision.reasoning }, 'Smart update: keep existing');
            // Refresh confirmation timestamp — memory is still accurate
            try {
              const existingMeta = JSON.parse(closest.memory.metadata || '{}');
              updateMemory(closest.memory.id, {
                metadata: JSON.stringify({ ...existingMeta, last_confirmed_at: new Date().toISOString() }),
              });
            } catch { /* best-effort */ }
            return { action: 'skipped' };
          }
          const newMem = await this.executeSmartUpdate(
            decision, closest.memory, classified, agentId, sessionId, confidenceOverride, sourcePrefix,
          );
          return { action: 'smart_updated', memory: newMem };
        }
      }
    }

    // Tier 3: unrelated → normal insert
    const mem = this.insertNewMemory(classified, agentId, sessionId, confidenceOverride, sourcePrefix, forceLayer);
    await this.indexVector(mem.id, classified.content);
    return { action: 'inserted', memory: mem };
  }

  /**
   * Process multiple extractions, batching smart update LLM calls when possible.
   * Collects all pairs needing LLM decisions, sends them in one batch call,
   * then executes the decisions.
   */
  async processNewMemoryBatch(
    extractions: ExtractedMemory[],
    agentId: string,
    sessionId?: string,
    confidenceOverride?: number,
    sourcePrefix = 'sieve',
  ): Promise<ProcessResult[]> {
    if (extractions.length === 0) return [];
    const classifiedExtractions = extractions.map((ext) => this.classifyExtraction(ext));

    // Gate: filter obvious noise before expensive operations
    const minImportance = this.config.sieve.minImportance ?? 0.3;
    const gatedExtractions = classifiedExtractions.filter((ext) => {
      if (ext.importance < minImportance) {
        log.debug({ content: ext.content.slice(0, 50), importance: ext.importance, threshold: minImportance }, 'Batch gate: below threshold');
        return false;
      }
      if (ext.content.length < 8 || ext.content.length > 500) {
        log.info({ content: ext.content.slice(0, 50) }, 'Batch gate: content length out of range');
        return false;
      }
      return true;
    });
    // Build result array with skipped entries for gated items
    const gateResults: (ProcessResult | null)[] = classifiedExtractions.map((ext) =>
      (ext.importance < minImportance || ext.content.length < 8 || ext.content.length > 500)
        ? { action: 'skipped' as const }
        : null,
    );
    if (gatedExtractions.length === 0) {
      return gateResults.map(r => r || { action: 'skipped' });
    }

    const { smartUpdate, exactDupThreshold, similarityThreshold } = this.config.sieve;

    // Phase 1: find similar for each extraction, classify into tiers
    interface PendingItem {
      index: number;
      extraction: ExtractedMemory & MemoryPlacement;
      similar: SimilarMemory[];
      tier: 'skip' | 'near_exact' | 'needs_llm' | 'insert';
      closest?: SimilarMemory;
    }

    // Phase 1: parallel findSimilar for all gated extractions
    const similarResults = await Promise.all(
      gatedExtractions.map(ext => {
        const cats = ext.category === 'correction'
          ? ['identity', 'fact', 'preference', 'decision', 'entity', 'skill', 'relationship', 'goal', 'project_state', 'correction']
          : undefined;
        // Corrections get wider search (top 10) to find the target memory
        const topK = ext.category === 'correction' ? 10 : 3;
        return this.findSimilar(ext, agentId, cats, topK);
      }),
    );

    const pending: PendingItem[] = [];
    for (let i = 0; i < gatedExtractions.length; i++) {
      const extraction = gatedExtractions[i]!;
      const similar = similarResults[i]!;
      const effectiveThreshold = extraction.category === 'correction'
        ? Math.min(similarityThreshold * 1.5, 0.6)
        : similarityThreshold;

      if (!smartUpdate) {
        if (similar.length > 0 && similar[0]!.distance < 0.15) {
          pending.push({ index: i, extraction, similar, tier: 'skip' });
        } else {
          pending.push({ index: i, extraction, similar, tier: 'insert' });
        }
        continue;
      }

      if (similar.length > 0) {
        const closest = similar[0]!;
        const crossFamily = !this.canMerge(closest.memory, extraction);

        if (!crossFamily) {
          if (closest.distance < exactDupThreshold) {
            pending.push({ index: i, extraction, similar, tier: 'skip', closest });
          } else if (closest.distance < exactDupThreshold * 1.5) {
            pending.push({ index: i, extraction, similar, tier: 'near_exact', closest });
          } else if (closest.distance < effectiveThreshold) {
            pending.push({ index: i, extraction, similar, tier: 'needs_llm', closest });
          } else {
            pending.push({ index: i, extraction, similar, tier: 'insert' });
          }
        } else {
          pending.push({ index: i, extraction, similar, tier: 'insert' });
        }
      } else {
        pending.push({ index: i, extraction, similar, tier: 'insert' });
      }
    }

    // Phase 2: batch LLM call for all items needing smart update
    const llmItems = pending.filter(p => p.tier === 'needs_llm');
    let llmDecisions: SmartUpdateDecision[] = [];
    if (llmItems.length > 0) {
      llmDecisions = await this.batchSmartUpdateDecision(
        llmItems.map(p => ({ existing: p.closest!.memory, incoming: p.extraction })),
      );
    }

    // Phase 3: execute all decisions
    const batchResults: ProcessResult[] = new Array(gatedExtractions.length);
    let llmIdx = 0;

    for (const item of pending) {
      switch (item.tier) {
        case 'skip':
          batchResults[item.index] = { action: 'skipped' };
          break;

        case 'near_exact': {
          const newMem = await this.executeSmartUpdate(
            { action: 'replace', reasoning: 'Near-exact match, auto-replaced without LLM' },
            item.closest!.memory, item.extraction, agentId, sessionId, confidenceOverride, sourcePrefix,
          );
          batchResults[item.index] = { action: 'smart_updated', memory: newMem };
          break;
        }

        case 'needs_llm': {
          const decision = llmDecisions[llmIdx++]!;
          if (decision.action === 'keep') {
            batchResults[item.index] = { action: 'skipped' };
          } else {
            const newMem = await this.executeSmartUpdate(
              decision, item.closest!.memory, item.extraction, agentId, sessionId, confidenceOverride, sourcePrefix,
            );
            batchResults[item.index] = { action: 'smart_updated', memory: newMem };
          }
          break;
        }

        case 'insert': {
          const mem = this.insertNewMemory(item.extraction, agentId, sessionId, confidenceOverride, sourcePrefix);
          await this.indexVector(mem.id, item.extraction.content);
          batchResults[item.index] = { action: 'inserted', memory: mem };
          break;
        }
      }
    }

    // Merge gated (skipped) results with batch results
    let batchIdx = 0;
    return gateResults.map(r => {
      if (r !== null) return r; // was gated out
      return batchResults[batchIdx++] || { action: 'skipped' };
    });
  }

  /**
   * Insert a new memory.
   */
  insertNewMemory(
    extraction: ExtractedMemory,
    agentId: string,
    sessionId?: string,
    confidenceOverride?: number,
    sourcePrefix = 'sieve',
    forceLayer?: 'working' | 'core',
  ): Memory {
    const layer = forceLayer || (extraction.importance >= 0.8 ? 'core' : 'working');
    const ttlMs = parseDuration(this.config.layers.working.ttl);
    const expiresAt = layer === 'working' ? new Date(Date.now() + ttlMs).toISOString() : undefined;

    return insertMemory({
      layer,
      category: extraction.category,
      owner_type: extraction.owner_type!,
      recall_scope: extraction.recall_scope!,
      content: extraction.content,
      importance: extraction.importance,
      confidence: confidenceOverride ?? 0.8,
      agent_id: agentId,
      source: sessionId ? `${sourcePrefix}:${sessionId}` : sourcePrefix,
      expires_at: expiresAt,
      metadata: JSON.stringify({
        extraction_source: extraction.source,
        reasoning: extraction.reasoning,
        scope_hint: extraction.scope_hint ?? null,
      }),
    });
  }

  /**
   * Index a memory's vector embedding.
   */
  async indexVector(id: string, content: string): Promise<void> {
    try {
      const embedding = await this.embeddingProvider.embed(content);
      if (embedding.length > 0) {
        await this.vectorBackend.upsert(id, embedding);
      }
    } catch (e: any) {
      log.warn({ id, error: e.message }, 'Vector indexing failed, text-only');
    }
  }
}

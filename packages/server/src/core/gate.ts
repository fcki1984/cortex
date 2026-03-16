import { createLogger } from '../utils/logger.js';
import { HybridSearchEngine, type SearchResult } from '../search/index.js';
import { isSmallTalk } from '../signals/index.js';
import { expandQuery } from '../search/query-expansion.js';
import { stripInjectedContent } from '../utils/sanitize.js';
import type { Reranker } from '../search/reranker.js';
import type { CortexConfig } from '../utils/config.js';
import type { LLMProvider } from '../llm/interface.js';
import { findRelatedRelations, listMemories } from '../db/queries.js';
import { extractEntityTokens } from '../utils/helpers.js';
import { getDriver, traverseRelations, listRelations as neo4jListRelations } from '../db/neo4j.js';
import { isPlacementComplete } from '../utils/memory-placement.js';

const log = createLogger('gate');

export interface RecallRequest {
  query: string;
  agent_id?: string;
  max_tokens?: number;
  layers?: ('working' | 'core' | 'archive')[];
  skip_filters?: boolean;
}

export interface RecallResponse {
  context: string;
  memories: SearchResult[];
  meta: {
    query: string;
    total_found: number;
    injected_count: number;
    persona_injected_count: number;
    rule_injected_count: number;
    search_injected_count: number;
    relations_count: number;
    skipped: boolean;
    reason?: string;
    suppressed: boolean;
    suppressed_reason?: 'low_relevance';
    relevance_gate: {
      passed: boolean;
      inspected_count: number;
      best_overlap: number;
      best_vector_score: number;
      best_fused_score: number;
    };
    latency_ms: number;
  };
}

interface RelevanceGateDecision {
  passed: boolean;
  suppressed: boolean;
  inspected_count: number;
  best_overlap: number;
  best_vector_score: number;
  best_fused_score: number;
}

const GATE_STOP_WORDS = new Set([
  '\u7684', '\u4e86', '\u5728', '\u662f', '\u6709', '\u6211', '\u4f60', '\u4ed6', '\u5979', '\u5b83', '\u4eec',
  '\u5417', '\u5427', '\u5462', '\u554a', '\u54e6', '\u55ef', '\u8fd9', '\u90a3', '\u4ec0\u4e48', '\u600e\u4e48',
  '\u54ea', '\u54ea\u91cc', '\u4e3a\u4ec0\u4e48',
  'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'what', 'how', 'where', 'who', 'which',
]);

const DEFAULT_RELEVANCE_GATE: RelevanceGateDecision = {
  passed: true,
  suppressed: false,
  inspected_count: 0,
  best_overlap: 0,
  best_vector_score: 0,
  best_fused_score: 0,
};

function getEffectiveTokens(text: string): string[] {
  return [...new Set(extractEntityTokens(text))].filter(token => token.length >= 2 && !GATE_STOP_WORDS.has(token));
}

function countInjectedLines(context: string): number {
  return context ? context.split('\n').filter(line => line.startsWith('[')).length : 0;
}

export class MemoryGate {
  private rerankerWeight: number;

  constructor(
    private searchEngine: HybridSearchEngine,
    private config: CortexConfig['gate'],
    private llm?: LLMProvider,
    private reranker?: Reranker,
    rerankerWeight?: number,
  ) {
    this.rerankerWeight = rerankerWeight ?? 0.5;
  }

  async recall(req: RecallRequest): Promise<RecallResponse> {
    const start = Date.now();
    const query = stripInjectedContent(req.query);

    // Skip small talk (unless skip_filters is set, e.g. Dashboard search test)
    if (this.config.skipSmallTalk && !req.skip_filters && isSmallTalk(query)) {
      return {
        context: '',
        memories: [],
        meta: {
          query: req.query,
          total_found: 0,
          injected_count: 0,
          persona_injected_count: 0,
          rule_injected_count: 0,
          search_injected_count: 0,
          relations_count: 0,
          skipped: true,
          reason: 'small_talk',
          suppressed: false,
          relevance_gate: DEFAULT_RELEVANCE_GATE,
          latency_ms: Date.now() - start,
        },
      };
    }

    const relationBudget = this.config.relationBudget ?? 100;
    const relationInjection = this.config.relationInjection !== false;
    const memoryBudget = req.max_tokens || this.config.maxInjectionTokens;

    // Parallel: search original query AND expand simultaneously
    // Before: expansion(2s) → embed+search(1.5s) × N → rerank (serial, ~7s)
    // After:  expansion(2s) ──┐
    //         embed+search(1.5s) ─┤→ merge → rerank (~4-5s)
    //                          variant searches(1.5s parallel) ─┘
    const searchOpts = {
      layers: req.layers,
      agent_id: req.agent_id,
      recall_scope: 'topic' as const,
      limit: this.config.searchLimit || 30,
    };

    // Start original query search immediately (no waiting for expansion)
    const originalSearchPromise = this.searchEngine.search({ query, ...searchOpts });

    // Expansion runs in parallel with original search
    const variantResultsPromise: Promise<SearchResult[]> = (this.config.queryExpansion?.enabled && this.llm)
      ? Promise.race([
          expandQuery(query, this.llm, this.config.queryExpansion),
          new Promise<string[]>((_, reject) =>
            setTimeout(() => reject(new Error('Query expansion timeout')), this.config.queryExpansionTimeoutMs ?? 5000)
          ),
        ])
        .then(async (queries) => {
          // Filter out original query, search all variants in parallel
          const variants = queries.filter(q => q !== query);
          if (variants.length === 0) return [];
          const variantSearches = await Promise.all(
            variants.map(q => this.searchEngine.search({ query: q, ...searchOpts }))
          );
          return variantSearches.flatMap(s => s.results);
        })
        .catch((e: any) => {
          log.warn({ error: e.message }, 'Query expansion timed out or failed');
          return [] as SearchResult[];
        })
      : Promise.resolve([]);

    const [originalResult, variantResults] = await Promise.all([
      originalSearchPromise,
      variantResultsPromise,
    ]);

    // Merge results: original first, then variants
    const resultMap = new Map<string, SearchResult>();
    const hitCount = new Map<string, number>();
    for (const r of originalResult.results) {
      hitCount.set(r.id, 1);
      resultMap.set(r.id, r);
    }
    for (const r of variantResults) {
      hitCount.set(r.id, (hitCount.get(r.id) ?? 0) + 1);
      const existing = resultMap.get(r.id);
      if (!existing || r.rawVectorSim > existing.rawVectorSim || (r.rawVectorSim === existing.rawVectorSim && r.finalScore > existing.finalScore)) {
        resultMap.set(r.id, r);
      }
    }

    // When multiple query variants are merged, keep the best per-variant scores as-is.
    // Each variant's search results were already normalized in hybrid.ts.
    // The merge uses rawVectorSim for comparison (see above), so the best variant's
    // normalized scores win naturally. No re-normalization needed here.
    const merged = Array.from(resultMap.values());

    // Boost score for memories hit by multiple query variants (diminishing returns)
    let results = merged
      .map(r => {
        const hits = hitCount.get(r.id) ?? 1;
        // ln(1)=0, ln(2)≈0.69, ln(3)≈1.10, ln(5)≈1.61 → boost caps naturally
        let boost = hits > 1 ? 1 + 0.08 * Math.log(hits) : 1;
        return { ...r, finalScore: r.finalScore * boost };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    // Pre-filter: only send results with meaningful search signal to reranker
    // Use rawVectorSim (pre-normalization) to avoid false negatives from normalization
    const signalResults = results.filter(r => r.rawVectorSim > 0 || r.vectorScore > 0 || r.textScore > 0);
    const zeroSignal = results.filter(r => r.rawVectorSim === 0 && r.vectorScore === 0 && r.textScore === 0);
    if (signalResults.length === 0 && results.length > 0) {
      log.info({ total: results.length, signal: 0, zero: zeroSignal.length }, 'All results filtered as zero-signal');
    }

    if (this.reranker && signalResults.length > 0) {
      // Normalize original scores to 0-1 range for fair fusion
      const maxOriginal = Math.max(...signalResults.map(r => r.finalScore)) || 1;
      const originalScores = new Map(signalResults.map(r => [r.id, r.finalScore / maxOriginal]));

      try {
        const reranked = await Promise.race([
          this.reranker.rerank(query, signalResults, 15),
          new Promise<SearchResult[]>((_, reject) =>
            setTimeout(() => reject(new Error('Reranker timeout')), this.config.rerankerTimeoutMs ?? 8000)
          ),
        ]);
        const rw = this.rerankerWeight;
        const ow = 1 - rw;

        // Fuse reranker score with original score
        results = reranked.map(r => ({
          ...r,
          finalScore: rw * r.finalScore + ow * (originalScores.get(r.id) ?? 0),
        })).sort((a, b) => b.finalScore - a.finalScore);

        // Only append zero-signal results if we have very few signal results
        // This prevents noise padding while allowing fallback for sparse queries
        if (results.length < 3 && zeroSignal.length > 0) {
          const padding = Math.min(3 - results.length, zeroSignal.length);
          for (let i = 0; i < padding; i++) {
            results.push({ ...zeroSignal[i]!, finalScore: 0 });
          }
        }
      } catch (e: any) {
        log.warn({ error: e.message }, 'Reranker timed out or failed, using original order');
        results = results.slice(0, 15);
      }
    } else if (signalResults.length === 0 && zeroSignal.length > 0) {
      // No signal at all — return empty (don't inject random noise)
      results = [];
    } else {
      results = results.slice(0, 15);
    }

    // Score cliff filter: drop results that are dramatically worse than the top
    // Three checks (any one triggers cutoff):
    //   1. Absolute: score < cliffAbsolute of #1 (too far from best match)
    //   2. Gap: score < cliffGap of previous result (sudden drop)
    //   3. Floor: score < cliffFloor (no meaningful signal)
    const cliffAbsolute = this.config.cliffAbsolute ?? 0.4;
    const cliffGap = this.config.cliffGap ?? 0.6;
    const cliffFloor = this.config.cliffFloor ?? 0.05;
    if (results.length > 1) {
      const topScore = results[0]!.finalScore;
      if (topScore > 0) {
        const cliff = Math.max(topScore * cliffAbsolute, cliffFloor);
        let cutoff = results.length;
        for (let i = 1; i < results.length; i++) {
          if (results[i]!.finalScore < cliff) {
            cutoff = i;
            break;
          }
          // Gap detection: if this result is less than cliffGap of previous, it's a cliff
          if (results[i]!.finalScore < results[i - 1]!.finalScore * cliffGap) {
            cutoff = i;
            break;
          }
        }
        if (cutoff < results.length) {
          log.info({ before: results.length, after: cutoff, topScore: topScore.toFixed(3), cutoffScore: results[cutoff - 1]?.finalScore.toFixed(3) }, 'Score cliff filter applied');
          results = results.slice(0, cutoff);
        }
      }
    }

    const fixedBudget = this.config.fixedInjectionTokens ?? 500;
    const ruleBudget = fixedBudget;
    const toFixedResult = (memory: any): SearchResult => ({
      id: memory.id,
      content: memory.content,
      layer: memory.layer,
      category: memory.category,
      owner_type: memory.owner_type,
      recall_scope: memory.recall_scope,
      agent_id: memory.agent_id,
      importance: memory.importance,
      decay_score: memory.decay_score,
      access_count: memory.access_count,
      created_at: memory.created_at,
      textScore: 0,
      vectorScore: 0,
      rawVectorSim: 0,
      fusedScore: 0,
      layerWeight: 1,
      recencyBoost: 1,
      accessBoost: 1,
      finalScore: 0,
    });

    const personaResults = listMemories({
      agent_id: req.agent_id,
      category: 'agent_persona' as any,
      owner_type: 'agent',
      recall_scope: 'global',
      limit: 50,
      orderBy: 'importance',
      orderDir: 'desc',
    }).items.filter(isPlacementComplete).map(toFixedResult);

    const ruleResults = listMemories({
      agent_id: req.agent_id,
      owner_type: 'system',
      recall_scope: 'global',
      limit: 50,
      orderBy: 'importance',
      orderDir: 'desc',
    }).items
      .filter((memory) => isPlacementComplete(memory) && (memory.category === 'constraint' || memory.category === 'policy'))
      .map(toFixedResult);

    const relevanceGate = this.evaluateRelevanceGate(query, results);

    const personaContext = personaResults.length > 0
      ? this.searchEngine.formatForInjection(personaResults, fixedBudget, { priorityCategories: ['agent_persona'] })
      : '';
    const ruleContext = ruleResults.length > 0
      ? this.searchEngine.formatForInjection(ruleResults, ruleBudget, { priorityCategories: ['constraint', 'policy'] })
      : '';
    const searchContext = relevanceGate.suppressed
      ? ''
      : this.searchEngine.formatForInjection(results, memoryBudget, { priorityCategories: ['correction'] });

    const blocks = [personaContext, ruleContext, searchContext].filter(Boolean);
    let context = '';
    for (const block of blocks) {
      if (!context) {
        context = block;
        continue;
      }
      const mergedHead = context.replace('</cortex_memory>', '').trimEnd();
      const mergedTail = block.replace('<cortex_memory>', '').trimStart();
      context = `${mergedHead}\n${mergedTail}`;
    }
    const personaInjectedCount = countInjectedLines(personaContext);
    const ruleInjectedCount = countInjectedLines(ruleContext);
    const searchInjectedCount = countInjectedLines(searchContext);
    const injectedCount = personaInjectedCount + ruleInjectedCount + searchInjectedCount;

    // Inject relevant relations (Neo4j multi-hop or SQLite fallback)
    let relationsCount = 0;
    if (relationInjection && !relevanceGate.suppressed) {
      try {
        const relationBlock = await Promise.race([
          this.buildRelationBlock(query, req.agent_id),
          new Promise<{ block: string; count: number }>((_, reject) =>
            setTimeout(() => reject(new Error('Relation injection timeout')), this.config.relationTimeoutMs ?? 5000)
          ),
        ]);
        if (relationBlock.count > 0) {
          relationsCount = relationBlock.count;
          context = context ? `${context}\n${relationBlock.block}` : relationBlock.block;
        }
      } catch (e: any) {
        log.warn({ error: e.message }, 'Relation injection failed entirely, returning search-only results');
        // relationsCount stays 0, context stays as-is
      }
    }

    const latency = Date.now() - start;
    log.info({
      query: query.slice(0, 50),
      results: results.length,
      injected: injectedCount,
      relations: relationsCount,
      suppressed: relevanceGate.suppressed,
      relevance_gate: relevanceGate,
      latency_ms: latency,
    }, 'Recall completed');

    return {
      context,
      memories: results,
        meta: {
          query,
          total_found: results.length,
          injected_count: injectedCount,
          persona_injected_count: personaInjectedCount,
          rule_injected_count: ruleInjectedCount,
          search_injected_count: searchInjectedCount,
          relations_count: relationsCount,
          skipped: false,
        suppressed: relevanceGate.suppressed,
        ...(relevanceGate.suppressed ? { suppressed_reason: 'low_relevance' as const } : {}),
        relevance_gate: {
          passed: relevanceGate.passed,
          inspected_count: relevanceGate.inspected_count,
          best_overlap: relevanceGate.best_overlap,
          best_vector_score: relevanceGate.best_vector_score,
          best_fused_score: relevanceGate.best_fused_score,
        },
        latency_ms: latency,
      },
    };
  }

  private evaluateRelevanceGate(query: string, results: SearchResult[]): RelevanceGateDecision {
    const gateConfig = this.config.relevanceGate;
    if (gateConfig?.enabled === false || results.length === 0) {
      return {
        ...DEFAULT_RELEVANCE_GATE,
        passed: true,
      };
    }

    const inspectTopK = gateConfig?.inspectTopK ?? 3;
    const inspected = results.slice(0, inspectTopK);
    const strongest = inspected[0];
    const queryTokens = getEffectiveTokens(query);

    let bestOverlap = 0;
    for (const result of inspected) {
      const memoryTokens = getEffectiveTokens(result.content);
      const overlap = memoryTokens.filter(token => queryTokens.includes(token)).length;
      if (overlap > bestOverlap) bestOverlap = overlap;
    }

    const bestVectorScore = strongest?.vectorScore ?? 0;
    const bestFusedScore = strongest?.fusedScore ?? 0;
    const hasOverlap = bestOverlap >= 1;
    const passesSemanticFallback = !hasOverlap
      && bestVectorScore >= (gateConfig?.minSemanticScore ?? 0.55)
      && bestFusedScore >= (gateConfig?.minFusedScoreNoOverlap ?? 0.15);
    const passed = hasOverlap || passesSemanticFallback;

    return {
      passed,
      suppressed: !passed,
      inspected_count: inspected.length,
      best_overlap: bestOverlap,
      best_vector_score: bestVectorScore,
      best_fused_score: bestFusedScore,
    };
  }

  private async buildRelationBlock(query: string, agentId?: string): Promise<{ block: string; count: number }> {
    const queryEntities = [...new Set(extractEntityTokens(query))];

    if (queryEntities.length === 0) {
      return { block: '', count: 0 };
    }

    const useNeo4j = !!getDriver();
    type RelCandidate = { line: string; text: string };
    const candidates: RelCandidate[] = [];

    if (useNeo4j) {
      for (const entity of queryEntities.slice(0, 3)) {
        try {
          const traversed = await traverseRelations(entity, {
            maxHops: 2,
            minConfidence: 0.6,
            limit: 8,
            agentId,
          });
          for (const t of traversed) {
            if (t.hops <= 2) {
              const pathText = t.path.slice(1).join(' → ');
              candidates.push({
                line: `${entity} → ${pathText} (${t.hops}hop)`,
                text: `${entity} ${pathText}`,
              });
            }
          }
        } catch (e: any) {
          log.debug({ entity, error: e.message }, 'Traverse failed for entity');
        }
      }

      try {
        const directRels = await neo4jListRelations({
          agentId,
          limit: 15,
          includeExpired: false,
        });
        const entityRels = directRels.filter(r =>
          queryEntities.some(e =>
            r.subject.toLowerCase().includes(e.toLowerCase()) ||
            r.object.toLowerCase().includes(e.toLowerCase())
          )
        );
        for (const r of entityRels) {
          const line = `${r.subject} --${r.predicate}--> ${r.object} (${r.confidence.toFixed(2)})`;
          if (!candidates.some(c => c.line === line)) {
            candidates.push({
              line,
              text: `${r.subject} ${r.predicate} ${r.object}`,
            });
          }
        }
      } catch (e: any) {
        log.debug({ error: e.message }, 'Failed to fetch direct relations');
      }
    } else {
      const relations = findRelatedRelations(queryEntities, agentId);
      for (const r of relations) {
        candidates.push({
          line: `${r.subject} --${r.predicate}--> ${r.object} (${r.confidence.toFixed(2)})`,
          text: `${r.subject} ${r.predicate} ${r.object}`,
        });
      }
    }

    const contextKeywords = queryEntities.filter(t => !GATE_STOP_WORDS.has(t));
    const subjectEntities = new Set<string>();
    const topicKeywords: string[] = [];

    for (const kw of contextKeywords) {
      const isSubject = candidates.some(c =>
        c.text.toLowerCase().startsWith(kw.toLowerCase()) ||
        c.text.toLowerCase().includes(`${kw.toLowerCase()} `)
      );
      if (isSubject && candidates.filter(c => c.text.toLowerCase().includes(kw.toLowerCase())).length > 3) {
        subjectEntities.add(kw);
      } else {
        topicKeywords.push(kw);
      }
    }

    let filtered: string[];
    if (topicKeywords.length > 0 && candidates.length > 0) {
      filtered = candidates
        .filter(c => topicKeywords.some(kw =>
          c.text.toLowerCase().includes(kw.toLowerCase())
        ))
        .map(c => c.line);
      log.debug({ topicKeywords, subjectEntities: [...subjectEntities], before: candidates.length, after: filtered.length }, 'Relation topic filter');
    } else {
      filtered = candidates.map(c => c.line);
    }

    const cappedLines = filtered.slice(0, 5);
    if (cappedLines.length === 0) {
      return { block: '', count: 0 };
    }

    log.debug({ count: cappedLines.length, source: useNeo4j ? 'neo4j' : 'sqlite' }, 'Relations injected');
    return {
      block: `<cortex_relations>\n${cappedLines.join('\n')}\n</cortex_relations>`,
      count: cappedLines.length,
    };
  }
}

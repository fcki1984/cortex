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
  '的', '了', '在', '是', '有', '我', '你', '他', '她', '它', '们',
  '吗', '吧', '呢', '啊', '哦', '嗯', '这', '那', '什么', '怎么',
  '哪', '哪里', '为什么',
  'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'what', 'how', 'where', 'who', 'which',
]);

const FIXED_RULE_HINTS = [
  /回答|作答|回复|输出|表达|语言|语气|风格|口吻|中文|写作/u,
  /澄清|提问|追问|歧义|语境|句意|词汇|对齐用户需求/u,
  /搜索|联网|引用|来源|证据|权威|知识库|工具|mcp/u,
  /answer|respond|response|reply|tone|style|wording|clarif|ambigu|search|browse|tool|source|cite|citation|evidence|mcp|formal|natural|professional|concise|chinese/i,
];

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

function unwrapMemoryBlock(block: string): string {
  return block
    .replace(/^<cortex_memory>\s*/, '')
    .replace(/\s*<\/cortex_memory>$/, '')
    .trim();
}

function mergeMemoryBlocks(blocks: string[]): string {
  const nonEmpty = blocks.filter(Boolean);
  if (nonEmpty.length === 0) return '';
  if (nonEmpty.length === 1) return nonEmpty[0]!;

  const bodies = nonEmpty.map(unwrapMemoryBlock).filter(Boolean);
  if (bodies.length === 0) return '';

  return ['<cortex_memory>', ...bodies, '</cortex_memory>'].join('\n');
}

function isEligibleFixedRule(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return FIXED_RULE_HINTS.some(pattern => pattern.test(normalized));
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

    const relationInjection = this.config.relationInjection !== false;
    const memoryBudget = req.max_tokens || this.config.maxInjectionTokens;
    const ruleInjectionEnabled = this.config.ruleInjection?.enabled !== false;
    const ruleBudget = this.config.ruleInjection?.maxTokens ?? 500;

    const searchOpts = {
      layers: req.layers,
      agent_id: req.agent_id,
      limit: this.config.searchLimit || 30,
    };

    const originalSearchPromise = this.searchEngine.search({ query, ...searchOpts });

    const variantResultsPromise: Promise<SearchResult[]> = (this.config.queryExpansion?.enabled && this.llm)
      ? Promise.race([
          expandQuery(query, this.llm, this.config.queryExpansion),
          new Promise<string[]>((_, reject) =>
            setTimeout(() => reject(new Error('Query expansion timeout')), this.config.queryExpansionTimeoutMs ?? 5000)
          ),
        ])
        .then(async (queries) => {
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

    const merged = Array.from(resultMap.values());

    let results = merged
      .map(r => {
        const hits = hitCount.get(r.id) ?? 1;
        let boost = hits > 1 ? 1 + 0.08 * Math.log(hits) : 1;
        if (!ruleInjectionEnabled && r.category === 'constraint' && r.importance >= 0.7) {
          boost *= 1.5;
        }
        return { ...r, finalScore: r.finalScore * boost };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    const signalResults = results.filter(r => r.rawVectorSim > 0 || r.vectorScore > 0 || r.textScore > 0);
    const zeroSignal = results.filter(r => r.rawVectorSim === 0 && r.vectorScore === 0 && r.textScore === 0);
    if (signalResults.length === 0 && results.length > 0) {
      log.info({ total: results.length, signal: 0, zero: zeroSignal.length }, 'All results filtered as zero-signal');
    }

    if (this.reranker && signalResults.length > 0) {
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

        results = reranked.map(r => ({
          ...r,
          finalScore: rw * r.finalScore + ow * (originalScores.get(r.id) ?? 0),
        })).sort((a, b) => b.finalScore - a.finalScore);

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
      results = [];
    } else {
      results = results.slice(0, 15);
    }

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

    const personaBudget = this.config.fixedInjectionTokens ?? 500;
    const personaExtraction = this.extractFixedLayerResults(req.agent_id, ['agent_persona'], results);
    results = personaExtraction.remainingResults;

    let ruleResults: SearchResult[] = [];
    if (ruleInjectionEnabled) {
      const ruleExtraction = this.extractFixedLayerResults(
        req.agent_id,
        ['constraint', 'policy'],
        results,
        result => isEligibleFixedRule(result.content)
      );
      ruleResults = ruleExtraction.fixedResults;
      results = ruleExtraction.remainingResults;
    }

    const relevanceGate = this.evaluateRelevanceGate(query, results);

    const personaContext = personaExtraction.fixedResults.length > 0
      ? this.searchEngine.formatForInjection(personaExtraction.fixedResults, personaBudget, {
          priorityCategories: ['agent_persona'],
        })
      : '';
    const ruleContext = ruleResults.length > 0
      ? this.searchEngine.formatForInjection(ruleResults, ruleBudget, {
          priorityCategories: ['constraint', 'policy'],
        })
      : '';
    const searchContext = relevanceGate.suppressed
      ? ''
      : this.searchEngine.formatForInjection(
          results,
          memoryBudget,
          ruleInjectionEnabled ? { priorityCategories: ['correction'] } : undefined
        );

    let context = mergeMemoryBlocks([personaContext, ruleContext, searchContext]);
    const personaInjectedCount = countInjectedLines(personaContext);
    const ruleInjectedCount = countInjectedLines(ruleContext);
    const searchInjectedCount = countInjectedLines(searchContext);
    const injectedCount = personaInjectedCount + ruleInjectedCount + searchInjectedCount;

    let relationsCount = 0;
    if (relationInjection && !relevanceGate.suppressed && results.length > 0) {
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
      }
    }

    const latency = Date.now() - start;
    log.info({
      query: query.slice(0, 50),
      results: results.length,
      injected: injectedCount,
      persona_injected: personaInjectedCount,
      rule_injected: ruleInjectedCount,
      search_injected: searchInjectedCount,
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

  private extractFixedLayerResults(
    agentId: string | undefined,
    categories: string[],
    results: SearchResult[],
    predicate?: (result: SearchResult) => boolean
  ): { fixedResults: SearchResult[]; remainingResults: SearchResult[] } {
    const categorySet = new Set(categories);
    const fixedMap = new Map<string, SearchResult>();
    const remainingResults: SearchResult[] = [];

    for (const result of results) {
      if (categorySet.has(result.category) && (!predicate || predicate(result))) {
        fixedMap.set(result.id, result);
      } else {
        remainingResults.push(result);
      }
    }

    for (const category of categories) {
      const { items } = listMemories({
        agent_id: agentId,
        category: category as any,
        limit: 50,
        orderBy: 'importance',
        orderDir: 'desc',
      });

      for (const memory of items) {
        const candidate: SearchResult = {
          id: memory.id,
          content: memory.content,
          layer: memory.layer,
          category: memory.category,
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
        };
        if (!fixedMap.has(memory.id) && (!predicate || predicate(candidate))) {
          fixedMap.set(memory.id, candidate);
        }
      }
    }

    const fixedResults = Array.from(fixedMap.values()).sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return { fixedResults, remainingResults };
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
              const pathText = t.path.slice(1).join(' -> ');
              candidates.push({
                line: `${entity} -> ${pathText} (${t.hops}hop)`,
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

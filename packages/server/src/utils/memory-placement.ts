import type { MemoryCategory } from '../db/queries.js';

export type MemoryOwnerType = 'user' | 'agent' | 'system';
export type MemoryRecallScope = 'global' | 'topic';
export type MemoryCategoryFamily = 'rule' | 'agent' | 'general';

export interface MemoryPlacement {
  owner_type: MemoryOwnerType;
  recall_scope: MemoryRecallScope;
}

export interface PlacementClassificationInput {
  category: MemoryCategory;
  content: string;
  source?: string | null;
  scope_hint?: MemoryRecallScope | null;
}

const GLOBAL_RULE_PATTERNS = [
  /(?:回答|回复|作答|表达|措辞|语言|中文|英文|语气|风格|写作)/i,
  /(?:澄清|先问|先确认|避免歧义|对齐需求)/i,
  /(?:引用|来源|证据|搜索|联网|工具|优先使用|必须使用|不要使用|核实)/i,
  /(?:response|answer|tone|style|wording|clarify|citation|source|search|tool)/i,
];

const TOPIC_RULE_PATTERNS = [
  /(?:预算|价格|金额|落地|公里|km|GB|TB|流量|住宅|家宽|套餐|代理|车型|版本|品牌|产品|项目|账号|IP)/i,
  /(?:偏好购买|想买|购车|代理池|住宅代理|混动车|DM-i|比亚迪|鸡翅|牛肉)/i,
  /(?:prefer to buy|budget|proxy|plan|model|product|package|pricing|vehicle|car)/i,
];

const GLOBAL_RULE_CATEGORIES = new Set<MemoryCategory>(['constraint', 'policy']);

export function isMemoryOwnerType(value: unknown): value is MemoryOwnerType {
  return value === 'user' || value === 'agent' || value === 'system';
}

export function isMemoryRecallScope(value: unknown): value is MemoryRecallScope {
  return value === 'global' || value === 'topic';
}

export function getCategoryFamily(category: MemoryCategory): MemoryCategoryFamily {
  if (category.startsWith('agent_')) return 'agent';
  if (category === 'constraint' || category === 'policy') return 'rule';
  return 'general';
}

export function isPlacementComplete(value: Partial<MemoryPlacement> | null | undefined): value is MemoryPlacement {
  return !!value && isMemoryOwnerType(value.owner_type) && isMemoryRecallScope(value.recall_scope);
}

export function classifyMemoryPlacement(input: PlacementClassificationInput): MemoryPlacement {
  const content = input.content.trim();
  const category = input.category;
  const source = input.source || null;
  const scopeHint = input.scope_hint;

  if (category === 'agent_persona') {
    return { owner_type: 'agent', recall_scope: 'global' };
  }

  if (category.startsWith('agent_')) {
    return { owner_type: 'agent', recall_scope: 'topic' };
  }

  if (!GLOBAL_RULE_CATEGORIES.has(category)) {
    return { owner_type: 'user', recall_scope: 'topic' };
  }

  const looksGlobalRule = GLOBAL_RULE_PATTERNS.some((pattern) => pattern.test(content));
  const looksTopicSpecific = TOPIC_RULE_PATTERNS.some((pattern) => pattern.test(content));
  const hintedGlobal = scopeHint === 'global';
  const systemDefined = source === 'system_defined';

  if ((systemDefined || looksGlobalRule || hintedGlobal) && !looksTopicSpecific) {
    return { owner_type: 'system', recall_scope: 'global' };
  }

  return { owner_type: 'user', recall_scope: 'topic' };
}

export function canSmartMergePlacement(existing: MemoryPlacement, incoming: MemoryPlacement): boolean {
  return existing.owner_type === incoming.owner_type && existing.recall_scope === incoming.recall_scope;
}

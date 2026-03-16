import type {
  Memory,
  MemoryCategory,
  MemoryOwnerType,
  MemoryRecallScope,
} from '../db/queries.js';

export interface MemoryPlacement {
  owner_type: MemoryOwnerType;
  recall_scope: MemoryRecallScope;
}

export interface PlacementLike {
  category: MemoryCategory;
  owner_type?: MemoryOwnerType | null;
  recall_scope?: MemoryRecallScope | null;
}

export interface PlacementHintInput {
  category: MemoryCategory;
  content: string;
  source?: string | null;
  scope_hint?: MemoryRecallScope | null;
}

export type MemoryCategoryFamily = 'agent' | 'rule' | 'general';

const VALID_OWNER_TYPES = new Set<MemoryOwnerType>(['user', 'agent', 'system']);
const VALID_RECALL_SCOPES = new Set<MemoryRecallScope>(['global', 'topic']);

const GLOBAL_RULE_PATTERNS: RegExp[] = [
  /回答|作答|回复|输出|表达|措辞|语气|写作|风格|语言/,
  /自然|正式|怪异化|简洁|简明|清晰/,
  /澄清|语境|词汇|句意|需求|歧义|提问/,
  /搜索工具|联网搜索|引用|来源|参考源|权威|知识库/,
  /grok[- ]?tavily|sequential[- ]thinking|mcp|tool/i,
  /always answer|reply|tone|style|wording|clarify|ask follow-up/i,
  /search tool|sources?|citations?|evidence/i,
];

function isValidOwnerType(value: unknown): value is MemoryOwnerType {
  return typeof value === 'string' && VALID_OWNER_TYPES.has(value as MemoryOwnerType);
}

function isValidRecallScope(value: unknown): value is MemoryRecallScope {
  return typeof value === 'string' && VALID_RECALL_SCOPES.has(value as MemoryRecallScope);
}

export function isAgentCategory(category: MemoryCategory): boolean {
  return category.startsWith('agent_');
}

export function isRuleCategory(category: MemoryCategory): boolean {
  return category === 'constraint' || category === 'policy';
}

export function getCategoryFamily(category: MemoryCategory): MemoryCategoryFamily {
  if (isAgentCategory(category)) return 'agent';
  if (isRuleCategory(category)) return 'rule';
  return 'general';
}

function inferRuleScopeFromContent(content: string): MemoryRecallScope {
  return GLOBAL_RULE_PATTERNS.some(pattern => pattern.test(content)) ? 'global' : 'topic';
}

export function classifyMemoryPlacement(input: PlacementHintInput): MemoryPlacement {
  if (input.category === 'agent_persona') {
    return { owner_type: 'agent', recall_scope: 'global' };
  }

  if (isAgentCategory(input.category)) {
    return {
      owner_type: 'agent',
      recall_scope: isValidRecallScope(input.scope_hint) ? input.scope_hint : 'topic',
    };
  }

  if (isRuleCategory(input.category)) {
    const ownerType: MemoryOwnerType = input.source === 'system_defined' ? 'system' : 'user';
    const recallScope = isValidRecallScope(input.scope_hint)
      ? input.scope_hint
      : input.source === 'system_defined'
        ? 'global'
        : inferRuleScopeFromContent(input.content);
    return { owner_type: ownerType, recall_scope: recallScope };
  }

  return {
    owner_type: 'user',
    recall_scope: 'topic',
  };
}

export function resolveMemoryPlacement(memory: PlacementLike): MemoryPlacement {
  if (isValidOwnerType(memory.owner_type) && isValidRecallScope(memory.recall_scope)) {
    return {
      owner_type: memory.owner_type,
      recall_scope: memory.recall_scope,
    };
  }

  if (memory.category === 'agent_persona') {
    return { owner_type: 'agent', recall_scope: 'global' };
  }

  if (isAgentCategory(memory.category)) {
    return { owner_type: 'agent', recall_scope: 'topic' };
  }

  return { owner_type: 'user', recall_scope: 'topic' };
}

export function canMergeMemoryPlacements(
  existing: Pick<Memory, 'category' | 'owner_type' | 'recall_scope'>,
  incoming: Pick<PlacementHintInput, 'category'> & MemoryPlacement,
): boolean {
  const existingPlacement = resolveMemoryPlacement(existing);
  if (existingPlacement.owner_type !== incoming.owner_type) return false;
  if (existingPlacement.recall_scope !== incoming.recall_scope) return false;

  const existingFamily = getCategoryFamily(existing.category);
  const incomingFamily = getCategoryFamily(incoming.category);
  return existingFamily === incomingFamily;
}

import type { RecordKind } from './types.js';

export type V2ContractCanonicalCase = {
  input: string;
  requested_kind: RecordKind;
  written_kind: RecordKind;
  attribute_key?: string;
  state_key?: string;
  relation_predicate?: string | null;
  output: string;
};

export type AtomicContractDecision = {
  requested_kind: RecordKind;
  attribute_key?: string;
  state_key?: string;
  relation_predicate?: string | null;
  speculative: boolean;
};

export const V2_CONTRACT_CANONICAL_CASES: V2ContractCanonicalCase[] = [
  {
    input: '我住大阪',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: '请用中文回答',
    requested_kind: 'profile_rule',
    written_kind: 'profile_rule',
    attribute_key: 'language_preference',
    relation_predicate: null,
    output: 'profile_rule(subject_key=user, attribute_key=language_preference)',
  },
  {
    input: '请把回答控制在三句话内',
    requested_kind: 'profile_rule',
    written_kind: 'profile_rule',
    attribute_key: 'response_length',
    relation_predicate: null,
    output: 'profile_rule(subject_key=user, attribute_key=response_length)',
  },
  {
    input: '不要复杂方案',
    requested_kind: 'profile_rule',
    written_kind: 'profile_rule',
    attribute_key: 'solution_complexity',
    relation_predicate: null,
    output: 'profile_rule(subject_key=user, attribute_key=solution_complexity)',
  },
  {
    input: '我在 OpenAI 工作',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: '当前任务是重构 Cortex recall',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    state_key: 'refactor_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=refactor_status)',
  },
  {
    input: '最近也许会考虑换方案',
    requested_kind: 'session_note',
    written_kind: 'session_note',
    relation_predicate: null,
    output: 'session_note',
  },
];

export const V2_CONTRACT_REFERENCE_EXAMPLES: Array<{ input: string; output: string }> = V2_CONTRACT_CANONICAL_CASES.map(
  ({ input, output }) => ({ input, output }),
);

const SPECULATIVE_CONTENT_RE = /(?:也许|可能|maybe|might|perhaps|考虑|看情况|大概|probably)/i;
const FACT_SLOT_RELATION_PREDICATES: Record<string, string> = {
  location: 'lives_in',
  organization: 'works_at',
  occupation: 'has_role',
  relationship: 'related_to',
  skill: 'has_skill',
};

export function isSpeculativeContent(content: string): boolean {
  return SPECULATIVE_CONTENT_RE.test(content);
}

function matchProfileRuleAttribute(content: string, ownerScope: 'user' | 'agent'): string | null {
  if (ownerScope === 'agent') {
    if (/(?:answer|respond|reply|回答|回复)/i.test(content) || /(?:style|tone|persona|风格|人设)/i.test(content)) {
      return 'persona_style';
    }
    return 'persona_rule';
  }

  if (/我叫|我的名字|my name is|call me/i.test(content)) return 'display_name';
  if (
    /(?:请|用|prefer|preferably|answer|respond|reply|回答|回复).*(中文|英文|日文|english|chinese|japanese)/i.test(content) ||
    /(中文|英文|日文|english|chinese|japanese).*(回答|回复|answer|respond)/i.test(content)
  ) {
    return 'language_preference';
  }
  if (
    /(?:简洁|简短|精简|直接|concise|brief|short|direct).*(回答|回复|answer|response|解释)/i.test(content) ||
    /(回答|回复|answer|response).*(简洁|简短|精简|直接|concise|brief|short|direct)/i.test(content)
  ) {
    return 'response_style';
  }
  if (
    /(?:控制|限制|保持|压缩).{0,12}(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:内|以内)?/i.test(content) ||
    /(?:within|in)\s+(?:one|two|three|four|five|\d+)\s+sentences?/i.test(content) ||
    /(?:一句话|两句话|三句话|四句话|\d+句(?:话)?).*(?:回答|回复|answer|response)/i.test(content) ||
    /(?:不要|别|avoid|no|not).*(长篇|冗长|verbose|long).*(解释|说明|answer|response)/i.test(content) ||
    /(?:详细|长篇|verbose|long).*(解释|说明|answer|response)/i.test(content)
  ) {
    return 'response_length';
  }
  if (
    /(?:简单|轻量|零配置|simple|lightweight|low maintenance).*(部署|方案|实现|deployment|solution|setup)/i.test(content) ||
    /(?:复杂|complex).*(部署|方案|实现|deployment|solution|setup)/i.test(content)
  ) {
    return 'solution_complexity';
  }
  if (/(低风险|高风险|risk tolerance|risk profile)/i.test(content)) return 'risk_tolerance';
  return null;
}

function matchFactSlotAttribute(content: string): string | null {
  if (/(?:我|用户)?住(?:在)?|live(?:s|d)? in|living in|based in|located in|位于|来自|from/i.test(content)) return 'location';
  if (/我在.+工作|i work (?:at|for|in)|works? at/i.test(content)) return 'organization';
  if (/我是.+(?:工程师|开发者|设计师|学生|老师|医生|研究员)|i(?:'m| am) (?:a |an )?(?:developer|engineer|designer|student|teacher|doctor|researcher)/i.test(content)) {
    return 'occupation';
  }
  if (/我会|擅长|熟悉|skill|capability|experienced in|good at/i.test(content)) return 'skill';
  if (/朋友|同事|老板|导师|partner|friend|colleague|boss|mentor/i.test(content)) return 'relationship';
  return null;
}

function matchTaskStateKey(content: string): string | null {
  if (/重构|rewrite|refactor/i.test(content)) return 'refactor_status';
  if (/部署|deploy|deployment/i.test(content)) return 'deployment_status';
  if (/迁移|migrate|migration/i.test(content)) return 'migration_status';
  if (/待办|todo|remind me|记得|别忘了/i.test(content)) return 'open_todo';
  if (/决定|decided|final decision|choose|就这样吧/i.test(content)) return 'current_decision';
  if (/目标|计划|goal|plan to|打算|想要/i.test(content)) return 'current_goal';
  if (/项目|project|状态|status/i.test(content)) return 'project_status';
  return null;
}

export function relationPredicateForFactAttribute(attributeKey?: string | null): string | null {
  if (!attributeKey) return null;
  return FACT_SLOT_RELATION_PREDICATES[attributeKey] || null;
}

export function resolveAtomicContractDecision(content: string, ownerScope: 'user' | 'agent' = 'user'): AtomicContractDecision {
  if (isSpeculativeContent(content)) {
    return {
      requested_kind: 'session_note',
      relation_predicate: null,
      speculative: true,
    };
  }

  const profileAttribute = matchProfileRuleAttribute(content, ownerScope);
  if (profileAttribute) {
    return {
      requested_kind: 'profile_rule',
      attribute_key: profileAttribute,
      relation_predicate: null,
      speculative: false,
    };
  }

  const factAttribute = matchFactSlotAttribute(content);
  if (factAttribute) {
    return {
      requested_kind: 'fact_slot',
      attribute_key: factAttribute,
      relation_predicate: relationPredicateForFactAttribute(factAttribute),
      speculative: false,
    };
  }

  const taskStateKey = matchTaskStateKey(content);
  if (taskStateKey) {
    return {
      requested_kind: 'task_state',
      state_key: taskStateKey,
      relation_predicate: null,
      speculative: false,
    };
  }

  return {
    requested_kind: 'session_note',
    relation_predicate: null,
    speculative: false,
  };
}

export function inferProfileRuleAttribute(content: string, ownerScope: 'user' | 'agent'): string | null {
  const decision = resolveAtomicContractDecision(content, ownerScope);
  return decision.requested_kind === 'profile_rule' ? decision.attribute_key || null : null;
}

export function inferFactSlotAttribute(content: string): string | null {
  const decision = resolveAtomicContractDecision(content);
  return decision.requested_kind === 'fact_slot' ? decision.attribute_key || null : null;
}

export function inferTaskStateKey(content: string): string | null {
  const decision = resolveAtomicContractDecision(content);
  return decision.requested_kind === 'task_state' ? decision.state_key || null : null;
}

export function inferRequestedKindFromContent(content: string): RecordKind {
  return resolveAtomicContractDecision(content).requested_kind;
}

export function shouldApplyRequestedKindHint(content: string, requestedKind?: RecordKind): boolean {
  if (!requestedKind) return false;
  if (requestedKind === 'session_note') return true;
  if (resolveAtomicContractDecision(content).speculative) return false;

  const userDecision = resolveAtomicContractDecision(content, 'user');
  const agentDecision = requestedKind === 'profile_rule'
    ? resolveAtomicContractDecision(content, 'agent')
    : null;

  switch (requestedKind) {
    case 'profile_rule':
      return userDecision.requested_kind === 'profile_rule' || agentDecision?.requested_kind === 'profile_rule';
    case 'fact_slot':
      return userDecision.requested_kind === 'fact_slot';
    case 'task_state':
      return userDecision.requested_kind === 'task_state';
  }
}

export function canDeriveRelationCandidate(kind: RecordKind, attributeKey?: string | null): boolean {
  return kind === 'fact_slot' && relationPredicateForFactAttribute(attributeKey) !== null;
}

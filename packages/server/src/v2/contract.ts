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

export type CanonicalRecordContentInput = {
  kind: Exclude<RecordKind, 'session_note'>;
  content: string;
  owner_scope?: 'user' | 'agent';
  subject_key?: string | null;
  entity_key?: string | null;
  attribute_key?: string | null;
  state_key?: string | null;
};

export type ShortUserProposalRewrite = {
  synthesized_content: string;
};

export type ShortUserProposalSelection = {
  keep_profile_rule_attributes: string[];
  drop_profile_rule_attributes: string[];
  drop_all: boolean;
};

export type ConversationalProfileRuleMatch = {
  attribute_key: 'language_preference' | 'response_length' | 'solution_complexity';
  canonical_content: string;
  disposition: 'auto_commit';
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
    input: '后续交流中文就行',
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
    input: '三句话内就行',
    requested_kind: 'profile_rule',
    written_kind: 'profile_rule',
    attribute_key: 'response_length',
    relation_predicate: null,
    output: 'profile_rule(subject_key=user, attribute_key=response_length)',
  },
  {
    input: '三句就够',
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
    input: '别整复杂方案',
    requested_kind: 'profile_rule',
    written_kind: 'profile_rule',
    attribute_key: 'solution_complexity',
    relation_predicate: null,
    output: 'profile_rule(subject_key=user, attribute_key=solution_complexity)',
  },
  {
    input: '方案简单点',
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
    input: '现在住东京',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: '目前位于东京',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: '现在在 OpenAI 工作',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: '目前任职于 OpenAI',
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
const CLAUSE_BOUNDARY_RE = /[。！？.!?;；]+/;
const LANGUAGE_LABEL_RE = /(中文|英文|日文|english|chinese|japanese)/i;
const ZH_SENTENCE_RE = /((?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?)(?:内|以内)?/i;
const EN_SENTENCE_RE = /(?:within|in|under|limit(?:ed)? to|keep(?: answers?)?(?: within)?|answer in)?\s*((?:one|two|three|four|five|six|seven|eight|nine|ten|\d+))\s+sentences?(?:\s*(?:max|maximum))?/i;
const CONVERSATIONAL_PROFILE_RULE_HEDGE_RE = /(?:就行吧|就好吧|即可吧|够(?:了)?吧|更好|最好)/i;
const SHORT_USER_CONFIRMATION_RE = /^(?:好(?:的)?|行|可以|没问题|收到|确认|同意|ok(?:ay)?)(?:[，,、 ]*(?:就这么定|就这样(?:吧)?|按这个来|按这个办|照这个来|这么办|定了))?$|^(?:就这么定|就这样(?:吧)?|按这个来|按这个办|照这个来|这么办|定了)$/i;
const SHORT_USER_REJECTION_RE = /^(?:不(?:要|用)?|先别|别这样|不是这个|换一个|换种|先别这样吧)(?:[，,、 ]*(?:吧|了|这个|这种|那样))?$/i;
const SHORT_USER_LANGUAGE_REWRITE_RE = /(?:改成|换成|改为|换为|改用|换用|用)\s*(中文|英文|日文|english|chinese|japanese)/i;
const SHORT_USER_RESPONSE_LENGTH_REWRITE_RE = /(?:改成|换成|改为|换为|控制在|限制在)\s*((?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:内|以内)?)/i;
const SHORT_USER_DISAGREEMENT_PREFIX_RE = /^(?:不(?:是)?|别|先别|不要|不用)[，,、 ]*/i;
const SHORT_USER_DROP_ALL_RE = /^(?:都不要|全都不要|都别要|都别加|都去掉|都删掉)$/i;
const ASSISTANT_PROPOSAL_CONJUNCTION_RE = /[，,]\s*(?:并(?:且)?|以及|and\b)\s*/i;
const FACT_SLOT_RELATION_PREDICATES: Record<string, string> = {
  location: 'lives_in',
  organization: 'works_at',
  occupation: 'has_role',
  relationship: 'related_to',
  skill: 'has_skill',
};

function matchRelationObjectValue(content: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  const fallback = content.trim();
  return fallback || null;
}

function stripBulletPrefix(line: string): string {
  return line.replace(/^(?:[-*+]|\d+\.)\s+/, '');
}

export function isSpeculativeContent(content: string): boolean {
  return SPECULATIVE_CONTENT_RE.test(content);
}

export function canonicalLanguageLabel(raw: string | null | undefined): '中文' | '英文' | '日文' | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized.includes('中文') || normalized.includes('chinese')) return '中文';
  if (normalized.includes('英文') || normalized.includes('english')) return '英文';
  if (normalized.includes('日文') || normalized.includes('japanese') || normalized.includes('日本語')) return '日文';
  return null;
}

function canonicalSentenceCount(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  return compact.replace(/句$/, '句话');
}

function detectContentLocale(content: string): 'zh' | 'en' | 'ja' | null {
  if (/[\u3040-\u30ff]/.test(content)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(content)) return 'zh';
  if (/[A-Za-z]/.test(content)) return 'en';
  return null;
}

export function extractSentenceCountConstraint(raw: string): string | null {
  const zhMatch = raw.match(ZH_SENTENCE_RE);
  if (zhMatch?.[1]) return canonicalSentenceCount(zhMatch[1]);

  const enMatch = raw.match(EN_SENTENCE_RE);
  return enMatch?.[1]?.trim() || null;
}

function languageTemplate(label: '中文' | '英文' | '日文'): string {
  switch (label) {
    case '英文':
      return 'Please answer in English';
    case '日文':
      return '日本語で答えてください';
    case '中文':
    default:
      return '请用中文回答';
  }
}

function canonicalProfileRuleContent(attributeKey: string, content: string, ownerScope: 'user' | 'agent' = 'user'): string | null {
  if (ownerScope !== 'user') return null;

  if (attributeKey === 'language_preference') {
    const label = canonicalLanguageLabel(content);
    return label ? languageTemplate(label) : null;
  }

  if (attributeKey === 'response_length') {
    const phrase = extractSentenceCountConstraint(content);
    if (phrase) {
      if (detectContentLocale(content) === 'en' && /^[A-Za-z0-9 ]+$/.test(phrase)) {
        return `Please keep answers within ${phrase} sentences`;
      }
      return `请把回答控制在${phrase}内`;
    }
    return null;
  }

  if (attributeKey === 'solution_complexity') {
    if (/(?:不要复杂方案|别太复杂|别搞太复杂|别整复杂方案|方案简单点|简单点|轻量点|simple solution|keep it simple|lightweight solution|avoid complex)/i.test(content)) {
      return /[A-Za-z]/.test(content) ? 'Please avoid complex solutions' : '不要复杂方案';
    }
  }

  return null;
}

export function isWeakConversationalProfileRule(content: string): boolean {
  return isSpeculativeContent(content) || CONVERSATIONAL_PROFILE_RULE_HEDGE_RE.test(content);
}

export function matchConversationalProfileRule(content: string): ConversationalProfileRuleMatch | null {
  if (isWeakConversationalProfileRule(content)) return null;

  const normalized = content.trim();
  if (!normalized) return null;

  const languageLabel = canonicalLanguageLabel(normalized);
  if (
    languageLabel &&
    (
      /(?:后续|之后|后面|接下来|以后).{0,8}(?:交流|沟通|聊|都用|用)/i.test(normalized) ||
      /(?:都用|改用|换用|用).{0,8}(?:中文|英文|日文|english|chinese|japanese)/i.test(normalized) ||
      /(?:中文|英文|日文|english|chinese|japanese).{0,8}(?:就行|即可|就好)/i.test(normalized)
    )
  ) {
    const canonicalContent = canonicalProfileRuleContent('language_preference', normalized);
    if (canonicalContent) {
      return {
        attribute_key: 'language_preference',
        canonical_content: canonicalContent,
        disposition: 'auto_commit',
      };
    }
  }

  if (
    extractSentenceCountConstraint(normalized) &&
    (
      /(?:就行|即可|就好|够(?:了)?|别太长|不要太长)/i.test(normalized) ||
      /(?:控制|限制).{0,12}(?:句|sentences?)/i.test(normalized) ||
      /(?:回答|回复|answer|response).{0,12}(?:句|sentences?)/i.test(normalized)
    )
  ) {
    const canonicalContent = canonicalProfileRuleContent('response_length', normalized);
    if (canonicalContent) {
      return {
        attribute_key: 'response_length',
        canonical_content: canonicalContent,
        disposition: 'auto_commit',
      };
    }
  }

  if (/(?:方案简单点|简单点|轻量点|别搞太复杂|别整复杂方案|别太复杂|不要复杂方案|keep it simple|avoid complex|lightweight solution|simple solution)/i.test(normalized)) {
    const canonicalContent = canonicalProfileRuleContent('solution_complexity', normalized);
    if (canonicalContent) {
      return {
        attribute_key: 'solution_complexity',
        canonical_content: canonicalContent,
        disposition: 'auto_commit',
      };
    }
  }

  return null;
}

function canonicalFactSlotContent(attributeKey: string, content: string, entityKey?: string | null): string | null {
  if (entityKey && entityKey !== 'user') return null;

  const value = extractFactRelationObjectValue(attributeKey, content)?.trim();
  if (!value) return null;
  const locale = detectContentLocale(content);

  if (attributeKey === 'location') {
    return locale === 'en' ? `I live in ${value}` : `我住${value}`;
  }

  if (attributeKey === 'organization') {
    return locale === 'en' ? `I work at ${value}` : `我在 ${value} 工作`;
  }

  return null;
}

function canonicalTaskStateContent(stateKey: string, content: string, subjectKey?: string | null): string | null {
  if (subjectKey && subjectKey !== 'cortex') return null;
  if (stateKey !== 'refactor_status') return null;
  if (!/cortex/i.test(content) || !/recall/i.test(content) || !/(?:重构|refactor)/i.test(content)) return null;
  return '当前任务是重构 Cortex recall';
}

export function canonicalizeDurableContent(input: CanonicalRecordContentInput): string | null {
  switch (input.kind) {
    case 'profile_rule':
      return input.attribute_key
        ? canonicalProfileRuleContent(input.attribute_key, input.content, input.owner_scope)
        : null;
    case 'fact_slot':
      return input.attribute_key
        ? canonicalFactSlotContent(input.attribute_key, input.content, input.entity_key)
        : null;
    case 'task_state':
      return input.state_key
        ? canonicalTaskStateContent(input.state_key, input.content, input.subject_key)
        : null;
  }
}

export function isShortUserConfirmation(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 16) return false;
  return SHORT_USER_CONFIRMATION_RE.test(trimmed);
}

function stripShortUserDisagreementPrefix(content: string): string {
  return content.replace(SHORT_USER_DISAGREEMENT_PREFIX_RE, '').trim();
}

function mentionsLanguagePreference(content: string): boolean {
  return /(中文|英文|日文|english|chinese|japanese)/i.test(content);
}

function mentionsResponseLength(content: string): boolean {
  return /(?:(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:限制|内|以内)?|句数限制|长度限制)/i.test(content);
}

function dropsLanguagePreference(content: string): boolean {
  return /(?:别|不要|别用|取消|去掉|删掉).{0,8}(?:中文|英文|日文|english|chinese|japanese)/i.test(content);
}

function dropsResponseLength(content: string): boolean {
  return /(?:别|不要|别加|取消|去掉|删掉).{0,10}(?:(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:限制|内|以内)?|句数|长度限制)/i.test(content);
}

export function inferShortUserProposalRewrite(content: string): ShortUserProposalRewrite | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 20) return null;
  const normalized = stripShortUserDisagreementPrefix(trimmed) || trimmed;

  const languageMatch = normalized.match(SHORT_USER_LANGUAGE_REWRITE_RE);
  if (languageMatch?.[1]) {
    const label = canonicalLanguageLabel(languageMatch[1]);
    if (label) {
      return {
        synthesized_content: `请用${label}回答`,
      };
    }
  }

  const responseLengthMatch = normalized.match(SHORT_USER_RESPONSE_LENGTH_REWRITE_RE);
  if (responseLengthMatch?.[1]) {
    return {
      synthesized_content: `请把回答控制在${canonicalSentenceCount(responseLengthMatch[1])}`,
    };
  }

  return null;
}

export function inferShortUserProposalSelection(content: string): ShortUserProposalSelection | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return null;
  if (SHORT_USER_DROP_ALL_RE.test(trimmed)) {
    return {
      keep_profile_rule_attributes: [],
      drop_profile_rule_attributes: [],
      drop_all: true,
    };
  }

  const keep = new Set<string>();
  const drop = new Set<string>();

  if (dropsLanguagePreference(trimmed)) {
    drop.add('language_preference');
  } else if (mentionsLanguagePreference(trimmed)) {
    keep.add('language_preference');
  }

  if (dropsResponseLength(trimmed)) {
    drop.add('response_length');
  } else if (mentionsResponseLength(trimmed)) {
    keep.add('response_length');
  }

  if (keep.size === 0 && drop.size === 0) return null;

  return {
    keep_profile_rule_attributes: Array.from(keep),
    drop_profile_rule_attributes: Array.from(drop),
    drop_all: false,
  };
}

export function isShortUserProposalRejection(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 16) return false;
  if (SHORT_USER_REJECTION_RE.test(trimmed)) return true;
  const normalized = stripShortUserDisagreementPrefix(trimmed);
  return normalized.length > 0 && SHORT_USER_REJECTION_RE.test(normalized);
}

export function splitAssistantProposalClauses(content: string): string[] {
  const baseClauses = splitCompoundClauses(content);
  const clauses: string[] = [];

  for (const clause of baseClauses) {
    const parts = clause
      .split(ASSISTANT_PROPOSAL_CONJUNCTION_RE)
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length > 0) clauses.push(...parts);
  }

  return clauses;
}

export function splitCompoundClauses(content: string): string[] {
  const clauses: string[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');

  for (const rawLine of lines) {
    const normalizedLine = stripBulletPrefix(rawLine.trim());
    if (!normalizedLine) continue;

    const parts = normalizedLine
      .split(CLAUSE_BOUNDARY_RE)
      .map(part => part.trim())
      .filter(Boolean);

    if (parts.length > 0) {
      clauses.push(...parts);
    }
  }

  return clauses;
}

function matchProfileRuleAttribute(content: string, ownerScope: 'user' | 'agent'): string | null {
  if (ownerScope === 'agent') {
    if (/(?:answer|respond|reply|回答|回复)/i.test(content) || /(?:style|tone|persona|风格|人设)/i.test(content)) {
      return 'persona_style';
    }
    return 'persona_rule';
  }

  const conversationalMatch = matchConversationalProfileRule(content);
  if (conversationalMatch) return conversationalMatch.attribute_key;
  if (isWeakConversationalProfileRule(content)) return null;

  if (/我叫|我的名字|my name is|call me/i.test(content)) return 'display_name';
  if (
    /(?:请|用|prefer|preferably|answer|respond|reply|回答|回复).*(中文|英文|日文|english|chinese|japanese)/i.test(content) ||
    /(中文|英文|日文|english|chinese|japanese).*(回答|回复|answer|respond)/i.test(content) ||
    (
      LANGUAGE_LABEL_RE.test(content) &&
      /(?:交流|沟通|聊|后续|之后|后面|接下来|以后|都用|就行|即可|就好)/i.test(content)
    )
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
    /(?:详细|长篇|verbose|long).*(解释|说明|answer|response)/i.test(content) ||
    (
      ZH_SENTENCE_RE.test(content) &&
      /(?:就行|即可|就好|够(?:了)?|别太长|不要太长|回答|回复|answer|response)/i.test(content)
    )
  ) {
    return 'response_length';
  }
  if (
    /(?:简单|轻量|零配置|simple|lightweight|low maintenance).*(部署|方案|实现|deployment|solution|setup)/i.test(content) ||
    /(?:复杂|complex).*(部署|方案|实现|deployment|solution|setup)/i.test(content) ||
    /(?:方案|实现|solution|setup).*(?:简单|轻量|simple|lightweight)/i.test(content) ||
    /(?:别搞太复杂|别整复杂方案|别太复杂|keep it simple|avoid complex)/i.test(content)
  ) {
    return 'solution_complexity';
  }
  if (/(低风险|高风险|risk tolerance|risk profile)/i.test(content)) return 'risk_tolerance';
  return null;
}

function matchFactSlotAttribute(content: string): string | null {
  if (/(?:我|用户)?住(?:在)?|live(?:s|d)? in|living in|based in|located in|位于|来自|from/i.test(content)) return 'location';
  if (/(?:我|用户)?在.+工作|(?:现在|目前|如今)?在.+工作|任职于|就职于|供职于|i work (?:at|for|in)|works? at/i.test(content)) return 'organization';
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

export function extractFactRelationObjectValue(attributeKey: string | null | undefined, content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  switch (attributeKey) {
    case 'location':
      return matchRelationObjectValue(trimmed, [
        /(?:现在|目前|如今|currently|now)\s*(?:我|用户)?住(?:在)?\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /(?:我|用户)?住(?:在)?\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /\blive(?:s|d|ing)?\s+in\s+([a-z0-9_\- ]+)/i,
        /\bbased in\s+([a-z0-9_\- ]+)/i,
        /\bfrom\s+([a-z0-9_\- ]+)/i,
        /来自\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /位于\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
      ]);
    case 'organization':
      return matchRelationObjectValue(trimmed, [
        /(?:现在|目前|如今)?在\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*工作/i,
        /(?:我|用户)?在\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*工作/i,
        /(?:现在|目前|如今)?(?:任职于|就职于|供职于)\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /(?:我|用户)?(?:任职于|就职于|供职于)\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /\bwork(?:s|ed|ing)?\s+(?:at|for|in)\s+([a-z0-9_\- ]+)/i,
      ]);
    case 'occupation':
      return matchRelationObjectValue(trimmed, [
        /(?:我|用户)?是\s*(.+)$/i,
        /\bi(?:'m| am)\s+(?:a |an )?(.+)$/i,
      ]);
    case 'relationship':
    case 'skill':
      return trimmed;
    default:
      return null;
  }
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

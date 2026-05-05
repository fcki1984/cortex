import type { RecordKind } from './types.js';

export type V2ContractCanonicalCase = {
  input: string;
  requested_kind: RecordKind;
  written_kind: RecordKind;
  disposition?: 'auto_commit' | 'review';
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

export type ShortUserFactSelection = {
  keep_fact_attributes: Array<'location' | 'organization'>;
  drop_fact_attributes: Array<'location' | 'organization'>;
  drop_all: boolean;
};

export type ShortUserTaskSelection = {
  keep_current_task: boolean;
};

export type ConversationalProfileRuleDisposition = 'auto_commit' | 'review';

export type ConversationalProfileRuleMatch = {
  attribute_key: 'language_preference' | 'response_length' | 'solution_complexity' | 'response_style';
  canonical_content: string;
  disposition: ConversationalProfileRuleDisposition;
};

export type V2ContractProfileRuleAliasSet = {
  attribute_key: ConversationalProfileRuleMatch['attribute_key'];
  canonical_content: string;
  disposition: ConversationalProfileRuleDisposition;
  strong_inputs: string[];
  weak_inputs: string[];
};

type InternalProfileRuleAliasSpec = V2ContractProfileRuleAliasSet & {
  matches_conversational: (content: string) => boolean;
  matches_attribute: (content: string) => boolean;
};

function matchesAnchoredConversationalResponseStyle(
  content: string,
  descriptors: '直接|干脆|利索|利落' | '干脆|利索|利落',
): boolean {
  return new RegExp(
    `^(?:请)?(?:(?:说话|表达|讲|说)(?:得)?)\\s*.{0,4}(?:${descriptors})(?:(?:一)?点|一些|些)?$`,
    'i',
  ).test(content.trim());
}

function matchesAnchoredEnglishExplicitResponseStyle(content: string): boolean {
  const trimmed = content.trim();
  return (
    /^(?:please\s+)?be\s+(?:more\s+)?(?:concise|brief)\s+and\s+(?:direct|directly)$/i.test(trimmed) ||
    /^(?:please\s+)?keep\s+(?:answers?|replies?|responses?)\s+(?:concise|brief)\s+and\s+(?:direct|directly)$/i.test(trimmed) ||
    /^(?:please\s+)?(?:reply|respond)\s+(?:more\s+)?(?:concisely|briefly)\s+and\s+directly$/i.test(trimmed) ||
    /^(?:please\s+)?(?:reply|respond)\s+(?:more\s+)?directly\s+and\s+(?:concisely|briefly)$/i.test(trimmed)
  );
}

function matchesAnchoredEnglishReviewResponseStyle(content: string): boolean {
  const trimmed = content.trim();
  return (
    /^(?:please\s+)?be\s+(?:more\s+)?direct$/i.test(trimmed) ||
    /^(?:please\s+)?(?:reply|respond)\s+(?:more\s+)?directly$/i.test(trimmed)
  );
}

function matchesCanonicalResponseStyle(content: string): boolean {
  return (
    matchesAnchoredConversationalResponseStyle(content, '直接|干脆|利索|利落') ||
    matchesAnchoredEnglishExplicitResponseStyle(content) ||
    matchesAnchoredEnglishReviewResponseStyle(content) ||
    matchesExplicitCanonicalResponseStyle(content) ||
    /(?:说话|表达).*(?:干脆|直接|简洁|简短|精简|利索|利落)/i.test(content) ||
    /(?:干脆|直接|简洁|简短|精简|利索|利落).*(?:说话|表达)/i.test(content)
  );
}

const CORTEX_REFACTOR_KEYWORD_RE = /(?:重构|refactor(?:ing)?|rewrit(?:e|ing))/i;
const CORTEX_DEPLOYMENT_KEYWORD_RE = /(?:部署|deploy(?:ment|ing)?)/i;
const CORTEX_MIGRATION_KEYWORD_RE = /(?:迁移|migrat(?:e|ion|ing))/i;

function matchesExplicitCanonicalResponseStyle(content: string): boolean {
  return (
    matchesAnchoredConversationalResponseStyle(content, '干脆|利索|利落') ||
    matchesAnchoredEnglishExplicitResponseStyle(content) ||
    /^(?:请)?(?:说话|表达).{0,4}(?:干脆|利索|利落)(?:(?:一)?点|一些|些)?$/i.test(content.trim()) ||
    (
      /(?:直接|干脆|利索|利落)/i.test(content) &&
      /(?:回答|回复|风格|answer|reply|response|style)/i.test(content)
    ) ||
    /^(?:请)?(?:回答|回复|表达|风格|说话)?(?:保持)?(?:更)?(?:简洁|简短|精简).*(?:直接|干脆|利索|利落)(?:一点|一些|些)?$/i.test(content.trim()) ||
    /^(?:请)?(?:回答|回复|表达|风格|说话)?(?:保持)?(?:更)?(?:直接|干脆|利索|利落).*(?:简洁|简短|精简)(?:一点|一些|些)?$/i.test(content.trim()) ||
    /(?:简洁|简短|精简).*(?:直接|干脆|利索|利落).*(?:回答|回复|风格)?/i.test(content) ||
    /(?:回答|回复|风格).*(?:简洁|简短|精简).*(?:直接|干脆|利索|利落)/i.test(content) ||
    (
      /(?:answer|reply|response|style)/i.test(content) &&
      /(?:concise|brief)/i.test(content) &&
      /direct/i.test(content)
    ) ||
    (
      /(?:respond|reply)/i.test(content) &&
      /(?:concise|brief)/i.test(content) &&
      /direct/i.test(content)
    )
  );
}

function matchesResponseStyleAttribute(content: string): boolean {
  return (
    /(?:简洁|简短|精简|直接|利索|利落|concise|brief|short|direct).*(回答|回复|answer|response|解释)/i.test(content) ||
    /(回答|回复|answer|response).*(简洁|简短|精简|直接|利索|利落|concise|brief|short|direct)/i.test(content) ||
    matchesCanonicalResponseStyle(content)
  );
}

export function matchesConversationalLocationFact(content: string): boolean {
  return /(?:人(?:在)?|我(?:现在|目前)?在)\s*([\u4e00-\u9fff]{1,12})(?:这边|那边)/i.test(content);
}

export function matchesColloquialRecallRefactorTask(content: string): boolean {
  return /(?:先(?:收|看|处理|搞)(?:一下|下)?|先把).{0,12}\brecall\b.{0,8}(?:那块|这块|这边)?/i.test(content);
}

export function matchesExplicitEnglishRecallRefactorTask(content: string): boolean {
  return /^current task is recall (?:refactor|rewrite)$/i.test(content.trim());
}

export function matchesColloquialCortexWorkflowTask(
  content: string,
  stateKey: 'deployment_status' | 'migration_status',
): boolean {
  if (stateKey === 'deployment_status') {
    return /^(?:先(?:做|搞|跑|处理)?(?:一下|下)?\s*)?(?:部署|deploy(?:ment|ing)?)(?:一下|下)?$/i.test(content.trim());
  }

  return /^(?:先(?:做|搞|跑|处理)?(?:一下|下)?\s*)?(?:迁移|migrat(?:e|ion|ing))(?:一下|下)?$/i.test(content.trim());
}

export function matchesImplicitCortexTaskSubject(content: string): boolean {
  return (
    matchesColloquialRecallRefactorTask(content) ||
    matchesExplicitEnglishRecallRefactorTask(content) ||
    matchesColloquialCortexWorkflowTask(content, 'deployment_status') ||
    matchesColloquialCortexWorkflowTask(content, 'migration_status')
  );
}

const PROFILE_RULE_ALIAS_SPECS: InternalProfileRuleAliasSpec[] = [
  {
    attribute_key: 'language_preference',
    canonical_content: '请用中文回答',
    disposition: 'auto_commit',
    strong_inputs: [
      '请用中文回答',
      '后续交流中文就行',
      '以后都中文回答',
      '后面中文就可以',
      '之后都用中文',
      '后面都用中文',
      '后面都说中文',
      '之后都讲中文',
      '中文就可以',
      '中文就行',
      '中文即可',
      '中文就好',
    ],
    weak_inputs: [
      '中文就行吧',
      '以后都中文回答就行吧',
      '尽量用中文',
      '优先用中文回答',
      '中文就可以吧',
      '中文即可吧',
      '中文就好吧',
      '后面中文就可以吧',
    ],
    matches_conversational: (content: string) => {
      const languageLabel = canonicalLanguageLabel(content);
      if (!languageLabel) return false;
      return (
        /(?:后续|之后|后面|接下来|以后).{0,8}(?:交流|沟通|聊|都用|用|回答|回复|都说|说|都讲|讲)/i.test(content) ||
        /(?:都用|改用|换用|用).{0,8}(?:中文|英文|日文|english|chinese|japanese)/i.test(content) ||
        /(?:中文|英文|日文|english|chinese|japanese).{0,8}(?:就行|即可|就好|就可以)/i.test(content)
      );
    },
    matches_attribute: (content: string) => (
      /(?:请|用|prefer|preferably|answer|respond|reply|回答|回复).*(中文|英文|日文|english|chinese|japanese)/i.test(content) ||
      /(中文|英文|日文|english|chinese|japanese).*(回答|回复|answer|respond)/i.test(content) ||
      (
        LANGUAGE_LABEL_RE.test(content) &&
        /(?:交流|沟通|聊|后续|之后|后面|接下来|以后|都用|就行|即可|就好)/i.test(content)
      )
    ),
  },
  {
    attribute_key: 'language_preference',
    canonical_content: '日本語で答えてください',
    disposition: 'auto_commit',
    strong_inputs: [
      '日本語で答えて',
      '日本語で答えてください',
    ],
    weak_inputs: [],
    matches_conversational: (content: string) => /日本語で(?:答えて|答えてください|回答して|返答して)(?:ください)?/iu.test(content),
    matches_attribute: (content: string) => /日本語で(?:答えて|答えてください|回答して|返答して)(?:ください)?/iu.test(content),
  },
  {
    attribute_key: 'language_preference',
    canonical_content: 'Please answer in English',
    disposition: 'auto_commit',
    strong_inputs: [
      'Use English from now on',
    ],
    weak_inputs: [],
    matches_conversational: (content: string) => (
      /(?:use|answer|respond|reply).{0,12}english.{0,12}(?:from now on|going forward|for future replies?|for future responses?)/i.test(content) ||
      /english.{0,12}(?:from now on|going forward).{0,12}(?:answer|reply|respond|use)/i.test(content)
    ),
    matches_attribute: (content: string) => (
      /(?:use|answer|respond|reply).{0,12}english.{0,12}(?:from now on|going forward|for future replies?|for future responses?)/i.test(content) ||
      /english.{0,12}(?:from now on|going forward).{0,12}(?:answer|reply|respond|use)/i.test(content)
    ),
  },
  {
    attribute_key: 'response_length',
    canonical_content: '请把回答控制在三句话内',
    disposition: 'auto_commit',
    strong_inputs: [
      '请把回答控制在三句话内',
      '控制在三句内',
      '三句话内就行',
      '三句就够',
      '最多三句话',
      '别超过三句话',
      '三句话内就可以',
      '三句话内即可',
      '三句话内就好',
    ],
    weak_inputs: [
      '三句就够了吧',
      '最多三句话更好',
      '别超过三句话更好',
      '尽量别超过三句话',
      '三句话内就可以吧',
      '三句话内即可吧',
      '三句话内就好吧',
    ],
    matches_conversational: (content: string) => (
      !!extractSentenceCountConstraint(content) &&
      (
        /(?:最多|至多|不超过).{0,12}(?:句|sentences?)/i.test(content) ||
        /(?:别超过|别超出|不要超过).{0,12}(?:句|sentences?)/i.test(content) ||
        /(?:就行|即可|就好|就可以|够(?:了)?|别太长|不要太长)/i.test(content) ||
        /(?:控制|限制).{0,12}(?:句|sentences?)/i.test(content) ||
        /(?:回答|回复|answer|response).{0,12}(?:句|sentences?)/i.test(content)
      )
    ),
    matches_attribute: (content: string) => (
      /(?:控制|限制|保持|压缩).{0,12}(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:内|以内)?/i.test(content) ||
      /(?:within|in)\s+(?:one|two|three|four|five|\d+)\s+sentences?/i.test(content) ||
      /(?:一句话|两句话|三句话|四句话|\d+句(?:话)?).*(?:回答|回复|answer|response)/i.test(content) ||
      /(?:不要|别|avoid|no|not).*(长篇|冗长|verbose|long).*(解释|说明|answer|response)/i.test(content) ||
      /(?:详细|长篇|verbose|long).*(解释|说明|answer|response)/i.test(content) ||
      (
        ZH_SENTENCE_RE.test(content) &&
        /(?:就行|即可|就好|就可以|够(?:了)?|别太长|不要太长|回答|回复|answer|response)/i.test(content)
      )
    ),
  },
  {
    attribute_key: 'response_length',
    canonical_content: 'Please keep answers within three sentences',
    disposition: 'auto_commit',
    strong_inputs: [
      'Three sentences max',
      'Keep answers under three sentences',
      'Please answer within three sentences',
      'Keep replies to three sentences',
    ],
    weak_inputs: [],
    matches_conversational: (content: string) => (
      /(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+sentences?\s+(?:max|maximum)/i.test(content)
      || /keep\s+(?:answers?|replies?|responses?)\s+(?:to|under|within)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+sentences?/i.test(content)
      || /(?:answer|reply|respond)\s+(?:within|in)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+sentences?/i.test(content)
    ),
    matches_attribute: (content: string) => (
      /(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+sentences?\s+(?:max|maximum)/i.test(content)
      || /keep\s+(?:answers?|replies?|responses?)\s+(?:to|under|within)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+sentences?/i.test(content)
      || /(?:answer|reply|respond)\s+(?:within|in)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+sentences?/i.test(content)
    ),
  },
  {
    attribute_key: 'solution_complexity',
    canonical_content: '不要复杂方案',
    disposition: 'auto_commit',
    strong_inputs: [
      '不要复杂方案',
      '别整复杂方案',
      '方案简单点',
      '方案尽量简单点',
      '简单方案就行',
      '简单方案即可',
      '轻量方案就行',
      '方案简单一点',
      '轻量方案即可',
      '方案简单一些',
      '方案轻量一点',
      '方案简单些',
      '简单方案就可以',
      '简单方案就好',
      '轻量方案就可以',
      '轻量方案就好',
    ],
    weak_inputs: [
      '尽量简单点',
      '优先简单点',
      '可能简单点更好',
      '方案简单些吧',
      '简单方案就行吧',
      '简单方案即可吧',
      '简单方案就可以吧',
      '简单方案就好吧',
      '轻量方案就行吧',
      '轻量方案就可以吧',
      '轻量方案就好吧',
    ],
    matches_conversational: (content: string) => (
      /(?:方案尽量简单点|方案简单点|方案简单一点|方案简单一些|方案简单些|方案轻量一点|简单点|轻量点|简单方案就行|简单方案即可|简单方案就好|简单方案就可以|轻量方案就行|轻量方案即可|轻量方案就好|轻量方案就可以|别搞太复杂|别整复杂方案|别太复杂|不要复杂方案)/i.test(content)
    ),
    matches_attribute: (content: string) => (
      /(?:简单|轻量|零配置|simple|lightweight|low maintenance).*(部署|方案|实现|deployment|solution|setup)/i.test(content) ||
      /(?:复杂|complex).*(部署|方案|实现|deployment|solution|setup)/i.test(content) ||
      /(?:方案|实现|solution|setup).*(?:简单|轻量|simple|lightweight)/i.test(content) ||
      /(?:别搞太复杂|别整复杂方案|别太复杂|简单方案就好|轻量方案就好|keep it simple|avoid complex)/i.test(content)
    ),
  },
  {
    attribute_key: 'solution_complexity',
    canonical_content: 'Please avoid complex solutions',
    disposition: 'auto_commit',
    strong_inputs: [
      'Keep it simple',
      'Use a simple approach',
      'Use the simplest approach',
      'Keep the approach lightweight',
      "Don't make it too complex",
    ],
    weak_inputs: [],
    matches_conversational: (content: string) => (
      /(?:(?:please\s+)?use the simplest approach|keep (?:the )?approach lightweight|keep it simple|avoid complex solutions?|use a simple approach|don't make (?:it|things|the approach|the solution) too complex)/i.test(content)
    ),
    matches_attribute: (content: string) => (
      /(?:(?:please\s+)?use the simplest approach|keep (?:the )?approach lightweight|keep it simple|avoid complex solutions?|use a simple approach|don't make (?:it|things|the approach|the solution) too complex)/i.test(content)
    ),
  },
  {
    attribute_key: 'response_style',
    canonical_content: '请简洁直接回答',
    disposition: 'auto_commit',
    strong_inputs: [
      '请简洁直接回答',
      '回答简洁直接',
      '回答风格简洁直接',
      '回复风格简洁直接',
      '简洁直接一点',
      '说话干脆一点',
      '说话干脆点',
      '说话利索点',
      '讲话干脆点',
      '讲话利索点',
      '表达干脆点',
      '表达利落点',
      '讲干脆点',
      '讲利索点',
      '说得利索点',
    ],
    weak_inputs: [
      '尽量简洁直接',
      '尽量说话干脆一点',
      '尽量说话干脆点',
      '最好简洁直接一点',
      '优先简洁直接回答',
    ],
    matches_conversational: (content: string) => !/[A-Za-z]/.test(content) && matchesExplicitCanonicalResponseStyle(content),
    matches_attribute: (content: string) => !/[A-Za-z]/.test(content) && matchesResponseStyleAttribute(content),
  },
  {
    attribute_key: 'response_style',
    canonical_content: 'Please keep responses concise and direct',
    disposition: 'auto_commit',
    strong_inputs: [
      'Be concise and direct',
      'Keep responses concise and direct',
      'Respond directly and concisely',
    ],
    weak_inputs: [],
    matches_conversational: (content: string) => /[A-Za-z]/.test(content) && matchesExplicitCanonicalResponseStyle(content),
    matches_attribute: (content: string) => matchesResponseStyleAttribute(content),
  },
  {
    attribute_key: 'response_style',
    canonical_content: '请简洁直接回答',
    disposition: 'review',
    strong_inputs: [
      '说话直接一点',
      '说话直接点',
      '讲话直接点',
      '讲直接点',
    ],
    weak_inputs: [
      '尽量简洁直接',
      '尽量说话直接一点',
      '尽量说话直接点',
      '最好简洁直接一点',
      '优先简洁直接回答',
    ],
    matches_conversational: (content: string) => (
      !/[A-Za-z]/.test(content) &&
      !matchesExplicitCanonicalResponseStyle(content) &&
      matchesCanonicalResponseStyle(content)
    ),
    matches_attribute: (content: string) => !/[A-Za-z]/.test(content) && matchesResponseStyleAttribute(content),
  },
  {
    attribute_key: 'response_style',
    canonical_content: 'Please keep responses concise and direct',
    disposition: 'review',
    strong_inputs: [
      'Be direct',
      'Reply more directly',
    ],
    weak_inputs: [],
    matches_conversational: (content: string) => (
      /[A-Za-z]/.test(content) &&
      !matchesExplicitCanonicalResponseStyle(content) &&
      matchesCanonicalResponseStyle(content)
    ),
    matches_attribute: (content: string) => /[A-Za-z]/.test(content) && matchesResponseStyleAttribute(content),
  },
];

export const V2_CONTRACT_PROFILE_RULE_ALIAS_SETS: V2ContractProfileRuleAliasSet[] = PROFILE_RULE_ALIAS_SPECS.map(
  ({ attribute_key, canonical_content, disposition, strong_inputs, weak_inputs }) => ({
    attribute_key,
    canonical_content,
    disposition,
    strong_inputs: [...strong_inputs],
    weak_inputs: [...weak_inputs],
  }),
);

const PROFILE_RULE_CANONICAL_CASES: V2ContractCanonicalCase[] = V2_CONTRACT_PROFILE_RULE_ALIAS_SETS.flatMap(
  ({ attribute_key, strong_inputs, disposition }) => strong_inputs.map(input => ({
    input,
    requested_kind: 'profile_rule' as const,
    written_kind: 'profile_rule' as const,
    disposition,
    attribute_key,
    relation_predicate: null,
    output: `profile_rule(subject_key=user, attribute_key=${attribute_key})`,
  })),
);

const NON_PROFILE_RULE_CANONICAL_CASES: V2ContractCanonicalCase[] = [
  {
    input: '我住大阪',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: '我在 OpenAI 工作',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: '在 OpenAI 上班',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: '目前在 OpenAI 上班',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: '现在住东京',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: '目前位于东京',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: "I'm living in Tokyo",
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: 'I reside in Tokyo',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: '人在东京这边',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'location',
    relation_predicate: 'lives_in',
    output: 'fact_slot(entity_key=user, attribute_key=location)',
  },
  {
    input: '现在在 OpenAI 工作',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: '目前任职于 OpenAI',
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: "I'm working at OpenAI",
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: "I'm employed by OpenAI",
    requested_kind: 'fact_slot',
    written_kind: 'fact_slot',
    disposition: 'auto_commit',
    attribute_key: 'organization',
    relation_predicate: 'works_at',
    output: 'fact_slot(entity_key=user, attribute_key=organization)',
  },
  {
    input: '当前任务是重构 Cortex recall',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'refactor_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=refactor_status)',
  },
  {
    input: '先收一下 recall 那块',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'refactor_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=refactor_status)',
  },
  {
    input: '当前任务是部署 Cortex',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'deployment_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=deployment_status)',
  },
  {
    input: '先做部署',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'deployment_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=deployment_status)',
  },
  {
    input: '当前任务是迁移 Cortex',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'migration_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=migration_status)',
  },
  {
    input: '先迁移一下',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'migration_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=migration_status)',
  },
  {
    input: 'Current task is migrating Cortex',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'migration_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=migration_status)',
  },
  {
    input: 'Current task is deploying Cortex',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'deployment_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=deployment_status)',
  },
  {
    input: 'Current task is refactoring Cortex recall',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'refactor_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=refactor_status)',
  },
  {
    input: 'Current task is recall refactor',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
    state_key: 'refactor_status',
    relation_predicate: null,
    output: 'task_state(subject_key=cortex, state_key=refactor_status)',
  },
  {
    input: 'Current task is rewriting Cortex recall',
    requested_kind: 'task_state',
    written_kind: 'task_state',
    disposition: 'auto_commit',
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

export const V2_CONTRACT_CANONICAL_CASES: V2ContractCanonicalCase[] = [
  NON_PROFILE_RULE_CANONICAL_CASES[0],
  ...PROFILE_RULE_CANONICAL_CASES,
  ...NON_PROFILE_RULE_CANONICAL_CASES.slice(1),
];

export const V2_CONTRACT_REFERENCE_EXAMPLES: Array<{ input: string; output: string }> = V2_CONTRACT_CANONICAL_CASES.map(
  ({ input, output }) => ({ input, output }),
);

const SPECULATIVE_CONTENT_RE = /(?:也许|可能|maybe|might|perhaps|考虑|看情况|大概|probably)/i;
const CLAUSE_BOUNDARY_RE = /[。！？.!?;；]+/;
const LANGUAGE_LABEL_RE = /(中文|英文|日文|english|chinese|japanese|日本語)/i;
const ZH_SENTENCE_RE = /((?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?)(?:内|以内)?/i;
const EN_SENTENCE_RE = /(?:within|in|under|to|limit(?:ed)? to|keep(?:\s+(?:answers?|replies?|responses?))?(?:\s+(?:to|under|within))?|(?:answer|reply|respond)(?:\s+(?:in|within))?)?\s*((?:one|two|three|four|five|six|seven|eight|nine|ten|\d+))\s+sentences?(?:\s*(?:max|maximum))?/i;
const CONVERSATIONAL_PROFILE_RULE_HEDGE_RE = /(?:就行吧|就好吧|即可吧|就可以吧|够(?:了)?吧|更好|最好|尽量|优先|简单(?:一点|一些|些)?吧|轻量(?:一点)?吧)/i;
const SHORT_USER_CONFIRMATION_RE = /^(?:好(?:的)?|行|可以|没问题|收到|确认|同意|ok(?:ay)?)(?:[，,、 ]*(?:就这么定|就这样(?:吧)?|按这个来|按这个办|照这个来|这么办|定了))?$|^(?:就这么定|就这样(?:吧)?|按这个来|按这个办|照这个来|这么办|定了)$/i;
const SHORT_USER_REJECTION_RE = /^(?:不(?:要|用)?|先别|别这样|不是这个|换一个|换种|先别这样吧)(?:[，,、 ]*(?:吧|了|这个|这种|那样))?$/i;
const SHORT_USER_LANGUAGE_REWRITE_RE = /(?:改成|换成|改为|换为|改用|换用|用)\s*(中文|英文|日文|english|chinese|japanese|日本語)/i;
const SHORT_USER_LANGUAGE_COMPACT_REWRITE_RE = /^(?:改|换)\s*(中文|英文|日文|english|chinese|japanese|日本語)$/i;
const SHORT_USER_RESPONSE_LENGTH_REWRITE_RE = /(?:改成|换成|改为|换为|控制在|限制在)\s*((?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:内|以内)?)/i;
const SHORT_USER_RESPONSE_LENGTH_COMPACT_REWRITE_RE = /^(?:改|换)\s*((?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:内|以内)?)$/i;
const SHORT_USER_LOCATION_COMPACT_REWRITE_RE = /^(?:改成|换成|改为|换为|改到|换到|改|换)\s*((?:[\u4e00-\u9fff]{1,12})|(?:[A-Za-z][A-Za-z0-9_\-]{0,47}))$/iu;
const SHORT_USER_ORGANIZATION_COMPACT_REWRITE_RE = /^(?:改成|换成|改为|换为|改|换)\s*((?:[A-Za-z][A-Za-z0-9_.\- ]{0,48})|(?:[\u4e00-\u9fff]{1,24}))$/iu;
const SHORT_USER_LOCATION_CONTEXTUAL_REWRITE_RE = /^(?:(?:还是|先|就|那就)\s*)?((?:[\u4e00-\u9fff]{1,12})|(?:[A-Za-z][A-Za-z0-9_\-]{0,47}))(?:吧)?$/iu;
const SHORT_USER_ORGANIZATION_CONTEXTUAL_REWRITE_RE = /^(?:(?:还是|先|就|那就)\s*)?((?:[A-Za-z][A-Za-z0-9_.\- ]{0,48})|(?:[\u4e00-\u9fff]{1,24}))(?:吧)?$/iu;
const SHORT_USER_TASK_STATE_COMPACT_REWRITE_RE = /^(?:改成|换成|改为|换为|改|换)\s*(重构|部署|迁移|refactor(?:ing)?|rewrit(?:e|ing)|deploy(?:ment|ing)?|migrat(?:e|ion|ing))$/i;
const SHORT_USER_TASK_STATE_CONTEXTUAL_REWRITE_RE = /^(?:(?:还是|先|就|那就)\s*)?(重构|部署|迁移|refactor(?:ing)?|rewrit(?:e|ing)|deploy(?:ment|ing)?|migrat(?:e|ion|ing))(?:吧)?$/i;
const SHORT_USER_REPLACEMENT_REQUEST_RE = /(?:^|[，,、 ])(?:换一个|换种)(?:[，,、 ]|$)/i;
const SHORT_USER_DISAGREEMENT_PREFIX_RE = /^(?:先别|不要|不用|不是|别|不)[，,、 ]*/i;
const SHORT_USER_DROP_ALL_RE = /^(?:都不要|全都不要|都别要|都别加|都去掉|都删掉)$/i;
const SHORT_USER_CONTEXTUAL_VALUE_STOPWORD_RE = /^(?:这个|那个|这样|那样|这里|那里|这边|那边|这样子|那样子|可以|行|好的?|收到|算了|不用|不行)$/i;
const SHORT_USER_CONTEXTUAL_VALUE_SUFFIX_RE = /(?:吧|呀|啊|呢|啦|嘛|哦|喔|噢)+$/u;
const ASSISTANT_PROPOSAL_CONJUNCTION_RE = /[，,]\s*(?:并(?:且)?|以及|and\b)\s*/i;
const FACT_SLOT_RELATION_PREDICATES: Record<string, string> = {
  location: 'lives_in',
  organization: 'works_at',
  occupation: 'has_role',
  relationship: 'related_to',
  skill: 'has_skill',
};

function matchRelationObjectValue(
  content: string,
  patterns: RegExp[],
  options: { fallback_to_input?: boolean } = {},
): string | null {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  if (options.fallback_to_input) {
    const fallback = content.trim();
    return fallback || null;
  }
  return null;
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
  const withoutBound = compact.replace(/(?:内|以内)$/u, '');
  return withoutBound.replace(/句$/u, '句话');
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
  const english = enMatch?.[1]?.trim();
  if (!english) return null;
  return /^[A-Za-z ]+$/.test(english) ? english.toLowerCase() : english;
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

function findProfileRuleAliasSpec(attributeKey: ConversationalProfileRuleMatch['attribute_key']): InternalProfileRuleAliasSpec | null {
  return PROFILE_RULE_ALIAS_SPECS.find(spec => spec.attribute_key === attributeKey) ?? null;
}

function matchesAnyProfileRuleAliasAttribute(
  attributeKey: ConversationalProfileRuleMatch['attribute_key'],
  content: string,
): boolean {
  return PROFILE_RULE_ALIAS_SPECS.some(
    spec => spec.attribute_key === attributeKey && spec.matches_attribute(content),
  );
}

function matchProfileRuleAliasSpec(content: string): InternalProfileRuleAliasSpec | null {
  if (isWeakConversationalProfileRule(content)) return null;

  const normalized = content.trim();
  if (!normalized) return null;

  for (const spec of PROFILE_RULE_ALIAS_SPECS) {
    if (spec.matches_conversational(normalized)) {
      return spec;
    }
  }

  return null;
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
    if (matchesAnyProfileRuleAliasAttribute('solution_complexity', content)) {
      return /[A-Za-z]/.test(content) ? 'Please avoid complex solutions' : '不要复杂方案';
    }
  }

  if (attributeKey === 'response_style') {
    if (matchesCanonicalResponseStyle(content)) {
      return /[A-Za-z]/.test(content)
        ? 'Please keep responses concise and direct'
        : '请简洁直接回答';
    }
  }

  return null;
}

export function isWeakConversationalProfileRule(content: string): boolean {
  if (/^方案尽量简单(?:点|一点|一些|些)$/i.test(content.trim())) {
    return false;
  }
  return isSpeculativeContent(content) || CONVERSATIONAL_PROFILE_RULE_HEDGE_RE.test(content);
}

export function matchConversationalProfileRule(content: string): ConversationalProfileRuleMatch | null {
  const spec = matchProfileRuleAliasSpec(content);
  if (!spec) return null;

  const canonicalContent = canonicalProfileRuleContent(spec.attribute_key, content.trim());
  if (canonicalContent) {
    return {
      attribute_key: spec.attribute_key,
      canonical_content: canonicalContent,
      disposition: spec.disposition,
    };
  }

  return null;
}

function canonicalFactSlotContent(attributeKey: string, content: string, entityKey?: string | null): string | null {
  if (entityKey && entityKey !== 'user') return null;

  const value = extractFactRelationObjectValue(attributeKey, content)?.trim();
  if (!value) return null;
  const locale = detectContentLocale(content) === 'en' ? 'en' : 'zh';
  return synthesizeCanonicalFactSlotContent(attributeKey, value, locale);
}

function synthesizeCanonicalFactSlotContent(
  attributeKey: string,
  value: string,
  locale: 'zh' | 'en' = 'zh',
): string | null {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');
  if (!normalizedValue) return null;

  if (attributeKey === 'location') {
    return locale === 'en' ? `I live in ${normalizedValue}` : `我住${normalizedValue}`;
  }

  if (attributeKey === 'organization') {
    return locale === 'en' ? `I work at ${normalizedValue}` : `我在 ${normalizedValue} 工作`;
  }

  return null;
}

function synthesizeCanonicalTaskStateContent(stateKey: string, subjectKey?: string | null): string | null {
  if (subjectKey && subjectKey !== 'cortex') return null;

  switch (stateKey) {
    case 'refactor_status':
      return '当前任务是重构 Cortex recall';
    case 'deployment_status':
      return '当前任务是部署 Cortex';
    case 'migration_status':
      return '当前任务是迁移 Cortex';
    default:
      return null;
  }
}

function canonicalTaskStateContent(stateKey: string, content: string, subjectKey?: string | null): string | null {
  const canonical = synthesizeCanonicalTaskStateContent(stateKey, subjectKey);
  if (!canonical) return null;

  switch (stateKey) {
    case 'refactor_status':
      if (
        !matchesColloquialRecallRefactorTask(content) &&
        !matchesExplicitEnglishRecallRefactorTask(content) &&
        (!/cortex/i.test(content) || !/recall/i.test(content) || !CORTEX_REFACTOR_KEYWORD_RE.test(content))
      ) {
        return null;
      }
      return canonical;
    case 'deployment_status':
      return (
        matchesColloquialCortexWorkflowTask(content, 'deployment_status') ||
        (/cortex/i.test(content) && CORTEX_DEPLOYMENT_KEYWORD_RE.test(content))
      )
        ? canonical
        : null;
    case 'migration_status':
      return (
        matchesColloquialCortexWorkflowTask(content, 'migration_status') ||
        (/cortex/i.test(content) && CORTEX_MIGRATION_KEYWORD_RE.test(content))
      )
        ? canonical
        : null;
    default:
      return null;
  }
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

function normalizeShortUserContextualValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(SHORT_USER_CONTEXTUAL_VALUE_SUFFIX_RE, '').trim();
  if (!normalized || SHORT_USER_CONTEXTUAL_VALUE_STOPWORD_RE.test(normalized)) return null;
  return normalized;
}

function mentionsLanguagePreference(content: string): boolean {
  return /(中文|英文|日文|english|chinese|japanese|日本語)/i.test(content);
}

function mentionsResponseLength(content: string): boolean {
  return /(?:(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:限制|内|以内)?|句数限制|长度限制)/i.test(content);
}

function mentionsSolutionComplexity(content: string): boolean {
  return !!findProfileRuleAliasSpec('solution_complexity')?.matches_conversational(content);
}

function mentionsResponseStyle(content: string): boolean {
  return /(?:回答|回复|说话|表达).{0,4}(?:风格|方式)|(?:风格|方式).{0,4}(?:回答|回复|说话|表达)/i.test(content);
}

function mentionsLocationFact(content: string): boolean {
  return /(?:住址|地址|所在地|居住地|住的地方)/i.test(content);
}

function mentionsOrganizationFact(content: string): boolean {
  return /(?:工作单位|公司|单位|组织|employer|company|organization)/i.test(content);
}

function dropsLanguagePreference(content: string): boolean {
  return /(?:别|不要|别用|取消|去掉|删掉).{0,8}(?:中文|英文|日文|english|chinese|japanese|日本語)/i.test(content);
}

function dropsResponseLength(content: string): boolean {
  return /(?:别|不要|别加|取消|去掉|删掉).{0,10}(?:(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?(?:限制|内|以内)?|句数|长度限制)/i.test(content);
}

function dropsSolutionComplexity(content: string): boolean {
  return /(?:别|不要|取消|去掉|删掉).{0,10}(?:简单|轻量|复杂方案|复杂限制)/i.test(content);
}

function dropsResponseStyle(content: string): boolean {
  return /(?:别|不要|取消|去掉|删掉).{0,10}(?:回答|回复|说话|表达).{0,4}(?:风格|方式)|(?:别|不要|取消|去掉|删掉).{0,10}(?:风格|方式).{0,4}(?:回答|回复|说话|表达)/i.test(content);
}

function dropsLocationFact(content: string): boolean {
  return /(?:别|不要|取消|去掉|删掉|别记|不记).{0,8}(?:住址|地址|所在地|居住地|住的地方)/i.test(content);
}

function dropsOrganizationFact(content: string): boolean {
  return /(?:别|不要|取消|去掉|删掉|别记|不记).{0,8}(?:工作单位|公司|单位|组织|employer|company|organization)/i.test(content);
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

  const compactLanguageMatch = normalized.match(SHORT_USER_LANGUAGE_COMPACT_REWRITE_RE);
  if (compactLanguageMatch?.[1]) {
    const label = canonicalLanguageLabel(compactLanguageMatch[1]);
    if (label) {
      return {
        synthesized_content: `请用${label}回答`,
      };
    }
  }

  const responseLengthMatch = normalized.match(SHORT_USER_RESPONSE_LENGTH_REWRITE_RE);
  if (responseLengthMatch?.[1]) {
    return {
      synthesized_content: `请把回答控制在${canonicalSentenceCount(responseLengthMatch[1])}内`,
    };
  }

  const compactResponseLengthMatch = normalized.match(SHORT_USER_RESPONSE_LENGTH_COMPACT_REWRITE_RE);
  if (compactResponseLengthMatch?.[1]) {
    return {
      synthesized_content: `请把回答控制在${canonicalSentenceCount(compactResponseLengthMatch[1])}内`,
    };
  }

  return null;
}

export function inferShortUserProfileRuleAttributeRewrite(attributeKey: string, content: string): ShortUserProposalRewrite | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return null;

  if (attributeKey === 'language_preference') {
    const label = canonicalLanguageLabel(trimmed);
    return label ? { synthesized_content: `请用${label}回答` } : null;
  }

  if (attributeKey === 'response_length') {
    const phrase = extractSentenceCountConstraint(trimmed);
    return phrase ? { synthesized_content: `请把回答控制在${phrase}内` } : null;
  }

  if (
    attributeKey === 'solution_complexity'
    && (
      findProfileRuleAliasSpec('solution_complexity')?.matches_conversational(trimmed)
      || findProfileRuleAliasSpec('solution_complexity')?.matches_attribute(trimmed)
    )
  ) {
    return {
      synthesized_content: /[A-Za-z]/.test(trimmed)
        ? 'Please avoid complex solutions'
        : '不要复杂方案',
    };
  }

  if (attributeKey === 'response_style' && matchesExplicitCanonicalResponseStyle(trimmed)) {
    return {
      synthesized_content: /[A-Za-z]/.test(trimmed)
        ? 'Please keep responses concise and direct'
        : '请简洁直接回答',
    };
  }

  return null;
}

export function inferShortUserFactSlotRewrite(attributeKey: string, content: string): ShortUserProposalRewrite | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return null;
  if (SHORT_USER_REJECTION_RE.test(trimmed) || SHORT_USER_DROP_ALL_RE.test(trimmed)) return null;
  const normalized = stripShortUserDisagreementPrefix(trimmed) || trimmed;

  if (attributeKey === 'location') {
    const value = normalizeShortUserContextualValue((
      normalized.match(SHORT_USER_LOCATION_COMPACT_REWRITE_RE)?.[1]
      || normalized.match(SHORT_USER_LOCATION_CONTEXTUAL_REWRITE_RE)?.[1]
    ));
    if (!value) return null;
    const synthesized = value ? synthesizeCanonicalFactSlotContent(attributeKey, value, 'zh') : null;
    return synthesized ? { synthesized_content: synthesized } : null;
  }

  if (attributeKey === 'organization') {
    const value = normalizeShortUserContextualValue((
      normalized.match(SHORT_USER_ORGANIZATION_COMPACT_REWRITE_RE)?.[1]
      || normalized.match(SHORT_USER_ORGANIZATION_CONTEXTUAL_REWRITE_RE)?.[1]
    ));
    if (!value) return null;
    const synthesized = value ? synthesizeCanonicalFactSlotContent(attributeKey, value, 'zh') : null;
    return synthesized ? { synthesized_content: synthesized } : null;
  }

  return null;
}

export function inferShortUserTaskStateRewrite(subjectKey: string, content: string): ShortUserProposalRewrite | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return null;
  if (subjectKey !== 'cortex') return null;

  const normalized = stripShortUserDisagreementPrefix(trimmed) || trimmed;
  const stateRaw = (
    normalized.match(SHORT_USER_TASK_STATE_COMPACT_REWRITE_RE)?.[1]
    || normalized.match(SHORT_USER_TASK_STATE_CONTEXTUAL_REWRITE_RE)?.[1]
  )?.trim().toLowerCase();
  if (!stateRaw) return null;

  let stateKey: string | null = null;
  if (stateRaw === '重构' || stateRaw.startsWith('refactor') || stateRaw.startsWith('rewrit')) {
    stateKey = 'refactor_status';
  } else if (stateRaw === '部署' || stateRaw.startsWith('deploy')) {
    stateKey = 'deployment_status';
  } else if (stateRaw === '迁移' || stateRaw.startsWith('migrat')) {
    stateKey = 'migration_status';
  }
  if (!stateKey) return null;

  const synthesized = synthesizeCanonicalTaskStateContent(stateKey, subjectKey);
  return synthesized ? { synthesized_content: synthesized } : null;
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

  if (dropsSolutionComplexity(trimmed)) {
    drop.add('solution_complexity');
  } else if (mentionsSolutionComplexity(trimmed)) {
    keep.add('solution_complexity');
  }

  if (dropsResponseStyle(trimmed)) {
    drop.add('response_style');
  } else if (mentionsResponseStyle(trimmed)) {
    keep.add('response_style');
  }

  if (keep.size === 0 && drop.size === 0) return null;

  return {
    keep_profile_rule_attributes: Array.from(keep),
    drop_profile_rule_attributes: Array.from(drop),
    drop_all: false,
  };
}

export function inferShortUserFactSelection(content: string): ShortUserFactSelection | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return null;
  if (SHORT_USER_DROP_ALL_RE.test(trimmed)) {
    return {
      keep_fact_attributes: [],
      drop_fact_attributes: [],
      drop_all: true,
    };
  }

  const keep = new Set<'location' | 'organization'>();
  const drop = new Set<'location' | 'organization'>();

  if (dropsLocationFact(trimmed)) {
    drop.add('location');
  } else if (mentionsLocationFact(trimmed)) {
    keep.add('location');
  }

  if (dropsOrganizationFact(trimmed)) {
    drop.add('organization');
  } else if (mentionsOrganizationFact(trimmed)) {
    keep.add('organization');
  }

  if (keep.size === 0 && drop.size === 0) return null;

  return {
    keep_fact_attributes: Array.from(keep),
    drop_fact_attributes: Array.from(drop),
    drop_all: false,
  };
}

export function inferShortUserTaskSelection(content: string): ShortUserTaskSelection | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return null;
  if (SHORT_USER_DROP_ALL_RE.test(trimmed)) return null;

  if (
    /^(?:只|就)?(?:保留|留)(?:当前)?任务$/i.test(trimmed) ||
    /^(?:只要|就要|就)(?:当前)?任务(?:(?:就)?(?:行|即可|就好|就可以))?$/i.test(trimmed) ||
    /^(?:当前)?任务(?:(?:就)?(?:行|即可|就好|就可以))$/i.test(trimmed)
  ) {
    return { keep_current_task: true };
  }

  return null;
}

export function isShortUserReplacementRequest(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return false;
  return SHORT_USER_REPLACEMENT_REQUEST_RE.test(trimmed);
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
  if (matchesAnyProfileRuleAliasAttribute('language_preference', content)) {
    return 'language_preference';
  }
  if (matchesResponseStyleAttribute(content) && ownerScope === 'user') {
    return 'response_style';
  }
  if (matchesAnyProfileRuleAliasAttribute('response_length', content)) {
    return 'response_length';
  }
  if (matchesAnyProfileRuleAliasAttribute('solution_complexity', content)) {
    return 'solution_complexity';
  }
  if (/(低风险|高风险|risk tolerance|risk profile)/i.test(content)) return 'risk_tolerance';
  return null;
}

function matchFactSlotAttribute(content: string): string | null {
  if (matchesConversationalLocationFact(content)) return 'location';
  if (/(?:我|用户)?住(?:在)?|live(?:s|d)? in|living in|resid(?:e|ed|ing) in|based in|located in|位于|来自|from/i.test(content)) return 'location';
  if (/(?:我|用户)?在.+(?:工作|上班)|(?:现在|目前|如今)?在.+(?:工作|上班)|任职于|就职于|供职于|i work (?:at|for|in)|works? at|i(?:'m| am)(?: currently)? working (?:at|for|in)|employed (?:at|by)/i.test(content)) return 'organization';
  if (/我是.+(?:工程师|开发者|设计师|学生|老师|医生|研究员)|i(?:'m| am) (?:a |an )?(?:developer|engineer|designer|student|teacher|doctor|researcher)/i.test(content)) {
    return 'occupation';
  }
  if (/我会|擅长|熟悉|skill|capability|experienced in|good at/i.test(content)) return 'skill';
  if (/朋友|同事|老板|导师|partner|friend|colleague|boss|mentor/i.test(content)) return 'relationship';
  return null;
}

function matchTaskStateKey(content: string): string | null {
  if (matchesColloquialRecallRefactorTask(content)) return 'refactor_status';
  if (CORTEX_REFACTOR_KEYWORD_RE.test(content)) return 'refactor_status';
  if (CORTEX_DEPLOYMENT_KEYWORD_RE.test(content)) return 'deployment_status';
  if (CORTEX_MIGRATION_KEYWORD_RE.test(content)) return 'migration_status';
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
        /(?:人(?:在)?|我(?:现在|目前)?在)\s*([\u4e00-\u9fff]{1,12})(?:这边|那边)/i,
        /(?:现在|目前|如今|currently|now)\s*(?:我|用户)?住(?:在)?\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /(?:我|用户)?住(?:在)?\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /\bliv(?:e|es|ed|ing)\s+in\s+([a-z0-9_\- ]+)/i,
        /\bresid(?:e|ed|ing)\s+in\s+([a-z0-9_\- ]+)/i,
        /\blocated in\s+([a-z0-9_\- ]+)/i,
        /\bbased in\s+([a-z0-9_\- ]+)/i,
        /\bfrom\s+([a-z0-9_\- ]+)/i,
        /来自\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /位于\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
      ]);
    case 'organization':
      return matchRelationObjectValue(trimmed, [
        /(?:现在|目前|如今)?在\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*上班/i,
        /(?:我|用户)?在\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*上班/i,
        /(?:现在|目前|如今)?在\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*工作/i,
        /(?:我|用户)?在\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*工作/i,
        /(?:现在|目前|如今)?(?:任职于|就职于|供职于)\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /(?:我|用户)?(?:任职于|就职于|供职于)\s*([A-Za-z0-9_\-\u4e00-\u9fff]+)/i,
        /\bwork(?:s|ed|ing)?\s+(?:at|for|in)\s+([a-z0-9_\- ]+)/i,
        /\bemployed\s+(?:at|by)\s+([a-z0-9_\- ]+)/i,
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

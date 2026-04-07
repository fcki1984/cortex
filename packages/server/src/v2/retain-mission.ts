import type { NormalizedRecordCandidate } from './types.js';

export type RetainMissionScope = 'in_scope' | 'unclear' | 'out_of_scope';

type RetainMissionCategory = 'profile_rule' | 'fact_slot' | 'task_state';
type RetainMissionKey =
  | 'profile_rule:language_preference'
  | 'profile_rule:response_length'
  | 'profile_rule:solution_complexity'
  | 'profile_rule:response_style'
  | 'fact_slot:location'
  | 'fact_slot:organization'
  | 'task_state:refactor_status'
  | 'task_state:deployment_status'
  | 'task_state:migration_status';

type ParsedRetainMission = {
  normalized: string;
  hasMission: boolean;
  strictLongTerm: boolean;
  onlyMode: boolean;
  explicitlyExcludesTaskStates: boolean;
  explicitlyIncludesTaskStates: boolean;
  includeCategories: Set<RetainMissionCategory>;
  excludeCategories: Set<RetainMissionCategory>;
  includeKeys: Set<RetainMissionKey>;
  excludeKeys: Set<RetainMissionKey>;
};

const STRICT_LONG_TERM_RE = /(?:长期|长期有复用价值|真正长期|复用价值|可复用|reusable|long[-\s]?term)/i;
const ONLY_MODE_RE = /(?:只保留|仅保留|只留下|only retain|retain only)/i;
const NEGATION_RE = '(?:不保留|不要|排除|过滤|忽略|别留|别记|skip|exclude|omit|drop)';
const TASK_STATE_EXCLUDE_RE = /(?:(?:不保留|不要|排除|过滤|忽略).{0,8}(?:短期|当前|临时|任务|项目|todo|待办|进度|状态)|(?:短期|当前|临时).{0,6}(?:任务|项目).{0,8}(?:不保留|不要))/i;
const TASK_STATE_INCLUDE_RE = /(?:(?:持续|长期|ongoing|persistent).{0,6}(?:任务|项目|todo|待办|进度)|(?:任务|项目|todo|待办|进度).{0,8}(?:保留|记录|retain))/i;
const GENERIC_PROFILE_RULE_RE = /(?:长期偏好|用户偏好|通用偏好|整体偏好|preferences?|profile rules?)/i;
const GENERIC_FACT_SLOT_RE = /(?:稳定背景|背景事实|背景信息|background facts?|stable background|facts?)/i;
const GENERIC_TASK_STATE_RE = /(?:持续任务|长期任务|任务状态|项目进度|ongoing tasks?|project status)/i;

type MissionKeyMatcher = {
  key: RetainMissionKey;
  include: RegExp[];
  exclude: RegExp[];
};

function splitMissionSegments(normalized: string): string[] {
  const segments = normalized
    .split(/[，,。；;\n]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.length > 0 ? segments : [normalized];
}

function buildNegationRegex(pattern: string): RegExp[] {
  return [
    new RegExp(`${NEGATION_RE}.{0,12}(?:${pattern})`, 'i'),
    new RegExp(`(?:${pattern}).{0,12}${NEGATION_RE}`, 'i'),
  ];
}

const KEY_MATCHERS: MissionKeyMatcher[] = [
  {
    key: 'profile_rule:language_preference',
    include: [/(?:语言偏好|language(?: preference)?|中文|英文)/i],
    exclude: buildNegationRegex('(?:语言偏好|language(?: preference)?|中文|英文)'),
  },
  {
    key: 'profile_rule:response_length',
    include: [/(?:回答长度|回复长度|句数|三句话|篇幅|length)/i],
    exclude: buildNegationRegex('(?:回答长度|回复长度|句数|三句话|篇幅|length)'),
  },
  {
    key: 'profile_rule:solution_complexity',
    include: [/(?:方案复杂度|方案简单|简单方案|复杂方案|复杂度|solution complexity|complexity)/i],
    exclude: buildNegationRegex('(?:方案复杂度|方案简单|简单方案|复杂方案|复杂度|solution complexity|complexity)'),
  },
  {
    key: 'profile_rule:response_style',
    include: [/(?:回答风格|回复风格|说话方式|语气|表达风格|response style|style)/i],
    exclude: buildNegationRegex('(?:回答风格|回复风格|说话方式|语气|表达风格|response style|style)'),
  },
  {
    key: 'fact_slot:location',
    include: [/(?:住址|居住地|住在哪|住哪|location|address|城市|地点)/i],
    exclude: buildNegationRegex('(?:住址|居住地|住在哪|住哪|location|address|城市|地点)'),
  },
  {
    key: 'fact_slot:organization',
    include: [/(?:工作背景|工作单位|任职背景|公司背景|组织背景|organization|employer|公司|任职)/i],
    exclude: buildNegationRegex('(?:工作背景|工作单位|任职背景|公司背景|组织背景|organization|employer|公司|任职)'),
  },
  {
    key: 'task_state:refactor_status',
    include: [/(?:重构|refactor)/i],
    exclude: buildNegationRegex('(?:重构|refactor)'),
  },
  {
    key: 'task_state:deployment_status',
    include: [/(?:部署|上线|deploy)/i],
    exclude: buildNegationRegex('(?:部署|上线|deploy)'),
  },
  {
    key: 'task_state:migration_status',
    include: [/(?:迁移|migration)/i],
    exclude: buildNegationRegex('(?:迁移|migration)'),
  },
];

export function normalizeRetainMission(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function extractRetainMissionFromConfigOverride(configOverride: unknown): string {
  if (!configOverride || typeof configOverride !== 'object') return '';
  const sieve = (configOverride as Record<string, unknown>).sieve;
  if (!sieve || typeof sieve !== 'object') return '';
  return normalizeRetainMission((sieve as Record<string, unknown>).retainMission);
}

export function resolveEffectiveRetainMission(input: {
  globalMission?: unknown;
  agentOverride?: unknown;
}): string {
  const override = normalizeRetainMission(input.agentOverride);
  if (override) return override;
  return normalizeRetainMission(input.globalMission);
}

function categoryForCandidate(candidate: NormalizedRecordCandidate): RetainMissionCategory | null {
  switch (candidate.written_kind) {
    case 'profile_rule':
      return 'profile_rule';
    case 'fact_slot':
      return 'fact_slot';
    case 'task_state':
      return 'task_state';
    default:
      return null;
  }
}

function keyForCandidate(candidate: NormalizedRecordCandidate): RetainMissionKey | null {
  const record = candidate.candidate;

  if (record.kind === 'profile_rule') {
    switch (record.attribute_key) {
      case 'language_preference':
        return 'profile_rule:language_preference';
      case 'response_length':
        return 'profile_rule:response_length';
      case 'solution_complexity':
        return 'profile_rule:solution_complexity';
      case 'response_style':
        return 'profile_rule:response_style';
      default:
        return null;
    }
  }

  if (record.kind === 'fact_slot') {
    switch (record.attribute_key) {
      case 'location':
        return 'fact_slot:location';
      case 'organization':
        return 'fact_slot:organization';
      default:
        return null;
    }
  }

  if (record.kind === 'task_state') {
    switch (record.state_key) {
      case 'refactor_status':
        return 'task_state:refactor_status';
      case 'deployment_status':
        return 'task_state:deployment_status';
      case 'migration_status':
        return 'task_state:migration_status';
      default:
        return null;
    }
  }

  return null;
}

function categoryFromKey(key: RetainMissionKey): RetainMissionCategory {
  if (key.startsWith('profile_rule:')) return 'profile_rule';
  if (key.startsWith('fact_slot:')) return 'fact_slot';
  return 'task_state';
}

function parseRetainMission(mission: string): ParsedRetainMission {
  const normalized = normalizeRetainMission(mission);
  const segments = splitMissionSegments(normalized);
  const includeCategories = new Set<RetainMissionCategory>();
  const excludeCategories = new Set<RetainMissionCategory>();
  const includeKeys = new Set<RetainMissionKey>();
  const excludeKeys = new Set<RetainMissionKey>();

  if (GENERIC_PROFILE_RULE_RE.test(normalized)) includeCategories.add('profile_rule');
  if (GENERIC_FACT_SLOT_RE.test(normalized)) includeCategories.add('fact_slot');
  if (GENERIC_TASK_STATE_RE.test(normalized)) includeCategories.add('task_state');

  for (const segment of segments) {
    for (const matcher of KEY_MATCHERS) {
      if (matcher.exclude.some((regex) => regex.test(segment))) {
        excludeKeys.add(matcher.key);
        continue;
      }
      if (matcher.include.some((regex) => regex.test(segment))) {
        includeKeys.add(matcher.key);
      }
    }
  }

  if (TASK_STATE_EXCLUDE_RE.test(normalized)) excludeCategories.add('task_state');
  if (TASK_STATE_INCLUDE_RE.test(normalized)) includeCategories.add('task_state');

  return {
    normalized,
    hasMission: normalized.length > 0,
    strictLongTerm: STRICT_LONG_TERM_RE.test(normalized),
    onlyMode: ONLY_MODE_RE.test(normalized),
    explicitlyExcludesTaskStates: TASK_STATE_EXCLUDE_RE.test(normalized),
    explicitlyIncludesTaskStates: TASK_STATE_INCLUDE_RE.test(normalized),
    includeCategories,
    excludeCategories,
    includeKeys,
    excludeKeys,
  };
}

export function resolveRetainMissionScope(
  mission: string | undefined,
  candidate: NormalizedRecordCandidate,
): RetainMissionScope {
  if (candidate.written_kind === 'session_note') return 'in_scope';

  const parsed = parseRetainMission(mission || '');
  if (!parsed.hasMission) return 'in_scope';

  const category = categoryForCandidate(candidate);
  const key = keyForCandidate(candidate);
  if (!category) return 'unclear';

  if (key && parsed.excludeKeys.has(key)) return 'out_of_scope';
  if (parsed.excludeCategories.has(category)) return 'out_of_scope';

  if (key && parsed.includeKeys.has(key)) return 'in_scope';
  if (parsed.includeCategories.has(category)) return 'in_scope';

  if (category === 'task_state') {
    if (parsed.explicitlyIncludesTaskStates) return 'in_scope';
    if (parsed.onlyMode && (parsed.includeKeys.size > 0 || parsed.includeCategories.size > 0)) {
      return 'out_of_scope';
    }
    if (parsed.strictLongTerm) return 'unclear';
    return 'unclear';
  }

  if (parsed.onlyMode && (parsed.includeKeys.size > 0 || parsed.includeCategories.size > 0)) {
    return 'out_of_scope';
  }
  return 'in_scope';
}

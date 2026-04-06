import type { NormalizedRecordCandidate } from './types.js';

export type RetainMissionScope = 'in_scope' | 'unclear' | 'out_of_scope';

type RetainMissionCategory = 'profile_rule' | 'fact_slot' | 'task_state';

type ParsedRetainMission = {
  normalized: string;
  hasMission: boolean;
  strictLongTerm: boolean;
  onlyMode: boolean;
  mentionsProfileRules: boolean;
  mentionsFactSlots: boolean;
  mentionsTaskStates: boolean;
  explicitlyExcludesTaskStates: boolean;
  explicitlyIncludesTaskStates: boolean;
};

const STRICT_LONG_TERM_RE = /(?:长期|长期有复用价值|真正长期|复用价值|可复用|reusable|long[-\s]?term)/i;
const ONLY_MODE_RE = /(?:只保留|仅保留|只留下|only retain|retain only)/i;
const PROFILE_RULE_RE = /(?:偏好|规则|约束|语言|回答方式|回复方式|风格|preference|constraint|language|response)/i;
const FACT_SLOT_RE = /(?:背景|事实|住在|居住|工作|任职|organization|location|background|fact)/i;
const TASK_STATE_RE = /(?:任务|项目|todo|待办|进度|状态|current task|project status)/i;
const TASK_STATE_EXCLUDE_RE = /(?:(?:不保留|不要|排除|过滤|忽略).{0,8}(?:短期|当前|临时|任务|项目|todo|待办|进度|状态)|(?:短期|当前|临时).{0,6}(?:任务|项目).{0,8}(?:不保留|不要))/i;
const TASK_STATE_INCLUDE_RE = /(?:(?:持续|长期|ongoing|persistent).{0,6}(?:任务|项目|todo|待办|进度)|(?:任务|项目|todo|待办|进度).{0,8}(?:保留|记录|retain))/i;

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

function parseRetainMission(mission: string): ParsedRetainMission {
  const normalized = normalizeRetainMission(mission);
  return {
    normalized,
    hasMission: normalized.length > 0,
    strictLongTerm: STRICT_LONG_TERM_RE.test(normalized),
    onlyMode: ONLY_MODE_RE.test(normalized),
    mentionsProfileRules: PROFILE_RULE_RE.test(normalized),
    mentionsFactSlots: FACT_SLOT_RE.test(normalized),
    mentionsTaskStates: TASK_STATE_RE.test(normalized),
    explicitlyExcludesTaskStates: TASK_STATE_EXCLUDE_RE.test(normalized),
    explicitlyIncludesTaskStates: TASK_STATE_INCLUDE_RE.test(normalized),
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
  if (!category) return 'unclear';

  if (category === 'task_state') {
    if (parsed.explicitlyExcludesTaskStates) return 'out_of_scope';
    if (parsed.explicitlyIncludesTaskStates) return 'in_scope';
    if (parsed.onlyMode && (parsed.mentionsProfileRules || parsed.mentionsFactSlots) && !parsed.mentionsTaskStates) {
      return 'out_of_scope';
    }
    if (parsed.strictLongTerm) return 'unclear';
    return 'unclear';
  }

  if (category === 'profile_rule') {
    if (parsed.mentionsProfileRules) return 'in_scope';
    if (parsed.onlyMode && (parsed.mentionsFactSlots || parsed.mentionsTaskStates) && !parsed.mentionsProfileRules) {
      return 'out_of_scope';
    }
    return 'in_scope';
  }

  if (parsed.mentionsFactSlots) return 'in_scope';
  if (parsed.onlyMode && (parsed.mentionsProfileRules || parsed.mentionsTaskStates) && !parsed.mentionsFactSlots) {
    return 'out_of_scope';
  }
  return 'in_scope';
}

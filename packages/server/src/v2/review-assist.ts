import {
  extractFactRelationObjectValue,
  isSpeculativeContent,
} from './contract.js';

export type ReviewSuggestedAction = 'accept' | 'reject' | 'edit';

export type ReviewAssistSuggestion = {
  suggested_action: ReviewSuggestedAction;
  suggested_reason: string;
  suggested_rewrite?: string | null;
};

type ReviewRecordPayload = Record<string, unknown>;
type ReviewRelationPayload = Record<string, unknown>;
type SupportedLocale = 'zh' | 'en' | 'ja';
type SupportedLanguageLabel = '中文' | '英文' | '日文';

const ZH_RE = /[\u4e00-\u9fff]/;
const JA_RE = /[\u3040-\u30ff]/;
const EN_RE = /[A-Za-z]/;
const ZH_SENTENCE_RE = /((?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*句(?:话)?)(?:内|以内)?/i;
const EN_SENTENCE_RE = /(?:within|in|under|limit(?:ed)? to|keep(?: answers?)?(?: within)?|answer in)?\s*((?:one|two|three|four|five|six|seven|eight|nine|ten|\d+))\s+sentences?(?:\s*(?:max|maximum))?/i;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asWarnings(payload: Record<string, unknown>): string[] {
  const warnings = payload.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0);
}

function detectLocale(text: string | null): SupportedLocale | null {
  if (!text) return null;
  if (JA_RE.test(text)) return 'ja';
  if (ZH_RE.test(text)) return 'zh';
  if (EN_RE.test(text)) return 'en';
  return null;
}

function normalizeLanguageLabel(text: string | null): SupportedLanguageLabel | null {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();
  if (normalized.includes('中文') || normalized.includes('chinese')) return '中文';
  if (normalized.includes('英文') || normalized.includes('english')) return '英文';
  if (normalized.includes('日文') || normalized.includes('japanese') || normalized.includes('日本語')) return '日文';
  return null;
}

function languageTemplate(label: SupportedLanguageLabel): string {
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

function supportsRewriteSourceType(sourceType: string | null): boolean {
  return sourceType === 'user_explicit' || sourceType === 'user_confirmed';
}

function canonicalResponseLengthRewrite(text: string, locale: SupportedLocale | null): string | null {
  const zhMatch = text.match(ZH_SENTENCE_RE);
  if (zhMatch?.[1]) {
    const phrase = zhMatch[1].replace(/\s+/g, '');
    return `请把回答控制在${phrase}内`;
  }

  const enMatch = text.match(EN_SENTENCE_RE);
  if (enMatch?.[1] && locale === 'en') {
    return `Please keep answers within ${enMatch[1]} sentences`;
  }

  return null;
}

function canonicalSolutionComplexityRewrite(text: string, locale: SupportedLocale | null): string | null {
  if (/(?:不要复杂方案|别太复杂|别做复杂方案|方案别太复杂|avoid complex|simple solution|keep it simple|lightweight solution)/i.test(text)) {
    if (locale === 'en') return 'Please avoid complex solutions';
    if (locale === 'zh') return '不要复杂方案';
  }
  return null;
}

function canonicalFactRewrite(payload: ReviewRecordPayload, sourceText: string, locale: SupportedLocale | null): string | null {
  const normalizedKind = asString(payload.normalized_kind);
  const attributeKey = asString(payload.attribute_key);
  const entityKey = asString(payload.entity_key);
  if (normalizedKind !== 'fact_slot' || entityKey !== 'user' || !attributeKey) return null;

  const value = extractFactRelationObjectValue(attributeKey, sourceText)?.trim();
  if (!value) return null;

  if (attributeKey === 'location') {
    if (locale === 'zh') return `我住${value}`;
    if (locale === 'en') return `I live in ${value}`;
    return null;
  }

  if (attributeKey === 'organization') {
    if (locale === 'zh') return `我在 ${value} 工作`;
    if (locale === 'en') return `I work at ${value}`;
    return null;
  }

  return null;
}

function canonicalTaskStateRewrite(payload: ReviewRecordPayload, sourceText: string, locale: SupportedLocale | null): string | null {
  if (locale !== 'zh') return null;
  if (asString(payload.normalized_kind) !== 'task_state') return null;
  if (asString(payload.subject_key) !== 'cortex') return null;
  if (asString(payload.state_key) !== 'refactor_status') return null;
  if (!/cortex/i.test(sourceText) || !/recall/i.test(sourceText) || !/(?:重构|refactor)/i.test(sourceText)) return null;
  return '当前任务是重构 Cortex recall';
}

function inferRewriteLocale(payload: ReviewRecordPayload, sourceText: string): SupportedLocale | null {
  const attributeKey = asString(payload.attribute_key);
  if (asString(payload.normalized_kind) === 'profile_rule' && attributeKey === 'language_preference') {
    const preferredLanguage = normalizeLanguageLabel(asString(payload.content));
    if (preferredLanguage === '中文') return 'zh';
    if (preferredLanguage === '英文') return 'en';
    if (preferredLanguage === '日文') return 'ja';
  }

  return detectLocale(asString(payload.source_excerpt) || sourceText);
}

function buildSuggestedRewrite(payload: ReviewRecordPayload): string | null {
  const sourceText = asString(payload.source_excerpt) || asString(payload.content);
  if (!sourceText) return null;

  const locale = inferRewriteLocale(payload, sourceText);
  const normalizedKind = asString(payload.normalized_kind);
  const attributeKey = asString(payload.attribute_key);

  if (normalizedKind === 'profile_rule' && asString(payload.subject_key) === 'user') {
    if (attributeKey === 'language_preference') {
      const preferredLanguage = normalizeLanguageLabel(asString(payload.content) || sourceText);
      return preferredLanguage ? languageTemplate(preferredLanguage) : null;
    }
    if (attributeKey === 'response_length') {
      return canonicalResponseLengthRewrite(sourceText, locale);
    }
    if (attributeKey === 'solution_complexity') {
      return canonicalSolutionComplexityRewrite(sourceText, locale);
    }
    return null;
  }

  if (normalizedKind === 'fact_slot') {
    return canonicalFactRewrite(payload, sourceText, locale);
  }

  if (normalizedKind === 'task_state') {
    return canonicalTaskStateRewrite(payload, sourceText, locale);
  }

  return null;
}

function fallbackRecordSuggestion(payload: ReviewRecordPayload): ReviewAssistSuggestion {
  const sourceText = asString(payload.source_excerpt) || asString(payload.content) || '';
  const normalizedKind = asString(payload.normalized_kind);

  if (normalizedKind === 'session_note' || isSpeculativeContent(sourceText)) {
    return {
      suggested_action: 'edit',
      suggested_reason: '这条候选仍带有不确定性，建议保持人工判断，只在你确认后再保留。',
      suggested_rewrite: null,
    };
  }

  return {
    suggested_action: 'edit',
    suggested_reason: '这条候选已经进入可审查状态，但当前没有安全的确定性改写模板，建议人工确认或轻微编辑后再接受。',
    suggested_rewrite: null,
  };
}

export function buildRecordReviewAssist(payload: ReviewRecordPayload): ReviewAssistSuggestion {
  const sourceType = asString(payload.source_type);
  const warnings = asWarnings(payload);
  const sourceText = asString(payload.source_excerpt) || asString(payload.content) || '';

  if (sourceType === 'assistant_inferred') {
    return {
      suggested_action: 'reject',
      suggested_reason: '这条候选主要来自助手推断，建议先拒绝，除非你明确确认它是真的。',
      suggested_rewrite: null,
    };
  }

  if (!supportsRewriteSourceType(sourceType)) {
    return fallbackRecordSuggestion(payload);
  }

  if (warnings.length > 0) {
    return {
      suggested_action: 'edit',
      suggested_reason: '这条候选带有降级或稳定性警告，建议先人工确认，不直接使用自动改写。',
      suggested_rewrite: null,
    };
  }

  if (isSpeculativeContent(sourceText)) {
    return fallbackRecordSuggestion(payload);
  }

  const suggestedRewrite = buildSuggestedRewrite(payload);
  if (suggestedRewrite) {
    return {
      suggested_action: 'accept',
      suggested_reason: '这条候选的 kind 和 stable key 已经稳定，可以直接使用建议改写后接受。',
      suggested_rewrite: suggestedRewrite,
    };
  }

  return fallbackRecordSuggestion(payload);
}

export function buildRelationReviewAssist(payload: ReviewRelationPayload): ReviewAssistSuggestion {
  if (payload.mode === 'confirmed_restore') {
    return {
      suggested_action: 'accept',
      suggested_reason: '这是已确认关系的恢复项，只要同批记录一起保留，就可以直接恢复 formal relation。',
      suggested_rewrite: null,
    };
  }

  return {
    suggested_action: 'accept',
    suggested_reason: '这是从稳定记录派生出的关系候选，接受后会进入现有关系候选链路继续审查。',
    suggested_rewrite: null,
  };
}

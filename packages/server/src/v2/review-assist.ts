import {
  canonicalizeDurableContent,
  isSpeculativeContent,
  isWeakConversationalProfileRule,
  matchConversationalProfileRule,
} from './contract.js';

export type ReviewSuggestedAction = 'accept' | 'reject' | 'edit';

export type ReviewAssistSuggestion = {
  suggested_action: ReviewSuggestedAction;
  suggested_reason: string;
  suggested_rewrite?: string | null;
};

type ReviewRecordPayload = Record<string, unknown>;
type ReviewRelationPayload = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asWarnings(payload: Record<string, unknown>): string[] {
  const warnings = payload.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0);
}

function supportsRewriteSourceType(sourceType: string | null): boolean {
  return sourceType === 'user_explicit' || sourceType === 'user_confirmed';
}

function canonicalRewriteFromText(
  payload: ReviewRecordPayload,
  sourceText: string,
): string | null {
  const normalizedKind = asString(payload.normalized_kind);
  const attributeKey = asString(payload.attribute_key);
  const ownerScope = asString(payload.owner_scope) === 'agent' ? 'agent' : 'user';
  const subjectKey = asString(payload.subject_key);
  const entityKey = asString(payload.entity_key);

  if (normalizedKind === 'profile_rule' && asString(payload.subject_key) === 'user') {
    if (isWeakConversationalProfileRule(sourceText)) {
      return null;
    }

    const conversationalMatch = matchConversationalProfileRule(sourceText);
    if (conversationalMatch && conversationalMatch.attribute_key === attributeKey) {
      return conversationalMatch.canonical_content;
    }

    return attributeKey
      ? canonicalizeDurableContent({
          kind: 'profile_rule',
          content: sourceText,
          owner_scope: ownerScope,
          subject_key: subjectKey,
          attribute_key: attributeKey,
        })
      : null;
  }

  if (normalizedKind === 'fact_slot') {
    return attributeKey
      ? canonicalizeDurableContent({
          kind: 'fact_slot',
          content: sourceText,
          entity_key: entityKey,
          attribute_key: attributeKey,
        })
      : null;
  }

  if (normalizedKind === 'task_state') {
    const stateKey = asString(payload.state_key);
    return stateKey
      ? canonicalizeDurableContent({
          kind: 'task_state',
          content: sourceText,
          subject_key: subjectKey,
          state_key: stateKey,
        })
      : null;
  }

  return null;
}

function buildSuggestedRewrite(payload: ReviewRecordPayload): string | null {
  const normalizedContent = asString(payload.content);
  if (normalizedContent) {
    const rewriteFromCandidate = canonicalRewriteFromText(payload, normalizedContent);
    if (rewriteFromCandidate) return rewriteFromCandidate;
  }

  const sourceText = asString(payload.source_excerpt);
  if (!sourceText) return null;
  return canonicalRewriteFromText(payload, sourceText);
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
    if (warnings.includes('mission_unclear')) {
      return {
        suggested_action: 'edit',
        suggested_reason: '这条候选本身已经接近 durable，但当前 mission 下是否该保留还不够明确，建议先人工审查后再决定是否接受。',
        suggested_rewrite: null,
      };
    }
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

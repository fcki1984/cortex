import { describe, expect, it } from 'vitest';
import {
  createReviewAssistRecordPayload,
  createReviewAssistRelationPayload,
} from './helpers/v2-contract-fixtures.js';
import {
  buildRecordReviewAssist,
  buildRelationReviewAssist,
} from '../src/v2/review-assist.js';

describe('review assist', () => {
  it('creates a safe rewrite for stable colloquial chinese language preference', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '以后都中文回答',
      source_excerpt: '以后都中文回答',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('请用中文回答');
  });

  it('keeps english language preference rewrites in english regardless of ui locale', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: 'Please answer in English',
      source_excerpt: 'Please answer in English',
      ui_locale: 'zh',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('Please answer in English');
  });

  it('creates a japanese language preference rewrite when the template exists', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '日本語で答えて',
      source_excerpt: '日本語で答えて',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('日本語で答えてください');
  });

  it('creates a safe rewrite for explicit response length constraints', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '最多三句话',
      source_excerpt: '最多三句话',
      attribute_key: 'response_length',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('请把回答控制在三句话内');
  });

  it('creates a safe rewrite for simple solution constraints', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '简单方案就行',
      source_excerpt: '简单方案就行',
      attribute_key: 'solution_complexity',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('不要复杂方案');
  });

  it('creates safe rewrites for additional constraint-style colloquial inputs', () => {
    const length = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '别超过三句话',
      source_excerpt: '别超过三句话',
      attribute_key: 'response_length',
    }));

    const complexity = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '轻量方案就行',
      source_excerpt: '轻量方案就行',
      attribute_key: 'solution_complexity',
    }));

    expect(length.suggested_action).toBe('accept');
    expect(length.suggested_rewrite).toBe('请把回答控制在三句话内');
    expect(complexity.suggested_action).toBe('accept');
    expect(complexity.suggested_rewrite).toBe('不要复杂方案');
  });

  it('creates safe rewrites for newly supported softer-worded explicit complexity constraints', () => {
    const simpler = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '方案简单一点',
      source_excerpt: '方案简单一点',
      attribute_key: 'solution_complexity',
    }));

    const lightweight = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '轻量方案即可',
      source_excerpt: '轻量方案即可',
      attribute_key: 'solution_complexity',
    }));

    expect(simpler.suggested_action).toBe('accept');
    expect(simpler.suggested_rewrite).toBe('不要复杂方案');
    expect(lightweight.suggested_action).toBe('accept');
    expect(lightweight.suggested_rewrite).toBe('不要复杂方案');
  });

  it('creates safe rewrites for additional explicit complexity phrasings', () => {
    const simpler = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '方案简单一些',
      source_excerpt: '方案简单一些',
      attribute_key: 'solution_complexity',
    }));

    const lighter = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '方案轻量一点',
      source_excerpt: '方案轻量一点',
      attribute_key: 'solution_complexity',
    }));

    expect(simpler.suggested_action).toBe('accept');
    expect(simpler.suggested_rewrite).toBe('不要复杂方案');
    expect(lighter.suggested_action).toBe('accept');
    expect(lighter.suggested_rewrite).toBe('不要复杂方案');
  });

  it('creates safe rewrites for additional explicit language and complexity short forms', () => {
    const language = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '后面中文就可以',
      source_excerpt: '后面中文就可以',
      attribute_key: 'language_preference',
    }));

    const complexity = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '方案简单些',
      source_excerpt: '方案简单些',
      attribute_key: 'solution_complexity',
    }));

    expect(language.suggested_action).toBe('accept');
    expect(language.suggested_rewrite).toBe('请用中文回答');
    expect(complexity.suggested_action).toBe('accept');
    expect(complexity.suggested_rewrite).toBe('不要复杂方案');
  });

  it('creates safe rewrites for structural colloquial "就可以" profile-rule forms', () => {
    const directLanguage = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '中文就可以',
      source_excerpt: '中文就可以',
      attribute_key: 'language_preference',
    }));

    const responseLength = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '三句话内就可以',
      source_excerpt: '三句话内就可以',
      attribute_key: 'response_length',
    }));

    const simpleOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '简单方案就可以',
      source_excerpt: '简单方案就可以',
      attribute_key: 'solution_complexity',
    }));

    const lightweightOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '轻量方案就可以',
      source_excerpt: '轻量方案就可以',
      attribute_key: 'solution_complexity',
    }));

    expect(directLanguage.suggested_action).toBe('accept');
    expect(directLanguage.suggested_rewrite).toBe('请用中文回答');
    expect(responseLength.suggested_action).toBe('accept');
    expect(responseLength.suggested_rewrite).toBe('请把回答控制在三句话内');
    expect(simpleOkay.suggested_action).toBe('accept');
    expect(simpleOkay.suggested_rewrite).toBe('不要复杂方案');
    expect(lightweightOkay.suggested_action).toBe('accept');
    expect(lightweightOkay.suggested_rewrite).toBe('不要复杂方案');
  });

  it('creates safe rewrites for structural colloquial "就好" profile-rule forms', () => {
    const directLanguage = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '中文就好',
      source_excerpt: '中文就好',
      attribute_key: 'language_preference',
    }));

    const responseLength = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '三句话内就好',
      source_excerpt: '三句话内就好',
      attribute_key: 'response_length',
    }));

    const simpleOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '简单方案就好',
      source_excerpt: '简单方案就好',
      attribute_key: 'solution_complexity',
    }));

    const lightweightOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '轻量方案就好',
      source_excerpt: '轻量方案就好',
      attribute_key: 'solution_complexity',
    }));

    expect(directLanguage.suggested_action).toBe('accept');
    expect(directLanguage.suggested_rewrite).toBe('请用中文回答');
    expect(responseLength.suggested_action).toBe('accept');
    expect(responseLength.suggested_rewrite).toBe('请把回答控制在三句话内');
    expect(simpleOkay.suggested_action).toBe('accept');
    expect(simpleOkay.suggested_rewrite).toBe('不要复杂方案');
    expect(lightweightOkay.suggested_action).toBe('accept');
    expect(lightweightOkay.suggested_rewrite).toBe('不要复杂方案');
  });

  it('creates safe rewrites for direct structural "就行 / 即可" language and length forms', () => {
    const languageOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '中文就行',
      source_excerpt: '中文就行',
      attribute_key: 'language_preference',
    }));

    const languageCan = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '中文即可',
      source_excerpt: '中文即可',
      attribute_key: 'language_preference',
    }));

    const responseLengthCan = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '三句话内即可',
      source_excerpt: '三句话内即可',
      attribute_key: 'response_length',
    }));

    expect(languageOkay.suggested_action).toBe('accept');
    expect(languageOkay.suggested_rewrite).toBe('请用中文回答');
    expect(languageCan.suggested_action).toBe('accept');
    expect(languageCan.suggested_rewrite).toBe('请用中文回答');
    expect(responseLengthCan.suggested_action).toBe('accept');
    expect(responseLengthCan.suggested_rewrite).toBe('请把回答控制在三句话内');
  });

  it('creates a safe rewrite for stable user location facts', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'fact_slot',
      normalized_kind: 'fact_slot',
      entity_key: 'user',
      attribute_key: 'location',
      subject_key: undefined,
      content: '现在住东京',
      source_excerpt: '现在住东京',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('我住东京');
  });

  it('creates a safe rewrite for stable user organization facts', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'fact_slot',
      normalized_kind: 'fact_slot',
      entity_key: 'user',
      attribute_key: 'organization',
      subject_key: undefined,
      content: '目前任职于 OpenAI',
      source_excerpt: '目前任职于 OpenAI',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('我在 OpenAI 工作');
  });

  it('supports the narrow cortex refactor task rewrite', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'task_state',
      normalized_kind: 'task_state',
      subject_key: 'cortex',
      attribute_key: undefined,
      state_key: 'refactor_status',
      status: 'active',
      content: '现在在做 Cortex recall 重构',
      source_excerpt: '现在在做 Cortex recall 重构',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('当前任务是重构 Cortex recall');
  });

  it('falls back to the normalized durable content for deep-only location review items', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'fact_slot',
      normalized_kind: 'fact_slot',
      entity_key: 'user',
      attribute_key: 'location',
      subject_key: undefined,
      content: '我住东京',
      source_excerpt: '人在东京这边',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('我住东京');
  });

  it('falls back to the normalized durable content for deep-only task-state review items', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'task_state',
      normalized_kind: 'task_state',
      subject_key: 'cortex',
      attribute_key: undefined,
      state_key: 'refactor_status',
      status: 'active',
      content: '当前任务是重构 Cortex recall',
      source_excerpt: '先收一下 recall 那块',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('当前任务是重构 Cortex recall');
  });

  it('does not emit rewrites for relation items', () => {
    const result = buildRelationReviewAssist(createReviewAssistRelationPayload());

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit durable rewrites for speculative notes', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'session_note',
      normalized_kind: 'session_note',
      attribute_key: undefined,
      content: '最近也许会考虑换方案',
      source_excerpt: '最近也许会考虑换方案',
    }));

    expect(result.suggested_action).toBe('edit');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });

  it('rejects assistant inferred durable candidates', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'fact_slot',
      normalized_kind: 'fact_slot',
      entity_key: 'user',
      attribute_key: 'organization',
      subject_key: undefined,
      content: '我在 OpenAI 工作',
      source_excerpt: '我在 OpenAI 工作',
      source_type: 'assistant_inferred',
    }));

    expect(result.suggested_action).toBe('reject');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });

  it('blocks rewrites whenever warnings are present', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '后续交流中文就行',
      source_excerpt: '后续交流中文就行',
      warnings: ['unstable_attribute'],
    }));

    expect(result.suggested_action).toBe('edit');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit auto-accept rewrites for weak colloquial preference language', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '最多三句话更好',
      source_excerpt: '最多三句话更好',
      attribute_key: 'response_length',
    }));

    expect(result.suggested_action).toBe('edit');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit auto-accept rewrites for newly hedged constraint-style inputs', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '轻量方案就行吧',
      source_excerpt: '轻量方案就行吧',
      attribute_key: 'solution_complexity',
    }));

    expect(result.suggested_action).toBe('edit');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit auto-accept rewrites for soft-priority colloquial inputs', () => {
    const language = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '尽量用中文',
      source_excerpt: '尽量用中文',
      attribute_key: 'language_preference',
    }));

    const complexity = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '尽量简单点',
      source_excerpt: '尽量简单点',
      attribute_key: 'solution_complexity',
    }));

    expect(language.suggested_action).toBe('edit');
    expect(language.suggested_rewrite ?? null).toBe(null);
    expect(complexity.suggested_action).toBe('edit');
    expect(complexity.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit auto-accept rewrites for newly hedged short colloquial variants', () => {
    const language = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '后面中文就可以吧',
      source_excerpt: '后面中文就可以吧',
      attribute_key: 'language_preference',
    }));

    const complexity = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '方案简单些吧',
      source_excerpt: '方案简单些吧',
      attribute_key: 'solution_complexity',
    }));

    expect(language.suggested_action).toBe('edit');
    expect(language.suggested_rewrite ?? null).toBe(null);
    expect(complexity.suggested_action).toBe('edit');
    expect(complexity.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit auto-accept rewrites for structural colloquial "就可以吧" variants', () => {
    const directLanguage = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '中文就可以吧',
      source_excerpt: '中文就可以吧',
      attribute_key: 'language_preference',
    }));

    const responseLength = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '三句话内就可以吧',
      source_excerpt: '三句话内就可以吧',
      attribute_key: 'response_length',
    }));

    const simpleOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '简单方案就可以吧',
      source_excerpt: '简单方案就可以吧',
      attribute_key: 'solution_complexity',
    }));

    const lightweightOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '轻量方案就可以吧',
      source_excerpt: '轻量方案就可以吧',
      attribute_key: 'solution_complexity',
    }));

    expect(directLanguage.suggested_action).toBe('edit');
    expect(directLanguage.suggested_rewrite ?? null).toBe(null);
    expect(responseLength.suggested_action).toBe('edit');
    expect(responseLength.suggested_rewrite ?? null).toBe(null);
    expect(simpleOkay.suggested_action).toBe('edit');
    expect(simpleOkay.suggested_rewrite ?? null).toBe(null);
    expect(lightweightOkay.suggested_action).toBe('edit');
    expect(lightweightOkay.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit auto-accept rewrites for structural colloquial "就好吧" variants', () => {
    const directLanguage = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '中文就好吧',
      source_excerpt: '中文就好吧',
      attribute_key: 'language_preference',
    }));

    const responseLength = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '三句话内就好吧',
      source_excerpt: '三句话内就好吧',
      attribute_key: 'response_length',
    }));

    const simpleOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '简单方案就好吧',
      source_excerpt: '简单方案就好吧',
      attribute_key: 'solution_complexity',
    }));

    const lightweightOkay = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '轻量方案就好吧',
      source_excerpt: '轻量方案就好吧',
      attribute_key: 'solution_complexity',
    }));

    expect(directLanguage.suggested_action).toBe('edit');
    expect(directLanguage.suggested_rewrite ?? null).toBe(null);
    expect(responseLength.suggested_action).toBe('edit');
    expect(responseLength.suggested_rewrite ?? null).toBe(null);
    expect(simpleOkay.suggested_action).toBe('edit');
    expect(simpleOkay.suggested_rewrite ?? null).toBe(null);
    expect(lightweightOkay.suggested_action).toBe('edit');
    expect(lightweightOkay.suggested_rewrite ?? null).toBe(null);
  });

  it('does not emit auto-accept rewrites for direct structural "即可吧" language and length variants', () => {
    const language = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '中文即可吧',
      source_excerpt: '中文即可吧',
      attribute_key: 'language_preference',
    }));

    const responseLength = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '三句话内即可吧',
      source_excerpt: '三句话内即可吧',
      attribute_key: 'response_length',
    }));

    expect(language.suggested_action).toBe('edit');
    expect(language.suggested_rewrite ?? null).toBe(null);
    expect(responseLength.suggested_action).toBe('edit');
    expect(responseLength.suggested_rewrite ?? null).toBe(null);
  });

  it('falls back to reason-only guidance for unsupported stable values', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      attribute_key: 'response_length',
      content: '请尽量简短一点',
      source_excerpt: '请尽量简短一点',
    }));

    expect(result.suggested_action).toBe('edit');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });

  it('blocks speculative durable rewrites even when the key looks durable', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      requested_kind: 'fact_slot',
      normalized_kind: 'fact_slot',
      entity_key: 'user',
      attribute_key: 'organization',
      subject_key: undefined,
      content: '我可能在 OpenAI',
      source_excerpt: '我可能在 OpenAI',
    }));

    expect(result.suggested_action).toBe('edit');
    expect(result.suggested_rewrite ?? null).toBe(null);
  });
});

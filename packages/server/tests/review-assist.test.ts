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
      content: '后续交流中文就行',
      source_excerpt: '后续交流中文就行',
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
      content: '回答控制在三句话内',
      source_excerpt: '回答控制在三句话内',
      attribute_key: 'response_length',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('请把回答控制在三句话内');
  });

  it('creates a safe rewrite for simple solution constraints', () => {
    const result = buildRecordReviewAssist(createReviewAssistRecordPayload({
      content: '方案别太复杂',
      source_excerpt: '方案别太复杂',
      attribute_key: 'solution_complexity',
    }));

    expect(result.suggested_action).toBe('accept');
    expect(result.suggested_rewrite).toBe('不要复杂方案');
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

import { vi } from 'vitest';
import type { LLMProvider } from '../../src/llm/interface.js';

export function createReviewAssistRecordPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: 'review_record_1',
    selected: true,
    requested_kind: 'profile_rule',
    normalized_kind: 'profile_rule',
    content: '请用中文回答',
    source_type: 'user_explicit',
    subject_key: 'user',
    attribute_key: 'language_preference',
    source_excerpt: '请用中文回答',
    confidence: 0.82,
    warnings: [],
    ...overrides,
  };
}

export function createReviewAssistRelationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: 'review_relation_1',
    selected: true,
    subject_key: 'user',
    predicate: 'lives_in',
    object_key: 'tokyo',
    mode: 'candidate',
    source_excerpt: '我住东京',
    confidence: 0.79,
    warnings: [],
    ...overrides,
  };
}

export function createNoOpLLM(): LLMProvider {
  return {
    name: 'no-op-llm',
    complete: vi.fn().mockResolvedValue('{"records":[],"nothing_extracted":true}'),
  };
}

export function createContractDriftMockLLM(): LLMProvider {
  return {
    name: 'contract-drift-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('请用中文回答')) {
        return JSON.stringify({
          records: [{
            kind: 'session_note',
            source_type: 'user_explicit',
            summary: '请用中文回答',
            priority: 0.5,
            confidence: 0.7,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('当前任务是重构 Cortex recall')) {
        return JSON.stringify({
          records: [{
            kind: 'session_note',
            source_type: 'user_explicit',
            summary: '当前任务是重构 Cortex recall',
            priority: 0.55,
            confidence: 0.72,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('最近也许会考虑换方案')) {
        return JSON.stringify({
          records: [{
            kind: 'task_state',
            source_type: 'user_explicit',
            subject_key: 'cortex',
            state_key: 'project_status',
            status: 'planned',
            summary: '最近也许会考虑换方案',
            priority: 0.7,
            confidence: 0.83,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

export function createConflictingDurableMockLLM(): LLMProvider {
  return {
    name: 'conflicting-durable-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('请用中文回答')) {
        return JSON.stringify({
          records: [{
            kind: 'task_state',
            source_type: 'user_explicit',
            subject_key: 'cortex',
            state_key: 'project_status',
            status: 'active',
            summary: '请用中文回答',
            priority: 0.72,
            confidence: 0.88,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('我在 OpenAI 工作')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'persona_style',
            value_text: '我在 OpenAI 工作',
            priority: 0.7,
            confidence: 0.86,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

export function createPrecisionFirstDriftMockLLM(): LLMProvider {
  return {
    name: 'precision-first-drift-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('这个方向先别定')) {
        return JSON.stringify({
          records: [{
            kind: 'task_state',
            source_type: 'user_explicit',
            subject_key: 'cortex',
            state_key: 'current_decision',
            status: 'open',
            summary: '这个方向先别定',
            priority: 0.71,
            confidence: 0.88,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

export function createReviewInboxDurableMockLLM(): LLMProvider {
  return {
    name: 'review-inbox-durable-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('把输出语言设成中文')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.76,
            confidence: 0.83,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

export function createReviewInboxResponseStyleMockLLM(): LLMProvider {
  return {
    name: 'review-inbox-response-style-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('说话干脆一点')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_style',
            value_text: '回答尽量简洁直接',
            priority: 0.73,
            confidence: 0.81,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

export function createReviewInboxCompoundDurableMockLLM(): LLMProvider {
  return {
    name: 'review-inbox-compound-durable-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('人在东京这边')) {
        return JSON.stringify({
          records: [{
            kind: 'fact_slot',
            source_type: 'user_explicit',
            entity_key: 'user',
            attribute_key: 'location',
            value_text: '我住东京',
            priority: 0.74,
            confidence: 0.82,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('先收一下 recall 那块')) {
        return JSON.stringify({
          records: [{
            kind: 'task_state',
            source_type: 'user_explicit',
            subject_key: 'cortex',
            state_key: 'refactor_status',
            status: 'active',
            summary: '当前任务是重构 Cortex recall',
            priority: 0.72,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

export function createWeakColloquialProfileRuleDriftMockLLM(): LLMProvider {
  return {
    name: 'weak-colloquial-profile-rule-drift-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('中文就行吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.74,
            confidence: 0.82,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('中文即可吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.74,
            confidence: 0.82,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('可能简单点更好')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.7,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('三句就够了吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.72,
            confidence: 0.81,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('以后都中文回答就行吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.75,
            confidence: 0.82,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('最多三句话更好')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.71,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('简单方案就行吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.7,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('别超过三句话更好')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.72,
            confidence: 0.81,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('简单方案即可吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.7,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('轻量方案就行吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.69,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('尽量用中文')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.72,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('尽量别超过三句话')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.71,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('尽量简单点')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.7,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('后面中文就可以吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.72,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('中文就可以吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.72,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('中文就好吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '请用中文回答',
            priority: 0.72,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('三句话内就可以吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.72,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('三句话内即可吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.72,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('三句话内就好吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.72,
            confidence: 0.8,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('方案简单些吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.7,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('简单方案就可以吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.7,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('简单方案就好吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.7,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('轻量方案就可以吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.69,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      if (prompt.includes('轻量方案就好吧')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'solution_complexity',
            value_text: '不要复杂方案',
            priority: 0.69,
            confidence: 0.79,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

export function createReviewInboxColloquialMockLLM(): LLMProvider {
  return {
    name: 'review-inbox-colloquial-mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('后续交流中文就行')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'language_preference',
            value_text: '后续交流中文就行',
            priority: 0.76,
            confidence: 0.83,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

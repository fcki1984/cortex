import { describe, expect, it } from 'vitest';
import {
  V2_CONTRACT_CANONICAL_CASES,
  extractFactRelationObjectValue,
  relationPredicateForFactAttribute,
  shouldApplyRequestedKindHint,
  splitCompoundClauses,
} from '../src/v2/contract.js';
import { normalizeManualInput } from '../src/v2/normalize.js';

describe('V2 shared atomic contract', () => {
  it('exposes a single atomic decision helper for canonical contract cases', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const resolveAtomicContractDecision = (contractModule as Record<string, unknown>).resolveAtomicContractDecision;

    expect(typeof resolveAtomicContractDecision).toBe('function');

    for (const sample of V2_CONTRACT_CANONICAL_CASES) {
      const decision = (resolveAtomicContractDecision as (input: string) => Record<string, unknown>)(sample.input);
      expect(decision.requested_kind).toBe(sample.requested_kind);
      expect(decision.attribute_key ?? null).toBe(sample.attribute_key ?? null);
      expect(decision.state_key ?? null).toBe(sample.state_key ?? null);
      expect(decision.relation_predicate ?? null).toBe(sample.relation_predicate ?? null);
    }
  });

  it('keeps manual normalization aligned with the shared atomic decision helper', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const resolveAtomicContractDecision = (contractModule as Record<string, unknown>).resolveAtomicContractDecision as
      | ((input: string) => Record<string, unknown>)
      | undefined;

    expect(typeof resolveAtomicContractDecision).toBe('function');

    for (const sample of V2_CONTRACT_CANONICAL_CASES) {
      const normalized = normalizeManualInput(`contract-manual-${sample.output}`, {
        content: sample.input,
      });
      const decision = resolveAtomicContractDecision!(sample.input);

      expect(normalized.requested_kind).toBe(decision.requested_kind);
      expect(normalized.written_kind).toBe(sample.written_kind);
      expect(
        normalized.candidate.kind === 'profile_rule' || normalized.candidate.kind === 'fact_slot'
          ? normalized.candidate.attribute_key
          : null,
      ).toBe(sample.attribute_key ?? null);
      expect(
        normalized.candidate.kind === 'task_state'
          ? normalized.candidate.state_key
          : null,
      ).toBe(sample.state_key ?? null);
    }
  });

  it('keeps speculative content and mismatched hints out of durable atomic decisions', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const resolveAtomicContractDecision = (contractModule as Record<string, unknown>).resolveAtomicContractDecision as
      | ((input: string) => Record<string, unknown>)
      | undefined;

    expect(typeof resolveAtomicContractDecision).toBe('function');

    const speculative = resolveAtomicContractDecision!('最近也许会考虑换方案');
    expect(speculative.requested_kind).toBe('session_note');
    expect(speculative.relation_predicate ?? null).toBe(null);
    expect(speculative.speculative).toBe(true);

    expect(shouldApplyRequestedKindHint('请用中文回答', 'profile_rule')).toBe(true);
    expect(shouldApplyRequestedKindHint('请用中文回答', 'task_state')).toBe(false);
    expect(shouldApplyRequestedKindHint('最近也许会考虑换方案', 'task_state')).toBe(false);
  });

  it('splits compound input on conservative clause boundaries only', () => {
    expect(splitCompoundClauses('我住大阪。请用中文回答；当前任务是重构 Cortex recall')).toEqual([
      '我住大阪',
      '请用中文回答',
      '当前任务是重构 Cortex recall',
    ]);

    expect(splitCompoundClauses('我住大阪，然后请用中文回答')).toEqual([
      '我住大阪，然后请用中文回答',
    ]);
  });

  it('canonicalizes stable colloquial explicit inputs into durable shared-contract truth', () => {
    const samples = [
      {
        input: '以后都中文回答',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      },
      {
        input: '后续交流中文就行',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      },
      {
        input: 'Use English from now on',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: 'Please answer in English',
      },
      {
        input: '三句话内就行',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在三句话内',
      },
      {
        input: '三句就够',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在三句话内',
      },
      {
        input: '最多三句话',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在三句话内',
      },
      {
        input: '别超过三句话',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在三句话内',
      },
      {
        input: 'Three sentences max',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: 'Please keep answers within three sentences',
      },
      {
        input: 'Keep answers under three sentences',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: 'Please keep answers within three sentences',
      },
      {
        input: 'Please answer within three sentences',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: 'Please keep answers within three sentences',
      },
      {
        input: 'Keep replies to three sentences',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: 'Please keep answers within three sentences',
      },
      {
        input: '方案简单点',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: 'Keep it simple',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: 'Please avoid complex solutions',
      },
      {
        input: 'Use a simple approach',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: 'Please avoid complex solutions',
      },
      {
        input: 'Be concise and direct',
        written_kind: 'profile_rule',
        attribute_key: 'response_style',
        content: 'Please keep responses concise and direct',
      },
      {
        input: 'Respond directly and concisely',
        written_kind: 'profile_rule',
        attribute_key: 'response_style',
        content: 'Please keep responses concise and direct',
      },
      {
        input: "Don't make it too complex",
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: 'Please avoid complex solutions',
      },
      {
        input: '别整复杂方案',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '简单方案就行',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '简单方案即可',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '轻量方案就行',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '方案简单一点',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '轻量方案即可',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '方案简单一些',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '方案轻量一点',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '后面中文就可以',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      },
      {
        input: '中文就可以',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      },
      {
        input: '中文就行',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      },
      {
        input: '中文即可',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      },
      {
        input: '中文就好',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      },
      {
        input: '日本語で答えて',
        written_kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '日本語で答えてください',
      },
      {
        input: '三句话内就可以',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在三句话内',
      },
      {
        input: '三句话内即可',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在三句话内',
      },
      {
        input: '三句话内就好',
        written_kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在三句话内',
      },
      {
        input: '方案简单些',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '简单方案就可以',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '简单方案就好',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '轻量方案就可以',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: '轻量方案就好',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
      },
      {
        input: 'Use the simplest approach',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: 'Please avoid complex solutions',
      },
      {
        input: 'Keep the approach lightweight',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: 'Please avoid complex solutions',
      },
    ] as const;

    for (const sample of samples) {
      const normalized = normalizeManualInput(`contract-colloquial-${sample.attribute_key}`, {
        content: sample.input,
      });

      expect(normalized.written_kind).toBe(sample.written_kind);
      expect(normalized.candidate.kind).toBe(sample.written_kind);
      expect(
        normalized.candidate.kind === 'profile_rule' || normalized.candidate.kind === 'fact_slot'
          ? normalized.candidate.attribute_key
          : null,
      ).toBe(sample.attribute_key);
      expect(
        normalized.candidate.kind === 'profile_rule' || normalized.candidate.kind === 'fact_slot'
          ? normalized.candidate.value_text
          : normalized.candidate.summary
      ).toBe(sample.content);
    }
  });

  it('canonicalizes accepted colloquial fact and task inputs without relying on deep extraction', () => {
    const samples = [
      {
        input: '人在东京这边',
        written_kind: 'fact_slot',
        attribute_key: 'location',
        state_key: null,
        content: '我住东京',
      },
      {
        input: "I'm living in Tokyo",
        written_kind: 'fact_slot',
        attribute_key: 'location',
        state_key: null,
        content: 'I live in Tokyo',
      },
      {
        input: "I'm located in Tokyo",
        written_kind: 'fact_slot',
        attribute_key: 'location',
        state_key: null,
        content: 'I live in Tokyo',
      },
      {
        input: 'I reside in Tokyo',
        written_kind: 'fact_slot',
        attribute_key: 'location',
        state_key: null,
        content: 'I live in Tokyo',
      },
      {
        input: 'Currently residing in Tokyo',
        written_kind: 'fact_slot',
        attribute_key: 'location',
        state_key: null,
        content: 'I live in Tokyo',
      },
      {
        input: '先收一下 recall 那块',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      },
      {
        input: '先做部署',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'deployment_status',
        content: '当前任务是部署 Cortex',
      },
      {
        input: '先迁移一下',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'migration_status',
        content: '当前任务是迁移 Cortex',
      },
      {
        input: 'Current task is migrating Cortex',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'migration_status',
        content: '当前任务是迁移 Cortex',
      },
      {
        input: 'Current task is deploying Cortex',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'deployment_status',
        content: '当前任务是部署 Cortex',
      },
      {
        input: 'Current task is refactoring Cortex recall',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      },
      {
        input: 'Current task is recall refactor',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      },
      {
        input: 'Current task is rewriting Cortex recall',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      },
      {
        input: "I'm employed by OpenAI",
        written_kind: 'fact_slot',
        attribute_key: 'organization',
        state_key: null,
        content: 'I work at OpenAI',
      },
      {
        input: 'Currently employed at OpenAI',
        written_kind: 'fact_slot',
        attribute_key: 'organization',
        state_key: null,
        content: 'I work at OpenAI',
      },
    ] as const;

    for (const sample of samples) {
      const normalized = normalizeManualInput(`contract-colloquial-extra-${sample.input}`, {
        content: sample.input,
      });

      expect(normalized.written_kind).toBe(sample.written_kind);
      expect(normalized.candidate.kind).toBe(sample.written_kind);
      expect(
        normalized.candidate.kind === 'profile_rule' || normalized.candidate.kind === 'fact_slot'
          ? normalized.candidate.attribute_key
          : null,
      ).toBe(sample.attribute_key);
      expect(
        normalized.candidate.kind === 'task_state'
          ? normalized.candidate.state_key
          : null,
      ).toBe(sample.state_key);
      expect(
        normalized.candidate.kind === 'profile_rule' || normalized.candidate.kind === 'fact_slot'
          ? normalized.candidate.value_text
          : normalized.candidate.summary,
      ).toBe(sample.content);
    }
  });

  it('keeps deployment and migration task-state samples in the shared canonical contract examples', () => {
    expect(V2_CONTRACT_CANONICAL_CASES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        input: '方案尽量简单点',
        requested_kind: 'profile_rule',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
      }),
      expect.objectContaining({
        input: '在 OpenAI 上班',
        requested_kind: 'fact_slot',
        written_kind: 'fact_slot',
        attribute_key: 'organization',
      }),
      expect.objectContaining({
        input: '目前在 OpenAI 上班',
        requested_kind: 'fact_slot',
        written_kind: 'fact_slot',
        attribute_key: 'organization',
      }),
      expect.objectContaining({
        input: '当前任务是部署 Cortex',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'deployment_status',
      }),
      expect.objectContaining({
        input: '先做部署',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'deployment_status',
      }),
      expect.objectContaining({
        input: '当前任务是迁移 Cortex',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'migration_status',
      }),
      expect.objectContaining({
        input: '先迁移一下',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'migration_status',
      }),
      expect.objectContaining({
        input: 'Current task is migrating Cortex',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'migration_status',
      }),
      expect.objectContaining({
        input: 'Current task is deploying Cortex',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'deployment_status',
      }),
      expect.objectContaining({
        input: 'Current task is refactoring Cortex recall',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'refactor_status',
      }),
      expect.objectContaining({
        input: 'Current task is rewriting Cortex recall',
        requested_kind: 'task_state',
        written_kind: 'task_state',
        state_key: 'refactor_status',
      }),
    ]));
  });

  it('exposes a shared colloquial profile-rule helper with weak-language gating', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const matchConversationalProfileRule = (contractModule as Record<string, unknown>).matchConversationalProfileRule as
      | ((input: string) => Record<string, unknown> | null)
      | undefined;

    expect(typeof matchConversationalProfileRule).toBe('function');

    expect(matchConversationalProfileRule!('后续交流中文就行')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('以后都中文回答')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('之后都用中文')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Use English from now on')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: 'Please answer in English',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('三句话内就行')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: '请把回答控制在三句话内',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('三句就够')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: '请把回答控制在三句话内',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('最多三句话')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: '请把回答控制在三句话内',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('别超过三句话')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: '请把回答控制在三句话内',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Three sentences max')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: 'Please keep answers within three sentences',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Please answer within three sentences')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: 'Please keep answers within three sentences',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Keep replies to three sentences')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: 'Please keep answers within three sentences',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('方案简单点')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('别整复杂方案')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('简单方案就行')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('简单方案即可')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('轻量方案就行')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('方案简单一点')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Keep it simple')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: 'Please avoid complex solutions',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('轻量方案即可')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('方案简单一些')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('方案轻量一点')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('后面中文就可以')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('中文就可以')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('中文就行')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('中文即可')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('中文就好')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('日本語で答えて')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '日本語で答えてください',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('后面都说中文')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('之后都讲中文')).toEqual(expect.objectContaining({
      attribute_key: 'language_preference',
      canonical_content: '请用中文回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('三句话内就可以')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: '请把回答控制在三句话内',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('三句话内即可')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: '请把回答控制在三句话内',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('三句话内就好')).toEqual(expect.objectContaining({
      attribute_key: 'response_length',
      canonical_content: '请把回答控制在三句话内',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('方案简单些')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('简单方案就可以')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('简单方案就好')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Use the simplest approach')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: 'Please avoid complex solutions',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Keep the approach lightweight')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: 'Please avoid complex solutions',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('轻量方案就可以')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('轻量方案就好')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('方案尽量简单点')).toEqual(expect.objectContaining({
      attribute_key: 'solution_complexity',
      canonical_content: '不要复杂方案',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('说话干脆一点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('说话干脆点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('说话利索点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('讲话干脆点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('讲话利索点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('表达干脆点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('表达利落点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('讲干脆点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('讲利索点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('说得利索点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Be concise and direct')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: 'Please keep responses concise and direct',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('Respond directly and concisely')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: 'Please keep responses concise and direct',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('说话直接一点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'review',
    }));

    expect(matchConversationalProfileRule!('说话直接点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'review',
    }));

    expect(matchConversationalProfileRule!('讲直接点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'review',
    }));

    expect(matchConversationalProfileRule!('讲话直接点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'review',
    }));

    expect(matchConversationalProfileRule!('Be direct')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: 'Please keep responses concise and direct',
      disposition: 'review',
    }));

    expect(matchConversationalProfileRule!('Reply more directly')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: 'Please keep responses concise and direct',
      disposition: 'review',
    }));

    expect(matchConversationalProfileRule!('回答风格简洁直接')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('简洁直接一点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'auto_commit',
    }));

    expect(matchConversationalProfileRule!('中文就行吧')).toBe(null);
    expect(matchConversationalProfileRule!('以后都中文回答就行吧')).toBe(null);
    expect(matchConversationalProfileRule!('三句就够了吧')).toBe(null);
    expect(matchConversationalProfileRule!('最多三句话更好')).toBe(null);
    expect(matchConversationalProfileRule!('别超过三句话更好')).toBe(null);
    expect(matchConversationalProfileRule!('尽量用中文')).toBe(null);
    expect(matchConversationalProfileRule!('优先用中文回答')).toBe(null);
    expect(matchConversationalProfileRule!('尽量别超过三句话')).toBe(null);
    expect(matchConversationalProfileRule!('尽量简单点')).toBe(null);
    expect(matchConversationalProfileRule!('优先简单点')).toBe(null);
    expect(matchConversationalProfileRule!('中文就可以吧')).toBe(null);
    expect(matchConversationalProfileRule!('中文即可吧')).toBe(null);
    expect(matchConversationalProfileRule!('中文就好吧')).toBe(null);
    expect(matchConversationalProfileRule!('后面中文就可以吧')).toBe(null);
    expect(matchConversationalProfileRule!('三句话内就可以吧')).toBe(null);
    expect(matchConversationalProfileRule!('三句话内即可吧')).toBe(null);
    expect(matchConversationalProfileRule!('三句话内就好吧')).toBe(null);
    expect(matchConversationalProfileRule!('方案简单些吧')).toBe(null);
    expect(matchConversationalProfileRule!('简单方案就可以吧')).toBe(null);
    expect(matchConversationalProfileRule!('简单方案就好吧')).toBe(null);
    expect(matchConversationalProfileRule!('轻量方案就可以吧')).toBe(null);
    expect(matchConversationalProfileRule!('轻量方案就好吧')).toBe(null);
    expect(matchConversationalProfileRule!('可能简单点更好')).toBe(null);
    expect(matchConversationalProfileRule!('简单方案就行吧')).toBe(null);
    expect(matchConversationalProfileRule!('简单方案即可吧')).toBe(null);
    expect(matchConversationalProfileRule!('轻量方案就行吧')).toBe(null);
    expect(matchConversationalProfileRule!('回答短一点')).toBe(null);
    expect(matchConversationalProfileRule!('回复短一点')).toBe(null);
    expect(matchConversationalProfileRule!('简单些就行')).toBe(null);
    expect(matchConversationalProfileRule!('先别搞复杂')).toBe(null);
    expect(matchConversationalProfileRule!('直接讲中文')).toBe(null);
    expect(matchConversationalProfileRule!('直接点说')).toBe(null);
    expect(matchConversationalProfileRule!('先说重点')).toBe(null);
  });

  it('drives strong and weak profile-rule aliases from a shared alias set', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const aliasSets = (contractModule as Record<string, unknown>).V2_CONTRACT_PROFILE_RULE_ALIAS_SETS as
      | Array<Record<string, unknown>>
      | undefined;

    expect(Array.isArray(aliasSets)).toBe(true);
    expect(aliasSets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attribute_key: 'language_preference',
        canonical_content: '请用中文回答',
        strong_inputs: expect.arrayContaining([
          '之后都用中文',
          '后面都用中文',
        ]),
      }),
      expect.objectContaining({
        attribute_key: 'response_length',
        canonical_content: '请把回答控制在三句话内',
        strong_inputs: expect.arrayContaining([
          '控制在三句内',
        ]),
      }),
      expect.objectContaining({
        attribute_key: 'solution_complexity',
        canonical_content: '不要复杂方案',
      }),
      expect.objectContaining({
        attribute_key: 'response_style',
        canonical_content: '请简洁直接回答',
        disposition: 'auto_commit',
        strong_inputs: expect.arrayContaining([
          '讲话干脆点',
          '讲话利索点',
        ]),
      }),
      expect.objectContaining({
        attribute_key: 'response_style',
        canonical_content: '请简洁直接回答',
        disposition: 'review',
        strong_inputs: expect.arrayContaining([
          '讲话直接点',
        ]),
      }),
    ]));

    for (const aliasSet of aliasSets ?? []) {
      const strongInputs = Array.isArray(aliasSet.strong_inputs) ? aliasSet.strong_inputs as string[] : [];
      const weakInputs = Array.isArray(aliasSet.weak_inputs) ? aliasSet.weak_inputs as string[] : [];
      const attributeKey = aliasSet.attribute_key;
      const canonicalContent = aliasSet.canonical_content;

      expect(strongInputs.length).toBeGreaterThan(0);

      for (const input of strongInputs) {
        const normalized = normalizeManualInput(`contract-alias-strong-${String(attributeKey)}-${input}`, {
          content: input,
        });

        expect(normalized.written_kind).toBe('profile_rule');
        expect(normalized.candidate.kind).toBe('profile_rule');
        expect(normalized.candidate.attribute_key).toBe(attributeKey);
        expect(normalized.candidate.value_text).toBe(canonicalContent);
      }

      for (const input of weakInputs) {
        const normalized = normalizeManualInput(`contract-alias-weak-${String(attributeKey)}-${input}`, {
          content: input,
        });

        expect(normalized.written_kind).toBe('session_note');
      }
    }
  });

  it('keeps colloquial explicit fact follow-ups relation-safe after canonicalization', () => {
    const samples = [
      {
        input: '目前任职于 OpenAI',
        content: '我在 OpenAI 工作',
      },
      {
        input: '在 OpenAI 上班',
        content: '我在 OpenAI 工作',
      },
      {
        input: '目前在 OpenAI 上班',
        content: '我在 OpenAI 工作',
      },
      {
        input: "I'm working at OpenAI",
        content: 'I work at OpenAI',
      },
    ];

    for (const sample of samples) {
      const normalized = normalizeManualInput('contract-colloquial-fact', {
        content: sample.input,
      });

      expect(normalized.written_kind).toBe('fact_slot');
      expect(normalized.candidate.kind).toBe('fact_slot');
      expect(normalized.candidate.attribute_key).toBe('organization');
      expect(normalized.candidate.value_text).toBe(sample.content);
      expect(relationPredicateForFactAttribute(normalized.candidate.attribute_key)).toBe('works_at');
      expect(extractFactRelationObjectValue(normalized.candidate.attribute_key, normalized.candidate.value_text)).toBe('OpenAI');
    }
  });

  it('extends short proposal selection to keep deterministic solution-complexity follow-ups', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const inferShortUserProposalSelection = (contractModule as Record<string, unknown>).inferShortUserProposalSelection as
      | ((input: string) => {
          keep_profile_rule_attributes: string[];
          drop_profile_rule_attributes: string[];
          drop_all: boolean;
        } | null)
      | undefined;

    expect(typeof inferShortUserProposalSelection).toBe('function');
    expect(inferShortUserProposalSelection!('就简单点')).toEqual({
      keep_profile_rule_attributes: ['solution_complexity'],
      drop_profile_rule_attributes: [],
      drop_all: false,
    });
    expect(inferShortUserProposalSelection!('只保留回答风格')).toEqual({
      keep_profile_rule_attributes: ['response_style'],
      drop_profile_rule_attributes: [],
      drop_all: false,
    });
    expect(inferShortUserProposalSelection!('不要回答风格')).toEqual({
      keep_profile_rule_attributes: [],
      drop_profile_rule_attributes: ['response_style'],
      drop_all: false,
    });
  });

  it('extends short proposal rewrites to support compact response-length updates', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const inferShortUserProposalRewrite = (contractModule as Record<string, unknown>).inferShortUserProposalRewrite as
      | ((input: string) => { synthesized_content: string } | null)
      | undefined;

    expect(typeof inferShortUserProposalRewrite).toBe('function');
    expect(inferShortUserProposalRewrite!('改两句')).toEqual({
      synthesized_content: '请把回答控制在两句话内',
    });
  });

  it('extends attribute-aware short rewrites to support explicit response-style restatements', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const inferShortUserProfileRuleAttributeRewrite = (contractModule as Record<string, unknown>).inferShortUserProfileRuleAttributeRewrite as
      | ((attributeKey: string, input: string) => { synthesized_content: string } | null)
      | undefined;

    expect(typeof inferShortUserProfileRuleAttributeRewrite).toBe('function');
    expect(inferShortUserProfileRuleAttributeRewrite!('response_style', '简洁直接一点')).toEqual({
      synthesized_content: '请简洁直接回答',
    });
  });

  it('extends short fact rewrites to support bilingual locations and Chinese organization names', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const inferShortUserFactSlotRewrite = (contractModule as Record<string, unknown>).inferShortUserFactSlotRewrite as
      | ((attributeKey: string, input: string) => { synthesized_content: string } | null)
      | undefined;

    expect(typeof inferShortUserFactSlotRewrite).toBe('function');
    expect(inferShortUserFactSlotRewrite!('location', '改 Tokyo')).toEqual({
      synthesized_content: '我住Tokyo',
    });
    expect(inferShortUserFactSlotRewrite!('organization', '换 腾讯')).toEqual({
      synthesized_content: '我在 腾讯 工作',
    });
    expect(inferShortUserFactSlotRewrite!('location', '还是东京吧')).toEqual({
      synthesized_content: '我住东京',
    });
    expect(inferShortUserFactSlotRewrite!('organization', '还是 Anthropic 吧')).toEqual({
      synthesized_content: '我在 Anthropic 工作',
    });
    expect(inferShortUserFactSlotRewrite!('location', '不要这个')).toBe(null);
    expect(inferShortUserFactSlotRewrite!('location', '都去掉')).toBe(null);
  });

  it('extends short task-state rewrites to support compact cortex workflow updates', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const inferShortUserTaskStateRewrite = (contractModule as Record<string, unknown>).inferShortUserTaskStateRewrite as
      | ((subjectKey: string, input: string) => { synthesized_content: string } | null)
      | undefined;

    expect(typeof inferShortUserTaskStateRewrite).toBe('function');
    expect(inferShortUserTaskStateRewrite!('cortex', '改部署')).toEqual({
      synthesized_content: '当前任务是部署 Cortex',
    });
    expect(inferShortUserTaskStateRewrite!('cortex', '换迁移')).toEqual({
      synthesized_content: '当前任务是迁移 Cortex',
    });
    expect(inferShortUserTaskStateRewrite!('cortex', '还是部署吧')).toEqual({
      synthesized_content: '当前任务是部署 Cortex',
    });
    expect(inferShortUserTaskStateRewrite!('cortex', '还是迁移吧')).toEqual({
      synthesized_content: '当前任务是迁移 Cortex',
    });
    expect(inferShortUserTaskStateRewrite!('user', '改部署')).toBe(null);
  });

  it('extends short fact selection to support symmetrical keep-drop and drop-all follow-ups', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const inferShortUserFactSelection = (contractModule as Record<string, unknown>).inferShortUserFactSelection as
      | ((input: string) => {
          keep_fact_attributes: string[];
          drop_fact_attributes: string[];
          drop_all: boolean;
        } | null)
      | undefined;

    expect(typeof inferShortUserFactSelection).toBe('function');
    expect(inferShortUserFactSelection!('就公司，别记住址')).toEqual({
      keep_fact_attributes: ['organization'],
      drop_fact_attributes: ['location'],
      drop_all: false,
    });
    expect(inferShortUserFactSelection!('都不要')).toEqual({
      keep_fact_attributes: [],
      drop_fact_attributes: [],
      drop_all: true,
    });
  });

  it('extends short task selection to keep the prior assistant proposed current task', async () => {
    const contractModule = await import('../src/v2/contract.js');
    const inferShortUserTaskSelection = (contractModule as Record<string, unknown>).inferShortUserTaskSelection as
      | ((input: string) => { keep_current_task: boolean } | null)
      | undefined;

    expect(typeof inferShortUserTaskSelection).toBe('function');
    expect(inferShortUserTaskSelection!('只保留当前任务')).toEqual({
      keep_current_task: true,
    });
    expect(inferShortUserTaskSelection!('只保留中文')).toBe(null);
  });
});

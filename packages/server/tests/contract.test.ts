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
        input: '方案简单点',
        written_kind: 'profile_rule',
        attribute_key: 'solution_complexity',
        content: '不要复杂方案',
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
        input: '先收一下 recall 那块',
        written_kind: 'task_state',
        attribute_key: null,
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
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

    expect(matchConversationalProfileRule!('说话干脆一点')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'review',
    }));

    expect(matchConversationalProfileRule!('回答风格简洁直接')).toEqual(expect.objectContaining({
      attribute_key: 'response_style',
      canonical_content: '请简洁直接回答',
      disposition: 'review',
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
      }),
      expect.objectContaining({
        attribute_key: 'response_length',
        canonical_content: '请把回答控制在三句话内',
      }),
      expect.objectContaining({
        attribute_key: 'solution_complexity',
        canonical_content: '不要复杂方案',
      }),
      expect.objectContaining({
        attribute_key: 'response_style',
        canonical_content: '请简洁直接回答',
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
    const normalized = normalizeManualInput('contract-colloquial-fact', {
      content: '目前任职于 OpenAI',
    });

    expect(normalized.written_kind).toBe('fact_slot');
    expect(normalized.candidate.kind).toBe('fact_slot');
    expect(normalized.candidate.attribute_key).toBe('organization');
    expect(normalized.candidate.value_text).toBe('我在 OpenAI 工作');
    expect(relationPredicateForFactAttribute(normalized.candidate.attribute_key)).toBe('works_at');
    expect(extractFactRelationObjectValue(normalized.candidate.attribute_key, normalized.candidate.value_text)).toBe('OpenAI');
  });
});

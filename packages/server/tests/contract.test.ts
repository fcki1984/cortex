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

    expect(matchConversationalProfileRule!('中文就行吧')).toBe(null);
    expect(matchConversationalProfileRule!('三句就够了吧')).toBe(null);
    expect(matchConversationalProfileRule!('可能简单点更好')).toBe(null);
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

import { describe, expect, it } from 'vitest';
import {
  V2_CONTRACT_CANONICAL_CASES,
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
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, initDatabase } from '../src/db/index.js';
import { deleteAgent, ensureAgent, insertAgent } from '../src/db/agent-queries.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import type { LLMProvider } from '../src/llm/interface.js';
import { V2_CONTRACT_CANONICAL_CASES } from '../src/v2/contract.js';
import { CortexRelationsV2 } from '../src/v2/relations.js';
import { V2_EXTRACTION_SYSTEM_PROMPT } from '../src/v2/prompts.js';
import { CortexRecordsV2 } from '../src/v2/service.js';
import { buildCanonicalExportBundle, confirmImport, previewImport } from '../src/v2/import-export.js';
import {
  createConflictingDurableMockLLM,
  createContractDriftMockLLM,
  createNoOpLLM,
  createPrecisionFirstDriftMockLLM,
  createWeakColloquialProfileRuleDriftMockLLM,
} from './helpers/v2-contract-fixtures.js';

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock-embedding',
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([]),
    embedBatch: vi.fn().mockResolvedValue([]),
  };
}

function createImportPreviewMockLLM(): LLMProvider {
  return {
    name: 'mock-llm',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('请把回答控制在三句话内')) {
        return JSON.stringify({
          records: [{
            kind: 'profile_rule',
            source_type: 'user_explicit',
            owner_scope: 'user',
            subject_key: 'user',
            attribute_key: 'response_length',
            value_text: '请把回答控制在三句话内',
            priority: 0.82,
            confidence: 0.94,
          }],
          nothing_extracted: false,
        });
      }

      return '{"records":[],"nothing_extracted":true}';
    }),
  };
}

async function createServices(llm: LLMProvider = createImportPreviewMockLLM()) {
  initDatabase(':memory:');
  const records = new CortexRecordsV2(llm, createMockEmbedding());
  await records.initialize();
  const relations = new CortexRelationsV2();
  return { records, relations, llm };
}

afterEach(() => {
  closeDatabase();
});

describe('V2 Import / Export', () => {
  it('documents the v2 extraction contract with stable and tentative examples', () => {
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('请用中文回答');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('请把回答控制在三句话内');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句就够');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('别整复杂方案');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('方案简单一点');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('轻量方案即可');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('方案简单一些');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('方案轻量一点');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('后面中文就可以');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文就可以');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文就行');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文即可');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文就好');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句话内就可以');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句话内即可');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句话内就好');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('方案简单些');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('简单方案就可以');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('简单方案就好');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('轻量方案就可以');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('轻量方案就好');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文就行吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文就可以吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文即可吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('中文就好吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句就够了吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句话内就可以吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句话内即可吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('三句话内就好吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('可能简单点更好');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('尽量用中文');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('尽量别超过三句话');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('尽量简单点');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('后面中文就可以吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('方案简单些吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('简单方案就可以吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('简单方案就好吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('轻量方案就可以吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('轻量方案就好吧');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('我在 OpenAI 工作');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('当前任务是重构 Cortex recall');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('最近也许会考虑换方案');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('If the only evidence is assistant interpretation, emit session_note with source_type assistant_inferred instead of a durable record.');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('Do not collapse compound inputs into a single vague summary.');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('If multiple clauses set the same stable key, keep only the later winner.');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('Do not keep superseded earlier durable records.');
  });

  it('uses deep extraction for plain text preview candidates', async () => {
    const { records } = await createServices();

    const preview = await previewImport(records, {
      agent_id: 'import-preview-text',
      format: 'text',
      content: '请把回答控制在三句话内',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.requested_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('response_length');
  });

  it('uses deep extraction for MEMORY.md preview candidates', async () => {
    const { records } = await createServices();

    const preview = await previewImport(records, {
      agent_id: 'import-preview-memory-md',
      format: 'memory_md',
      content: [
        '# MEMORY.md',
        '',
        '## Profile Rules',
        '- 请把回答控制在三句话内',
      ].join('\n'),
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.requested_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('response_length');
  });

  it('lets content-driven durable inference override mismatched MEMORY.md heading hints', async () => {
    const { records } = await createServices();

    const preview = await previewImport(records, {
      agent_id: 'import-preview-memory-md-mismatch',
      format: 'memory_md',
      content: [
        '# MEMORY.md',
        '',
        '## Task States',
        '- 请用中文回答',
      ].join('\n'),
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.requested_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('falls back to deterministic durable preview candidates when deep extraction drifts to session_note', async () => {
    const { records } = await createServices(createContractDriftMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-language-drift',
      format: 'text',
      content: '请用中文回答',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('language_preference');
  });

  it('prefers deterministic durable preview candidates over conflicting deep durable output for atomic text', async () => {
    const { records } = await createServices(createConflictingDurableMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-durable-conflict',
      format: 'text',
      content: '请用中文回答',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('infers response-length preview candidates without relying on deep extraction output', async () => {
    const { records } = await createServices({
      name: 'no-op-llm',
      complete: vi.fn().mockResolvedValue('{"records":[],"nothing_extracted":true}'),
    });

    const preview = await previewImport(records, {
      agent_id: 'import-preview-response-length-fallback',
      format: 'text',
      content: '请把回答控制在三句话内',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('response_length');
  });

  it('keeps speculative import preview content as session_note even when deep extraction proposes a durable state', async () => {
    const { records } = await createServices(createContractDriftMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-speculative-drift',
      format: 'text',
      content: '最近也许会考虑换方案',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('keeps weak colloquial preference preview content as session_note even when deep extraction proposes a durable rule', async () => {
    const { records } = await createServices(createWeakColloquialProfileRuleDriftMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-language',
      format: 'text',
      content: '中文就行吧',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(preview.record_candidates[0]?.content).toBe('中文就行吧');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('keeps weak colloquial complexity preview content as session_note even when deep extraction proposes a durable rule', async () => {
    const { records } = await createServices(createWeakColloquialProfileRuleDriftMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-complexity',
      format: 'text',
      content: '可能简单点更好',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(preview.record_candidates[0]?.content).toBe('可能简单点更好');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('keeps weak colloquial response-length preview content as session_note even when deep extraction proposes a durable rule', async () => {
    const { records } = await createServices(createWeakColloquialProfileRuleDriftMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-length',
      format: 'text',
      content: '三句就够了吧',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(preview.record_candidates[0]?.content).toBe('三句就够了吧');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('canonicalizes newly supported colloquial language preview content into a durable profile rule', async () => {
    const { records } = await createServices();

    const preview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-language-followup',
      format: 'text',
      content: '以后都中文回答',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(preview.record_candidates[0]?.content).toBe('请用中文回答');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('canonicalizes newly supported colloquial complexity preview content into a durable profile rule', async () => {
    const { records } = await createServices();

    const preview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-complexity-followup',
      format: 'text',
      content: '简单方案就行',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(preview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('keeps newly hedged colloquial language preview content as session_note even when deep extraction proposes a durable rule', async () => {
    const { records } = await createServices(createWeakColloquialProfileRuleDriftMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-language-followup',
      format: 'text',
      content: '以后都中文回答就行吧',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(preview.record_candidates[0]?.content).toBe('以后都中文回答就行吧');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('canonicalizes additional constraint-style colloquial preview content into durable profile rules', async () => {
    const { records } = await createServices();

    const lengthPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-length-cap',
      format: 'text',
      content: '别超过三句话',
    });

    expect(lengthPreview.record_candidates).toHaveLength(1);
    expect(lengthPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(lengthPreview.record_candidates[0]?.attribute_key).toBe('response_length');
    expect(lengthPreview.record_candidates[0]?.content).toBe('请把回答控制在三句话内');
    expect(lengthPreview.relation_candidates).toHaveLength(0);

    const complexityPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-lightweight',
      format: 'text',
      content: '轻量方案就行',
    });

    expect(complexityPreview.record_candidates).toHaveLength(1);
    expect(complexityPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(complexityPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(complexityPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(complexityPreview.relation_candidates).toHaveLength(0);

    const softerComplexityPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-simple-a-bit',
      format: 'text',
      content: '方案简单一点',
    });

    expect(softerComplexityPreview.record_candidates).toHaveLength(1);
    expect(softerComplexityPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(softerComplexityPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(softerComplexityPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(softerComplexityPreview.relation_candidates).toHaveLength(0);

    const lightweightOkayPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-lightweight-okay',
      format: 'text',
      content: '轻量方案即可',
    });

    expect(lightweightOkayPreview.record_candidates).toHaveLength(1);
    expect(lightweightOkayPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(lightweightOkayPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(lightweightOkayPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(lightweightOkayPreview.relation_candidates).toHaveLength(0);

    const softerWordedPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-simple-somewhat',
      format: 'text',
      content: '方案简单一些',
    });

    expect(softerWordedPreview.record_candidates).toHaveLength(1);
    expect(softerWordedPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(softerWordedPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(softerWordedPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(softerWordedPreview.relation_candidates).toHaveLength(0);

    const lighterPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-light-somewhat',
      format: 'text',
      content: '方案轻量一点',
    });

    expect(lighterPreview.record_candidates).toHaveLength(1);
    expect(lighterPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(lighterPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(lighterPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(lighterPreview.relation_candidates).toHaveLength(0);

    const shorterLanguagePreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-language-can',
      format: 'text',
      content: '后面中文就可以',
    });

    expect(shorterLanguagePreview.record_candidates).toHaveLength(1);
    expect(shorterLanguagePreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(shorterLanguagePreview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(shorterLanguagePreview.record_candidates[0]?.content).toBe('请用中文回答');
    expect(shorterLanguagePreview.relation_candidates).toHaveLength(0);

    const shorterDirectLanguagePreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-language-short-can',
      format: 'text',
      content: '中文就可以',
    });

    expect(shorterDirectLanguagePreview.record_candidates).toHaveLength(1);
    expect(shorterDirectLanguagePreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(shorterDirectLanguagePreview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(shorterDirectLanguagePreview.record_candidates[0]?.content).toBe('请用中文回答');
    expect(shorterDirectLanguagePreview.relation_candidates).toHaveLength(0);

    const shorterDirectLanguageOkayPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-language-short-okay',
      format: 'text',
      content: '中文就行',
    });

    expect(shorterDirectLanguageOkayPreview.record_candidates).toHaveLength(1);
    expect(shorterDirectLanguageOkayPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(shorterDirectLanguageOkayPreview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(shorterDirectLanguageOkayPreview.record_candidates[0]?.content).toBe('请用中文回答');
    expect(shorterDirectLanguageOkayPreview.relation_candidates).toHaveLength(0);

    const shorterDirectLanguageCanPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-language-short-can-2',
      format: 'text',
      content: '中文即可',
    });

    expect(shorterDirectLanguageCanPreview.record_candidates).toHaveLength(1);
    expect(shorterDirectLanguageCanPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(shorterDirectLanguageCanPreview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(shorterDirectLanguageCanPreview.record_candidates[0]?.content).toBe('请用中文回答');
    expect(shorterDirectLanguageCanPreview.relation_candidates).toHaveLength(0);

    const shorterLengthPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-length-short-can',
      format: 'text',
      content: '三句话内就可以',
    });

    expect(shorterLengthPreview.record_candidates).toHaveLength(1);
    expect(shorterLengthPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(shorterLengthPreview.record_candidates[0]?.attribute_key).toBe('response_length');
    expect(shorterLengthPreview.record_candidates[0]?.content).toBe('请把回答控制在三句话内');
    expect(shorterLengthPreview.relation_candidates).toHaveLength(0);

    const shorterLengthCanPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-length-short-can-2',
      format: 'text',
      content: '三句话内即可',
    });

    expect(shorterLengthCanPreview.record_candidates).toHaveLength(1);
    expect(shorterLengthCanPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(shorterLengthCanPreview.record_candidates[0]?.attribute_key).toBe('response_length');
    expect(shorterLengthCanPreview.record_candidates[0]?.content).toBe('请把回答控制在三句话内');
    expect(shorterLengthCanPreview.relation_candidates).toHaveLength(0);

    const shorterComplexityPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-simple-short',
      format: 'text',
      content: '方案简单些',
    });

    expect(shorterComplexityPreview.record_candidates).toHaveLength(1);
    expect(shorterComplexityPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(shorterComplexityPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(shorterComplexityPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(shorterComplexityPreview.relation_candidates).toHaveLength(0);

    const simpleOkayPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-simple-okay',
      format: 'text',
      content: '简单方案就可以',
    });

    expect(simpleOkayPreview.record_candidates).toHaveLength(1);
    expect(simpleOkayPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(simpleOkayPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(simpleOkayPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(simpleOkayPreview.relation_candidates).toHaveLength(0);

    const lightweightOkayCanPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-lightweight-can',
      format: 'text',
      content: '轻量方案就可以',
    });

    expect(lightweightOkayCanPreview.record_candidates).toHaveLength(1);
    expect(lightweightOkayCanPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(lightweightOkayCanPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(lightweightOkayCanPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(lightweightOkayCanPreview.relation_candidates).toHaveLength(0);

    const directLanguageGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-language-short-good',
      format: 'text',
      content: '中文就好',
    });

    expect(directLanguageGoodPreview.record_candidates).toHaveLength(1);
    expect(directLanguageGoodPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(directLanguageGoodPreview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(directLanguageGoodPreview.record_candidates[0]?.content).toBe('请用中文回答');
    expect(directLanguageGoodPreview.relation_candidates).toHaveLength(0);

    const lengthGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-length-short-good',
      format: 'text',
      content: '三句话内就好',
    });

    expect(lengthGoodPreview.record_candidates).toHaveLength(1);
    expect(lengthGoodPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(lengthGoodPreview.record_candidates[0]?.attribute_key).toBe('response_length');
    expect(lengthGoodPreview.record_candidates[0]?.content).toBe('请把回答控制在三句话内');
    expect(lengthGoodPreview.relation_candidates).toHaveLength(0);

    const simpleGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-simple-good',
      format: 'text',
      content: '简单方案就好',
    });

    expect(simpleGoodPreview.record_candidates).toHaveLength(1);
    expect(simpleGoodPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(simpleGoodPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(simpleGoodPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(simpleGoodPreview.relation_candidates).toHaveLength(0);

    const lightweightGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-lightweight-good',
      format: 'text',
      content: '轻量方案就好',
    });

    expect(lightweightGoodPreview.record_candidates).toHaveLength(1);
    expect(lightweightGoodPreview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(lightweightGoodPreview.record_candidates[0]?.attribute_key).toBe('solution_complexity');
    expect(lightweightGoodPreview.record_candidates[0]?.content).toBe('不要复杂方案');
    expect(lightweightGoodPreview.relation_candidates).toHaveLength(0);
  });

  it('keeps newly hedged constraint-style colloquial preview content as session_note even when deep extraction proposes a durable rule', async () => {
    const { records } = await createServices(createWeakColloquialProfileRuleDriftMockLLM());

    const lengthPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-length-cap',
      format: 'text',
      content: '别超过三句话更好',
    });

    expect(lengthPreview.record_candidates).toHaveLength(1);
    expect(lengthPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(lengthPreview.record_candidates[0]?.content).toBe('别超过三句话更好');
    expect(lengthPreview.relation_candidates).toHaveLength(0);

    const complexityPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-lightweight',
      format: 'text',
      content: '轻量方案就行吧',
    });

    expect(complexityPreview.record_candidates).toHaveLength(1);
    expect(complexityPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(complexityPreview.record_candidates[0]?.content).toBe('轻量方案就行吧');
    expect(complexityPreview.relation_candidates).toHaveLength(0);

    const softLanguagePreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-soft-language',
      format: 'text',
      content: '尽量用中文',
    });

    expect(softLanguagePreview.record_candidates).toHaveLength(1);
    expect(softLanguagePreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(softLanguagePreview.record_candidates[0]?.content).toBe('尽量用中文');
    expect(softLanguagePreview.relation_candidates).toHaveLength(0);

    const softLengthPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-soft-length',
      format: 'text',
      content: '尽量别超过三句话',
    });

    expect(softLengthPreview.record_candidates).toHaveLength(1);
    expect(softLengthPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(softLengthPreview.record_candidates[0]?.content).toBe('尽量别超过三句话');
    expect(softLengthPreview.relation_candidates).toHaveLength(0);

    const softComplexityPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-soft-complexity',
      format: 'text',
      content: '尽量简单点',
    });

    expect(softComplexityPreview.record_candidates).toHaveLength(1);
    expect(softComplexityPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(softComplexityPreview.record_candidates[0]?.content).toBe('尽量简单点');
    expect(softComplexityPreview.relation_candidates).toHaveLength(0);

    const hedgedLanguagePreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-language-can',
      format: 'text',
      content: '后面中文就可以吧',
    });

    expect(hedgedLanguagePreview.record_candidates).toHaveLength(1);
    expect(hedgedLanguagePreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedLanguagePreview.record_candidates[0]?.content).toBe('后面中文就可以吧');
    expect(hedgedLanguagePreview.relation_candidates).toHaveLength(0);

    const hedgedDirectLanguagePreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-direct-language-can',
      format: 'text',
      content: '中文就可以吧',
    });

    expect(hedgedDirectLanguagePreview.record_candidates).toHaveLength(1);
    expect(hedgedDirectLanguagePreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedDirectLanguagePreview.record_candidates[0]?.content).toBe('中文就可以吧');
    expect(hedgedDirectLanguagePreview.relation_candidates).toHaveLength(0);

    const hedgedDirectLanguageCanPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-direct-language-can-2',
      format: 'text',
      content: '中文即可吧',
    });

    expect(hedgedDirectLanguageCanPreview.record_candidates).toHaveLength(1);
    expect(hedgedDirectLanguageCanPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedDirectLanguageCanPreview.record_candidates[0]?.content).toBe('中文即可吧');
    expect(hedgedDirectLanguageCanPreview.relation_candidates).toHaveLength(0);

    const hedgedDirectLanguageGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-direct-language-good',
      format: 'text',
      content: '中文就好吧',
    });

    expect(hedgedDirectLanguageGoodPreview.record_candidates).toHaveLength(1);
    expect(hedgedDirectLanguageGoodPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedDirectLanguageGoodPreview.record_candidates[0]?.content).toBe('中文就好吧');
    expect(hedgedDirectLanguageGoodPreview.relation_candidates).toHaveLength(0);

    const hedgedLengthCanPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-length-can',
      format: 'text',
      content: '三句话内就可以吧',
    });

    expect(hedgedLengthCanPreview.record_candidates).toHaveLength(1);
    expect(hedgedLengthCanPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedLengthCanPreview.record_candidates[0]?.content).toBe('三句话内就可以吧');
    expect(hedgedLengthCanPreview.relation_candidates).toHaveLength(0);

    const hedgedLengthCanPreview2 = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-length-can-2',
      format: 'text',
      content: '三句话内即可吧',
    });

    expect(hedgedLengthCanPreview2.record_candidates).toHaveLength(1);
    expect(hedgedLengthCanPreview2.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedLengthCanPreview2.record_candidates[0]?.content).toBe('三句话内即可吧');
    expect(hedgedLengthCanPreview2.relation_candidates).toHaveLength(0);

    const hedgedLengthGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-length-good',
      format: 'text',
      content: '三句话内就好吧',
    });

    expect(hedgedLengthGoodPreview.record_candidates).toHaveLength(1);
    expect(hedgedLengthGoodPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedLengthGoodPreview.record_candidates[0]?.content).toBe('三句话内就好吧');
    expect(hedgedLengthGoodPreview.relation_candidates).toHaveLength(0);

    const hedgedComplexityPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-simple-short',
      format: 'text',
      content: '方案简单些吧',
    });

    expect(hedgedComplexityPreview.record_candidates).toHaveLength(1);
    expect(hedgedComplexityPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedComplexityPreview.record_candidates[0]?.content).toBe('方案简单些吧');
    expect(hedgedComplexityPreview.relation_candidates).toHaveLength(0);

    const hedgedSimpleOkayPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-simple-okay',
      format: 'text',
      content: '简单方案就可以吧',
    });

    expect(hedgedSimpleOkayPreview.record_candidates).toHaveLength(1);
    expect(hedgedSimpleOkayPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedSimpleOkayPreview.record_candidates[0]?.content).toBe('简单方案就可以吧');
    expect(hedgedSimpleOkayPreview.relation_candidates).toHaveLength(0);

    const hedgedSimpleGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-simple-good',
      format: 'text',
      content: '简单方案就好吧',
    });

    expect(hedgedSimpleGoodPreview.record_candidates).toHaveLength(1);
    expect(hedgedSimpleGoodPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedSimpleGoodPreview.record_candidates[0]?.content).toBe('简单方案就好吧');
    expect(hedgedSimpleGoodPreview.relation_candidates).toHaveLength(0);

    const hedgedLightweightCanPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-lightweight-can',
      format: 'text',
      content: '轻量方案就可以吧',
    });

    expect(hedgedLightweightCanPreview.record_candidates).toHaveLength(1);
    expect(hedgedLightweightCanPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedLightweightCanPreview.record_candidates[0]?.content).toBe('轻量方案就可以吧');
    expect(hedgedLightweightCanPreview.relation_candidates).toHaveLength(0);

    const hedgedLightweightGoodPreview = await previewImport(records, {
      agent_id: 'import-preview-weak-colloquial-lightweight-good',
      format: 'text',
      content: '轻量方案就好吧',
    });

    expect(hedgedLightweightGoodPreview.record_candidates).toHaveLength(1);
    expect(hedgedLightweightGoodPreview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(hedgedLightweightGoodPreview.record_candidates[0]?.content).toBe('轻量方案就好吧');
    expect(hedgedLightweightGoodPreview.relation_candidates).toHaveLength(0);
  });

  it('canonicalizes colloquial response-length preview content into a durable profile rule', async () => {
    const { records } = await createServices();

    const preview = await previewImport(records, {
      agent_id: 'import-preview-colloquial-length',
      format: 'text',
      content: '三句就够',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('response_length');
    expect(preview.record_candidates[0]?.content).toBe('请把回答控制在三句话内');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('prunes deep durable preview drift when the explicit input does not support a stable key', async () => {
    const { records } = await createServices(createPrecisionFirstDriftMockLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-precision-first-drift',
      format: 'text',
      content: '这个方向先别定',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('session_note');
    expect(preview.record_candidates[0]?.content).toBe('这个方向先别定');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('does not duplicate confirmed restore relations with derived candidates in canonical preview', async () => {
    const { records, relations } = await createServices();

    await records.remember({
      agent_id: 'canonical-export-source',
      kind: 'fact_slot',
      content: '我住大阪',
    });

    const candidates = relations.listCandidates({ agent_id: 'canonical-export-source' });
    expect(candidates.items).toHaveLength(1);
    relations.confirmCandidate(candidates.items[0]!.id);

    const bundle = buildCanonicalExportBundle(records, relations, {
      scope: 'current_agent',
      agent_id: 'canonical-export-source',
    });

    const preview = await previewImport(records, {
      agent_id: 'canonical-export-target',
      format: 'json',
      content: JSON.stringify(bundle),
    });

    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.mode).toBe('confirmed_restore');
  });

  it('restores confirmed relations without leaving duplicate pending candidates after import confirm', async () => {
    const { records, relations } = await createServices();

    await records.remember({
      agent_id: 'canonical-export-source',
      kind: 'fact_slot',
      content: '我住大阪',
    });

    const sourceCandidates = relations.listCandidates({ agent_id: 'canonical-export-source' });
    expect(sourceCandidates.items).toHaveLength(1);
    relations.confirmCandidate(sourceCandidates.items[0]!.id);

    const bundle = buildCanonicalExportBundle(records, relations, {
      scope: 'current_agent',
      agent_id: 'canonical-export-source',
    });

    const preview = await previewImport(records, {
      agent_id: 'canonical-export-target',
      format: 'json',
      content: JSON.stringify(bundle),
    });

    const confirmed = await confirmImport(records, relations, {
      agent_id: 'canonical-export-target',
      record_candidates: preview.record_candidates,
      relation_candidates: preview.relation_candidates,
    });

    expect(confirmed.summary.relation_candidates_created).toBe(0);
    expect(confirmed.summary.confirmed_relations_restored).toBe(1);
    expect(relations.listRelations({ agent_id: 'canonical-export-target' }).items).toHaveLength(1);
    expect(relations.listCandidates({ agent_id: 'canonical-export-target', status: 'pending' }).items).toHaveLength(0);
  });

  it('only derives relation candidates from stable fact slots', async () => {
    const { records, relations } = await createServices();

    await records.remember({
      agent_id: 'relation-contract-agent',
      kind: 'task_state',
      content: '当前任务是重构 Cortex recall',
    });

    const candidates = relations.listCandidates({ agent_id: 'relation-contract-agent' });
    expect(candidates.items).toHaveLength(0);
  });

  it('keeps organization facts durable and tentative ideas as session notes in text preview', async () => {
    const { records } = await createServices();

    const preview = await previewImport(records, {
      agent_id: 'import-preview-mixed',
      format: 'text',
      content: [
        '我在 OpenAI 工作',
        '最近也许会考虑换方案',
      ].join('\n'),
    });

    expect(preview.record_candidates).toHaveLength(2);
    expect(preview.record_candidates[0]?.requested_kind).toBe('fact_slot');
    expect(preview.record_candidates[0]?.normalized_kind).toBe('fact_slot');
    expect(preview.record_candidates[0]?.attribute_key).toBe('organization');
    expect(preview.record_candidates[1]?.requested_kind).toBe('session_note');
    expect(preview.record_candidates[1]?.normalized_kind).toBe('session_note');
    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.predicate).toBe('works_at');
    expect(preview.relation_candidates[0]?.object_key).toBe('openai');
  });

  it('keeps compound text preview aligned with clause-level durable winners', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-compound-durable',
      format: 'text',
      content: '我住大阪。请用中文回答。当前任务是重构 Cortex recall',
    });

    expect(preview.record_candidates).toHaveLength(3);
    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'fact_slot',
      'profile_rule',
      'task_state',
    ]);
    expect(preview.record_candidates[0]?.attribute_key).toBe('location');
    expect(preview.record_candidates[1]?.attribute_key).toBe('language_preference');
    expect(preview.record_candidates[2]?.state_key).toBe('refactor_status');
    expect(preview.relation_candidates.map((candidate) => candidate.predicate)).toEqual(['lives_in']);
  });

  it('keeps compound text preview aligned for speculative and durable mixed clauses', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-compound-mixed',
      format: 'text',
      content: '最近也许会考虑换方案。请用中文回答',
    });

    expect(preview.record_candidates).toHaveLength(2);
    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'session_note',
      'profile_rule',
    ]);
    expect(preview.record_candidates[1]?.attribute_key).toBe('language_preference');
    expect(preview.relation_candidates).toHaveLength(0);
  });

  it('keeps implicit user follow-up fact clauses durable after a speculative clause in text preview', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-compound-implicit-fact',
      format: 'text',
      content: '最近也许会考虑换方案。现在住东京',
    });

    expect(preview.record_candidates).toHaveLength(2);
    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'session_note',
      'fact_slot',
    ]);
    expect(preview.record_candidates[1]?.attribute_key).toBe('location');
    expect(preview.record_candidates[1]?.entity_key).toBe('user');
    expect(preview.record_candidates[1]?.content).toBe('我住东京');
    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.predicate).toBe('lives_in');
    expect(preview.relation_candidates[0]?.object_key).toBe('东京');
  });

  it('keeps implicit follow-up location variants durable after a speculative clause in text preview', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-compound-implicit-location-variant',
      format: 'text',
      content: '最近也许会考虑换方案。目前位于东京',
    });

    expect(preview.record_candidates).toHaveLength(2);
    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'session_note',
      'fact_slot',
    ]);
    expect(preview.record_candidates[1]?.attribute_key).toBe('location');
    expect(preview.record_candidates[1]?.entity_key).toBe('user');
    expect(preview.record_candidates[1]?.content).toBe('我住东京');
    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.predicate).toBe('lives_in');
    expect(preview.relation_candidates[0]?.object_key).toBe('东京');
  });

  it('keeps implicit follow-up organization variants durable after a speculative clause in text preview', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-compound-implicit-organization-variant',
      format: 'text',
      content: '最近也许会考虑换方案。目前任职于 OpenAI',
    });

    expect(preview.record_candidates).toHaveLength(2);
    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'session_note',
      'fact_slot',
    ]);
    expect(preview.record_candidates[1]?.attribute_key).toBe('organization');
    expect(preview.record_candidates[1]?.entity_key).toBe('user');
    expect(preview.record_candidates[1]?.content).toBe('我在 OpenAI 工作');
    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.predicate).toBe('works_at');
    expect(preview.relation_candidates[0]?.object_key).toBe('openai');
  });

  it('lets later compound clauses win when they supersede the same stable fact key', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-compound-conflict',
      format: 'text',
      content: '我住大阪。现在住东京',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('fact_slot');
    expect(preview.record_candidates[0]?.attribute_key).toBe('location');
    expect(preview.record_candidates[0]?.content).toBe('我住东京');
    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.predicate).toBe('lives_in');
    expect(preview.relation_candidates[0]?.object_key).toBe('东京');
  });

  it('keeps multiline text preview aligned with ingest winners across segment boundaries', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-multiline-conflict',
      format: 'text',
      content: ['我住大阪', '请用中文回答', '现在住东京'].join('\n'),
    });

    expect(preview.record_candidates).toHaveLength(2);
    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'profile_rule',
      'fact_slot',
    ]);
    expect(preview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(preview.record_candidates[1]?.content).toBe('我住东京');
    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.object_key).toBe('东京');
  });

  it('keeps MEMORY.md preview aligned when later segments supersede the same durable key', async () => {
    const { records } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'import-preview-memory-md-conflict',
      format: 'memory_md',
      content: [
        '# MEMORY.md',
        '',
        '## Fact Slots',
        '- 我住大阪',
        '- 现在住东京',
        '',
        '## Profile Rules',
        '- 请用中文回答',
      ].join('\n'),
    });

    expect(preview.record_candidates).toHaveLength(2);
    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'fact_slot',
      'profile_rule',
    ]);
    expect(preview.record_candidates[0]?.content).toBe('我住东京');
    expect(preview.record_candidates[0]?.attribute_key).toBe('location');
    expect(preview.record_candidates[1]?.attribute_key).toBe('language_preference');
    expect(preview.relation_candidates).toHaveLength(1);
    expect(preview.relation_candidates[0]?.object_key).toBe('东京');
  });

  it('keeps ingest aligned with deterministic task-state hints when deep extraction drifts', async () => {
    const { records, relations } = await createServices(createContractDriftMockLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-contract-drift',
      user_message: '当前任务是重构 Cortex recall',
      assistant_message: '记住了',
    });

    expect(ingested.records.some((item) => item.written_kind === 'task_state' && item.content.includes('重构 Cortex recall'))).toBe(true);
    expect(relations.listCandidates({ agent_id: 'ingest-contract-drift' }).items).toHaveLength(0);

    const recall = await records.recall({
      agent_id: 'ingest-contract-drift',
      query: 'What is the current task?',
    });
    expect(recall.task_state[0]?.content).toContain('重构 Cortex recall');
  });

  it('keeps text preview and ingest aligned with canonical contract samples', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    for (const [index, sample] of V2_CONTRACT_CANONICAL_CASES.entries()) {
      const preview = await previewImport(records, {
        agent_id: `contract-preview-${index}`,
        format: 'text',
        content: sample.input,
      });

      expect(preview.record_candidates).toHaveLength(1);
      expect(preview.record_candidates[0]?.requested_kind).toBe(sample.requested_kind);
      expect(preview.record_candidates[0]?.normalized_kind).toBe(sample.written_kind);
      expect(preview.record_candidates[0]?.attribute_key || null).toBe(sample.attribute_key || null);
      expect(preview.record_candidates[0]?.state_key || null).toBe(sample.state_key || null);
      expect(preview.relation_candidates.map((item) => item.predicate)).toEqual(
        sample.relation_predicate ? [sample.relation_predicate] : [],
      );

      const ingested = await records.ingest({
        agent_id: `contract-ingest-${index}`,
        user_message: sample.input,
        assistant_message: '记住了',
      });

      expect(ingested.records).toHaveLength(1);
      expect(ingested.records[0]?.requested_kind).toBe(sample.requested_kind);
      expect(ingested.records[0]?.written_kind).toBe(sample.written_kind);
      expect(relations.listCandidates({ agent_id: `contract-ingest-${index}` }).items.map((item) => item.predicate)).toEqual(
        sample.relation_predicate ? [sample.relation_predicate] : [],
      );
    }
  });

  it('canonicalizes colloquial stable preview and ingest inputs even without deep extraction help', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'contract-colloquial-preview',
      format: 'text',
      content: '后续交流中文就行',
    });

    expect(preview.record_candidates).toHaveLength(1);
    expect(preview.record_candidates[0]?.normalized_kind).toBe('profile_rule');
    expect(preview.record_candidates[0]?.attribute_key).toBe('language_preference');
    expect(preview.record_candidates[0]?.content).toBe('请用中文回答');
    expect(preview.relation_candidates).toHaveLength(0);

    const ingested = await records.ingest({
      agent_id: 'contract-colloquial-ingest',
      user_message: '后续交流中文就行',
      assistant_message: '收到',
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('profile_rule');
    expect(ingested.records[0]?.content).toBe('请用中文回答');
    expect(relations.listCandidates({ agent_id: 'contract-colloquial-ingest' }).items).toHaveLength(0);
  });

  it('keeps compound preview and ingest winners aligned when a speculative clause coexists with a stable colloquial preference', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const preview = await previewImport(records, {
      agent_id: 'contract-colloquial-compound-preview',
      format: 'text',
      content: '最近也许会考虑换方案。后续交流中文就行',
    });

    expect(preview.record_candidates.map((candidate) => candidate.normalized_kind)).toEqual([
      'session_note',
      'profile_rule',
    ]);
    expect(preview.record_candidates[0]?.content).toBe('最近也许会考虑换方案');
    expect(preview.record_candidates[1]?.content).toBe('请用中文回答');
    expect(preview.record_candidates[1]?.attribute_key).toBe('language_preference');

    const ingested = await records.ingest({
      agent_id: 'contract-colloquial-compound-ingest',
      user_message: '最近也许会考虑换方案。后续交流中文就行',
      assistant_message: '收到',
    });

    expect(ingested.records).toHaveLength(2);
    expect(ingested.records.map((record) => record.written_kind)).toEqual([
      'session_note',
      'profile_rule',
    ]);
    expect(ingested.records[1]?.content).toBe('请用中文回答');
    expect(relations.listCandidates({ agent_id: 'contract-colloquial-compound-ingest' }).items).toHaveLength(0);
  });

  it('prefers deterministic durable ingest candidates over conflicting deep durable output for atomic user input', async () => {
    const { records, relations } = await createServices(createConflictingDurableMockLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-durable-conflict',
      user_message: '我在 OpenAI 工作',
      assistant_message: '记住了',
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('fact_slot');
    expect(ingested.records[0]?.content).toContain('我在 OpenAI 工作');

    const relationCandidates = relations.listCandidates({ agent_id: 'ingest-durable-conflict' });
    expect(relationCandidates.items).toHaveLength(1);
    expect(relationCandidates.items[0]?.predicate).toBe('works_at');
  });

  it('prunes deep durable ingest drift when the explicit input does not support a stable key', async () => {
    const { records, relations } = await createServices(createPrecisionFirstDriftMockLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-precision-first-drift',
      user_message: '这个方向先别定',
      assistant_message: '记住了',
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('session_note');
    expect(ingested.records[0]?.content).toBe('这个方向先别定');
    expect(relations.listCandidates({ agent_id: 'ingest-precision-first-drift' }).items).toHaveLength(0);
  });

  it('treats a short user confirmation as user_confirmed durable when the prior assistant proposal has a single stable winner', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-confirmed-assistant-proposal',
      user_message: '好，就这么定',
      assistant_message: '收到',
      messages: [
        { role: 'assistant', content: '之后请始终用中文回答。' },
        { role: 'user', content: '好，就这么定' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('profile_rule');
    expect(ingested.records[0]?.source_type).toBe('user_confirmed');
    expect(ingested.records[0]?.content).toContain('中文回答');
    expect(relations.listCandidates({ agent_id: 'ingest-confirmed-assistant-proposal' }).items).toHaveLength(0);
  });

  it('keeps a short user confirmation as session_note when the prior assistant proposal contains multiple durable winners', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-confirmed-assistant-proposal-ambiguous',
      user_message: '好，就这么定',
      assistant_message: '收到',
      messages: [
        { role: 'assistant', content: '之后请始终用中文回答，并把回答控制在三句话内。' },
        { role: 'user', content: '好，就这么定' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('session_note');
    expect(ingested.records[0]?.source_type).toBe('user_explicit');
    expect(relations.listCandidates({ agent_id: 'ingest-confirmed-assistant-proposal-ambiguous' }).items).toHaveLength(0);
  });

  it('treats a short user rewrite as explicit durable when it disambiguates a prior assistant proposal', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-rewrite-assistant-proposal',
      user_message: '不，改成英文',
      assistant_message: '收到',
      messages: [
        { role: 'assistant', content: '之后请始终用中文回答，并把回答控制在三句话内。' },
        { role: 'user', content: '不，改成英文' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('profile_rule');
    expect(ingested.records[0]?.source_type).toBe('user_explicit');
    expect(ingested.records[0]?.content).toBe('Please answer in English');
    expect(relations.listCandidates({ agent_id: 'ingest-rewrite-assistant-proposal' }).items).toHaveLength(0);
  });

  it('keeps a short user rewrite as session_note when it does not provide a stable replacement', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-rewrite-assistant-proposal-unstable',
      user_message: '不，换一个',
      assistant_message: '收到',
      messages: [
        { role: 'assistant', content: '之后请始终用中文回答。' },
        { role: 'user', content: '不，换一个' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('session_note');
    expect(ingested.records[0]?.source_type).toBe('user_explicit');
    expect(relations.listCandidates({ agent_id: 'ingest-rewrite-assistant-proposal-unstable' }).items).toHaveLength(0);
  });

  it('keeps only language_preference when a short follow-up drops the response_length part of a prior proposal', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-selective-keep-language',
      user_message: '就中文，别加三句话限制',
      assistant_message: '收到',
      messages: [
        { role: 'assistant', content: '之后请始终用中文回答，并把回答控制在三句话内。' },
        { role: 'user', content: '就中文，别加三句话限制' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('profile_rule');
    expect(ingested.records[0]?.source_type).toBe('user_confirmed');
    expect(ingested.records[0]?.content).toContain('中文回答');
    expect(ingested.records[0]?.content).not.toContain('三句话');
    expect(relations.listCandidates({ agent_id: 'ingest-selective-keep-language' }).items).toHaveLength(0);
  });

  it('keeps only response_length when a short follow-up keeps the length constraint from a prior proposal', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-selective-keep-length',
      user_message: '只保留三句话限制',
      assistant_message: '收到',
      messages: [
        { role: 'assistant', content: '之后请始终用中文回答，并把回答控制在三句话内。' },
        { role: 'user', content: '只保留三句话限制' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('profile_rule');
    expect(ingested.records[0]?.source_type).toBe('user_confirmed');
    expect(ingested.records[0]?.content).toContain('三句话');
    expect(ingested.records[0]?.content).not.toContain('中文回答');
    expect(relations.listCandidates({ agent_id: 'ingest-selective-keep-length' }).items).toHaveLength(0);
  });

  it('keeps a short selective follow-up as session_note when it drops every stable winner', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-selective-drop-all',
      user_message: '都不要',
      assistant_message: '收到',
      messages: [
        { role: 'assistant', content: '之后请始终用中文回答，并把回答控制在三句话内。' },
        { role: 'user', content: '都不要' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('session_note');
    expect(ingested.records[0]?.source_type).toBe('user_explicit');
    expect(ingested.records[0]?.content).toBe('都不要');
    expect(relations.listCandidates({ agent_id: 'ingest-selective-drop-all' }).items).toHaveLength(0);
  });

  it('keeps ingest aligned with clause-level winners for compound user input', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-compound-durable',
      user_message: '我住大阪。请用中文回答。当前任务是重构 Cortex recall',
      assistant_message: '记住了',
    });

    expect(ingested.records).toHaveLength(3);
    expect(ingested.records.map((record) => record.written_kind)).toEqual([
      'fact_slot',
      'profile_rule',
      'task_state',
    ]);
    expect(relations.listCandidates({ agent_id: 'ingest-compound-durable' }).items.map((item) => item.predicate)).toEqual([
      'lives_in',
    ]);
  });

  it('lets later compound ingest clauses win when they supersede the same stable fact key', async () => {
    const { records, relations } = await createServices(createNoOpLLM());

    const ingested = await records.ingest({
      agent_id: 'ingest-compound-conflict',
      user_message: '我住大阪。现在住东京',
      assistant_message: '记住了',
    });

    expect(ingested.records).toHaveLength(1);
    expect(ingested.records[0]?.written_kind).toBe('fact_slot');
    expect(ingested.records[0]?.content).toBe('我住东京');

    const stored = records.listRecords({ agent_id: 'ingest-compound-conflict' }).items;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe('我住东京');
    expect(relations.listCandidates({ agent_id: 'ingest-compound-conflict' }).items.map((item) => item.object_key)).toEqual([
      '东京',
    ]);
  });

  it('excludes auto-created empty agents from all_agents export', async () => {
    const { records, relations } = await createServices();

    ensureAgent('probe-empty-agent');

    const bundle = buildCanonicalExportBundle(records, relations, {
      scope: 'all_agents',
    });

    const agentIds = bundle.agents.map((agent) => agent.id);
    expect(agentIds).toEqual(expect.arrayContaining(['default', 'mcp']));
    expect(agentIds).not.toContain('probe-empty-agent');
  });

  it('keeps manually created empty agents in all_agents export', async () => {
    const { records, relations } = await createServices();

    insertAgent({
      id: 'manual-empty-agent',
      name: 'Manual Empty Agent',
      description: 'Created intentionally for export scope',
    });

    const bundle = buildCanonicalExportBundle(records, relations, {
      scope: 'all_agents',
    });

    expect(bundle.agents.map((agent) => agent.id)).toContain('manual-empty-agent');
  });

  it('does not resurrect deleted agents or their truth data in all_agents export', async () => {
    const { records, relations } = await createServices();

    insertAgent({
      id: 'deleted-export-agent',
      name: 'Deleted Export Agent',
      description: 'Created for export regression coverage',
    });

    await records.remember({
      agent_id: 'deleted-export-agent',
      kind: 'fact_slot',
      content: '我住大阪',
    });

    const deletedCandidates = relations.listCandidates({ agent_id: 'deleted-export-agent' });
    expect(deletedCandidates.items).toHaveLength(1);
    relations.confirmCandidate(deletedCandidates.items[0]!.id);

    const deleted = deleteAgent('deleted-export-agent');
    expect(deleted.deleted).toBe(true);

    const bundle = buildCanonicalExportBundle(records, relations, {
      scope: 'all_agents',
    });

    expect(bundle.agents.map((agent) => agent.id)).not.toContain('deleted-export-agent');
    expect([
      ...bundle.records.profile_rules,
      ...bundle.records.fact_slots,
      ...bundle.records.task_states,
      ...bundle.records.session_notes,
    ].map((record) => record.agent_id)).not.toContain('deleted-export-agent');
    expect(bundle.confirmed_relations.map((relation) => relation.agent_id)).not.toContain('deleted-export-agent');
  });
});

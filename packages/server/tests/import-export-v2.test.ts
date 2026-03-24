import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, initDatabase } from '../src/db/index.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import type { LLMProvider } from '../src/llm/interface.js';
import { CortexRelationsV2 } from '../src/v2/relations.js';
import { CortexRecordsV2 } from '../src/v2/service.js';
import { buildCanonicalExportBundle, previewImport } from '../src/v2/import-export.js';

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
});

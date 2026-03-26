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

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock-embedding',
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([]),
    embedBatch: vi.fn().mockResolvedValue([]),
  };
}

function createNoOpLLM(): LLMProvider {
  return {
    name: 'no-op-llm',
    complete: vi.fn().mockResolvedValue('{"records":[],"nothing_extracted":true}'),
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

function createContractDriftMockLLM(): LLMProvider {
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

function createConflictingDurableMockLLM(): LLMProvider {
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
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('我在 OpenAI 工作');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('当前任务是重构 Cortex recall');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('最近也许会考虑换方案');
    expect(V2_EXTRACTION_SYSTEM_PROMPT).toContain('If the only evidence is assistant interpretation, emit session_note with source_type assistant_inferred instead of a durable record.');
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

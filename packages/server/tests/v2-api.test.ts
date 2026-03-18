import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase } from '../src/db/index.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';
import { CortexRecordsV2 } from '../src/v2/service.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';

function createVectorOnlyEmbedding(): EmbeddingProvider {
  const vector = [1, 0, 0, 0];
  return {
    name: 'vector-only-mock',
    dimensions: 4,
    embed: async (text: string) => {
      if (
        text.includes('我住大阪') ||
        text.includes('我喜欢简洁回答') ||
        text.includes('最近也许会考虑换方案') ||
        text.includes('最近是否要换方案')
      ) {
        return vector;
      }
      return [];
    },
    embedBatch: async (texts: string[]) => texts.map(text => {
      if (
        text.includes('我住大阪') ||
        text.includes('我喜欢简洁回答') ||
        text.includes('最近也许会考虑换方案') ||
        text.includes('最近是否要换方案')
      ) {
        return vector;
      }
      return [];
    }),
  };
}

describe('API V2 Integration', () => {
  let app: FastifyInstance;
  let cortex: CortexApp;

  beforeAll(async () => {
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
    });

    initDatabase(':memory:');
    cortex = new CortexApp(config);
    await cortex.initialize();

    app = Fastify();
    await app.register(cors, { origin: true });
    registerAllRoutes(app, cortex);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cortex.shutdown();
    closeDatabase();
  });

  it('creates and lists v2 records', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '用户住在东京',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-v2',
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.requested_kind).toBe('fact_slot');
    expect(createdBody.written_kind).toBe('fact_slot');
    expect(createdBody.normalization).toBe('durable');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=api-v2',
    });
    expect(listed.statusCode).toBe(200);
    const body = JSON.parse(listed.payload);
    expect(body.items.some((item: any) => item.content.includes('东京'))).toBe(true);
  });

  it('recalls grouped v2 records', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'profile_rule',
        content: 'Always answer in concise prose',
        owner_scope: 'agent',
        subject_key: 'agent',
        attribute_key: 'persona_style',
        source_type: 'system_derived',
        agent_id: 'api-recall',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '用户住在大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-recall',
      },
    });

    const recalled = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: '用户住在哪里', agent_id: 'api-recall' },
    });
    expect(recalled.statusCode).toBe(200);
    const body = JSON.parse(recalled.payload);
    expect(Array.isArray(body.facts)).toBe(true);
    expect(body.facts.some((item: any) => item.content.includes('大阪'))).toBe(true);
    expect(body.context).toContain('大阪');
  });

  it('returns structured recall metadata for cross-language durable matches and excludes unrelated notes', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-cross-language',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '最近也许会考虑换方案',
        agent_id: 'api-cross-language',
      },
    });

    const recalled = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'Where does the user live?', agent_id: 'api-cross-language' },
    });
    expect(recalled.statusCode).toBe(200);
    const body = JSON.parse(recalled.payload);
    expect(body.facts.some((item: any) => item.content.includes('大阪'))).toBe(true);
    expect(body.session_notes).toHaveLength(0);
    expect(body.meta.normalized_intents.attributes).toContain('location');
    expect(body.meta.durable_candidate_count).toBeGreaterThan(0);
    expect(Array.isArray(body.meta.relevance_basis)).toBe(true);
  });

  it('ingests v2 records from fast channel signals', async () => {
    const ingested = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        user_message: '我叫Harry，我住在东京',
        assistant_message: '记住了',
        agent_id: 'api-ingest',
      },
    });

    expect(ingested.statusCode).toBe(201);
    const body = JSON.parse(ingested.payload);
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records.every((item: any) => item.requested_kind && item.written_kind && item.normalization)).toBe(true);
  });

  it('filters extraction logs by v2 channel', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        user_message: '我喜欢简洁回答。',
        assistant_message: '记住了',
        agent_id: 'api-ingest-logs',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/extraction-logs?agent_id=api-ingest-logs&channel=v2&limit=5',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items.every((item: any) => item.channel === 'v2')).toBe(true);
  });

  it('returns downgrade metadata for ambiguous manual writes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '最近也许会考虑换方案',
        agent_id: 'api-downgrade',
      },
    });

    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload);
    expect(body.requested_kind).toBe('fact_slot');
    expect(body.written_kind).toBe('session_note');
    expect(body.normalization).toBe('downgraded_to_session_note');
    expect(body.reason_code).toBe('insufficient_structure');
    expect(body.record.kind).toBe('session_note');
  });

  it('exposes MCP endpoint metadata on GET /mcp', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.endpoints.jsonrpc_post).toBe('/mcp');
    expect(payload.endpoints.compat_jsonrpc_post).toBe('/mcp/message');
    expect(payload.endpoints.sse).toBe('/mcp/sse');
    expect(payload.endpoints.tools).toBe('/mcp/tools');
  });

  it('mirrors downgrade metadata through cortex_remember', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/message',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cortex_remember',
          arguments: {
            agent_id: 'api-mcp-downgrade',
            kind: 'fact_slot',
            content: '最近也许会考虑换方案',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    const text = body.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.requested_kind).toBe('fact_slot');
    expect(parsed.written_kind).toBe('session_note');
    expect(parsed.reason_code).toBe('insufficient_structure');
    expect(parsed.record.kind).toBe('session_note');
  });

  it('accepts JSON-RPC tool calls on /mcp', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'cortex_remember',
          arguments: {
            agent_id: 'api-mcp-primary',
            kind: 'fact_slot',
            content: '最近也许会考虑换方案',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    const text = body.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.requested_kind).toBe('fact_slot');
    expect(parsed.written_kind).toBe('session_note');
    expect(parsed.reason_code).toBe('insufficient_structure');
  });

  it('includes recall eligibility metadata in cortex_search_debug results', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-mcp-search-debug',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'cortex_search_debug',
          arguments: {
            agent_id: 'api-mcp-search-debug',
            query: 'Where does the user live?',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    const text = body.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results[0]?.intent_match).toBeDefined();
    expect(parsed.results[0]?.eligible_for_recall).toBe(true);
    expect(parsed.results[0]?.excluded_reason ?? null).toBeNull();
  });

  it('keeps subject-only durable matches out of relevance_basis for location recall', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-subject-only',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'profile_rule',
        content: '我喜欢简洁回答',
        agent_id: 'api-subject-only',
      },
    });

    const recalled = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'Where does the user live?', agent_id: 'api-subject-only' },
    });

    expect(recalled.statusCode).toBe(200);
    const body = JSON.parse(recalled.payload);
    expect(body.rules).toHaveLength(0);
    expect(body.meta.relevance_basis).toHaveLength(1);
    expect(body.meta.relevance_basis[0]?.kind).toBe('fact_slot');
  });

  it('marks subject-only search_debug results as excluded from recall', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-subject-only-debug',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'profile_rule',
        content: '我喜欢简洁回答',
        agent_id: 'api-subject-only-debug',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'cortex_search_debug',
          arguments: {
            agent_id: 'api-subject-only-debug',
            query: 'Where does the user live?',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    const parsed = JSON.parse(body.result?.content?.[0]?.text);
    const rule = parsed.results.find((item: any) => item.kind === 'profile_rule');
    expect(rule?.eligible_for_recall).toBe(false);
    expect(rule?.excluded_reason).toBe('subject_only_match');
  });

  it('keeps vector-only durable matches out of note-only recall results', async () => {
    const originalRecordsV2 = cortex.recordsV2;
    cortex.recordsV2 = new CortexRecordsV2(cortex.llmExtraction, createVectorOnlyEmbedding());
    await cortex.recordsV2.initialize();

    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-vector-only',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'profile_rule',
        content: '我喜欢简洁回答',
        agent_id: 'api-vector-only',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '最近也许会考虑换方案',
        agent_id: 'api-vector-only',
      },
    });

    const recalled = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: '最近是否要换方案？', agent_id: 'api-vector-only' },
    });

    expect(recalled.statusCode).toBe(200);
    const body = JSON.parse(recalled.payload);
    expect(body.context).toBe('');
    expect(body.rules).toHaveLength(0);
    expect(body.facts).toHaveLength(0);
    expect(body.session_notes).toHaveLength(0);
    expect(body.meta.reason).toBe('low_relevance');
    expect(body.meta.durable_candidate_count).toBe(0);
    expect(body.meta.relevance_basis).toEqual([]);

    cortex.recordsV2 = originalRecordsV2;
  });

  it('creates traceable v2 relations bound to source records', async () => {
    const createdRecord = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-v2-relations',
      },
    });
    const recordBody = JSON.parse(createdRecord.payload);

    const createdRelation = await app.inject({
      method: 'POST',
      url: '/api/v2/relations',
      payload: {
        agent_id: 'api-v2-relations',
        source_record_id: recordBody.record.id,
        subject_key: 'user',
        predicate: 'lives_in',
        object_key: 'osaka',
      },
    });

    expect(createdRelation.statusCode).toBe(201);
    const relationBody = JSON.parse(createdRelation.payload);
    expect(relationBody.source_record_id).toBe(recordBody.record.id);
    expect(relationBody.subject_key).toBe('user');
    expect(relationBody.object_key).toBe('osaka');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v2/relations?agent_id=api-v2-relations',
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = JSON.parse(listed.payload);
    expect(listedBody.items).toHaveLength(1);
    expect(listedBody.items[0]?.source_record?.content).toContain('大阪');
  });

  it('runs lifecycle maintenance only on session notes', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '需要确认部署窗口',
        session_id: 'session-lifecycle',
        agent_id: 'api-v2-lifecycle',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '要检查迁移顺序',
        session_id: 'session-lifecycle',
        agent_id: 'api-v2-lifecycle',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '需要安排回滚预案',
        session_id: 'session-lifecycle',
        agent_id: 'api-v2-lifecycle',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-v2-lifecycle',
      },
    });

    const preview = await app.inject({
      method: 'GET',
      url: '/api/v2/lifecycle/preview?agent_id=api-v2-lifecycle',
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = JSON.parse(preview.payload);
    expect(previewBody.summary.compression_groups).toBe(1);
    expect(previewBody.summary.expire_count).toBe(0);

    const run = await app.inject({
      method: 'POST',
      url: '/api/v2/lifecycle/run',
      payload: { agent_id: 'api-v2-lifecycle' },
    });
    expect(run.statusCode).toBe(200);
    const runBody = JSON.parse(run.payload);
    expect(runBody.summary.compressed_notes).toBe(3);
    expect(runBody.summary.written_notes).toBe(1);

    const activeNotes = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=api-v2-lifecycle&kind=session_note',
    });
    const activeNotesBody = JSON.parse(activeNotes.payload);
    expect(activeNotesBody.items).toHaveLength(1);
    expect(activeNotesBody.items[0]?.tags).toContain('lifecycle_compressed');

    const facts = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=api-v2-lifecycle&kind=fact_slot',
    });
    const factsBody = JSON.parse(facts.payload);
    expect(factsBody.items).toHaveLength(1);
    expect(factsBody.items[0]?.content).toContain('大阪');
  });

  it('records v2 feedback corrections as superseding records instead of in-place edits', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住东京',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-v2-feedback',
      },
    });
    const createdBody = JSON.parse(created.payload);

    const corrected = await app.inject({
      method: 'POST',
      url: '/api/v2/feedback',
      payload: {
        agent_id: 'api-v2-feedback',
        record_id: createdBody.record.id,
        feedback: 'corrected',
        corrected_content: '我住大阪',
        reason: 'user corrected residence',
      },
    });

    expect(corrected.statusCode).toBe(201);
    const correctedBody = JSON.parse(corrected.payload);
    expect(correctedBody.feedback.feedback).toBe('corrected');
    expect(correctedBody.correction.record.content).toContain('大阪');
    expect(correctedBody.correction.previous_record_id).toBe(createdBody.record.id);

    const recalled = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'Where does the user live?', agent_id: 'api-v2-feedback' },
    });
    const recallBody = JSON.parse(recalled.payload);
    expect(recallBody.facts).toHaveLength(1);
    expect(recallBody.facts[0]?.content).toContain('大阪');

    const stats = await app.inject({
      method: 'GET',
      url: '/api/v2/feedback/stats?agent_id=api-v2-feedback',
    });
    expect(stats.statusCode).toBe(200);
    const statsBody = JSON.parse(stats.payload);
    expect(statsBody.corrected).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase } from '../src/db/index.js';
import { getDb } from '../src/db/connection.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';
import { registerAuthRoutes } from '../src/api/security.js';
import { CortexRecordsV2 } from '../src/v2/service.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import { startLifecycleScheduler, stopLifecycleScheduler } from '../src/core/scheduler.js';

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
        text.includes('最近是否要换方案') ||
        text.includes('Should we switch approaches')
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
        text.includes('最近是否要换方案') ||
        text.includes('Should we switch approaches')
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
  let authConfig: { token?: string; agents?: Array<{ agent_id: string; token: string }> };

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
    authConfig = { agents: [] };
    registerAuthRoutes(app, authConfig);
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
      url: '/api/v2/extraction-logs?agent_id=api-ingest-logs&channel=v2&limit=5',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items.every((item: any) => item.channel === 'v2')).toBe(true);
  });

  it('exposes admin platform routes under /api/v2 and disables non-auth v1 equivalents', async () => {
    const [configV2, healthV2, logLevelV2, agentsV2, configV1, healthV1, extractionLogsV1] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v2/config' }),
      app.inject({ method: 'GET', url: '/api/v2/health' }),
      app.inject({ method: 'GET', url: '/api/v2/log-level' }),
      app.inject({ method: 'GET', url: '/api/v2/agents' }),
      app.inject({ method: 'GET', url: '/api/v1/config' }),
      app.inject({ method: 'GET', url: '/api/v1/health' }),
      app.inject({ method: 'GET', url: '/api/v1/extraction-logs' }),
    ]);

    expect(configV2.statusCode).toBe(200);
    expect(healthV2.statusCode).toBe(200);
    expect(logLevelV2.statusCode).toBe(200);
    expect(agentsV2.statusCode).toBe(200);

    expect(configV1.statusCode).toBe(404);
    expect(healthV1.statusCode).toBe(404);
    expect(extractionLogsV1.statusCode).toBe(404);
  });

  it('exposes auth bootstrap under /api/v2 and closes /api/v1 auth aliases', async () => {
    const checkV2 = await app.inject({ method: 'GET', url: '/api/v2/auth/check' });
    const checkV1 = await app.inject({ method: 'GET', url: '/api/v1/auth/check' });
    const statusBefore = await app.inject({ method: 'GET', url: '/api/v2/auth/status' });

    expect(checkV2.statusCode).toBe(200);
    expect(JSON.parse(checkV2.payload)).toEqual({ authRequired: false });
    expect(checkV1.statusCode).toBe(404);
    expect(statusBefore.statusCode).toBe(200);
    expect(JSON.parse(statusBefore.payload)).toMatchObject({
      authRequired: false,
      setupRequired: true,
      source: 'none',
    });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/setup',
      payload: { token: 'super-secret-token' },
    });
    expect(setup.statusCode).toBe(200);

    const statusAfter = await app.inject({ method: 'GET', url: '/api/v2/auth/status' });
    expect(statusAfter.statusCode).toBe(200);
    expect(JSON.parse(statusAfter.payload)).toMatchObject({
      authRequired: true,
      setupRequired: false,
      source: 'config',
      mutable: true,
    });

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/verify',
      payload: { token: 'super-secret-token' },
    });
    expect(verify.statusCode).toBe(200);
    expect(JSON.parse(verify.payload)).toMatchObject({
      valid: true,
      isMaster: true,
    });

    const change = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/change-token',
      payload: {
        oldToken: 'super-secret-token',
        newToken: 'super-secret-token-2',
      },
    });
    expect(change.statusCode).toBe(200);

    const verifyChanged = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/verify',
      payload: { token: 'super-secret-token-2' },
    });
    expect(verifyChanged.statusCode).toBe(200);
    expect(JSON.parse(verifyChanged.payload)).toMatchObject({
      valid: true,
      isMaster: true,
    });
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

  it('admits plain location statements as durable facts through the public write API', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        agent_id: 'api-plain-location',
      },
    });

    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload);
    expect(body.record.kind).toBe('fact_slot');
    expect(body.record.attribute_key).toBe('location');
    expect(body.normalization).toBe('durable');

    const recalled = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'Where does the user live?', agent_id: 'api-plain-location' },
    });
    expect(recalled.statusCode).toBe(200);
    const recallBody = JSON.parse(recalled.payload);
    expect(recallBody.facts).toHaveLength(1);
    expect(recallBody.facts[0]?.content).toContain('大阪');
  });

  it('admits imperative language preference and constraint statements as durable profile rules', async () => {
    const language = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'profile_rule',
        content: '请用中文回答',
        agent_id: 'api-plain-profile-rules',
      },
    });
    const constraint = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'profile_rule',
        content: '不要复杂方案',
        agent_id: 'api-plain-profile-rules',
      },
    });

    expect(language.statusCode).toBe(201);
    expect(constraint.statusCode).toBe(201);

    const languageBody = JSON.parse(language.payload);
    const constraintBody = JSON.parse(constraint.payload);
    expect(languageBody.record.kind).toBe('profile_rule');
    expect(languageBody.record.attribute_key).toBe('language_preference');
    expect(languageBody.normalization).toBe('durable');
    expect(constraintBody.record.kind).toBe('profile_rule');
    expect(constraintBody.record.attribute_key).toBe('solution_complexity');
    expect(constraintBody.normalization).toBe('durable');
  });

  it('bridges cross-language organization and task queries into durable recall', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我在 OpenAI 工作',
        agent_id: 'api-cross-language-extended',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
        agent_id: 'api-cross-language-extended',
      },
    });

    const organizationRecall = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'Where does the user work?', agent_id: 'api-cross-language-extended' },
    });
    const taskRecall = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'What is the current task?', agent_id: 'api-cross-language-extended' },
    });

    expect(organizationRecall.statusCode).toBe(200);
    expect(taskRecall.statusCode).toBe(200);

    const organizationBody = JSON.parse(organizationRecall.payload);
    const taskBody = JSON.parse(taskRecall.payload);
    expect(organizationBody.facts).toHaveLength(1);
    expect(organizationBody.facts[0]?.content).toContain('OpenAI');
    expect(taskBody.task_state).toHaveLength(1);
    expect(taskBody.task_state[0]?.content).toContain('重构 Cortex recall');
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
      payload: { query: 'Should we switch approaches?', agent_id: 'api-vector-only' },
    });

    expect(recalled.statusCode).toBe(200);
    const body = JSON.parse(recalled.payload);
    expect(body.context).toBe('');
    expect(body.rules).toHaveLength(0);
    expect(body.facts).toHaveLength(0);
    expect(body.session_notes).toHaveLength(0);
    expect(body.meta.reason).toBe('low_relevance');
    expect(body.meta.durable_candidate_count).toBe(0);
    expect(body.meta.note_candidate_count).toBe(0);
    expect(body.meta.relevance_basis).toEqual([]);

    cortex.recordsV2 = originalRecordsV2;
  });

  it('marks note-only vector hits as excluded from recall', async () => {
    const originalRecordsV2 = cortex.recordsV2;
    cortex.recordsV2 = new CortexRecordsV2(cortex.llmExtraction, createVectorOnlyEmbedding());
    await cortex.recordsV2.initialize();

    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '最近也许会考虑换方案',
        agent_id: 'api-vector-note-debug',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'cortex_search_debug',
          arguments: {
            agent_id: 'api-vector-note-debug',
            query: 'Should we switch approaches?',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    const parsed = JSON.parse(body.result?.content?.[0]?.text);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results[0]?.kind).toBe('session_note');
    expect(parsed.results[0]?.eligible_for_recall).toBe(false);
    expect(parsed.results[0]?.excluded_reason).toBe('vector_only_match');

    cortex.recordsV2 = originalRecordsV2;
  });

  it('starts the lifecycle v2 scheduler in v2-only mode', async () => {
    stopLifecycleScheduler();
    startLifecycleScheduler(cortex);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/health/components',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    const scheduler = body.components.find((component: any) => component.id === 'scheduler');
    expect(scheduler).toBeDefined();
    expect(scheduler.status).toBe('ok');
    expect(scheduler.details.running).toBe(true);
    expect(typeof scheduler.details.schedule).toBe('string');
    expect(scheduler.details.nextRun).toBeTruthy();

    stopLifecycleScheduler();
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

  it('creates relation candidates during v2 ingest and only materializes formal relations after confirmation', async () => {
    const ingested = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'api-v2-relation-candidates',
        user_message: '我住大阪',
        assistant_message: '记住了',
      },
    });

    expect(ingested.statusCode).toBe(201);
    const ingestBody = JSON.parse(ingested.payload);
    const factRecord = ingestBody.records.find((item: any) => item.written_kind === 'fact_slot');
    expect(factRecord).toBeTruthy();

    const candidates = await app.inject({
      method: 'GET',
      url: '/api/v2/relation-candidates?agent_id=api-v2-relation-candidates',
    });
    expect(candidates.statusCode).toBe(200);
    const candidatesBody = JSON.parse(candidates.payload);
    expect(candidatesBody.items).toHaveLength(1);
    expect(candidatesBody.items[0]?.status).toBe('pending');
    expect(candidatesBody.items[0]?.source_record_id).toBe(factRecord.record_id);
    expect(candidatesBody.items[0]?.source_evidence_id).toBeTruthy();

    const relationsBeforeConfirm = await app.inject({
      method: 'GET',
      url: '/api/v2/relations?agent_id=api-v2-relation-candidates',
    });
    const relationsBeforeBody = JSON.parse(relationsBeforeConfirm.payload);
    expect(relationsBeforeBody.items).toHaveLength(0);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v2/relation-candidates/${candidatesBody.items[0].id}/confirm`,
    });
    expect(confirmed.statusCode).toBe(201);
    const confirmedBody = JSON.parse(confirmed.payload);
    expect(confirmedBody.candidate.status).toBe('confirmed');
    expect(confirmedBody.relation.source_record_id).toBe(factRecord.record_id);

    const relationsAfterConfirm = await app.inject({
      method: 'GET',
      url: '/api/v2/relations?agent_id=api-v2-relation-candidates',
    });
    const relationsAfterBody = JSON.parse(relationsAfterConfirm.payload);
    expect(relationsAfterBody.items).toHaveLength(1);
    expect(relationsAfterBody.items[0]?.source_record?.content).toContain('大阪');
  });

  it('creates relation candidates for durable records written via the public record API', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-v2-record-candidates',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.record.kind).toBe('fact_slot');

    const candidates = await app.inject({
      method: 'GET',
      url: '/api/v2/relation-candidates?agent_id=api-v2-record-candidates',
    });
    expect(candidates.statusCode).toBe(200);
    const candidatesBody = JSON.parse(candidates.payload);
    expect(candidatesBody.items).toHaveLength(1);
    expect(candidatesBody.items[0]?.status).toBe('pending');
    expect(candidatesBody.items[0]?.source_record_id).toBe(createdBody.record.id);
  });

  it('refreshes pending relation candidates when durable records are updated', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: 'location',
        agent_id: 'api-v2-update-candidates',
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);

    const before = await app.inject({
      method: 'GET',
      url: '/api/v2/relation-candidates?agent_id=api-v2-update-candidates',
    });
    expect(before.statusCode).toBe(200);
    const beforeBody = JSON.parse(before.payload);
    expect(beforeBody.items).toHaveLength(1);
    expect(beforeBody.items[0]?.object_key).toBe('大阪');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v2/records/${createdBody.record.id}`,
      payload: {
        content: '我住京都',
      },
    });
    expect(updated.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v2/relation-candidates?agent_id=api-v2-update-candidates',
    });
    expect(after.statusCode).toBe(200);
    const afterBody = JSON.parse(after.payload);
    expect(afterBody.items).toHaveLength(1);
    expect(afterBody.items[0]?.source_record_id).toBe(createdBody.record.id);
    expect(afterBody.items[0]?.object_key).toBe('京都');
    expect(afterBody.items[0]?.status).toBe('pending');
  });

  it('runs forgetting-first lifecycle maintenance only on session notes', async () => {
    const activeNote = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '需要确认部署窗口',
        session_id: 'session-lifecycle',
        agent_id: 'api-v2-lifecycle',
      },
    });
    const dormantNote = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'session_note',
        content: '要检查迁移顺序',
        session_id: 'session-lifecycle',
        agent_id: 'api-v2-lifecycle',
      },
    });
    const staleNote = await app.inject({
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

    const activeBody = JSON.parse(activeNote.payload);
    const dormantBody = JSON.parse(dormantNote.payload);
    const staleBody = JSON.parse(staleNote.payload);
    const db = getDb();
    const now = Date.now();
    db.prepare(`
      UPDATE session_notes
      SET expires_at = ?, lifecycle_state = 'active', retired_at = NULL, purge_after = NULL
      WHERE id = ?
    `).run(new Date(now - 60_000).toISOString(), activeBody.record.id);
    db.prepare(`
      UPDATE session_notes
      SET lifecycle_state = 'dormant', retired_at = ?, purge_after = ?
      WHERE id = ?
    `).run(
      new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(now + 15 * 24 * 60 * 60 * 1000).toISOString(),
      dormantBody.record.id,
    );
    db.prepare(`
      UPDATE session_notes
      SET lifecycle_state = 'stale', retired_at = ?, purge_after = ?
      WHERE id = ?
    `).run(
      new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(now - 60_000).toISOString(),
      staleBody.record.id,
    );

    const preview = await app.inject({
      method: 'GET',
      url: '/api/v2/lifecycle/preview?agent_id=api-v2-lifecycle',
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = JSON.parse(preview.payload);
    expect(previewBody.summary.active_notes).toBe(1);
    expect(previewBody.summary.dormant_candidates).toBe(1);
    expect(previewBody.summary.stale_candidates).toBe(1);
    expect(previewBody.summary.purge_candidates).toBe(1);
    expect(previewBody.summary.compression_groups).toBeUndefined();

    const run = await app.inject({
      method: 'POST',
      url: '/api/v2/lifecycle/run',
      payload: { agent_id: 'api-v2-lifecycle' },
    });
    expect(run.statusCode).toBe(200);
    const runBody = JSON.parse(run.payload);
    expect(runBody.summary.retired_notes).toBe(1);
    expect(runBody.summary.purged_notes).toBe(1);
    expect(runBody.summary.compressed_notes).toBeUndefined();
    expect(runBody.summary.written_notes).toBeUndefined();

    const activeNotes = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=api-v2-lifecycle&kind=session_note',
    });
    const activeNotesBody = JSON.parse(activeNotes.payload);
    expect(activeNotesBody.items).toHaveLength(2);
    expect(activeNotesBody.items.some((item: any) => item.lifecycle_state === 'dormant')).toBe(true);
    expect(activeNotesBody.items.some((item: any) => item.lifecycle_state === 'stale')).toBe(true);
    expect(activeNotesBody.items.every((item: any) => !item.tags.includes('lifecycle_compressed'))).toBe(true);

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

    const candidates = await app.inject({
      method: 'GET',
      url: '/api/v2/relation-candidates?agent_id=api-v2-feedback',
    });
    expect(candidates.statusCode).toBe(200);
    const candidatesBody = JSON.parse(candidates.payload);
    expect(candidatesBody.items.some((item: any) => item.source_record_id === correctedBody.correction.record.id)).toBe(true);

    const stats = await app.inject({
      method: 'GET',
      url: '/api/v2/feedback/stats?agent_id=api-v2-feedback',
    });
    expect(stats.statusCode).toBe(200);
    const statsBody = JSON.parse(stats.payload);
    expect(statsBody.corrected).toBe(1);
  });
});

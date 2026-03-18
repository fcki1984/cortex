import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase } from '../src/db/index.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';

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
});

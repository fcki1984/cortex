import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
      llm: {
        extraction: { provider: 'none', timeoutMs: 100 },
        lifecycle: { provider: 'none' },
      },
      embedding: { provider: 'none', dimensions: 4, timeoutMs: 100 },
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

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=api-v2',
    });
    expect(listed.statusCode).toBe(200);
    const body = JSON.parse(listed.payload);
    expect(body.items.some((item: any) => item.content.includes('东京'))).toBe(true);
  });

  it('returns v2 stats for dashboard and MCP consumers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/stats',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.totals).toBeDefined();
    expect(payload.distributions).toBeDefined();
    expect(typeof payload.runtime?.legacy_mode).toBe('boolean');
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
  });

  it('scopes MCP search debug to the caller agent_id', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        kind: 'fact_slot',
        content: 'Scoped MCP debug record',
        entity_key: 'scoped',
        attribute_key: 'debug_key',
        agent_id: 'mcp-scope',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mcp/message',
      headers: {
        'x-agent-id': 'mcp-scope',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cortex_search_debug',
          arguments: {
            query: 'Scoped MCP debug',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    const text = payload.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results.some((item: any) => item.content.includes('Scoped MCP debug record'))).toBe(true);
  });

  it('classifies database busy errors on v2 recall', async () => {
    const originalRecall = cortex.recordsV2.recall.bind(cortex.recordsV2);
    cortex.recordsV2.recall = vi.fn(async () => {
      throw new Error('database is locked');
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'busy', agent_id: 'api-v2' },
    });

    cortex.recordsV2.recall = originalRecall as any;

    expect(response.statusCode).toBe(503);
    const payload = JSON.parse(response.payload);
    expect(payload.category).toBe('db_busy');
    expect(payload.error).toContain('Database is busy');
  });

  it('times out slow v2 ingest handlers with classified errors', async () => {
    const originalIngest = cortex.recordsV2.ingest.bind(cortex.recordsV2);
    cortex.recordsV2.ingest = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { records: [], skipped: false };
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        user_message: 'slow request',
        assistant_message: 'still slow',
        agent_id: 'api-v2',
      },
    });

    cortex.recordsV2.ingest = originalIngest as any;

    expect(response.statusCode).toBe(504);
    const payload = JSON.parse(response.payload);
    expect(payload.category).toBe('upstream_timeout');
  });

  it('freezes legacy write/search routes when legacy mode is disabled', async () => {
    const disabledConfig = JSON.parse(JSON.stringify(cortex.config));
    disabledConfig.runtime = { legacyMode: false };

    const legacyOff = new CortexApp(disabledConfig);
    await legacyOff.initialize();

    const offApp = Fastify();
    await offApp.register(cors, { origin: true });
    registerAllRoutes(offApp, legacyOff);
    await offApp.ready();

    const legacyRecall = await offApp.inject({
      method: 'POST',
      url: '/api/v1/recall',
      payload: { query: 'test' },
    });
    const legacySearch = await offApp.inject({
      method: 'POST',
      url: '/api/v1/search',
      payload: { query: 'test' },
    });
    const legacyMemories = await offApp.inject({
      method: 'GET',
      url: '/api/v1/memories',
    });
    const legacyRelations = await offApp.inject({
      method: 'GET',
      url: '/api/v1/relations',
    });
    const legacyLifecycle = await offApp.inject({
      method: 'GET',
      url: '/api/v1/lifecycle/preview',
    });
    const v2Recall = await offApp.inject({
      method: 'POST',
      url: '/api/v2/recall',
      payload: { query: 'test', agent_id: 'api-v2' },
    });
    const health = await offApp.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    const configResponse = await offApp.inject({
      method: 'GET',
      url: '/api/v1/config',
    });
    const agents = await offApp.inject({
      method: 'GET',
      url: '/api/v1/agents',
    });
    const extractionLogs = await offApp.inject({
      method: 'GET',
      url: '/api/v1/extraction-logs',
    });

    await offApp.close();
    await legacyOff.shutdown();

    expect(legacyRecall.statusCode).toBe(404);
    expect(legacySearch.statusCode).toBe(404);
    expect(legacyMemories.statusCode).toBe(404);
    expect(legacyRelations.statusCode).toBe(404);
    expect(legacyLifecycle.statusCode).toBe(404);
    expect(v2Recall.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
    expect(configResponse.statusCode).toBe(200);
    expect(agents.statusCode).toBe(200);
    expect(extractionLogs.statusCode).toBe(200);
  });
});

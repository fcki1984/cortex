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
});

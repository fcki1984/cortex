import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase } from '../src/db/index.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';

describe('Relation confirm HTTP compatibility', () => {
  let app: FastifyInstance;
  let cortex: CortexApp;
  let baseUrl: string;

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
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await app.close();
    await cortex.shutdown();
    closeDatabase();
  });

  async function createCandidate(agentId: string): Promise<string> {
    const created = await fetch(`${baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'fact_slot',
        content: '我住东京',
        agent_id: agentId,
      }),
    });
    expect(created.status).toBe(201);

    const listed = await fetch(`${baseUrl}/api/v2/relation-candidates?agent_id=${encodeURIComponent(agentId)}`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { items: Array<{ id: string }> };
    expect(listedBody.items).toHaveLength(1);
    return listedBody.items[0]!.id;
  }

  it('accepts no body, empty JSON body, and {} over real HTTP transport', async () => {
    const noBodyId = await createCandidate('http-confirm-no-body');
    const emptyJsonId = await createCandidate('http-confirm-empty-json');
    const jsonObjectId = await createCandidate('http-confirm-json-object');

    const responses = await Promise.all([
      fetch(`${baseUrl}/api/v2/relation-candidates/${noBodyId}/confirm`, {
        method: 'POST',
      }),
      fetch(`${baseUrl}/api/v2/relation-candidates/${emptyJsonId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '',
      }),
      fetch(`${baseUrl}/api/v2/relation-candidates/${jsonObjectId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
  });
});

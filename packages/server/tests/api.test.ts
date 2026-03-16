import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase } from '../src/db/index.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';

describe('API Integration', () => {
  let app: FastifyInstance;
  let cortex: CortexApp;

  beforeAll(async () => {
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: {
        extraction: { provider: 'none', timeoutMs: 1111 },
        lifecycle: { provider: 'none', timeoutMs: 2222 },
      },
      embedding: { provider: 'none', dimensions: 4, timeoutMs: 3333 },
      vectorBackend: { provider: 'sqlite-vec' },
      gate: {
        queryExpansionTimeoutMs: 5555,
        rerankerTimeoutMs: 6666,
        relationInjection: true,
        relationTimeoutMs: 7777,
        relevanceGate: {
          enabled: true,
          inspectTopK: 4,
          minSemanticScore: 0.66,
          minFusedScoreNoOverlap: 0.22,
        },
      },
      search: {
        reranker: {
          enabled: false,
          provider: 'none',
          timeoutMs: 4444,
          topN: 10,
          weight: 0.5,
        },
      },
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
    fs.rmSync(new URL('../cortex.json', import.meta.url), { force: true });
  });

  describe('GET /api/v1/health', () => {
    it('should return health status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /api/v1/stats', () => {
    it('should return stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(typeof body.total_memories).toBe('number');
    });
  });

  describe('POST /api/v1/memories', () => {
    it('should create a memory', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        payload: { layer: 'core', category: 'fact', content: 'API test memory' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.id).toBeTruthy();
      expect(body.content).toBe('API test memory');
    });
  });

  describe('GET /api/v1/memories', () => {
    it('should list memories', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/memories' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.items).toBeDefined();
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('should filter by layer', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/memories?layer=core' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      body.items.forEach((m: any) => expect(m.layer).toBe('core'));
    });
  });

  describe('POST /api/v1/ingest', () => {
    it('should ingest a conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ingest',
        payload: {
          user_message: '我叫Harry，我住在东京',
          assistant_message: '你好Harry！东京是个好地方。',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.high_signals).toBeDefined();
    });
  });

  describe('POST /api/v1/recall', () => {
    it('should recall memories', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        payload: { query: 'Harry Tokyo' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta).toBeDefined();
    });

    it('should skip small talk', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        payload: { query: 'hi' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta.skipped).toBe(true);
    });
  });

  describe('POST /api/v1/search', () => {
    it('should search memories', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/search',
        payload: { query: 'test', debug: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toBeDefined();
    });
  });

  describe('POST /api/v1/relations', () => {
    it('should create a relation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/relations',
        payload: { subject: 'Harry', predicate: 'lives_in', object: 'Tokyo', confidence: 0.9 },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.id).toBeTruthy();
    });
  });

  describe('GET /api/v1/relations', () => {
    it('should list relations', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/relations' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('POST /api/v1/lifecycle/run', () => {
    it('should run lifecycle (dry run)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/lifecycle/run',
        payload: { dry_run: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(typeof body.promoted).toBe('number');
    });
  });

  describe('GET /api/v1/config', () => {
    it('should return config with timeout fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.port).toBeDefined();
      expect(body.llm.extraction.timeoutMs).toBe(1111);
      expect(body.llm.lifecycle.timeoutMs).toBe(2222);
      expect(body.embedding.timeoutMs).toBe(3333);
      expect(body.search.reranker.timeoutMs).toBe(4444);
      expect(body.gate.queryExpansionTimeoutMs).toBe(5555);
      expect(body.gate.rerankerTimeoutMs).toBe(6666);
      expect(body.gate.relationInjection).toBe(true);
      expect(body.gate.relationTimeoutMs).toBe(7777);
      expect(body.gate.relevanceGate.enabled).toBe(true);
      expect(body.gate.relevanceGate.inspectTopK).toBe(4);
      expect(body.gate.relevanceGate.minSemanticScore).toBe(0.66);
      expect(body.gate.relevanceGate.minFusedScoreNoOverlap).toBe(0.22);
    });
  });

  describe('PATCH /api/v1/config', () => {
    it('should reload providers when timeout changes', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/config',
        payload: {
          llm: {
            extraction: {
              timeoutMs: 9999,
            },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.reloaded_providers).toContain('llm.extraction');
      expect(body.config.llm.extraction.timeoutMs).toBe(9999);
    });

    it('should persist relevance gate settings', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/config',
        payload: {
          gate: {
            relevanceGate: {
              enabled: false,
              inspectTopK: 2,
              minSemanticScore: 0.71,
              minFusedScoreNoOverlap: 0.19,
            },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.config.gate.relevanceGate.enabled).toBe(false);
      expect(body.config.gate.relevanceGate.inspectTopK).toBe(2);
      expect(body.config.gate.relevanceGate.minSemanticScore).toBe(0.71);
      expect(body.config.gate.relevanceGate.minFusedScoreNoOverlap).toBe(0.19);
    });
  });
});

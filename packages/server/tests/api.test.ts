import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase } from '../src/db/index.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';
import { getSchedulerStatus, startLifecycleScheduler, stopLifecycleScheduler } from '../src/core/scheduler.js';

describe('API Integration', () => {
  let app: FastifyInstance;
  let cortex: CortexApp;

  beforeAll(async () => {
    const config = loadConfig({
      runtime: { legacyMode: true },
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
    stopLifecycleScheduler();
    await app.close();
    await cortex.shutdown();
    closeDatabase();
    fs.rmSync(new URL('../cortex.json', import.meta.url), { force: true });
  });

  describe('GET /api/v2/health', () => {
    it('should return health status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /api/v2/stats', () => {
    it('should return stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(typeof body.totals?.total_records).toBe('number');
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

  describe('GET /api/v2/config', () => {
    it('should return config with timeout fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/config' });
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

  describe('PATCH /api/v2/config', () => {
    it('should persist and live-apply provider timeout changes', async () => {
      const previousExtraction = cortex.llmExtraction;
      const previousEmbedding = cortex.embeddingProvider;
      const previousRecordsV2 = cortex.recordsV2;

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v2/config',
        payload: {
          llm: {
            extraction: {
              timeoutMs: 9999,
            },
          },
          embedding: {
            timeoutMs: 8888,
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.runtime_applied).toBe(true);
      expect(body.applied_sections).toContain('llm.extraction');
      expect(body.applied_sections).toContain('embedding');
      expect(body.restart_required_sections).toEqual([]);
      expect(body.config.llm.extraction.timeoutMs).toBe(9999);
      expect(body.config.embedding.timeoutMs).toBe(8888);
      expect(cortex.config.llm.extraction.timeoutMs).toBe(9999);
      expect(cortex.config.embedding.timeoutMs).toBe(8888);
      expect(cortex.llmExtraction).not.toBe(previousExtraction);
      expect(cortex.embeddingProvider).not.toBe(previousEmbedding);
      expect(cortex.recordsV2).not.toBe(previousRecordsV2);
    });

    it('should persist and live-apply gate, search, sieve, and lifecycle schedule settings', async () => {
      stopLifecycleScheduler();
      startLifecycleScheduler(cortex);
      const initialSchedule = getSchedulerStatus().schedule;
      const previousGate = cortex.gate;
      const previousSearchEngine = cortex.searchEngine;
      const previousSieve = cortex.sieve;

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v2/config',
        payload: {
          gate: {
            queryExpansionTimeoutMs: 1234,
            rerankerTimeoutMs: 2345,
            relationTimeoutMs: 3456,
            relevanceGate: {
              enabled: false,
              inspectTopK: 2,
              minSemanticScore: 0.71,
              minFusedScoreNoOverlap: 0.19,
            },
          },
          search: {
            vectorWeight: 0.2,
            textWeight: 0.8,
            reranker: {
              enabled: false,
              topN: 7,
              weight: 0.3,
            },
          },
          sieve: {
            smartUpdate: false,
            relationExtraction: false,
          },
          lifecycle: {
            schedule: '*/15 * * * *',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.runtime_applied).toBe(true);
      expect(body.applied_sections).toContain('gate');
      expect(body.applied_sections).toContain('search');
      expect(body.applied_sections).toContain('sieve');
      expect(body.applied_sections).toContain('lifecycle.schedule');
      expect(body.restart_required_sections).toEqual([]);
      expect(body.config.gate.queryExpansionTimeoutMs).toBe(1234);
      expect(body.config.gate.rerankerTimeoutMs).toBe(2345);
      expect(body.config.gate.relationTimeoutMs).toBe(3456);
      expect(body.config.gate.relevanceGate.enabled).toBe(false);
      expect(body.config.gate.relevanceGate.inspectTopK).toBe(2);
      expect(body.config.gate.relevanceGate.minSemanticScore).toBe(0.71);
      expect(body.config.gate.relevanceGate.minFusedScoreNoOverlap).toBe(0.19);
      expect(cortex.config.gate.relevanceGate.enabled).toBe(false);
      expect(cortex.config.search.vectorWeight).toBe(0.2);
      expect(cortex.config.search.textWeight).toBe(0.8);
      expect(cortex.config.sieve.smartUpdate).toBe(false);
      expect(cortex.config.sieve.relationExtraction).toBe(false);
      expect(cortex.config.lifecycle.schedule).toBe('*/15 * * * *');
      expect(cortex.gate).not.toBe(previousGate);
      expect(cortex.searchEngine).not.toBe(previousSearchEngine);
      expect(cortex.sieve).not.toBe(previousSieve);
      expect((cortex.gate as any)?.config?.queryExpansionTimeoutMs).toBe(1234);
      expect((cortex.gate as any)?.config?.rerankerTimeoutMs).toBe(2345);
      expect((cortex.gate as any)?.config?.relationTimeoutMs).toBe(3456);
      expect((cortex.searchEngine as any)?.config?.vectorWeight).toBe(0.2);
      expect((cortex.searchEngine as any)?.config?.textWeight).toBe(0.8);
      expect((cortex.sieve as any)?.config?.sieve?.smartUpdate).toBe(false);
      expect((cortex.sieve as any)?.config?.sieve?.relationExtraction).toBe(false);
      const scheduler = getSchedulerStatus();
      expect(scheduler.running).toBe(true);
      expect(scheduler.schedule).toBe('*/15 * * * *');
      expect(scheduler.nextRun).toBeTruthy();
      expect(scheduler.schedule).not.toBe(initialSchedule);
    });

    it('should ignore unchanged deployment-only sections when reporting runtime apply', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v2/config',
        payload: {
          llm: {
            extraction: {
              timeoutMs: 7777,
            },
            lifecycle: {
              provider: cortex.config.llm.lifecycle.provider,
              model: cortex.config.llm.lifecycle.model,
              timeoutMs: cortex.config.llm.lifecycle.timeoutMs,
            },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.runtime_applied).toBe(true);
      expect(body.applied_sections).toEqual(['llm.extraction']);
      expect(body.restart_required_sections).toEqual([]);
      expect(body.config.llm.extraction.timeoutMs).toBe(7777);
    });
  });

  describe('PATCH /api/v2/log-level', () => {
    it('should apply log level changes immediately', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v2/log-level',
        payload: { level: 'debug' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true, level: 'debug' });

      const verify = await app.inject({ method: 'GET', url: '/api/v2/log-level' });
      expect(verify.statusCode).toBe(200);
      expect(JSON.parse(verify.payload)).toEqual({ level: 'debug' });
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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
    it('should return local health status without blocking on GitHub release checks', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('should not reach GitHub on default health checks'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({ method: 'GET', url: '/api/v2/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ok');
      expect(body.version).toBe('1.0.0');
      expect(body.github).toBe('https://github.com/fcki1984/cortex');
      expect(body.latestRelease).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should only refresh latest release metadata when refresh=true is requested', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        tag_name: 'v1.2.3',
        html_url: 'https://github.com/fcki1984/cortex/releases/tag/v1.2.3',
        published_at: '2026-03-25T00:00:00.000Z',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({ method: 'GET', url: '/api/v2/health?refresh=true' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body.latestRelease).toMatchObject({
        version: '1.2.3',
        url: 'https://github.com/fcki1984/cortex/releases/tag/v1.2.3',
        publishedAt: '2026-03-25T00:00:00.000Z',
      });
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
    it('should return config with timeout fields and no sensitive secrets', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.port).toBeDefined();
      expect(body.auth).toBeUndefined();
      expect(body.llm.extraction.timeoutMs).toBe(1111);
      expect(body.llm.lifecycle.timeoutMs).toBe(2222);
      expect(body.embedding.timeoutMs).toBe(3333);
      expect(body.llm.extraction.apiKey).toBeUndefined();
      expect(body.llm.lifecycle.apiKey).toBeUndefined();
      expect(body.embedding.apiKey).toBeUndefined();
      expect(body.search.reranker.timeoutMs).toBe(4444);
      expect(body.search.reranker.apiKey).toBeUndefined();
      expect(body.gate.queryExpansionTimeoutMs).toBe(5555);
      expect(body.gate.rerankerTimeoutMs).toBe(6666);
      expect(body.gate.relationInjection).toBe(true);
      expect(body.gate.relationTimeoutMs).toBe(7777);
      expect(body.gate.relevanceGate.enabled).toBe(true);
      expect(body.gate.relevanceGate.inspectTopK).toBe(4);
      expect(body.gate.relevanceGate.minSemanticScore).toBe(0.66);
      expect(body.gate.relevanceGate.minFusedScoreNoOverlap).toBe(0.22);
      expect(body.sieve.retainMission).toBe('');
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
      expect(body.config.auth).toBeUndefined();
      expect(body.config.llm.extraction.apiKey).toBeUndefined();
      expect(body.config.llm.lifecycle.apiKey).toBeUndefined();
      expect(body.config.embedding.apiKey).toBeUndefined();
      expect(body.config.llm.extraction.timeoutMs).toBe(9999);
      expect(body.config.embedding.timeoutMs).toBe(8888);
      expect(cortex.config.llm.extraction.timeoutMs).toBe(9999);
      expect(cortex.config.embedding.timeoutMs).toBe(8888);
      expect(cortex.llmExtraction).not.toBe(previousExtraction);
      expect(cortex.embeddingProvider).not.toBe(previousEmbedding);
      expect(cortex.recordsV2).not.toBe(previousRecordsV2);
    });

    it('should persist and live-apply the global retain mission without opening the rest of sieve settings', async () => {
      const mission = '保留长期偏好、稳定背景和持续任务';

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v2/config',
        payload: {
          sieve: {
            retainMission: mission,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.runtime_applied).toBe(true);
      expect(body.applied_sections).toContain('sieve.retainMission');
      expect(body.config.sieve.retainMission).toBe(mission);
      expect(cortex.config.sieve.retainMission).toBe(mission);

      const verify = await app.inject({
        method: 'GET',
        url: '/api/v2/config',
      });
      expect(verify.statusCode).toBe(200);
      expect(JSON.parse(verify.payload).sieve.retainMission).toBe(mission);
    });

    it('should reject writes to deployment-only sections', async () => {
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
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(false);
      expect(body.code).toBe('READ_ONLY_CONFIG');
      expect(body.read_only_sections).toEqual(expect.arrayContaining(['gate', 'search', 'sieve']));
      expect(cortex.config.gate.relevanceGate.enabled).toBe(true);
      expect(cortex.config.search.vectorWeight).toBe(0.7);
      expect(cortex.config.search.textWeight).toBe(0.3);
      expect(cortex.config.sieve.smartUpdate).toBe(true);
      expect(cortex.config.sieve.relationExtraction).toBe(true);
      expect(cortex.config.lifecycle.schedule).toBe(initialSchedule);
      expect(cortex.gate).toBe(previousGate);
      expect(cortex.searchEngine).toBe(previousSearchEngine);
      expect(cortex.sieve).toBe(previousSieve);
      expect((cortex.gate as any)?.config?.queryExpansionTimeoutMs).toBe(5555);
      expect((cortex.gate as any)?.config?.rerankerTimeoutMs).toBe(6666);
      expect((cortex.gate as any)?.config?.relationTimeoutMs).toBe(7777);
      const scheduler = getSchedulerStatus();
      expect(scheduler.running).toBe(true);
      expect(scheduler.schedule).toBe(initialSchedule);
      expect(scheduler.nextRun).toBeTruthy();
      expect(scheduler.schedule).toBe(initialSchedule);
    });

    it('should reject mixed payloads that contain changed read-only sections', async () => {
      const previousExtraction = cortex.llmExtraction;
      const previousGate = cortex.gate;
      const nextExtractionTimeout = (cortex.config.llm.extraction.timeoutMs ?? 0) + 1111;
      const nextLifecycleTimeout = (cortex.config.llm.lifecycle.timeoutMs ?? 0) + 2222;
      const nextQueryExpansionTimeout = (cortex.config.gate.queryExpansionTimeoutMs ?? 0) + 333;

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v2/config',
        payload: {
          llm: {
            extraction: {
              timeoutMs: nextExtractionTimeout,
            },
            lifecycle: {
              provider: 'none',
              timeoutMs: nextLifecycleTimeout,
            },
          },
          gate: {
            queryExpansionTimeoutMs: nextQueryExpansionTimeout,
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(false);
      expect(body.code).toBe('READ_ONLY_CONFIG');
      expect(body.read_only_sections).toEqual(expect.arrayContaining(['llm.lifecycle', 'gate']));
      expect(cortex.config.llm.extraction.timeoutMs).toBe(9999);
      expect(cortex.config.llm.lifecycle.timeoutMs).toBe(2222);
      expect(cortex.config.gate.queryExpansionTimeoutMs).toBe(5555);
      expect(cortex.llmExtraction).toBe(previousExtraction);
      expect(cortex.gate).toBe(previousGate);
    });

    it('should ignore unchanged deployment-only sections when reporting runtime apply', async () => {
      const nextExtractionTimeout = (cortex.config.llm.extraction.timeoutMs ?? 0) + 1111;
      const currentConfigRes = await app.inject({
        method: 'GET',
        url: '/api/v2/config',
      });
      expect(currentConfigRes.statusCode).toBe(200);
      const currentConfig = JSON.parse(currentConfigRes.payload);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v2/config',
        payload: {
          llm: {
            extraction: {
              timeoutMs: nextExtractionTimeout,
            },
            lifecycle: {
              provider: currentConfig.llm.lifecycle.provider,
              model: currentConfig.llm.lifecycle.model,
              timeoutMs: currentConfig.llm.lifecycle.timeoutMs,
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
      expect(body.config.llm.extraction.timeoutMs).toBe(nextExtractionTimeout);
    });
  });

  describe('GET /api/v2/agents/:id/config', () => {
    it('should merge agent-level retain mission overrides over the global default and fall back when cleared', async () => {
      const globalMission = '保留长期偏好、稳定背景和持续任务';
      const agentMission = '只保留长期偏好和稳定背景，不保留短期任务';

      const setGlobal = await app.inject({
        method: 'PATCH',
        url: '/api/v2/config',
        payload: {
          sieve: {
            retainMission: globalMission,
          },
        },
      });
      expect(setGlobal.statusCode).toBe(200);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v2/agents',
        payload: {
          id: 'mission-agent',
          name: 'Mission Agent',
        },
      });
      expect(created.statusCode).toBe(201);

      const override = await app.inject({
        method: 'PATCH',
        url: '/api/v2/agents/mission-agent',
        payload: {
          config_override: {
            sieve: {
              retainMission: agentMission,
            },
          },
        },
      });
      expect(override.statusCode).toBe(200);

      const merged = await app.inject({
        method: 'GET',
        url: '/api/v2/agents/mission-agent/config',
      });
      expect(merged.statusCode).toBe(200);
      expect(JSON.parse(merged.payload)).toEqual(expect.objectContaining({
        config: expect.objectContaining({
          sieve: expect.objectContaining({
            retainMission: agentMission,
          }),
        }),
        has_override: true,
      }));

      const cleared = await app.inject({
        method: 'PATCH',
        url: '/api/v2/agents/mission-agent',
        payload: {
          config_override: {
            sieve: {
              retainMission: '',
            },
          },
        },
      });
      expect(cleared.statusCode).toBe(200);

      const mergedAfterClear = await app.inject({
        method: 'GET',
        url: '/api/v2/agents/mission-agent/config',
      });
      expect(mergedAfterClear.statusCode).toBe(200);
      expect(JSON.parse(mergedAfterClear.payload)).toEqual(expect.objectContaining({
        config: expect.objectContaining({
          sieve: expect.objectContaining({
            retainMission: globalMission,
          }),
        }),
      }));
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

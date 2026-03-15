import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase } from '../src/db/index.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';

const ORIGINAL_ENV = { ...process.env };
const CONFIG_ENV_KEYS = [
  'HOME',
  'OPENAI_API_KEY',
  'OLLAMA_BASE_URL',
  'DASHSCOPE_API_KEY',
  'CORTEX_PORT',
  'CORTEX_HOST',
  'CORTEX_DB_PATH',
  'CORTEX_AUTH_TOKEN',
  'CORTEX_LLM_EXTRACTION_PROVIDER',
  'CORTEX_LLM_EXTRACTION_MODEL',
  'CORTEX_LLM_EXTRACTION_API_KEY',
  'CORTEX_LLM_EXTRACTION_BASE_URL',
  'CORTEX_LLM_LIFECYCLE_PROVIDER',
  'CORTEX_LLM_LIFECYCLE_MODEL',
  'CORTEX_LLM_LIFECYCLE_API_KEY',
  'CORTEX_LLM_LIFECYCLE_BASE_URL',
  'CORTEX_EMBEDDING_PROVIDER',
  'CORTEX_EMBEDDING_MODEL',
  'CORTEX_EMBEDDING_API_KEY',
  'CORTEX_EMBEDDING_BASE_URL',
  'CORTEX_EMBEDDING_DIMENSIONS',
];

function restoreOriginalEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearConfigEnv(): void {
  for (const key of CONFIG_ENV_KEYS) {
    delete process.env[key];
  }
}

function makeTempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'cortex-config-env-'));
}

describe('Config env wiring', () => {
  let tempHome: string;

  beforeEach(() => {
    restoreOriginalEnv();
    clearConfigEnv();
    tempHome = makeTempHome();
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    restoreOriginalEnv();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('loads OpenAI-compatible LLM and embedding settings from CORTEX_* env vars without clobbering nested fields', () => {
    process.env.CORTEX_LLM_EXTRACTION_PROVIDER = 'openai';
    process.env.CORTEX_LLM_EXTRACTION_MODEL = 'qwen-max';
    process.env.CORTEX_LLM_EXTRACTION_API_KEY = 'compat-extraction-key';
    process.env.CORTEX_LLM_EXTRACTION_BASE_URL = 'https://compat.example.com/v1';
    process.env.CORTEX_LLM_LIFECYCLE_PROVIDER = 'openai';
    process.env.CORTEX_LLM_LIFECYCLE_MODEL = 'qwen-plus';
    process.env.CORTEX_LLM_LIFECYCLE_BASE_URL = 'https://compat.example.com/v1';
    process.env.CORTEX_LLM_LIFECYCLE_API_KEY = 'compat-lifecycle-key';
    process.env.CORTEX_EMBEDDING_PROVIDER = 'openai';
    process.env.CORTEX_EMBEDDING_MODEL = 'text-embedding-3-large';
    process.env.CORTEX_EMBEDDING_BASE_URL = 'https://compat.example.com/v1';
    process.env.CORTEX_EMBEDDING_API_KEY = 'compat-embedding-key';
    process.env.CORTEX_EMBEDDING_DIMENSIONS = '3072';

    const config = loadConfig({
      llm: {
        extraction: { timeoutMs: 1111 },
        lifecycle: { timeoutMs: 2222 },
      },
      embedding: { timeoutMs: 3333 },
    });

    expect(config.llm.extraction.provider).toBe('openai');
    expect(config.llm.extraction.model).toBe('qwen-max');
    expect(config.llm.extraction.apiKey).toBe('compat-extraction-key');
    expect(config.llm.extraction.baseUrl).toBe('https://compat.example.com/v1');
    expect(config.llm.extraction.timeoutMs).toBe(1111);

    expect(config.llm.lifecycle.provider).toBe('openai');
    expect(config.llm.lifecycle.model).toBe('qwen-plus');
    expect(config.llm.lifecycle.apiKey).toBe('compat-lifecycle-key');
    expect(config.llm.lifecycle.baseUrl).toBe('https://compat.example.com/v1');
    expect(config.llm.lifecycle.timeoutMs).toBe(2222);

    expect(config.embedding.provider).toBe('openai');
    expect(config.embedding.model).toBe('text-embedding-3-large');
    expect(config.embedding.apiKey).toBe('compat-embedding-key');
    expect(config.embedding.baseUrl).toBe('https://compat.example.com/v1');
    expect(config.embedding.dimensions).toBe(3072);
    expect(config.embedding.timeoutMs).toBe(3333);
  });

  it('accepts dashscope providers and parses embedding dimensions from env', () => {
    process.env.CORTEX_LLM_EXTRACTION_PROVIDER = 'dashscope';
    process.env.CORTEX_LLM_EXTRACTION_MODEL = 'qwen-plus';
    process.env.CORTEX_LLM_EXTRACTION_API_KEY = 'dashscope-llm-key';
    process.env.CORTEX_EMBEDDING_PROVIDER = 'dashscope';
    process.env.CORTEX_EMBEDDING_MODEL = 'text-embedding-v3';
    process.env.CORTEX_EMBEDDING_API_KEY = 'dashscope-embedding-key';
    process.env.CORTEX_EMBEDDING_DIMENSIONS = '1024';

    const config = loadConfig();

    expect(config.llm.extraction.provider).toBe('dashscope');
    expect(config.llm.extraction.model).toBe('qwen-plus');
    expect(config.embedding.provider).toBe('dashscope');
    expect(config.embedding.model).toBe('text-embedding-v3');
    expect(config.embedding.dimensions).toBe(1024);
  });

  it('keeps OPENAI_API_KEY and OLLAMA_BASE_URL as legacy compatibility env vars', () => {
    process.env.OPENAI_API_KEY = 'legacy-openai-key';
    process.env.CORTEX_LLM_EXTRACTION_PROVIDER = 'openai';
    process.env.CORTEX_LLM_LIFECYCLE_PROVIDER = 'openai';
    process.env.CORTEX_EMBEDDING_PROVIDER = 'openai';
    process.env.CORTEX_LLM_LIFECYCLE_MODEL = 'gpt-4o-mini';
    process.env.CORTEX_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.CORTEX_EMBEDDING_DIMENSIONS = '1536';
    process.env.OLLAMA_BASE_URL = 'http://ollama.internal:11434';

    const openaiConfig = loadConfig();
    expect(openaiConfig.llm.extraction.apiKey).toBe('legacy-openai-key');
    expect(openaiConfig.llm.lifecycle.apiKey).toBe('legacy-openai-key');
    expect(openaiConfig.embedding.apiKey).toBe('legacy-openai-key');

    process.env.CORTEX_LLM_EXTRACTION_PROVIDER = 'ollama';
    process.env.CORTEX_EMBEDDING_PROVIDER = 'ollama';

    const ollamaConfig = loadConfig();
    expect(ollamaConfig.llm.extraction.baseUrl).toBe('http://ollama.internal:11434');
    expect(ollamaConfig.embedding.baseUrl).toBe('http://ollama.internal:11434');
  });
});

describe('Config env API surface', () => {
  let app: FastifyInstance;
  let cortex: CortexApp;
  let tempHome: string;

  beforeAll(async () => {
    restoreOriginalEnv();
    clearConfigEnv();
    tempHome = makeTempHome();
    process.env.HOME = tempHome;
    process.env.CORTEX_DB_PATH = ':memory:';
    process.env.CORTEX_LLM_EXTRACTION_PROVIDER = 'openai';
    process.env.CORTEX_LLM_EXTRACTION_MODEL = 'qwen-max';
    process.env.CORTEX_LLM_EXTRACTION_API_KEY = 'config-visible-key';
    process.env.CORTEX_LLM_EXTRACTION_BASE_URL = 'https://compat.example.com/v1';
    process.env.CORTEX_LLM_LIFECYCLE_PROVIDER = 'openai';
    process.env.CORTEX_LLM_LIFECYCLE_MODEL = 'qwen-plus';
    process.env.CORTEX_LLM_LIFECYCLE_API_KEY = 'lifecycle-visible-key';
    process.env.CORTEX_LLM_LIFECYCLE_BASE_URL = 'https://compat.example.com/v1';
    process.env.CORTEX_EMBEDDING_PROVIDER = 'openai';
    process.env.CORTEX_EMBEDDING_MODEL = 'text-embedding-3-large';
    process.env.CORTEX_EMBEDDING_API_KEY = 'embedding-visible-key';
    process.env.CORTEX_EMBEDDING_BASE_URL = 'https://compat.example.com/v1';
    process.env.CORTEX_EMBEDDING_DIMENSIONS = '3072';

    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
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
    restoreOriginalEnv();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns env-backed config without exposing raw api keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    expect(body.llm.extraction.provider).toBe('openai');
    expect(body.llm.extraction.model).toBe('qwen-max');
    expect(body.llm.extraction.baseUrl).toBe('https://compat.example.com/v1');
    expect(body.llm.extraction.hasApiKey).toBe(true);
    expect(body.llm.extraction.apiKey).toBeUndefined();

    expect(body.llm.lifecycle.provider).toBe('openai');
    expect(body.llm.lifecycle.model).toBe('qwen-plus');
    expect(body.llm.lifecycle.hasApiKey).toBe(true);
    expect(body.embedding.provider).toBe('openai');
    expect(body.embedding.model).toBe('text-embedding-3-large');
    expect(body.embedding.dimensions).toBe(3072);
    expect(body.embedding.baseUrl).toBe('https://compat.example.com/v1');
    expect(body.embedding.hasApiKey).toBe(true);
    expect(body.embedding.apiKey).toBeUndefined();
  });

  it('marks embedding and extraction llm as configured when only env vars are used', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/components' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    const embedding = body.components.find((component: any) => component.id === 'embedding');
    const extraction = body.components.find((component: any) => component.id === 'extraction_llm');

    expect(embedding).toBeDefined();
    expect(embedding.status).toBe('unknown');
    expect(embedding.details.configured).toBe(true);
    expect(embedding.details.model).toBe('text-embedding-3-large');

    expect(extraction).toBeDefined();
    expect(extraction.status).toBe('unknown');
    expect(extraction.details.configured).toBe(true);
    expect(extraction.details.provider).toBe('openai');
    expect(extraction.details.model).toBe('qwen-max');
  });
});

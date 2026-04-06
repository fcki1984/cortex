import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeDatabase, initDatabase } from '../src/db/index.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import { CortexRelationsV2 } from '../src/v2/relations.js';
import { CortexRecordsV2 } from '../src/v2/service.js';
import { registerAgentRoutes } from '../src/api/agents.js';
import { registerImportExportRoutes } from '../src/api/import-export.js';
import { registerV2IngestRoutes } from '../src/api/ingest-v2.js';
import { registerV2RecordRoutes } from '../src/api/records-v2.js';
import { registerV2RelationsRoutes } from '../src/api/relations-v2.js';
import { registerV2ReviewInboxRoutes } from '../src/api/review-inbox-v2.js';
import { CortexReviewInboxV2 } from '../src/v2/review-inbox.js';
import {
  createNoOpLLM,
  createReviewAssistRecordPayload,
  createReviewInboxResponseStyleMockLLM,
} from './helpers/v2-contract-fixtures.js';

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock-embedding',
    dimensions: 4,
    embed: async () => [],
    embedBatch: async (texts: string[]) => texts.map(() => []),
  };
}

async function createServer(options: { responseStyleReview?: boolean } = {}): Promise<{
  app: FastifyInstance;
  baseUrl: string;
  reviewInbox: CortexReviewInboxV2;
}> {
  initDatabase(':memory:');
  const records = new CortexRecordsV2(
    options.responseStyleReview ? createReviewInboxResponseStyleMockLLM() : createNoOpLLM(),
    createMockEmbedding(),
  );
  await records.initialize();
  const relations = new CortexRelationsV2();
  const reviewInbox = new CortexReviewInboxV2(records, relations);
  records.setLiveReviewFollowupResolver(reviewInbox);

  const app = Fastify();
  const cortex = {
    config: {
      sieve: {
        extractionLogging: false,
      },
    },
    recordsV2: records,
    relationsV2: relations,
    reviewInboxV2: reviewInbox,
  } as any;

  registerV2RecordRoutes(app, cortex);
  registerV2IngestRoutes(app, cortex);
  registerImportExportRoutes(app, cortex);
  registerV2RelationsRoutes(app, cortex);
  registerV2ReviewInboxRoutes(app, cortex);
  registerAgentRoutes(app);
  await app.ready();

  return {
    app,
    baseUrl: await app.listen({ host: '127.0.0.1', port: 0 }),
    reviewInbox,
  };
}

describe('Review follow-up HTTP integration', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    closeDatabase();
  });

  it('auto-rewrites a single pending live fact review item over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const created = server.reviewInbox.createLiveBatch({
      agent_id: 'http-live-followup-rewrite-fact',
      source_preview: '我住东京',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_review_rewrite_location',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我住东京',
          source_excerpt: '我住东京',
          entity_key: 'user',
          attribute_key: 'location',
        }),
      ],
    });

    const rewritten = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-live-followup-rewrite-fact',
        user_message: '换大阪',
        assistant_message: '收到',
      }),
    });

    expect(rewritten.status).toBe(201);
    const rewrittenBody = await rewritten.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(rewrittenBody.auto_committed_count).toBe(1);
    expect(rewrittenBody.review_pending_count).toBe(0);
    expect(rewrittenBody.records).toEqual([
      expect.objectContaining({
        content: '我住大阪',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${created.batch.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
      rejected: 0,
    }));
  });

  it('rewrites the selected pending live profile-rule survivor over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const batch = server.reviewInbox.createLiveBatch({
      agent_id: 'http-live-followup-selective-rewrite-language',
      source_preview: '后续交流中文就行\n三句话内就行',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_keep_rewrite_language',
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'http_drop_rewrite_length',
          content: '三句话内就行',
          source_excerpt: '三句话内就行',
          attribute_key: 'response_length',
        }),
      ],
    });

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-live-followup-selective-rewrite-language',
        user_message: '只保留英文',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: 'Please answer in English',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${batch.batch.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
      rejected: 1,
    }));
  });

  it('keeps a pending live response-style review item unresolved when the short rewrite targets another attribute over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const initial = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-live-followup-response-style-mismatch',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      }),
    });

    expect(initial.status).toBe(201);
    const initialBody = await initial.json() as {
      review_pending_count: number;
      review_batch_id?: string;
    };
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const mismatch = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-live-followup-response-style-mismatch',
        user_message: '改英文',
        assistant_message: '收到',
      }),
    });
    expect(mismatch.status).toBe(201);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${initialBody.review_batch_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      summary: { pending: number; accepted: number };
      items: Array<{
        status: string;
        payload: { attribute_key: string; content: string };
      }>;
    };
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 1,
      accepted: 0,
    }));
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        status: 'pending',
        payload: expect.objectContaining({
          attribute_key: 'response_style',
          content: '请简洁直接回答',
        }),
      }),
    ]);
  });

  it('auto-accepts a pending live response-style review item when a later short follow-up restates the same style over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const initial = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-live-followup-response-style-restate',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      }),
    });

    expect(initial.status).toBe(201);
    const initialBody = await initial.json() as {
      review_pending_count: number;
      review_batch_id?: string;
    };
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const restated = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-live-followup-response-style-restate',
        user_message: '简洁直接一点',
        assistant_message: '收到',
      }),
    });
    expect(restated.status).toBe(201);
    const restatedBody = await restated.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(restatedBody.auto_committed_count).toBe(1);
    expect(restatedBody.review_pending_count).toBe(0);
    expect(restatedBody.records).toEqual([
      expect.objectContaining({
        content: '请简洁直接回答',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${initialBody.review_batch_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      summary: { pending: number; accepted: number };
    };
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
    }));
  });

  it('rewrites the active current task through real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-active-task-rewrite',
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
      }),
    });
    expect(seeded.status).toBe(201);

    const rewritten = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-active-task-rewrite',
        user_message: '改部署',
        assistant_message: '收到',
      }),
    });

    expect(rewritten.status).toBe(201);
    const rewrittenBody = await rewritten.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(rewrittenBody.auto_committed_count).toBe(1);
    expect(rewrittenBody.review_pending_count).toBe(0);
    expect(rewrittenBody.records).toEqual([
      expect.objectContaining({
        content: '当前任务是部署 Cortex',
      }),
    ]);

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-active-task-rewrite`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        content: '当前任务是部署 Cortex',
      }),
    ]);
  });

  it('rewrites the active organization truth and surviving relation candidate over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-active-organization-rewrite',
        kind: 'fact_slot',
        content: '我在 OpenAI 工作',
      }),
    });
    expect(seeded.status).toBe(201);

    const rewritten = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-active-organization-rewrite',
        user_message: '换 腾讯',
        assistant_message: '收到',
      }),
    });

    expect(rewritten.status).toBe(201);
    const rewrittenBody = await rewritten.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(rewrittenBody.auto_committed_count).toBe(1);
    expect(rewrittenBody.review_pending_count).toBe(0);
    expect(rewrittenBody.records).toEqual([
      expect.objectContaining({
        content: '我在 腾讯 工作',
      }),
    ]);

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-active-organization-rewrite`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        content: '我在 腾讯 工作',
      }),
    ]);

    const candidates = await fetch(`${server.baseUrl}/api/v2/relation-candidates?agent_id=http-active-organization-rewrite&status=pending`);
    expect(candidates.status).toBe(200);
    const candidatesBody = await candidates.json() as {
      items: Array<{ object_key: string }>;
    };
    expect(candidatesBody.items).toEqual([
      expect.objectContaining({
        object_key: '腾讯',
      }),
    ]);
  });

  it('resolves mixed active and pending fact follow-up state over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-active-pending-facts',
        kind: 'fact_slot',
        content: '我住东京',
      }),
    });
    expect(seeded.status).toBe(201);

    const batch = server.reviewInbox.createLiveBatch({
      agent_id: 'http-mixed-active-pending-facts',
      source_preview: '我在 OpenAI 工作',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_keep_pending_organization',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我在 OpenAI 工作',
          source_excerpt: '我在 OpenAI 工作',
          subject_key: undefined,
          entity_key: 'user',
          attribute_key: 'organization',
        }),
      ],
    });

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-active-pending-facts',
        user_message: '就公司，别记住址',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '我在 OpenAI 工作',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${batch.batch.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
      rejected: 0,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-mixed-active-pending-facts`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; attribute_key: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        attribute_key: 'organization',
        content: '我在 OpenAI 工作',
      }),
    ]);

    const candidates = await fetch(`${server.baseUrl}/api/v2/relation-candidates?agent_id=http-mixed-active-pending-facts&status=pending`);
    expect(candidates.status).toBe(200);
    const candidatesBody = await candidates.json() as {
      items: Array<{ predicate: string; object_key: string }>;
    };
    expect(candidatesBody.items).toEqual([
      expect.objectContaining({
        predicate: 'works_at',
        object_key: 'openai',
      }),
    ]);
  });

  it('resolves mixed active language plus pending response-style follow-up state over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-active-pending-style',
        kind: 'profile_rule',
        content: '请用中文回答',
      }),
    });
    expect(seeded.status).toBe(201);

    const initial = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-active-pending-style',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      }),
    });
    expect(initial.status).toBe(201);
    const initialBody = await initial.json() as {
      review_pending_count: number;
      auto_committed_count: number;
      review_batch_id?: string;
    };
    expect(initialBody.auto_committed_count).toBe(0);
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-active-pending-style',
        user_message: '只保留回答风格，别用中文',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '请简洁直接回答',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${initialBody.review_batch_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
      rejected: 0,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-mixed-active-pending-style`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; attribute_key: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        attribute_key: 'response_style',
        content: '请简洁直接回答',
      }),
    ]);
  });

  it('keeps active Chinese truth and rejects pending response-style review noise over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-language-reject-pending-style',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      }),
    });
    expect(seeded.status).toBe(201);

    const initial = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-language-reject-pending-style',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      }),
    });
    expect(initial.status).toBe(201);
    const initialBody = await initial.json() as {
      review_pending_count: number;
      auto_committed_count: number;
      review_batch_id?: string;
    };
    expect(initialBody.auto_committed_count).toBe(0);
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-language-reject-pending-style',
        user_message: '只保留中文',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '请用中文回答',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${initialBody.review_batch_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      batch: { status: string };
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-keep-active-language-reject-pending-style`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; attribute_key: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps active Chinese truth and rejects pending fact review noise over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-language-reject-pending-fact',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      }),
    });
    expect(seeded.status).toBe(201);

    const batch = server.reviewInbox.createLiveBatch({
      agent_id: 'http-keep-active-language-reject-pending-fact',
      source_preview: '我在 OpenAI 工作',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_reject_pending_fact_when_keep_language',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我在 OpenAI 工作',
          source_excerpt: '我在 OpenAI 工作',
          entity_key: 'user',
          attribute_key: 'organization',
        }),
      ],
    });

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-language-reject-pending-fact',
        user_message: '只保留中文',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '请用中文回答',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${batch.batch.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      batch: { status: string };
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-keep-active-language-reject-pending-fact`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; attribute_key: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps active Chinese truth and clears cross-bucket pending fact plus response-style noise over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-language-clear-cross-bucket-noise',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      }),
    });
    expect(seeded.status).toBe(201);

    const batch = server.reviewInbox.createLiveBatch({
      agent_id: 'http-keep-active-language-clear-cross-bucket-noise',
      source_preview: '我在 OpenAI 工作\n说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_reject_pending_organization_when_keep_language_cross_bucket',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我在 OpenAI 工作',
          source_excerpt: '我在 OpenAI 工作',
          entity_key: 'user',
          attribute_key: 'organization',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'http_reject_pending_response_style_when_keep_language_cross_bucket',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-language-clear-cross-bucket-noise',
        user_message: '只保留中文，别记公司',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '请用中文回答',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${batch.batch.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      batch: { status: string };
      summary: { pending: number; accepted: number; rejected: number };
      items: Array<{ status: string }>;
    };
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 2,
    }));
    expect(detailBody.items).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-keep-active-language-clear-cross-bucket-noise`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; attribute_key: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps active Chinese truth and clears cross-bucket pending noise across multiple live batches over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;
    const agentId = 'http-keep-language-cross-bucket-multi';

    const seeded = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      }),
    });
    expect(seeded.status).toBe(201);

    const factBatch = server.reviewInbox.createLiveBatch({
      agent_id: agentId,
      source_preview: '我在 OpenAI 工作',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_reject_pending_organization_when_keep_language_cross_batch',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我在 OpenAI 工作',
          source_excerpt: '我在 OpenAI 工作',
          entity_key: 'user',
          attribute_key: 'organization',
        }),
      ],
    });

    const styleBatch = server.reviewInbox.createLiveBatch({
      agent_id: agentId,
      source_preview: '说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_reject_pending_response_style_when_keep_language_cross_batch',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        user_message: '只保留中文，别记公司',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '请用中文回答',
      }),
    ]);

    const factDetail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${factBatch.batch.id}`);
    expect(factDetail.status).toBe(200);
    const factDetailBody = await factDetail.json() as {
      batch: { status: string };
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(factDetailBody.batch.status).toBe('dismissed');
    expect(factDetailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));

    const styleDetail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${styleBatch.batch.id}`);
    expect(styleDetail.status).toBe(200);
    const styleDetailBody = await styleDetail.json() as {
      batch: { status: string };
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(styleDetailBody.batch.status).toBe('dismissed');
    expect(styleDetailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=${agentId}`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; attribute_key: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps the active current task and rejects pending review noise over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const seededLanguage = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-task-reject-pending-style',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      }),
    });
    expect(seededLanguage.status).toBe(201);

    const seededTask = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-task-reject-pending-style',
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
        source_type: 'user_confirmed',
      }),
    });
    expect(seededTask.status).toBe(201);

    const initial = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-task-reject-pending-style',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      }),
    });
    expect(initial.status).toBe(201);
    const initialBody = await initial.json() as {
      review_pending_count: number;
      auto_committed_count: number;
      review_batch_id?: string;
    };
    expect(initialBody.auto_committed_count).toBe(0);
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-task-reject-pending-style',
        user_message: '只保留当前任务',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '当前任务是重构 Cortex recall',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${initialBody.review_batch_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      batch: { status: string };
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-keep-active-task-reject-pending-style`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; kind: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
      }),
    ]);
  });

  it('keeps the active location truth and rejects pending response-style review noise over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const seededLocation = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-location-reject-pending-style',
        kind: 'fact_slot',
        content: '我住东京',
        source_type: 'user_confirmed',
      }),
    });
    expect(seededLocation.status).toBe(201);

    const initial = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-location-reject-pending-style',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      }),
    });
    expect(initial.status).toBe(201);
    const initialBody = await initial.json() as {
      review_pending_count: number;
      auto_committed_count: number;
      review_batch_id?: string;
    };
    expect(initialBody.auto_committed_count).toBe(0);
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const selected = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-keep-active-location-reject-pending-style',
        user_message: '只保留住址',
        assistant_message: '收到',
      }),
    });

    expect(selected.status).toBe(201);
    const selectedBody = await selected.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        content: '我住东京',
      }),
    ]);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${initialBody.review_batch_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      batch: { status: string };
      summary: { pending: number; accepted: number; rejected: number };
    };
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-keep-active-location-reject-pending-style`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: Array<{ content: string; kind: string; attribute_key: string }>;
    };
    expect(listedBody.items).toEqual([
      expect.objectContaining({
        kind: 'fact_slot',
        attribute_key: 'location',
        content: '我住东京',
      }),
    ]);
  });

  it('routes mixed auto-commit plus review ingest over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const ingested = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-auto-review-routing',
        user_message: '后续交流中文就行。说话干脆一点',
        assistant_message: '收到',
      }),
    });

    expect(ingested.status).toBe(201);
    const ingestBody = await ingested.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      review_batch_id?: string;
      review_source_preview?: string;
      records: Array<{ content: string }>;
    };
    expect(ingestBody.auto_committed_count).toBe(1);
    expect(ingestBody.review_pending_count).toBe(1);
    expect(ingestBody.review_source_preview).toBe('说话干脆一点');
    expect(ingestBody.records).toEqual([
      expect.objectContaining({
        content: '请用中文回答',
      }),
    ]);
    expect(typeof ingestBody.review_batch_id).toBe('string');

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${ingestBody.review_batch_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      batch: { source_preview: string };
      summary: { pending: number };
      items: Array<{
        payload: {
          content: string;
          source_excerpt: string;
        };
      }>;
    };
    expect(detailBody.batch.source_preview).toBe('说话干脆一点');
    expect(detailBody.summary.pending).toBe(1);
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
        }),
      }),
    ]);
  });

  it('auto-commits compound durable ingest without creating review work over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const ingested = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-compound-auto-routing',
        user_message: '人在东京这边。先收一下 recall 那块',
        assistant_message: '记住了',
      }),
    });

    expect(ingested.status).toBe(201);
    const ingestBody = await ingested.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      review_batch_id?: string | null;
      records: Array<{ content: string }>;
    };
    expect(ingestBody.auto_committed_count).toBe(2);
    expect(ingestBody.review_pending_count).toBe(0);
    expect(ingestBody.review_batch_id || null).toBe(null);
    expect(ingestBody.records.map((item) => item.content).sort()).toEqual([
      '当前任务是重构 Cortex recall',
      '我住东京',
    ]);

    const inbox = await fetch(`${server.baseUrl}/api/v2/review-inbox?agent_id=http-compound-auto-routing`);
    expect(inbox.status).toBe(200);
    const inboxBody = await inbox.json() as {
      items: unknown[];
    };
    expect(inboxBody.items).toHaveLength(0);
  });

  it('drops all mixed active truths over real HTTP transport', async () => {
    const server = await createServer();
    app = server.app;

    const seededLanguage = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-drop-all',
        kind: 'profile_rule',
        content: '请用中文回答',
      }),
    });
    expect(seededLanguage.status).toBe(201);

    const seededLocation = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-drop-all',
        kind: 'fact_slot',
        content: '我住东京',
      }),
    });
    expect(seededLocation.status).toBe(201);

    const dropped = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-drop-all',
        user_message: '都去掉',
        assistant_message: '收到',
      }),
    });

    expect(dropped.status).toBe(201);
    const droppedBody = await dropped.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(droppedBody.auto_committed_count).toBe(0);
    expect(droppedBody.review_pending_count).toBe(0);
    expect(droppedBody.records).toHaveLength(0);

    const records = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-mixed-drop-all`);
    expect(records.status).toBe(200);
    const recordsBody = await records.json() as {
      items: unknown[];
    };
    expect(recordsBody.items).toHaveLength(0);

    const candidates = await fetch(`${server.baseUrl}/api/v2/relation-candidates?agent_id=http-mixed-drop-all&status=pending`);
    expect(candidates.status).toBe(200);
    const candidatesBody = await candidates.json() as {
      items: unknown[];
    };
    expect(candidatesBody.items).toHaveLength(0);
  });

  it('drops mixed active truths and pending live review items over real HTTP transport', async () => {
    const server = await createServer({ responseStyleReview: true });
    app = server.app;

    const seededLanguage = await fetch(`${server.baseUrl}/api/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-active-pending-drop-all',
        kind: 'profile_rule',
        content: '请用中文回答',
      }),
    });
    expect(seededLanguage.status).toBe(201);

    const batch = server.reviewInbox.createLiveBatch({
      agent_id: 'http-mixed-active-pending-drop-all',
      source_preview: '说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'http_drop_pending_style',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    const dropped = await fetch(`${server.baseUrl}/api/v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'http-mixed-active-pending-drop-all',
        user_message: '都去掉',
        assistant_message: '收到',
      }),
    });

    expect(dropped.status).toBe(201);
    const droppedBody = await dropped.json() as {
      auto_committed_count: number;
      review_pending_count: number;
      records: Array<{ content: string }>;
    };
    expect(droppedBody.auto_committed_count).toBe(0);
    expect(droppedBody.review_pending_count).toBe(0);
    expect(droppedBody.records).toHaveLength(0);

    const detail = await fetch(`${server.baseUrl}/api/v2/review-inbox/${batch.batch.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      batch: { status: string };
      summary: { pending: number; rejected: number };
    };
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      rejected: 1,
    }));

    const listed = await fetch(`${server.baseUrl}/api/v2/records?agent_id=http-mixed-active-pending-drop-all`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      items: unknown[];
    };
    expect(listedBody.items).toHaveLength(0);
  });
});

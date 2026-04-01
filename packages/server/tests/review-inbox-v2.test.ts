import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeDatabase, initDatabase } from '../src/db/index.js';
import { getDb } from '../src/db/connection.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import { CortexRelationsV2 } from '../src/v2/relations.js';
import { CortexRecordsV2 } from '../src/v2/service.js';
import { registerImportExportRoutes } from '../src/api/import-export.js';
import { registerV2IngestRoutes } from '../src/api/ingest-v2.js';
import { registerV2RecordRoutes } from '../src/api/records-v2.js';
import { registerV2ReviewInboxRoutes } from '../src/api/review-inbox-v2.js';
import { CortexReviewInboxV2 } from '../src/v2/review-inbox.js';
import {
  createNoOpLLM,
  createReviewAssistRecordPayload,
  createReviewInboxDurableMockLLM,
  createWeakColloquialProfileRuleDriftMockLLM,
} from './helpers/v2-contract-fixtures.js';

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock-embedding',
    dimensions: 4,
    embed: async () => [],
    embedBatch: async (texts: string[]) => texts.map(() => []),
  };
}

async function createApp(options: { reviewOnly?: boolean; weakColloquial?: boolean } = {}): Promise<{
  app: FastifyInstance;
  records: CortexRecordsV2;
  relations: CortexRelationsV2;
  reviewInbox: CortexReviewInboxV2;
}> {
  initDatabase(':memory:');
  const records = new CortexRecordsV2(
    options.weakColloquial
      ? createWeakColloquialProfileRuleDriftMockLLM()
      : options.reviewOnly
        ? createReviewInboxDurableMockLLM()
        : createNoOpLLM(),
    createMockEmbedding(),
  );
  await records.initialize();
  const relations = new CortexRelationsV2();
  const reviewInbox = new CortexReviewInboxV2(records, relations);

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
  registerV2ReviewInboxRoutes(app, cortex);
  await app.ready();

  return { app, records, relations, reviewInbox };
}

describe('V2 review inbox', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
  });

  afterEach(async () => {
    await app.close().catch(() => undefined);
    closeDatabase();
  });

  it('creates review inbox tables during database initialization', async () => {
    initDatabase(':memory:');
    const db = getDb();

    const batchColumns = db.prepare('PRAGMA table_info(review_batches_v2)').all() as Array<{ name: string }>;
    const itemColumns = db.prepare('PRAGMA table_info(review_items_v2)').all() as Array<{ name: string }>;

    expect(batchColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id',
      'agent_id',
      'source_kind',
      'status',
      'source_preview',
    ]));
    expect(itemColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id',
      'batch_id',
      'item_type',
      'status',
      'payload_json',
    ]));
  });

  it('auto-commits deterministic ingest candidates without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto',
        user_message: '请用中文回答',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(1);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toHaveLength(1);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-auto',
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload).items).toHaveLength(0);
  });

  it('auto-commits stable colloquial ingest preferences without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial',
        user_message: '后续交流中文就行',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(1);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请用中文回答',
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-auto-colloquial',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]));
  });

  it('routes deep-only durable live ingest candidates into the review inbox', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live',
        user_message: '把输出语言设成中文',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(0);
    expect(body.review_pending_count).toBe(1);
    expect(typeof body.review_batch_id).toBe('string');
    expect(body.records).toHaveLength(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${body.review_batch_id}`,
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.source_kind).toBe('live_ingest');
    expect(detailBody.summary.pending).toBe(1);
    expect(detailBody.items).toHaveLength(1);
    expect(detailBody.items[0]).toEqual(expect.objectContaining({
      item_type: 'record',
      status: 'pending',
      suggested_action: expect.any(String),
      suggested_rewrite: '请用中文回答',
    }));
    expect(detailBody.items[0].payload.content).toBe('请用中文回答');
  });

  it('keeps weak colloquial ingest preferences as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial',
        user_message: '中文就行吧',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(1);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '中文就行吧',
    }));

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-weak-colloquial',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('keeps weak colloquial complexity ingest content as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-complexity',
        user_message: '可能简单点更好',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(1);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '可能简单点更好',
    }));

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-weak-colloquial-complexity',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('emits tracing headers for review inbox list and detail reads', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-observed',
      source_preview: '把输出语言设成中文',
      items: [
        createReviewAssistRecordPayload({
          content: '请用中文回答',
          source_excerpt: '把输出语言设成中文',
        }),
      ],
    });

    const smokeRunId = 'smoke-review-inbox-observed';
    const list = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-observed',
      headers: {
        'x-cortex-smoke-run': smokeRunId,
      },
    });

    expect(list.statusCode).toBe(200);
    expect(list.headers['x-cortex-request-id']).toBeTruthy();
    expect(list.headers['x-cortex-smoke-run']).toBe(smokeRunId);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
      headers: {
        'x-cortex-smoke-run': smokeRunId,
      },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.headers['x-cortex-request-id']).toBeTruthy();
    expect(detail.headers['x-cortex-smoke-run']).toBe(smokeRunId);
  });

  it('persists canonical rewrites for colloquial live review items', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-suggested',
      source_preview: '后续交流中文就行',
      items: [
        createReviewAssistRecordPayload({
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
        }),
      ],
    });

    expect(created.summary.pending).toBe(1);
    expect(created.items[0]).toEqual(expect.objectContaining({
      suggested_action: 'accept',
      suggested_rewrite: '请用中文回答',
    }));
  });

  it('does not persist suggested rewrites for warned review items', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-warned',
      source_preview: '后续交流中文就行',
      items: [
        createReviewAssistRecordPayload({
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
          warnings: ['unstable_attribute'],
        }),
      ],
    });

    expect(created.items[0]).toEqual(expect.objectContaining({
      suggested_action: 'edit',
      suggested_rewrite: null,
    }));
  });

  it('creates an import review batch for text input and applies accept_all through the existing write path', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import',
        format: 'text',
        content: '后续交流中文就行',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(typeof createdBody.batch_id).toBe('string');
    expect(createdBody.summary.pending).toBe(1);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${createdBody.batch_id}/apply`,
      payload: {
        accept_all: true,
      },
    });

    expect(applied.statusCode).toBe(200);
    const appliedBody = JSON.parse(applied.payload);
    expect(appliedBody.summary.committed).toBe(1);
    expect(appliedBody.remaining_pending).toBe(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${createdBody.batch_id}`,
    });
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.status).toBe('completed');
    expect(detailBody.summary.accepted).toBe(1);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import',
    });
    expect(records.statusCode).toBe(200);
    const recordsBody = JSON.parse(records.payload);
    expect(recordsBody.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]));
  });

  it('persists canonical rewrites for import review batches built from deterministic preview items', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-preview',
        format: 'text',
        content: '回答控制在三句话内',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${createdBody.batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload).items[0]).toEqual(expect.objectContaining({
      suggested_action: 'accept',
      suggested_rewrite: '请把回答控制在三句话内',
    }));
  });

  it('commits explicit payload overrides through review batch apply', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-override',
        format: 'text',
        content: '回答控制在三句话内',
      },
    });

    const createdBody = JSON.parse(created.payload);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${createdBody.batch_id}`,
    });
    const detailBody = JSON.parse(detail.payload);
    const recordItem = detailBody.items.find((item: any) => item.item_type === 'record');

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${createdBody.batch_id}/apply`,
      payload: {
        item_actions: [{
          item_id: recordItem.id,
          action: 'edit_then_accept',
          payload_override: {
            content: '请把回答控制在两句话内',
          },
        }],
      },
    });

    expect(applied.statusCode).toBe(200);
    expect(JSON.parse(applied.payload).summary).toEqual({
      committed: 1,
      rejected: 0,
      failed: 0,
    });

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-override',
    });

    expect(JSON.parse(records.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_length',
        content: '请把回答控制在两句话内',
      }),
    ]));
  });

  it('dismisses a review batch with reject_all without writing records', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-reject',
        format: 'text',
        content: '后续交流中文就行',
      },
    });
    const createdBody = JSON.parse(created.payload);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${createdBody.batch_id}/apply`,
      payload: {
        reject_all: true,
      },
    });

    expect(rejected.statusCode).toBe(200);
    const rejectedBody = JSON.parse(rejected.payload);
    expect(rejectedBody.summary.rejected).toBe(1);
    expect(rejectedBody.remaining_pending).toBe(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${createdBody.batch_id}`,
    });
    expect(JSON.parse(detail.payload).batch.status).toBe('dismissed');

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-reject',
    });
    expect(JSON.parse(records.payload).items).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeDatabase, initDatabase } from '../src/db/index.js';
import { getDb } from '../src/db/connection.js';
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
  createReviewAssistRelationPayload,
  createReviewInboxCompoundDurableMockLLM,
  createReviewInboxDurableMockLLM,
  createReviewInboxResponseStyleMockLLM,
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

async function createApp(options: { reviewOnly?: boolean; weakColloquial?: boolean; compoundReview?: boolean; responseStyleReview?: boolean } = {}): Promise<{
  app: FastifyInstance;
  records: CortexRecordsV2;
  relations: CortexRelationsV2;
  reviewInbox: CortexReviewInboxV2;
}> {
  initDatabase(':memory:');
  const records = new CortexRecordsV2(
    options.compoundReview
      ? createReviewInboxCompoundDurableMockLLM()
      : options.weakColloquial
      ? createWeakColloquialProfileRuleDriftMockLLM()
      : options.responseStyleReview
        ? createReviewInboxResponseStyleMockLLM()
      : options.reviewOnly
        ? createReviewInboxDurableMockLLM()
        : createNoOpLLM(),
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
  registerV2RelationsRoutes(app, cortex);
  registerImportExportRoutes(app, cortex);
  registerV2ReviewInboxRoutes(app, cortex);
  registerAgentRoutes(app);
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

  it('auto-resolves pending live review items when later truth writes confirm the same stable key', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const initial = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-reconcile-match',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(initial.statusCode).toBe(201);
    const initialBody = JSON.parse(initial.payload);
    expect(initialBody.auto_committed_count).toBe(0);
    expect(initialBody.review_pending_count).toBe(1);
    expect(initialBody.review_batch_id).toBeTruthy();

    const batchId = initialBody.review_batch_id as string;

    const resolved = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-reconcile-match',
        kind: 'profile_rule',
        content: '请简洁直接回答',
        attribute_key: 'response_style',
        subject_key: 'user',
        source_type: 'user_confirmed',
      },
    });

    expect(resolved.statusCode).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batchId}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.status).toBe('completed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
      rejected: 0,
    }));
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        status: 'accepted',
      }),
    ]);

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-live-reconcile-match&status=pending',
    });
    expect(pending.statusCode).toBe(200);
    expect(JSON.parse(pending.payload).items).toHaveLength(0);
  });

  it('rejects pending live review items when newer truth supersedes the same stable key', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const initial = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-reconcile-conflict',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(initial.statusCode).toBe(201);
    const initialBody = JSON.parse(initial.payload);
    expect(initialBody.review_batch_id).toBeTruthy();
    const batchId = initialBody.review_batch_id as string;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-reconcile-conflict',
        kind: 'profile_rule',
        content: '请详细回答',
        attribute_key: 'response_style',
        subject_key: 'user',
        source_type: 'user_confirmed',
      },
    });

    expect(seeded.statusCode).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batchId}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        status: 'rejected',
      }),
    ]);
  });

  it('auto-accepts a single pending live review item when a later short confirmation arrives', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const initial = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-confirm',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(initial.statusCode).toBe(201);
    const initialBody = JSON.parse(initial.payload);
    expect(initialBody.review_batch_id).toBeTruthy();

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-confirm',
        user_message: '可以',
        assistant_message: '收到',
      },
    });

    expect(confirmed.statusCode).toBe(201);
    const confirmedBody = JSON.parse(confirmed.payload);
    expect(confirmedBody.auto_committed_count).toBe(1);
    expect(confirmedBody.review_pending_count).toBe(0);
    expect(confirmedBody.review_batch_id || null).toBe(null);
    expect(confirmedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: '请简洁直接回答',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${initialBody.review_batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.status).toBe('completed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
      rejected: 0,
    }));
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        status: 'accepted',
      }),
    ]);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-confirm',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_style',
        content: '请简洁直接回答',
      }),
    ]);
  });

  it('auto-rejects a single pending live review item when a later short rejection arrives', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const initial = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-reject',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(initial.statusCode).toBe(201);
    const initialBody = JSON.parse(initial.payload);
    expect(initialBody.review_batch_id).toBeTruthy();

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-reject',
        user_message: '不要这个',
        assistant_message: '收到',
      },
    });

    expect(rejected.statusCode).toBe(201);
    const rejectedBody = JSON.parse(rejected.payload);
    expect(rejectedBody.auto_committed_count).toBe(0);
    expect(rejectedBody.review_pending_count).toBe(0);
    expect(rejectedBody.review_batch_id || null).toBe(null);
    expect(rejectedBody.records).toHaveLength(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${initialBody.review_batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.status).toBe('dismissed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 0,
      rejected: 1,
    }));
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        status: 'rejected',
      }),
    ]);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-reject',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toHaveLength(0);
  });

  it('auto-rewrites a single pending live fact review item when a later short follow-up changes the value', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-rewrite-fact',
      source_preview: '我住东京',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_rewrite_location',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我住东京',
          source_excerpt: '我住东京',
          subject_key: undefined,
          entity_key: 'user',
          attribute_key: 'location',
        }),
      ],
    });

    expect(created.summary.pending).toBe(1);

    const rewritten = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-rewrite-fact',
        user_message: '换大阪',
        assistant_message: '收到',
      },
    });

    expect(rewritten.statusCode).toBe(201);
    const rewrittenBody = JSON.parse(rewritten.payload);
    expect(rewrittenBody.auto_committed_count).toBe(1);
    expect(rewrittenBody.review_pending_count).toBe(0);
    expect(rewrittenBody.review_batch_id || null).toBe(null);
    expect(rewrittenBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'fact_slot',
        source_type: 'user_confirmed',
        content: '我住大阪',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.status).toBe('completed');
    expect(detailBody.summary).toEqual(expect.objectContaining({
      pending: 0,
      accepted: 1,
      rejected: 0,
    }));
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        status: 'accepted',
      }),
    ]);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-rewrite-fact',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'fact_slot',
        attribute_key: 'location',
        content: '我住大阪',
      }),
    ]);
  });

  it('does not auto-accept a single pending live response-style review item with a mismatched short rewrite', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const initial = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-rewrite-response-style-mismatch',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(initial.statusCode).toBe(201);
    const initialBody = JSON.parse(initial.payload);
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-rewrite-response-style-mismatch',
        user_message: '改英文',
        assistant_message: '收到',
      },
    });

    expect(mismatch.statusCode).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${initialBody.review_batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'pending',
      }),
      summary: expect.objectContaining({
        pending: 1,
        accepted: 0,
      }),
      items: [
        expect.objectContaining({
          status: 'pending',
          payload: expect.objectContaining({
            normalized_kind: 'profile_rule',
            attribute_key: 'response_style',
            content: '请简洁直接回答',
          }),
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-rewrite-response-style-mismatch',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_style',
        content: '请用英文回答',
      }),
    ]));
  });

  it('auto-accepts a single pending live response-style review item when a later short follow-up restates the same style explicitly', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const initial = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-rewrite-response-style-match',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(initial.statusCode).toBe(201);
    const initialBody = JSON.parse(initial.payload);
    expect(initialBody.review_pending_count).toBe(1);
    expect(typeof initialBody.review_batch_id).toBe('string');

    const matched = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-rewrite-response-style-match',
        user_message: '简洁直接一点',
        assistant_message: '收到',
      },
    });

    expect(matched.statusCode).toBe(201);
    const matchedBody = JSON.parse(matched.payload);
    expect(matchedBody.auto_committed_count).toBe(1);
    expect(matchedBody.review_pending_count).toBe(0);
    expect(matchedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        content: '请简洁直接回答',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${initialBody.review_batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'completed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 1,
      }),
    }));
  });

  it('dismisses multiple pending live review items when a later short drop-all arrives', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-drop-all',
      source_preview: '后续交流中文就行\n回答控制在三句话内',
      items: [
        createReviewAssistRecordPayload({
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'review_drop_all_length',
          content: '回答控制在三句话内',
          source_excerpt: '回答控制在三句话内',
        }),
      ],
    });

    expect(created.summary.pending).toBe(2);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-drop-all',
        user_message: '都去掉',
        assistant_message: '收到',
      },
    });

    expect(rejected.statusCode).toBe(201);
    const rejectedBody = JSON.parse(rejected.payload);
    expect(rejectedBody.auto_committed_count).toBe(0);
    expect(rejectedBody.review_pending_count).toBe(0);
    expect(rejectedBody.review_batch_id || null).toBe(null);
    expect(rejectedBody.records).toHaveLength(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
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
  });

  it('auto-applies mixed pending live review survivors across batches when a later short follow-up selects both profile rules and facts', async () => {
    const setup = await createApp();
    app = setup.app;

    const ruleBatch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-selective-mixed',
      source_preview: '后续交流中文就行\n回答控制在三句话内',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_keep_language',
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'review_drop_length',
          content: '回答控制在三句话内',
          source_excerpt: '回答控制在三句话内',
          attribute_key: 'response_length',
        }),
      ],
    });
    const factBatch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-selective-mixed',
      source_preview: '我住东京\n我在 OpenAI 工作',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_keep_location',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我住东京',
          source_excerpt: '我住东京',
          subject_key: undefined,
          entity_key: 'user',
          attribute_key: 'location',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'review_drop_organization',
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

    expect(ruleBatch.summary.pending).toBe(2);
    expect(factBatch.summary.pending).toBe(2);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-selective-mixed',
        user_message: '只保留中文和住址',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(2);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toHaveLength(2);
    expect(selectedBody.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: '请用中文回答',
      }),
      expect.objectContaining({
        written_kind: 'fact_slot',
        source_type: 'user_confirmed',
        content: '我住东京',
      }),
    ]));

    const ruleDetail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${ruleBatch.batch.id}`,
    });

    expect(ruleDetail.statusCode).toBe(200);
    expect(JSON.parse(ruleDetail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'completed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 1,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'accepted',
        }),
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const factDetail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${factBatch.batch.id}`,
    });

    expect(factDetail.statusCode).toBe(200);
    expect(JSON.parse(factDetail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'completed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 1,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'accepted',
        }),
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-selective-mixed',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items.map((item: any) => item.content).sort()).toEqual([
      '我住东京',
      '请用中文回答',
    ]);
  });

  it('resolves mixed active and pending fact follow-up state in one ingest when keep-drop spans both sides', async () => {
    const setup = await createApp();
    app = setup.app;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-followup-mixed-active-pending-facts',
        kind: 'fact_slot',
        content: '我住东京',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-mixed-active-pending-facts',
      source_preview: '我在 OpenAI 工作',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_keep_pending_organization',
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

    expect(batch.summary.pending).toBe(1);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-mixed-active-pending-facts',
        user_message: '就公司，别记住址',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'fact_slot',
        source_type: 'user_confirmed',
        content: '我在 OpenAI 工作',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'completed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 1,
        rejected: 0,
      }),
      items: [
        expect.objectContaining({
          status: 'accepted',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-mixed-active-pending-facts',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'fact_slot',
        attribute_key: 'organization',
        content: '我在 OpenAI 工作',
      }),
    ]);

    const candidates = await app.inject({
      method: 'GET',
      url: '/api/v2/relation-candidates?agent_id=review-live-followup-mixed-active-pending-facts&status=pending',
    });
    expect(candidates.statusCode).toBe(200);
    expect(JSON.parse(candidates.payload).items).toEqual([
      expect.objectContaining({
        predicate: 'works_at',
        object_key: 'openai',
      }),
    ]);
  });

  it('rewrites the selected pending live profile rule survivor when a later short follow-up changes its value', async () => {
    const setup = await createApp();
    app = setup.app;

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-selective-rewrite-language',
      source_preview: '后续交流中文就行\n三句话内就行',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_keep_rewrite_language',
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'review_drop_rewrite_length',
          content: '三句话内就行',
          source_excerpt: '三句话内就行',
          attribute_key: 'response_length',
        }),
      ],
    });

    expect(batch.summary.pending).toBe(2);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-selective-rewrite-language',
        user_message: '只保留英文',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: 'Please answer in English',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch?.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'completed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 1,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'accepted',
        }),
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-selective-rewrite-language',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: 'Please answer in English',
      }),
    ]);
  });

  it('keeps only the pending live response-style survivor when a short follow-up selects that attribute explicitly', async () => {
    const setup = await createApp();
    app = setup.app;

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-selective-response-style',
      source_preview: '后续交流中文就行\n说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_drop_language_for_style',
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'review_keep_response_style',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    expect(batch.summary.pending).toBe(2);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-selective-response-style',
        user_message: '只保留回答风格',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: '请简洁直接回答',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch?.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'completed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 1,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'rejected',
        }),
        expect.objectContaining({
          status: 'accepted',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-selective-response-style',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_style',
        content: '请简洁直接回答',
      }),
    ]);
  });

  it('keeps the active language truth and rejects pending response-style review noise when a short follow-up selects only Chinese', async () => {
    const setup = await createApp();
    app = setup.app;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-followup-keep-active-language',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-keep-active-language',
      source_preview: '说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_response_style_when_keep_language',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    expect(batch.summary.pending).toBe(1);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-keep-active-language',
        user_message: '只保留中文',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: '请用中文回答',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch?.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-keep-active-language',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps the active language truth and rejects pending fact review noise when a short follow-up selects only Chinese', async () => {
    const setup = await createApp();
    app = setup.app;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-followup-keep-active-language-reject-pending-fact',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-keep-active-language-reject-pending-fact',
      source_preview: '我在 OpenAI 工作',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_fact_when_keep_language',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我在 OpenAI 工作',
          source_excerpt: '我在 OpenAI 工作',
          entity_key: 'user',
          attribute_key: 'organization',
        }),
      ],
    });

    expect(batch.summary.pending).toBe(1);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-keep-active-language-reject-pending-fact',
        user_message: '只保留中文',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: '请用中文回答',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch?.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-keep-active-language-reject-pending-fact',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps the active language truth and clears cross-bucket pending fact plus response-style noise when a short follow-up selects only Chinese', async () => {
    const setup = await createApp();
    app = setup.app;
    const agentId = 'review-live-followup-cross-bucket-language';

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: agentId,
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: agentId,
      source_preview: '我在 OpenAI 工作\n说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_organization_when_keep_language_cross_bucket',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我在 OpenAI 工作',
          source_excerpt: '我在 OpenAI 工作',
          entity_key: 'user',
          attribute_key: 'organization',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_response_style_when_keep_language_cross_bucket',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    expect(batch.summary.pending).toBe(2);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: agentId,
        user_message: '只保留中文，别记公司',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: '请用中文回答',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch?.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 2,
      }),
      items: [
        expect.objectContaining({
          status: 'rejected',
        }),
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: `/api/v2/records?agent_id=${agentId}`,
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps the active language truth and clears cross-bucket pending noise across multiple live batches when a short follow-up selects only Chinese', async () => {
    const setup = await createApp();
    app = setup.app;
    const agentId = 'review-live-followup-cross-bucket-language-multi';

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: agentId,
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const factBatch = setup.reviewInbox.createLiveBatch({
      agent_id: agentId,
      source_preview: '我在 OpenAI 工作',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_organization_when_keep_language_cross_batch',
          requested_kind: 'fact_slot',
          normalized_kind: 'fact_slot',
          content: '我在 OpenAI 工作',
          source_excerpt: '我在 OpenAI 工作',
          entity_key: 'user',
          attribute_key: 'organization',
        }),
      ],
    });
    expect(factBatch.summary.pending).toBe(1);

    const styleBatch = setup.reviewInbox.createLiveBatch({
      agent_id: agentId,
      source_preview: '说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_response_style_when_keep_language_cross_batch',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });
    expect(styleBatch.summary.pending).toBe(1);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: agentId,
        user_message: '只保留中文，别记公司',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        source_type: 'user_confirmed',
        content: '请用中文回答',
      }),
    ]);

    const factDetail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${factBatch.batch?.id}`,
    });
    expect(factDetail.statusCode).toBe(200);
    expect(JSON.parse(factDetail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 1,
      }),
    }));

    const styleDetail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${styleBatch.batch?.id}`,
    });
    expect(styleDetail.statusCode).toBe(200);
    expect(JSON.parse(styleDetail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 1,
      }),
    }));

    const records = await app.inject({
      method: 'GET',
      url: `/api/v2/records?agent_id=${agentId}`,
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('keeps the active current task and rejects pending review noise when a short follow-up selects only the current task', async () => {
    const setup = await createApp();
    app = setup.app;

    const seededLanguage = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-followup-keep-active-task',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seededLanguage.statusCode).toBe(201);

    const seededTask = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-followup-keep-active-task',
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
        source_type: 'user_confirmed',
      },
    });
    expect(seededTask.statusCode).toBe(201);

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-keep-active-task',
      source_preview: '说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_response_style_when_keep_task',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    expect(batch.summary.pending).toBe(1);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-keep-active-task',
        user_message: '只保留当前任务',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'task_state',
        source_type: 'user_confirmed',
        content: '当前任务是重构 Cortex recall',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch?.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-keep-active-task',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'task_state',
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      }),
    ]);
  });

  it('keeps the active location truth and rejects pending response-style review noise when a short follow-up selects only the address', async () => {
    const setup = await createApp();
    app = setup.app;

    const seededLocation = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-live-followup-keep-active-location',
        kind: 'fact_slot',
        content: '我住东京',
        source_type: 'user_confirmed',
      },
    });
    expect(seededLocation.statusCode).toBe(201);

    const batch = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-followup-keep-active-location',
      source_preview: '说话干脆一点',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_reject_pending_response_style_when_keep_location',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          attribute_key: 'response_style',
        }),
      ],
    });

    expect(batch.summary.pending).toBe(1);

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-followup-keep-active-location',
        user_message: '只保留住址',
        assistant_message: '收到',
      },
    });

    expect(selected.statusCode).toBe(201);
    const selectedBody = JSON.parse(selected.payload);
    expect(selectedBody.auto_committed_count).toBe(1);
    expect(selectedBody.review_pending_count).toBe(0);
    expect(selectedBody.review_batch_id || null).toBe(null);
    expect(selectedBody.records).toEqual([
      expect.objectContaining({
        written_kind: 'fact_slot',
        source_type: 'user_confirmed',
        content: '我住东京',
      }),
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${batch.batch?.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'rejected',
        }),
      ],
    }));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-followup-keep-active-location',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'fact_slot',
        attribute_key: 'location',
        content: '我住东京',
      }),
    ]);
  });

  it('suppresses canonical no-op auto-commit ingest work when the same truth is already active', async () => {
    const setup = await createApp();
    app = setup.app;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-auto-noop-language',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-noop-language',
        user_message: '后续交流中文就行',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(0);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toHaveLength(0);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-auto-noop-language',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]);
  });

  it('auto-commits deterministic response-style profile rules without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-response-style-deterministic',
        user_message: '回答简洁直接',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(1);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toEqual([
      expect.objectContaining({
        written_kind: 'profile_rule',
        content: '请简洁直接回答',
      }),
    ]);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-response-style-deterministic',
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.payload).items).toHaveLength(0);
  });

  it('auto-commits explicit response-style imports without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-explicit-response-style',
        format: 'text',
        content: '回答风格简洁直接',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(1);
    expect(createdBody.summary).toEqual({
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
    });

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-explicit-response-style',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_style',
        content: '请简洁直接回答',
      }),
    ]));
  });

  it('auto-commits explicit colloquial response-style imports without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-explicit-colloquial-response-style',
        format: 'text',
        content: '简洁直接一点',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(1);
    expect(createdBody.summary).toEqual({
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
    });

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-explicit-colloquial-response-style',
    });
    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_style',
        content: '请简洁直接回答',
      }),
    ]));
  });

  it('suppresses repeated live review-only inputs when the canonical rewrite already exists as active truth', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-noop-existing-response-style',
        kind: 'profile_rule',
        content: '请简洁直接回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-noop-existing-response-style',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(0);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toHaveLength(0);

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-noop-existing-response-style',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('routes colloquial response-style imports into review with the same canonical rewrite', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-colloquial-response-style',
        format: 'text',
        content: '说话干脆一点',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.auto_committed_count).toBe(0);
    expect(createdBody.summary.pending).toBe(1);
    expect(createdBody.source_preview).toBe('说话干脆一点');
    expect(typeof createdBody.batch_id).toBe('string');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${createdBody.batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload).items).toEqual([
      expect.objectContaining({
        suggested_action: 'accept',
        suggested_rewrite: '请简洁直接回答',
        payload: expect.objectContaining({
          normalized_kind: 'profile_rule',
          attribute_key: 'response_style',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
        }),
      }),
    ]);
  });

  it('suppresses import review batches when the canonical review-only rewrite already exists as active truth', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-import-noop-existing-response-style',
        kind: 'profile_rule',
        content: '请简洁直接回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-noop-existing-response-style',
        format: 'text',
        content: '说话干脆一点',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(0);
    expect(createdBody.summary).toEqual({
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
    });

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-import-noop-existing-response-style',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('does not create a second pending review batch when the same canonical review-only key is already pending', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-noop-existing-pending-response-style',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.payload);
    expect(typeof firstBody.review_batch_id).toBe('string');
    expect(firstBody.review_pending_count).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-noop-existing-pending-response-style',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(second.statusCode).toBe(201);
    const secondBody = JSON.parse(second.payload);
    expect(secondBody.auto_committed_count).toBe(0);
    expect(secondBody.review_pending_count).toBe(0);
    expect(secondBody.review_batch_id || null).toBe(null);

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-noop-existing-pending-response-style',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(1);
  });

  it('supersedes older pending live review items when a newer candidate uses the same stable key', async () => {
    const setup = await createApp();
    app = setup.app;

    const first = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-pending-supersede',
      source_preview: '先回答简洁一些',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_response_style_old',
          content: '请简洁直接回答',
          source_excerpt: '先回答简洁一些',
          owner_scope: 'user',
          subject_key: 'user',
          attribute_key: 'response_style',
        }),
      ],
    });

    expect(first.summary.pending).toBe(1);
    expect(first.batch?.status).toBe('pending');

    const second = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-pending-supersede',
      source_preview: '改成详细一些',
      items: [
        createReviewAssistRecordPayload({
          candidate_id: 'review_response_style_new',
          content: '请详细回答',
          source_excerpt: '改成详细一些',
          owner_scope: 'user',
          subject_key: 'user',
          attribute_key: 'response_style',
        }),
      ],
    });

    expect(second.summary.pending).toBe(1);
    expect(second.batch?.status).toBe('pending');

    const oldDetail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${first.batch?.id}`,
    });
    expect(oldDetail.statusCode).toBe(200);
    expect(JSON.parse(oldDetail.payload)).toEqual(expect.objectContaining({
      batch: expect.objectContaining({
        status: 'dismissed',
      }),
      summary: expect.objectContaining({
        pending: 0,
        accepted: 0,
        rejected: 1,
      }),
      items: [
        expect.objectContaining({
          status: 'rejected',
          error_message: 'superseded_by_newer_review_candidate',
        }),
      ],
    }));

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-live-pending-supersede&status=pending',
    });
    expect(pending.statusCode).toBe(200);
    expect(JSON.parse(pending.payload).items).toEqual([
      expect.objectContaining({
        id: second.batch?.id,
      }),
    ]);
  });

  it('accepts response-style review batches through the canonical suggested rewrite', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const ingested = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-response-style-apply',
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(ingested.statusCode).toBe(201);
    const ingestBody = JSON.parse(ingested.payload);
    expect(typeof ingestBody.review_batch_id).toBe('string');
    expect(ingestBody.auto_committed_count).toBe(0);
    expect(ingestBody.review_pending_count).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${ingestBody.review_batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        suggested_action: 'accept',
        suggested_rewrite: '请简洁直接回答',
        payload: expect.objectContaining({
          normalized_kind: 'profile_rule',
          attribute_key: 'response_style',
        }),
      }),
    ]);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${ingestBody.review_batch_id}/apply`,
      payload: {
        accept_all: true,
      },
    });

    expect(applied.statusCode).toBe(200);
    const appliedBody = JSON.parse(applied.payload);
    expect(appliedBody.summary.committed).toBe(1);
    expect(appliedBody.remaining_pending).toBe(0);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-response-style-apply',
    });

    expect(records.statusCode).toBe(200);
    const recordsBody = JSON.parse(records.payload);
    expect(recordsBody.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_style',
        content: '请简洁直接回答',
      }),
    ]));
  });

  it('auto-commits newly supported colloquial complexity preferences without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-complexity',
        user_message: '简单方案就行',
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
      content: '不要复杂方案',
    }));
  });

  it('auto-commits additional constraint-style colloquial preferences without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-lightweight',
        user_message: '轻量方案就行',
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
      content: '不要复杂方案',
    }));
  });

  it('auto-commits newly supported softer-worded explicit complexity preferences without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-soft-complexity',
        user_message: '方案简单一点',
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
      content: '不要复杂方案',
    }));
  });

  it('auto-commits additional explicit complexity phrasings without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-soft-complexity-2',
        user_message: '方案简单一些',
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
      content: '不要复杂方案',
    }));
  });

  it('auto-commits additional explicit short language and complexity phrasings without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const language = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-language-can',
        user_message: '后面中文就可以',
        assistant_message: '收到',
      },
    });

    expect(language.statusCode).toBe(201);
    const languageBody = JSON.parse(language.payload);
    expect(languageBody.auto_committed_count).toBe(1);
    expect(languageBody.review_pending_count).toBe(0);
    expect(languageBody.review_batch_id || null).toBe(null);
    expect(languageBody.records).toHaveLength(1);
    expect(languageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请用中文回答',
    }));

    const complexity = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-simple-short',
        user_message: '方案简单些',
        assistant_message: '收到',
      },
    });

    expect(complexity.statusCode).toBe(201);
    const complexityBody = JSON.parse(complexity.payload);
    expect(complexityBody.auto_committed_count).toBe(1);
    expect(complexityBody.review_pending_count).toBe(0);
    expect(complexityBody.review_batch_id || null).toBe(null);
    expect(complexityBody.records).toHaveLength(1);
    expect(complexityBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '不要复杂方案',
    }));
  });

  it('auto-commits structural colloquial "就可以" profile-rule phrasings without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const directLanguage = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-direct-language-can',
        user_message: '中文就可以',
        assistant_message: '收到',
      },
    });

    expect(directLanguage.statusCode).toBe(201);
    const directLanguageBody = JSON.parse(directLanguage.payload);
    expect(directLanguageBody.auto_committed_count).toBe(1);
    expect(directLanguageBody.review_pending_count).toBe(0);
    expect(directLanguageBody.review_batch_id || null).toBe(null);
    expect(directLanguageBody.records).toHaveLength(1);
    expect(directLanguageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请用中文回答',
    }));

    const responseLength = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-length-can',
        user_message: '三句话内就可以',
        assistant_message: '收到',
      },
    });

    expect(responseLength.statusCode).toBe(201);
    const responseLengthBody = JSON.parse(responseLength.payload);
    expect(responseLengthBody.auto_committed_count).toBe(1);
    expect(responseLengthBody.review_pending_count).toBe(0);
    expect(responseLengthBody.review_batch_id || null).toBe(null);
    expect(responseLengthBody.records).toHaveLength(1);
    expect(responseLengthBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请把回答控制在三句话内',
    }));

    const simpleOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-simple-okay',
        user_message: '简单方案就可以',
        assistant_message: '收到',
      },
    });

    expect(simpleOkay.statusCode).toBe(201);
    const simpleOkayBody = JSON.parse(simpleOkay.payload);
    expect(simpleOkayBody.auto_committed_count).toBe(1);
    expect(simpleOkayBody.review_pending_count).toBe(0);
    expect(simpleOkayBody.review_batch_id || null).toBe(null);
    expect(simpleOkayBody.records).toHaveLength(1);
    expect(simpleOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '不要复杂方案',
    }));

    const lightweightOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-lightweight-okay',
        user_message: '轻量方案就可以',
        assistant_message: '收到',
      },
    });

    expect(lightweightOkay.statusCode).toBe(201);
    const lightweightOkayBody = JSON.parse(lightweightOkay.payload);
    expect(lightweightOkayBody.auto_committed_count).toBe(1);
    expect(lightweightOkayBody.review_pending_count).toBe(0);
    expect(lightweightOkayBody.review_batch_id || null).toBe(null);
    expect(lightweightOkayBody.records).toHaveLength(1);
    expect(lightweightOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '不要复杂方案',
    }));
  });

  it('auto-commits structural colloquial "就好" profile-rule phrasings without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const directLanguage = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-direct-language-good',
        user_message: '中文就好',
        assistant_message: '收到',
      },
    });

    expect(directLanguage.statusCode).toBe(201);
    const directLanguageBody = JSON.parse(directLanguage.payload);
    expect(directLanguageBody.auto_committed_count).toBe(1);
    expect(directLanguageBody.review_pending_count).toBe(0);
    expect(directLanguageBody.review_batch_id || null).toBe(null);
    expect(directLanguageBody.records).toHaveLength(1);
    expect(directLanguageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请用中文回答',
    }));

    const responseLength = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-length-good',
        user_message: '三句话内就好',
        assistant_message: '收到',
      },
    });

    expect(responseLength.statusCode).toBe(201);
    const responseLengthBody = JSON.parse(responseLength.payload);
    expect(responseLengthBody.auto_committed_count).toBe(1);
    expect(responseLengthBody.review_pending_count).toBe(0);
    expect(responseLengthBody.review_batch_id || null).toBe(null);
    expect(responseLengthBody.records).toHaveLength(1);
    expect(responseLengthBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请把回答控制在三句话内',
    }));

    const simpleOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-simple-good',
        user_message: '简单方案就好',
        assistant_message: '收到',
      },
    });

    expect(simpleOkay.statusCode).toBe(201);
    const simpleOkayBody = JSON.parse(simpleOkay.payload);
    expect(simpleOkayBody.auto_committed_count).toBe(1);
    expect(simpleOkayBody.review_pending_count).toBe(0);
    expect(simpleOkayBody.review_batch_id || null).toBe(null);
    expect(simpleOkayBody.records).toHaveLength(1);
    expect(simpleOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '不要复杂方案',
    }));

    const lightweightOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-lightweight-good',
        user_message: '轻量方案就好',
        assistant_message: '收到',
      },
    });

    expect(lightweightOkay.statusCode).toBe(201);
    const lightweightOkayBody = JSON.parse(lightweightOkay.payload);
    expect(lightweightOkayBody.auto_committed_count).toBe(1);
    expect(lightweightOkayBody.review_pending_count).toBe(0);
    expect(lightweightOkayBody.review_batch_id || null).toBe(null);
    expect(lightweightOkayBody.records).toHaveLength(1);
    expect(lightweightOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '不要复杂方案',
    }));
  });

  it('auto-commits direct structural "就行 / 即可" language and length phrasings without creating a review batch', async () => {
    const setup = await createApp();
    app = setup.app;

    const languageOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-direct-language-okay',
        user_message: '中文就行',
        assistant_message: '收到',
      },
    });

    expect(languageOkay.statusCode).toBe(201);
    const languageOkayBody = JSON.parse(languageOkay.payload);
    expect(languageOkayBody.auto_committed_count).toBe(1);
    expect(languageOkayBody.review_pending_count).toBe(0);
    expect(languageOkayBody.review_batch_id || null).toBe(null);
    expect(languageOkayBody.records).toHaveLength(1);
    expect(languageOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请用中文回答',
    }));

    const languageCan = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-direct-language-can-2',
        user_message: '中文即可',
        assistant_message: '收到',
      },
    });

    expect(languageCan.statusCode).toBe(201);
    const languageCanBody = JSON.parse(languageCan.payload);
    expect(languageCanBody.auto_committed_count).toBe(1);
    expect(languageCanBody.review_pending_count).toBe(0);
    expect(languageCanBody.review_batch_id || null).toBe(null);
    expect(languageCanBody.records).toHaveLength(1);
    expect(languageCanBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请用中文回答',
    }));

    const responseLengthCan = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-auto-colloquial-length-can-2',
        user_message: '三句话内即可',
        assistant_message: '收到',
      },
    });

    expect(responseLengthCan.statusCode).toBe(201);
    const responseLengthCanBody = JSON.parse(responseLengthCan.payload);
    expect(responseLengthCanBody.auto_committed_count).toBe(1);
    expect(responseLengthCanBody.review_pending_count).toBe(0);
    expect(responseLengthCanBody.review_batch_id || null).toBe(null);
    expect(responseLengthCanBody.records).toHaveLength(1);
    expect(responseLengthCanBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请把回答控制在三句话内',
    }));
  });

  it('auto-commits shared-contract-safe live ingest durables even when they originate from deep extraction', async () => {
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
    expect(body.auto_committed_count).toBe(1);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toEqual(expect.objectContaining({
      written_kind: 'profile_rule',
      content: '请用中文回答',
    }));

    const stored = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live',
    });
    expect(stored.statusCode).toBe(200);
    expect(JSON.parse(stored.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'language_preference',
        content: '请用中文回答',
      }),
    ]));

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-live',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
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

  it('keeps weak colloquial response-length ingest content as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-length',
        user_message: '三句就够了吧',
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
      content: '三句就够了吧',
    }));

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-weak-colloquial-length',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('keeps newly hedged constraint-style colloquial inputs as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-lightweight',
        user_message: '轻量方案就行吧',
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
      content: '轻量方案就行吧',
    }));

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-weak-colloquial-lightweight',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('keeps soft-priority colloquial inputs as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const language = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-soft-language',
        user_message: '尽量用中文',
        assistant_message: '收到',
      },
    });

    expect(language.statusCode).toBe(201);
    const languageBody = JSON.parse(language.payload);
    expect(languageBody.auto_committed_count).toBe(1);
    expect(languageBody.review_pending_count).toBe(0);
    expect(languageBody.review_batch_id || null).toBe(null);
    expect(languageBody.records).toHaveLength(1);
    expect(languageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '尽量用中文',
    }));

    const length = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-soft-length',
        user_message: '尽量别超过三句话',
        assistant_message: '收到',
      },
    });

    expect(length.statusCode).toBe(201);
    const lengthBody = JSON.parse(length.payload);
    expect(lengthBody.auto_committed_count).toBe(1);
    expect(lengthBody.review_pending_count).toBe(0);
    expect(lengthBody.review_batch_id || null).toBe(null);
    expect(lengthBody.records).toHaveLength(1);
    expect(lengthBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '尽量别超过三句话',
    }));

    const complexity = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-soft-complexity',
        user_message: '尽量简单点',
        assistant_message: '收到',
      },
    });

    expect(complexity.statusCode).toBe(201);
    const complexityBody = JSON.parse(complexity.payload);
    expect(complexityBody.auto_committed_count).toBe(1);
    expect(complexityBody.review_pending_count).toBe(0);
    expect(complexityBody.review_batch_id || null).toBe(null);
    expect(complexityBody.records).toHaveLength(1);
    expect(complexityBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '尽量简单点',
    }));
  });

  it('keeps newly hedged short colloquial variants as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const language = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-language-can',
        user_message: '后面中文就可以吧',
        assistant_message: '收到',
      },
    });

    expect(language.statusCode).toBe(201);
    const languageBody = JSON.parse(language.payload);
    expect(languageBody.auto_committed_count).toBe(1);
    expect(languageBody.review_pending_count).toBe(0);
    expect(languageBody.review_batch_id || null).toBe(null);
    expect(languageBody.records).toHaveLength(1);
    expect(languageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '后面中文就可以吧',
    }));

    const complexity = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-simple-short',
        user_message: '方案简单些吧',
        assistant_message: '收到',
      },
    });

    expect(complexity.statusCode).toBe(201);
    const complexityBody = JSON.parse(complexity.payload);
    expect(complexityBody.auto_committed_count).toBe(1);
    expect(complexityBody.review_pending_count).toBe(0);
    expect(complexityBody.review_batch_id || null).toBe(null);
    expect(complexityBody.records).toHaveLength(1);
    expect(complexityBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '方案简单些吧',
    }));
  });

  it('keeps structural colloquial "就可以吧" variants as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const directLanguage = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-direct-language-can',
        user_message: '中文就可以吧',
        assistant_message: '收到',
      },
    });

    expect(directLanguage.statusCode).toBe(201);
    const directLanguageBody = JSON.parse(directLanguage.payload);
    expect(directLanguageBody.auto_committed_count).toBe(1);
    expect(directLanguageBody.review_pending_count).toBe(0);
    expect(directLanguageBody.review_batch_id || null).toBe(null);
    expect(directLanguageBody.records).toHaveLength(1);
    expect(directLanguageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '中文就可以吧',
    }));

    const responseLength = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-length-can',
        user_message: '三句话内就可以吧',
        assistant_message: '收到',
      },
    });

    expect(responseLength.statusCode).toBe(201);
    const responseLengthBody = JSON.parse(responseLength.payload);
    expect(responseLengthBody.auto_committed_count).toBe(1);
    expect(responseLengthBody.review_pending_count).toBe(0);
    expect(responseLengthBody.review_batch_id || null).toBe(null);
    expect(responseLengthBody.records).toHaveLength(1);
    expect(responseLengthBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '三句话内就可以吧',
    }));

    const simpleOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-simple-okay',
        user_message: '简单方案就可以吧',
        assistant_message: '收到',
      },
    });

    expect(simpleOkay.statusCode).toBe(201);
    const simpleOkayBody = JSON.parse(simpleOkay.payload);
    expect(simpleOkayBody.auto_committed_count).toBe(1);
    expect(simpleOkayBody.review_pending_count).toBe(0);
    expect(simpleOkayBody.review_batch_id || null).toBe(null);
    expect(simpleOkayBody.records).toHaveLength(1);
    expect(simpleOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '简单方案就可以吧',
    }));

    const lightweightOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-lightweight-okay',
        user_message: '轻量方案就可以吧',
        assistant_message: '收到',
      },
    });

    expect(lightweightOkay.statusCode).toBe(201);
    const lightweightOkayBody = JSON.parse(lightweightOkay.payload);
    expect(lightweightOkayBody.auto_committed_count).toBe(1);
    expect(lightweightOkayBody.review_pending_count).toBe(0);
    expect(lightweightOkayBody.review_batch_id || null).toBe(null);
    expect(lightweightOkayBody.records).toHaveLength(1);
    expect(lightweightOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '轻量方案就可以吧',
    }));
  });

  it('keeps structural colloquial "就好吧" variants as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const directLanguage = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-direct-language-good',
        user_message: '中文就好吧',
        assistant_message: '收到',
      },
    });

    expect(directLanguage.statusCode).toBe(201);
    const directLanguageBody = JSON.parse(directLanguage.payload);
    expect(directLanguageBody.auto_committed_count).toBe(1);
    expect(directLanguageBody.review_pending_count).toBe(0);
    expect(directLanguageBody.review_batch_id || null).toBe(null);
    expect(directLanguageBody.records).toHaveLength(1);
    expect(directLanguageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '中文就好吧',
    }));

    const responseLength = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-length-good',
        user_message: '三句话内就好吧',
        assistant_message: '收到',
      },
    });

    expect(responseLength.statusCode).toBe(201);
    const responseLengthBody = JSON.parse(responseLength.payload);
    expect(responseLengthBody.auto_committed_count).toBe(1);
    expect(responseLengthBody.review_pending_count).toBe(0);
    expect(responseLengthBody.review_batch_id || null).toBe(null);
    expect(responseLengthBody.records).toHaveLength(1);
    expect(responseLengthBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '三句话内就好吧',
    }));

    const simpleOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-simple-good',
        user_message: '简单方案就好吧',
        assistant_message: '收到',
      },
    });

    expect(simpleOkay.statusCode).toBe(201);
    const simpleOkayBody = JSON.parse(simpleOkay.payload);
    expect(simpleOkayBody.auto_committed_count).toBe(1);
    expect(simpleOkayBody.review_pending_count).toBe(0);
    expect(simpleOkayBody.review_batch_id || null).toBe(null);
    expect(simpleOkayBody.records).toHaveLength(1);
    expect(simpleOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '简单方案就好吧',
    }));

    const lightweightOkay = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-lightweight-good',
        user_message: '轻量方案就好吧',
        assistant_message: '收到',
      },
    });

    expect(lightweightOkay.statusCode).toBe(201);
    const lightweightOkayBody = JSON.parse(lightweightOkay.payload);
    expect(lightweightOkayBody.auto_committed_count).toBe(1);
    expect(lightweightOkayBody.review_pending_count).toBe(0);
    expect(lightweightOkayBody.review_batch_id || null).toBe(null);
    expect(lightweightOkayBody.records).toHaveLength(1);
    expect(lightweightOkayBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '轻量方案就好吧',
    }));
  });

  it('keeps direct structural "即可吧" language and length variants as session_note instead of creating review work', async () => {
    const setup = await createApp({ weakColloquial: true });
    app = setup.app;

    const language = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-direct-language-can-2',
        user_message: '中文即可吧',
        assistant_message: '收到',
      },
    });

    expect(language.statusCode).toBe(201);
    const languageBody = JSON.parse(language.payload);
    expect(languageBody.auto_committed_count).toBe(1);
    expect(languageBody.review_pending_count).toBe(0);
    expect(languageBody.review_batch_id || null).toBe(null);
    expect(languageBody.records).toHaveLength(1);
    expect(languageBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '中文即可吧',
    }));

    const responseLength = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-weak-colloquial-length-can-2',
        user_message: '三句话内即可吧',
        assistant_message: '收到',
      },
    });

    expect(responseLength.statusCode).toBe(201);
    const responseLengthBody = JSON.parse(responseLength.payload);
    expect(responseLengthBody.auto_committed_count).toBe(1);
    expect(responseLengthBody.review_pending_count).toBe(0);
    expect(responseLengthBody.review_batch_id || null).toBe(null);
    expect(responseLengthBody.records).toHaveLength(1);
    expect(responseLengthBody.records[0]).toEqual(expect.objectContaining({
      written_kind: 'session_note',
      content: '三句话内即可吧',
    }));
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

  it('returns sync metadata on full review inbox list responses', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-sync-full',
      source_preview: '把输出语言设成中文',
      items: [
        createReviewAssistRecordPayload({
          content: '请用中文回答',
          source_excerpt: '把输出语言设成中文',
        }),
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-sync-full',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.items).toEqual([
      expect.objectContaining({
        id: created.batch.id,
      }),
    ]);
    expect(body.sync).toEqual(expect.objectContaining({
      mode: 'full',
      cursor: expect.any(String),
    }));
  });

  it('returns only newly changed batches when listing review inbox with a cursor', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-sync-delta-new',
      source_preview: '把输出语言设成中文',
      items: [
        createReviewAssistRecordPayload({
          content: '请用中文回答',
          source_excerpt: '把输出语言设成中文',
        }),
      ],
    });

    const full = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-sync-delta-new',
    });
    expect(full.statusCode).toBe(200);
    const fullBody = JSON.parse(full.payload);
    expect(fullBody.items).toHaveLength(1);
    expect(fullBody.sync?.cursor).toEqual(expect.any(String));

    const nextCreated = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-sync-delta-new',
      source_preview: '先收一下 recall 那块',
      items: [
        createReviewAssistRecordPayload({
          content: '当前任务是重构 Cortex recall',
          requested_kind: 'task_state',
          normalized_kind: 'task_state',
          state_key: 'refactor_status',
          source_excerpt: '先收一下 recall 那块',
        }),
      ],
    });

    const delta = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox?agent_id=review-sync-delta-new&cursor=${encodeURIComponent(fullBody.sync.cursor)}`,
    });

    expect(delta.statusCode).toBe(200);
    const deltaBody = JSON.parse(delta.payload);
    expect(deltaBody.sync).toEqual(expect.objectContaining({
      mode: 'delta',
      cursor: expect.any(String),
    }));
    expect(deltaBody.items).toEqual([
      expect.objectContaining({
        id: nextCreated.batch.id,
        source_preview: '先收一下 recall 那块',
      }),
    ]);
    expect(deltaBody.total).toBe(2);
    expect(deltaBody.items[0].id).not.toBe(created.batch.id);
  });

  it('returns updated existing batches when listing review inbox with a cursor', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-sync-delta-updated',
        format: 'text',
        content: '说话干脆一点',
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);

    const full = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-sync-delta-updated',
    });
    expect(full.statusCode).toBe(200);
    const fullBody = JSON.parse(full.payload);
    expect(fullBody.sync?.cursor).toEqual(expect.any(String));

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${createdBody.batch_id}/apply`,
      payload: {
        accept_all: true,
      },
    });
    expect(applied.statusCode).toBe(200);

    const delta = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox?agent_id=review-sync-delta-updated&cursor=${encodeURIComponent(fullBody.sync.cursor)}`,
    });

    expect(delta.statusCode).toBe(200);
    const deltaBody = JSON.parse(delta.payload);
    expect(deltaBody.sync).toEqual(expect.objectContaining({
      mode: 'delta',
      cursor: expect.any(String),
    }));
    expect(deltaBody.items).toEqual([
      expect.objectContaining({
        id: createdBody.batch_id,
        status: 'completed',
        summary: expect.objectContaining({
          pending: 0,
          accepted: 1,
        }),
      }),
    ]);
    expect(deltaBody.total).toBe(1);
  });

  it('deletes review batches and items when the owning agent is deleted', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-deleted-agent',
      source_preview: '把输出语言设成中文',
      items: [
        createReviewAssistRecordPayload({
          content: '请用中文回答',
          source_excerpt: '把输出语言设成中文',
        }),
      ],
    });

    const before = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-deleted-agent',
    });
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.payload).items).toHaveLength(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v2/agents/review-deleted-agent',
    });
    expect(deleted.statusCode).toBe(200);

    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) as cnt FROM review_batches_v2 WHERE agent_id = ?').get('review-deleted-agent') as { cnt: number }).cnt).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as cnt FROM review_items_v2 WHERE batch_id = ?').get(created.batch.id) as { cnt: number }).cnt).toBe(0);

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-deleted-agent',
    });
    expect(listAfter.statusCode).toBe(200);
    expect(JSON.parse(listAfter.payload).items).toHaveLength(0);

    const detailAfter = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    expect(detailAfter.statusCode).toBe(404);
  });

  it('ignores orphaned review batches whose agents no longer exist', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-orphaned-agent',
      source_preview: '把输出语言设成中文',
      items: [
        createReviewAssistRecordPayload({
          content: '请用中文回答',
          source_excerpt: '把输出语言设成中文',
        }),
      ],
    });

    const db = getDb();
    db.prepare('DELETE FROM agents WHERE id = ?').run('review-orphaned-agent');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-orphaned-agent',
    });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.payload);
    expect(listBody.items).toHaveLength(0);
    expect(listBody.total).toBe(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    expect(detail.statusCode).toBe(404);
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

  it('persists canonical rewrites for narrow cortex workflow task live review items', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = setup.reviewInbox.createLiveBatch({
      agent_id: 'review-live-task-workflow',
      source_preview: '先做部署\n先迁移一下',
      items: [
        createReviewAssistRecordPayload({
          requested_kind: 'task_state',
          normalized_kind: 'task_state',
          content: '先做部署',
          source_excerpt: '先做部署',
          subject_key: 'cortex',
          attribute_key: undefined,
          state_key: 'deployment_status',
        }),
        createReviewAssistRecordPayload({
          candidate_id: 'review_record_task_migration',
          requested_kind: 'task_state',
          normalized_kind: 'task_state',
          content: '先迁移一下',
          source_excerpt: '先迁移一下',
          subject_key: 'cortex',
          attribute_key: undefined,
          state_key: 'migration_status',
        }),
      ],
    });

    expect(created.summary.pending).toBe(2);
    expect(created.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        suggested_action: 'accept',
        suggested_rewrite: '当前任务是部署 Cortex',
      }),
      expect.objectContaining({
        suggested_action: 'accept',
        suggested_rewrite: '当前任务是迁移 Cortex',
      }),
    ]));

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch?.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        suggested_rewrite: '当前任务是部署 Cortex',
        payload: expect.objectContaining({
          state_key: 'deployment_status',
          source_excerpt: '先做部署',
        }),
      }),
      expect.objectContaining({
        suggested_rewrite: '当前任务是迁移 Cortex',
        payload: expect.objectContaining({
          state_key: 'migration_status',
          source_excerpt: '先迁移一下',
        }),
      }),
    ]));
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

  it('scopes mixed live ingest review batches to the pending clause context', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const ingested = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-mixed-clause-context',
        user_message: '后续交流中文就行。说话干脆一点',
        assistant_message: '收到',
      },
    });

    expect(ingested.statusCode).toBe(201);
    const ingestBody = JSON.parse(ingested.payload);
    expect(ingestBody.auto_committed_count).toBe(1);
    expect(ingestBody.review_pending_count).toBe(1);
    expect(ingestBody.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        written_kind: 'profile_rule',
        content: '请用中文回答',
      }),
    ]));
    expect(typeof ingestBody.review_batch_id).toBe('string');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${ingestBody.review_batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.payload);
    expect(detailBody.batch.source_preview).toBe('说话干脆一点');
    expect(detailBody.items).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          normalized_kind: 'profile_rule',
          attribute_key: 'response_style',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
          evidence: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: '说话干脆一点',
            }),
          ]),
        }),
      }),
    ]);
    expect(
      detailBody.items[0].payload.evidence.some((entry: { role: string; content: string }) => (
        entry.role === 'user' && entry.content.includes('后续交流中文就行')
      )),
    ).toBe(false);
  });

  it('auto-commits shared-contract-safe compound deep-only durables without creating review work', async () => {
    const setup = await createApp({ compoundReview: true });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-compound-auto',
        user_message: '人在东京这边。先收一下 recall 那块',
        assistant_message: '记住了',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(2);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        written_kind: 'fact_slot',
        content: '我住东京',
      }),
      expect.objectContaining({
        written_kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
      }),
    ]));

    const stored = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-compound-auto',
    });
    expect(stored.statusCode).toBe(200);
    expect(JSON.parse(stored.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'fact_slot',
        attribute_key: 'location',
        content: '我住东京',
      }),
      expect.objectContaining({
        kind: 'task_state',
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      }),
    ]));

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-live-compound-auto',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('auto-commits already-accepted colloquial compound durables without deep extraction help', async () => {
    const setup = await createApp();
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/ingest',
      payload: {
        agent_id: 'review-live-compound-auto-deterministic',
        user_message: '人在东京这边。先收一下 recall 那块',
        assistant_message: '记住了',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.auto_committed_count).toBe(2);
    expect(body.review_pending_count).toBe(0);
    expect(body.review_batch_id || null).toBe(null);
    expect(body.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        written_kind: 'fact_slot',
        content: '我住东京',
      }),
      expect.objectContaining({
        written_kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
      }),
    ]));

    const stored = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-live-compound-auto-deterministic',
    });
    expect(stored.statusCode).toBe(200);
    expect(JSON.parse(stored.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'fact_slot',
        attribute_key: 'location',
        content: '我住东京',
      }),
      expect.objectContaining({
        kind: 'task_state',
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      }),
    ]));

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-live-compound-auto-deterministic',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('auto-commits shared-contract-safe import text without creating a review batch', async () => {
    const setup = await createApp();
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
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.source_preview || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(1);
    expect(createdBody.summary).toEqual({
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
    });

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-import',
    });

    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);

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

  it('suppresses empty import batches when safe import content already matches active truth', async () => {
    const setup = await createApp();
    app = setup.app;

    const seeded = await app.inject({
      method: 'POST',
      url: '/api/v2/records',
      payload: {
        agent_id: 'review-import-noop-language',
        kind: 'profile_rule',
        content: '请用中文回答',
        source_type: 'user_confirmed',
      },
    });
    expect(seeded.statusCode).toBe(201);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-noop-language',
        format: 'text',
        content: '后续交流中文就行',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.source_preview || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(0);
    expect(createdBody.summary).toEqual({
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
    });

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v2/review-inbox?agent_id=review-import-noop-language',
    });
    expect(inbox.statusCode).toBe(200);
    expect(JSON.parse(inbox.payload).items).toHaveLength(0);
  });

  it('keeps import review batches focused on remaining review-only clauses after safe auto-commit', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-preview',
        format: 'text',
        content: '后续交流中文就行。说话干脆一点',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(typeof createdBody.batch_id).toBe('string');
    expect(createdBody.auto_committed_count).toBe(1);
    expect(createdBody.source_preview).toBe('说话干脆一点');
    expect(createdBody.summary.pending).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${createdBody.batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload).items).toEqual([
      expect.objectContaining({
        suggested_action: 'accept',
        suggested_rewrite: '请简洁直接回答',
        payload: expect.objectContaining({
          normalized_kind: 'profile_rule',
          attribute_key: 'response_style',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
        }),
      }),
    ]);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-preview',
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

  it('keeps response-style import review batches aligned with the same canonical rewrite and apply path', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-response-style',
        format: 'text',
        content: '说话干脆一点',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.source_preview).toBe('说话干脆一点');
    expect(createdBody.summary.pending).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${createdBody.batch_id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload).items).toEqual([
      expect.objectContaining({
        suggested_action: 'accept',
        suggested_rewrite: '请简洁直接回答',
        payload: expect.objectContaining({
          normalized_kind: 'profile_rule',
          attribute_key: 'response_style',
          content: '请简洁直接回答',
          source_excerpt: '说话干脆一点',
        }),
      }),
    ]);

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

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-response-style',
    });

    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile_rule',
        attribute_key: 'response_style',
        content: '请简洁直接回答',
      }),
    ]));
  });

  it('auto-commits clause-level deep-only compound import items without creating review work', async () => {
    const setup = await createApp({ compoundReview: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-compound-preview',
        format: 'text',
        content: '人在东京这边。先收一下 recall 那块',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(2);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-compound-preview',
    });

    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'fact_slot',
        attribute_key: 'location',
        content: '我住东京',
      }),
      expect.objectContaining({
        kind: 'task_state',
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      }),
    ]));
  });

  it('auto-commits safe memory-md imports without creating review batches', async () => {
    const setup = await createApp({ compoundReview: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-memory-md-source-preview',
        format: 'memory_md',
        content: [
          '# MEMORY.md',
          '',
          '## Task States',
          '- 先收一下 recall 那块',
        ].join('\n'),
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(1);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-memory-md-source-preview',
    });

    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'task_state',
        state_key: 'refactor_status',
        content: '当前任务是重构 Cortex recall',
      }),
    ]));
  });

  it('auto-commits narrow cortex deployment imports without creating review batches', async () => {
    const setup = await createApp();
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-import-deployment-short',
        format: 'text',
        content: '先做部署',
      },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.payload);
    expect(createdBody.batch_id || null).toBe(null);
    expect(createdBody.auto_committed_count).toBe(1);

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-import-deployment-short',
    });

    expect(records.statusCode).toBe(200);
    expect(JSON.parse(records.payload).items).toEqual([
      expect.objectContaining({
        kind: 'task_state',
        subject_key: 'cortex',
        state_key: 'deployment_status',
        content: '当前任务是部署 Cortex',
      }),
    ]);
  });

  it('commits explicit payload overrides through review batch apply', async () => {
    const setup = await createApp();
    app = setup.app;
    const created = setup.reviewInbox.createBatch({
      agent_id: 'review-import-override',
      source_kind: 'import_preview',
      source_preview: '把输出语言设成中文',
      items: [{
        item_type: 'record',
        payload: createReviewAssistRecordPayload({
          candidate_id: 'override_record_1',
          content: '请把回答控制在三句话内',
          attribute_key: 'response_length',
          source_excerpt: '回答控制在三句话内',
        }),
        suggested_action: 'accept',
        suggested_reason: 'explicit_profile_rule',
        suggested_rewrite: '请把回答控制在三句话内',
      }],
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    const detailBody = JSON.parse(detail.payload);
    const recordItem = detailBody.items.find((item: any) => item.item_type === 'record');

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${created.batch.id}/apply`,
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

  it('applies accept and reject suggestions together while leaving edit items pending when apply_suggested is requested', async () => {
    const setup = await createApp();
    app = setup.app;
    const created = setup.reviewInbox.createBatch({
      agent_id: 'review-apply-suggested',
      source_kind: 'live_ingest',
      source_preview: '后续交流中文就行。这应该是助手推断。最近也许会考虑换方案',
      items: [
        {
          item_type: 'record',
          payload: createReviewAssistRecordPayload({
            candidate_id: 'apply_suggested_accept',
            content: '后续交流中文就行',
            source_excerpt: '后续交流中文就行',
          }),
          suggested_action: 'accept',
          suggested_reason: 'explicit_profile_rule',
          suggested_rewrite: '请用中文回答',
        },
        {
          item_type: 'record',
          payload: createReviewAssistRecordPayload({
            candidate_id: 'apply_suggested_reject',
            content: '这应该是助手推断',
            source_type: 'assistant_inferred',
            source_excerpt: '这应该是助手推断',
          }),
          suggested_action: 'reject',
          suggested_reason: 'assistant_only',
          suggested_rewrite: null,
        },
        {
          item_type: 'record',
          payload: createReviewAssistRecordPayload({
            candidate_id: 'apply_suggested_edit',
            requested_kind: 'session_note',
            normalized_kind: 'session_note',
            content: '最近也许会考虑换方案',
            source_excerpt: '最近也许会考虑换方案',
            attribute_key: undefined,
            subject_key: undefined,
          }),
          suggested_action: 'edit',
          suggested_reason: 'needs_human_judgement',
          suggested_rewrite: null,
        },
      ],
    });

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${created.batch.id}/apply`,
      payload: {
        apply_suggested: true,
      },
    });

    expect(applied.statusCode).toBe(200);
    const appliedBody = JSON.parse(applied.payload);
    expect(appliedBody.summary).toEqual({
      committed: 1,
      rejected: 1,
      failed: 0,
    });
    expect(appliedBody.batch_summary).toEqual({
      total: 3,
      pending: 1,
      accepted: 1,
      rejected: 1,
      failed: 0,
    });
    expect(appliedBody.remaining_pending).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.any(String),
        payload: expect.objectContaining({ candidate_id: 'apply_suggested_accept' }),
        status: 'accepted',
      }),
      expect.objectContaining({
        id: expect.any(String),
        payload: expect.objectContaining({ candidate_id: 'apply_suggested_reject' }),
        status: 'rejected',
      }),
      expect.objectContaining({
        id: expect.any(String),
        payload: expect.objectContaining({ candidate_id: 'apply_suggested_edit' }),
        status: 'pending',
      }),
    ]));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-apply-suggested',
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

  it('rejects ambiguous apply_suggested payloads that also request other batch actions', async () => {
    const setup = await createApp();
    app = setup.app;
    const created = setup.reviewInbox.createBatch({
      agent_id: 'review-apply-suggested-invalid',
      source_kind: 'live_ingest',
      source_preview: '后续交流中文就行',
      items: [{
        item_type: 'record',
        payload: createReviewAssistRecordPayload({
          candidate_id: 'apply_suggested_invalid',
          content: '后续交流中文就行',
          source_excerpt: '后续交流中文就行',
        }),
        suggested_action: 'accept',
        suggested_reason: 'explicit_profile_rule',
        suggested_rewrite: '请用中文回答',
      }],
    });

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${created.batch.id}/apply`,
      payload: {
        apply_suggested: true,
        accept_all: true,
      },
    });

    expect(applied.statusCode).toBe(400);
    expect(JSON.parse(applied.payload)).toEqual({
      error: 'apply_suggested cannot be combined with other batch actions',
    });
  });

  it('narrows batch source preview to remaining pending items after partial apply', async () => {
    const setup = await createApp({ compoundReview: true });
    app = setup.app;
    const created = setup.reviewInbox.createBatch({
      agent_id: 'review-import-partial-preview',
      source_kind: 'import_preview',
      source_preview: '人在东京这边。先收一下 recall 那块',
      items: [
        {
          item_type: 'record',
          payload: createReviewAssistRecordPayload({
            candidate_id: 'partial_record_tokyo',
            requested_kind: 'fact_slot',
            normalized_kind: 'fact_slot',
            content: '我住东京',
            entity_key: 'user',
            attribute_key: 'location',
            subject_key: undefined,
            source_excerpt: '人在东京这边',
          }),
          suggested_action: 'accept',
          suggested_reason: 'explicit_fact_slot',
        },
        {
          item_type: 'relation',
          payload: createReviewAssistRelationPayload({
            candidate_id: 'partial_relation_tokyo',
            source_candidate_id: 'partial_record_tokyo',
            subject_key: 'user',
            predicate: 'lives_in',
            object_key: 'tokyo',
            source_excerpt: '人在东京这边',
          }),
          suggested_action: 'accept',
          suggested_reason: 'candidate_relation',
        },
        {
          item_type: 'record',
          payload: {
            candidate_id: 'partial_record_task',
            selected: true,
            requested_kind: 'task_state',
            normalized_kind: 'task_state',
            content: '当前任务是重构 Cortex recall',
            source_type: 'user_explicit',
            subject_key: 'cortex',
            state_key: 'refactor_status',
            status: 'active',
            source_excerpt: '先收一下 recall 那块',
            confidence: 0.8,
            warnings: [],
          },
          suggested_action: 'accept',
          suggested_reason: 'explicit_task_state',
        },
      ],
    });

    const detailBefore = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    const beforeBody = JSON.parse(detailBefore.payload);
    expect(beforeBody.batch.source_preview).toBe('人在东京这边\n先收一下 recall 那块');
    expect(beforeBody.items).toHaveLength(3);

    const acceptedItems = beforeBody.items.filter((item: any) => item.payload?.source_excerpt === '人在东京这边');
    expect(acceptedItems).toHaveLength(2);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${created.batch.id}/apply`,
      payload: {
        item_actions: acceptedItems.map((item: any) => ({
          item_id: item.id,
          action: 'accept',
        })),
      },
    });

    expect(applied.statusCode).toBe(200);
    const appliedBody = JSON.parse(applied.payload);
    expect(appliedBody.remaining_pending).toBe(1);
    expect(appliedBody.batch.status).toBe('partially_applied');
    expect(appliedBody.batch.source_preview).toBe('先收一下 recall 那块');
    expect(appliedBody.batch_summary).toEqual({
      total: 3,
      pending: 1,
      accepted: 2,
      rejected: 0,
      failed: 0,
    });

    const detailAfter = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    const afterBody = JSON.parse(detailAfter.payload);
    expect(afterBody.batch.status).toBe('partially_applied');
    expect(afterBody.summary.pending).toBe(1);
    expect(afterBody.batch.source_preview).toBe('先收一下 recall 那块');
  });

  it('keeps failed review items actionable and allows retrying them in the same batch', async () => {
    const setup = await createApp({ reviewOnly: true });
    app = setup.app;
    const created = setup.reviewInbox.createBatch({
      agent_id: 'review-retryable-failure',
      source_kind: 'import_preview',
      source_preview: '我住大阪',
      items: [
        {
          item_type: 'record',
          payload: createReviewAssistRecordPayload({
            candidate_id: 'retry_record_osaka',
            requested_kind: 'fact_slot',
            normalized_kind: 'fact_slot',
            content: '我住大阪',
            entity_key: 'user',
            attribute_key: 'location',
            subject_key: undefined,
            source_excerpt: '我住大阪',
          }),
          suggested_action: 'accept',
          suggested_reason: 'explicit_fact_slot',
        },
        {
          item_type: 'relation',
          payload: createReviewAssistRelationPayload({
            candidate_id: 'retry_relation_osaka',
            source_candidate_id: 'retry_record_osaka',
            subject_key: 'user',
            predicate: 'lives_in',
            object_key: 'osaka',
            source_excerpt: '我住大阪',
          }),
          suggested_action: 'accept',
          suggested_reason: 'candidate_relation',
        },
      ],
    });

    const detailBefore = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    const beforeBody = JSON.parse(detailBefore.payload);
    const recordItem = beforeBody.items.find((item: any) => item.item_type === 'record');
    const relationItem = beforeBody.items.find((item: any) => item.item_type === 'relation');
    expect(recordItem?.id).toBeTruthy();
    expect(relationItem?.id).toBeTruthy();

    const failedApply = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${created.batch.id}/apply`,
      payload: {
        item_actions: [{
          item_id: relationItem.id,
          action: 'accept',
        }],
      },
    });

    expect(failedApply.statusCode).toBe(200);
    const failedBody = JSON.parse(failedApply.payload);
    expect(failedBody.summary).toEqual({
      committed: 0,
      rejected: 0,
      failed: 1,
    });
    expect(failedBody.batch.status).toBe('partially_applied');
    expect(failedBody.batch_summary).toEqual({
      total: 2,
      pending: 1,
      accepted: 0,
      rejected: 0,
      failed: 1,
    });
    expect(failedBody.failed).toEqual([
      expect.objectContaining({
        candidate_id: relationItem.payload.candidate_id,
        type: 'relation',
        reason: 'missing_source_record',
      }),
    ]);

    const detailAfterFailure = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    const failureDetailBody = JSON.parse(detailAfterFailure.payload);
    expect(failureDetailBody.batch.status).toBe('partially_applied');
    expect(failureDetailBody.batch.source_preview).toBe('我住大阪');
    expect(failureDetailBody.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: recordItem.id,
        status: 'pending',
      }),
      expect.objectContaining({
        id: relationItem.id,
        status: 'failed',
        error_message: 'missing_source_record',
      }),
    ]));

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v2/review-inbox/${created.batch.id}/apply`,
      payload: {
        accept_all: true,
      },
    });

    expect(retried.statusCode).toBe(200);
    const retriedBody = JSON.parse(retried.payload);
    expect(retriedBody.summary).toEqual({
      committed: 2,
      rejected: 0,
      failed: 0,
    });
    expect(retriedBody.batch.status).toBe('completed');
    expect(retriedBody.batch_summary).toEqual({
      total: 2,
      pending: 0,
      accepted: 2,
      rejected: 0,
      failed: 0,
    });

    const detailAfterRetry = await app.inject({
      method: 'GET',
      url: `/api/v2/review-inbox/${created.batch.id}`,
    });
    const retryDetailBody = JSON.parse(detailAfterRetry.payload);
    expect(retryDetailBody.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: recordItem.id,
        status: 'accepted',
        error_message: null,
      }),
      expect.objectContaining({
        id: relationItem.id,
        status: 'accepted',
        error_message: null,
      }),
    ]));

    const records = await app.inject({
      method: 'GET',
      url: '/api/v2/records?agent_id=review-retryable-failure',
    });
    const recordsBody = JSON.parse(records.payload);
    expect(recordsBody.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: '我住大阪',
      }),
    ]));
  });

  it('dismisses a review batch with reject_all without writing records', async () => {
    const setup = await createApp({ responseStyleReview: true });
    app = setup.app;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/review-inbox/import',
      payload: {
        agent_id: 'review-reject',
        format: 'text',
        content: '说话干脆一点',
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
    expect(rejectedBody.batch_summary).toEqual({
      total: 1,
      pending: 0,
      accepted: 0,
      rejected: 1,
      failed: 0,
    });

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

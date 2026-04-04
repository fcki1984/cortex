import { ensureAgent } from '../db/index.js';
import { getDb } from '../db/connection.js';
import { generateId } from '../utils/helpers.js';
import {
  confirmImport,
  previewImportForReviewInbox,
  type ImportFormat,
  type PreviewRecordCandidate,
} from './import-export.js';
import type { CortexRelationsV2 } from './relations.js';
import {
  buildRecordReviewAssist,
  buildRelationReviewAssist,
} from './review-assist.js';
import type { CortexRecordsV2 } from './service.js';
import type { CortexRecord } from './types.js';

export type ReviewSourceKind = 'live_ingest' | 'import_preview';
export type ReviewBatchStatus = 'pending' | 'partially_applied' | 'completed' | 'dismissed';
export type ReviewItemType = 'record' | 'relation';
export type ReviewItemStatus = 'pending' | 'accepted' | 'rejected' | 'failed';
export type ReviewSuggestedAction = 'accept' | 'reject' | 'edit';

type ReviewBatchRow = {
  id: string;
  agent_id: string;
  source_kind: ReviewSourceKind;
  status: ReviewBatchStatus;
  conversation_ref_id: string | null;
  session_id: string | null;
  import_format: ImportFormat | null;
  source_label: string | null;
  source_preview: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  sync_cursor: number;
};

type ReviewItemRow = {
  id: string;
  batch_id: string;
  item_type: ReviewItemType;
  status: ReviewItemStatus;
  suggested_action: ReviewSuggestedAction;
  suggested_reason: string;
  suggested_rewrite: string | null;
  payload_json: string;
  committed_record_id: string | null;
  committed_relation_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type ReviewBatchItemInput = {
  item_type: ReviewItemType;
  payload: Record<string, unknown>;
  suggested_action: ReviewSuggestedAction;
  suggested_reason: string;
  suggested_rewrite?: string | null;
};

type ReviewItemActionInput = {
  item_id: string;
  action: 'accept' | 'reject' | 'edit_then_accept';
  payload_override?: Record<string, unknown>;
};

type ReviewBatchSummary = {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  failed: number;
};

type ReviewBatch = Omit<ReviewBatchRow, 'conversation_ref_id' | 'session_id' | 'import_format' | 'source_label' | 'resolved_at' | 'sync_cursor'> & {
  conversation_ref_id?: string | null;
  session_id?: string | null;
  import_format?: ImportFormat | null;
  source_label?: string | null;
  resolved_at?: string | null;
};

type ReviewBatchSync = {
  cursor: string;
  mode: 'full' | 'delta';
};

type ReviewItem = Omit<ReviewItemRow, 'payload_json' | 'committed_record_id' | 'committed_relation_id' | 'error_message'> & {
  payload: Record<string, unknown>;
  committed_record_id?: string | null;
  committed_relation_id?: string | null;
  error_message?: string | null;
};

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function recordPayloadKind(payload: Record<string, unknown>): string | null {
  return asString(payload.normalized_kind) || asString(payload.kind);
}

function recordPayloadStableKey(payload: Record<string, unknown>): string | null {
  switch (recordPayloadKind(payload)) {
    case 'profile_rule': {
      const ownerScope = asString(payload.owner_scope);
      const subjectKey = asString(payload.subject_key);
      const attributeKey = asString(payload.attribute_key);
      if (!ownerScope || !subjectKey || !attributeKey) return null;
      return `profile_rule:${ownerScope}:${subjectKey}:${attributeKey}`;
    }
    case 'fact_slot': {
      const entityKey = asString(payload.entity_key);
      const attributeKey = asString(payload.attribute_key);
      if (!entityKey || !attributeKey) return null;
      return `fact_slot:${entityKey}:${attributeKey}`;
    }
    case 'task_state': {
      const subjectKey = asString(payload.subject_key);
      const stateKey = asString(payload.state_key);
      if (!subjectKey || !stateKey) return null;
      return `task_state:${subjectKey}:${stateKey}`;
    }
    default:
      return null;
  }
}

function activeRecordStableKey(record: CortexRecord): string | null {
  switch (record.kind) {
    case 'profile_rule':
      return `profile_rule:${record.owner_scope}:${record.subject_key}:${record.attribute_key}`;
    case 'fact_slot':
      return `fact_slot:${record.entity_key}:${record.attribute_key}`;
    case 'task_state':
      return `task_state:${record.subject_key}:${record.state_key}`;
    case 'session_note':
      return null;
  }
}

function recordFingerprint(key: string | null, content: string | null): string | null {
  if (!key || !content) return null;
  return JSON.stringify([key, content]);
}

function reviewRecordFingerprint(item: ReviewBatchItemInput): string | null {
  if (item.item_type !== 'record') return null;
  return recordFingerprint(
    recordPayloadStableKey(item.payload),
    asString(item.suggested_rewrite) || asString(item.payload.content),
  );
}

function autoCommitPreviewFingerprint(candidate: PreviewRecordCandidate): string | null {
  return recordFingerprint(
    recordPayloadStableKey(candidate),
    candidate.content,
  );
}

function activeRecordFingerprint(record: CortexRecord): string | null {
  if (!record.content.trim()) return null;
  return recordFingerprint(activeRecordStableKey(record), record.content.trim());
}

function summarize(items: ReviewItem[]): ReviewBatchSummary {
  return items.reduce<ReviewBatchSummary>((summary, item) => {
    summary.total += 1;
    if (item.status === 'pending') summary.pending += 1;
    if (item.status === 'accepted') summary.accepted += 1;
    if (item.status === 'rejected') summary.rejected += 1;
    if (item.status === 'failed') summary.failed += 1;
    return summary;
  }, {
    total: 0,
    pending: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
  });
}

function emptySummary(): ReviewBatchSummary {
  return {
    total: 0,
    pending: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
  };
}

function resolveBatchStatus(summary: ReviewBatchSummary): ReviewBatchStatus {
  if (summary.pending === summary.total) return 'pending';
  if (summary.pending > 0 || summary.failed > 0) return 'partially_applied';
  if (summary.accepted === 0 && summary.failed === 0) return 'dismissed';
  return 'completed';
}

function inflateBatch(row: ReviewBatchRow): ReviewBatch {
  const { sync_cursor, ...rest } = row;
  void sync_cursor;
  return {
    ...rest,
    conversation_ref_id: row.conversation_ref_id,
    session_id: row.session_id,
    import_format: row.import_format,
    source_label: row.source_label,
    resolved_at: row.resolved_at,
  };
}

function inflateItem(row: ReviewItemRow): ReviewItem {
  return {
    ...row,
    payload: parseJsonObject(row.payload_json),
    committed_record_id: row.committed_record_id,
    committed_relation_id: row.committed_relation_id,
    error_message: row.error_message,
  };
}

function shallowMergePayload(
  payload: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> {
  if (!override) return { ...payload };
  return {
    ...payload,
    ...override,
  };
}

function buildSuggestedApplyAction(item: ReviewItem): ReviewItemActionInput | null {
  if (item.suggested_action === 'edit') return null;
  if (item.suggested_action === 'reject') {
    return {
      item_id: item.id,
      action: 'reject',
    };
  }

  if (item.item_type !== 'record') {
    return {
      item_id: item.id,
      action: 'accept',
    };
  }

  const content = asString(item.suggested_rewrite) || asString(item.payload.content);
  return content
    ? {
        item_id: item.id,
        action: 'edit_then_accept',
        payload_override: {
          content,
        },
      }
    : {
        item_id: item.id,
        action: 'accept',
      };
}

function buildImportItems(preview: {
  record_candidates: Array<Record<string, unknown>>;
  relation_candidates: Array<Record<string, unknown>>;
}): ReviewBatchItemInput[] {
  return [
    ...preview.record_candidates.map((payload) => {
      const suggestion = buildRecordReviewAssist(payload);
      return {
        item_type: 'record' as const,
        payload,
        suggested_action: suggestion.suggested_action,
        suggested_reason: suggestion.suggested_reason,
        suggested_rewrite: suggestion.suggested_rewrite,
      };
    }),
    ...preview.relation_candidates.map((payload) => {
      const suggestion = buildRelationReviewAssist(payload);
      return {
        item_type: 'relation' as const,
        payload,
        suggested_action: suggestion.suggested_action,
        suggested_reason: suggestion.suggested_reason,
      };
    }),
  ];
}

function payloadSourceExcerpt(payload: Record<string, unknown>): string {
  return typeof payload.source_excerpt === 'string' ? payload.source_excerpt.trim() : '';
}

function deriveReviewSourcePreviewFromPayloads(
  payloads: Record<string, unknown>[],
  fallback: string,
): string {
  const excerpts: string[] = [];
  const seen = new Set<string>();

  for (const payload of payloads) {
    const sourceExcerpt = payloadSourceExcerpt(payload);
    if (!sourceExcerpt || seen.has(sourceExcerpt)) continue;
    seen.add(sourceExcerpt);
    excerpts.push(sourceExcerpt);
  }

  if (excerpts.length > 0) {
    return excerpts.join('\n');
  }

  return fallback.trim();
}

function deriveReviewSourcePreview(
  items: ReviewBatchItemInput[],
  fallback: string,
): string {
  return deriveReviewSourcePreviewFromPayloads(items.map(item => item.payload), fallback);
}

function deriveActionableReviewSourcePreview(
  items: ReviewItem[],
  fallback: string,
): string {
  return deriveReviewSourcePreviewFromPayloads(
    items
      .filter(item => item.status === 'pending' || item.status === 'failed')
      .map(item => item.payload),
    fallback,
  );
}

function encodeReviewInboxCursor(value: number): string {
  return String(Math.max(0, value));
}

function decodeReviewInboxCursor(cursor?: string): number | null {
  if (!cursor?.trim()) return null;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export class CortexReviewInboxV2 {
  constructor(
    private readonly recordsV2: CortexRecordsV2,
    private readonly relationsV2: CortexRelationsV2,
  ) {}

  private listItemsByBatchId(batchId: string): ReviewItem[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT *
      FROM review_items_v2
      WHERE batch_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(batchId) as ReviewItemRow[];
    return rows.map(inflateItem);
  }

  private updateBatchStatus(batchId: string): ReviewBatch {
    const db = getDb();
    const existingRow = db.prepare('SELECT * FROM review_batches_v2 WHERE id = ?').get(batchId) as ReviewBatchRow | undefined;
    if (!existingRow) {
      throw new Error('Review batch not found');
    }
    const items = this.listItemsByBatchId(batchId);
    const summary = summarize(items);
    const status = resolveBatchStatus(summary);
    const now = new Date().toISOString();
    const sourcePreview = deriveActionableReviewSourcePreview(items, existingRow.source_preview).slice(0, 500);

    const syncCursor = this.allocateSyncCursor();

    db.prepare(`
      UPDATE review_batches_v2
      SET status = ?, updated_at = ?, resolved_at = ?, source_preview = ?, sync_cursor = ?
      WHERE id = ?
    `).run(
      status,
      now,
      summary.pending === 0 ? now : null,
      sourcePreview,
      syncCursor,
      batchId,
    );

    const row = db.prepare('SELECT * FROM review_batches_v2 WHERE id = ?').get(batchId) as ReviewBatchRow | undefined;
    if (!row) {
      throw new Error('Review batch not found');
    }
    return inflateBatch(row);
  }

  private allocateSyncCursor(): number {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO review_batch_sync_seq_v2 DEFAULT VALUES
    `).run();
    return Number(result.lastInsertRowid);
  }

  private updateItemOutcome(input: {
    item_id: string;
    status: Extract<ReviewItemStatus, 'accepted' | 'rejected' | 'failed'>;
    committed_record_id?: string | null;
    committed_relation_id?: string | null;
    error_message?: string | null;
  }): void {
    const db = getDb();
    db.prepare(`
      UPDATE review_items_v2
      SET
        status = ?,
        committed_record_id = ?,
        committed_relation_id = ?,
        error_message = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.status,
      input.committed_record_id || null,
      input.committed_relation_id || null,
      input.error_message || null,
      new Date().toISOString(),
      input.item_id,
    );
  }

  private listActiveReviewFingerprints(agentId: string): Set<string> {
    const records = this.recordsV2.listRecords({
      agent_id: agentId,
      include_inactive: false,
      limit: 1000,
      order_by: 'updated_at',
      order_dir: 'desc',
    }).items;

    return new Set(
      records
        .map(activeRecordFingerprint)
        .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string'),
    );
  }

  private listPendingReviewFingerprints(agentId: string): Set<string> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT review_items_v2.payload_json, review_items_v2.suggested_rewrite
      FROM review_items_v2
      INNER JOIN review_batches_v2 ON review_batches_v2.id = review_items_v2.batch_id
      WHERE review_batches_v2.agent_id = ?
        AND review_items_v2.item_type = 'record'
        AND review_items_v2.status = 'pending'
        AND review_batches_v2.status IN ('pending', 'partially_applied')
    `).all(agentId) as Array<{ payload_json: string; suggested_rewrite: string | null }>;

    const fingerprints = new Set<string>();
    for (const row of rows) {
      const payload = parseJsonObject(row.payload_json);
      const fingerprint = recordFingerprint(
        recordPayloadStableKey(payload),
        asString(row.suggested_rewrite) || asString(payload.content),
      );
      if (fingerprint) fingerprints.add(fingerprint);
    }

    return fingerprints;
  }

  private suppressRedundantItems(agentId: string, items: ReviewBatchItemInput[]): ReviewBatchItemInput[] {
    if (items.length === 0) return [];

    const activeFingerprints = this.listActiveReviewFingerprints(agentId);
    const pendingFingerprints = this.listPendingReviewFingerprints(agentId);
    const kept: ReviewBatchItemInput[] = [];
    const keptRecordCandidateIds = new Set<string>();

    for (const item of items) {
      if (item.item_type !== 'record') continue;

      const fingerprint = reviewRecordFingerprint(item);
      if (fingerprint && (activeFingerprints.has(fingerprint) || pendingFingerprints.has(fingerprint))) {
        continue;
      }

      if (fingerprint) pendingFingerprints.add(fingerprint);
      const candidateId = asString(item.payload.candidate_id);
      if (candidateId) keptRecordCandidateIds.add(candidateId);
      kept.push(item);
    }

    for (const item of items) {
      if (item.item_type !== 'relation') continue;
      const sourceCandidateId = asString(item.payload.source_candidate_id);
      if (sourceCandidateId && !keptRecordCandidateIds.has(sourceCandidateId)) continue;
      kept.push(item);
    }

    return kept;
  }

  private suppressNoOpAutoCommitCandidates(agentId: string, candidates: PreviewRecordCandidate[]): PreviewRecordCandidate[] {
    if (candidates.length === 0) return candidates;

    const activeFingerprints = this.listActiveReviewFingerprints(agentId);
    const kept: PreviewRecordCandidate[] = [];

    for (const candidate of candidates) {
      const fingerprint = autoCommitPreviewFingerprint(candidate);
      if (fingerprint && activeFingerprints.has(fingerprint)) continue;
      if (fingerprint) activeFingerprints.add(fingerprint);
      kept.push(candidate);
    }

    return kept;
  }

  createBatch(input: {
    agent_id: string;
    source_kind: ReviewSourceKind;
    conversation_ref_id?: string;
    session_id?: string;
    import_format?: ImportFormat;
    source_label?: string;
    source_preview: string;
    items: ReviewBatchItemInput[];
  }): {
    batch: ReviewBatch;
    items: ReviewItem[];
    summary: ReviewBatchSummary;
  } {
    ensureAgent(input.agent_id);
    const db = getDb();
    const now = new Date().toISOString();
    const batchId = generateId();

    db.prepare(`
      INSERT INTO review_batches_v2 (
        id, agent_id, source_kind, status, conversation_ref_id, session_id, import_format, source_label, source_preview, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      input.agent_id,
      input.source_kind,
      'pending',
      input.conversation_ref_id || null,
      input.session_id || null,
      input.import_format || null,
      input.source_label || null,
      deriveReviewSourcePreview(input.items, input.source_preview).slice(0, 500),
      now,
      now,
    );

    const insertItem = db.prepare(`
      INSERT INTO review_items_v2 (
        id, batch_id, item_type, status, suggested_action, suggested_reason, suggested_rewrite, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of input.items) {
      insertItem.run(
        generateId(),
        batchId,
        item.item_type,
        'pending',
        item.suggested_action,
        item.suggested_reason,
        item.suggested_rewrite || null,
        JSON.stringify(item.payload),
        now,
        now,
      );
    }

    const batch = this.updateBatchStatus(batchId);
    const items = this.listItemsByBatchId(batchId);
    return {
      batch,
      items,
      summary: summarize(items),
    };
  }

  createLiveBatch(input: {
    agent_id: string;
    conversation_ref_id?: string;
    session_id?: string;
    source_preview: string;
    items: Array<Record<string, unknown>>;
  }): {
    batch: ReviewBatch | null;
    items: ReviewItem[];
    summary: ReviewBatchSummary;
  } {
    const itemInputs = this.suppressRedundantItems(input.agent_id, input.items.map((payload) => {
      const suggestion = buildRecordReviewAssist(payload);
      return {
        item_type: 'record' as const,
        payload,
        suggested_action: suggestion.suggested_action,
        suggested_reason: suggestion.suggested_reason,
        suggested_rewrite: suggestion.suggested_rewrite,
      };
    }));

    if (itemInputs.length === 0) {
      return {
        batch: null,
        items: [],
        summary: emptySummary(),
      };
    }

    return this.createBatch({
      agent_id: input.agent_id,
      source_kind: 'live_ingest',
      conversation_ref_id: input.conversation_ref_id,
      session_id: input.session_id,
      source_preview: input.source_preview,
      items: itemInputs,
    });
  }

  async createImportBatch(input: {
    agent_id: string;
    format: 'text' | 'memory_md';
    content: string;
    source_label?: string;
  }): Promise<{
    batch: ReviewBatch | null;
    items: ReviewItem[];
    summary: ReviewBatchSummary;
    auto_committed_count: number;
  }> {
    const preview = await previewImportForReviewInbox(this.recordsV2, input);
    let autoCommittedCount = 0;
    const autoCommitRecordCandidates = this.suppressNoOpAutoCommitCandidates(
      input.agent_id,
      preview.auto_commit_record_candidates,
    );
    let reviewRecordCandidates = [...preview.review_record_candidates];
    let reviewRelationCandidates = [...preview.review_relation_candidates];

    if (autoCommitRecordCandidates.length > 0) {
      const autoCommitResult = await confirmImport(this.recordsV2, this.relationsV2, {
        agent_id: input.agent_id,
        record_candidates: autoCommitRecordCandidates,
        relation_candidates: [],
      });
      autoCommittedCount = autoCommitResult.summary.committed;

      const failedAutoCandidateIds = new Set(
        autoCommitResult.failed
          .filter((entry) => entry.type === 'record' && typeof entry.candidate_id === 'string')
          .map((entry) => entry.candidate_id as string),
      );

      if (failedAutoCandidateIds.size > 0) {
        const failedAutoRecords = autoCommitRecordCandidates.filter((candidate) => (
          failedAutoCandidateIds.has(candidate.candidate_id)
        ));
        reviewRecordCandidates = [...failedAutoRecords, ...reviewRecordCandidates];
      }
    }

    const reviewItems = buildImportItems({
      record_candidates: reviewRecordCandidates,
      relation_candidates: reviewRelationCandidates,
    });
    const survivingReviewItems = this.suppressRedundantItems(input.agent_id, reviewItems);

    if (survivingReviewItems.length === 0) {
      return {
        batch: null,
        items: [],
        summary: emptySummary(),
        auto_committed_count: autoCommittedCount,
      };
    }

    const created = this.createBatch({
      agent_id: input.agent_id,
      source_kind: 'import_preview',
      import_format: input.format,
      source_label: input.source_label || input.format,
      source_preview: input.content,
      items: survivingReviewItems,
    });
    return {
      ...created,
      auto_committed_count: autoCommittedCount,
    };
  }

  listBatches(opts: {
    agent_id?: string;
    status?: ReviewBatchStatus;
    source_kind?: ReviewSourceKind;
    limit?: number;
    offset?: number;
    cursor?: string;
  } = {}): {
    items: Array<ReviewBatch & { summary: ReviewBatchSummary }>;
    total: number;
    sync: ReviewBatchSync;
  } {
    const db = getDb();
    const conditions: string[] = ['EXISTS (SELECT 1 FROM agents WHERE agents.id = review_batches_v2.agent_id)'];
    const params: unknown[] = [];

    if (opts.agent_id) {
      conditions.push('agent_id = ?');
      params.push(opts.agent_id);
    }
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    if (opts.source_kind) {
      conditions.push('source_kind = ?');
      params.push(opts.source_kind);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit || 50;
    const offset = opts.offset || 0;
    const cursorValue = decodeReviewInboxCursor(opts.cursor);
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM review_batches_v2 ${where}`).get(...params) as { cnt: number }).cnt;
    const cursorRow = db.prepare(`
      SELECT COALESCE(MAX(sync_cursor), 0) as cursor
      FROM review_batches_v2
      ${where}
    `).get(...params) as { cursor: number | null };

    const listConditions = [...conditions];
    const listParams = [...params];
    if (cursorValue != null) {
      listConditions.push('sync_cursor > ?');
      listParams.push(cursorValue);
    }

    const listWhere = listConditions.length > 0 ? `WHERE ${listConditions.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT *
      FROM review_batches_v2
      ${listWhere}
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'partially_applied' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        updated_at DESC,
        created_at DESC
      LIMIT ? OFFSET ?
    `).all(...listParams, limit, offset) as ReviewBatchRow[];

    return {
      items: rows.map((row) => {
        const items = this.listItemsByBatchId(row.id);
        return {
          ...inflateBatch(row),
          summary: summarize(items),
        };
      }),
      total,
      sync: {
        cursor: encodeReviewInboxCursor(cursorRow.cursor ?? 0),
        mode: cursorValue == null ? 'full' : 'delta',
      },
    };
  }

  getBatch(id: string): { batch: ReviewBatch; items: ReviewItem[]; summary: ReviewBatchSummary } | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT *
      FROM review_batches_v2
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM agents WHERE agents.id = review_batches_v2.agent_id)
    `).get(id) as ReviewBatchRow | undefined;
    if (!row) return null;
    const items = this.listItemsByBatchId(id);
    return {
      batch: inflateBatch(row),
      items,
      summary: summarize(items),
    };
  }

  async applyBatch(input: {
    batch_id: string;
    apply_suggested?: boolean;
    accept_all?: boolean;
    reject_all?: boolean;
    item_actions?: ReviewItemActionInput[];
  }): Promise<{
    summary: {
      committed: number;
      rejected: number;
      failed: number;
    };
    batch_summary: ReviewBatchSummary;
    committed: Array<Record<string, unknown>>;
    rejected: Array<Record<string, unknown>>;
    failed: Array<Record<string, unknown>>;
    remaining_pending: number;
    batch: ReviewBatch;
  }> {
    const batchDetail = this.getBatch(input.batch_id);
    if (!batchDetail) throw new Error('review batch not found');
    if (input.accept_all && input.reject_all) throw new Error('accept_all and reject_all cannot both be true');
    if (
      input.apply_suggested &&
      (input.accept_all || input.reject_all || (input.item_actions || []).length > 0)
    ) {
      throw new Error('apply_suggested cannot be combined with other batch actions');
    }

    const actionMap = new Map(
      (input.apply_suggested
        ? batchDetail.items
            .map((item) => buildSuggestedApplyAction(item))
            .filter((item): item is ReviewItemActionInput => Boolean(item))
        : (input.item_actions || [])
      ).map((item) => [item.item_id, item]),
    );
    const rejected: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    const selectedRecordCandidates: any[] = [];
    const selectedRelationCandidates: any[] = [];
    const itemIdByCandidateId = new Map<string, string>();

    for (const item of batchDetail.items) {
      if (item.status !== 'pending' && item.status !== 'failed') continue;

      const override = actionMap.get(item.id);
      const resolvedAction = input.reject_all
        ? 'reject'
        : input.accept_all
          ? 'accept'
          : override?.action;

      if (!resolvedAction) continue;

      if (resolvedAction === 'reject') {
        this.updateItemOutcome({
          item_id: item.id,
          status: 'rejected',
        });
        rejected.push({
          item_id: item.id,
          type: item.item_type,
        });
        continue;
      }

      const payload = shallowMergePayload(item.payload, override?.payload_override);
      const candidateId = typeof payload.candidate_id === 'string' ? payload.candidate_id : item.id;
      itemIdByCandidateId.set(candidateId, item.id);
      const selectedPayload = {
        ...payload,
        candidate_id: candidateId,
        selected: true,
      };

      if (item.item_type === 'record') {
        selectedRecordCandidates.push(selectedPayload);
      } else {
        selectedRelationCandidates.push(selectedPayload);
      }
    }

    const committed: Array<Record<string, unknown>> = [];

    if (selectedRecordCandidates.length > 0 || selectedRelationCandidates.length > 0) {
      const result = await confirmImport(this.recordsV2, this.relationsV2, {
        agent_id: batchDetail.batch.agent_id,
        record_candidates: selectedRecordCandidates,
        relation_candidates: selectedRelationCandidates,
      });

      for (const item of result.committed as Array<Record<string, any>>) {
        const itemId = typeof item.candidate_id === 'string' ? itemIdByCandidateId.get(item.candidate_id) : undefined;
        if (!itemId) continue;
        this.updateItemOutcome({
          item_id: itemId,
          status: 'accepted',
          committed_record_id: item.record?.id || null,
          committed_relation_id: item.relation?.id || item.candidate?.id || null,
        });
        committed.push(item);
      }

      for (const item of result.failed as Array<Record<string, any>>) {
        const itemId = typeof item.candidate_id === 'string' ? itemIdByCandidateId.get(item.candidate_id) : undefined;
        if (!itemId) continue;
        this.updateItemOutcome({
          item_id: itemId,
          status: 'failed',
          error_message: item.error || 'commit_failed',
        });
        failed.push(item);
      }

      for (const item of result.skipped as Array<Record<string, any>>) {
        const itemId = typeof item.candidate_id === 'string' ? itemIdByCandidateId.get(item.candidate_id) : undefined;
        if (!itemId) continue;
        this.updateItemOutcome({
          item_id: itemId,
          status: 'failed',
          error_message: item.reason || 'skipped',
        });
        failed.push(item);
      }
    }

    const batch = this.updateBatchStatus(input.batch_id);
    const refreshed = this.getBatch(input.batch_id);
    const summary = refreshed?.summary || {
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
    };

    return {
      summary: {
        committed: committed.length,
        rejected: rejected.length,
        failed: failed.length,
      },
      batch_summary: summary,
      committed,
      rejected,
      failed,
      remaining_pending: summary.pending,
      batch,
    };
  }
}

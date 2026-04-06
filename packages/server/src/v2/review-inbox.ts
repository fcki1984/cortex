import { ensureAgent } from '../db/index.js';
import { getDb } from '../db/connection.js';
import { generateId } from '../utils/helpers.js';
import {
  inferShortUserFactSlotRewrite,
  inferShortUserProfileRuleAttributeRewrite,
  inferShortUserFactSelection,
  inferShortUserProposalSelection,
  inferShortUserTaskStateRewrite,
  inferShortUserTaskSelection,
  isShortUserConfirmation,
  isShortUserProposalRejection,
  isShortUserReplacementRequest,
} from './contract.js';
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
import type {
  CortexRecordsV2,
  IngestCommittedRecord,
  LiveReviewFollowupResolution,
} from './service.js';
import type { CortexRecord, NormalizedRecordCandidate } from './types.js';

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

type PendingLiveReviewRecordRow = {
  item_id: string;
  batch_id: string;
  payload_json: string;
  suggested_rewrite: string | null;
};

type PendingLiveReviewItemRow = ReviewItemRow & {
  source_kind: ReviewSourceKind;
  agent_id: string;
};

type PendingLiveSelectionResolution = {
  accept_items: ReviewItem[];
  reject_items: ReviewItem[];
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

function toIngestCommittedRecord(item: Record<string, unknown>): IngestCommittedRecord | null {
  const record = (item.record && typeof item.record === 'object')
    ? item.record as Record<string, unknown>
    : null;
  const recordId = asString(record?.id);
  const requestedKind = asString(item.requested_kind) || asString(record?.requested_kind);
  const writtenKind = asString(item.written_kind) || asString(record?.written_kind) || asString(record?.kind);
  const normalization = asString(item.normalization) || asString(record?.normalization);
  const decision = asString(item.decision);
  const sourceType = asString(record?.source_type);
  const content = asString(record?.content);
  if (
    !recordId ||
    !requestedKind ||
    !writtenKind ||
    !normalization ||
    !decision ||
    !sourceType ||
    !content
  ) {
    return null;
  }

  return {
    record_id: recordId,
    requested_kind: requestedKind as IngestCommittedRecord['requested_kind'],
    written_kind: writtenKind as IngestCommittedRecord['written_kind'],
    normalization: normalization as IngestCommittedRecord['normalization'],
    reason_code: null,
    decision: decision as IngestCommittedRecord['decision'],
    source_type: sourceType as IngestCommittedRecord['source_type'],
    content,
  };
}

function selectablePendingProfileRuleAttribute(item: ReviewItem): 'language_preference' | 'response_length' | 'solution_complexity' | 'response_style' | null {
  if (item.item_type !== 'record' || item.suggested_action !== 'accept') return null;
  const normalizedKind = asString(item.payload.normalized_kind);
  const subjectKey = asString(item.payload.subject_key);
  const attributeKey = asString(item.payload.attribute_key);
  if (normalizedKind !== 'profile_rule' || subjectKey !== 'user') return null;
  return attributeKey === 'language_preference' || attributeKey === 'response_length' || attributeKey === 'solution_complexity' || attributeKey === 'response_style'
    ? attributeKey
    : null;
}

function selectablePendingFactAttribute(item: ReviewItem): 'location' | 'organization' | null {
  if (item.item_type !== 'record' || item.suggested_action !== 'accept') return null;
  const normalizedKind = asString(item.payload.normalized_kind);
  const entityKey = asString(item.payload.entity_key);
  const attributeKey = asString(item.payload.attribute_key);
  if (normalizedKind !== 'fact_slot' || entityKey !== 'user') return null;
  return attributeKey === 'location' || attributeKey === 'organization'
    ? attributeKey
    : null;
}

function selectablePendingTaskStateKey(item: ReviewItem): 'refactor_status' | 'deployment_status' | 'migration_status' | null {
  if (item.item_type !== 'record' || item.suggested_action !== 'accept') return null;
  const normalizedKind = asString(item.payload.normalized_kind);
  const subjectKey = asString(item.payload.subject_key);
  const stateKey = asString(item.payload.state_key);
  if (normalizedKind !== 'task_state' || subjectKey !== 'cortex') return null;
  return stateKey === 'refactor_status' || stateKey === 'deployment_status' || stateKey === 'migration_status'
    ? stateKey
    : null;
}

function selectableActiveProfileRuleAttribute(
  candidate: NormalizedRecordCandidate,
): 'language_preference' | 'response_length' | 'solution_complexity' | 'response_style' | null {
  const record = candidate.candidate;
  if (
    record.kind !== 'profile_rule'
    || record.owner_scope !== 'user'
    || record.subject_key !== 'user'
  ) {
    return null;
  }
  return (
    record.attribute_key === 'language_preference'
    || record.attribute_key === 'response_length'
    || record.attribute_key === 'solution_complexity'
    || record.attribute_key === 'response_style'
  )
    ? record.attribute_key
    : null;
}

function selectableActiveFactAttribute(candidate: NormalizedRecordCandidate): 'location' | 'organization' | null {
  const record = candidate.candidate;
  if (record.kind !== 'fact_slot' || record.entity_key !== 'user') return null;
  return record.attribute_key === 'location' || record.attribute_key === 'organization'
    ? record.attribute_key
    : null;
}

function selectableActiveTaskStateKey(
  candidate: NormalizedRecordCandidate,
): 'refactor_status' | 'deployment_status' | 'migration_status' | null {
  const record = candidate.candidate;
  if (record.kind !== 'task_state' || record.subject_key !== 'cortex') return null;
  return (
    record.state_key === 'refactor_status'
    || record.state_key === 'deployment_status'
    || record.state_key === 'migration_status'
  )
    ? record.state_key
    : null;
}

function isPendingLiveSelectableItem(item: ReviewItem): boolean {
  return !!selectablePendingProfileRuleAttribute(item)
    || !!selectablePendingFactAttribute(item)
    || !!selectablePendingTaskStateKey(item);
}

function pendingLiveAcceptContent(item: ReviewItem): string | null {
  return asString(item.suggested_rewrite) || asString(item.payload.content);
}

function pendingLiveRewriteContent(item: ReviewItem, userMessage: string): string | null {
  if (item.item_type !== 'record' || item.suggested_action !== 'accept') return null;

  const normalizedKind = asString(item.payload.normalized_kind);
  if (normalizedKind === 'profile_rule') {
    const attributeKey = asString(item.payload.attribute_key);
    if (!attributeKey) return null;
    return inferShortUserProfileRuleAttributeRewrite(attributeKey, userMessage)?.synthesized_content ?? null;
  }

  if (normalizedKind === 'fact_slot') {
    const attributeKey = asString(item.payload.attribute_key);
    if (attributeKey !== 'location' && attributeKey !== 'organization') return null;
    return inferShortUserFactSlotRewrite(attributeKey, userMessage)?.synthesized_content ?? null;
  }

  if (normalizedKind === 'task_state') {
    const subjectKey = asString(item.payload.subject_key);
    if (!subjectKey) return null;
    return inferShortUserTaskStateRewrite(subjectKey, userMessage)?.synthesized_content ?? null;
  }

  return null;
}

function pendingLiveSelectiveRewriteContent(item: ReviewItem, userMessage: string): string | null {
  if (item.item_type !== 'record' || item.suggested_action !== 'accept') return null;

  const normalizedKind = asString(item.payload.normalized_kind);
  if (normalizedKind === 'profile_rule') {
    const attributeKey = asString(item.payload.attribute_key);
    if (!attributeKey) return null;
    return inferShortUserProfileRuleAttributeRewrite(attributeKey, userMessage)?.synthesized_content ?? null;
  }

  if (!isShortUserReplacementRequest(userMessage)) {
    return null;
  }

  return pendingLiveRewriteContent(item, userMessage);
}

function resolvePendingProfileRuleSelection(
  userMessage: string,
  pendingItems: Array<{ batch_id: string; item: ReviewItem }>,
): PendingLiveSelectionResolution | null {
  const selection = inferShortUserProposalSelection(userMessage);
  if (!selection || selection.drop_all) return null;

  const selectable = pendingItems
    .map((pending) => ({
      pending,
      attribute: selectablePendingProfileRuleAttribute(pending.item),
    }))
    .filter((entry): entry is {
      pending: { batch_id: string; item: ReviewItem };
      attribute: 'language_preference' | 'response_length' | 'solution_complexity' | 'response_style';
    } => !!entry.attribute);
  if (selectable.length === 0) return null;

  const keepSet = new Set(selection.keep_profile_rule_attributes);
  const dropSet = new Set(selection.drop_profile_rule_attributes);
  let survivors = selectable;

  if (keepSet.size > 0) {
    survivors = survivors.filter((entry) => keepSet.has(entry.attribute));
    if (survivors.length === 0 && dropSet.size === 0) return null;
  }

  if (dropSet.size > 0) {
    survivors = survivors.filter((entry) => !dropSet.has(entry.attribute));
    if (survivors.length === 0 && keepSet.size === 0) {
      return {
        accept_items: [],
        reject_items: selectable
          .filter((entry) => dropSet.has(entry.attribute))
          .map((entry) => entry.pending.item),
      };
    }
    if (survivors.length === 0 && keepSet.size > 0) {
      const rejected = selectable
        .filter((entry) => dropSet.has(entry.attribute))
        .map((entry) => entry.pending.item);
      if (rejected.length === 0) return null;
      return {
        accept_items: [],
        reject_items: rejected,
      };
    }
  }

  if (survivors.length === 0) return null;

  const rejected = keepSet.size > 0
    ? selectable
      .filter((entry) => !survivors.some((survivor) => survivor.pending.item.id === entry.pending.item.id))
      .map((entry) => entry.pending.item)
    : selectable
      .filter((entry) => dropSet.has(entry.attribute))
      .map((entry) => entry.pending.item);

  return {
    accept_items: survivors.map((entry) => entry.pending.item),
    reject_items: rejected,
  };
}

function resolvePendingProfileRuleSelectionSatisfiedByActiveSurvivors(
  userMessage: string,
  pendingItems: Array<{ batch_id: string; item: ReviewItem }>,
  keptActiveCandidates: NormalizedRecordCandidate[],
): PendingLiveSelectionResolution | null {
  if (keptActiveCandidates.length === 0) return null;

  const selection = inferShortUserProposalSelection(userMessage);
  if (!selection || selection.drop_all) return null;

  const keepSet = new Set(selection.keep_profile_rule_attributes);
  const dropSet = new Set(selection.drop_profile_rule_attributes);
  if (keepSet.size === 0 && dropSet.size === 0) return null;

  const activeKeepSet = new Set(
    keptActiveCandidates
      .map((candidate) => selectableActiveProfileRuleAttribute(candidate))
      .filter((attribute): attribute is 'language_preference' | 'response_length' | 'solution_complexity' | 'response_style' => !!attribute),
  );
  if (keepSet.size > 0 && !Array.from(activeKeepSet).some((attribute) => keepSet.has(attribute))) {
    return null;
  }

  const rejected = keepSet.size > 0
    ? pendingItems
      .map((pending) => pending.item)
      .filter((item) => isPendingLiveSelectableItem(item))
    : pendingItems
      .map((pending) => ({
        pending,
        attribute: selectablePendingProfileRuleAttribute(pending.item),
      }))
      .filter((entry): entry is {
        pending: { batch_id: string; item: ReviewItem };
        attribute: 'language_preference' | 'response_length' | 'solution_complexity' | 'response_style';
      } => !!entry.attribute)
      .filter((entry) => dropSet.has(entry.attribute))
      .map((entry) => entry.pending.item);

  if (rejected.length === 0) return null;
  return {
    accept_items: [],
    reject_items: rejected,
  };
}

function resolvePendingFactSelection(
  userMessage: string,
  pendingItems: Array<{ batch_id: string; item: ReviewItem }>,
): PendingLiveSelectionResolution | null {
  const selection = inferShortUserFactSelection(userMessage);
  if (!selection || selection.drop_all) return null;

  const selectable = pendingItems
    .map((pending) => ({
      pending,
      attribute: selectablePendingFactAttribute(pending.item),
    }))
    .filter((entry): entry is {
      pending: { batch_id: string; item: ReviewItem };
      attribute: 'location' | 'organization';
    } => !!entry.attribute);
  if (selectable.length === 0) return null;

  const keepSet = new Set(selection.keep_fact_attributes);
  const dropSet = new Set(selection.drop_fact_attributes);
  let survivors = selectable;

  if (keepSet.size > 0) {
    survivors = survivors.filter((entry) => keepSet.has(entry.attribute));
    if (survivors.length === 0 && dropSet.size === 0) return null;
  }

  if (dropSet.size > 0) {
    survivors = survivors.filter((entry) => !dropSet.has(entry.attribute));
    if (survivors.length === 0 && keepSet.size === 0) {
      return {
        accept_items: [],
        reject_items: selectable
          .filter((entry) => dropSet.has(entry.attribute))
          .map((entry) => entry.pending.item),
      };
    }
    if (survivors.length === 0 && keepSet.size > 0) {
      const rejected = selectable
        .filter((entry) => dropSet.has(entry.attribute))
        .map((entry) => entry.pending.item);
      if (rejected.length === 0) return null;
      return {
        accept_items: [],
        reject_items: rejected,
      };
    }
  }

  if (survivors.length === 0) return null;

  const rejected = keepSet.size > 0
    ? selectable
      .filter((entry) => !survivors.some((survivor) => survivor.pending.item.id === entry.pending.item.id))
      .map((entry) => entry.pending.item)
    : selectable
      .filter((entry) => dropSet.has(entry.attribute))
      .map((entry) => entry.pending.item);

  return {
    accept_items: survivors.map((entry) => entry.pending.item),
    reject_items: rejected,
  };
}

function resolvePendingFactSelectionSatisfiedByActiveSurvivors(
  userMessage: string,
  pendingItems: Array<{ batch_id: string; item: ReviewItem }>,
  keptActiveCandidates: NormalizedRecordCandidate[],
): PendingLiveSelectionResolution | null {
  if (keptActiveCandidates.length === 0) return null;

  const selection = inferShortUserFactSelection(userMessage);
  if (!selection || selection.drop_all) return null;

  const keepSet = new Set(selection.keep_fact_attributes);
  const dropSet = new Set(selection.drop_fact_attributes);
  if (keepSet.size === 0 && dropSet.size === 0) return null;

  const activeKeepSet = new Set(
    keptActiveCandidates
      .map((candidate) => selectableActiveFactAttribute(candidate))
      .filter((attribute): attribute is 'location' | 'organization' => !!attribute),
  );
  if (keepSet.size > 0 && !Array.from(activeKeepSet).some((attribute) => keepSet.has(attribute))) {
    return null;
  }

  const rejected = keepSet.size > 0
    ? pendingItems
      .map((pending) => pending.item)
      .filter((item) => isPendingLiveSelectableItem(item))
    : pendingItems
      .map((pending) => ({
        pending,
        attribute: selectablePendingFactAttribute(pending.item),
      }))
      .filter((entry): entry is {
        pending: { batch_id: string; item: ReviewItem };
        attribute: 'location' | 'organization';
      } => !!entry.attribute)
      .filter((entry) => dropSet.has(entry.attribute))
      .map((entry) => entry.pending.item);

  if (rejected.length === 0) return null;
  return {
    accept_items: [],
    reject_items: rejected,
  };
}

function resolvePendingTaskSelection(
  userMessage: string,
  pendingItems: Array<{ batch_id: string; item: ReviewItem }>,
): PendingLiveSelectionResolution | null {
  const selection = inferShortUserTaskSelection(userMessage);
  if (!selection?.keep_current_task) return null;

  const selectableTasks = pendingItems
    .map((pending) => ({
      pending,
      stateKey: selectablePendingTaskStateKey(pending.item),
    }))
    .filter((entry): entry is {
      pending: { batch_id: string; item: ReviewItem };
      stateKey: 'refactor_status' | 'deployment_status' | 'migration_status';
    } => !!entry.stateKey);
  if (selectableTasks.length !== 1) return null;

  const [survivor] = selectableTasks;
  if (!survivor) return null;

  return {
    accept_items: [survivor.pending.item],
    reject_items: pendingItems
      .map((pending) => pending.item)
      .filter((item) => isPendingLiveSelectableItem(item) && item.id !== survivor.pending.item.id),
  };
}

function resolvePendingTaskSelectionSatisfiedByActiveSurvivor(
  userMessage: string,
  pendingItems: Array<{ batch_id: string; item: ReviewItem }>,
  keptActiveCandidates: NormalizedRecordCandidate[],
): PendingLiveSelectionResolution | null {
  const selection = inferShortUserTaskSelection(userMessage);
  if (!selection?.keep_current_task) return null;

  const hasActiveTaskSurvivor = keptActiveCandidates.some((candidate) => !!selectableActiveTaskStateKey(candidate));
  if (!hasActiveTaskSurvivor) return null;

  const rejected = pendingItems
    .map((pending) => pending.item)
    .filter((item) => isPendingLiveSelectableItem(item));
  if (rejected.length === 0) return null;

  return {
    accept_items: [],
    reject_items: rejected,
  };
}

function mergePendingLiveSelectionResolutions(
  ...selections: Array<PendingLiveSelectionResolution | null>
): PendingLiveSelectionResolution | null {
  const resolved = selections.filter((selection): selection is PendingLiveSelectionResolution => !!selection);
  if (resolved.length === 0) return null;

  const accepted = new Map<string, ReviewItem>();
  const rejected = new Map<string, ReviewItem>();

  for (const selection of resolved) {
    for (const item of selection.accept_items) {
      accepted.set(item.id, item);
      rejected.delete(item.id);
    }
    for (const item of selection.reject_items) {
      if (!accepted.has(item.id)) rejected.set(item.id, item);
    }
  }

  if (accepted.size === 0 && rejected.size === 0) return null;
  return {
    accept_items: Array.from(accepted.values()),
    reject_items: Array.from(rejected.values()),
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

  private listActiveTruthByStableKey(agentId: string): Map<string, CortexRecord> {
    const records = this.recordsV2.listRecords({
      agent_id: agentId,
      include_inactive: false,
      limit: 1000,
      order_by: 'updated_at',
      order_dir: 'desc',
    }).items;

    const activeByKey = new Map<string, CortexRecord>();
    for (const record of records) {
      const stableKey = activeRecordStableKey(record);
      if (!stableKey || activeByKey.has(stableKey)) continue;
      activeByKey.set(stableKey, record);
    }

    return activeByKey;
  }

  private listPendingLiveRecordRows(agentId: string): PendingLiveReviewRecordRow[] {
    const db = getDb();
    return db.prepare(`
      SELECT
        review_items_v2.id as item_id,
        review_items_v2.batch_id,
        review_items_v2.payload_json,
        review_items_v2.suggested_rewrite
      FROM review_items_v2
      INNER JOIN review_batches_v2 ON review_batches_v2.id = review_items_v2.batch_id
      WHERE review_batches_v2.agent_id = ?
        AND review_batches_v2.source_kind = 'live_ingest'
        AND review_batches_v2.status IN ('pending', 'partially_applied')
        AND review_items_v2.item_type = 'record'
        AND review_items_v2.status = 'pending'
    `).all(agentId) as PendingLiveReviewRecordRow[];
  }

  private listPendingLiveReviewItems(agentId: string): Array<{ batch_id: string; item: ReviewItem }> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        review_items_v2.id,
        review_items_v2.batch_id,
        review_items_v2.item_type,
        review_items_v2.status,
        review_items_v2.suggested_action,
        review_items_v2.suggested_reason,
        review_items_v2.suggested_rewrite,
        review_items_v2.payload_json,
        review_items_v2.committed_record_id,
        review_items_v2.committed_relation_id,
        review_items_v2.error_message,
        review_items_v2.created_at,
        review_items_v2.updated_at,
        review_batches_v2.source_kind,
        review_batches_v2.agent_id
      FROM review_items_v2
      INNER JOIN review_batches_v2 ON review_batches_v2.id = review_items_v2.batch_id
      WHERE review_batches_v2.agent_id = ?
        AND review_batches_v2.source_kind = 'live_ingest'
        AND review_batches_v2.status IN ('pending', 'partially_applied')
        AND review_items_v2.item_type = 'record'
        AND review_items_v2.status = 'pending'
      ORDER BY review_batches_v2.created_at ASC, review_batches_v2.id ASC, review_items_v2.created_at ASC, review_items_v2.id ASC
    `).all(agentId) as PendingLiveReviewItemRow[];

    return rows.map((row) => ({
      batch_id: row.batch_id,
      item: inflateItem(row),
    }));
  }

  private supersedePendingLiveItems(agentId: string, items: ReviewBatchItemInput[]): void {
    const nextFingerprintsByKey = new Map<string, string>();
    for (const item of items) {
      if (item.item_type !== 'record') continue;
      const stableKey = recordPayloadStableKey(item.payload);
      const fingerprint = reviewRecordFingerprint(item);
      if (!stableKey || !fingerprint) continue;
      nextFingerprintsByKey.set(stableKey, fingerprint);
    }

    if (nextFingerprintsByKey.size === 0) return;

    const touchedBatchIds = new Set<string>();
    for (const row of this.listPendingLiveRecordRows(agentId)) {
      const payload = parseJsonObject(row.payload_json);
      const stableKey = recordPayloadStableKey(payload);
      if (!stableKey) continue;

      const nextFingerprint = nextFingerprintsByKey.get(stableKey);
      if (!nextFingerprint) continue;

      const currentFingerprint = recordFingerprint(
        stableKey,
        asString(row.suggested_rewrite) || asString(payload.content),
      );
      if (!currentFingerprint || currentFingerprint === nextFingerprint) continue;

      this.updateItemOutcome({
        item_id: row.item_id,
        status: 'rejected',
        error_message: 'superseded_by_newer_review_candidate',
      });
      touchedBatchIds.add(row.batch_id);
    }

    for (const batchId of touchedBatchIds) {
      this.updateBatchStatus(batchId);
    }
  }

  reconcileLiveBatchesAgainstActiveTruth(agentId: string): void {
    const activeByKey = this.listActiveTruthByStableKey(agentId);
    if (activeByKey.size === 0) return;

    const touchedBatchIds = new Set<string>();

    for (const row of this.listPendingLiveRecordRows(agentId)) {
      const payload = parseJsonObject(row.payload_json);
      const stableKey = recordPayloadStableKey(payload);
      if (!stableKey) continue;

      const activeRecord = activeByKey.get(stableKey);
      if (!activeRecord) continue;

      const reviewContent = asString(row.suggested_rewrite) || asString(payload.content);
      const activeContent = asString(activeRecord.content);
      if (!reviewContent || !activeContent) continue;

      if (reviewContent === activeContent) {
        this.updateItemOutcome({
          item_id: row.item_id,
          status: 'accepted',
          committed_record_id: activeRecord.id,
        });
      } else {
        this.updateItemOutcome({
          item_id: row.item_id,
          status: 'rejected',
          committed_record_id: activeRecord.id,
          error_message: 'superseded_by_active_truth',
        });
      }
      touchedBatchIds.add(row.batch_id);
    }

    for (const batchId of touchedBatchIds) {
      this.updateBatchStatus(batchId);
    }
  }

  async resolveShortLiveFollowup(input: {
    agent_id: string;
    user_message: string;
    session_id?: string;
    kept_active_candidates?: NormalizedRecordCandidate[];
  }): Promise<LiveReviewFollowupResolution | null> {
    const userMessage = input.user_message.trim();
    if (!userMessage) return null;

    const pendingItems = this.listPendingLiveReviewItems(input.agent_id);
    if (pendingItems.length === 0) return null;

    if (inferShortUserProposalSelection(userMessage)?.drop_all) {
      const itemActionsByBatch = new Map<string, ReviewItemActionInput[]>();
      for (const pending of pendingItems) {
        const current = itemActionsByBatch.get(pending.batch_id) || [];
        current.push({
          item_id: pending.item.id,
          action: 'reject',
        });
        itemActionsByBatch.set(pending.batch_id, current);
      }
      for (const [batch_id, item_actions] of itemActionsByBatch.entries()) {
        await this.applyBatch({ batch_id, item_actions });
      }
      return {
        records: [],
        suppress_fallback_note: true,
      };
    }

    const selective = mergePendingLiveSelectionResolutions(
      resolvePendingProfileRuleSelection(userMessage, pendingItems),
      resolvePendingFactSelection(userMessage, pendingItems),
      resolvePendingTaskSelection(userMessage, pendingItems),
    );
    const selectiveBackfilledByActive = mergePendingLiveSelectionResolutions(
      resolvePendingProfileRuleSelectionSatisfiedByActiveSurvivors(
        userMessage,
        pendingItems,
        input.kept_active_candidates || [],
      ),
      resolvePendingFactSelectionSatisfiedByActiveSurvivors(
        userMessage,
        pendingItems,
        input.kept_active_candidates || [],
      ),
      resolvePendingTaskSelectionSatisfiedByActiveSurvivor(
        userMessage,
        pendingItems,
        input.kept_active_candidates || [],
      ),
    );
    const resolvedSelective = mergePendingLiveSelectionResolutions(
      selective,
      selectiveBackfilledByActive,
    );
    if (resolvedSelective) {
      const acceptedById = new Set(resolvedSelective.accept_items.map((item) => item.id));
      const rejectedById = new Set(resolvedSelective.reject_items.map((item) => item.id));
      const itemActionsByBatch = new Map<string, ReviewItemActionInput[]>();

      for (const pending of pendingItems) {
        const actions = itemActionsByBatch.get(pending.batch_id) || [];
        if (acceptedById.has(pending.item.id)) {
          const content = pendingLiveSelectiveRewriteContent(pending.item, userMessage)
            || pendingLiveAcceptContent(pending.item);
          if (!content) return null;
          actions.push({
            item_id: pending.item.id,
            action: 'edit_then_accept',
            payload_override: {
              content,
              source_type: 'user_confirmed',
              ...(input.session_id ? { session_id: input.session_id } : {}),
            },
          });
        } else if (rejectedById.has(pending.item.id)) {
          actions.push({
            item_id: pending.item.id,
            action: 'reject',
          });
        }
        if (actions.length > 0) itemActionsByBatch.set(pending.batch_id, actions);
      }

      const records: IngestCommittedRecord[] = [];
      for (const [batch_id, item_actions] of itemActionsByBatch.entries()) {
        const applyResult = await this.applyBatch({ batch_id, item_actions });
        records.push(
          ...applyResult.committed
            .map((item) => toIngestCommittedRecord(item))
            .filter((item): item is IngestCommittedRecord => Boolean(item)),
        );
      }

      return {
        records,
        suppress_fallback_note: true,
      };
    }

    if (pendingItems.length !== 1) return null;

    const [pending] = pendingItems;
    if (!pending) return null;

    if (isShortUserConfirmation(userMessage)) {
      if (pending.item.suggested_action !== 'accept') return null;

      const content = asString(pending.item.suggested_rewrite) || asString(pending.item.payload.content);
      if (!content) return null;

      const applyResult = await this.applyBatch({
        batch_id: pending.batch_id,
        item_actions: [{
          item_id: pending.item.id,
          action: 'edit_then_accept',
          payload_override: {
            content,
            source_type: 'user_confirmed',
            ...(input.session_id ? { session_id: input.session_id } : {}),
          },
        }],
      });

      return {
        records: applyResult.committed
          .map((item) => toIngestCommittedRecord(item))
          .filter((item): item is IngestCommittedRecord => Boolean(item)),
        suppress_fallback_note: true,
      };
    }

    const rewrittenContent = pendingLiveRewriteContent(pending.item, userMessage);
    if (rewrittenContent) {
      const applyResult = await this.applyBatch({
        batch_id: pending.batch_id,
        item_actions: [{
          item_id: pending.item.id,
          action: 'edit_then_accept',
          payload_override: {
            content: rewrittenContent,
            source_type: 'user_confirmed',
            ...(input.session_id ? { session_id: input.session_id } : {}),
          },
        }],
      });

      return {
        records: applyResult.committed
          .map((item) => toIngestCommittedRecord(item))
          .filter((item): item is IngestCommittedRecord => Boolean(item)),
        suppress_fallback_note: true,
      };
    }

    if (isShortUserProposalRejection(userMessage) && !isShortUserReplacementRequest(userMessage)) {
      await this.applyBatch({
        batch_id: pending.batch_id,
        item_actions: [{
          item_id: pending.item.id,
          action: 'reject',
        }],
      });
      return {
        records: [],
        suppress_fallback_note: true,
      };
    }

    return null;
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
    this.supersedePendingLiveItems(input.agent_id, itemInputs);

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
      this.reconcileLiveBatchesAgainstActiveTruth(input.agent_id);

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
    if (opts.agent_id && (!opts.source_kind || opts.source_kind === 'live_ingest')) {
      this.reconcileLiveBatchesAgainstActiveTruth(opts.agent_id);
    }
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
    let row = db.prepare(`
      SELECT *
      FROM review_batches_v2
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM agents WHERE agents.id = review_batches_v2.agent_id)
    `).get(id) as ReviewBatchRow | undefined;
    if (!row) return null;
    if (row.source_kind === 'live_ingest' && (row.status === 'pending' || row.status === 'partially_applied')) {
      this.reconcileLiveBatchesAgainstActiveTruth(row.agent_id);
      row = db.prepare(`
        SELECT *
        FROM review_batches_v2
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM agents WHERE agents.id = review_batches_v2.agent_id)
      `).get(id) as ReviewBatchRow | undefined;
      if (!row) return null;
    }
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

    this.reconcileLiveBatchesAgainstActiveTruth(batchDetail.batch.agent_id);

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

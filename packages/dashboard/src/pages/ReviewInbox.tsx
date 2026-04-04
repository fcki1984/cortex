import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyReviewInboxBatchV2,
  getReviewInboxBatchV2,
  listReviewInboxBatchesV2,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { formatAgentNameLabel, formatRecordKindLabel, formatSourceTypeLabel } from '../utils/v2Display.js';

type ReviewBatchSummary = {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  failed: number;
};

type ReviewBatch = {
  id: string;
  agent_id: string;
  source_kind: 'live_ingest' | 'import_preview';
  status: 'pending' | 'partially_applied' | 'completed' | 'dismissed';
  source_label?: string | null;
  source_preview: string;
  created_at: string;
  updated_at: string;
  summary: ReviewBatchSummary;
};

type ReviewItem = {
  id: string;
  batch_id: string;
  item_type: 'record' | 'relation';
  status: 'pending' | 'accepted' | 'rejected' | 'failed';
  suggested_action: 'accept' | 'reject' | 'edit';
  suggested_reason: string;
  suggested_rewrite?: string | null;
  payload: Record<string, unknown>;
  error_message?: string | null;
};

type ReviewBatchDetail = {
  batch: Omit<ReviewBatch, 'summary'>;
  summary: ReviewBatchSummary;
  items: ReviewItem[];
};

type ReviewBatchApplyPayload = {
  apply_suggested?: boolean;
  accept_all?: boolean;
  reject_all?: boolean;
  item_actions?: Array<{
    item_id: string;
    action: 'accept' | 'reject' | 'edit_then_accept';
    payload_override?: Record<string, unknown>;
  }>;
};

type ReviewBatchApplyResult = {
  summary?: {
    committed?: number;
    rejected?: number;
    failed?: number;
  };
  batch_summary?: ReviewBatchSummary;
  committed?: Array<Record<string, unknown>>;
  rejected?: Array<Record<string, unknown>>;
  failed?: Array<Record<string, unknown>>;
  remaining_pending?: number;
  batch?: Omit<ReviewBatch, 'summary'>;
};

type ReviewBatchListResponse = {
  items?: ReviewBatch[];
  total?: number;
  sync?: {
    cursor?: string | null;
    mode?: 'full' | 'delta';
  };
};

type LoadBatchesResult = {
  items: ReviewBatch[];
  nextSelected: string | null;
  selectionPreserved: boolean;
};

const REVIEW_INBOX_AUTO_REFRESH_MS = 15000;

function getPayloadContent(item: ReviewItem): string {
  return typeof item.payload.content === 'string' ? item.payload.content : '';
}

function getVisibleDraft(item: ReviewItem, draftContent: Record<string, string>): string {
  return draftContent[item.id] ?? item.suggested_rewrite ?? getPayloadContent(item);
}

function buildAcceptAction(item: ReviewItem, draftContent: Record<string, string>) {
  if (item.item_type !== 'record') {
    return {
      item_id: item.id,
      action: 'accept' as const,
    };
  }

  return {
    item_id: item.id,
    action: 'edit_then_accept' as const,
    payload_override: {
      content: getVisibleDraft(item, draftContent),
    },
  };
}

function buildSuggestedAcceptActions(
  items: ReviewItem[],
  draftContent: Record<string, string>,
) {
  return items
    .filter((item) => item.suggested_action === 'accept')
    .map((item) => buildAcceptAction(item, draftContent));
}

function buildSuggestedRejectActions(items: ReviewItem[]) {
  return items
    .filter((item) => item.suggested_action === 'reject')
    .map((item) => ({
      item_id: item.id,
      action: 'reject' as const,
    }));
}

function buildSuggestedApplyAction(item: ReviewItem): { action: 'accept' | 'reject' | 'edit_then_accept' } | null {
  if (item.suggested_action === 'edit') return null;
  if (item.suggested_action === 'reject') return { action: 'reject' };
  return {
    action: item.item_type === 'record' ? 'edit_then_accept' : 'accept',
  };
}

function getItemCandidateId(item: ReviewItem): string | null {
  return typeof item.payload.candidate_id === 'string' ? item.payload.candidate_id : null;
}

function updateItemsFromApplyResult(
  items: ReviewItem[],
  payload: ReviewBatchApplyPayload,
  result: ReviewBatchApplyResult,
): ReviewItem[] {
  const actionMap = new Map((payload.item_actions || []).map((action) => [action.item_id, action]));
  const candidateIdByItemId = new Map<string, string>();
  const itemIdByCandidateId = new Map<string, string>();

  for (const item of items) {
    const candidateId = getItemCandidateId(item);
    if (!candidateId) continue;
    candidateIdByItemId.set(item.id, candidateId);
    itemIdByCandidateId.set(candidateId, item.id);
  }

  const acceptedIds = new Set<string>();
  for (const entry of result.committed || []) {
    if (typeof entry.item_id === 'string') acceptedIds.add(entry.item_id);
    if (typeof entry.candidate_id === 'string') {
      const itemId = itemIdByCandidateId.get(entry.candidate_id);
      if (itemId) acceptedIds.add(itemId);
    }
  }

  const rejectedIds = new Set<string>();
  for (const entry of result.rejected || []) {
    if (typeof entry.item_id === 'string') rejectedIds.add(entry.item_id);
    if (typeof entry.candidate_id === 'string') {
      const itemId = itemIdByCandidateId.get(entry.candidate_id);
      if (itemId) rejectedIds.add(itemId);
    }
  }

  const failedIds = new Set<string>();
  const failureMessageByItemId = new Map<string, string>();
  for (const entry of result.failed || []) {
    const message = typeof entry.error === 'string'
      ? entry.error
      : typeof entry.reason === 'string'
        ? entry.reason
        : 'commit_failed';
    if (typeof entry.item_id === 'string') {
      failedIds.add(entry.item_id);
      failureMessageByItemId.set(entry.item_id, message);
    }
    if (typeof entry.candidate_id === 'string') {
      const itemId = itemIdByCandidateId.get(entry.candidate_id);
      if (itemId) {
        failedIds.add(itemId);
        failureMessageByItemId.set(itemId, message);
      }
    }
  }

  return items.map((item) => {
    if (item.status === 'accepted' || item.status === 'rejected') return item;
    const action = payload.reject_all
      ? { action: 'reject' as const }
      : actionMap.get(item.id) || (payload.apply_suggested ? buildSuggestedApplyAction(item) : null);
    if (!action) return item;
    if (failedIds.has(item.id)) {
      return {
        ...item,
        status: 'failed',
        error_message: failureMessageByItemId.get(item.id) || item.error_message || 'commit_failed',
      };
    }
    if (rejectedIds.has(item.id) || (payload.reject_all && !failedIds.has(item.id))) {
      return { ...item, status: 'rejected', error_message: null };
    }
    if (acceptedIds.has(item.id)) return { ...item, status: 'accepted', error_message: null };

    const candidateId = candidateIdByItemId.get(item.id);
    if (candidateId && failedIds.has(item.id)) {
      return {
        ...item,
        status: 'failed',
        error_message: failureMessageByItemId.get(item.id) || item.error_message || 'commit_failed',
      };
    }
    if (action.action === 'accept' || action.action === 'edit_then_accept') {
      return { ...item, status: 'accepted', error_message: null };
    }
    return item;
  });
}

function Notice({
  message,
  type,
}: {
  message: string;
  type: 'success' | 'error';
}) {
  return (
    <div
      style={{
        marginBottom: 16,
        padding: '10px 12px',
        borderRadius: 8,
        fontSize: 13,
        color: type === 'success' ? '#dcfce7' : '#fee2e2',
        background: type === 'success' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
        border: `1px solid ${type === 'success' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
      }}
    >
      {message}
    </div>
  );
}

function formatRequestError(t: (key: string, params?: Record<string, string | number>) => string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || t('common.error');
}

function formatSourceKindLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  sourceKind: ReviewBatch['source_kind'],
): string {
  return sourceKind === 'live_ingest'
    ? t('reviewInbox.sourceLive')
    : t('reviewInbox.sourceImport');
}

function formatBatchStatusLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  status: ReviewBatch['status'],
): string {
  switch (status) {
    case 'completed':
      return t('reviewInbox.statusCompleted');
    case 'dismissed':
      return t('reviewInbox.statusDismissed');
    case 'partially_applied':
      return t('reviewInbox.statusPartiallyApplied');
    case 'pending':
    default:
      return t('reviewInbox.statusPending');
  }
}

function formatSuggestedActionLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  action: ReviewItem['suggested_action'],
): string {
  switch (action) {
    case 'reject':
      return t('reviewInbox.actionRejectSuggested');
    case 'edit':
      return t('reviewInbox.actionEditSuggested');
    case 'accept':
    default:
      return t('reviewInbox.actionAcceptSuggested');
  }
}

function formatActionableSummary(
  t: (key: string, params?: Record<string, string | number>) => string,
  summary: ReviewBatchSummary,
): string {
  if (summary.failed > 0) {
    return t('reviewInbox.actionableSummary', {
      pending: summary.pending,
      total: summary.total,
      failed: summary.failed,
    });
  }
  return t('reviewInbox.pendingSummary', {
    pending: summary.pending,
    total: summary.total,
  });
}

function isActionableSummary(summary: ReviewBatchSummary): boolean {
  return (summary.pending + summary.failed) > 0;
}

function getNextActionableBatchId(
  batches: ReviewBatch[],
  currentBatchId: string,
): string | null {
  for (const batch of batches) {
    if (batch.id === currentBatchId) continue;
    if (isActionableSummary(batch.summary)) return batch.id;
  }
  return null;
}

function sortReviewBatches(batches: ReviewBatch[]): ReviewBatch[] {
  return [...batches].sort((left, right) => {
    const actionableDelta = Number(isActionableSummary(right.summary)) - Number(isActionableSummary(left.summary));
    if (actionableDelta !== 0) return actionableDelta;

    const rightUpdated = Date.parse(right.updated_at || '');
    const leftUpdated = Date.parse(left.updated_at || '');
    if (Number.isFinite(rightUpdated) && Number.isFinite(leftUpdated) && rightUpdated !== leftUpdated) {
      return rightUpdated - leftUpdated;
    }

    return left.id.localeCompare(right.id);
  });
}

function mergeReviewBatches(current: ReviewBatch[], incoming: ReviewBatch[]): ReviewBatch[] {
  const merged = new Map(current.map((batch) => [batch.id, batch]));
  for (const batch of incoming) {
    merged.set(batch.id, batch);
  }
  return sortReviewBatches([...merged.values()]);
}

function readRequestedBatchId(): string | null {
  if (typeof window === 'undefined') return null;
  const batchId = new URLSearchParams(window.location.search).get('batch');
  return batchId && batchId.trim() ? batchId : null;
}

function syncRequestedBatchId(batchId: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (batchId) {
    url.searchParams.set('batch', batchId);
  } else {
    url.searchParams.delete('batch');
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export default function ReviewInbox() {
  const { t } = useI18n();
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [syncCursor, setSyncCursor] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewBatchDetail | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, ReviewBatchDetail>>({});
  const [draftContent, setDraftContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshingBatches, setRefreshingBatches] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const prefetchingBatchIdsRef = useRef<Set<string>>(new Set());

  const hydrateDrafts = (items: ReviewItem[]) => {
    setDraftContent((current) => {
      const next: Record<string, string> = {};
      for (const item of items) {
        if (item.item_type !== 'record') continue;
        next[item.id] = current[item.id] ?? item.suggested_rewrite ?? getPayloadContent(item);
      }
      return next;
    });
  };

  const storeDetail = (batchId: string, response: ReviewBatchDetail) => {
    setDetailCache((current) => ({
      ...current,
      [batchId]: response,
    }));
  };

  const loadBatches = async (
    preferredBatchId?: string | null,
    options?: { background?: boolean; silentError?: boolean; cursor?: string | null },
  ): Promise<LoadBatchesResult | null> => {
    const background = options?.background === true;
    const silentError = options?.silentError === true;
    const cursor = options?.cursor?.trim() || null;
    if (background) {
      setRefreshingBatches(true);
    } else {
      setLoading(true);
      setError(null);
    }
    try {
      const requestParams = cursor ? { cursor } : undefined;
      const response = await listReviewInboxBatchesV2(requestParams) as ReviewBatchListResponse;
      if (response.sync?.cursor) {
        setSyncCursor(response.sync.cursor);
      }
      const incomingItems = sortReviewBatches((response.items || []) as ReviewBatch[]);

      if (background && cursor && response.sync?.mode === 'delta') {
        const currentBatches = batches;
        const currentBatchIds = new Set(currentBatches.map((batch) => batch.id));
        const changedIds = new Set(incomingItems.map((batch) => batch.id));
        const mergedItems = mergeReviewBatches(currentBatches, incomingItems);
        const newActionableCount = incomingItems.filter((batch) => (
          !currentBatchIds.has(batch.id) && isActionableSummary(batch.summary)
        )).length;
        const selectedBatchChanged = Boolean(preferredBatchId && changedIds.has(preferredBatchId));

        setBatches(mergedItems);
        if (changedIds.size > 0) {
          setDetailCache((current) => Object.fromEntries(
            Object.entries(current).filter(([batchId]) => (
              !changedIds.has(batchId) || batchId === preferredBatchId
            )),
          ));
        }
        if (selectedBatchChanged) {
          setNotice({
            message: t('reviewInbox.syncCurrentBatchChanged'),
            type: 'success',
          });
        } else if (newActionableCount > 0) {
          setNotice({
            message: t('reviewInbox.syncNewPending', { count: newActionableCount }),
            type: 'success',
          });
        }

        return {
          items: mergedItems,
          nextSelected: preferredBatchId || selectedBatchId || mergedItems[0]?.id || null,
          selectionPreserved: Boolean(preferredBatchId),
        };
      }

      setBatches(incomingItems);
      setDetailCache((current) => {
        const allowedIds = new Set(incomingItems.map((item) => item.id));
        return Object.fromEntries(
          Object.entries(current).filter(([batchId]) => allowedIds.has(batchId)),
        );
      });
      const selectionPreserved = Boolean(preferredBatchId && incomingItems.some((item) => item.id === preferredBatchId));
      const nextSelected = selectionPreserved
        ? preferredBatchId as string
        : (incomingItems[0]?.id || null);
      setSelectedBatchId(nextSelected);
      return {
        items: incomingItems,
        nextSelected,
        selectionPreserved,
      };
    } catch (loadError) {
      const message = formatRequestError(t, loadError);
      if (background) {
        if (!silentError) {
          setNotice({ message, type: 'error' });
        }
      } else {
        setError(message);
      }
      return null;
    } finally {
      if (background) {
        setRefreshingBatches(false);
      } else {
        setLoading(false);
      }
    }
  };

  const loadDetail = async (batchId: string, options?: { preserveCurrent?: boolean; forceRefresh?: boolean }) => {
    const cachedDetail = detailCache[batchId] || null;
    const forceRefresh = options?.forceRefresh === true;
    const preserveCurrent = options?.preserveCurrent === true && detail?.batch.id === batchId;
    if (cachedDetail && !forceRefresh) {
      setDetail(cachedDetail);
      hydrateDrafts(cachedDetail.items || []);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    if (!preserveCurrent) {
      setDetail(null);
    }
    try {
      const response = await getReviewInboxBatchV2(batchId) as ReviewBatchDetail;
      setDetail(response);
      storeDetail(batchId, response);
      hydrateDrafts(response.items || []);
    } catch (loadError) {
      setDetailError(formatRequestError(t, loadError));
      if (!preserveCurrent) {
        setDetail(null);
      }
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadBatches(readRequestedBatchId());
  }, []);

  useEffect(() => {
    if (!selectedBatchId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedBatchId);
  }, [selectedBatchId]);

  const actionableItems = useMemo(
    () => detail?.items.filter((item) => item.status === 'pending' || item.status === 'failed') || [],
    [detail],
  );
  const suggestedAcceptActions = useMemo(
    () => buildSuggestedAcceptActions(actionableItems, draftContent),
    [actionableItems, draftContent],
  );
  const suggestedRejectActions = useMemo(
    () => buildSuggestedRejectActions(actionableItems),
    [actionableItems],
  );
  const suggestedApplyCount = useMemo(
    () => actionableItems.filter((item) => item.suggested_action === 'accept' || item.suggested_action === 'reject').length,
    [actionableItems],
  );
  const selectedDetail = detail && detail.batch.id === selectedBatchId ? detail : null;

  useEffect(() => {
    if (error || !selectedBatchId || !selectedDetail) return;
    const nextBatchId = getNextActionableBatchId(batches, selectedBatchId);
    if (!nextBatchId) return;
    if (detailCache[nextBatchId]) return;
    if (prefetchingBatchIdsRef.current.has(nextBatchId)) return;

    prefetchingBatchIdsRef.current.add(nextBatchId);
    void (async () => {
      try {
        const response = await getReviewInboxBatchV2(nextBatchId) as ReviewBatchDetail;
        storeDetail(nextBatchId, response);
      } catch {
        // Best-effort prefetch should not disrupt the current review flow.
      } finally {
        prefetchingBatchIdsRef.current.delete(nextBatchId);
      }
    })();
  }, [batches, selectedBatchId, selectedDetail, error, detailCache]);

  useEffect(() => {
    if (loading || error) return;
    syncRequestedBatchId(selectedBatchId);
  }, [selectedBatchId, loading, error]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refreshBatchList = async (options?: {
    syncCurrentDetail?: boolean;
    clearNotice?: boolean;
    silentError?: boolean;
    incremental?: boolean;
  }) => {
    if (loading || refreshingBatches) return;
    if (options?.clearNotice) {
      setNotice(null);
    }
    const preferredBatchId = selectedBatchId;
    const result = await loadBatches(preferredBatchId, {
      background: true,
      silentError: options?.silentError,
      cursor: options?.incremental ? syncCursor : null,
    });
    if (!result || !preferredBatchId) return;
    if (
      options?.syncCurrentDetail &&
      result.selectionPreserved &&
      result.nextSelected === preferredBatchId
    ) {
      await loadDetail(preferredBatchId, {
        preserveCurrent: true,
        forceRefresh: true,
      });
    }
  };

  const handleRefreshBatches = async () => {
    await refreshBatchList({
      syncCurrentDetail: true,
      clearNotice: true,
    });
  };

  useEffect(() => {
    if (loading || error || applying || refreshingBatches || batches.length === 0) return;

    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshBatchList({ silentError: true, incremental: true });
    }, REVIEW_INBOX_AUTO_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [loading, error, applying, refreshingBatches, batches.length, selectedBatchId, syncCursor]);

  const handleBatchApply = async (payload: ReviewBatchApplyPayload) => {
    if (!selectedBatchId) return;
    setApplying(true);
    setNotice(null);
    try {
      const result = await applyReviewInboxBatchV2(selectedBatchId, payload) as ReviewBatchApplyResult;
      const updatedBatches = sortReviewBatches(batches.map((batch) => (
        batch.id === selectedBatchId
          ? {
              ...batch,
              ...(result.batch || {}),
              summary: result.batch_summary || batch.summary,
            }
          : batch
      )));
      const updatedCurrentBatch = updatedBatches.find((batch) => batch.id === selectedBatchId) || null;
      const nextActionableBatchId = updatedCurrentBatch && !isActionableSummary(updatedCurrentBatch.summary)
        ? getNextActionableBatchId(updatedBatches, selectedBatchId)
        : null;

      setDetailError(null);
      setBatches(updatedBatches);
      setDetail((current) => {
        if (!current || current.batch.id !== selectedBatchId) return current;
        const nextDetail = {
          batch: {
            ...current.batch,
            ...(result.batch || {}),
          },
          summary: result.batch_summary || current.summary,
          items: updateItemsFromApplyResult(current.items, payload, result),
        };
        storeDetail(selectedBatchId, nextDetail);
        return nextDetail;
      });
      if (nextActionableBatchId) {
        setSelectedBatchId(nextActionableBatchId);
      }
      setNotice({
        message: t('reviewInbox.applySuccess', {
          committed: result.summary?.committed ?? 0,
          rejected: result.summary?.rejected ?? 0,
          failed: result.summary?.failed ?? 0,
        }),
        type: 'success',
      });
    } catch (applyError) {
      setNotice({ message: formatRequestError(t, applyError), type: 'error' });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">{t('reviewInbox.title')}</h1>

      {notice && <Notice message={notice.message} type={notice.type} />}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7 }}>
          {t('reviewInbox.intro')}
        </div>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(239,68,68,0.35)' }}>
          <div style={{ marginBottom: 10, color: '#fca5a5' }}>{error}</div>
          <button type="button" className="btn" onClick={() => void loadBatches(selectedBatchId)}>
            {t('reviewInbox.retry')}
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>{t('reviewInbox.listTitle')}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('common.total', { count: batches.length })}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => void handleRefreshBatches()}
                disabled={loading || refreshingBatches}
              >
                {refreshingBatches ? t('reviewInbox.refreshingList') : t('reviewInbox.refreshList')}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="empty">{t('common.loading')}</div>
          ) : batches.length === 0 ? (
            <div className="empty">{t('reviewInbox.empty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {batches.map((batch) => (
                <button
                  key={batch.id}
                  type="button"
                  onClick={() => setSelectedBatchId(batch.id)}
                  style={{
                    textAlign: 'left',
                    width: '100%',
                    background: batch.id === selectedBatchId ? 'rgba(59,130,246,0.14)' : 'var(--bg-card)',
                    border: `1px solid ${batch.id === selectedBatchId ? 'rgba(59,130,246,0.35)' : 'var(--border)'}`,
                    borderRadius: 10,
                    padding: 12,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <span className="badge" style={{ background: 'rgba(59,130,246,0.18)', color: '#93c5fd' }}>
                      {formatSourceKindLabel(t, batch.source_kind)}
                    </span>
                    <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>
                      {formatBatchStatusLabel(t, batch.status)}
                    </span>
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.5, marginBottom: 8 }}>
                    {batch.source_preview}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    <span>{formatAgentNameLabel(t, batch.agent_id)}</span>
                    <span>{formatActionableSummary(t, batch.summary)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          {!selectedBatchId ? (
            <div className="empty">{t('reviewInbox.detailEmpty')}</div>
          ) : detailLoading && !selectedDetail && !detailError ? (
            <div className="empty">{t('common.loading')}</div>
          ) : !selectedDetail && detailError ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ color: '#fca5a5', fontSize: 14 }}>{t('reviewInbox.detailLoadFailed')}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7 }}>
                {t('reviewInbox.detailLoadFailedHint')}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.7 }}>
                {detailError}
              </div>
              <div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadDetail(selectedBatchId, { forceRefresh: true })}
                  disabled={detailLoading}
                >
                  {t('reviewInbox.retryDetail')}
                </button>
              </div>
            </div>
          ) : !selectedDetail ? (
            <div className="empty">{t('common.loading')}</div>
          ) : (
            <>
              {detailError && (
                <div style={{
                  marginBottom: 16,
                  padding: '10px 12px',
                  borderRadius: 8,
                  fontSize: 13,
                  color: '#fee2e2',
                  background: 'rgba(239,68,68,0.15)',
                  border: '1px solid rgba(239,68,68,0.25)',
                }}>
                  <div style={{ marginBottom: 6 }}>{t('reviewInbox.detailLoadFailed')}</div>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 8 }}>{t('reviewInbox.detailLoadFailedHint')}</div>
                  <div style={{ marginBottom: 10 }}>{detailError}</div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void loadDetail(selectedBatchId, { preserveCurrent: true, forceRefresh: true })}
                    disabled={detailLoading}
                  >
                    {t('reviewInbox.retryDetail')}
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
                <div>
                  <h3 style={{ marginTop: 0, marginBottom: 8 }}>{t('reviewInbox.detailTitle')}</h3>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className="badge" style={{ background: 'rgba(59,130,246,0.18)', color: '#93c5fd' }}>
                      {formatSourceKindLabel(t, selectedDetail.batch.source_kind)}
                    </span>
                    <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>
                      {formatBatchStatusLabel(t, selectedDetail.batch.status)}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                    {t('reviewInbox.sourcePreview')}: {selectedDetail.batch.source_preview}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                    {t('reviewInbox.agentLabel')}: {formatAgentNameLabel(t, selectedDetail.batch.agent_id)}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={applying || suggestedApplyCount === 0}
                    onClick={() => void handleBatchApply({
                      apply_suggested: true,
                    })}
                  >
                    {applying ? t('reviewInbox.applying') : t('reviewInbox.actionApplySuggested')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={applying || suggestedAcceptActions.length === 0}
                    onClick={() => void handleBatchApply({
                      item_actions: suggestedAcceptActions,
                    })}
                  >
                    {t('reviewInbox.actionAcceptSuggestedOnly')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={applying || suggestedRejectActions.length === 0}
                    onClick={() => void handleBatchApply({
                      item_actions: suggestedRejectActions,
                    })}
                  >
                    {t('reviewInbox.actionRejectSuggestedOnly')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={applying || actionableItems.length === 0}
                    onClick={() => void handleBatchApply({
                      item_actions: actionableItems.map((item) => buildAcceptAction(item, draftContent)),
                    })}
                  >
                    {applying ? t('reviewInbox.applying') : t('reviewInbox.actionAcceptAll')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={applying || actionableItems.length === 0}
                    onClick={() => void handleBatchApply({ reject_all: true })}
                  >
                    {t('reviewInbox.actionRejectAll')}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                {formatActionableSummary(t, selectedDetail.summary)}
              </div>

              {actionableItems.length === 0 ? (
                <div className="empty">{t('reviewInbox.emptyItems')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {actionableItems.map((item) => {
                    const content = getVisibleDraft(item, draftContent);
                    const originalContent = getPayloadContent(item);
                    const warnings = Array.isArray(item.payload.warnings)
                      ? item.payload.warnings.filter((warning): warning is string => typeof warning === 'string')
                      : [];
                    const kind = typeof item.payload.normalized_kind === 'string'
                      ? item.payload.normalized_kind
                      : typeof item.payload.requested_kind === 'string'
                        ? item.payload.requested_kind
                        : null;

                    return (
                      <div key={item.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>
                              {item.item_type === 'record' ? t('reviewInbox.itemRecord') : t('reviewInbox.itemRelation')}
                            </span>
                            <span className="badge" style={{ background: 'rgba(59,130,246,0.18)', color: '#93c5fd' }}>
                              {formatSuggestedActionLabel(t, item.suggested_action)}
                            </span>
                            {kind && (
                              <span className="badge" style={{ background: 'rgba(250,204,21,0.14)', color: '#fde68a' }}>
                                {formatRecordKindLabel(t, kind)}
                              </span>
                            )}
                            {typeof item.payload.source_type === 'string' && (
                              <span className="badge" style={{ background: 'rgba(168,85,247,0.14)', color: '#d8b4fe' }}>
                                {formatSourceTypeLabel(t, item.payload.source_type)}
                              </span>
                            )}
                            {item.status === 'failed' && (
                              <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5' }}>
                                {t('reviewInbox.statusFailed')}
                              </span>
                            )}
                          </div>
                        </div>

                        <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--text)', lineHeight: 1.7 }}>
                          <strong>{t('reviewInbox.suggestedReason')}:</strong> {item.suggested_reason}
                        </div>

                        {item.status === 'failed' && (
                          <div style={{ marginBottom: 10, fontSize: 12, color: '#fca5a5', lineHeight: 1.7 }}>
                            <strong>{t('reviewInbox.failedMessage')}:</strong> {item.error_message || 'commit_failed'}
                            <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>
                              {t('reviewInbox.failedHint')}
                            </div>
                          </div>
                        )}

                        {item.suggested_rewrite && (
                          <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                            <strong>{t('reviewInbox.suggestedRewrite')}:</strong> {item.suggested_rewrite}
                          </div>
                        )}

                        {item.item_type === 'record' && originalContent && (
                          <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                            <strong>{t('reviewInbox.originalContent')}:</strong> {originalContent}
                          </div>
                        )}

                        {item.item_type === 'record' && (
                          <div className="form-group" style={{ marginBottom: 12 }}>
                            <label htmlFor={`review-item-${item.id}`}>{t('reviewInbox.reviewDraft')}</label>
                            <textarea
                              id={`review-item-${item.id}`}
                              value={content}
                              rows={3}
                              onChange={(event) => setDraftContent((current) => ({
                                ...current,
                                [item.id]: event.target.value,
                              }))}
                              style={{ width: '100%', resize: 'vertical' }}
                            />
                          </div>
                        )}

                        {typeof item.payload.source_excerpt === 'string' && item.payload.source_excerpt && (
                          <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                            <strong>{t('reviewInbox.excerpt')}:</strong> {item.payload.source_excerpt}
                          </div>
                        )}

                        {warnings.length > 0 && (
                          <div style={{ marginBottom: 12, fontSize: 12, color: '#fbbf24', lineHeight: 1.7 }}>
                            <strong>{t('reviewInbox.warnings')}:</strong> {warnings.join(' · ')}
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn primary"
                            disabled={applying}
                            onClick={() => void handleBatchApply({
                              item_actions: [buildAcceptAction(item, draftContent)],
                            })}
                          >
                            {item.status === 'failed' ? t('reviewInbox.actionRetry') : t('reviewInbox.actionAccept')}
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={applying}
                            onClick={() => void handleBatchApply({
                              item_actions: [{ item_id: item.id, action: 'reject' }],
                            })}
                          >
                            {t('reviewInbox.actionReject')}
                          </button>
                          {item.item_type === 'record' && (
                            <button
                              type="button"
                              className="btn"
                              disabled={applying}
                              onClick={() => void handleBatchApply({
                                item_actions: [{
                                  item_id: item.id,
                                  action: 'edit_then_accept',
                                  payload_override: {
                                    content,
                                  },
                                }],
                              })}
                            >
                              {t('reviewInbox.actionEditThenAccept')}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

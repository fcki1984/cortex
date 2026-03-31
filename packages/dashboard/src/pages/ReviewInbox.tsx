import React, { useEffect, useMemo, useState } from 'react';
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
};

type ReviewBatchDetail = {
  batch: Omit<ReviewBatch, 'summary'>;
  summary: ReviewBatchSummary;
  items: ReviewItem[];
};

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

export default function ReviewInbox() {
  const { t } = useI18n();
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewBatchDetail | null>(null);
  const [draftContent, setDraftContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

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

  const loadBatches = async (preferredBatchId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const response: any = await listReviewInboxBatchesV2();
      const items = (response.items || []) as ReviewBatch[];
      setBatches(items);
      const nextSelected = preferredBatchId && items.some((item) => item.id === preferredBatchId)
        ? preferredBatchId
        : (items[0]?.id || null);
      setSelectedBatchId(nextSelected);
    } catch (loadError) {
      setError(formatRequestError(t, loadError));
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (batchId: string, options?: { preserveCurrent?: boolean }) => {
    const preserveCurrent = options?.preserveCurrent === true && detail?.batch.id === batchId;
    setDetailLoading(true);
    setDetailError(null);
    if (!preserveCurrent) {
      setDetail(null);
    }
    try {
      const response = await getReviewInboxBatchV2(batchId) as ReviewBatchDetail;
      setDetail(response);
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
    void loadBatches();
  }, []);

  useEffect(() => {
    if (!selectedBatchId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedBatchId);
  }, [selectedBatchId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const pendingItems = useMemo(
    () => detail?.items.filter((item) => item.status === 'pending') || [],
    [detail],
  );
  const selectedDetail = detail && detail.batch.id === selectedBatchId ? detail : null;

  const refreshCurrentBatch = async (batchId: string) => {
    await loadBatches(batchId);
    await loadDetail(batchId, { preserveCurrent: true });
  };

  const handleBatchApply = async (payload: {
    accept_all?: boolean;
    reject_all?: boolean;
    item_actions?: Array<{
      item_id: string;
      action: 'accept' | 'reject' | 'edit_then_accept';
      payload_override?: Record<string, unknown>;
    }>;
  }) => {
    if (!selectedBatchId) return;
    setApplying(true);
    setNotice(null);
    try {
      const result: any = await applyReviewInboxBatchV2(selectedBatchId, payload);
      setNotice({
        message: t('reviewInbox.applySuccess', {
          committed: result.summary?.committed ?? 0,
          rejected: result.summary?.rejected ?? 0,
          failed: result.summary?.failed ?? 0,
        }),
        type: 'success',
      });
      await refreshCurrentBatch(selectedBatchId);
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
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('common.total', { count: batches.length })}
            </span>
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
                    <span>{t('reviewInbox.pendingSummary', { pending: batch.summary.pending, total: batch.summary.total })}</span>
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
                  onClick={() => void loadDetail(selectedBatchId)}
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
                    onClick={() => void loadDetail(selectedBatchId, { preserveCurrent: true })}
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
                    disabled={applying || pendingItems.length === 0}
                    onClick={() => void handleBatchApply({
                      item_actions: pendingItems.map((item) => buildAcceptAction(item, draftContent)),
                    })}
                  >
                    {applying ? t('reviewInbox.applying') : t('reviewInbox.actionAcceptAll')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={applying || pendingItems.length === 0}
                    onClick={() => void handleBatchApply({ reject_all: true })}
                  >
                    {t('reviewInbox.actionRejectAll')}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('reviewInbox.pendingSummary', {
                  pending: selectedDetail.summary.pending,
                  total: selectedDetail.summary.total,
                })}
              </div>

              {pendingItems.length === 0 ? (
                <div className="empty">{t('reviewInbox.emptyItems')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {pendingItems.map((item) => {
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
                          </div>
                        </div>

                        <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--text)', lineHeight: 1.7 }}>
                          <strong>{t('reviewInbox.suggestedReason')}:</strong> {item.suggested_reason}
                        </div>

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
                            {t('reviewInbox.actionAccept')}
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

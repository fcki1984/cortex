import React, { useEffect, useMemo, useState } from 'react';
import {
  getFeedbackStatsV2,
  listAgents,
  listRecordsV2,
  submitFeedbackV2,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';
import {
  formatAgentNameLabel,
  formatFeedbackKindLabel,
  formatNormalizationLabel,
  formatReasonCodeLabel,
  formatRecordKindLabel,
  formatSourceTypeLabel,
  formatWriteDecisionLabel,
} from '../utils/v2Display.js';

type RecordItem = {
  id: string;
  kind: 'profile_rule' | 'fact_slot' | 'task_state' | 'session_note';
  requested_kind?: string;
  written_kind?: string;
  normalization?: string;
  reason_code?: string | null;
  source_type: string;
  content: string;
  tags: string[];
  agent_id: string;
  updated_at: string;
  created_at: string;
};

type FeedbackKind = 'good' | 'bad' | 'corrected';

export default function FeedbackReview() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [stats, setStats] = useState({ good: 0, bad: 0, corrected: 0 });
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);
  const [form, setForm] = useState({
    feedback: 'good' as FeedbackKind,
    reason: '',
    corrected_content: '',
  });

  const selectedRecord = useMemo(
    () => records.find((record) => record.id === selectedId) || null,
    [records, selectedId],
  );

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, recordsRes] = await Promise.all([
        getFeedbackStatsV2(agentId || undefined),
        listRecordsV2({
          agent_id: agentId || '',
          query: query || '',
          limit: '25',
          order_by: 'updated_at',
          order_dir: 'desc',
        }),
      ]);
      setStats({
        good: statsRes.good ?? 0,
        bad: statsRes.bad ?? 0,
        corrected: statsRes.corrected ?? 0,
      });
      const nextRecords = recordsRes.items || [];
      setRecords(nextRecords);
      if (!nextRecords.some((record: RecordItem) => record.id === selectedId)) {
        setSelectedId(nextRecords[0]?.id || '');
      }
    } catch (e: any) {
      setError(e.message || t('feedback.loadError'));
      setRecords([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    listAgents().then((res: any) => setAgents(res.agents || res || [])).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [agentId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRecord) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await submitFeedbackV2({
        agent_id: selectedRecord.agent_id,
        record_id: selectedRecord.id,
        feedback: form.feedback,
        reason: form.reason || undefined,
        corrected_content: form.feedback === 'corrected' ? form.corrected_content : undefined,
      });
      setResult(response);
      if (form.feedback === 'corrected') {
        setForm(prev => ({ ...prev, corrected_content: '' }));
      }
      setForm(prev => ({ ...prev, reason: '' }));
      await refresh();
    } catch (e: any) {
      setError(e.message || t('feedback.submitError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>{t('feedback.title')}</h1>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('feedback.subtitle')}</div>
        </div>
        <button className="btn" onClick={refresh} disabled={loading}>
          {loading ? `${t('common.loading')}` : t('feedback.refresh')}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{t('feedback.statsTitle')}</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{stats.good + stats.bad + stats.corrected}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('common.total', { count: stats.good + stats.bad + stats.corrected })}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#4ade80' }}>{stats.good}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('feedback.good')}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#fbbf24' }}>{stats.bad}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('feedback.bad')}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#60a5fa' }}>{stats.corrected}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('feedback.corrected')}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>{t('feedback.recordSearchTitle')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">{t('feedback.allAgents')}</option>
            {agents.map((agent: any) => (
              <option key={agent.id} value={agent.id}>{formatAgentNameLabel(t, agent.id, agent.name)}</option>
            ))}
          </select>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') refresh(); }}
            placeholder={t('feedback.searchPlaceholder')}
            style={{ minWidth: 280, flex: 1 }}
          />
          <button className="btn" onClick={refresh}>{t('feedback.search')}</button>
        </div>

        {error && <div style={{ marginBottom: 12, color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

        {records.length === 0 ? (
          <div className="empty">{t('feedback.noRecords')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {records.map(record => {
              const selected = record.id === selectedId;
              return (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => setSelectedId(record.id)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: selected ? 'rgba(59,130,246,0.12)' : 'transparent',
                    border: `1px solid ${selected ? 'rgba(59,130,246,0.45)' : 'var(--border)'}`,
                    borderRadius: 8,
                    padding: 12,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span className="badge" style={{ background: 'rgba(34,197,94,0.16)', color: '#4ade80' }}>{formatRecordKindLabel(t, record.kind)}</span>
                      <span className="badge" style={{ background: 'rgba(59,130,246,0.16)', color: '#93c5fd' }}>{formatSourceTypeLabel(t, record.source_type)}</span>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{toLocal(record.updated_at || record.created_at)}</span>
                  </div>
                  <div style={{ color: 'var(--text)', lineHeight: 1.5, marginBottom: 8 }}>{record.content}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('feedback.requestedWritten')}: {formatRecordKindLabel(t, record.requested_kind || record.kind)} → {formatRecordKindLabel(t, record.written_kind || record.kind)}
                    {' · '}
                    {t('feedback.normalization')}: {formatNormalizationLabel(t, record.normalization || 'durable')}
                    {record.reason_code ? ` (${formatReasonCodeLabel(t, record.reason_code)})` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>{t('feedback.reviewTitle')}</h3>
        {!selectedRecord ? (
          <div className="empty">{t('feedback.pickRecord')}</div>
        ) : (
          <>
            <div style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{t('feedback.selectedRecord')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <span className="badge" style={{ background: 'rgba(34,197,94,0.16)', color: '#4ade80' }}>{formatRecordKindLabel(t, selectedRecord.kind)}</span>
                <span className="badge" style={{ background: 'rgba(59,130,246,0.16)', color: '#93c5fd' }}>{formatAgentNameLabel(t, selectedRecord.agent_id, agents.find((agent: any) => agent.id === selectedRecord.agent_id)?.name)}</span>
                <span className="badge" style={{ background: 'rgba(245,158,11,0.16)', color: '#fbbf24' }}>{formatSourceTypeLabel(t, selectedRecord.source_type)}</span>
              </div>
              <div style={{ color: 'var(--text)', lineHeight: 1.5, marginBottom: 8 }}>{selectedRecord.content}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('feedback.requestedWritten')}: {formatRecordKindLabel(t, selectedRecord.requested_kind || selectedRecord.kind)} → {formatRecordKindLabel(t, selectedRecord.written_kind || selectedRecord.kind)}
                {' · '}
                {t('feedback.normalization')}: {formatNormalizationLabel(t, selectedRecord.normalization || 'durable')}
                {' · '}
                {t('feedback.sourceType')}: {formatSourceTypeLabel(t, selectedRecord.source_type)}
              </div>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{t('feedback.feedbackKind')}</label>
                  <select
                    value={form.feedback}
                    onChange={e => setForm(prev => ({ ...prev, feedback: e.target.value as FeedbackKind }))}
                    style={{ width: '100%' }}
                  >
                    <option value="good">{t('feedback.good')}</option>
                    <option value="bad">{t('feedback.bad')}</option>
                    <option value="corrected">{t('feedback.corrected')}</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{t('feedback.reason')}</label>
                  <input
                    value={form.reason}
                    onChange={e => setForm(prev => ({ ...prev, reason: e.target.value }))}
                    placeholder={t('common.optional')}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              {form.feedback === 'corrected' && (
                <div style={{ marginTop: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{t('feedback.correctedContent')}</label>
                  <textarea
                    value={form.corrected_content}
                    onChange={e => setForm(prev => ({ ...prev, corrected_content: e.target.value }))}
                    rows={4}
                    placeholder={t('feedback.correctedHint')}
                    style={{ width: '100%' }}
                  />
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <button
                  className="btn"
                  type="submit"
                  disabled={submitting || (form.feedback === 'corrected' && !form.corrected_content.trim())}
                >
                  {submitting ? t('feedback.submitting') : t('feedback.submit')}
                </button>
              </div>
            </form>
          </>
        )}
      </div>

      {result && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('feedback.latestResult')}</h3>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
            {t('feedback.resultSummary', {
              id: result.feedback?.id,
              feedback: formatFeedbackKindLabel(t, result.feedback?.feedback),
            })}
          </div>
          {result.correction ? (
            <div style={{ color: 'var(--text)' }}>
              <strong>{t('feedback.correctionResult')}:</strong> {formatWriteDecisionLabel(t, result.correction.decision)} → {formatRecordKindLabel(t, result.correction.record?.kind)} ({result.correction.record?.id})
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>{t('feedback.noCorrectionRecord')}</div>
          )}
        </div>
      )}
    </div>
  );
}

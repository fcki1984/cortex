import React, { useEffect, useMemo, useState } from 'react';
import {
  confirmRelationCandidateV2,
  createRelationCandidateV2,
  deleteRelationCandidateV2,
  deleteRelationV2,
  listAgents,
  listRelationCandidatesV2,
  listRelationsV2,
  updateRelationCandidateV2,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';
import {
  formatAgentNameLabel,
  formatRecordKindLabel,
  formatRelationCandidateStatusLabel,
} from '../utils/v2Display.js';

type CandidateRecord = {
  id: string;
  agent_id: string;
  source_record_id: string;
  source_evidence_id: number | null;
  subject_key: string;
  predicate: string;
  object_key: string;
  confidence: number;
  status: 'pending' | 'confirmed' | 'rejected';
  created_at: string;
  updated_at: string;
  source_record?: { id: string; kind: string; content: string } | null;
  source_evidence?: { id: number; role: string; content: string } | null;
};

type RelationRecord = {
  id: string;
  agent_id: string;
  source_record_id: string;
  source_evidence_id: number | null;
  subject_key: string;
  predicate: string;
  object_key: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  source_record?: { id: string; kind: string; content: string } | null;
  source_evidence?: { id: number; role: string; content: string } | null;
};

const STATUS_COLORS: Record<string, { background: string; color: string }> = {
  pending: { background: 'rgba(59,130,246,0.15)', color: '#60a5fa' },
  confirmed: { background: 'rgba(34,197,94,0.15)', color: '#4ade80' },
  rejected: { background: 'rgba(239,68,68,0.15)', color: '#f87171' },
};

export default function RelationGraph() {
  const [view, setView] = useState<'candidates' | 'confirmed'>('candidates');
  const [candidateStatus, setCandidateStatus] = useState<'pending' | 'confirmed' | 'rejected' | ''>('pending');
  const [candidates, setCandidates] = useState<CandidateRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    source_record_id: '',
    subject_key: '',
    predicate: '',
    object_key: '',
    confidence: '0.8',
  });
  const { t } = useI18n();

  const relationCountLabel = useMemo(
    () => t('relationManager.listCount', { count: relations.length }),
    [relations.length, t],
  );
  const candidateCountLabel = useMemo(
    () => t('relationManager.candidateCount', { count: candidates.length }),
    [candidates.length, t],
  );

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [candidateRes, relationRes] = await Promise.all([
        listRelationCandidatesV2({
          ...(agentId ? { agent_id: agentId } : {}),
          ...(candidateStatus ? { status: candidateStatus } : {}),
          limit: '200',
        }),
        listRelationsV2(agentId ? { agent_id: agentId, limit: '200' } : { limit: '200' }),
      ]);
      setCandidates(candidateRes.items || []);
      setRelations(relationRes.items || []);
    } catch (e: any) {
      setError(e.message || t('relationManager.createError'));
      setCandidates([]);
      setRelations([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    listAgents().then((res: any) => setAgents(res.agents || res || [])).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [agentId, candidateStatus]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.source_record_id.trim() || !form.subject_key.trim() || !form.predicate.trim() || !form.object_key.trim()) return;
    setCreating(true);
    setError('');
    try {
      await createRelationCandidateV2({
        agent_id: agentId || undefined,
        source_record_id: form.source_record_id.trim(),
        subject_key: form.subject_key.trim(),
        predicate: form.predicate.trim(),
        object_key: form.object_key.trim(),
        confidence: Number(form.confidence) || 0.8,
      });
      setForm({ source_record_id: '', subject_key: '', predicate: '', object_key: '', confidence: '0.8' });
      setView('candidates');
      setCandidateStatus('pending');
      await load();
    } catch (e: any) {
      setError(e.message || t('relationManager.saveError'));
    } finally {
      setCreating(false);
    }
  };

  const handleCandidateStatus = async (id: string, status: 'pending' | 'rejected') => {
    await updateRelationCandidateV2(id, { status });
    await load();
  };

  const handleConfirm = async (id: string) => {
    await confirmRelationCandidateV2(id);
    setView('confirmed');
    await load();
  };

  const handleDeleteCandidate = async (id: string) => {
    if (!confirm(t('relationManager.deleteConfirm'))) return;
    await deleteRelationCandidateV2(id);
    await load();
  };

  const handleDeleteRelation = async (id: string) => {
    if (!confirm(t('relationManager.deleteConfirm'))) return;
    await deleteRelationV2(id);
    await load();
  };

  return (
    <div>
      <h1 className="page-title">{t('nav.relations')}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>{t('relationManager.traceableHint')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('relationManager.auditHint')}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('relationManager.filterAgent')}</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
              <option value="">{t('relationManager.allAgents')}</option>
              {agents.map((agent: any) => (
                <option key={agent.id} value={agent.id}>
                  {formatAgentNameLabel(t, agent.id, agent.name)}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => setView('candidates')}>{t('relationManager.candidatesTab')}</button>
            <button className="btn" onClick={() => setView('confirmed')}>{t('relationManager.confirmedTab')}</button>
          </div>
        </div>
      </div>

      <form className="card" onSubmit={handleCreate} style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>{t('relationManager.createCandidateTitle')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <input
            aria-label={t('relationManager.sourceRecordId')}
            placeholder={t('relationManager.sourceRecordIdPlaceholder')}
            value={form.source_record_id}
            onChange={e => setForm(prev => ({ ...prev, source_record_id: e.target.value }))}
          />
          <input
            aria-label={t('relationManager.subjectKey')}
            placeholder={t('relationManager.subjectKeyPlaceholder')}
            value={form.subject_key}
            onChange={e => setForm(prev => ({ ...prev, subject_key: e.target.value }))}
          />
          <input
            aria-label={t('relationManager.predicateLabel')}
            placeholder={t('relationManager.predicatePlaceholder')}
            value={form.predicate}
            onChange={e => setForm(prev => ({ ...prev, predicate: e.target.value }))}
          />
          <input
            aria-label={t('relationManager.objectKey')}
            placeholder={t('relationManager.objectKeyPlaceholder')}
            value={form.object_key}
            onChange={e => setForm(prev => ({ ...prev, object_key: e.target.value }))}
          />
          <input
            aria-label={t('relationManager.confidenceLabel')}
            placeholder={t('relationManager.confidencePlaceholder')}
            value={form.confidence}
            onChange={e => setForm(prev => ({ ...prev, confidence: e.target.value }))}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('relationManager.createHint')}
          </div>
          <button className="btn" type="submit" disabled={creating}>
            {creating ? t('relationManager.creating') : t('relationManager.createCandidate')}
          </button>
        </div>
        {error && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </form>

      {view === 'candidates' ? (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{t('relationManager.candidateTitle')}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{candidateCountLabel}</span>
              <select value={candidateStatus} onChange={e => setCandidateStatus(e.target.value as any)} style={{ fontSize: 13, padding: '4px 8px' }}>
                <option value="">{t('relationManager.allStatuses')}</option>
                <option value="pending">{t('relationManager.statusPending')}</option>
                <option value="confirmed">{t('relationManager.statusConfirmed')}</option>
                <option value="rejected">{t('relationManager.statusRejected')}</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="empty">{t('relationManager.loading')}</div>
          ) : candidates.length === 0 ? (
            <div className="empty">{t('relationManager.emptyCandidates')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {candidates.map(candidate => {
                const statusStyle = STATUS_COLORS[candidate.status] || STATUS_COLORS.pending;
                return (
                  <div key={candidate.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                          <span className="badge" style={{ background: 'rgba(59,130,246,0.15)', color: '#60a5fa' }}>{candidate.subject_key}</span>
                          <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>{candidate.predicate}</span>
                          <span className="badge" style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>{candidate.object_key}</span>
                          <span className="badge" style={statusStyle}>{formatRelationCandidateStatusLabel(t, candidate.status)}</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {t('relationManager.meta', {
                            agent: formatAgentNameLabel(t, candidate.agent_id),
                            confidence: candidate.confidence.toFixed(2),
                            updated: toLocal(candidate.updated_at),
                          })}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {candidate.status !== 'confirmed' && (
                          <button className="btn" onClick={() => handleConfirm(candidate.id)}>{t('relationManager.confirm')}</button>
                        )}
                        {candidate.status !== 'rejected' && (
                          <button className="btn" onClick={() => handleCandidateStatus(candidate.id, 'rejected')}>{t('relationManager.reject')}</button>
                        )}
                        {candidate.status !== 'pending' && (
                          <button className="btn" onClick={() => handleCandidateStatus(candidate.id, 'pending')}>{t('relationManager.markPending')}</button>
                        )}
                        <button className="btn" onClick={() => handleDeleteCandidate(candidate.id)}>{t('common.delete')}</button>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                      <div><strong>{t('relationManager.sourceRecord')}:</strong> {candidate.source_record_id}</div>
                      {candidate.source_record && (
                        <div style={{ marginTop: 4, color: 'var(--text)' }}>
                          [{formatRecordKindLabel(t, candidate.source_record.kind)}] {candidate.source_record.content}
                        </div>
                      )}
                      {candidate.source_evidence && (
                        <div style={{ marginTop: 6 }}>
                          <strong>{t('relationManager.evidence')}:</strong> [{candidate.source_evidence.role}] {candidate.source_evidence.content}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>{t('relationManager.listTitle')}</h3>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{relationCountLabel}</span>
          </div>

          {loading ? (
            <div className="empty">{t('relationManager.loading')}</div>
          ) : relations.length === 0 ? (
            <div className="empty">{t('relationManager.empty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {relations.map(relation => (
                <div key={relation.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                        <span className="badge" style={{ background: 'rgba(59,130,246,0.15)', color: '#60a5fa' }}>{relation.subject_key}</span>
                        <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>{relation.predicate}</span>
                        <span className="badge" style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>{relation.object_key}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {t('relationManager.meta', {
                          agent: formatAgentNameLabel(t, relation.agent_id),
                          confidence: relation.confidence.toFixed(2),
                          updated: toLocal(relation.updated_at),
                        })}
                      </div>
                    </div>
                    <button className="btn" onClick={() => handleDeleteRelation(relation.id)}>{t('common.delete')}</button>
                  </div>

                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                    <div><strong>{t('relationManager.sourceRecord')}:</strong> {relation.source_record_id}</div>
                    {relation.source_record && (
                      <div style={{ marginTop: 4, color: 'var(--text)' }}>
                        [{formatRecordKindLabel(t, relation.source_record.kind)}] {relation.source_record.content}
                      </div>
                    )}
                    {relation.source_evidence && (
                      <div style={{ marginTop: 6 }}>
                        <strong>{t('relationManager.evidence')}:</strong> [{relation.source_evidence.role}] {relation.source_evidence.content}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

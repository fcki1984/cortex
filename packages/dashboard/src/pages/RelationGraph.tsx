import React, { useEffect, useState } from 'react';
import { createRelationV2, deleteRelationV2, listAgents, listRelationsV2 } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';

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

export default function RelationGraph() {
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

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listRelationsV2(agentId ? { agent_id: agentId, limit: '200' } : { limit: '200' });
      setRelations(res.items || []);
    } catch (e: any) {
      setError(e.message || 'Failed to load relations');
      setRelations([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    listAgents().then((res: any) => setAgents(res.agents || res || [])).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [agentId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.source_record_id.trim() || !form.subject_key.trim() || !form.predicate.trim() || !form.object_key.trim()) return;
    setCreating(true);
    setError('');
    try {
      await createRelationV2({
        agent_id: agentId || undefined,
        source_record_id: form.source_record_id.trim(),
        subject_key: form.subject_key.trim(),
        predicate: form.predicate.trim(),
        object_key: form.object_key.trim(),
        confidence: Number(form.confidence) || 0.8,
      });
      setForm({ source_record_id: '', subject_key: '', predicate: '', object_key: '', confidence: '0.8' });
      await load();
    } catch (e: any) {
      setError(e.message || 'Failed to create relation');
    }
    setCreating(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this relation?')) return;
    await deleteRelationV2(id);
    await load();
  };

  return (
    <div>
      <h1 className="page-title">{t('nav.relations')}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>V2 relations are traceable to source records and evidence.</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>They are for audit and explainability, not online graph traversal.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Agent</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
              <option value="">All</option>
              {agents.map((agent: any) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
            </select>
          </div>
        </div>
      </div>

      <form className="card" onSubmit={handleCreate} style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>Create V2 Relation</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <input
            placeholder="source_record_id"
            value={form.source_record_id}
            onChange={e => setForm(prev => ({ ...prev, source_record_id: e.target.value }))}
          />
          <input
            placeholder="subject_key"
            value={form.subject_key}
            onChange={e => setForm(prev => ({ ...prev, subject_key: e.target.value }))}
          />
          <input
            placeholder="predicate"
            value={form.predicate}
            onChange={e => setForm(prev => ({ ...prev, predicate: e.target.value }))}
          />
          <input
            placeholder="object_key"
            value={form.object_key}
            onChange={e => setForm(prev => ({ ...prev, object_key: e.target.value }))}
          />
          <input
            placeholder="confidence"
            value={form.confidence}
            onChange={e => setForm(prev => ({ ...prev, confidence: e.target.value }))}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Use a source record id from the Memory Browser. The API will auto-link the latest evidence if available.
          </div>
          <button className="btn" type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create relation'}</button>
        </div>
        {error && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </form>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Relation List</h3>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{relations.length} relations</span>
        </div>

        {loading ? (
          <div className="empty">Loading...</div>
        ) : relations.length === 0 ? (
          <div className="empty">No V2 relations yet.</div>
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
                      Agent: {relation.agent_id} · Confidence: {relation.confidence.toFixed(2)} · Updated: {toLocal(relation.updated_at)}
                    </div>
                  </div>
                  <button className="btn" onClick={() => handleDelete(relation.id)}>Delete</button>
                </div>

                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                  <div><strong>Source record:</strong> {relation.source_record_id}</div>
                  {relation.source_record && (
                    <div style={{ marginTop: 4, color: 'var(--text)' }}>
                      [{relation.source_record.kind}] {relation.source_record.content}
                    </div>
                  )}
                  {relation.source_evidence && (
                    <div style={{ marginTop: 6 }}>
                      <strong>Evidence:</strong> [{relation.source_evidence.role}] {relation.source_evidence.content}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

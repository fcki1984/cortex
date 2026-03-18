import React, { useEffect, useState } from 'react';
import {
  createRecordV2,
  deleteRecordV2,
  listAgents,
  listRecordsV2,
  updateRecordV2,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';
import {
  formatAgentNameLabel,
  formatNormalizationLabel,
  formatReasonCodeLabel,
  formatRecordKindLabel,
  formatSourceTypeLabel,
} from '../utils/v2Display.js';

interface RecordItem {
  id: string;
  kind: 'profile_rule' | 'fact_slot' | 'task_state' | 'session_note';
  requested_kind?: 'profile_rule' | 'fact_slot' | 'task_state' | 'session_note';
  written_kind?: 'profile_rule' | 'fact_slot' | 'task_state' | 'session_note';
  normalization?: 'durable' | 'downgraded_to_session_note';
  reason_code?: string | null;
  source_type: string;
  content: string;
  tags: string[];
  agent_id: string;
  priority: number;
  updated_at: string;
  created_at: string;
}

const KINDS = ['profile_rule', 'fact_slot', 'task_state', 'session_note'];
const SOURCES = ['user_explicit', 'user_confirmed', 'assistant_inferred', 'system_derived'];

export default function MemoryBrowser() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [agentId, setAgentId] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RecordItem | null>(null);
  const [toast, setToast] = useState<string>('');
  const [draft, setDraft] = useState({
    kind: 'session_note',
    content: '',
    source_type: 'user_confirmed',
    priority: 0.8,
    tags: '',
  });
  const limit = 20;
  const { t } = useI18n();

  const load = async () => {
    setLoading(true);
    try {
      const res = await listRecordsV2({
        limit: String(limit),
        offset: String(page * limit),
        query: query || '',
        kind: kind || '',
        source_type: sourceType || '',
        agent_id: agentId || '',
        order_by: 'updated_at',
        order_dir: 'desc',
      });
      setRecords(res.items || []);
      setTotal(res.total || 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [page, kind, sourceType, agentId]);

  useEffect(() => {
    listAgents().then((res: any) => setAgents(res.agents || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleCreate = async () => {
    const result = await createRecordV2({
      kind: draft.kind,
      content: draft.content,
      source_type: draft.source_type,
      priority: draft.priority,
      tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean),
      agent_id: agentId || undefined,
    });
    setCreating(false);
    setDraft({ kind: 'session_note', content: '', source_type: 'user_confirmed', priority: 0.8, tags: '' });
    const requestedKind = formatRecordKindLabel(t, result.requested_kind || draft.kind);
    const writtenKind = formatRecordKindLabel(t, result.written_kind || result.record?.kind || draft.kind);
    const reason = result.reason_code ? t('memoryBrowser.reasonSuffix', { reason: formatReasonCodeLabel(t, result.reason_code) }) : '';
    setToast(t('memoryBrowser.toastCreated', { requested: requestedKind, written: writtenKind, reason }));
    await load();
  };

  const handleSave = async () => {
    if (!editing) return;
    await updateRecordV2(editing.id, {
      content: editing.content,
      source_type: editing.source_type,
      priority: editing.priority,
      tags: editing.tags,
    });
    setEditing(null);
    setToast(t('memoryBrowser.toastUpdated'));
    await load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('memories.confirmDelete'))) return;
    await deleteRecordV2(id);
    setToast(t('memoryBrowser.toastDeleted'));
    await load();
  };

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', top: 24, right: 24, zIndex: 100,
          background: 'var(--primary)', color: '#fff', padding: '10px 14px',
          borderRadius: 'var(--radius)', fontSize: 13,
        }}>
          {toast}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>{t('memories.title')} V2</h1>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            {t('memoryBrowser.subtitle')}
          </div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          {t('memories.newMemory')}
        </button>
      </div>

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setPage(0); load(); } }}
          placeholder={t('memories.searchPlaceholder')}
          style={{ minWidth: 240 }}
        />
        <button className="btn primary" onClick={() => { setPage(0); load(); }}>{t('common.search')}</button>
        <button className="btn" onClick={() => { setQuery(''); setPage(0); load(); }}>{t('common.clear')}</button>
      </div>

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <select value={kind} onChange={e => { setKind(e.target.value); setPage(0); }}>
          <option value="">{t('memoryBrowser.allKinds')}</option>
          {KINDS.map(item => <option key={item} value={item}>{formatRecordKindLabel(t, item)}</option>)}
        </select>
        <select value={sourceType} onChange={e => { setSourceType(e.target.value); setPage(0); }}>
          <option value="">{t('memoryBrowser.allSources')}</option>
          {SOURCES.map(item => <option key={item} value={item}>{formatSourceTypeLabel(t, item)}</option>)}
        </select>
        <select value={agentId} onChange={e => { setAgentId(e.target.value); setPage(0); }}>
          <option value="">{t('memoryBrowser.allAgents')}</option>
          {agents.map((agent: any) => <option key={agent.id} value={agent.id}>{formatAgentNameLabel(t, agent.id, agent.name)}</option>)}
        </select>
        <div style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: 13 }}>
          {t('memoryBrowser.totalRecords', { count: total })}
        </div>
      </div>

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : (
        <div className="card">
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnRequested')}</th>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnWritten')}</th>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnSource')}</th>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnContent')}</th>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnNormalization')}</th>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnTags')}</th>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnAgent')}</th>
                <th style={{ textAlign: 'left' }}>{t('memoryBrowser.columnUpdated')}</th>
                <th style={{ textAlign: 'right' }}>{t('memoryBrowser.columnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map(record => (
                <tr key={record.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 8px 10px 0' }}>
                    <span className="badge" style={{ background: 'rgba(96,165,250,0.16)', color: '#93c5fd' }}>
                      {formatRecordKindLabel(t, record.requested_kind || record.kind)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <span className="badge" style={{ background: 'rgba(34,197,94,0.16)', color: '#4ade80' }}>
                      {formatRecordKindLabel(t, record.written_kind || record.kind)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px' }}>{formatSourceTypeLabel(t, record.source_type)}</td>
                  <td style={{ padding: '10px 8px', maxWidth: 420 }}>
                    <div style={{ color: 'var(--text)', lineHeight: 1.5 }}>
                      {record.content}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                      {record.id}
                    </div>
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <div>{formatNormalizationLabel(t, record.normalization)}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                      {formatReasonCodeLabel(t, record.reason_code)}
                    </div>
                  </td>
                  <td style={{ padding: '10px 8px' }}>{record.tags.join(', ') || '—'}</td>
                  <td style={{ padding: '10px 8px' }}>{formatAgentNameLabel(t, record.agent_id || 'default', record.agent_id || 'default')}</td>
                  <td style={{ padding: '10px 8px' }}>{toLocal(record.updated_at || record.created_at)}</td>
                  <td style={{ padding: '10px 0 10px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn" onClick={() => setEditing(record)}>{t('common.edit')}</button>
                    <button className="btn" style={{ marginLeft: 6 }} onClick={() => handleDelete(record.id)}>{t('common.delete')}</button>
                  </td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                    {t('common.noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('common.prev')}</button>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {t('common.page', { current: page + 1, total: Math.max(1, Math.ceil(total / limit)) })}
        </div>
        <button className="btn" disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)}>{t('common.next')}</button>
      </div>

      {(creating || editing) && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 120,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card" style={{ width: 680, maxWidth: '92vw' }}>
            <h3 style={{ marginTop: 0, marginBottom: 16 }}>{creating ? t('memoryBrowser.createTitle') : t('memoryBrowser.editTitle')}</h3>
            <div className="form-group">
              <label>{t('memoryBrowser.kindLabel')}</label>
              <select
                value={creating ? draft.kind : editing?.kind}
                onChange={e => creating
                  ? setDraft({ ...draft, kind: e.target.value })
                  : editing && setEditing({ ...editing, kind: e.target.value as RecordItem['kind'] })
                }
                disabled={!!editing}
              >
                {KINDS.map(item => <option key={item} value={item}>{formatRecordKindLabel(t, item)}</option>)}
              </select>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                {t('memoryBrowser.kindHint')}
              </div>
            </div>
            <div className="form-group">
              <label>{t('memoryBrowser.sourceTypeLabel')}</label>
              <select
                value={creating ? draft.source_type : editing?.source_type}
                onChange={e => creating
                  ? setDraft({ ...draft, source_type: e.target.value })
                  : editing && setEditing({ ...editing, source_type: e.target.value })
                }
              >
                {SOURCES.map(item => <option key={item} value={item}>{formatSourceTypeLabel(t, item)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>{t('memoryBrowser.columnContent')}</label>
              <textarea
                rows={6}
                value={creating ? draft.content : editing?.content}
                onChange={e => creating
                  ? setDraft({ ...draft, content: e.target.value })
                  : editing && setEditing({ ...editing, content: e.target.value })
                }
              />
            </div>
            <div className="form-group">
              <label>{t('memoryBrowser.tagsLabel')}</label>
              <input
                value={creating ? draft.tags : (editing?.tags || []).join(', ')}
                onChange={e => creating
                  ? setDraft({ ...draft, tags: e.target.value })
                  : editing && setEditing({ ...editing, tags: e.target.value.split(',').map(tag => tag.trim()).filter(Boolean) })
                }
              />
            </div>
            <div className="form-group">
              <label>{t('memoryBrowser.priorityLabel', { value: (creating ? draft.priority : editing?.priority || 0).toFixed(2) })}</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={creating ? draft.priority : editing?.priority}
                onChange={e => creating
                  ? setDraft({ ...draft, priority: parseFloat(e.target.value) })
                  : editing && setEditing({ ...editing, priority: parseFloat(e.target.value) })
                }
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => { setCreating(false); setEditing(null); }}>{t('common.cancel')}</button>
              <button
                className="btn primary"
                onClick={() => creating ? handleCreate() : handleSave()}
                disabled={creating ? !draft.content.trim() : !editing?.content.trim()}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { getLifecycleLogsV2, listAgents, previewLifecycleV2, runLifecycleV2 } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';
import { formatAgentNameLabel, formatLifecycleStateLabel } from '../utils/v2Display.js';

type LifecyclePreviewNote = {
  id: string;
  summary: string;
  session_id?: string | null;
  expires_at?: string | null;
  lifecycle_state: 'active' | 'dormant' | 'stale';
  retired_at?: string | null;
  purge_after?: string | null;
};

function NoteList({
  title,
  notes,
  t,
}: {
  title: string;
  notes: LifecyclePreviewNote[];
  t: (key: string, params?: any) => string;
}) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 12 }}>{title}</h3>
      {notes.length === 0 ? (
        <div className="empty">{t('common.noData')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {notes.map(note => (
            <div key={note.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('lifecycle.sessionSummary', {
                    session: note.session_id || t('lifecycle.global'),
                    state: formatLifecycleStateLabel(t, note.lifecycle_state),
                  })}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{note.id}</div>
              </div>
              <div style={{ color: 'var(--text)', marginBottom: 8 }}>{note.summary}</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
                {note.expires_at && <span>{t('lifecycle.expiresAt')}: {toLocal(note.expires_at)}</span>}
                {note.retired_at && <span>{t('lifecycle.retiredAt')}: {toLocal(note.retired_at)}</span>}
                {note.purge_after && <span>{t('lifecycle.purgeAfter')}: {toLocal(note.purge_after)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LifecycleMonitor() {
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();

  const refresh = async () => {
    setLoading(true);
    try {
      const [previewRes, logRes] = await Promise.all([
        previewLifecycleV2(agentId || undefined),
        getLifecycleLogsV2(50, agentId || undefined, 0),
      ]);
      setPreview(previewRes);
      setLogs(logRes.items || []);
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

  const handleRun = async () => {
    setRunning(true);
    try {
      await runLifecycleV2(agentId || undefined);
      await refresh();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">{t('nav.lifecycle')}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>{t('lifecycle.subtitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('lifecycle.noteOnlyHint')}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('lifecycle.agent')}</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
              <option value="">{t('lifecycle.allAgents')}</option>
              {agents.map((agent: any) => (
                <option key={agent.id} value={agent.id}>
                  {formatAgentNameLabel(t, agent.id, agent.name)}
                </option>
              ))}
            </select>
            <button className="btn" onClick={refresh} disabled={loading}>{loading ? t('lifecycle.refreshing') : t('lifecycle.refresh')}</button>
            <button className="btn" onClick={handleRun} disabled={running}>{running ? t('lifecycle.running') : t('lifecycle.runNow')}</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.active_notes ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('lifecycle.activeNotes')}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.dormant_candidates ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('lifecycle.dormantCandidates')}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.stale_candidates ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('lifecycle.staleCandidates')}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.purge_candidates ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('lifecycle.purgeCandidates')}</div>
        </div>
      </div>

      <NoteList title={t('lifecycle.dormantTitle')} notes={preview?.dormant_candidates || []} t={t} />
      <NoteList title={t('lifecycle.staleTitle')} notes={preview?.stale_candidates || []} t={t} />
      <NoteList title={t('lifecycle.purgeTitle')} notes={preview?.purge_candidates || []} t={t} />

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('lifecycle.logTitle')}</h3>
        {logs.length === 0 ? (
          <div className="empty">{t('lifecycle.noEntries')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {logs.map((log: any) => {
              let details: any = {};
              try {
                details = log.details ? JSON.parse(log.details) : {};
              } catch {
                details = {};
              }
              return (
                <div key={`${log.id}-${log.executed_at}`} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                    <strong>{t(`lifecycle.logAction.${log.action}`)}</strong>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{toLocal(log.executed_at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('lifecycle.logSummary', {
                      agent: details.agent_id || t('lifecycle.global'),
                      retired: details.retired_notes ?? 0,
                      staled: details.staled_notes ?? 0,
                      purged: details.purged_notes ?? 0,
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

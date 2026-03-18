import React, { useEffect, useState } from 'react';
import { getLifecycleLogsV2, listAgents, previewLifecycleV2, runLifecycleV2 } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';

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
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>V2 lifecycle only maintains session notes.</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Facts, rules, and task states are not archived or decayed here.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Agent</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
              <option value="">All</option>
              {agents.map((agent: any) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
            </select>
            <button className="btn" onClick={refresh} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
            <button className="btn" onClick={handleRun} disabled={running}>{running ? 'Running...' : 'Run maintenance'}</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.active_notes ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Active session notes</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.expire_count ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Expired note candidates</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.compression_groups ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Compression groups</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{preview?.summary?.notes_to_compress ?? 0}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Notes to compress</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>Compression Preview</h3>
        {!preview?.compression_candidates?.length ? (
          <div className="empty">No compression candidates.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {preview.compression_candidates.map((candidate: any, index: number) => (
              <div key={`${candidate.session_id || 'global'}-${index}`} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  Session: {candidate.session_id || 'global'} · {candidate.note_ids.length} notes
                </div>
                <div style={{ marginBottom: 8, color: 'var(--text)' }}>{candidate.replacement_summary}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{candidate.summaries.join(' | ')}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Lifecycle Log</h3>
        {logs.length === 0 ? (
          <div className="empty">No V2 lifecycle entries.</div>
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
                    <strong>{log.action}</strong>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{toLocal(log.executed_at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Agent: {details.agent_id || 'all'} · Expired: {details.expired_notes ?? 0} · Compressed: {details.compressed_notes ?? details.compressed_count ?? 0} · Written: {details.written_notes ?? 0}
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

import React, { useEffect, useRef, useState } from 'react';
import { getStatsV2, getHealth, getComponentHealth, testConnections, recallV2, listAgents } from '../api/client.js';
import { useI18n } from '../i18n/index.js';

function fmtNum(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10_000) return (n / 10_000).toFixed(1).replace(/\.0$/, '') + '万';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function timeAgo(dateStr: string, future = false): string {
  const diff = future ? new Date(dateStr).getTime() - Date.now() : Date.now() - new Date(dateStr).getTime();
  const abs = Math.abs(diff);
  if (abs < 60_000) return future ? '即将' : '刚刚';
  if (abs < 3_600_000) return Math.floor(abs / 60_000) + '分钟' + (future ? '后' : '前');
  if (abs < 86_400_000) return Math.floor(abs / 3_600_000) + '小时' + (future ? '后' : '前');
  return Math.floor(abs / 86_400_000) + '天' + (future ? '后' : '前');
}

function BarChart({ data, colors, height = 220 }: { data: { label: string; value: number }[]; colors: string[]; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const max = Math.max(...data.map(d => d.value), 1);
    const barW = Math.min(60, (W - 40) / data.length - 10);
    const startX = (W - data.length * (barW + 10) + 10) / 2;

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 20 + (H - 90) * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.lineTo(W - 10, y);
      ctx.stroke();
      ctx.fillStyle = '#71717a';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(max * i / 4)), 26, y + 3);
    }

    data.forEach((d, i) => {
      const x = startX + i * (barW + 10);
      const barH = (d.value / max) * (H - 90);
      const y = H - 70 - barH;
      const color = colors[i % colors.length]!;
      const grad = ctx.createLinearGradient(x, y, x, H - 70);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color + '44');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
      ctx.fill();

      ctx.fillStyle = '#e4e4e7';
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(d.value), x + barW / 2, y - 6);

      ctx.fillStyle = '#71717a';
      ctx.font = '10px system-ui';
      ctx.save();
      ctx.translate(x + barW / 2, H - 18);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.fillText(d.label, 0, 0);
      ctx.restore();
    });
  }, [data, colors, height]);

  return <canvas ref={canvasRef} style={{ width: '100%', height }} />;
}

function DistributionBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const { t } = useI18n();
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('common.noData')}</div>;
  return (
    <div>
      <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
        {segments.map((seg) => (
          <div
            key={seg.label}
            style={{
              width: `${(seg.value / total) * 100}%`,
              background: seg.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 600,
              color: '#fff',
              minWidth: seg.value > 0 ? 24 : 0,
            }}
          >
            {seg.value > 0 && ((seg.value / total) > 0.08 ? seg.value : '')}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {segments.map((seg) => (
          <div key={seg.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: seg.color }} />
            <span style={{ color: 'var(--text-muted)' }}>{seg.label}</span>
            <span style={{ fontWeight: 600 }}>{seg.value}</span>
            <span style={{ color: 'var(--text-muted)' }}>({((seg.value / total) * 100).toFixed(1)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecallSection({ title, items, color }: { title: string; items: any[]; color: string }) {
  const { t } = useI18n();
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: 12, border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <span className="badge" style={{ background: color, color: '#fff' }}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('common.noData')}</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((item: any) => (
            <div key={item.id} style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ color: 'var(--text)' }}>{item.content}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {item.source_type} · {item.kind}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Stats() {
  const [stats, setStats] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [components, setComponents] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [connTest, setConnTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [recallQuery, setRecallQuery] = useState('');
  const [recallResults, setRecallResults] = useState<any>(null);
  const [recalling, setRecalling] = useState(false);
  const [recallAgent, setRecallAgent] = useState('');
  const { t } = useI18n();

  useEffect(() => {
    Promise.all([getStatsV2(), getHealth(), listAgents()])
      .then(([s, h, agentRes]) => {
        setStats(s);
        setHealth(h);
        const list = agentRes.agents || [];
        setAgents(list);
        if (list.length > 0) setRecallAgent((current) => current || list[0].id);
      })
      .catch((e) => setError(e.message));

    getComponentHealth().then((r: any) => setComponents(r.components || [])).catch(() => {});
  }, []);

  if (error) return <div className="card" style={{ color: 'var(--danger)' }}>{t('common.errorPrefix', { message: error })}</div>;
  if (!stats) return <div className="loading">{t('common.loading')}</div>;

  const kindMap = stats.distributions?.kinds || {};
  const sourceMap = stats.distributions?.sources || {};
  const kindColors: Record<string, string> = {
    profile_rule: '#3b82f6',
    fact_slot: '#22c55e',
    task_state: '#f59e0b',
    session_note: '#a855f7',
  };
  const sourceColors: Record<string, string> = {
    user_explicit: '#3b82f6',
    user_confirmed: '#22c55e',
    assistant_inferred: '#f59e0b',
    system_derived: '#a855f7',
  };

  const kindSegments = Object.entries(kindMap).map(([label, value]) => ({
    label,
    value: value as number,
    color: kindColors[label] || '#71717a',
  }));
  const sourceData = Object.entries(sourceMap).map(([label, value]) => ({ label, value: value as number }));
  const agentData = (stats.agents || []).map((item: any) => ({ label: item.agent_id, value: item.active_records }));

  const formatUptime = (seconds: number) => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0 }}>{t('stats.title')}</h1>
        <span className="badge" style={{ background: stats.runtime?.legacy_mode ? 'rgba(245,158,11,0.2)' : 'rgba(34,197,94,0.18)', color: stats.runtime?.legacy_mode ? '#fbbf24' : '#4ade80' }}>
          {stats.runtime?.legacy_mode ? t('stats.legacyModeOn') : t('stats.legacyModeOff')}
        </span>
      </div>

      <div className="card-grid">
        <div className="stat-card">
          <div className="label">{t('stats.activeRecords')}</div>
          <div className="value">{fmtNum(stats.totals?.active_records || 0)}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.inactiveRecords')}</div>
          <div className="value" style={{ color: '#a1a1aa' }}>{fmtNum(stats.totals?.inactive_records || 0)}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.profileRules')}</div>
          <div className="value" style={{ color: '#60a5fa' }}>{kindMap.profile_rule || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.factSlots')}</div>
          <div className="value" style={{ color: '#4ade80' }}>{kindMap.fact_slot || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.taskStates')}</div>
          <div className="value" style={{ color: '#fbbf24' }}>{kindMap.task_state || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.sessionNotes')}</div>
          <div className="value" style={{ color: '#c084fc' }}>{kindMap.session_note || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.totalAgents')}</div>
          <div className="value">{fmtNum(stats.totals?.total_agents || 0)}</div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('stats.recordKinds')}</h3>
        <DistributionBar segments={kindSegments} />
      </div>

      {sourceData.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('stats.sourceTypes')}</h3>
          <BarChart data={sourceData} colors={Object.keys(sourceMap).map(key => sourceColors[key] || '#71717a')} height={180} />
        </div>
      )}

      {agentData.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('stats.topAgents')}</h3>
          <BarChart data={agentData} colors={['#3b82f6', '#22c55e', '#f59e0b', '#a855f7']} height={180} />
        </div>
      )}

      {health && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('stats.systemHealth')}</h3>
          <table>
            <tbody>
              <tr><td>{t('stats.status')}</td><td><span style={{ color: health.status === 'ok' ? 'var(--success)' : 'var(--danger)' }}>● {health.status}</span></td></tr>
              <tr><td>{t('stats.version')}</td><td>{health.version}</td></tr>
              <tr><td>{t('stats.uptime')}</td><td>{formatUptime(health.uptime)}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {components.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>{t('stats.componentStatus')}</h3>
            <button
              onClick={async () => {
                setTesting(true);
                setConnTest(null);
                try {
                  setConnTest(await testConnections());
                } catch (e: any) {
                  setConnTest({ _error: e.message });
                }
                setTesting(false);
              }}
              disabled={testing}
              style={{ fontSize: 11, padding: '4px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', color: 'var(--text)' }}
            >
              {testing ? t('stats.testingConnections') : t('stats.testConnections')}
            </button>
          </div>
          {connTest && !connTest._error && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              {Object.entries(connTest).map(([key, val]: [string, any]) => (
                <div key={key} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, background: val.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${val.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                  <span style={{ fontWeight: 600 }}>{key.toUpperCase()}</span>{' '}
                  {val.ok ? `✅ ${val.latencyMs}ms` : `❌ ${val.error || 'failed'}`}
                </div>
              ))}
            </div>
          )}
          {connTest?._error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>❌ {connTest._error}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {components.map((c: any) => {
              const statusColor = c.status === 'ok' ? '#22c55e' : c.status === 'warning' ? '#f59e0b' : c.status === 'error' ? '#ef4444' : c.status === 'stopped' ? '#ef4444' : '#71717a';
              const statusLabel = c.status === 'ok' ? '✅ OK' : c.status === 'warning' ? '⚠️ Warning' : c.status === 'error' ? '❌ Error' : c.status === 'stopped' ? '⏹ Stopped' : '⚙️ Idle';
              const ago = c.lastRun ? timeAgo(c.lastRun) : null;
              return (
                <div key={c.id} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                    <span style={{ color: statusColor, fontSize: 12, fontWeight: 600 }}>{statusLabel}</span>
                  </div>
                  {ago && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('stats.lastRun')}: {ago}</div>}
                  {c.latencyMs != null && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('stats.latency')}: {c.latencyMs}ms</div>}
                  {c.details && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {c.id === 'scheduler' && c.details.nextRun ? `${t('stats.nextRun')}: ${timeAgo(c.details.nextRun, true)}` : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>🔍 {t('stats.recallTester')}</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <select
            value={recallAgent}
            onChange={e => setRecallAgent(e.target.value)}
            style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: 'auto', maxWidth: 180, flexShrink: 0 }}
          >
            {agents.map((a: any) => (
              <option key={a.id} value={a.id}>{a.name || a.id}</option>
            ))}
          </select>
          <input
            type="text"
            value={recallQuery}
            onChange={e => setRecallQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && recallQuery.trim()) {
                setRecalling(true);
                recallV2({ query: recallQuery, agent_id: recallAgent || undefined })
                  .then((r: any) => setRecallResults(r))
                  .catch(() => setRecallResults({ rules: [], facts: [], task_state: [], session_notes: [], meta: {} }))
                  .finally(() => setRecalling(false));
              }
            }}
            placeholder={t('stats.recallPlaceholder')}
            style={{ flex: 1, fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
          />
          <button
            disabled={recalling || !recallQuery.trim()}
            onClick={async () => {
              setRecalling(true);
              try {
                const r = await recallV2({ query: recallQuery, agent_id: recallAgent || undefined });
                setRecallResults(r);
              } catch {
                setRecallResults({ rules: [], facts: [], task_state: [], session_notes: [], meta: {} });
              }
              setRecalling(false);
            }}
            style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', background: 'var(--primary)', color: '#fff', border: 'none', flexShrink: 0 }}
          >
            {recalling ? '...' : t('common.search')}
          </button>
        </div>

        {recallResults && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>{t('stats.recallFound', { total: recallResults.meta?.total_candidates || 0 })}</span>
              <span>{t('stats.recallInjected', { count: recallResults.meta?.injected_count || 0 })}</span>
              <span>⏱ {recallResults.meta?.latency_ms || 0}ms</span>
              {recallResults.meta?.reason && <span>{t('stats.recallReason', { reason: recallResults.meta.reason })}</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <RecallSection title={t('stats.rulesSection')} items={recallResults.rules || []} color="#3b82f6" />
              <RecallSection title={t('stats.factsSection')} items={recallResults.facts || []} color="#22c55e" />
              <RecallSection title={t('stats.taskStateSection')} items={recallResults.task_state || []} color="#f59e0b" />
              <RecallSection title={t('stats.sessionNotesSection')} items={recallResults.session_notes || []} color="#a855f7" />
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: 12, border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('stats.contextPreview')}</div>
              <pre className="json-debug" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{recallResults.context || ''}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

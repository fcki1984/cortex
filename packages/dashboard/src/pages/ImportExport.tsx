import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  confirmImportV2,
  exportBundleV2,
  listAgents,
  previewImportV2,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import {
  formatAgentNameLabel,
  formatReasonCodeLabel,
  formatRecordKindLabel,
  formatSourceTypeLabel,
} from '../utils/v2Display.js';

type AgentRecord = {
  id: string;
  name?: string | null;
  description?: string | null;
};

type ImportFormat = 'json' | 'memory_md' | 'text';
type ExportFormat = 'json' | 'memory_md';
type ExportScope = 'current_agent' | 'all_agents';
type RecordKind = 'profile_rule' | 'fact_slot' | 'task_state' | 'session_note';
type SourceType = 'user_explicit' | 'user_confirmed' | 'assistant_inferred' | 'system_derived';
type LifecycleState = 'active' | 'dormant' | 'stale';
type RelationMode = 'candidate' | 'confirmed_restore';

type RecordCandidate = {
  candidate_id: string;
  selected: boolean;
  requested_kind: RecordKind;
  normalized_kind: RecordKind;
  content: string;
  source_type: SourceType;
  tags: string[];
  priority: number;
  confidence: number;
  owner_scope?: 'user' | 'agent';
  subject_key?: string;
  attribute_key?: string;
  entity_key?: string;
  state_key?: string;
  status?: string;
  session_id?: string | null;
  expires_at?: string | null;
  lifecycle_state?: LifecycleState;
  retired_at?: string | null;
  purge_after?: string | null;
  source_excerpt: string;
  warnings: string[];
};

type RelationCandidate = {
  candidate_id: string;
  selected: boolean;
  source_candidate_id?: string;
  subject_key: string;
  predicate: string;
  object_key: string;
  source_excerpt: string;
  confidence: number;
  mode: RelationMode;
  warnings: string[];
};

type PreviewResponse = {
  record_candidates: RecordCandidate[];
  relation_candidates: RelationCandidate[];
  warnings: string[];
  stats: {
    format: ImportFormat;
    total_segments: number;
    record_candidates: number;
    relation_candidates: number;
  };
};

type ConfirmResponse = {
  summary: {
    committed: number;
    skipped: number;
    failed: number;
    relation_candidates_created: number;
    confirmed_relations_restored: number;
  };
  committed: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  failed: Array<Record<string, unknown>>;
};

const RECORD_KIND_OPTIONS: RecordKind[] = ['profile_rule', 'fact_slot', 'task_state', 'session_note'];

function guessImportFormat(filename: string): ImportFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'memory_md';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}

function downloadFile(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
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

export default function ImportExport() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [importAgentId, setImportAgentId] = useState('');
  const [exportAgentId, setExportAgentId] = useState('');
  const [importFormat, setImportFormat] = useState<ImportFormat>('json');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('json');
  const [exportScope, setExportScope] = useState<ExportScope>('current_agent');
  const [sourceContent, setSourceContent] = useState('');
  const [sourceFilename, setSourceFilename] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [confirmResult, setConfirmResult] = useState<ConfirmResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const fileInputId = useId();

  useEffect(() => {
    listAgents()
      .then((response: any) => {
        const nextAgents = (response.agents || response || []) as AgentRecord[];
        setAgents(nextAgents);
        if (nextAgents.length > 0) {
          setImportAgentId((current) => current || nextAgents[0].id);
          setExportAgentId((current) => current || nextAgents[0].id);
        }
      })
      .catch((error: Error) => {
        setNotice({ message: error.message, type: 'error' });
      });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    setPreview(null);
    setConfirmResult(null);
  }, [importAgentId, importFormat, sourceContent, sourceFilename]);

  const selectedRecordCount = useMemo(
    () => preview?.record_candidates.filter((candidate) => candidate.selected).length || 0,
    [preview],
  );
  const selectedRelationCount = useMemo(
    () => preview?.relation_candidates.filter((candidate) => candidate.selected).length || 0,
    [preview],
  );

  const setRecordCandidate = (candidateId: string, updater: (candidate: RecordCandidate) => RecordCandidate) => {
    setPreview((current) => {
      if (!current) return current;
      return {
        ...current,
        record_candidates: current.record_candidates.map((candidate) => (
          candidate.candidate_id === candidateId ? updater(candidate) : candidate
        )),
      };
    });
  };

  const setRelationCandidate = (candidateId: string, updater: (candidate: RelationCandidate) => RelationCandidate) => {
    setPreview((current) => {
      if (!current) return current;
      return {
        ...current,
        relation_candidates: current.relation_candidates.map((candidate) => (
          candidate.candidate_id === candidateId ? updater(candidate) : candidate
        )),
      };
    });
  };

  const removeRecordCandidate = (candidateId: string) => {
    setPreview((current) => {
      if (!current) return current;
      return {
        ...current,
        record_candidates: current.record_candidates.filter((candidate) => candidate.candidate_id !== candidateId),
        relation_candidates: current.relation_candidates.filter((candidate) => candidate.source_candidate_id !== candidateId),
      };
    });
  };

  const removeRelationCandidate = (candidateId: string) => {
    setPreview((current) => {
      if (!current) return current;
      return {
        ...current,
        relation_candidates: current.relation_candidates.filter((candidate) => candidate.candidate_id !== candidateId),
      };
    });
  };

  const handleSourceFile = async (file: File | null) => {
    if (!file) return;
    const content = await file.text();
    const guessedFormat = guessImportFormat(file.name);
    if (guessedFormat) setImportFormat(guessedFormat);
    setSourceFilename(file.name);
    setSourceContent(content);
    setNotice({ message: t('importExport.fileLoaded', { filename: file.name }), type: 'success' });
  };

  const handlePreview = async () => {
    if (!importAgentId) {
      setNotice({ message: t('importExport.agentRequired'), type: 'error' });
      return;
    }
    if (!sourceContent.trim()) {
      setNotice({ message: t('importExport.contentRequired'), type: 'error' });
      return;
    }

    setPreviewing(true);
    setNotice(null);
    try {
      const response = await previewImportV2({
        agent_id: importAgentId,
        format: importFormat,
        content: sourceContent,
        filename: sourceFilename || undefined,
      });
      setPreview(response);
      setConfirmResult(null);
      setNotice({ message: t('importExport.previewReady'), type: 'success' });
    } catch (error: any) {
      setNotice({ message: error.message, type: 'error' });
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setConfirming(true);
    setNotice(null);
    try {
      const result = await confirmImportV2({
        agent_id: importAgentId,
        record_candidates: preview.record_candidates,
        relation_candidates: preview.relation_candidates,
      });
      setConfirmResult(result);
      setNotice({ message: t('importExport.confirmSuccess'), type: 'success' });
    } catch (error: any) {
      setNotice({ message: error.message, type: 'error' });
    } finally {
      setConfirming(false);
    }
  };

  const handleExport = async () => {
    if (exportScope === 'current_agent' && !exportAgentId) {
      setNotice({ message: t('importExport.agentRequired'), type: 'error' });
      return;
    }

    setExporting(true);
    setNotice(null);
    try {
      const result = await exportBundleV2({
        scope: exportScope,
        agent_id: exportScope === 'current_agent' ? exportAgentId : undefined,
        format: exportFormat,
      });
      const today = new Date().toISOString().slice(0, 10);
      const filename = exportFormat === 'json'
        ? `cortex-v2-export-${exportScope}-${today}.json`
        : `cortex-v2-export-${exportScope}-${today}.md`;
      if (exportFormat === 'json') {
        downloadFile(JSON.stringify(result, null, 2), filename, 'application/json');
      } else {
        downloadFile(result.content || '', filename, 'text/markdown;charset=utf-8');
      }
      setNotice({ message: t('importExport.exportReady'), type: 'success' });
    } catch (error: any) {
      setNotice({ message: error.message, type: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">{t('nav.importExport')}</h1>

      {notice && <Notice message={notice.message} type={notice.type} />}

      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === 'import' ? ' active' : ''}`}
          onClick={() => setTab('import')}
          style={{ background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}
        >
          {t('importExport.importTab')}
        </button>
        <button
          type="button"
          className={`tab${tab === 'export' ? ' active' : ''}`}
          onClick={() => setTab('export')}
          style={{ background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}
        >
          {t('importExport.exportTab')}
        </button>
      </div>

      {tab === 'import' ? (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>{t('importExport.importTitle')}</h3>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
              {t('importExport.importHint')}
            </p>
            <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
              {t('importExport.previewHint')}
            </p>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 12 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('importExport.targetAgent')}</label>
                <select value={importAgentId} onChange={(event) => setImportAgentId(event.target.value)}>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {formatAgentNameLabel(t, agent.id, agent.name)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('importExport.sourceFormat')}</label>
                <select value={importFormat} onChange={(event) => setImportFormat(event.target.value as ImportFormat)}>
                  <option value="json">JSON</option>
                  <option value="memory_md">MEMORY.md</option>
                  <option value="text">{t('importExport.formatText')}</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>{t('importExport.uploadOrPaste')}</label>
              <input
                id={fileInputId}
                type="file"
                accept=".json,.md,.markdown,.txt,text/plain,application/json"
                onChange={(event) => void handleSourceFile(event.target.files?.[0] || null)}
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: 'hidden',
                  clip: 'rect(0, 0, 0, 0)',
                  whiteSpace: 'nowrap',
                  border: 0,
                }}
              />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label htmlFor={fileInputId} className="btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                  {t('importExport.chooseFile')}
                </label>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {sourceFilename
                    ? t('importExport.fileSelected', { filename: sourceFilename })
                    : t('importExport.noFileChosen')}
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('importExport.fileHint')}
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>{t('importExport.sourceContent')}</label>
              <textarea
                value={sourceContent}
                onChange={(event) => {
                  setSourceFilename('');
                  setSourceContent(event.target.value);
                }}
                placeholder={t('importExport.sourcePlaceholder')}
                rows={12}
                style={{ width: '100%', resize: 'vertical' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('importExport.supportedFormats')}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn" onClick={() => {
                  setSourceFilename('');
                  setSourceContent('');
                  setPreview(null);
                  setConfirmResult(null);
                }}>
                  {t('common.clear')}
                </button>
                <button type="button" className="btn primary" onClick={handlePreview} disabled={previewing}>
                  {previewing ? t('importExport.previewing') : t('importExport.previewAction')}
                </button>
              </div>
            </div>
          </div>

          {preview && (
            <>
              <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ margin: 0 }}>{t('importExport.previewSection')}</h3>
                    <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                      {t('importExport.previewStats', {
                        records: preview.stats.record_candidates,
                        relations: preview.stats.relation_candidates,
                        segments: preview.stats.total_segments,
                      })}
                    </div>
                    <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
                      {t('importExport.selectedStats', {
                        records: selectedRecordCount,
                        relations: selectedRelationCount,
                      })}
                    </div>
                  </div>
                  <button type="button" className="btn primary" onClick={handleConfirm} disabled={confirming}>
                    {confirming ? t('importExport.confirming') : t('importExport.confirmAction')}
                  </button>
                </div>
                {preview.warnings.length > 0 && (
                  <div style={{ marginTop: 12, fontSize: 12, color: '#fbbf24' }}>
                    {preview.warnings.map((warning) => formatReasonCodeLabel(t, warning)).join(' · ')}
                  </div>
                )}
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <h3 style={{ marginTop: 0 }}>{t('importExport.recordCandidates')}</h3>
                {preview.record_candidates.length === 0 ? (
                  <div className="empty">{t('importExport.emptyRecords')}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {preview.record_candidates.map((candidate) => (
                      <div key={candidate.candidate_id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                              <input
                                type="checkbox"
                                checked={candidate.selected}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  selected: event.target.checked,
                                }))}
                              />
                              {t('importExport.includeCandidate')}
                            </label>
                            <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>
                              {formatRecordKindLabel(t, candidate.normalized_kind)}
                            </span>
                            <span className="badge" style={{ background: 'rgba(59,130,246,0.18)', color: '#93c5fd' }}>
                              {formatSourceTypeLabel(t, candidate.source_type)}
                            </span>
                          </div>
                          <button type="button" className="btn danger" onClick={() => removeRecordCandidate(candidate.candidate_id)}>
                            {t('importExport.removeCandidate')}
                          </button>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>{t('importExport.requestedKind')}</label>
                            <select
                              value={candidate.requested_kind}
                              onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                ...current,
                                requested_kind: event.target.value as RecordKind,
                              }))}
                            >
                              {RECORD_KIND_OPTIONS.map((kind) => (
                                <option key={kind} value={kind}>
                                  {formatRecordKindLabel(t, kind)}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>{t('importExport.priority')}</label>
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="0.05"
                              value={candidate.priority}
                              onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                ...current,
                                priority: Number(event.target.value) || 0,
                              }))}
                            />
                          </div>

                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>{t('importExport.confidence')}</label>
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="0.05"
                              value={candidate.confidence}
                              onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                ...current,
                                confidence: Number(event.target.value) || 0,
                              }))}
                            />
                          </div>
                        </div>

                        <div className="form-group">
                          <label>{t('importExport.contentLabel')}</label>
                          <textarea
                            value={candidate.content}
                            rows={3}
                            onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                              ...current,
                              content: event.target.value,
                            }))}
                            style={{ width: '100%', resize: 'vertical' }}
                          />
                        </div>

                        {candidate.requested_kind === 'profile_rule' && (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.subjectKey')}</label>
                              <input
                                value={candidate.subject_key || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  subject_key: event.target.value,
                                }))}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.attributeKey')}</label>
                              <input
                                value={candidate.attribute_key || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  attribute_key: event.target.value,
                                }))}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.ownerScope')}</label>
                              <select
                                value={candidate.owner_scope || 'user'}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  owner_scope: event.target.value as 'user' | 'agent',
                                }))}
                              >
                                <option value="user">{t('importExport.ownerScopeUser')}</option>
                                <option value="agent">{t('importExport.ownerScopeAgent')}</option>
                              </select>
                            </div>
                          </div>
                        )}

                        {candidate.requested_kind === 'fact_slot' && (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.entityKey')}</label>
                              <input
                                value={candidate.entity_key || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  entity_key: event.target.value,
                                }))}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.attributeKey')}</label>
                              <input
                                value={candidate.attribute_key || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  attribute_key: event.target.value,
                                }))}
                              />
                            </div>
                          </div>
                        )}

                        {candidate.requested_kind === 'task_state' && (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.subjectKey')}</label>
                              <input
                                value={candidate.subject_key || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  subject_key: event.target.value,
                                }))}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.stateKey')}</label>
                              <input
                                value={candidate.state_key || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  state_key: event.target.value,
                                }))}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.statusLabel')}</label>
                              <input
                                value={candidate.status || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  status: event.target.value,
                                }))}
                              />
                            </div>
                          </div>
                        )}

                        {candidate.requested_kind === 'session_note' && (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.sessionId')}</label>
                              <input
                                value={candidate.session_id || ''}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  session_id: event.target.value,
                                }))}
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                              <label>{t('importExport.lifecycleState')}</label>
                              <select
                                value={candidate.lifecycle_state || 'active'}
                                onChange={(event) => setRecordCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  lifecycle_state: event.target.value as LifecycleState,
                                }))}
                              >
                                <option value="active">{t('terms.lifecycleStates.active')}</option>
                                <option value="dormant">{t('terms.lifecycleStates.dormant')}</option>
                                <option value="stale">{t('terms.lifecycleStates.stale')}</option>
                              </select>
                            </div>
                          </div>
                        )}

                        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                          <div>
                            <strong>{t('importExport.sourceExcerpt')}:</strong> {candidate.source_excerpt || '—'}
                          </div>
                          {candidate.warnings.length > 0 && (
                            <div style={{ marginTop: 6, color: '#fbbf24' }}>
                              <strong>{t('importExport.warnings')}:</strong>{' '}
                              {candidate.warnings.map((warning) => formatReasonCodeLabel(t, warning)).join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <h3 style={{ marginTop: 0 }}>{t('importExport.relationCandidates')}</h3>
                {preview.relation_candidates.length === 0 ? (
                  <div className="empty">{t('importExport.emptyRelations')}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {preview.relation_candidates.map((candidate) => (
                      <div key={candidate.candidate_id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                              <input
                                type="checkbox"
                                checked={candidate.selected}
                                onChange={(event) => setRelationCandidate(candidate.candidate_id, (current) => ({
                                  ...current,
                                  selected: event.target.checked,
                                }))}
                              />
                              {t('importExport.includeCandidate')}
                            </label>
                            <span className="badge" style={{ background: 'rgba(168,85,247,0.18)', color: '#d8b4fe' }}>
                              {candidate.mode === 'confirmed_restore'
                                ? t('importExport.relationModeConfirmedRestore')
                                : t('importExport.relationModeCandidate')}
                            </span>
                          </div>
                          <button type="button" className="btn danger" onClick={() => removeRelationCandidate(candidate.candidate_id)}>
                            {t('importExport.removeCandidate')}
                          </button>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>{t('importExport.subjectKey')}</label>
                            <input
                              value={candidate.subject_key}
                              onChange={(event) => setRelationCandidate(candidate.candidate_id, (current) => ({
                                ...current,
                                subject_key: event.target.value,
                              }))}
                            />
                          </div>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>{t('importExport.predicate')}</label>
                            <input
                              value={candidate.predicate}
                              onChange={(event) => setRelationCandidate(candidate.candidate_id, (current) => ({
                                ...current,
                                predicate: event.target.value,
                              }))}
                            />
                          </div>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>{t('importExport.objectKey')}</label>
                            <input
                              value={candidate.object_key}
                              onChange={(event) => setRelationCandidate(candidate.candidate_id, (current) => ({
                                ...current,
                                object_key: event.target.value,
                              }))}
                            />
                          </div>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>{t('importExport.confidence')}</label>
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="0.05"
                              value={candidate.confidence}
                              onChange={(event) => setRelationCandidate(candidate.candidate_id, (current) => ({
                                ...current,
                                confidence: Number(event.target.value) || 0,
                              }))}
                            />
                          </div>
                        </div>

                        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                          <div>
                            <strong>{t('importExport.sourceExcerpt')}:</strong> {candidate.source_excerpt || '—'}
                          </div>
                          {candidate.warnings.length > 0 && (
                            <div style={{ marginTop: 6, color: '#fbbf24' }}>
                              <strong>{t('importExport.warnings')}:</strong> {candidate.warnings.map((warning) => formatReasonCodeLabel(t, warning)).join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {confirmResult && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>{t('importExport.resultTitle')}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
                <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('importExport.resultCommitted')}</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{confirmResult.summary.committed}</div>
                </div>
                <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('importExport.resultSkipped')}</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{confirmResult.summary.skipped}</div>
                </div>
                <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('importExport.resultFailed')}</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{confirmResult.summary.failed}</div>
                </div>
                <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('importExport.resultRelationCandidates')}</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{confirmResult.summary.relation_candidates_created}</div>
                </div>
                <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('importExport.resultRelationsRestored')}</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{confirmResult.summary.confirmed_relations_restored}</div>
                </div>
              </div>

              {confirmResult.failed.length > 0 && (
                <div>
                  <h4 style={{ marginBottom: 8 }}>{t('importExport.failedItems')}</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {confirmResult.failed.map((item, index) => (
                      <div key={`${String(item.candidate_id || 'failed')}-${index}`} style={{ fontSize: 12, color: '#fca5a5' }}>
                        {String(item.candidate_id || 'unknown')}: {String(item.error || t('common.error'))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>{t('importExport.exportTitle')}</h3>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
              {t('importExport.exportHint')}
            </p>
            <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
              {t('importExport.exportFormatHint')}
            </p>
          </div>

          <div className="card">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('importExport.exportScope')}</label>
                <select value={exportScope} onChange={(event) => setExportScope(event.target.value as ExportScope)}>
                  <option value="current_agent">{t('importExport.scopeCurrentAgent')}</option>
                  <option value="all_agents">{t('importExport.scopeAllAgents')}</option>
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('importExport.exportFormat')}</label>
                <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                  <option value="json">JSON</option>
                  <option value="memory_md">MEMORY.md</option>
                </select>
              </div>

              {exportScope === 'current_agent' && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>{t('importExport.currentAgent')}</label>
                  <select value={exportAgentId} onChange={(event) => setExportAgentId(event.target.value)}>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {formatAgentNameLabel(t, agent.id, agent.name)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('importExport.exportIncludes')}
              </div>
              <button type="button" className="btn primary" onClick={handleExport} disabled={exporting}>
                {exporting ? t('importExport.exporting') : t('importExport.exportAction')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { getConfig, updateConfig, testLLM, testEmbedding, testReranker, getLogLevel, setLogLevel as apiSetLogLevel } from '../../api/client.js';
import { useI18n } from '../../i18n/index.js';
import {
  SectionKey,
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  RERANKER_PROVIDERS,
  EMBEDDING_DIMENSIONS,
  CUSTOM_MODEL,
  ProviderPreset,
} from './types.js';
import LlmSection from './sections/LlmSection.js';
import DataManagement from './sections/DataManagement.js';
import AuthSection from './sections/AuthSection.js';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Settings() {
  const [config, setConfig] = useState<any>(null);
  const [error, setError] = useState('');
  const [editingSection, setEditingSection] = useState<SectionKey | null>(null);
  const [draft, setDraft] = useState<any>({});
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [testState, setTestState] = useState<Record<string, { status: 'idle' | 'testing' | 'success' | 'error'; message?: string; latency?: number }>>({});
  const [logLevel, setLogLevelState] = useState('info');
  const { t } = useI18n();

  useEffect(() => {
    getConfig().then(setConfig).catch((e: any) => setError(e.message));
    getLogLevel().then((res: any) => setLogLevelState(res.level)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const parseOptionalNumber = (value: any): number | undefined => {
    if (value === '' || value === null || value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const updateDraft = (path: string, value: any) => {
    setDraft((prev: any) => {
      const keys = path.split('.');
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const startEdit = (section: SectionKey) => {
    if (section !== 'llm') return;
    const nextDraft = {
      extraction: {
        provider: config.llm?.extraction?.provider ?? 'openai',
        model: config.llm?.extraction?.model ?? '',
        customModel: '',
        useCustomModel: false,
        apiKey: '',
        baseUrl: config.llm?.extraction?.baseUrl ?? '',
        timeoutMs: config.llm?.extraction?.timeoutMs ?? '',
        hasApiKey: config.llm?.extraction?.hasApiKey ?? false,
      },
      lifecycle: {
        provider: config.llm?.lifecycle?.provider ?? 'openai',
        model: config.llm?.lifecycle?.model ?? '',
        customModel: '',
        useCustomModel: false,
        apiKey: '',
        baseUrl: config.llm?.lifecycle?.baseUrl ?? '',
        timeoutMs: config.llm?.lifecycle?.timeoutMs ?? '',
        hasApiKey: config.llm?.lifecycle?.hasApiKey ?? false,
      },
      embedding: {
        provider: config.embedding?.provider ?? 'openai',
        model: config.embedding?.model ?? '',
        customModel: '',
        useCustomModel: false,
        dimensions: config.embedding?.dimensions ?? 1536,
        apiKey: '',
        baseUrl: config.embedding?.baseUrl ?? '',
        timeoutMs: config.embedding?.timeoutMs ?? '',
        hasApiKey: config.embedding?.hasApiKey ?? false,
      },
      reranker: {
        provider: config.search?.reranker?.provider ?? 'none',
        model: config.search?.reranker?.model ?? '',
        customModel: '',
        useCustomModel: false,
        apiKey: '',
        baseUrl: config.search?.reranker?.baseUrl ?? '',
        timeoutMs: config.search?.reranker?.timeoutMs ?? '',
        hasApiKey: config.search?.reranker?.hasApiKey ?? false,
      },
    };

    for (const key of ['extraction', 'lifecycle'] as const) {
      const provider = nextDraft[key].provider;
      const presets = LLM_PROVIDERS[provider]?.models ?? [];
      if (nextDraft[key].model && !presets.includes(nextDraft[key].model)) {
        nextDraft[key].useCustomModel = true;
        nextDraft[key].customModel = nextDraft[key].model;
      }
    }

    const embeddingPresets = EMBEDDING_PROVIDERS[nextDraft.embedding.provider]?.models ?? [];
    if (nextDraft.embedding.model && !embeddingPresets.includes(nextDraft.embedding.model)) {
      nextDraft.embedding.useCustomModel = true;
      nextDraft.embedding.customModel = nextDraft.embedding.model;
    }

    const rerankerPresets = RERANKER_PROVIDERS[nextDraft.reranker.provider]?.models ?? [];
    if (nextDraft.reranker.model && !rerankerPresets.includes(nextDraft.reranker.model)) {
      nextDraft.reranker.useCustomModel = true;
      nextDraft.reranker.customModel = nextDraft.reranker.model;
    }

    setDraft(nextDraft);
    setEditingSection(section);
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setDraft({});
  };

  const saveSection = async (section: SectionKey) => {
    if (section !== 'llm') return;

    for (const value of [draft.extraction?.timeoutMs, draft.lifecycle?.timeoutMs, draft.embedding?.timeoutMs, draft.reranker?.timeoutMs]) {
      if (value === '' || value === null || value === undefined) continue;
      const parsed = Number(value);
      if (Number.isNaN(parsed) || parsed < 500 || parsed > 120000) {
        setToast({ message: t('settings.validationTimeoutRange', { min: 500, max: 120000 }), type: 'error' });
        return;
      }
    }

    const buildProviderPayload = (value: any) => {
      const output: any = {
        provider: value.provider,
        model: value.useCustomModel ? value.customModel : value.model,
        baseUrl: value.baseUrl || '',
        timeoutMs: parseOptionalNumber(value.timeoutMs),
      };
      if (value.apiKey) output.apiKey = value.apiKey;
      return output;
    };

    const payload: any = {
      llm: {
        extraction: buildProviderPayload(draft.extraction),
        lifecycle: buildProviderPayload(draft.lifecycle),
      },
      embedding: {
        provider: draft.embedding.provider,
        model: draft.embedding.useCustomModel ? draft.embedding.customModel : draft.embedding.model,
        dimensions: Number(draft.embedding.dimensions),
        baseUrl: draft.embedding.baseUrl || '',
        timeoutMs: parseOptionalNumber(draft.embedding.timeoutMs),
        ...(draft.embedding.apiKey ? { apiKey: draft.embedding.apiKey } : {}),
      },
      search: {
        reranker: {
          ...(config.search?.reranker ?? {}),
          provider: draft.reranker.provider ?? 'none',
          ...(draft.reranker.useCustomModel ? { model: draft.reranker.customModel } : draft.reranker.model ? { model: draft.reranker.model } : {}),
          ...(draft.reranker.apiKey ? { apiKey: draft.reranker.apiKey } : {}),
          ...(draft.reranker.baseUrl ? { baseUrl: draft.reranker.baseUrl } : {}),
          timeoutMs: parseOptionalNumber(draft.reranker.timeoutMs),
        },
      },
    };

    try {
      await updateConfig(payload);
      const refreshed = await getConfig();
      setConfig(refreshed);
      setEditingSection(null);
      setDraft({});
      setToast({ message: t('settings.toastConfigSaved'), type: 'success' });
    } catch (e: any) {
      setToast({ message: t('settings.toastSaveFailed', { message: e.message }), type: 'error' });
    }
  };

  const handleTestLLM = async (target: 'extraction' | 'lifecycle') => {
    const key = `llm.${target}`;
    setTestState(prev => ({ ...prev, [key]: { status: 'testing' } }));
    try {
      const res = await testLLM(target);
      if (res.ok) {
        setTestState(prev => ({ ...prev, [key]: { status: 'success', latency: res.latency_ms } }));
      } else {
        setTestState(prev => ({ ...prev, [key]: { status: 'error', message: res.error || 'Unknown error' } }));
      }
    } catch (e: any) {
      setTestState(prev => ({ ...prev, [key]: { status: 'error', message: e.message } }));
    }
  };

  const handleTestEmbedding = async () => {
    setTestState(prev => ({ ...prev, embedding: { status: 'testing' } }));
    try {
      const res = await testEmbedding();
      if (res.ok) {
        setTestState(prev => ({ ...prev, embedding: { status: 'success', latency: res.latency_ms } }));
      } else {
        setTestState(prev => ({ ...prev, embedding: { status: 'error', message: res.error || 'Unknown error' } }));
      }
    } catch (e: any) {
      setTestState(prev => ({ ...prev, embedding: { status: 'error', message: e.message } }));
    }
  };

  const handleTestReranker = async () => {
    setTestState(prev => ({ ...prev, reranker: { status: 'testing' } }));
    try {
      const res = await testReranker();
      if (res.ok) {
        setTestState(prev => ({ ...prev, reranker: { status: 'success', latency: res.latency_ms } }));
      } else {
        setTestState(prev => ({ ...prev, reranker: { status: 'error', message: res.error || 'Unknown error' } }));
      }
    } catch (e: any) {
      setTestState(prev => ({ ...prev, reranker: { status: 'error', message: e.message } }));
    }
  };

  const sectionHeader = (title: string, section: SectionKey) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <h3>{title}</h3>
      {editingSection === section ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={cancelEdit}>{t('common.cancel')}</button>
          <button className="btn primary" onClick={() => saveSection(section)}>{t('common.save')}</button>
        </div>
      ) : (
        <button className="btn" onClick={() => startEdit(section)} disabled={editingSection !== null}>
          {t('common.edit')}
        </button>
      )}
    </div>
  );

  const fieldDesc = (text: string) => (
    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{text}</div>
  );

  const renderProviderBlock = (title: string, prefix: string, providerMap: Record<string, ProviderPreset>) => {
    let value: any = draft;
    for (const key of prefix.split('.')) value = value?.[key];
    if (!value) return null;

    const provider = value.provider ?? 'openai';
    const preset = providerMap[provider];
    const models = preset?.models ?? [];
    const isCustomModel = value.useCustomModel;
    const isDisabled = provider === 'none';
    const timeoutDesc = prefix === 'reranker'
      ? t('settings.providerTimeoutRerankerDesc')
      : t('settings.providerTimeoutDesc');

    const handleProviderChange = (nextProvider: string) => {
      updateDraft(`${prefix}.provider`, nextProvider);
      const nextPreset = providerMap[nextProvider];
      const firstModel = nextPreset?.models?.[0] ?? '';
      updateDraft(`${prefix}.model`, firstModel);
      updateDraft(`${prefix}.useCustomModel`, false);
      updateDraft(`${prefix}.customModel`, '');
      updateDraft(`${prefix}.baseUrl`, '');
      if (value.dimensions !== undefined && firstModel && EMBEDDING_DIMENSIONS[firstModel]) {
        updateDraft(`${prefix}.dimensions`, EMBEDDING_DIMENSIONS[firstModel]);
      }
    };

    const handleModelSelectChange = (nextModel: string) => {
      if (nextModel === CUSTOM_MODEL) {
        updateDraft(`${prefix}.useCustomModel`, true);
        updateDraft(`${prefix}.customModel`, value.model ?? '');
        return;
      }

      updateDraft(`${prefix}.useCustomModel`, false);
      updateDraft(`${prefix}.model`, nextModel);
      if (value.dimensions !== undefined && EMBEDDING_DIMENSIONS[nextModel]) {
        updateDraft(`${prefix}.dimensions`, EMBEDDING_DIMENSIONS[nextModel]);
      }
    };

    return (
      <div style={{ marginBottom: 20, padding: 16, background: 'var(--bg)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
          {title}
        </div>

        <div className="form-group">
          <label>{t('settings.provider')}</label>
          <select value={provider} onChange={e => handleProviderChange(e.target.value)}>
            {Object.entries(providerMap).map(([key, item]) => (
              <option key={key} value={key}>{item.label}</option>
            ))}
          </select>
        </div>

        {!isDisabled && (
          <>
            <div className="form-group">
              <label>{t('settings.model')}</label>
              {models.length > 0 ? (
                <>
                  <select
                    value={isCustomModel ? CUSTOM_MODEL : (value.model ?? '')}
                    onChange={e => handleModelSelectChange(e.target.value)}
                  >
                    {models.map(model => <option key={model} value={model}>{model}</option>)}
                    <option value={CUSTOM_MODEL}>{t('settings.customModel')}</option>
                  </select>
                  {isCustomModel && (
                    <input
                      type="text"
                      value={value.customModel ?? ''}
                      placeholder={t('settings.enterCustomModel')}
                      style={{ marginTop: 8 }}
                      onChange={e => updateDraft(`${prefix}.customModel`, e.target.value)}
                    />
                  )}
                </>
              ) : (
                <input
                  type="text"
                  value={value.customModel ?? value.model ?? ''}
                  placeholder={t('settings.enterModel')}
                  onChange={e => {
                    updateDraft(`${prefix}.model`, e.target.value);
                    updateDraft(`${prefix}.customModel`, e.target.value);
                  }}
                />
              )}
            </div>

            {value.dimensions !== undefined && (() => {
              const currentModel = isCustomModel ? (value.customModel ?? '') : (value.model ?? '');
              const recommended = EMBEDDING_DIMENSIONS[currentModel];
              const currentDimensions = Number(value.dimensions);
              const mismatch = recommended && currentDimensions !== recommended;
              return (
                <div className="form-group">
                  <label>
                    {t('settings.dimensions')}
                    {recommended && (
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
                        {t('settings.dimensionRecommended', { value: recommended })}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    value={value.dimensions ?? ''}
                    onChange={e => updateDraft(`${prefix}.dimensions`, e.target.value)}
                  />
                  {mismatch && (
                    <div style={{
                      marginTop: 8, padding: '8px 12px',
                      background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.3)',
                      borderRadius: 4, fontSize: 12, color: '#b8860b', lineHeight: 1.5,
                    }}>
                      {t('settings.dimensionMismatch', { model: currentModel, recommended })}
                    </div>
                  )}
                  <div style={{
                    marginTop: 8, padding: '8px 12px',
                    background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.3)',
                    borderRadius: 4, fontSize: 12, color: '#b8860b', lineHeight: 1.5,
                  }}>
                    {t('settings.dimensionWarning')}
                  </div>
                </div>
              );
            })()}

            {preset?.envKey && (
              <div className="form-group">
                <label>
                  {t('settings.apiKey')}
                  {value.hasApiKey && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--success)' }}>{t('common.configured')}</span>
                  )}
                  {!value.hasApiKey && preset.envKey && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>env: {preset.envKey}</span>
                  )}
                </label>
                <input
                  type="password"
                  value={value.apiKey ?? ''}
                  placeholder={value.hasApiKey ? t('settings.keepCurrentKey') : t('settings.enterKeyOrEnv', { envKey: preset.envKey })}
                  onChange={e => updateDraft(`${prefix}.apiKey`, e.target.value)}
                />
              </div>
            )}

            <div className="form-group">
              <label>
                {t('settings.baseUrl')}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>{t('common.optional')}</span>
              </label>
              <input
                type="text"
                value={value.baseUrl ?? ''}
                placeholder={preset?.defaultBaseUrl || 'Default'}
                onChange={e => updateDraft(`${prefix}.baseUrl`, e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>
                {t('settings.providerTimeoutMs')}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>{t('common.optional')}</span>
              </label>
              <input
                type="number"
                min={500}
                max={120000}
                value={value.timeoutMs ?? ''}
                placeholder={t('settings.providerTimeoutPlaceholder')}
                onChange={e => updateDraft(`${prefix}.timeoutMs`, e.target.value)}
              />
              {fieldDesc(timeoutDesc)}
            </div>
          </>
        )}
      </div>
    );
  };

  if (error) return <div className="card" style={{ color: 'var(--danger)' }}>{t('common.errorPrefix', { message: error })}</div>;
  if (!config) return <div className="loading">{t('common.loading')}</div>;

  return (
    <div>
      <h1 className="page-title">{t('settings.title')}</h1>

      {toast && (
        <div style={{
          position: 'fixed', top: 24, right: 24, zIndex: 200,
          padding: '12px 20px', borderRadius: 'var(--radius)',
          background: toast.type === 'success' ? 'var(--success)' : 'var(--danger)',
          color: '#fff', fontSize: 14, fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {toast.message}
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3>{t('settings.serverConfig')}</h3>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.readOnly')}</span>
        </div>
        <table>
          <tbody>
            <tr><td>{t('settings.port')}</td><td>{config.port}</td></tr>
            <tr><td>{t('settings.host')}</td><td>{config.host}</td></tr>
            <tr><td>{t('settings.dbPath')}</td><td>{config.storage?.dbPath}</td></tr>
            <tr><td>{t('settings.walMode')}</td><td>{config.storage?.walMode ? t('common.on') : t('common.off')}</td></tr>
            {config.serverInfo && (
              <>
                <tr><td>{t('settings.serverTimezone')}</td><td>{config.serverInfo.timezone}</td></tr>
                <tr><td>{t('settings.serverTime')}</td><td>{new Date(config.serverInfo.time).toLocaleString()}</td></tr>
                <tr><td>{t('settings.serverUptime')}</td><td>{formatUptime(config.serverInfo.uptime)}</td></tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3>{t('settings.runtimeTitle')}</h3>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.readOnly')}</span>
        </div>
        <table>
          <tbody>
            <tr>
              <td>{t('settings.runtimeMode')}</td>
              <td>{config.runtime?.legacyMode ? t('settings.runtimeLegacy') : t('settings.runtimeV2Only')}</td>
            </tr>
            <tr>
              <td>{t('settings.runtimeLegacyRoutes')}</td>
              <td>{config.runtime?.legacyMode ? t('common.on') : t('common.off')}</td>
            </tr>
            <tr>
              <td>{t('settings.runtimeFallback')}</td>
              <td><code>CORTEX_LEGACY_MODE=1</code></td>
            </tr>
          </tbody>
        </table>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 12 }}>
          {t('settings.runtimeHint')}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3>{t('settings.debugMode')}</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('settings.logLevel')}</label>
          <select
            value={logLevel}
            onChange={async (e) => {
              const level = e.target.value;
              try {
                await apiSetLogLevel(level);
                setLogLevelState(level);
                setToast({ message: `Log level -> ${level}`, type: 'success' });
              } catch (err: any) {
                setToast({ message: err.message, type: 'error' });
              }
            }}
            style={{ fontSize: 13, padding: '4px 8px' }}
          >
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
            <option value="trace">Trace</option>
          </select>
          {(logLevel === 'debug' || logLevel === 'trace') && (
            <span style={{ fontSize: 12, color: 'var(--warning)', fontStyle: 'italic' }}>
              ⚠️ {t('settings.debugWarning')}
            </span>
          )}
        </div>
      </div>

      <LlmSection
        config={config}
        editing={editingSection === 'llm'}
        sectionHeader={sectionHeader}
        renderProviderBlock={renderProviderBlock}
        testState={testState}
        handleTestLLM={handleTestLLM}
        handleTestEmbedding={handleTestEmbedding}
        handleTestReranker={handleTestReranker}
        t={t}
      />

      <div style={{
        background: 'var(--bg-card)', borderRadius: 'var(--radius)',
        border: '1px solid var(--border)', padding: 20, marginBottom: 20,
      }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>
          🔐 {t('settings.authSection')}
        </h3>
        <AuthSection />
      </div>

      <DataManagement
        config={config}
        setConfig={setConfig}
        setToast={setToast}
        t={t}
      />
    </div>
  );
}

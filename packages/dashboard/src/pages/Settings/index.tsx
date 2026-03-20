import React, { useEffect, useMemo, useState } from 'react';
import {
  getConfig,
  updateConfig,
  testLLM,
  testEmbedding,
  testReranker,
  getLogLevel,
  setLogLevel as apiSetLogLevel,
} from '../../api/client.js';
import { useI18n } from '../../i18n/index.js';
import {
  SectionKey,
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  RERANKER_PROVIDERS,
  EMBEDDING_DIMENSIONS,
  CUSTOM_MODEL,
  ProviderPreset,
  parseDuration,
  SCHEDULE_PRESETS,
  SCHEDULE_CUSTOM,
} from './types.js';
import LlmSection from './sections/LlmSection.js';
import SearchSection from './sections/SearchSection.js';
import GateSection from './sections/GateSection.js';
import SieveSection from './sections/SieveSection.js';
import LifecycleSection from './sections/LifecycleSection.js';
import DataManagement from './sections/DataManagement.js';
import AuthSection from './sections/AuthSection.js';

type SettingsView = 'basic' | 'expert';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function humanizeCronValue(value: string, t: (key: string, params?: any) => string): string {
  const preset = SCHEDULE_PRESETS.find(item => item.value === value);
  if (preset) return t(preset.labelKey);
  return value || t('settings.scheduleDisabled');
}

export default function Settings() {
  const [config, setConfig] = useState<any>(null);
  const [error, setError] = useState('');
  const [editingSection, setEditingSection] = useState<SectionKey | null>(null);
  const [draft, setDraft] = useState<any>({});
  const [view, setView] = useState<SettingsView>('basic');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [testState, setTestState] = useState<Record<string, { status: 'idle' | 'testing' | 'success' | 'error'; message?: string; latency?: number }>>({});
  const [logLevel, setLogLevelState] = useState('info');
  const { t } = useI18n();
  const liveEditableSections = useMemo(() => new Set<SectionKey>(['llm', 'lifecycle']), []);

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

  const getDraftValue = (path: string): any =>
    path.split('.').reduce((acc: any, key: string) => acc?.[key], draft);

  const updateDraft = (path: string, value: any) => {
    setDraft((prev: any) => {
      const next = deepClone(prev);
      const keys = path.split('.');
      let cursor = next;
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i]!;
        if (cursor[key] === undefined) cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[keys[keys.length - 1]!] = value;
      return next;
    });
  };

  const humanizeDuration = (value: string): string => {
    const { num, unit } = parseDuration(value);
    if (!num) return value || '-';
    const labels: Record<string, string> = {
      m: t('settings.unitMinutes'),
      h: t('settings.unitHours'),
      d: t('settings.unitDays'),
    };
    return `${num} ${labels[unit] || unit}`;
  };

  const humanizeCron = (value: string): string => humanizeCronValue(value, t);

  const displayRow = (label: string, value: React.ReactNode, desc?: string) => (
    <tr>
      <td style={{ width: '38%', verticalAlign: 'top' }}>
        <div>{label}</div>
        {desc && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {desc}
          </div>
        )}
      </td>
      <td style={{ verticalAlign: 'top' }}>{value}</td>
    </tr>
  );

  const fieldDesc = (text: string) => (
    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
      {text}
    </div>
  );

  const renderNumberField = (label: string, desc: string, path: string, min?: number, max?: number) => (
    <div className="form-group" style={{ marginBottom: 14 }}>
      <label>{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step="any"
        value={getDraftValue(path) ?? ''}
        onChange={e => updateDraft(path, e.target.value === '' ? '' : Number(e.target.value))}
      />
      {fieldDesc(desc)}
    </div>
  );

  const renderToggleField = (label: string, desc: string, path: string) => (
    <div className="form-group" style={{ marginBottom: 14 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={!!getDraftValue(path)}
          onChange={e => updateDraft(path, e.target.checked)}
        />
        <span>{label}</span>
      </label>
      {fieldDesc(desc)}
    </div>
  );

  const renderSlider = (label: string, desc: string, path: string, min: number, max: number, step: number) => {
    const value = Number(getDraftValue(path) ?? min);
    return (
      <div className="form-group" style={{ marginBottom: 14 }}>
        <label>{label} — {value.toFixed(step < 0.1 ? 2 : 1)}</label>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => updateDraft(path, Number(e.target.value))}
          style={{ width: '100%' }}
        />
        {fieldDesc(desc)}
      </div>
    );
  };

  const renderLinkedWeights = () => {
    const vectorWeight = Number(getDraftValue('vectorWeight') ?? 0.7);
    const textWeight = Number(getDraftValue('textWeight') ?? 0.3);
    return (
      <div className="form-group" style={{ marginBottom: 14 }}>
        <label>
          {t('settings.searchBalance')} — {t('settings.vectorWeight')}: {(vectorWeight * 100).toFixed(0)}% / {t('settings.textWeight')}: {(textWeight * 100).toFixed(0)}%
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={vectorWeight}
          onChange={e => {
            const nextVector = Number(e.target.value);
            updateDraft('vectorWeight', nextVector);
            updateDraft('textWeight', Number((1 - nextVector).toFixed(2)));
          }}
          style={{ width: '100%' }}
        />
        {fieldDesc(t('settings.searchBalanceDesc'))}
      </div>
    );
  };

  const renderDuration = (label: string, desc: string, path: string) => (
    <div className="form-group" style={{ marginBottom: 14 }}>
      <label>{label}</label>
      <input
        type="text"
        value={getDraftValue(path) ?? ''}
        placeholder="7d"
        onChange={e => updateDraft(path, e.target.value)}
      />
      {fieldDesc(desc)}
    </div>
  );

  const renderSchedule = () => {
    const presetValue = getDraftValue('schedulePreset') ?? '';
    const isCustom = presetValue === SCHEDULE_CUSTOM;
    return (
      <div className="form-group" style={{ marginBottom: 14 }}>
        <label>{t('settings.scheduleLabel')}</label>
        <select
          value={presetValue}
          onChange={e => {
            const next = e.target.value;
            updateDraft('schedulePreset', next);
            if (next === SCHEDULE_CUSTOM) {
              updateDraft('schedule', getDraftValue('customSchedule') ?? '');
              return;
            }
            updateDraft('schedule', next);
          }}
        >
          {SCHEDULE_PRESETS.map(item => (
            <option key={item.value || '__disabled__'} value={item.value}>
              {t(item.labelKey)}
            </option>
          ))}
          <option value={SCHEDULE_CUSTOM}>{t('settings.scheduleCustom')}</option>
        </select>
        {isCustom && (
          <input
            type="text"
            value={getDraftValue('customSchedule') ?? ''}
            placeholder="0 3 * * *"
            style={{ marginTop: 8 }}
            onChange={e => {
              updateDraft('customSchedule', e.target.value);
              updateDraft('schedule', e.target.value);
            }}
          />
        )}
        {fieldDesc(t('settings.scheduleDesc'))}
      </div>
    );
  };

  const sectionHeader = (title: string, section: SectionKey) => {
    const editable = liveEditableSections.has(section);
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>{title}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {editable ? t('settings.liveApply') : t('settings.deployOnly')}
          </div>
        </div>
        {editable ? (
          editingSection === section ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={cancelEdit}>{t('common.cancel')}</button>
              <button className="btn primary" onClick={() => saveSection(section)}>{t('common.save')}</button>
            </div>
          ) : (
            <button className="btn" onClick={() => startEdit(section)} disabled={editingSection !== null}>
              {t('common.edit')}
            </button>
          )
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.readOnly')}</span>
        )}
      </div>
    );
  };

  const startEdit = (section: SectionKey) => {
    if (!config) return;

    if (section === 'llm') {
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
      return;
    }

    if (section === 'gate') {
      setDraft({
        fixedInjectionTokens: config.gate?.fixedInjectionTokens ?? 500,
        maxInjectionTokens: config.gate?.maxInjectionTokens ?? 1000,
        relationInjection: config.gate?.relationInjection ?? false,
        relationBudget: config.gate?.relationBudget ?? 100,
        searchLimit: config.gate?.searchLimit ?? 30,
        skipSmallTalk: config.gate?.skipSmallTalk ?? false,
        cliffAbsolute: config.gate?.cliffAbsolute ?? 0.4,
        cliffGap: config.gate?.cliffGap ?? 0.6,
        cliffFloor: config.gate?.cliffFloor ?? 0.05,
        queryExpansionTimeoutMs: config.gate?.queryExpansionTimeoutMs ?? 5000,
        rerankerTimeoutMs: config.gate?.rerankerTimeoutMs ?? 8000,
        relationTimeoutMs: config.gate?.relationTimeoutMs ?? 5000,
        relevanceGate: {
          enabled: config.gate?.relevanceGate?.enabled ?? true,
          inspectTopK: config.gate?.relevanceGate?.inspectTopK ?? 3,
          minSemanticScore: config.gate?.relevanceGate?.minSemanticScore ?? 0.55,
          minFusedScoreNoOverlap: config.gate?.relevanceGate?.minFusedScoreNoOverlap ?? 0.15,
        },
        queryExpansion: {
          enabled: config.gate?.queryExpansion?.enabled ?? false,
          maxVariants: config.gate?.queryExpansion?.maxVariants ?? 3,
        },
      });
      setEditingSection(section);
      return;
    }

    if (section === 'lifecycle') {
      setDraft({
        schedulePreset: config.lifecycle?.schedule ?? '',
        schedule: config.lifecycle?.schedule ?? '',
        customSchedule: config.lifecycle?.schedule ?? '',
      });
      setEditingSection(section);
      return;
    }

    if (section === 'search') {
      setDraft({
        hybrid: config.search?.hybrid ?? true,
        vectorWeight: config.search?.vectorWeight ?? 0.7,
        textWeight: config.search?.textWeight ?? 0.3,
        minSimilarity: config.search?.minSimilarity ?? 0.2,
        recencyBoostWindow: config.search?.recencyBoostWindow ?? '7d',
        reranker: {
          enabled: config.search?.reranker?.enabled ?? false,
          topN: config.search?.reranker?.topN ?? 10,
          weight: config.search?.reranker?.weight ?? 0.5,
        },
      });
      setEditingSection(section);
      return;
    }

    if (section === 'sieve') {
      setDraft({
        fastChannelEnabled: config.sieve?.fastChannelEnabled ?? true,
        contextMessages: config.sieve?.contextMessages ?? 4,
        maxConversationChars: config.sieve?.maxConversationChars ?? 4000,
        smartUpdate: config.sieve?.smartUpdate ?? true,
        similarityThreshold: config.sieve?.similarityThreshold ?? 0.35,
        exactDupThreshold: config.sieve?.exactDupThreshold ?? 0.08,
        relationExtraction: config.sieve?.relationExtraction ?? true,
        extractionLogPreviewCharsPerMessage: config.sieve?.extractionLogPreviewCharsPerMessage ?? 60,
        extractionLogPreviewMaxChars: config.sieve?.extractionLogPreviewMaxChars ?? 300,
      });
      setEditingSection(section);
    }
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setDraft({});
  };

  const handleConfigSaveSuccess = async (response: any) => {
    const refreshed = await getConfig();
    setConfig(refreshed);
    cancelEdit();
    const restartRequired = Array.isArray(response?.restart_required_sections)
      ? response.restart_required_sections
      : [];
    setToast({
      message: restartRequired.length > 0
        ? t('settings.toastConfigSavedPartial', { sections: restartRequired.join(', ') })
        : t('settings.toastConfigSaved'),
      type: 'success',
    });
  };

  const saveSection = async (section: SectionKey) => {
    if (!config) return;
    const v2Only = !config.runtime?.legacyMode;

    if (section === 'llm') {
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

      if (!v2Only) {
        payload.llm.lifecycle = buildProviderPayload(draft.lifecycle);
      } else {
        delete payload.search;
      }

      try {
        const response = await updateConfig(payload);
        await handleConfigSaveSuccess(response);
      } catch (e: any) {
        setToast({ message: t('settings.toastSaveFailed', { message: e.message }), type: 'error' });
      }
      return;
    }

    if (section === 'gate') {
      const timeoutValues = [draft.queryExpansionTimeoutMs, draft.rerankerTimeoutMs, draft.relationTimeoutMs];
      if (timeoutValues.some((value: any) => Number.isNaN(Number(value)) || Number(value) < 500 || Number(value) > 30000)) {
        setToast({ message: t('settings.validationTimeoutRange', { min: 500, max: 30000 }), type: 'error' });
        return;
      }

      const payload = {
        gate: {
          ...config.gate,
          fixedInjectionTokens: Number(draft.fixedInjectionTokens),
          maxInjectionTokens: Number(draft.maxInjectionTokens),
          relationInjection: !!draft.relationInjection,
          relationBudget: Number(draft.relationBudget),
          searchLimit: Number(draft.searchLimit),
          skipSmallTalk: !!draft.skipSmallTalk,
          cliffAbsolute: Number(draft.cliffAbsolute),
          cliffGap: Number(draft.cliffGap),
          cliffFloor: Number(draft.cliffFloor),
          queryExpansionTimeoutMs: Number(draft.queryExpansionTimeoutMs),
          rerankerTimeoutMs: Number(draft.rerankerTimeoutMs),
          relationTimeoutMs: Number(draft.relationTimeoutMs),
          relevanceGate: {
            enabled: !!draft.relevanceGate?.enabled,
            inspectTopK: Number(draft.relevanceGate?.inspectTopK),
            minSemanticScore: Number(draft.relevanceGate?.minSemanticScore),
            minFusedScoreNoOverlap: Number(draft.relevanceGate?.minFusedScoreNoOverlap),
          },
          queryExpansion: {
            enabled: !!draft.queryExpansion?.enabled,
            maxVariants: Number(draft.queryExpansion?.maxVariants ?? 3),
          },
        },
      };

      try {
        const response = await updateConfig(payload);
        await handleConfigSaveSuccess(response);
      } catch (e: any) {
        setToast({ message: t('settings.toastSaveFailed', { message: e.message }), type: 'error' });
      }
      return;
    }

    if (section === 'lifecycle') {
      const schedule = String(draft.schedule ?? '').trim();
      if (schedule && schedule.split(/\s+/).length !== 5) {
        setToast({ message: t('settings.validationCronFormat'), type: 'error' });
        return;
      }

      try {
        const response = await updateConfig({
          lifecycle: {
            ...config.lifecycle,
            schedule,
          },
        });
        await handleConfigSaveSuccess(response);
      } catch (e: any) {
        setToast({ message: t('settings.toastSaveFailed', { message: e.message }), type: 'error' });
      }
      return;
    }

    if (section === 'search') {
      const vectorWeight = Number(draft.vectorWeight);
      const textWeight = Number(draft.textWeight);
      if (Number.isNaN(vectorWeight) || Number.isNaN(textWeight) || vectorWeight < 0 || vectorWeight > 1 || textWeight < 0 || textWeight > 1) {
        setToast({ message: t('settings.validationWeightRange'), type: 'error' });
        return;
      }
      if (!/^\d+[mhd]$/i.test(draft.recencyBoostWindow || '')) {
        setToast({ message: t('settings.validationDurationFormat'), type: 'error' });
        return;
      }

      const payload = {
        search: {
          ...config.search,
          hybrid: !!draft.hybrid,
          vectorWeight,
          textWeight,
          minSimilarity: Number(draft.minSimilarity),
          recencyBoostWindow: draft.recencyBoostWindow,
          reranker: {
            ...(config.search?.reranker ?? {}),
            enabled: !!draft.reranker?.enabled,
            topN: Number(draft.reranker?.topN ?? 10),
            weight: Number(draft.reranker?.weight ?? 0.5),
          },
        },
      };

      try {
        const response = await updateConfig(payload);
        await handleConfigSaveSuccess(response);
      } catch (e: any) {
        setToast({ message: t('settings.toastSaveFailed', { message: e.message }), type: 'error' });
      }
      return;
    }

    if (section === 'sieve') {
      const payload = {
        sieve: {
          ...config.sieve,
          fastChannelEnabled: !!draft.fastChannelEnabled,
          contextMessages: Number(draft.contextMessages),
          maxConversationChars: Number(draft.maxConversationChars),
          smartUpdate: !!draft.smartUpdate,
          similarityThreshold: Number(draft.similarityThreshold),
          exactDupThreshold: Number(draft.exactDupThreshold),
          relationExtraction: !!draft.relationExtraction,
          extractionLogPreviewCharsPerMessage: Number(draft.extractionLogPreviewCharsPerMessage),
          extractionLogPreviewMaxChars: Number(draft.extractionLogPreviewMaxChars),
        },
      };

      try {
        const response = await updateConfig(payload);
        await handleConfigSaveSuccess(response);
      } catch (e: any) {
        setToast({ message: t('settings.toastSaveFailed', { message: e.message }), type: 'error' });
      }
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

  const renderProviderBlock = useMemo(() => {
    const localizeProviderLabel = (key: string, label: string) => {
      if (key === 'none') return t('settings.disabled');
      if (key === 'llm') return t('settings.rerankerLlmLabel');
      if (label === 'Ollama (Local)') return t('settings.providerOllamaLocal');
      if (label === 'Voyage AI (200M free tokens)') return t('settings.providerVoyageFree');
      if (label === 'Jina AI (multilingual, 1M free tokens)') return t('settings.providerJinaFree');
      return label;
    };

    return (title: string, prefix: string, providerMap: Record<string, ProviderPreset>) => {
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
                <option key={key} value={key}>{localizeProviderLabel(key, item.label)}</option>
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
                        marginTop: 8,
                        padding: '8px 12px',
                        background: 'rgba(255,170,0,0.1)',
                        border: '1px solid rgba(255,170,0,0.3)',
                        borderRadius: 4,
                        fontSize: 12,
                        color: '#b8860b',
                        lineHeight: 1.5,
                      }}>
                        {t('settings.dimensionMismatch', { model: currentModel, recommended })}
                      </div>
                    )}
                    <div style={{
                      marginTop: 8,
                      padding: '8px 12px',
                      background: 'rgba(255,170,0,0.1)',
                      border: '1px solid rgba(255,170,0,0.3)',
                      borderRadius: 4,
                      fontSize: 12,
                      color: '#b8860b',
                      lineHeight: 1.5,
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
  }, [draft, t]);

  if (error) return <div className="card" style={{ color: 'var(--danger)' }}>{t('common.errorPrefix', { message: error })}</div>;
  if (!config) return <div className="loading">{t('common.loading')}</div>;

  return (
    <div>
      <h1 className="page-title">{t('settings.title')}</h1>

      {toast && (
        <div style={{
          position: 'fixed',
          top: 24,
          right: 24,
          zIndex: 200,
          padding: '12px 20px',
          borderRadius: 'var(--radius)',
          background: toast.type === 'success' ? 'var(--success)' : 'var(--danger)',
          color: '#fff',
          fontSize: 14,
          fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {toast.message}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={`btn ${view === 'basic' ? 'primary' : ''}`} onClick={() => setView('basic')}>
            {t('settings.basicSettings')}
          </button>
          <button className={`btn ${view === 'expert' ? 'primary' : ''}`} onClick={() => setView('expert')}>
            {t('settings.expertSettings')}
          </button>
        </div>
      </div>

      {view === 'basic' ? (
        <>
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
                  {t('settings.debugWarning')}
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
            background: 'var(--bg-card)',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            padding: 20,
            marginBottom: 20,
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
        </>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginBottom: 10 }}>{t('settings.expertSettings')}</h3>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              {t('settings.expertSettingsHint')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 8 }}>
              {t('settings.expertRuntimeHint')}
            </div>
          </div>

          <LifecycleSection
            config={config}
            editing={editingSection === 'lifecycle'}
            sectionHeader={sectionHeader}
            displayRow={displayRow}
            renderSchedule={renderSchedule}
            humanizeCron={humanizeCron}
            t={t}
          />

          <GateSection
            config={config}
            editing={editingSection === 'gate'}
            draft={draft}
            setDraft={setDraft}
            sectionHeader={sectionHeader}
            displayRow={displayRow}
            renderNumberField={renderNumberField}
            renderToggleField={renderToggleField}
            t={t}
          />

          <SearchSection
            config={config}
            editing={editingSection === 'search'}
            draft={draft}
            setDraft={setDraft}
            sectionHeader={sectionHeader}
            displayRow={displayRow}
            renderToggleField={renderToggleField}
            renderLinkedWeights={renderLinkedWeights}
            renderDuration={renderDuration}
            humanizeDuration={humanizeDuration}
            t={t}
          />

          <SieveSection
            config={config}
            editing={editingSection === 'sieve'}
            sectionHeader={sectionHeader}
            displayRow={displayRow}
            renderToggleField={renderToggleField}
            renderNumberField={renderNumberField}
            renderSlider={renderSlider}
            t={t}
          />
        </>
      )}
    </div>
  );
}

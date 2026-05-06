import React from 'react';
import { RETAIN_MISSION_PRESETS, labelRetainMissionPreset } from '../../../utils/missionPresets.js';

interface AutomaticMemorySectionProps {
  missionDraft: string;
  missionSaving: boolean;
  onMissionDraftChange: (value: string) => void;
  onMissionSave: () => void;
  t: (key: string, params?: any) => string;
}

export default function AutomaticMemorySection({
  missionDraft,
  missionSaving,
  onMissionDraftChange,
  onMissionSave,
  t,
}: AutomaticMemorySectionProps) {
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>{t('settings.automaticMemoryTitle')}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.liveApply')}</div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('settings.automaticMemoryDesc')}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('settings.retainMissionLabel')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 10 }}>
        {t('settings.retainMissionDesc')}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {RETAIN_MISSION_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="btn"
            onClick={() => onMissionDraftChange(preset)}
          >
            {labelRetainMissionPreset(preset)}
          </button>
        ))}
      </div>
      <textarea
        aria-label={t('settings.retainMissionLabel')}
        value={missionDraft}
        rows={4}
        placeholder={t('settings.retainMissionPlaceholder')}
        style={{ width: '100%', resize: 'vertical', marginBottom: 10 }}
        onChange={e => onMissionDraftChange(e.target.value)}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {t('settings.retainMissionHint')}
        </div>
        <button className="btn primary" disabled={missionSaving} onClick={onMissionSave}>
          {missionSaving ? t('common.running') : t('settings.retainMissionSave')}
        </button>
      </div>
    </div>
  );
}

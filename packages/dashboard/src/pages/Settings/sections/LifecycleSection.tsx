import React from 'react';
import { SectionKey } from '../types.js';

interface LifecycleSectionProps {
  config: any;
  editing: boolean;
  sectionHeader: (title: string, section: SectionKey) => React.ReactNode;
  displayRow: (label: string, value: any, desc?: string) => React.ReactNode;
  renderSchedule: () => React.ReactNode;
  humanizeCron: (s: string) => string;
  t: (key: string, params?: any) => string;
}

export default function LifecycleSection({
  config, editing, sectionHeader, displayRow, renderSchedule, humanizeCron, t,
}: LifecycleSectionProps) {
  return (
    <div className="card">
      {sectionHeader(t('settings.lifecycleTitle'), 'lifecycle')}
      {editing ? (
        <div style={{ padding: '4px 0' }}>
          {renderSchedule()}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
            {t('settings.lifecycleRetentionHint')}
          </div>
        </div>
      ) : (
        <table>
          <tbody>
            {displayRow(t('settings.scheduleLabel'), humanizeCron(config.lifecycle?.schedule), t('settings.scheduleDesc'))}
          </tbody>
        </table>
      )}
    </div>
  );
}

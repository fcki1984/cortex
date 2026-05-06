import React from 'react';
import { SectionKey, LLM_PROVIDERS, EMBEDDING_PROVIDERS, ProviderPreset } from '../types.js';

interface LlmSectionProps {
  config: any;
  editing: boolean;
  sectionHeader: (title: string, section: SectionKey) => React.ReactNode;
  renderProviderBlock: (title: string, prefix: string, providerMap: Record<string, ProviderPreset>) => React.ReactNode;
  testState: Record<string, { status: 'idle' | 'testing' | 'success' | 'error'; message?: string; latency?: number }>;
  handleTestLLM: (target: 'extraction') => void;
  handleTestEmbedding: () => void;
  t: (key: string, params?: any) => string;
}

export default function LlmSection({
  config, editing, sectionHeader, renderProviderBlock, testState, handleTestLLM, handleTestEmbedding, t,
}: LlmSectionProps) {
  const formatProvider = (provider?: string, model?: string, timeoutMs?: number) =>
    `${provider}${model ? ` / ${model}` : ''}${timeoutMs ? ` · ${timeoutMs}ms` : ''}`;

  return (
    <div className="card">
      {sectionHeader(t('settings.llmEmbedding'), 'llm')}
      {editing ? (
        <>
          {renderProviderBlock(t('settings.extractionLlm'), 'extraction', LLM_PROVIDERS)}
          {renderProviderBlock(t('settings.embedding'), 'embedding', EMBEDDING_PROVIDERS)}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 8 }}>
            {t('settings.llmV2OnlyHint')}
          </div>
        </>
      ) : (
        <table>
          <tbody>
            <tr>
              <td>{t('settings.extractionLlm')}</td>
              <td style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{formatProvider(config.llm?.extraction?.provider, config.llm?.extraction?.model, config.llm?.extraction?.timeoutMs)}</span>
                <button
                  className="btn"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  disabled={testState['llm.extraction']?.status === 'testing'}
                  onClick={() => handleTestLLM('extraction')}
                >
                  {testState['llm.extraction']?.status === 'testing' ? t('settings.testing') : t('settings.testConnection')}
                </button>
                {testState['llm.extraction']?.status === 'success' && (
                  <span style={{ fontSize: 11, color: 'var(--success)' }}>{t('settings.testSuccess', { latency: testState['llm.extraction'].latency ?? 0 })}</span>
                )}
                {testState['llm.extraction']?.status === 'error' && (
                  <span style={{ fontSize: 11, color: 'var(--danger)' }}>{t('settings.testFailed', { message: testState['llm.extraction'].message ?? '' })}</span>
                )}
              </td>
            </tr>
            <tr>
              <td>{t('settings.embedding')}</td>
              <td style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{formatProvider(config.embedding?.provider, config.embedding?.model, config.embedding?.timeoutMs)}</span>
                <button
                  className="btn"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  disabled={testState['embedding']?.status === 'testing'}
                  onClick={() => handleTestEmbedding()}
                >
                  {testState['embedding']?.status === 'testing' ? t('settings.testing') : t('settings.testConnection')}
                </button>
                {testState['embedding']?.status === 'success' && (
                  <span style={{ fontSize: 11, color: 'var(--success)' }}>{t('settings.testSuccess', { latency: testState['embedding'].latency ?? 0 })}</span>
                )}
                {testState['embedding']?.status === 'error' && (
                  <span style={{ fontSize: 11, color: 'var(--danger)' }}>{t('settings.testFailed', { message: testState['embedding'].message ?? '' })}</span>
                )}
              </td>
            </tr>
            <tr><td>{t('settings.embeddingDimensions')}</td><td>{config.embedding?.dimensions}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

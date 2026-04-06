import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Settings from './index.js';
import { I18nProvider } from '../../i18n/index.js';

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  testLLM: vi.fn(),
  testEmbedding: vi.fn(),
  testReranker: vi.fn(),
  getAuthStatus: vi.fn(),
  getLogLevel: vi.fn(),
  setLogLevel: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  getConfig: apiMocks.getConfig,
  updateConfig: apiMocks.updateConfig,
  testLLM: apiMocks.testLLM,
  testEmbedding: apiMocks.testEmbedding,
  testReranker: apiMocks.testReranker,
  getAuthStatus: apiMocks.getAuthStatus,
  getLogLevel: apiMocks.getLogLevel,
  setLogLevel: apiMocks.setLogLevel,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <Settings />
      </I18nProvider>
    </MemoryRouter>,
  );
}

function installLocale() {
  window.localStorage.setItem('cortex-locale', 'zh');
}

function buildConfig(retainMission: string) {
  return {
    port: 3000,
    host: '0.0.0.0',
    runtime: {
      legacyMode: false,
      fallbackEnabled: false,
    },
    storage: {
      dbPath: ':memory:',
      walMode: false,
    },
    llm: {
      extraction: { provider: 'none', model: '', timeoutMs: 5000, hasApiKey: false, baseUrl: '' },
      lifecycle: { provider: 'none', model: '', timeoutMs: 5000, hasApiKey: false, baseUrl: '' },
    },
    embedding: {
      provider: 'none',
      model: '',
      dimensions: 4,
      timeoutMs: 5000,
      hasApiKey: false,
      baseUrl: '',
    },
    search: {
      hybrid: true,
      vectorWeight: 0.7,
      textWeight: 0.3,
      minSimilarity: 0.2,
      recencyBoostWindow: '7d',
      reranker: {
        enabled: false,
        provider: 'none',
        model: '',
        timeoutMs: 5000,
        topN: 10,
        weight: 0.5,
        hasApiKey: false,
        baseUrl: '',
      },
    },
    lifecycle: {
      schedule: '',
    },
    gate: {
      fixedInjectionTokens: 500,
      maxInjectionTokens: 1000,
      relationInjection: false,
      relationBudget: 100,
      searchLimit: 30,
      skipSmallTalk: false,
      cliffAbsolute: 0.4,
      cliffGap: 0.6,
      cliffFloor: 0.05,
      queryExpansionTimeoutMs: 5000,
      rerankerTimeoutMs: 8000,
      relationTimeoutMs: 5000,
      relevanceGate: {
        enabled: true,
        inspectTopK: 3,
        minSemanticScore: 0.55,
        minFusedScoreNoOverlap: 0.15,
      },
      queryExpansion: {
        enabled: false,
        maxVariants: 3,
      },
    },
    sieve: {
      fastChannelEnabled: true,
      contextMessages: 4,
      maxConversationChars: 4000,
      smartUpdate: true,
      similarityThreshold: 0.35,
      exactDupThreshold: 0.08,
      relationExtraction: true,
      extractionLogPreviewCharsPerMessage: 60,
      extractionLogPreviewMaxChars: 300,
      retainMission,
    },
  };
}

describe('Settings retain mission', () => {
  beforeEach(() => {
    installLocale();
    apiMocks.getConfig.mockResolvedValue(buildConfig('保留长期偏好、稳定背景和持续任务'));
    apiMocks.getLogLevel.mockResolvedValue({ level: 'info' });
    apiMocks.getAuthStatus.mockResolvedValue({
      authRequired: false,
      setupRequired: false,
      source: 'none',
      hasAgentTokens: false,
      agentTokenCount: 0,
      mutable: false,
    });
    apiMocks.updateConfig.mockResolvedValue({
      ok: true,
      applied_sections: ['sieve.retainMission'],
      restart_required_sections: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('loads and saves the global retain mission from the sieve section', async () => {
    const user = userEvent.setup();
    apiMocks.getConfig
      .mockResolvedValueOnce(buildConfig('保留长期偏好、稳定背景和持续任务'))
      .mockResolvedValueOnce(buildConfig('只保留长期偏好和稳定背景，不保留短期任务'));

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });
    await user.click(screen.getByRole('button', { name: '专家设置' }));

    const sieveCard = screen.getByText('提取与归一').closest('.card');
    expect(sieveCard).toBeTruthy();

    const missionField = within(sieveCard as HTMLElement).getByLabelText('保留 Mission') as HTMLTextAreaElement;
    expect(missionField.value).toBe('保留长期偏好、稳定背景和持续任务');

    await user.clear(missionField);
    await user.type(missionField, '只保留长期偏好和稳定背景，不保留短期任务');
    await user.click(within(sieveCard as HTMLElement).getByRole('button', { name: '保存 Mission' }));

    await waitFor(() => {
      expect(apiMocks.updateConfig).toHaveBeenCalledWith({
        sieve: {
          retainMission: '只保留长期偏好和稳定背景，不保留短期任务',
        },
      });
    });

    expect(await within(sieveCard as HTMLElement).findByDisplayValue('只保留长期偏好和稳定背景，不保留短期任务')).toBeTruthy();
  });
});

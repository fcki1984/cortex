import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Settings from './index.js';
import { buildImportableConfigForSettingsUpdate } from './sections/DataManagement.js';
import { I18nProvider } from '../../i18n/index.js';

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  testLLM: vi.fn(),
  testEmbedding: vi.fn(),
  setupAuthToken: vi.fn(),
  changeAuthToken: vi.fn(),
  navigate: vi.fn(),
  getAuthStatus: vi.fn(),
  getLogLevel: vi.fn(),
  setLogLevel: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  getConfig: apiMocks.getConfig,
  updateConfig: apiMocks.updateConfig,
  testLLM: apiMocks.testLLM,
  testEmbedding: apiMocks.testEmbedding,
  setupAuthToken: apiMocks.setupAuthToken,
  changeAuthToken: apiMocks.changeAuthToken,
  getAuthStatus: apiMocks.getAuthStatus,
  getLogLevel: apiMocks.getLogLevel,
  setLogLevel: apiMocks.setLogLevel,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => apiMocks.navigate,
  };
});

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

describe('Settings truth source', () => {
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
    apiMocks.setupAuthToken.mockResolvedValue({ ok: true });
    apiMocks.changeAuthToken.mockResolvedValue({ ok: true });
    apiMocks.navigate.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('loads and saves the global retain mission from basic automatic memory settings', async () => {
    const user = userEvent.setup();
    apiMocks.getConfig
      .mockResolvedValueOnce(buildConfig('保留长期偏好、稳定背景和持续任务'))
      .mockResolvedValueOnce(buildConfig('只保留长期偏好和稳定背景，不保留短期任务'));

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });

    const automationCard = screen.getByText('自动记忆').closest('.card');
    expect(automationCard).toBeTruthy();

    const missionField = within(automationCard as HTMLElement).getByLabelText('保留 Mission') as HTMLTextAreaElement;
    expect(missionField.value).toBe('保留长期偏好、稳定背景和持续任务');

    await user.click(within(automationCard as HTMLElement).getByRole('button', { name: '长期偏好和稳定背景，不保留短期任务' }));
    await user.click(within(automationCard as HTMLElement).getByRole('button', { name: '保存 Mission' }));

    await waitFor(() => {
      expect(apiMocks.updateConfig).toHaveBeenCalledWith({
        sieve: {
          retainMission: '只保留长期偏好和稳定背景，不保留短期任务',
        },
      });
    });

    expect(await within(automationCard as HTMLElement).findByDisplayValue('只保留长期偏好和稳定背景，不保留短期任务')).toBeTruthy();
  });

  it('removes legacy expert settings from the product settings surface', async () => {
    const user = userEvent.setup();

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });
    await user.click(screen.getByRole('button', { name: '专家设置' }));

    expect(screen.getByText('V2 主链使用，但只能通过部署配置或重启调整')).toBeTruthy();
    expect(screen.queryByLabelText('保留 Mission')).toBeNull();
    expect(screen.queryByText('记忆注入')).toBeNull();
    expect(screen.queryByText('搜索与重排')).toBeNull();
    expect(screen.queryByText('提取与归一')).toBeNull();
    expect(screen.queryByText('V2 主链未使用，仅 legacy 兼容参考')).toBeNull();
  });

  it('does not expose legacy reranker or lifecycle LLM editing even when legacy config exists', async () => {
    const user = userEvent.setup();
    apiMocks.getConfig.mockResolvedValueOnce({
      ...buildConfig('保留长期偏好、稳定背景和持续任务'),
      runtime: {
        legacyMode: true,
        fallbackEnabled: true,
      },
      llm: {
        extraction: { provider: 'none', model: '', timeoutMs: 5000, hasApiKey: false, baseUrl: '' },
        lifecycle: { provider: 'openai', model: 'gpt-4o-mini', timeoutMs: 5000, hasApiKey: true, baseUrl: '' },
      },
      search: {
        ...buildConfig('').search,
        reranker: {
          enabled: true,
          provider: 'llm',
          model: 'gpt-4o-mini',
          timeoutMs: 5000,
          topN: 10,
          weight: 0.5,
          hasApiKey: false,
          baseUrl: '',
        },
      },
    });

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });

    const llmCard = screen.getByText('LLM 与向量嵌入').closest('.card');
    expect(llmCard).toBeTruthy();
    await user.click(within(llmCard as HTMLElement).getByRole('button', { name: '编辑' }));

    expect(within(llmCard as HTMLElement).getByText('提取 LLM')).toBeTruthy();
    expect(within(llmCard as HTMLElement).getByText('向量嵌入')).toBeTruthy();
    expect(within(llmCard as HTMLElement).queryByText('生命周期 LLM')).toBeNull();
    expect(within(llmCard as HTMLElement).queryByText('重排器')).toBeNull();

    await user.click(within(llmCard as HTMLElement).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(apiMocks.updateConfig).toHaveBeenCalled();
    });
    const payload = apiMocks.updateConfig.mock.calls[0]?.[0];
    expect(payload.llm).toEqual({
      extraction: {
        provider: 'none',
        model: '',
        baseUrl: '',
        timeoutMs: 5000,
      },
    });
    expect(payload.embedding).toBeTruthy();
    expect(payload.search).toBeUndefined();
  });

  it('does not show legacy lifecycle LLM or reranker in read-only LLM settings', async () => {
    apiMocks.getConfig.mockResolvedValueOnce({
      ...buildConfig('保留长期偏好、稳定背景和持续任务'),
      llm: {
        extraction: { provider: 'none', model: '', timeoutMs: 5000, hasApiKey: false, baseUrl: '' },
        lifecycle: { provider: 'openai', model: 'gpt-4o-mini', timeoutMs: 5000, hasApiKey: true, baseUrl: '' },
      },
      search: {
        ...buildConfig('').search,
        reranker: {
          enabled: true,
          provider: 'llm',
          model: 'gpt-4o-mini',
          timeoutMs: 5000,
          topN: 10,
          weight: 0.5,
          hasApiKey: false,
          baseUrl: '',
        },
      },
    });

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });

    const llmCard = screen.getByText('LLM 与向量嵌入').closest('.card');
    expect(llmCard).toBeTruthy();
    expect(within(llmCard as HTMLElement).getByText('提取 LLM')).toBeTruthy();
    expect(within(llmCard as HTMLElement).getByText('向量嵌入')).toBeTruthy();
    expect(within(llmCard as HTMLElement).queryByText('生命周期 LLM')).toBeNull();
    expect(within(llmCard as HTMLElement).queryByText('重排器')).toBeNull();
  });

  it('filters full config import to writable settings only', () => {
    const importable = buildImportableConfigForSettingsUpdate({
      port: 3000,
      host: '0.0.0.0',
      runtime: { legacyMode: true },
      storage: { dbPath: '/tmp/cortex.db' },
      auth: { token: 'secret-token' },
      vectorBackend: { provider: 'sqlite-vec' },
      gate: { searchLimit: 30 },
      search: {
        reranker: {
          enabled: true,
          provider: 'llm',
          model: 'gpt-4o-mini',
          timeoutMs: 5000,
        },
      },
      llm: {
        extraction: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl: '',
          timeoutMs: 5000,
          hasApiKey: true,
        },
        lifecycle: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          timeoutMs: 5000,
          hasApiKey: true,
        },
      },
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        timeoutMs: 5000,
        hasApiKey: true,
      },
      lifecycle: {
        schedule: '0 3 * * *',
        staleAfter: '30d',
      },
      sieve: {
        retainMission: '只保留长期偏好和稳定背景，不保留短期任务',
        fastChannelEnabled: false,
      },
    });

    expect(importable).toEqual({
      llm: {
        extraction: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl: '',
          timeoutMs: 5000,
        },
      },
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        timeoutMs: 5000,
      },
      lifecycle: {
        schedule: '0 3 * * *',
      },
      sieve: {
        retainMission: '只保留长期偏好和稳定背景，不保留短期任务',
      },
    });
  });

  it('supports first-time auth token setup when auth has no master token', async () => {
    const user = userEvent.setup();
    apiMocks.getAuthStatus
      .mockResolvedValueOnce({
        authRequired: false,
        setupRequired: true,
        source: 'none',
        hasAgentTokens: false,
        agentTokenCount: 0,
        mutable: true,
      })
      .mockResolvedValueOnce({
        authRequired: true,
        setupRequired: false,
        source: 'config',
        hasAgentTokens: false,
        agentTokenCount: 0,
        mutable: true,
      });

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });
    const authCard = screen.getByText(/认证管理/).closest('div[style*="background"]');
    expect(authCard).toBeTruthy();

    expect(within(authCard as HTMLElement).queryByLabelText('当前令牌')).toBeNull();
    await user.type(await within(authCard as HTMLElement).findByLabelText('新令牌'), 'new-master-token');
    await user.type(await within(authCard as HTMLElement).findByLabelText('确认新令牌'), 'new-master-token');
    await user.click(within(authCard as HTMLElement).getByRole('button', { name: '设置令牌' }));

    await waitFor(() => {
      expect(apiMocks.setupAuthToken).toHaveBeenCalledWith('new-master-token');
    });
    expect(apiMocks.changeAuthToken).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('cortex_auth_token')).toBe('new-master-token');
  });

  it('keeps existing auth token change flow when a config token exists', async () => {
    const user = userEvent.setup();
    apiMocks.getAuthStatus
      .mockResolvedValueOnce({
        authRequired: true,
        setupRequired: false,
        source: 'config',
        hasAgentTokens: false,
        agentTokenCount: 0,
        mutable: true,
      })
      .mockResolvedValueOnce({
        authRequired: true,
        setupRequired: false,
        source: 'config',
        hasAgentTokens: false,
        agentTokenCount: 0,
        mutable: true,
      });

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });
    const authCard = screen.getByText(/认证管理/).closest('div[style*="background"]');
    expect(authCard).toBeTruthy();

    await user.type(await within(authCard as HTMLElement).findByLabelText('当前令牌'), 'old-master-token');
    await user.type(await within(authCard as HTMLElement).findByLabelText('新令牌'), 'new-master-token');
    await user.type(await within(authCard as HTMLElement).findByLabelText('确认新令牌'), 'new-master-token');
    await user.click(within(authCard as HTMLElement).getByRole('button', { name: '修改令牌' }));

    await waitFor(() => {
      expect(apiMocks.changeAuthToken).toHaveBeenCalledWith('old-master-token', 'new-master-token');
    });
    expect(apiMocks.setupAuthToken).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('cortex_auth_token')).toBe('new-master-token');
  });

  it('links Settings maintenance to the Quality Center instead of exposing recall tuning knobs', async () => {
    const user = userEvent.setup();

    renderPage();

    await screen.findByRole('button', { name: '基础设置' });
    await user.click(screen.getByRole('button', { name: '运行召回质量检查' }));

    expect(apiMocks.navigate).toHaveBeenCalledWith('/quality');
    expect(screen.queryByText('搜索与重排')).toBeNull();
    expect(screen.queryByText('记忆注入')).toBeNull();
  });
});

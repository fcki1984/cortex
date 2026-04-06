import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentDetail from './AgentDetail.js';
import { I18nProvider } from '../i18n/index.js';

const navigateMock = vi.fn();

const apiMocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getAgentConfig: vi.fn(),
  checkAuth: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('../api/client.js', () => ({
  getAgent: apiMocks.getAgent,
  updateAgent: apiMocks.updateAgent,
  deleteAgent: apiMocks.deleteAgent,
  getAgentConfig: apiMocks.getAgentConfig,
  checkAuth: apiMocks.checkAuth,
  getConfig: apiMocks.getConfig,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'agent-1' }),
    useNavigate: () => navigateMock,
  };
});

function renderPage() {
  return render(
    <I18nProvider>
      <AgentDetail />
    </I18nProvider>,
  );
}

function installLocale() {
  window.localStorage.setItem('cortex-locale', 'zh');
}

function buildAgent(configOverride?: any) {
  return {
    id: 'agent-1',
    name: '测试智能体',
    description: '用于 retain mission 测试',
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    config_override: configOverride ?? null,
    stats: {
      total: 0,
      active: 0,
      inactive: 0,
      kinds: {},
      sources: {},
    },
  };
}

function buildMergedConfig(retainMission: string, hasOverride = false) {
  return {
    has_override: hasOverride,
    config: {
      llm: {
        extraction: { provider: 'openai', model: 'gpt-5.4', hasApiKey: false, baseUrl: '' },
        lifecycle: { provider: 'openai', model: 'gpt-5.4', hasApiKey: false, baseUrl: '' },
      },
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        hasApiKey: false,
        baseUrl: '',
      },
      sieve: {
        retainMission,
      },
    },
  };
}

describe('AgentDetail retain mission override', () => {
  beforeEach(() => {
    installLocale();
    apiMocks.getAgent.mockResolvedValue(buildAgent());
    apiMocks.getAgentConfig.mockResolvedValue(buildMergedConfig('保留长期偏好、稳定背景和持续任务'));
    apiMocks.getConfig.mockResolvedValue({
      sieve: {
        retainMission: '保留长期偏好、稳定背景和持续任务',
      },
    });
    apiMocks.checkAuth.mockResolvedValue({ authRequired: false });
    apiMocks.updateAgent.mockResolvedValue(buildAgent({
      sieve: {
        retainMission: '只保留长期偏好和稳定背景，不保留短期任务',
      },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('supports agent-specific mission override and clearing back to inherit', async () => {
    const user = userEvent.setup();
    apiMocks.getAgentConfig
      .mockResolvedValueOnce(buildMergedConfig('保留长期偏好、稳定背景和持续任务'))
      .mockResolvedValueOnce(buildMergedConfig('只保留长期偏好和稳定背景，不保留短期任务', true))
      .mockResolvedValueOnce(buildMergedConfig('保留长期偏好、稳定背景和持续任务'));

    renderPage();

    await screen.findByRole('button', { name: '配置' });
    await user.click(screen.getByRole('button', { name: '配置' }));

    const configCard = screen.getByText('配置覆盖').closest('.card');
    expect(configCard).toBeTruthy();
    expect(within(configCard as HTMLElement).getByText('当前生效 Mission')).toBeTruthy();
    expect(within(configCard as HTMLElement).getByText('保留长期偏好、稳定背景和持续任务')).toBeTruthy();

    await user.click(within(configCard as HTMLElement).getByRole('button', { name: '编辑' }));
    await user.click(within(configCard as HTMLElement).getByLabelText('使用智能体专属 Mission'));
    const missionField = within(configCard as HTMLElement).getByLabelText('智能体专属 Mission');
    await user.type(missionField, '只保留长期偏好和稳定背景，不保留短期任务');
    await user.click(within(configCard as HTMLElement).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(apiMocks.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
        config_override: expect.objectContaining({
          sieve: {
            retainMission: '只保留长期偏好和稳定背景，不保留短期任务',
          },
        }),
      }));
    });

    await user.click(within(configCard as HTMLElement).getByRole('button', { name: '编辑' }));
    await user.click(within(configCard as HTMLElement).getByLabelText('继承全局默认 Mission'));
    await user.click(within(configCard as HTMLElement).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(apiMocks.updateAgent).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({
        config_override: expect.objectContaining({
          sieve: {
            retainMission: null,
          },
        }),
      }));
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QualityCenter from './QualityCenter.js';
import { I18nProvider } from '../i18n/index.js';

const apiMocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  createRecordV2: vi.fn(),
  deleteRecordV2: vi.fn(),
  recallV2: vi.fn(),
  listRelationCandidatesV2: vi.fn(),
  deleteRelationCandidateV2: vi.fn(),
  listRelationsV2: vi.fn(),
  deleteRelationV2: vi.fn(),
}));

vi.mock('../api/client.js', () => ({
  createAgent: apiMocks.createAgent,
  deleteAgent: apiMocks.deleteAgent,
  createRecordV2: apiMocks.createRecordV2,
  deleteRecordV2: apiMocks.deleteRecordV2,
  recallV2: apiMocks.recallV2,
  listRelationCandidatesV2: apiMocks.listRelationCandidatesV2,
  deleteRelationCandidateV2: apiMocks.deleteRelationCandidateV2,
  listRelationsV2: apiMocks.listRelationsV2,
  deleteRelationV2: apiMocks.deleteRelationV2,
}));

function installLocale() {
  window.localStorage.setItem('cortex-locale', 'zh');
}

function renderPage() {
  return render(
    <I18nProvider>
      <QualityCenter />
    </I18nProvider>,
  );
}

function recallResponse(overrides: Record<string, unknown> = {}) {
  return {
    context: 'Facts\n- 我住大阪',
    rules: [],
    facts: [{ content: '我住大阪', kind: 'fact_slot', attribute_key: 'location' }],
    task_state: [],
    session_notes: [],
    meta: {
      normalized_intents: { attributes: ['location'] },
      relevance_basis: [{ kind: 'fact_slot', attribute_key: 'location' }],
      reason: null,
    },
    ...overrides,
  };
}

describe('QualityCenter page', () => {
  beforeEach(() => {
    installLocale();
    apiMocks.createAgent.mockResolvedValue({ id: 'quality-probe' });
    apiMocks.createRecordV2.mockImplementation(async (payload: any) => ({
      record: {
        id: `record-${payload.content}`,
        ...payload,
      },
    }));
    apiMocks.listRelationCandidatesV2.mockResolvedValue({ items: [{ id: 'relcand-1', predicate: 'works_at', object_key: 'openai' }] });
    apiMocks.listRelationsV2.mockResolvedValue({ items: [] });
    apiMocks.deleteRecordV2.mockResolvedValue({ ok: true });
    apiMocks.deleteRelationCandidateV2.mockResolvedValue({ ok: true });
    apiMocks.deleteRelationV2.mockResolvedValue({ ok: true });
    apiMocks.deleteAgent.mockResolvedValue({ ok: true });
    apiMocks.recallV2
      .mockResolvedValueOnce(recallResponse())
      .mockResolvedValueOnce(recallResponse({
        context: 'Facts\n- 我在 OpenAI 工作',
        facts: [{ content: '我在 OpenAI 工作', kind: 'fact_slot', attribute_key: 'organization' }],
        meta: {
          normalized_intents: { attributes: ['organization'] },
          relevance_basis: [{ kind: 'fact_slot', attribute_key: 'organization' }],
          reason: null,
        },
      }))
      .mockResolvedValueOnce(recallResponse({
        context: 'Rules\n- 请用中文回答',
        rules: [{ content: '请用中文回答', kind: 'profile_rule', attribute_key: 'language_preference' }],
        facts: [],
        meta: {
          normalized_intents: { attributes: ['language_preference'] },
          relevance_basis: [{ kind: 'profile_rule', attribute_key: 'language_preference' }],
          reason: null,
        },
      }))
      .mockResolvedValueOnce(recallResponse({
        context: 'Task State\n- 当前任务是重构 Cortex recall',
        facts: [],
        task_state: [{ content: '当前任务是重构 Cortex recall', kind: 'task_state', state_key: 'refactor_status' }],
        meta: {
          normalized_intents: { attributes: ['refactor_status'] },
          relevance_basis: [{ kind: 'task_state', state_key: 'refactor_status' }],
          reason: null,
        },
      }))
      .mockResolvedValueOnce(recallResponse({
        context: '',
        facts: [],
        session_notes: [],
        meta: {
          normalized_intents: { attributes: [] },
          relevance_basis: [],
          reason: 'low_relevance',
        },
      }))
      .mockResolvedValueOnce(recallResponse({
        context: 'Facts\n- 我住东京',
        facts: [{ content: '我住东京', kind: 'fact_slot', attribute_key: 'location' }],
        meta: {
          normalized_intents: { attributes: ['location'] },
          relevance_basis: [{ kind: 'fact_slot', attribute_key: 'location' }],
          reason: null,
        },
      }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('runs recall quality scenarios with a probe agent and cleans them up', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: '运行质量检查' }));

    expect(await screen.findByText('location')).toBeTruthy();
    expect(await screen.findByText('organization')).toBeTruthy();
    expect(await screen.findByText('note-only negative')).toBeTruthy();
    expect(await screen.findByText('newest winner')).toBeTruthy();
    expect(await screen.findAllByText('通过')).toHaveLength(6);

    const noteScenario = screen.getByText('note-only negative').closest('.card');
    expect(noteScenario).toBeTruthy();
    expect(within(noteScenario as HTMLElement).getAllByText(/low_relevance/).length).toBeGreaterThan(0);
    expect(within(noteScenario as HTMLElement).getByText('未注入上下文')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '清理 probe agent' }));

    await waitFor(() => {
      expect(apiMocks.deleteRecordV2).toHaveBeenCalled();
      expect(apiMocks.deleteRelationCandidateV2).toHaveBeenCalledWith('relcand-1');
      expect(apiMocks.deleteAgent).toHaveBeenCalled();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportExport from './ImportExport.js';
import { I18nProvider } from '../i18n/index.js';

const apiMocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  previewImportV2: vi.fn(),
  confirmImportV2: vi.fn(),
  exportBundleV2: vi.fn(),
  createReviewInboxImportV2: vi.fn(),
}));

vi.mock('../api/client.js', () => ({
  listAgents: apiMocks.listAgents,
  previewImportV2: apiMocks.previewImportV2,
  confirmImportV2: apiMocks.confirmImportV2,
  exportBundleV2: apiMocks.exportBundleV2,
  createReviewInboxImportV2: apiMocks.createReviewInboxImportV2,
}));

function renderPage() {
  return render(
    <I18nProvider>
      <ImportExport />
    </I18nProvider>,
  );
}

function installLocale() {
  window.localStorage.setItem('cortex-locale', 'zh');
}

const previewResponse = {
  record_candidates: [{
    candidate_id: 'record_1',
    selected: true,
    requested_kind: 'profile_rule',
    normalized_kind: 'profile_rule',
    content: '请用中文回答',
    source_type: 'user_confirmed',
    tags: [],
    priority: 0.8,
    confidence: 0.95,
    owner_scope: 'user',
    subject_key: 'user',
    attribute_key: 'language_preference',
    source_excerpt: '请用中文回答',
    warnings: [],
  }],
  relation_candidates: [],
  warnings: [],
  stats: {
    format: 'text',
    total_segments: 1,
    record_candidates: 1,
    relation_candidates: 0,
  },
};

describe('ImportExport page', () => {
  beforeEach(() => {
    installLocale();
    apiMocks.listAgents.mockResolvedValue({
      agents: [
        { id: 'default', name: '默认智能体' },
        { id: 'mcp', name: 'MCP' },
      ],
    });
    apiMocks.previewImportV2.mockResolvedValue(previewResponse);
    apiMocks.confirmImportV2.mockResolvedValue({
      summary: {
        committed: 1,
        skipped: 0,
        failed: 0,
        relation_candidates_created: 0,
        confirmed_relations_restored: 0,
      },
      committed: [],
      skipped: [],
      failed: [],
    });
    apiMocks.exportBundleV2.mockResolvedValue({
      schema_version: 'cortex_v2_export',
      scope: 'current_agent',
      agents: [],
      records: {},
      confirmed_relations: [],
    });
    apiMocks.createReviewInboxImportV2.mockResolvedValue({
      batch_id: 'batch_1',
      source_preview: '后续交流中文就行',
      summary: {
        total: 1,
        pending: 1,
        accepted: 0,
        rejected: 0,
        failed: 0,
      },
    });

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('blocks confirm when selected candidates are invalid', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByLabelText('目标智能体');
    await user.type(screen.getByLabelText('来源内容'), '请用中文回答');
    await user.click(screen.getByRole('button', { name: '生成预览' }));

    const candidateContent = await screen.findByLabelText('内容 record_1');
    await user.clear(candidateContent);
    await user.click(screen.getByRole('button', { name: '确认导入' }));

    expect(apiMocks.confirmImportV2).not.toHaveBeenCalled();
    expect(await screen.findByText('所选记录候选必须填写内容后才能提交。')).toBeTruthy();
  });

  it('submits edited preview candidates and shows the returned summary', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByLabelText('目标智能体');
    await user.type(screen.getByLabelText('来源内容'), '请用中文回答');
    await user.click(screen.getByRole('button', { name: '生成预览' }));

    const candidateContent = await screen.findByLabelText('内容 record_1');
    await user.clear(candidateContent);
    await user.type(candidateContent, '请始终用中文回答');
    await user.click(screen.getByRole('button', { name: '确认导入' }));

    await waitFor(() => {
      expect(apiMocks.confirmImportV2).toHaveBeenCalledWith(expect.objectContaining({
        agent_id: 'default',
        record_candidates: [
          expect.objectContaining({
            candidate_id: 'record_1',
            content: '请始终用中文回答',
          }),
        ],
      }));
    });

    expect(await screen.findByText('导入结果')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('exports the current agent bundle from the system page', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByLabelText('目标智能体');
    await user.click(screen.getByRole('button', { name: '导出' }));
    await user.click(screen.getByRole('button', { name: '开始导出' }));

    await waitFor(() => {
      expect(apiMocks.exportBundleV2).toHaveBeenCalledWith({
        scope: 'current_agent',
        agent_id: 'default',
        format: 'json',
      });
    });

    expect(await screen.findByText('导出文件已生成')).toBeTruthy();
  });

  it('recovers agent loading in-page without losing the current draft', async () => {
    const user = userEvent.setup();
    apiMocks.listAgents.mockReset();
    apiMocks.listAgents
      .mockRejectedValueOnce(new Error('API timeout after 20000ms: /api/v2/agents'))
      .mockResolvedValueOnce({
        agents: [
          { id: 'default', name: '默认智能体' },
          { id: 'mcp', name: 'MCP' },
        ],
      });

    renderPage();

    const sourceInput = screen.getByLabelText('来源内容');
    await user.type(sourceInput, '请用中文回答');

    expect(await screen.findByText('智能体列表加载失败，请在页面内重试。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重试加载智能体' }));

    await screen.findByLabelText('目标智能体');
    expect((screen.getByLabelText('来源内容') as HTMLTextAreaElement).value).toBe('请用中文回答');
  });

  it('shows the exported agent scope summary after export completes', async () => {
    const user = userEvent.setup();
    apiMocks.exportBundleV2.mockResolvedValue({
      schema_version: 'cortex_v2_export',
      scope: 'all_agents',
      agents: [
        { id: 'default', name: '默认智能体' },
        { id: 'mcp', name: 'MCP' },
      ],
      records: {
        profile_rules: [],
        fact_slots: [],
        task_states: [],
        session_notes: [],
      },
      confirmed_relations: [],
    });

    renderPage();

    await screen.findByLabelText('目标智能体');
    await user.click(screen.getByRole('button', { name: '导出' }));
    await user.selectOptions(screen.getByLabelText('导出范围'), 'all_agents');
    await user.click(screen.getByRole('button', { name: '开始导出' }));

    expect(await screen.findByText('导出结果')).toBeTruthy();
    expect(screen.getByText('本次导出覆盖 2 个智能体。')).toBeTruthy();
  });

  it('sends text import content to the review inbox from the system page', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByLabelText('目标智能体');
    await user.selectOptions(screen.getByLabelText('来源格式'), 'text');
    await user.type(screen.getByLabelText('来源内容'), '后续交流中文就行');
    await user.click(screen.getByRole('button', { name: '发送到审查箱' }));

    await waitFor(() => {
      expect(apiMocks.createReviewInboxImportV2).toHaveBeenCalledWith({
        agent_id: 'default',
        format: 'text',
        content: '后续交流中文就行',
        filename: undefined,
      });
    });

    expect(await screen.findByText('已发送到审查箱，待处理 1 条。当前待审：后续交流中文就行')).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开对应审查批次' }).getAttribute('href')).toBe('/review-inbox?batch=batch_1');
  });
});

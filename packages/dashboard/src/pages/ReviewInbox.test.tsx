import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReviewInbox from './ReviewInbox.js';
import { I18nProvider } from '../i18n/index.js';

const apiMocks = vi.hoisted(() => ({
  listReviewInboxBatchesV2: vi.fn(),
  getReviewInboxBatchV2: vi.fn(),
  applyReviewInboxBatchV2: vi.fn(),
}));

vi.mock('../api/client.js', () => ({
  listReviewInboxBatchesV2: apiMocks.listReviewInboxBatchesV2,
  getReviewInboxBatchV2: apiMocks.getReviewInboxBatchV2,
  applyReviewInboxBatchV2: apiMocks.applyReviewInboxBatchV2,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage() {
  return render(
    <I18nProvider>
      <ReviewInbox />
    </I18nProvider>,
  );
}

function installLocale() {
  window.localStorage.setItem('cortex-locale', 'zh');
}

const batchSummary = {
  id: 'batch_1',
  agent_id: 'default',
  source_kind: 'live_ingest',
  status: 'pending',
  source_preview: '后续交流中文就行',
  created_at: '2026-03-28T00:00:00.000Z',
  updated_at: '2026-03-28T00:00:00.000Z',
  summary: {
    total: 1,
    pending: 1,
    accepted: 0,
    rejected: 0,
    failed: 0,
  },
};

const batchDetail = {
  batch: batchSummary,
  summary: batchSummary.summary,
  items: [{
    id: 'item_1',
    batch_id: 'batch_1',
    item_type: 'record',
    status: 'pending',
    suggested_action: 'accept',
    suggested_reason: '这条候选已经归一到当前 V2 contract，可直接接受；如表述不顺手，再做轻微改写即可。',
    suggested_rewrite: '请用中文回答',
    payload: {
      candidate_id: 'review_record_1',
      content: '后续交流中文就行',
      requested_kind: 'profile_rule',
      normalized_kind: 'profile_rule',
      attribute_key: 'language_preference',
      source_excerpt: '后续交流中文就行',
      warnings: [],
      confidence: 0.83,
    },
  }],
};

describe('ReviewInbox page', () => {
  beforeEach(() => {
    installLocale();
    apiMocks.listReviewInboxBatchesV2.mockResolvedValue({
      items: [batchSummary],
      total: 1,
      sync: {
        mode: 'full',
        cursor: 'cursor_initial',
      },
    });
    apiMocks.getReviewInboxBatchV2.mockResolvedValue(batchDetail);
    apiMocks.applyReviewInboxBatchV2.mockResolvedValue({
      summary: {
        committed: 1,
        rejected: 0,
        failed: 0,
      },
      batch_summary: {
        total: 1,
        pending: 0,
        accepted: 1,
        rejected: 0,
        failed: 0,
      },
      committed: [{ candidate_id: 'review_record_1' }],
      rejected: [],
      failed: [],
      remaining_pending: 0,
      batch: {
        ...batchSummary,
        status: 'completed',
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('loads the pending batch list and selected batch detail', async () => {
    renderPage();

    expect(await screen.findByText('审查箱')).toBeTruthy();
    expect(await screen.findByText('后续交流中文就行')).toBeTruthy();
    expect(await screen.findByDisplayValue('请用中文回答')).toBeTruthy();
    expect(await screen.findByText('原始候选内容:')).toBeTruthy();
    expect(screen.getByText('这条候选已经归一到当前 V2 contract，可直接接受；如表述不顺手，再做轻微改写即可。')).toBeTruthy();
  });

  it('honors the batch query parameter when opening a specific review batch', async () => {
    const secondBatchSummary = {
      ...batchSummary,
      id: 'batch_2',
      source_preview: '先收一下 recall 那块',
    };
    const secondBatchDetail = {
      batch: secondBatchSummary,
      summary: secondBatchSummary.summary,
      items: [{
        ...batchDetail.items[0],
        id: 'item_2',
        batch_id: 'batch_2',
        suggested_rewrite: '当前任务是重构 Cortex recall',
        payload: {
          ...batchDetail.items[0].payload,
          candidate_id: 'review_record_2',
          content: '先收一下 recall 那块',
          requested_kind: 'task_state',
          normalized_kind: 'task_state',
          state_key: 'refactor_status',
          source_excerpt: '先收一下 recall 那块',
        },
      }],
    };

    apiMocks.listReviewInboxBatchesV2.mockResolvedValueOnce({
      items: [batchSummary, secondBatchSummary],
      total: 2,
    });
    apiMocks.getReviewInboxBatchV2.mockResolvedValueOnce(secondBatchDetail);
    window.history.replaceState({}, '', '/review-inbox?batch=batch_2');

    renderPage();

    expect(await screen.findByText('来源预览: 先收一下 recall 那块')).toBeTruthy();
    expect(await screen.findByDisplayValue('当前任务是重构 Cortex recall')).toBeTruthy();
    expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledWith('batch_2');
  });

  it('keeps the batch list usable when detail loading fails and retries detail in place', async () => {
    const user = userEvent.setup();
    apiMocks.getReviewInboxBatchV2
      .mockRejectedValueOnce(new Error('API timeout after 20000ms: /api/v2/review-inbox/batch_1'))
      .mockResolvedValueOnce(batchDetail);

    renderPage();

    expect(await screen.findByText('后续交流中文就行')).toBeTruthy();
    expect(await screen.findByText('当前批次加载失败，请在页面内重试。')).toBeTruthy();
    expect(screen.getByText('批次列表仍然可用，重试成功后会继续保留当前选择。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重试当前批次' }));

    expect(await screen.findByDisplayValue('请用中文回答')).toBeTruthy();
    expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(1);
    expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(2);
  });

  it('refreshes the batch list in place without dropping the current detail or draft', async () => {
    const user = userEvent.setup();
    const nextBatchSummary = {
      ...batchSummary,
      id: 'batch_2',
      source_preview: '先收一下 recall 那块',
      updated_at: '2026-03-29T00:00:00.000Z',
    };
    const listRefresh = deferred<{
      items: typeof batchSummary[];
      total: number;
      sync: {
        mode: 'full' | 'delta';
        cursor: string;
      };
    }>();
    const detailRefresh = deferred<typeof batchDetail>();

    apiMocks.listReviewInboxBatchesV2
      .mockResolvedValueOnce({
        items: [batchSummary],
        total: 1,
        sync: {
          mode: 'full',
          cursor: 'cursor_initial',
        },
      })
      .mockImplementationOnce(() => listRefresh.promise);
    apiMocks.getReviewInboxBatchV2
      .mockResolvedValueOnce(batchDetail)
      .mockImplementationOnce(() => detailRefresh.promise);

    renderPage();

    const contentField = await screen.findByDisplayValue('请用中文回答');
    await user.clear(contentField);
    await user.type(contentField, '请始终用中文回答');
    await user.click(screen.getByRole('button', { name: '刷新批次' }));

    expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '正在刷新...' })).toBeTruthy();
    expect(screen.getByDisplayValue('请始终用中文回答')).toBeTruthy();

    listRefresh.resolve({
      items: [batchSummary, nextBatchSummary],
      total: 2,
      sync: {
        mode: 'full',
        cursor: 'cursor_refreshed',
      },
    });

    await waitFor(() => {
      expect(apiMocks.getReviewInboxBatchV2).toHaveBeenNthCalledWith(2, 'batch_1');
    });

    detailRefresh.resolve(batchDetail);

    expect(await screen.findByText('先收一下 recall 那块')).toBeTruthy();
    expect(screen.getByDisplayValue('请始终用中文回答')).toBeTruthy();
  });

  it('refreshes the batch list automatically in the background without interrupting the current review', async () => {
    const user = userEvent.setup();
    const nextBatchSummary = {
      ...batchSummary,
      id: 'batch_2',
      source_preview: '先收一下 recall 那块',
      updated_at: '2026-03-29T00:00:00.000Z',
    };
    const intervalCallbacks: Array<{ handler: () => void; timeout: number | undefined }> = [];
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (typeof handler === 'function') {
        intervalCallbacks.push({
          handler: handler as () => void,
          timeout,
        });
      }
      return 1 as unknown as number;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation((() => undefined) as typeof window.clearInterval);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    try {
      apiMocks.listReviewInboxBatchesV2
        .mockResolvedValueOnce({
          items: [batchSummary],
          total: 1,
          sync: {
            mode: 'full',
            cursor: 'cursor_initial',
          },
        })
        .mockResolvedValueOnce({
          items: [nextBatchSummary],
          total: 2,
          sync: {
            mode: 'delta',
            cursor: 'cursor_next',
          },
        });
      apiMocks.getReviewInboxBatchV2.mockResolvedValueOnce(batchDetail);

      renderPage();

      const contentField = await screen.findByDisplayValue('请用中文回答');
      await waitFor(() => {
        expect(intervalCallbacks.some((entry) => entry.timeout === 15000)).toBe(true);
      });
      const autoRefreshCallback = intervalCallbacks.find((entry) => entry.timeout === 15000)?.handler;
      expect(autoRefreshCallback).toBeTruthy();
      await user.clear(contentField);
      await user.type(contentField, '请始终用中文回答');

      await act(async () => {
        autoRefreshCallback?.();
      });

      await waitFor(() => {
        expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(2);
      });
      expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenNthCalledWith(2, { cursor: 'cursor_initial' });

      expect(await screen.findByText('先收一下 recall 那块')).toBeTruthy();
      expect(screen.getByText('新增 1 个待审批次。')).toBeTruthy();
      expect(screen.getByDisplayValue('请始终用中文回答')).toBeTruthy();
      expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(2);
      expect(apiMocks.getReviewInboxBatchV2).toHaveBeenNthCalledWith(2, 'batch_2');
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      } else {
        Reflect.deleteProperty(document as unknown as object, 'visibilityState');
      }
    }
  });

  it('surfaces a sync notice when the selected batch changed remotely without overwriting the current detail or draft', async () => {
    const user = userEvent.setup();
    const remoteUpdatedBatch = {
      ...batchSummary,
      status: 'partially_applied',
      source_preview: '先收一下 recall 那块',
      updated_at: '2026-03-29T00:00:00.000Z',
      summary: {
        total: 1,
        pending: 0,
        accepted: 0,
        rejected: 0,
        failed: 1,
      },
    };
    const intervalCallbacks: Array<{ handler: () => void; timeout: number | undefined }> = [];
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (typeof handler === 'function') {
        intervalCallbacks.push({
          handler: handler as () => void,
          timeout,
        });
      }
      return 1 as unknown as number;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation((() => undefined) as typeof window.clearInterval);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    try {
      apiMocks.listReviewInboxBatchesV2
        .mockResolvedValueOnce({
          items: [batchSummary],
          total: 1,
          sync: {
            mode: 'full',
            cursor: 'cursor_initial',
          },
        })
        .mockResolvedValueOnce({
          items: [remoteUpdatedBatch],
          total: 1,
          sync: {
            mode: 'delta',
            cursor: 'cursor_updated',
          },
        });
      apiMocks.getReviewInboxBatchV2.mockResolvedValueOnce(batchDetail);

      renderPage();

      const contentField = await screen.findByDisplayValue('请用中文回答');
      await waitFor(() => {
        expect(intervalCallbacks.some((entry) => entry.timeout === 15000)).toBe(true);
      });
      const autoRefreshCallback = intervalCallbacks.find((entry) => entry.timeout === 15000)?.handler;
      expect(autoRefreshCallback).toBeTruthy();
      await user.clear(contentField);
      await user.type(contentField, '请始终用中文回答');

      await act(async () => {
        autoRefreshCallback?.();
      });

      await waitFor(() => {
        expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(2);
      });

      expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenNthCalledWith(2, { cursor: 'cursor_initial' });
      expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(1);
      expect(screen.getByText('当前批次有新状态，点“刷新批次”可同步详情。')).toBeTruthy();
      expect(screen.getByDisplayValue('请始终用中文回答')).toBeTruthy();
      expect(screen.getByText('先收一下 recall 那块')).toBeTruthy();
      expect(screen.getByText('来源预览: 后续交流中文就行')).toBeTruthy();
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      } else {
        Reflect.deleteProperty(document as unknown as object, 'visibilityState');
      }
    }
  });

  it('applies accept_all from the response payload without refetching detail', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: '全部接受' });
    await user.click(screen.getByRole('button', { name: '全部接受' }));

    await waitFor(() => {
      expect(apiMocks.applyReviewInboxBatchV2).toHaveBeenCalledWith('batch_1', {
        item_actions: [{
          item_id: 'item_1',
          action: 'edit_then_accept',
          payload_override: {
            content: '请用中文回答',
          },
        }],
      });
    });

    expect(await screen.findByText('当前批次没有待处理项。')).toBeTruthy();
    expect(screen.getAllByText('已完成')).toHaveLength(2);
    expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(1);
    expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(1);
  });

  it('advances to the next actionable batch after finishing the current batch', async () => {
    const user = userEvent.setup();
    const nextBatchSummary = {
      ...batchSummary,
      id: 'batch_2',
      source_preview: '先收一下 recall 那块',
      updated_at: '2026-03-27T00:00:00.000Z',
    };
    const nextBatchDetail = {
      batch: nextBatchSummary,
      summary: nextBatchSummary.summary,
      items: [{
        ...batchDetail.items[0],
        id: 'item_2',
        batch_id: 'batch_2',
        suggested_rewrite: '当前任务是重构 Cortex recall',
        payload: {
          ...batchDetail.items[0].payload,
          candidate_id: 'review_record_2',
          content: '先收一下 recall 那块',
          requested_kind: 'task_state',
          normalized_kind: 'task_state',
          state_key: 'refactor_status',
          source_excerpt: '先收一下 recall 那块',
        },
      }],
    };

    apiMocks.listReviewInboxBatchesV2.mockResolvedValueOnce({
      items: [batchSummary, nextBatchSummary],
      total: 2,
    });
    apiMocks.getReviewInboxBatchV2
      .mockResolvedValueOnce(batchDetail)
      .mockResolvedValueOnce(nextBatchDetail);

    renderPage();

    await screen.findByDisplayValue('请用中文回答');
    await user.click(screen.getByRole('button', { name: '全部接受' }));

    expect(await screen.findByText('来源预览: 先收一下 recall 那块')).toBeTruthy();
    expect(screen.getByDisplayValue('当前任务是重构 Cortex recall')).toBeTruthy();
    expect(window.location.search).toBe('?batch=batch_2');
    const listCard = screen.getByText('待审批次').closest('.card') as HTMLElement | null;
    expect(listCard).toBeTruthy();
    const batchButton = within(listCard!).getAllByRole('button').find((button) => (
      button.textContent?.includes('先收一下 recall 那块')
    ));
    expect(batchButton?.textContent).toContain('先收一下 recall 那块');
    expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(1);
    expect(apiMocks.getReviewInboxBatchV2).toHaveBeenNthCalledWith(2, 'batch_2');
  });

  it('reuses prefetched next-batch detail during auto-advance without an extra detail fetch', async () => {
    const user = userEvent.setup();
    const nextBatchSummary = {
      ...batchSummary,
      id: 'batch_2',
      source_preview: '先收一下 recall 那块',
      updated_at: '2026-03-27T00:00:00.000Z',
    };
    const nextBatchDetail = {
      batch: nextBatchSummary,
      summary: nextBatchSummary.summary,
      items: [{
        ...batchDetail.items[0],
        id: 'item_2',
        batch_id: 'batch_2',
        suggested_rewrite: '当前任务是重构 Cortex recall',
        payload: {
          ...batchDetail.items[0].payload,
          candidate_id: 'review_record_2',
          content: '先收一下 recall 那块',
          requested_kind: 'task_state',
          normalized_kind: 'task_state',
          state_key: 'refactor_status',
          source_excerpt: '先收一下 recall 那块',
        },
      }],
    };

    apiMocks.listReviewInboxBatchesV2.mockResolvedValueOnce({
      items: [batchSummary, nextBatchSummary],
      total: 2,
    });
    apiMocks.getReviewInboxBatchV2
      .mockResolvedValueOnce(batchDetail)
      .mockResolvedValueOnce(nextBatchDetail);

    renderPage();

    await screen.findByDisplayValue('请用中文回答');
    await waitFor(() => {
      expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(2);
      expect(apiMocks.getReviewInboxBatchV2).toHaveBeenNthCalledWith(2, 'batch_2');
    });

    await user.click(screen.getByRole('button', { name: '全部接受' }));

    expect(await screen.findByDisplayValue('当前任务是重构 Cortex recall')).toBeTruthy();
    expect(screen.queryByText('加载中...')).toBeNull();
    expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(2);
  });

  it('updates the current batch locally from the apply response without refetching list/detail', async () => {
    const user = userEvent.setup();
    const compoundBatchSummary = {
      ...batchSummary,
      id: 'batch_compound',
      source_preview: '人在东京这边\n先收一下 recall 那块',
      summary: {
        total: 2,
        pending: 2,
        accepted: 0,
        rejected: 0,
        failed: 0,
      },
    };
    const compoundBatchDetail = {
      batch: compoundBatchSummary,
      summary: compoundBatchSummary.summary,
      items: [
        {
          id: 'item_tokyo',
          batch_id: 'batch_compound',
          item_type: 'record',
          status: 'pending',
          suggested_action: 'accept',
          suggested_reason: '地点信息已经稳定，可直接接受。',
          suggested_rewrite: '我住东京',
          payload: {
            candidate_id: 'candidate_tokyo',
            content: '人在东京这边',
            requested_kind: 'fact_slot',
            normalized_kind: 'fact_slot',
            attribute_key: 'location',
            entity_key: 'user',
            source_excerpt: '人在东京这边',
            warnings: [],
            confidence: 0.84,
          },
        },
        {
          id: 'item_recall',
          batch_id: 'batch_compound',
          item_type: 'record',
          status: 'pending',
          suggested_action: 'accept',
          suggested_reason: '任务状态明确，可继续保留。',
          suggested_rewrite: '当前任务是重构 Cortex recall',
          payload: {
            candidate_id: 'candidate_recall',
            content: '先收一下 recall 那块',
            requested_kind: 'task_state',
            normalized_kind: 'task_state',
            state_key: 'refactor_status',
            subject_key: 'user',
            source_excerpt: '先收一下 recall 那块',
            warnings: [],
            confidence: 0.81,
          },
        },
      ],
    };

    apiMocks.listReviewInboxBatchesV2.mockResolvedValueOnce({
      items: [compoundBatchSummary],
      total: 1,
    });
    apiMocks.getReviewInboxBatchV2.mockResolvedValueOnce(compoundBatchDetail);
    apiMocks.applyReviewInboxBatchV2.mockResolvedValueOnce({
      summary: {
        committed: 1,
        rejected: 0,
        failed: 0,
      },
      batch_summary: {
        total: 2,
        pending: 1,
        accepted: 1,
        rejected: 0,
        failed: 0,
      },
      committed: [{ candidate_id: 'candidate_tokyo' }],
      rejected: [],
      failed: [],
      remaining_pending: 1,
      batch: {
        ...compoundBatchSummary,
        status: 'partially_applied',
        source_preview: '先收一下 recall 那块',
      },
    });

    renderPage();

    await screen.findByDisplayValue('我住东京');
    await user.click(screen.getAllByRole('button', { name: '接受' })[0]!);

    await waitFor(() => {
      expect(screen.queryByText('当前批次没有待处理项。')).toBeNull();
    });
    expect(await screen.findByText('来源预览: 先收一下 recall 那块')).toBeTruthy();
    expect(screen.getAllByText('部分已处理')).toHaveLength(2);
    expect(screen.getAllByText('待处理 1 / 共 2')).toHaveLength(2);
    expect(screen.queryByDisplayValue('我住东京')).toBeNull();
    expect(screen.getByDisplayValue('当前任务是重构 Cortex recall')).toBeTruthy();
    expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(1);
    expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(1);
  });

  it('keeps failed items visible for retry after a local apply failure', async () => {
    const user = userEvent.setup();
    apiMocks.applyReviewInboxBatchV2
      .mockResolvedValueOnce({
        summary: {
          committed: 0,
          rejected: 0,
          failed: 1,
        },
        batch_summary: {
          total: 1,
          pending: 0,
          accepted: 0,
          rejected: 0,
          failed: 1,
        },
        committed: [],
        rejected: [],
        failed: [{
          candidate_id: 'review_record_1',
          error: 'content is required',
        }],
        remaining_pending: 0,
        batch: {
          ...batchSummary,
          status: 'partially_applied',
        },
      })
      .mockResolvedValueOnce({
        summary: {
          committed: 1,
          rejected: 0,
          failed: 0,
        },
        batch_summary: {
          total: 1,
          pending: 0,
          accepted: 1,
          rejected: 0,
          failed: 0,
        },
        committed: [{ candidate_id: 'review_record_1' }],
        rejected: [],
        failed: [],
        remaining_pending: 0,
        batch: {
          ...batchSummary,
          status: 'completed',
        },
      });

    renderPage();

    const contentField = await screen.findByDisplayValue('请用中文回答');
    await user.clear(contentField);
    await user.click(screen.getByRole('button', { name: '编辑后接受' }));

    expect(await screen.findByText(/content is required/)).toBeTruthy();
    expect(screen.getByText('这条候选上次提交失败，修正后可以再次提交，也可以直接拒绝。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新提交' })).toBeTruthy();
    expect(screen.getAllByText('待处理 0 / 共 1，失败 1 条可重试')).toHaveLength(2);

    const retryField = screen.getByLabelText('提交草稿');
    await user.type(retryField, '请始终用中文回答');
    await user.click(screen.getByRole('button', { name: '重新提交' }));

    await waitFor(() => {
      expect(apiMocks.applyReviewInboxBatchV2).toHaveBeenNthCalledWith(2, 'batch_1', {
        item_actions: [{
          item_id: 'item_1',
          action: 'edit_then_accept',
          payload_override: {
            content: '请始终用中文回答',
          },
        }],
      });
    });

    expect(await screen.findByText('当前批次没有待处理项。')).toBeTruthy();
  });

  it('uses the visible draft when accepting an unchanged record item', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByDisplayValue('请用中文回答');
    await user.click(screen.getByRole('button', { name: '接受' }));

    await waitFor(() => {
      expect(apiMocks.applyReviewInboxBatchV2).toHaveBeenCalledWith('batch_1', {
        item_actions: [{
          item_id: 'item_1',
          action: 'edit_then_accept',
          payload_override: {
            content: '请用中文回答',
          },
        }],
      });
    });
  });

  it('submits an edited record with edit_then_accept', async () => {
    const user = userEvent.setup();
    renderPage();

    const contentField = await screen.findByDisplayValue('请用中文回答');
    await user.clear(contentField);
    await user.type(contentField, '请始终用中文回答');
    await user.click(screen.getByRole('button', { name: '编辑后接受' }));

    await waitFor(() => {
      expect(apiMocks.applyReviewInboxBatchV2).toHaveBeenCalledWith('batch_1', {
        item_actions: [{
          item_id: 'item_1',
          action: 'edit_then_accept',
          payload_override: {
            content: '请始终用中文回答',
          },
        }],
      });
    });
  });

  it('applies reject_all from the response payload without refetching detail', async () => {
    const user = userEvent.setup();
    apiMocks.applyReviewInboxBatchV2.mockResolvedValueOnce({
      summary: {
        committed: 0,
        rejected: 1,
        failed: 0,
      },
      batch_summary: {
        total: 1,
        pending: 0,
        accepted: 0,
        rejected: 1,
        failed: 0,
      },
      committed: [],
      rejected: [{ item_id: 'item_1' }],
      failed: [],
      remaining_pending: 0,
      batch: {
        ...batchSummary,
        status: 'dismissed',
      },
    });

    renderPage();

    await screen.findByRole('button', { name: '全部拒绝' });
    await user.click(screen.getByRole('button', { name: '全部拒绝' }));

    expect(await screen.findByText('当前批次没有待处理项。')).toBeTruthy();
    expect(screen.getAllByText('已关闭')).toHaveLength(2);
    expect(apiMocks.listReviewInboxBatchesV2).toHaveBeenCalledTimes(1);
    expect(apiMocks.getReviewInboxBatchV2).toHaveBeenCalledTimes(1);
  });
});

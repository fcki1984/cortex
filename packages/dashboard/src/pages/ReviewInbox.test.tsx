import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    });
    apiMocks.getReviewInboxBatchV2.mockResolvedValue(batchDetail);
    apiMocks.applyReviewInboxBatchV2.mockResolvedValue({
      summary: {
        committed: 1,
        rejected: 0,
        failed: 0,
      },
      committed: [],
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
  });

  it('loads the pending batch list and selected batch detail', async () => {
    renderPage();

    expect(await screen.findByText('审查箱')).toBeTruthy();
    expect(await screen.findByText('后续交流中文就行')).toBeTruthy();
    expect(await screen.findByDisplayValue('请用中文回答')).toBeTruthy();
    expect(await screen.findByText('原始候选内容:')).toBeTruthy();
    expect(screen.getByText('这条候选已经归一到当前 V2 contract，可直接接受；如表述不顺手，再做轻微改写即可。')).toBeTruthy();
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

  it('applies accept_all to the current batch and refreshes the detail', async () => {
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmImportV2,
  getStats,
  previewImportV2,
} from '../../dashboard/src/api/client.ts';

function installBrowserGlobals() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
  });
}

describe('Dashboard API client', () => {
  beforeEach(() => {
    installBrowserGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retries transient GET failures once before surfacing an error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        totals: { total_records: 0 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getStats();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.totals.total_records).toBe(0);
  });

  it('retries import preview once because preview requests are safe to replay', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        record_candidates: [],
        relation_candidates: [],
        warnings: [],
        stats: {
          format: 'text',
          total_segments: 1,
          record_candidates: 0,
          relation_candidates: 0,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await previewImportV2({
      agent_id: 'dashboard-preview-agent',
      format: 'text',
      content: '最近也许会考虑换方案',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.stats.total_segments).toBe(1);
  });

  it('does not retry non-idempotent import confirmation writes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('upstream write failed', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmImportV2({
      agent_id: 'dashboard-confirm-agent',
      record_candidates: [],
      relation_candidates: [],
    })).rejects.toThrow('API 503');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

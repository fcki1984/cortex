import { describe, expect, it, vi } from 'vitest';
import { runBestEffortSteps, runSmokeRequest } from '../../../scripts/smoke-v2-lib.mjs';

describe('smoke-v2 helper library', () => {
  it('retries a retryable safe request once after a transient fetch failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-cortex-request-id': 'req-2',
        },
      }));

    const result = await runSmokeRequest({
      fetchImpl: fetchMock,
      baseUrl: 'https://example.com',
      authToken: 'secret-token',
      smokeRunId: 'smoke-run-1',
      label: 'health',
      method: 'GET',
      path: '/api/v2/health',
      retryable: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
      'x-cortex-smoke-run': 'smoke-run-1',
    });
    expect(result.requestId).toBe('req-2');
    expect(result.json).toEqual({ status: 'ok' });
  });

  it('fails fast for non-retryable writes with a detailed step label', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad gateway', {
      status: 502,
      headers: {
        'x-cortex-request-id': 'req-write-1',
      },
    }));

    await expect(runSmokeRequest({
      fetchImpl: fetchMock,
      baseUrl: 'https://example.com',
      authToken: 'secret-token',
      smokeRunId: 'smoke-run-2',
      label: 'create probe record',
      method: 'POST',
      path: '/api/v2/records',
      body: { kind: 'fact_slot', content: '我住大阪' },
      retryable: false,
    })).rejects.toThrow('create probe record POST /api/v2/records failed with status 502');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies exhausted retryable transport timeouts separately from assertion failures', async () => {
    const timeoutError = new TypeError('fetch failed');
    Object.assign(timeoutError, {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    const fetchMock = vi.fn().mockRejectedValue(timeoutError);

    await expect(runSmokeRequest({
      fetchImpl: fetchMock,
      baseUrl: 'https://example.com',
      authToken: 'secret-token',
      smokeRunId: 'smoke-run-timeout',
      label: 'health',
      method: 'GET',
      path: '/api/v2/health',
      retryable: true,
    })).rejects.toMatchObject({
      smokeClass: 'transport_timeout',
      smokePhase: 'entry',
      attemptsUsed: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records cleanup warnings and continues later cleanup steps', async () => {
    const events: string[] = [];

    const warnings = await runBestEffortSteps([
      {
        label: 'cleanup records',
        run: async () => {
          events.push('records');
          throw new Error('socket hang up');
        },
      },
      {
        label: 'cleanup agent',
        run: async () => {
          events.push('agent');
        },
      },
    ]);

    expect(events).toEqual(['records', 'agent']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cleanup records');
    expect(warnings[0]).toContain('socket hang up');
  });

  it('accepts an explicitly expected non-2xx status for release gate checks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: {
        'content-type': 'application/json',
        'x-cortex-request-id': 'req-404',
      },
    }));

    const result = await runSmokeRequest({
      fetchImpl: fetchMock,
      baseUrl: 'https://example.com',
      authToken: 'secret-token',
      smokeRunId: 'smoke-run-404',
      label: 'legacy route POST /api/v1/recall',
      method: 'POST',
      path: '/api/v1/recall',
      body: { query: 'smoke' },
      expectedStatus: 404,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(404);
    expect(result.requestId).toBe('req-404');
    expect(result.json).toEqual({ error: 'Not found' });
  });

  it('treats a null body as absent so GET-based release checks stay valid', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: {
        'content-type': 'application/json',
        'x-cortex-request-id': 'req-null-body',
      },
    }));

    const result = await runSmokeRequest({
      fetchImpl: fetchMock,
      baseUrl: 'https://example.com',
      authToken: 'secret-token',
      smokeRunId: 'smoke-run-null-body',
      label: 'legacy route GET /api/v1/memories',
      method: 'GET',
      path: '/api/v1/memories',
      body: null,
      expectedStatus: 404,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(result.requestId).toBe('req-null-body');
  });

  it('allows cleanup steps to ignore an already-deleted probe agent', async () => {
    const warnings = await runBestEffortSteps([
      {
        label: 'cleanup agent probe-deleted',
        ignoreError: (error: unknown) => String(error).includes('status 404') && String(error).includes('Agent not found'),
        run: async () => {
          throw new Error('delete probe deleted-agent DELETE /api/v2/agents/probe-deleted failed with status 404: {"error":"Agent not found"}');
        },
      },
    ]);

    expect(warnings).toEqual([]);
  });

  it('waits for rate-limit reset after exhausting the budget on a successful response', async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const now = 1_000;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.ceil((now + 1_200) / 1000)),
      },
    }));

    await runSmokeRequest({
      fetchImpl: fetchMock,
      baseUrl: 'https://example.com',
      label: 'health',
      method: 'GET',
      path: '/api/v2/health',
      now: () => now,
      sleep: sleepMock,
    });

    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1_000);
  });

  it('waits before retrying a safe request that hit rate-limit exhaustion', async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const now = 5_000;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil((now + 1_500) / 1000)),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }));

    const result = await runSmokeRequest({
      fetchImpl: fetchMock,
      baseUrl: 'https://example.com',
      label: 'health',
      method: 'GET',
      path: '/api/v2/health',
      retryable: true,
      now: () => now,
      sleep: sleepMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(result.json).toEqual({ status: 'ok' });
  });
});

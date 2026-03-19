import { afterEach, describe, expect, it, vi } from 'vitest';
import bridgePlugin from '../../cortex-bridge/src/index.ts';

type RegisteredHook = (event: any) => Promise<any>;

function createPluginHarness() {
  const hooks = new Map<string, RegisteredHook>();
  const logs: string[] = [];

  const api = {
    pluginConfig: {
      cortexUrl: 'https://cortex.test',
      authToken: 'test-token',
      agentId: 'bridge-test-agent',
      debug: true,
      contextMessages: 4,
    },
    logger: {
      info: (...args: any[]) => logs.push(args.join(' ')),
      warn: (...args: any[]) => logs.push(args.join(' ')),
      error: (...args: any[]) => logs.push(args.join(' ')),
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerService: vi.fn(),
    on: (name: string, handler: RegisteredHook) => {
      hooks.set(name, handler);
    },
  };

  bridgePlugin.register(api as any);
  return { hooks, logs };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OpenClaw bridge reliability', () => {
  it('waits long enough for agent_end ingestion to succeed under production-like latency', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/api/v2/ingest')) {
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(new Response(JSON.stringify({ records: [{ decision: 'inserted' }] }), {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            }));
          }, 5500);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }

      return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { hooks, logs } = createPluginHarness();
    const handler = hooks.get('agent_end');
    expect(handler).toBeTruthy();

    const promise = handler!({
      messages: [
        { role: 'user', content: '我希望你后续回答时尽量简洁，先给结论，再给必要细节，不要写成很长的说明文。' },
        { role: 'assistant', content: '明白了。后续我会优先给出简洁结论，只在需要时补充必要细节，避免冗长展开。' },
      ],
    });

    await vi.advanceTimersByTimeAsync(12000);
    await promise;

    const ingestCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v2/ingest'));
    expect(ingestCalls).toHaveLength(1);
    expect(logs.some(line => line.includes('agent_end ingest ok=true'))).toBe(true);
    expect(logs.some(line => line.includes('agent_end ingest ok=false'))).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import bridgePlugin from '../../cortex-bridge/src/index.ts';

type RegisteredHook = (event: any) => Promise<any>;

function createPluginHarness() {
  const hooks = new Map<string, RegisteredHook[]>();
  const logs: string[] = [];
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const services: any[] = [];

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
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((command: any) => {
      commands.set(command.name, command);
    }),
    registerService: vi.fn((service: any) => {
      services.push(service);
    }),
    on: (name: string, handler: RegisteredHook) => {
      const list = hooks.get(name) || [];
      list.push(handler);
      hooks.set(name, list);
    },
  };

  bridgePlugin.register(api as any);
  return { hooks, logs, tools, commands, services };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OpenClaw bridge reliability', () => {
  it('infers v2 requested kinds for remember command and tool instead of defaulting to facts', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      return new Response(JSON.stringify({
        decision: 'inserted',
        requested_kind: payload.kind,
        written_kind: payload.kind,
        normalization: payload.kind === 'session_note' ? 'downgraded_to_session_note' : 'durable',
        reason_code: payload.kind === 'session_note' ? 'insufficient_structure' : null,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { tools, commands } = createPluginHarness();

    await tools.get('cortex_remember').execute('1', {
      content: '请用中文回答',
      category: 'fact',
    });
    await tools.get('cortex_remember').execute('2', {
      content: '当前任务是重构 Cortex recall',
      category: 'fact',
    });
    await tools.get('cortex_remember').execute('3', {
      content: '最近也许会考虑换方案',
      category: 'fact',
    });
    await commands.get('cortex_remember').handler({
      args: '不要复杂方案',
      text: '不要复杂方案',
    });

    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body || '{}')));
    expect(payloads[0].kind).toBe('profile_rule');
    expect(payloads[1].kind).toBe('task_state');
    expect(payloads[2].kind).toBe('session_note');
    expect(payloads[3].kind).toBe('profile_rule');
  });

  it('keeps cortex_status online when health succeeds but stats/details time out', async () => {
    let healthCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith('/api/v2/health')) {
        healthCalls += 1;
        if (healthCalls === 1) {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new DOMException('aborted', 'AbortError');
      }
      if (target.includes('/api/v2/stats')) {
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { commands } = createPluginHarness();
    const result = await commands.get('cortex_status').handler({});

    expect(result.text).toContain('✅ Cortex is online');
    expect(result.text).toContain('降级');
    expect(result.text).not.toContain('❌ Cortex is offline');
  });

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
    const handler = hooks.get('agent_end')?.[0];
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

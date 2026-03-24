import type { LLMProvider, LLMCompletionOpts } from './interface.js';
import { createLogger } from '../utils/logger.js';
import { createTimeoutSignal, resolveTimeoutMs } from '../utils/timeout.js';

const log = createLogger('llm-openrouter');
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_REFERER = 'https://github.com/fcki1984/cortex';

/**
 * OpenRouter LLM Provider — routes to any model via OpenRouter's unified API.
 * Uses OpenAI-compatible format.
 */
export class OpenRouterLLMProvider implements LLMProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.model = opts.model || 'anthropic/claude-haiku-4-5';
    this.baseUrl = (opts.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.timeoutMs = resolveTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  async complete(prompt: string, opts?: LLMCompletionOpts): Promise<string> {
    if (!this.apiKey) throw new Error('OpenRouter API key not configured');

    const messages: any[] = [];
    if (opts?.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': process.env.CORTEX_OPENROUTER_REFERER || DEFAULT_REFERER,
        'X-Title': 'Cortex Memory Service',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts?.maxTokens || 500,
        temperature: opts?.temperature ?? 0.3,
      }),
      signal: createTimeoutSignal(this.timeoutMs, DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as any;
    return data.choices?.[0]?.message?.content || '';
  }
}

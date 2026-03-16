import type { EmbeddingProvider } from './interface.js';
import { createLogger } from '../utils/logger.js';
import { createTimeoutSignal, resolveTimeoutMs } from '../utils/timeout.js';

const log = createLogger('embed-google');
const DEFAULT_TIMEOUT_MS = 15000;

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'google';
  readonly dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { apiKey?: string; model?: string; dimensions?: number; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
    this.model = opts.model || 'text-embedding-004';
    this.dimensions = opts.dimensions || 768;
    this.baseUrl = (opts.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    this.timeoutMs = resolveTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error('Google API key not configured');

    // Google embedding API processes one at a time (batch via multiple requests)
    const results: number[][] = [];
    for (const text of texts) {
      const res = await fetch(
        `${this.baseUrl}/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            outputDimensionality: this.dimensions,
          }),
          signal: createTimeoutSignal(this.timeoutMs, DEFAULT_TIMEOUT_MS),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Google Embedding error ${res.status}: ${body}`);
      }

      const data = (await res.json()) as any;
      results.push(data.embedding?.values || []);
    }

    return results;
  }
}

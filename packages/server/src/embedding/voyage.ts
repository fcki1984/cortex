import type { EmbeddingProvider } from './interface.js';
import { createLogger } from '../utils/logger.js';
import { createTimeoutSignal, resolveTimeoutMs } from '../utils/timeout.js';

const log = createLogger('embed-voyage');
const DEFAULT_TIMEOUT_MS = 15000;

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { apiKey?: string; model?: string; dimensions?: number; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey || process.env.VOYAGE_API_KEY || '';
    this.model = opts.model || 'voyage-3-lite';
    this.dimensions = opts.dimensions || 1024;
    this.baseUrl = (opts.baseUrl || 'https://api.voyageai.com/v1').replace(/\/+$/, '');
    this.timeoutMs = resolveTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error('Voyage API key not configured');

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: 'document',
      }),
      signal: createTimeoutSignal(this.timeoutMs, DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Voyage API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as any;
    return data.data.map((d: any) => d.embedding);
  }
}

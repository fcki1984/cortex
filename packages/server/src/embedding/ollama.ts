import type { EmbeddingProvider } from './interface.js';
import { createLogger } from '../utils/logger.js';
import { createTimeoutSignal, resolveTimeoutMs } from '../utils/timeout.js';

const log = createLogger('embed-ollama');
const DEFAULT_TIMEOUT_MS = 30000;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions: number;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { model?: string; dimensions?: number; baseUrl?: string; timeoutMs?: number }) {
    this.model = opts.model || 'bge-m3';
    this.dimensions = opts.dimensions || 1024;
    this.baseUrl = opts.baseUrl || 'http://localhost:11434';
    this.timeoutMs = resolveTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: createTimeoutSignal(this.timeoutMs, DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama Embedding error ${res.status}: ${body}`);
    }

    const data = await res.json() as any;
    return data.embeddings?.[0] || [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch natively, do sequential
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

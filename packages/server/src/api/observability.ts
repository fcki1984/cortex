import type { FastifyReply, FastifyRequest } from 'fastify';
import { metrics } from '../utils/metrics.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api-observability');

type ObservedRouteMeta = {
  route: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  timeoutMs: number;
  metricPrefix: 'v2_route' | 'mcp_route';
};

type ClassifiedError = {
  statusCode: number;
  category: string;
  message: string;
  details: string;
};

type Handler<T> = (req: FastifyRequest, reply: FastifyReply) => Promise<T> | T;

function readSingleHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find(item => typeof item === 'string' && item.trim());
    if (first) return first.trim();
  }
  return undefined;
}

function inferAgentId(req: FastifyRequest): string | undefined {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : undefined;
  const query = (req.query && typeof req.query === 'object') ? req.query as Record<string, unknown> : undefined;
  const fromHeader = readSingleHeader(headers, 'x-agent-id');
  if (fromHeader) return fromHeader;
  if (typeof body?.agent_id === 'string' && body.agent_id.trim()) return body.agent_id.trim();
  if (typeof query?.agent_id === 'string' && query.agent_id.trim()) return query.agent_id.trim();
  return undefined;
}

function inferSmokeRunId(req: FastifyRequest): string | undefined {
  return readSingleHeader(req.headers as Record<string, string | string[] | undefined>, 'x-cortex-smoke-run');
}

function applyTraceHeaders(req: FastifyRequest, reply: FastifyReply) {
  const requestId = typeof req.id === 'string' ? req.id : String(req.id);
  const smokeRunId = inferSmokeRunId(req);
  reply.header('x-cortex-request-id', requestId);
  if (smokeRunId) {
    reply.header('x-cortex-smoke-run', smokeRunId);
  }
  return { requestId, smokeRunId };
}

function classifyError(error: unknown): ClassifiedError {
  const details = error instanceof Error ? error.message : String(error);
  const lower = details.toLowerCase();

  if (lower.includes('sqlite_busy') || lower.includes('database is locked') || lower.includes('database is busy')) {
    return {
      statusCode: 503,
      category: 'db_busy',
      message: 'Database is busy',
      details,
    };
  }

  if (
    error instanceof Error && error.name === 'AbortError' ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout')
  ) {
    if (lower.includes('llm') || lower.includes('model') || lower.includes('openai') || lower.includes('anthropic') || lower.includes('gemini') || lower.includes('deepseek')) {
      return {
        statusCode: 504,
        category: 'llm_timeout',
        message: 'LLM request timed out',
        details,
      };
    }
    if (lower.includes('vector') || lower.includes('embedding') || lower.includes('qdrant') || lower.includes('milvus') || lower.includes('sqlite-vec')) {
      return {
        statusCode: 504,
        category: 'vector_timeout',
        message: 'Vector backend timed out',
        details,
      };
    }
    return {
      statusCode: 504,
      category: 'upstream_timeout',
      message: 'Request timed out',
      details,
    };
  }

  if (
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up')
  ) {
    return {
      statusCode: 502,
      category: 'upstream_error',
      message: 'Upstream request failed',
      details,
    };
  }

  return {
    statusCode: 500,
    category: 'internal_error',
    message: 'Internal server error',
    details,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, route: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${route} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function observedRoute<T>(meta: ObservedRouteMeta, handler: Handler<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<T | { error: string; category: string; details: string }> => {
    const startedAt = Date.now();
    const agentId = inferAgentId(req);
    const trace = applyTraceHeaders(req, reply);

    log.info({
      route: meta.route,
      method: meta.method,
      timeout_ms: meta.timeoutMs,
      agent_id: agentId,
      request_id: trace.requestId,
      smoke_run_id: trace.smokeRunId,
    }, 'Observed route entered');

    try {
      const result = await withTimeout(Promise.resolve(handler(req, reply)), meta.timeoutMs, meta.route);
      const durationMs = Date.now() - startedAt;
      const nearTimeout = durationMs >= Math.max(1000, Math.floor(meta.timeoutMs * 0.8));
      metrics.inc(`${meta.metricPrefix}_requests_total`, { route: meta.route, method: meta.method, status: 'ok' });
      metrics.observe(`${meta.metricPrefix}_latency_ms`, durationMs);
      const logPayload = {
        route: meta.route,
        method: meta.method,
        status_code: reply.statusCode || 200,
        duration_ms: durationMs,
        timeout_ms: meta.timeoutMs,
        near_timeout: nearTimeout,
        agent_id: agentId,
        request_id: trace.requestId,
        smoke_run_id: trace.smokeRunId,
      };
      if (nearTimeout) {
        log.warn(logPayload, 'Observed route near timeout');
      } else {
        log.info(logPayload, 'Observed route completed');
      }
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const classified = classifyError(error);
      reply.code(classified.statusCode);
      metrics.inc(`${meta.metricPrefix}_requests_total`, {
        route: meta.route,
        method: meta.method,
        status: 'error',
        category: classified.category,
      });
      metrics.observe(`${meta.metricPrefix}_latency_ms`, durationMs);
      log.warn({
        route: meta.route,
        method: meta.method,
        status_code: classified.statusCode,
        duration_ms: durationMs,
        timeout_ms: meta.timeoutMs,
        timed_out: classified.category.endsWith('timeout'),
        agent_id: agentId,
        request_id: trace.requestId,
        smoke_run_id: trace.smokeRunId,
        category: classified.category,
        error: classified.details,
      }, 'Observed route failed');
      return {
        error: classified.message,
        category: classified.category,
        details: classified.details,
      };
    }
  };
}

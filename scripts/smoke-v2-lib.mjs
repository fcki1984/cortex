function normalizeHeaders({ authToken, smokeRunId, headers = {}, hasBody }) {
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(smokeRunId ? { 'x-cortex-smoke-run': smokeRunId } : {}),
    ...headers,
  };
}

export function normalizeSmokeBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/mcp/message')) return trimmed.slice(0, -'/mcp/message'.length);
  if (trimmed.endsWith('/mcp')) return trimmed.slice(0, -'/mcp'.length);
  return trimmed;
}

export function resolveSmokeBaseUrl({
  validationBaseUrl,
  baseUrl,
  cliBaseUrl,
  defaultBaseUrl = 'http://localhost:21100',
} = {}) {
  const candidates = [
    { source: 'validation', raw: validationBaseUrl },
    { source: 'base', raw: baseUrl },
    { source: 'cli', raw: cliBaseUrl },
    { source: 'default', raw: defaultBaseUrl },
  ];

  for (const candidate of candidates) {
    const normalized = normalizeSmokeBaseUrl(candidate.raw);
    if (normalized) {
      return {
        baseUrl: normalized,
        source: candidate.source,
      };
    }
  }

  return {
    baseUrl: normalizeSmokeBaseUrl(defaultBaseUrl),
    source: 'default',
  };
}

function maybeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shouldRetryStatus(status) {
  return [408, 425, 429, 502, 503, 504].includes(status);
}

function inferOperationKind(method) {
  return method === 'GET' ? 'read' : 'write';
}

function isRetryableNetworkError(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const causeCode = typeof error.cause === 'object' && error.cause && 'code' in error.cause
    ? String(error.cause.code).toLowerCase()
    : '';
  return (
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('socket hang up') ||
    causeCode === 'etimedout' ||
    causeCode === 'econnreset' ||
    causeCode === 'econnrefused'
  );
}

function createSmokeError(message, meta = {}, cause) {
  const error = new Error(message, cause !== undefined ? { cause } : undefined);
  Object.assign(error, meta);
  return error;
}

function classifyNetworkError(error) {
  if (!(error instanceof Error)) return 'transport_error';
  const message = error.message.toLowerCase();
  const causeCode = typeof error.cause === 'object' && error.cause && 'code' in error.cause
    ? String(error.cause.code).toLowerCase()
    : '';
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    causeCode.includes('timeout')
  ) {
    return 'transport_timeout';
  }
  return 'transport_error';
}

function formatNetworkError(label, method, path, error, attemptsUsed, { smokePhase, operationKind }) {
  const message = error instanceof Error ? error.message : String(error);
  const causeCode = typeof error === 'object' && error && 'cause' in error && error.cause && typeof error.cause === 'object' && 'code' in error.cause
    ? ` (${String(error.cause.code)})`
    : '';
  return createSmokeError(
    `${label} ${method} ${path} failed: ${message}${causeCode}`,
    {
      smokeClass: classifyNetworkError(error),
      smokePhase,
      attemptsUsed,
      label,
      method,
      path,
      operationKind,
    },
    error,
  );
}

function formatStatusError({ label, method, path, response, text, requestId, attemptsUsed, smokePhase, operationKind }) {
  const detail = text ? `: ${text.slice(0, 300)}` : '';
  const requestDetail = requestId ? ` (request_id=${requestId})` : '';
  return createSmokeError(
    `${label} ${method} ${path} failed with status ${response.status}${requestDetail}${detail}`,
    {
      smokeClass: shouldRetryStatus(response.status) ? 'retryable_status' : 'unexpected_status',
      smokePhase,
      attemptsUsed,
      label,
      method,
      path,
      statusCode: response.status,
      requestId,
      operationKind,
    },
  );
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRateLimitHeaders(response) {
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(remaining) || !Number.isFinite(resetSeconds)) return null;
  return {
    remaining,
    resetAtMs: resetSeconds * 1000,
  };
}

async function maybeWaitForRateLimitReset(response, {
  now = () => Date.now(),
  sleep = defaultSleep,
  onRateLimitWait,
} = {}) {
  const rateLimit = parseRateLimitHeaders(response);
  if (!rateLimit || rateLimit.remaining > 0) return false;

  const waitMs = rateLimit.resetAtMs - now() + 100;
  if (waitMs <= 0) return false;

  if (typeof onRateLimitWait === 'function') {
    onRateLimitWait({
      remaining: rateLimit.remaining,
      resetAtMs: rateLimit.resetAtMs,
      waitMs,
    });
  }

  await sleep(waitMs);
  return true;
}

export async function runSmokeRequest({
  fetchImpl = fetch,
  baseUrl,
  authToken,
  smokeRunId,
  label,
  method,
  path,
  body,
  headers,
  retryable = false,
  expectedStatus,
  smokePhase = 'entry',
  now = () => Date.now(),
  sleep = defaultSleep,
  onRateLimitWait,
}) {
  const attempts = retryable ? 2 : 1;
  let lastError;
  const hasBody = body !== undefined && body !== null;
  const operationKind = inferOperationKind(method);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: normalizeHeaders({
          authToken,
          smokeRunId,
          headers,
          hasBody,
        }),
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const json = maybeParseJson(text);
      const requestId = response.headers.get('x-cortex-request-id') || undefined;
      const matchesExpectedStatus = expectedStatus === undefined
        ? response.ok
        : response.status === expectedStatus;

      if (!matchesExpectedStatus) {
        const statusError = formatStatusError({
          label,
          method,
          path,
          response,
          text,
          requestId,
          attemptsUsed: attempt,
          smokePhase,
          operationKind,
        });
        if (retryable && attempt < attempts && shouldRetryStatus(response.status)) {
          if (response.status === 429) {
            await maybeWaitForRateLimitReset(response, { now, sleep, onRateLimitWait });
          }
          lastError = statusError;
          continue;
        }
        throw statusError;
      }

      await maybeWaitForRateLimitReset(response, { now, sleep, onRateLimitWait });
      return {
        response,
        text,
        json,
        requestId,
        attemptsUsed: attempt,
        retried: attempt > 1,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('failed with status')) {
        throw error;
      }
      const networkError = formatNetworkError(label, method, path, error, attempt, {
        smokePhase,
        operationKind,
      });
      if (retryable && attempt < attempts && isRetryableNetworkError(error)) {
        lastError = networkError;
        continue;
      }
      throw networkError;
    }
  }

  throw lastError || new Error(`${label} ${method} ${path} failed`);
}

function formatWarning(stepLabel, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== 'object') {
    return `${stepLabel}: ${message}`;
  }

  const smokeClass = 'smokeClass' in error ? String(error.smokeClass) : null;
  const smokePhase = 'smokePhase' in error ? String(error.smokePhase) : null;
  const operationKind = 'operationKind' in error ? String(error.operationKind) : null;
  const method = 'method' in error ? String(error.method) : null;
  const path = 'path' in error ? String(error.path) : null;
  const attemptsUsed = 'attemptsUsed' in error ? Number(error.attemptsUsed) : null;

  const meta = [
    smokeClass,
    smokePhase,
    operationKind,
    method && path ? `${method} ${path}` : null,
    Number.isFinite(attemptsUsed) ? `attempts=${attemptsUsed}` : null,
  ].filter(Boolean);

  if (meta.length === 0) {
    return `${stepLabel}: ${message}`;
  }

  return `${stepLabel} [${meta.join(' | ')}]: ${message}`;
}

export async function runBestEffortSteps(steps) {
  const warnings = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      if (typeof step.ignoreError === 'function' && step.ignoreError(error)) {
        continue;
      }
      warnings.push(formatWarning(step.label, error));
    }
  }

  return warnings;
}

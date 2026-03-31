function normalizeHeaders({ authToken, smokeRunId, headers = {}, hasBody }) {
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(smokeRunId ? { 'x-cortex-smoke-run': smokeRunId } : {}),
    ...headers,
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

function formatNetworkError(label, method, path, error, attemptsUsed) {
  const message = error instanceof Error ? error.message : String(error);
  const causeCode = typeof error === 'object' && error && 'cause' in error && error.cause && typeof error.cause === 'object' && 'code' in error.cause
    ? ` (${String(error.cause.code)})`
    : '';
  return createSmokeError(
    `${label} ${method} ${path} failed: ${message}${causeCode}`,
    {
      smokeClass: classifyNetworkError(error),
      smokePhase: 'entry',
      attemptsUsed,
      label,
      method,
      path,
    },
    error,
  );
}

function formatStatusError({ label, method, path, response, text, requestId, attemptsUsed }) {
  const detail = text ? `: ${text.slice(0, 300)}` : '';
  const requestDetail = requestId ? ` (request_id=${requestId})` : '';
  return createSmokeError(
    `${label} ${method} ${path} failed with status ${response.status}${requestDetail}${detail}`,
    {
      smokeClass: shouldRetryStatus(response.status) ? 'retryable_status' : 'unexpected_status',
      smokePhase: 'entry',
      attemptsUsed,
      label,
      method,
      path,
      statusCode: response.status,
      requestId,
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
  now = () => Date.now(),
  sleep = defaultSleep,
  onRateLimitWait,
}) {
  const attempts = retryable ? 2 : 1;
  let lastError;
  const hasBody = body !== undefined && body !== null;

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
        const statusError = formatStatusError({ label, method, path, response, text, requestId, attemptsUsed: attempt });
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
      const networkError = formatNetworkError(label, method, path, error, attempt);
      if (retryable && attempt < attempts && isRetryableNetworkError(error)) {
        lastError = networkError;
        continue;
      }
      throw networkError;
    }
  }

  throw lastError || new Error(`${label} ${method} ${path} failed`);
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
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${step.label}: ${message}`);
    }
  }

  return warnings;
}

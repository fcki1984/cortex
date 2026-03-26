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

function formatNetworkError(label, method, path, error) {
  const message = error instanceof Error ? error.message : String(error);
  const causeCode = typeof error === 'object' && error && 'cause' in error && error.cause && typeof error.cause === 'object' && 'code' in error.cause
    ? ` (${String(error.cause.code)})`
    : '';
  return new Error(`${label} ${method} ${path} failed: ${message}${causeCode}`);
}

function formatStatusError({ label, method, path, response, text, requestId }) {
  const detail = text ? `: ${text.slice(0, 300)}` : '';
  const requestDetail = requestId ? ` (request_id=${requestId})` : '';
  return new Error(`${label} ${method} ${path} failed with status ${response.status}${requestDetail}${detail}`);
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
        const statusError = formatStatusError({ label, method, path, response, text, requestId });
        if (retryable && attempt < attempts && shouldRetryStatus(response.status)) {
          lastError = statusError;
          continue;
        }
        throw statusError;
      }

      return { response, text, json, requestId };
    } catch (error) {
      if (error instanceof Error && error.message.includes('failed with status')) {
        throw error;
      }
      const networkError = formatNetworkError(label, method, path, error);
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

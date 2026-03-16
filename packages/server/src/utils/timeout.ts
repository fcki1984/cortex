export function resolveTimeoutMs(timeoutMs: number | undefined, fallbackMs: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  return fallbackMs;
}

export function createTimeoutSignal(timeoutMs: number | undefined, fallbackMs: number): AbortSignal {
  return AbortSignal.timeout(resolveTimeoutMs(timeoutMs, fallbackMs));
}

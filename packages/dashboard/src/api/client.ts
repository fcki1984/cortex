const AUTH = {
  check: '/api/v2/auth/check',
  status: '/api/v2/auth/status',
  setup: '/api/v2/auth/setup',
  changeToken: '/api/v2/auth/change-token',
  verify: '/api/v2/auth/verify',
} as const;
const V2 = {
  health: '/api/v2/health',
  healthComponents: '/api/v2/health/components',
  healthTest: '/api/v2/health/test',
  stats: '/api/v2/stats',
  config: '/api/v2/config',
  configExport: '/api/v2/config/export',
  testLLM: '/api/v2/test-llm',
  testEmbedding: '/api/v2/test-embedding',
  testReranker: '/api/v2/test-reranker',
  export: '/api/v2/export',
  importPreview: '/api/v2/import/preview',
  importConfirm: '/api/v2/import/confirm',
  reindex: '/api/v2/reindex',
  update: '/api/v2/update',
  agents: '/api/v2/agents',
  extractionLogs: '/api/v2/extraction-logs',
  logLevel: '/api/v2/log-level',
  logs: '/api/v2/logs',
  recall: '/api/v2/recall',
  ingest: '/api/v2/ingest',
  records: '/api/v2/records',
  relationCandidates: '/api/v2/relation-candidates',
  relations: '/api/v2/relations',
  lifecycle: '/api/v2/lifecycle',
  feedback: '/api/v2/feedback',
  reviewInbox: '/api/v2/review-inbox',
} as const;
const TOKEN_KEY = 'cortex_auth_token';
const DEFAULT_READ_TIMEOUT_MS = 8000;
const HEAVY_READ_TIMEOUT_MS = 20000;
const WRITE_TIMEOUT_MS = 15000;
const MAX_NETWORK_RETRIES = 1;

type RequestPolicy = {
  timeoutMs: number;
  retryable: boolean;
};

function stripQuery(path: string): string {
  return path.split('?')[0] || path;
}

function isRetryableStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
}

function isRetryableNetworkError(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('fetch failed') || message.includes('network') || message.includes('timeout');
}

function buildRequestPolicy(path: string, opts?: RequestInit): RequestPolicy {
  const method = (opts?.method || 'GET').toUpperCase();
  const normalizedPath = stripQuery(path);
  const isHeavyRead = (
    (method === 'GET' && (
      normalizedPath === V2.export ||
      normalizedPath === V2.agents ||
      normalizedPath === V2.extractionLogs ||
      normalizedPath === V2.records ||
      normalizedPath === V2.relationCandidates ||
      normalizedPath === V2.relations ||
      path.includes('refresh=true')
    )) ||
    (method === 'POST' && path === V2.importPreview)
  );

  return {
    timeoutMs: method === 'GET'
      ? (isHeavyRead ? HEAVY_READ_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS)
      : (normalizedPath === V2.importPreview ? HEAVY_READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    retryable: method === 'GET' || path === V2.importPreview,
  };
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function parseJsonResponse(res: Response) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ============ Token Management ============

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ============ Auth API (public, no token needed) ============

export async function checkAuth(): Promise<{ authRequired: boolean }> {
  const res = await fetch(AUTH.check);
  if (!res.ok) return { authRequired: false };
  return res.json();
}

export async function verifyToken(token: string): Promise<{ valid: boolean }> {
  const res = await fetch(AUTH.verify, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return { valid: false };
  return res.json();
}

export async function getAuthStatus(): Promise<{
  authRequired: boolean;
  setupRequired: boolean;
  source: 'env' | 'config' | 'none';
  hasAgentTokens: boolean;
  agentTokenCount: number;
  mutable: boolean;
}> {
  const res = await fetch(AUTH.status);
  if (!res.ok) {
    throw new Error(`API ${res.status}: unable to fetch auth status`);
  }
  return res.json();
}

export async function setupAuthToken(token: string): Promise<any> {
  const res = await fetch(AUTH.setup, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `API ${res.status}: setup failed`);
  }
  return data;
}

export async function changeAuthToken(oldToken: string, newToken: string): Promise<any> {
  const stored = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (stored) headers.Authorization = `Bearer ${stored}`;
  const res = await fetch(AUTH.changeToken, {
    method: 'POST',
    headers,
    body: JSON.stringify({ oldToken, newToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `API ${res.status}: change-token failed`);
  }
  return data;
}

// ============ Authenticated Request ============

async function request(path: string, opts?: RequestInit) {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    ...opts?.headers as Record<string, string>,
  };
  if (opts?.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const policy = buildRequestPolicy(path, opts);

  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt += 1) {
    const timeout = createTimeoutSignal(policy.timeoutMs);
    try {
      const res = await fetch(path, { ...opts, headers, signal: timeout.signal });
      timeout.cancel();

      if (res.status === 401 || res.status === 403) {
        clearStoredToken();
        window.dispatchEvent(new CustomEvent('cortex:auth-expired'));
        throw new Error(`API ${res.status}: Unauthorized`);
      }
      if (!res.ok) {
        if (policy.retryable && attempt < MAX_NETWORK_RETRIES && isRetryableStatus(res.status)) {
          continue;
        }
        const body = await res.text();
        throw new Error(`API ${res.status}: ${body}`);
      }
      return parseJsonResponse(res);
    } catch (error) {
      timeout.cancel();
      if (policy.retryable && attempt < MAX_NETWORK_RETRIES && isRetryableNetworkError(error)) {
        continue;
      }
      if (isAbortError(error)) {
        throw new Error(`API timeout after ${policy.timeoutMs}ms: ${path}`);
      }
      throw error;
    }
  }

  throw new Error(`API request failed after retry: ${path}`);
}

// Health
export const getHealth = (refresh = false) => request(`${V2.health}${refresh ? '?refresh=true' : ''}`);
export const getComponentHealth = () => request(V2.healthComponents);

// Stats
export const getStats = (agentId?: string) =>
  request(`${V2.stats}${agentId ? `?agent_id=${agentId}` : ''}`);
export const getStatsV2 = (agentId?: string) =>
  request(`${V2.stats}${agentId ? `?agent_id=${agentId}` : ''}`);

// Config
export const getConfig = () => request(V2.config);
export const exportFullConfig = () => request(V2.configExport);

export const updateConfig = (data: any) =>
  request(V2.config, { method: 'PATCH', body: JSON.stringify(data) });

// Test connections
export const testLLM = (target: 'extraction' | 'lifecycle') =>
  request(V2.testLLM, { method: 'POST', body: JSON.stringify({ target }) });

export const testEmbedding = () =>
  request(V2.testEmbedding, { method: 'POST' });

export const testReranker = () =>
  request(V2.testReranker, { method: 'POST' });

// Import / Export v2
export const previewImportV2 = (data: {
  agent_id: string;
  format: 'json' | 'memory_md' | 'text';
  content: string;
  filename?: string;
}) =>
  request(V2.importPreview, { method: 'POST', body: JSON.stringify(data) });

export const confirmImportV2 = (data: {
  agent_id: string;
  record_candidates: any[];
  relation_candidates: any[];
}) =>
  request(V2.importConfirm, { method: 'POST', body: JSON.stringify(data) });

export const exportBundleV2 = (params?: {
  scope?: 'current_agent' | 'all_agents';
  agent_id?: string;
  format?: 'json' | 'memory_md';
}) => {
  const qs = new URLSearchParams();
  if (params?.scope) qs.set('scope', params.scope);
  if (params?.agent_id) qs.set('agent_id', params.agent_id);
  if (params?.format) qs.set('format', params.format);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request(`${V2.export}${suffix}`);
};

export const listReviewInboxBatchesV2 = (params?: {
  agent_id?: string;
  status?: 'pending' | 'partially_applied' | 'completed' | 'dismissed';
  source_kind?: 'live_ingest' | 'import_preview';
  limit?: number | string;
  offset?: number | string;
  cursor?: string;
}) => {
  const qs = new URLSearchParams();
  if (params?.agent_id) qs.set('agent_id', params.agent_id);
  if (params?.status) qs.set('status', params.status);
  if (params?.source_kind) qs.set('source_kind', params.source_kind);
  if (params?.limit != null) qs.set('limit', String(params.limit));
  if (params?.offset != null) qs.set('offset', String(params.offset));
  if (params?.cursor) qs.set('cursor', params.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request(`${V2.reviewInbox}${suffix}`);
};

export const getReviewInboxBatchV2 = (id: string) =>
  request(`${V2.reviewInbox}/${id}`);

export const applyReviewInboxBatchV2 = (id: string, data: {
  accept_all?: boolean;
  reject_all?: boolean;
  item_actions?: Array<{
    item_id: string;
    action: 'accept' | 'reject' | 'edit_then_accept';
    payload_override?: Record<string, unknown>;
  }>;
}) =>
  request(`${V2.reviewInbox}/${id}/apply`, { method: 'POST', body: JSON.stringify(data) });

export const createReviewInboxImportV2 = (data: {
  agent_id: string;
  format: 'text' | 'memory_md';
  content: string;
  filename?: string;
}) =>
  request(`${V2.reviewInbox}/import`, { method: 'POST', body: JSON.stringify(data) });

// Reindex
export const triggerReindex = () =>
  request(V2.reindex, { method: 'POST' });

// Self-update
export const triggerUpdate = () =>
  request(V2.update, { method: 'POST' });

// Agents
export const listAgents = () => request(V2.agents);

export const getAgent = (id: string) => request(`${V2.agents}/${id}`);

export const createAgent = (data: { id: string; name: string; description?: string; config_override?: any }) =>
  request(V2.agents, { method: 'POST', body: JSON.stringify(data) });

export const updateAgent = (id: string, data: any) =>
  request(`${V2.agents}/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteAgent = (id: string) =>
  request(`${V2.agents}/${id}`, { method: 'DELETE' });

export const getAgentConfig = (id: string) => request(`${V2.agents}/${id}/config`);

// Extraction Logs
export const getExtractionLogs = (agentId?: string, opts?: { limit?: number; offset?: number; channel?: string; status?: string; from?: string; to?: string }) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agent_id', agentId);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.channel) params.set('channel', opts.channel);
  if (opts?.status) params.set('status', opts.status);
  if (opts?.from) params.set('from', opts.from);
  if (opts?.to) params.set('to', opts.to);
  return request(`${V2.extractionLogs}?${params}`);
};

// Log Level
export const getLogLevel = () => request(V2.logLevel);
export const setLogLevel = (level: string) =>
  request(V2.logLevel, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }) });
export const getSystemLogs = (limit = 100, level?: string) => {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (level) params.set('level', level);
  return request(`${V2.logs}?${params}`);
};

// Test connections
export const testConnections = () =>
  request(V2.healthTest, { method: 'POST' });

// Search/Recall test
export const testRecall = (query: string, agentId?: string) =>
  request(V2.recall, { method: 'POST', body: JSON.stringify({ query, agent_id: agentId, limit: 10, skip_filters: true }) });

// V2 Records
export const listRecordsV2 = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request(`${V2.records}${qs}`);
};

export const getRecordV2 = (id: string) => request(`${V2.records}/${id}`);

export const createRecordV2 = (data: any) =>
  request(V2.records, { method: 'POST', body: JSON.stringify(data) });

export const updateRecordV2 = (id: string, data: any) =>
  request(`${V2.records}/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteRecordV2 = (id: string) =>
  request(`${V2.records}/${id}`, { method: 'DELETE' });

export const recallV2 = (data: any) =>
  request(V2.recall, { method: 'POST', body: JSON.stringify(data) });

export const ingestV2 = (data: any) =>
  request(V2.ingest, { method: 'POST', body: JSON.stringify(data) });

export const listRelationsV2 = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request(`${V2.relations}${qs}`);
};

export const listRelationCandidatesV2 = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request(`${V2.relationCandidates}${qs}`);
};

export const createRelationCandidateV2 = (data: any) =>
  request(V2.relationCandidates, { method: 'POST', body: JSON.stringify(data) });

export const updateRelationCandidateV2 = (id: string, data: any) =>
  request(`${V2.relationCandidates}/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const confirmRelationCandidateV2 = (id: string) =>
  request(`${V2.relationCandidates}/${id}/confirm`, { method: 'POST' });

export const deleteRelationCandidateV2 = (id: string) =>
  request(`${V2.relationCandidates}/${id}`, { method: 'DELETE' });

export const createRelationV2 = (data: any) =>
  request(V2.relations, { method: 'POST', body: JSON.stringify(data) });

export const deleteRelationV2 = (id: string) =>
  request(`${V2.relations}/${id}`, { method: 'DELETE' });

export const previewLifecycleV2 = (agentId?: string) =>
  request(`${V2.lifecycle}/preview${agentId ? `?agent_id=${agentId}` : ''}`);

export const runLifecycleV2 = (agentId?: string) =>
  request(`${V2.lifecycle}/run`, { method: 'POST', body: JSON.stringify({ agent_id: agentId }) });

export const getLifecycleLogsV2 = (limit = 50, agentId?: string, offset = 0) =>
  request(`${V2.lifecycle}/log?limit=${limit}&offset=${offset}${agentId ? `&agent_id=${agentId}` : ''}`);

export const submitFeedbackV2 = (data: any) =>
  request(V2.feedback, { method: 'POST', body: JSON.stringify(data) });

export const getFeedbackStatsV2 = (agentId?: string) =>
  request(`${V2.feedback}/stats${agentId ? `?agent_id=${agentId}` : ''}`);

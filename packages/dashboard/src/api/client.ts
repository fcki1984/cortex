const LEGACY_BASE = '/api/v1';
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
  import: '/api/v2/import',
  reindex: '/api/v2/reindex',
  update: '/api/v2/update',
  agents: '/api/v2/agents',
  extractionLogs: '/api/v2/extraction-logs',
  logLevel: '/api/v2/log-level',
  logs: '/api/v2/logs',
  recall: '/api/v2/recall',
  ingest: '/api/v2/ingest',
  records: '/api/v2/records',
  relations: '/api/v2/relations',
  lifecycle: '/api/v2/lifecycle',
  feedback: '/api/v2/feedback',
} as const;
const TOKEN_KEY = 'cortex_auth_token';

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

  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 || res.status === 403) {
    // Token invalid or expired — clear and trigger re-login
    clearStoredToken();
    window.dispatchEvent(new CustomEvent('cortex:auth-expired'));
    throw new Error(`API ${res.status}: Unauthorized`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

async function requestLegacy(path: string, opts?: RequestInit) {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    ...opts?.headers as Record<string, string>,
  };
  if (opts?.body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${LEGACY_BASE}${path}`, { ...opts, headers });
  if (res.status === 401 || res.status === 403) {
    clearStoredToken();
    window.dispatchEvent(new CustomEvent('cortex:auth-expired'));
    throw new Error(`API ${res.status}: Unauthorized`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// Health
export const getHealth = (refresh = false) => request(`${V2.health}${refresh ? '?refresh=true' : ''}`);
export const getComponentHealth = () => request(V2.healthComponents);

// Stats
export const getStats = (agentId?: string) =>
  request(`${V2.stats}${agentId ? `?agent_id=${agentId}` : ''}`);
export const getStatsV2 = (agentId?: string) =>
  request(`${V2.stats}${agentId ? `?agent_id=${agentId}` : ''}`);

// Memories
export const listMemories = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return requestLegacy(`/memories${qs}`);
};

export const getMemory = (id: string) => requestLegacy(`/memories/${id}`);

export const getMemoryChain = (id: string) => requestLegacy(`/memories/${id}/chain`);
export const rollbackMemory = (id: string, targetId: string) =>
  requestLegacy(`/memories/${id}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_id: targetId }) });

export const createMemory = (data: any) =>
  requestLegacy('/memories', { method: 'POST', body: JSON.stringify(data) });

export const updateMemory = (id: string, data: any) =>
  requestLegacy(`/memories/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteMemory = (id: string) =>
  requestLegacy(`/memories/${id}`, { method: 'DELETE' });

// Search
export const search = (data: any) =>
  requestLegacy('/search', { method: 'POST', body: JSON.stringify(data) });

// Recall
export const recall = (data: any) =>
  requestLegacy('/recall', { method: 'POST', body: JSON.stringify(data) });

// Ingest
export const ingest = (data: any) =>
  requestLegacy('/ingest', { method: 'POST', body: JSON.stringify(data) });

// Relations
export const listRelations = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return requestLegacy(`/relations${qs}`);
};

export const createRelation = (data: any) =>
  requestLegacy('/relations', { method: 'POST', body: JSON.stringify(data) });

export const deleteRelation = (id: string) =>
  requestLegacy(`/relations/${id}`, { method: 'DELETE' });

export const findPath = (from: string, to: string) =>
  requestLegacy(`/relations/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

export const getRelationStats = () => requestLegacy('/relations/stats');

// Lifecycle
export const runLifecycle = (dryRun = false, agentId?: string) =>
  requestLegacy('/lifecycle/run', { method: 'POST', body: JSON.stringify({ dry_run: dryRun, agent_id: agentId }) });

export const previewLifecycle = (agentId?: string) =>
  requestLegacy(`/lifecycle/preview${agentId ? `?agent_id=${agentId}` : ''}`);

export const getLifecycleLogs = (limit = 50, agentId?: string, offset = 0) =>
  requestLegacy(`/lifecycle/log?limit=${limit}&offset=${offset}${agentId ? `&agent_id=${agentId}` : ''}`);

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

// Export
export const triggerExport = (format: string = 'json') =>
  request(V2.export, { method: 'POST', body: JSON.stringify({ format }) });

// Import
export const triggerImport = (data: any) =>
  request(V2.import, { method: 'POST', body: JSON.stringify(data) });

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

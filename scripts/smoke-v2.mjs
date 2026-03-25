#!/usr/bin/env node

const rawBaseUrl = process.env.CORTEX_BASE_URL || process.env.CORTEX_URL || process.argv[2] || 'http://localhost:21100';
const authToken = process.env.CORTEX_AUTH_TOKEN || '';
const baseAgentId = process.env.CORTEX_AGENT_ID || `smoke-v2-${Date.now()}`;
const smokeRounds = Math.max(1, Number(process.env.SMOKE_ROUNDS || process.argv[3] || '1'));

function normalizeBaseUrl(rawUrl) {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/mcp/message')) return trimmed.slice(0, -'/mcp/message'.length);
  if (trimmed.endsWith('/mcp')) return trimmed.slice(0, -'/mcp'.length);
  return trimmed;
}

const baseUrl = normalizeBaseUrl(rawBaseUrl);

function authHeaders(extra = {}) {
  return authToken ? { Authorization: `Bearer ${authToken}`, ...extra } : extra;
}

async function request(method, path, { body, headers } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(headers),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label, detail) {
  process.stdout.write(`- ${label}${detail ? `: ${detail}` : ''}\n`);
}

function getAgentId(round) {
  return smokeRounds === 1 ? baseAgentId : `${baseAgentId}-r${round}`;
}

async function cleanup(agentId) {
  const listed = await request('GET', `/api/v2/records?agent_id=${encodeURIComponent(agentId)}&limit=100`);
  if (!listed.response.ok || !listed.json?.items) return;
  for (const item of listed.json.items) {
    await request('DELETE', `/api/v2/records/${item.id}`);
  }
}

async function runRound(round) {
  const agentId = getAgentId(round);
  process.stdout.write(`Cortex V2 smoke test -> ${baseUrl} (agent: ${agentId}, round ${round}/${smokeRounds})\n`);

  const stats = await request('GET', '/api/v2/stats');
  assert(stats.response.status === 200, `GET /api/v2/stats returned ${stats.response.status}`);
  assert(stats.json?.runtime?.legacy_mode === false, 'expected legacy_mode=false');
  assert(stats.json?.runtime?.v1_routes_enabled === false, 'expected v1_routes_enabled=false');
  logStep('v2 stats', 'runtime flags are V2-only');

  const legacyChecks = [
    ['POST', '/api/v1/recall', { query: 'smoke', agent_id: agentId }],
    ['POST', '/api/v1/ingest', { user_message: 'smoke', assistant_message: 'smoke', agent_id: agentId }],
    ['GET', '/api/v1/memories', null],
    ['GET', '/api/v1/relations', null],
    ['GET', '/api/v1/lifecycle/preview', null],
  ];
  for (const [method, path, body] of legacyChecks) {
    const result = await request(method, path, { body });
    assert(result.response.status === 404, `${method} ${path} returned ${result.response.status}, expected 404`);
  }
  logStep('legacy routes', 'write/search chain disabled');

  const createRecord = await request('POST', '/api/v2/records', {
    body: {
      kind: 'fact_slot',
      content: 'Smoke V2 user lives in Taipei',
      entity_key: 'user',
      attribute_key: 'location',
      value_text: 'Taipei',
      agent_id: agentId,
    },
  });
  assert(createRecord.response.status === 201, `POST /api/v2/records returned ${createRecord.response.status}`);

  const ingest = await request('POST', '/api/v2/ingest', {
    body: {
      user_message: '我喜欢简洁回答。',
      assistant_message: '收到，我会保持简洁。',
      agent_id: agentId,
    },
  });
  assert(ingest.response.status === 201, `POST /api/v2/ingest returned ${ingest.response.status}`);

  const recall = await request('POST', '/api/v2/recall', {
    body: {
      query: 'Where does the user live?',
      agent_id: agentId,
    },
  });
  assert(recall.response.status === 200, `POST /api/v2/recall returned ${recall.response.status}`);
  assert(typeof recall.json?.context === 'string', 'v2 recall did not return context');
  logStep('v2 REST', 'records, ingest, recall all passed');

  const mcpHeaders = { 'x-agent-id': agentId };
  const mcpInfo = await request('GET', '/mcp', { headers: mcpHeaders });
  assert(mcpInfo.response.status === 200, `GET /mcp returned ${mcpInfo.response.status}`);
  assert(mcpInfo.json?.endpoints?.jsonrpc_post === '/mcp', 'GET /mcp did not expose primary jsonrpc endpoint');
  assert(mcpInfo.json?.endpoints?.compat_jsonrpc_post === '/mcp/message', 'GET /mcp did not expose compat endpoint');

  const toolsListPayload = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const listPrimary = await request('POST', '/mcp', { headers: mcpHeaders, body: toolsListPayload });
  const listCompat = await request('POST', '/mcp/message', { headers: mcpHeaders, body: toolsListPayload });
  assert(listPrimary.response.status === 200, `POST /mcp returned ${listPrimary.response.status}`);
  assert(listCompat.response.status === 200, `POST /mcp/message returned ${listCompat.response.status}`);
  assert(JSON.stringify(listPrimary.json) === JSON.stringify(listCompat.json), 'MCP tools/list differs between /mcp and /mcp/message');

  const searchPayload = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'cortex_search_debug',
      arguments: { query: 'Smoke V2 Taipei' },
    },
  };
  const searchPrimary = await request('POST', '/mcp', { headers: mcpHeaders, body: searchPayload });
  const searchCompat = await request('POST', '/mcp/message', { headers: mcpHeaders, body: searchPayload });
  assert(searchPrimary.response.status === 200, `POST /mcp search returned ${searchPrimary.response.status}`);
  assert(searchCompat.response.status === 200, `POST /mcp/message search returned ${searchCompat.response.status}`);
  const primaryText = searchPrimary.json?.result?.content?.[0]?.text;
  const compatText = searchCompat.json?.result?.content?.[0]?.text;
  assert(typeof primaryText === 'string' && primaryText.includes('Smoke V2 user lives in Taipei'), 'primary MCP search did not find smoke record');
  assert(typeof compatText === 'string' && compatText.includes('Smoke V2 user lives in Taipei'), 'compat MCP search did not find smoke record');
  assert(primaryText === compatText, 'MCP search result differs between /mcp and /mcp/message');
  logStep('MCP', 'primary and compat JSON-RPC endpoints behave identically');

  await cleanup(agentId);
  logStep('cleanup', 'removed smoke records');
}

async function main() {
  for (let round = 1; round <= smokeRounds; round += 1) {
    await runRound(round);
  }
  process.stdout.write(`Smoke test passed (${smokeRounds} rounds).\n`);
}

main().catch(async (error) => {
  process.stderr.write(`Smoke test failed: ${error.message}\n`);
  try {
    for (let round = 1; round <= smokeRounds; round += 1) {
      await cleanup(getAgentId(round));
    }
  } catch {}
  process.exit(1);
});

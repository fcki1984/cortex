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

function query(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `?${suffix}` : '';
}

function bundleRecords(bundle) {
  return [
    ...(bundle?.records?.profile_rules || []),
    ...(bundle?.records?.fact_slots || []),
    ...(bundle?.records?.task_states || []),
    ...(bundle?.records?.session_notes || []),
  ];
}

async function deleteById(pathPrefix, items) {
  for (const item of items || []) {
    if (!item?.id) continue;
    await request('DELETE', `${pathPrefix}/${encodeURIComponent(item.id)}`);
  }
}

async function cleanupAgent(agentId) {
  const records = await request('GET', `/api/v2/records${query({ agent_id: agentId, limit: 200 })}`);
  if (records.response.ok && Array.isArray(records.json?.items)) {
    await deleteById('/api/v2/records', records.json.items);
  }

  const relations = await request('GET', `/api/v2/relations${query({ agent_id: agentId, limit: 200 })}`);
  if (relations.response.ok && Array.isArray(relations.json?.items)) {
    await deleteById('/api/v2/relations', relations.json.items);
  }

  const candidates = await request('GET', `/api/v2/relation-candidates${query({ agent_id: agentId, limit: 200 })}`);
  if (candidates.response.ok && Array.isArray(candidates.json?.items)) {
    await deleteById('/api/v2/relation-candidates', candidates.json.items);
  }

  if (!['default', 'mcp'].includes(agentId)) {
    await request('DELETE', `/api/v2/agents/${encodeURIComponent(agentId)}`);
  }
}

async function cleanup(agentIds) {
  const uniqueAgentIds = Array.from(new Set(agentIds.filter(Boolean)));
  for (const agentId of uniqueAgentIds) {
    await cleanupAgent(agentId);
  }
}

async function confirmFirstCandidate(agentId, predicate) {
  const candidates = await request('GET', `/api/v2/relation-candidates${query({ agent_id: agentId, status: 'pending', limit: 50 })}`);
  assert(candidates.response.status === 200, `GET /api/v2/relation-candidates returned ${candidates.response.status}`);
  const candidate = (candidates.json?.items || []).find((item) => item.predicate === predicate) || candidates.json?.items?.[0];
  assert(candidate?.id, `No pending relation candidate found for ${agentId}`);
  const confirmed = await request('POST', `/api/v2/relation-candidates/${encodeURIComponent(candidate.id)}/confirm`);
  assert(confirmed.response.status === 201, `POST /api/v2/relation-candidates/:id/confirm returned ${confirmed.response.status}`);
  return candidate;
}

async function runRound(round) {
  const probeAgentId = getAgentId(round);
  const roundtripSourceAgentId = `${probeAgentId}-src`;
  const roundtripTargetAgentId = `${probeAgentId}-dst`;
  const deletedAgentId = `${probeAgentId}-deleted`;
  const cleanupAgentIds = [probeAgentId, roundtripSourceAgentId, roundtripTargetAgentId, deletedAgentId];

  process.stdout.write(`Cortex V2 smoke test -> ${baseUrl} (agent: ${probeAgentId}, round ${round}/${smokeRounds})\n`);

  try {
    for (let i = 0; i < 3; i += 1) {
      const health = await request('GET', '/api/v2/health');
      assert(health.response.status === 200, `GET /api/v2/health returned ${health.response.status}`);
      assert(health.json?.status === 'ok', 'expected /api/v2/health status=ok');
    }
    logStep('health', '3 consecutive checks passed');

    const agents = await request('GET', '/api/v2/agents');
    assert(agents.response.status === 200, `GET /api/v2/agents returned ${agents.response.status}`);
    assert(Array.isArray(agents.json?.agents), 'expected /api/v2/agents to return agents[]');
    logStep('agents', `${agents.json.agents.length} agents returned`);

    const stats = await request('GET', '/api/v2/stats');
    assert(stats.response.status === 200, `GET /api/v2/stats returned ${stats.response.status}`);
    assert(stats.json?.runtime?.legacy_mode === false, 'expected legacy_mode=false');
    assert(stats.json?.runtime?.v1_routes_enabled === false, 'expected v1_routes_enabled=false');
    logStep('v2 stats', 'runtime flags are V2-only');

    const legacyChecks = [
      ['POST', '/api/v1/recall', { query: 'smoke', agent_id: probeAgentId }],
      ['POST', '/api/v1/ingest', { user_message: 'smoke', assistant_message: 'smoke', agent_id: probeAgentId }],
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
        agent_id: probeAgentId,
      },
    });
    assert(createRecord.response.status === 201, `POST /api/v2/records returned ${createRecord.response.status}`);

    const ingest = await request('POST', '/api/v2/ingest', {
      body: {
        user_message: '我喜欢简洁回答。',
        assistant_message: '收到，我会保持简洁。',
        agent_id: probeAgentId,
      },
    });
    assert(ingest.response.status === 201, `POST /api/v2/ingest returned ${ingest.response.status}`);

    const recall = await request('POST', '/api/v2/recall', {
      body: {
        query: 'Where does the user live?',
        agent_id: probeAgentId,
      },
    });
    assert(recall.response.status === 200, `POST /api/v2/recall returned ${recall.response.status}`);
    assert(typeof recall.json?.context === 'string', 'v2 recall did not return context');
    logStep('v2 REST', 'records, ingest, recall all passed');

    const preview = await request('POST', '/api/v2/import/preview', {
      body: {
        agent_id: probeAgentId,
        format: 'text',
        content: [
          '我住大阪',
          '请用中文回答',
          '当前任务是重构 Cortex recall',
          '最近也许会考虑换方案',
        ].join('\n'),
      },
    });
    assert(preview.response.status === 200, `POST /api/v2/import/preview returned ${preview.response.status}`);
    const previewKinds = new Set((preview.json?.record_candidates || []).map((item) => item.normalized_kind));
    assert(previewKinds.has('fact_slot'), 'text import preview did not keep fact_slot');
    assert(previewKinds.has('profile_rule'), 'text import preview did not keep profile_rule');
    assert(previewKinds.has('task_state'), 'text import preview did not keep task_state');
    assert(previewKinds.has('session_note'), 'text import preview did not keep session_note');
    assert((preview.json?.relation_candidates || []).some((item) => item.predicate === 'lives_in'), 'text import preview did not derive lives_in');
    logStep('import preview', 'text contract looks correct');

    const roundtripSourceRecord = await request('POST', '/api/v2/records', {
      body: {
        kind: 'fact_slot',
        content: '我住大阪',
        agent_id: roundtripSourceAgentId,
      },
    });
    assert(roundtripSourceRecord.response.status === 201, `POST /api/v2/records source returned ${roundtripSourceRecord.response.status}`);
    await confirmFirstCandidate(roundtripSourceAgentId, 'lives_in');

    const currentExport = await request('GET', `/api/v2/export${query({
      scope: 'current_agent',
      agent_id: roundtripSourceAgentId,
      format: 'json',
    })}`);
    assert(currentExport.response.status === 200, `GET /api/v2/export current_agent returned ${currentExport.response.status}`);
    assert(currentExport.json?.scope === 'current_agent', 'current export did not preserve scope');
    assert(bundleRecords(currentExport.json).some((item) => item.agent_id === roundtripSourceAgentId), 'current export missing source agent records');
    assert((currentExport.json?.confirmed_relations || []).length === 1, 'current export missing confirmed relation');
    logStep('current export', 'canonical JSON bundle generated');

    const deletedRecord = await request('POST', '/api/v2/records', {
      body: {
        kind: 'fact_slot',
        content: '我住东京',
        agent_id: deletedAgentId,
      },
    });
    assert(deletedRecord.response.status === 201, `POST /api/v2/records deleted-agent returned ${deletedRecord.response.status}`);
    await confirmFirstCandidate(deletedAgentId, 'lives_in');
    const deletedAgentResponse = await request('DELETE', `/api/v2/agents/${encodeURIComponent(deletedAgentId)}`);
    assert(deletedAgentResponse.response.status === 200, `DELETE /api/v2/agents/:id returned ${deletedAgentResponse.response.status}`);

    const allAgentsExport = await request('GET', `/api/v2/export${query({
      scope: 'all_agents',
      format: 'json',
    })}`);
    assert(allAgentsExport.response.status === 200, `GET /api/v2/export all_agents returned ${allAgentsExport.response.status}`);
    const exportedAgentIds = (allAgentsExport.json?.agents || []).map((agent) => agent.id);
    assert(exportedAgentIds.includes('default'), 'all_agents export is missing default');
    assert(exportedAgentIds.includes('mcp'), 'all_agents export is missing mcp');
    assert(!exportedAgentIds.includes(deletedAgentId), 'all_agents export resurrected a deleted agent');
    assert(!bundleRecords(allAgentsExport.json).some((item) => item.agent_id === deletedAgentId), 'all_agents export still includes deleted-agent records');
    assert(!(allAgentsExport.json?.confirmed_relations || []).some((item) => item.agent_id === deletedAgentId), 'all_agents export still includes deleted-agent relations');
    logStep('all_agents export', 'deleted agents stay filtered out');

    const roundtripPreview = await request('POST', '/api/v2/import/preview', {
      body: {
        agent_id: roundtripTargetAgentId,
        format: 'json',
        content: JSON.stringify(currentExport.json),
      },
    });
    assert(roundtripPreview.response.status === 200, `POST /api/v2/import/preview json returned ${roundtripPreview.response.status}`);
    assert((roundtripPreview.json?.relation_candidates || []).length === 1, 'canonical preview should include one relation restore candidate');
    assert(roundtripPreview.json.relation_candidates[0]?.mode === 'confirmed_restore', 'canonical preview relation should be confirmed_restore');

    const roundtripConfirm = await request('POST', '/api/v2/import/confirm', {
      body: {
        agent_id: roundtripTargetAgentId,
        record_candidates: roundtripPreview.json.record_candidates,
        relation_candidates: roundtripPreview.json.relation_candidates,
      },
    });
    assert(roundtripConfirm.response.status === 201, `POST /api/v2/import/confirm returned ${roundtripConfirm.response.status}`);
    assert(roundtripConfirm.json?.summary?.confirmed_relations_restored === 1, 'import confirm did not restore exactly one confirmed relation');

    const targetRelations = await request('GET', `/api/v2/relations${query({ agent_id: roundtripTargetAgentId, limit: 20 })}`);
    assert(targetRelations.response.status === 200, `GET /api/v2/relations returned ${targetRelations.response.status}`);
    assert((targetRelations.json?.items || []).length === 1, 'target agent missing restored formal relation');

    const targetPending = await request('GET', `/api/v2/relation-candidates${query({
      agent_id: roundtripTargetAgentId,
      status: 'pending',
      limit: 20,
    })}`);
    assert(targetPending.response.status === 200, `GET /api/v2/relation-candidates returned ${targetPending.response.status}`);
    assert((targetPending.json?.items || []).length === 0, 'target agent still has duplicate pending relation candidates');
    logStep('canonical round-trip', 'confirmed restore completed without pending duplicates');

    const mcpHeaders = { 'x-agent-id': probeAgentId };
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
  } finally {
    await cleanup(cleanupAgentIds);
    logStep('cleanup', 'removed smoke records, relations, candidates, and probe agents');
  }
}

async function main() {
  for (let round = 1; round <= smokeRounds; round += 1) {
    await runRound(round);
  }
  process.stdout.write(`Smoke test passed (${smokeRounds} rounds).\n`);
}

main().catch((error) => {
  process.stderr.write(`Smoke test failed: ${error.message}\n`);
  process.exit(1);
});

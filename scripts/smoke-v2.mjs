#!/usr/bin/env node

import { runBestEffortSteps, runSmokeRequest } from './smoke-v2-lib.mjs';

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label, detail) {
  process.stdout.write(`- ${label}${detail ? `: ${detail}` : ''}\n`);
}

function getAgentId(round) {
  return smokeRounds === 1 ? baseAgentId : `${baseAgentId}-r${round}`;
}

function getSmokeRunId(round) {
  const suffix = smokeRounds === 1 ? 'single' : `r${round}`;
  return `${baseAgentId}-smoke-${suffix}`;
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
    await runSmokeRequest({
      baseUrl,
      authToken,
      smokeRunId: 'cleanup',
      label: `cleanup ${pathPrefix}`,
      method: 'DELETE',
      path: `${pathPrefix}/${encodeURIComponent(item.id)}`,
    });
  }
}

async function cleanupAgent(agentId, smokeRunId) {
  return runBestEffortSteps([
    {
      label: `cleanup records for ${agentId}`,
      run: async () => {
        const records = await runSmokeRequest({
          baseUrl,
          authToken,
          smokeRunId,
          label: `list records for cleanup (${agentId})`,
          method: 'GET',
          path: `/api/v2/records${query({ agent_id: agentId, limit: 200 })}`,
          retryable: true,
        });
        if (Array.isArray(records.json?.items)) {
          await deleteById('/api/v2/records', records.json.items);
        }
      },
    },
    {
      label: `cleanup relations for ${agentId}`,
      run: async () => {
        const relations = await runSmokeRequest({
          baseUrl,
          authToken,
          smokeRunId,
          label: `list relations for cleanup (${agentId})`,
          method: 'GET',
          path: `/api/v2/relations${query({ agent_id: agentId, limit: 200 })}`,
          retryable: true,
        });
        if (Array.isArray(relations.json?.items)) {
          await deleteById('/api/v2/relations', relations.json.items);
        }
      },
    },
    {
      label: `cleanup relation candidates for ${agentId}`,
      run: async () => {
        const candidates = await runSmokeRequest({
          baseUrl,
          authToken,
          smokeRunId,
          label: `list relation candidates for cleanup (${agentId})`,
          method: 'GET',
          path: `/api/v2/relation-candidates${query({ agent_id: agentId, limit: 200 })}`,
          retryable: true,
        });
        if (Array.isArray(candidates.json?.items)) {
          await deleteById('/api/v2/relation-candidates', candidates.json.items);
        }
      },
    },
    {
      label: `cleanup agent ${agentId}`,
      ignoreError: (error) => (
        String(error).includes('status 404') &&
        String(error).includes('Agent not found')
      ),
      run: async () => {
        if (!['default', 'mcp'].includes(agentId)) {
          await runSmokeRequest({
            baseUrl,
            authToken,
            smokeRunId,
            label: `delete probe agent ${agentId}`,
            method: 'DELETE',
            path: `/api/v2/agents/${encodeURIComponent(agentId)}`,
          });
        }
      },
    },
  ]);
}

async function cleanup(agentIds, smokeRunId) {
  const uniqueAgentIds = Array.from(new Set(agentIds.filter(Boolean)));
  const warnings = [];
  for (const agentId of uniqueAgentIds) {
    warnings.push(...await cleanupAgent(agentId, smokeRunId));
  }
  return warnings;
}

async function confirmFirstCandidate(agentId, predicate, smokeRunId) {
  const candidates = await runSmokeRequest({
    baseUrl,
    authToken,
    smokeRunId,
    label: `list pending relation candidates for ${agentId}`,
    method: 'GET',
    path: `/api/v2/relation-candidates${query({ agent_id: agentId, status: 'pending', limit: 50 })}`,
    retryable: true,
  });
  assert(candidates.response.status === 200, `GET /api/v2/relation-candidates returned ${candidates.response.status}`);
  const candidate = (candidates.json?.items || []).find((item) => item.predicate === predicate) || candidates.json?.items?.[0];
  assert(candidate?.id, `No pending relation candidate found for ${agentId}`);
  const confirmed = await runSmokeRequest({
    baseUrl,
    authToken,
    smokeRunId,
    label: `confirm relation candidate ${candidate.id}`,
    method: 'POST',
    path: `/api/v2/relation-candidates/${encodeURIComponent(candidate.id)}/confirm`,
  });
  assert(confirmed.response.status === 201, `POST /api/v2/relation-candidates/:id/confirm returned ${confirmed.response.status}`);
  return candidate;
}

async function runRound(round) {
  const probeAgentId = getAgentId(round);
  const smokeRunId = getSmokeRunId(round);
  const roundtripSourceAgentId = `${probeAgentId}-src`;
  const roundtripTargetAgentId = `${probeAgentId}-dst`;
  const deletedAgentId = `${probeAgentId}-deleted`;
  const compoundAgentId = `${probeAgentId}-compound`;
  const conflictAgentId = `${probeAgentId}-conflict`;
  const organizationVariantAgentId = `${probeAgentId}-org`;
  const cleanupAgentIds = [
    probeAgentId,
    roundtripSourceAgentId,
    roundtripTargetAgentId,
    deletedAgentId,
    compoundAgentId,
    conflictAgentId,
    organizationVariantAgentId,
  ];

  async function request(label, method, path, { body, headers, retryable = false, expectedStatus } = {}) {
    return runSmokeRequest({
      fetchImpl: fetch,
      baseUrl,
      authToken,
      smokeRunId,
      label,
      method,
      path,
      body,
      headers,
      retryable,
      expectedStatus,
    });
  }

  process.stdout.write(`Cortex V2 smoke test -> ${baseUrl} (agent: ${probeAgentId}, round ${round}/${smokeRounds}, trace: ${smokeRunId})\n`);

  try {
    for (let i = 0; i < 3; i += 1) {
      const health = await request(`health check ${i + 1}`, 'GET', '/api/v2/health', { retryable: true });
      assert(health.response.status === 200, `GET /api/v2/health returned ${health.response.status}`);
      assert(health.json?.status === 'ok', 'expected /api/v2/health status=ok');
    }
    logStep('health', '3 consecutive checks passed');

    const agents = await request('list agents', 'GET', '/api/v2/agents', { retryable: true });
    assert(agents.response.status === 200, `GET /api/v2/agents returned ${agents.response.status}`);
    assert(Array.isArray(agents.json?.agents), 'expected /api/v2/agents to return agents[]');
    logStep('agents', `${agents.json.agents.length} agents returned`);

    const stats = await request('fetch v2 stats', 'GET', '/api/v2/stats', { retryable: true });
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
      const result = await request(`legacy route ${method} ${path}`, method, path, {
        body,
        expectedStatus: 404,
      });
      assert(result.response.status === 404, `${method} ${path} returned ${result.response.status}, expected 404`);
    }
    logStep('legacy routes', 'write/search chain disabled');

    const createRecord = await request('create probe record', 'POST', '/api/v2/records', {
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

    const ingest = await request('ingest probe preference', 'POST', '/api/v2/ingest', {
      body: {
        user_message: '我喜欢简洁回答。',
        assistant_message: '收到，我会保持简洁。',
        agent_id: probeAgentId,
      },
    });
    assert(ingest.response.status === 201, `POST /api/v2/ingest returned ${ingest.response.status}`);

    const recall = await request('recall probe context', 'POST', '/api/v2/recall', {
      body: {
        query: 'Where does the user live?',
        agent_id: probeAgentId,
      },
    });
    assert(recall.response.status === 200, `POST /api/v2/recall returned ${recall.response.status}`);
    assert(typeof recall.json?.context === 'string', 'v2 recall did not return context');
    logStep('v2 REST', 'records, ingest, recall all passed');

    const compoundWrite = await request('reject compound public record write', 'POST', '/api/v2/records', {
      body: {
        content: '我住大阪。请用中文回答',
        agent_id: compoundAgentId,
      },
      expectedStatus: 400,
    });
    assert(compoundWrite.response.status === 400, `POST /api/v2/records compound returned ${compoundWrite.response.status}`);

    const compoundIngest = await request('ingest compound contract sample', 'POST', '/api/v2/ingest', {
      body: {
        user_message: '我住大阪。请用中文回答。当前任务是重构 Cortex recall',
        assistant_message: '记住了',
        agent_id: compoundAgentId,
      },
    });
    assert(compoundIngest.response.status === 201, `POST /api/v2/ingest compound returned ${compoundIngest.response.status}`);
    const compoundKinds = compoundIngest.json?.records?.map((item) => item.written_kind) || [];
    assert(compoundKinds.includes('fact_slot'), 'compound ingest missing fact_slot');
    assert(compoundKinds.includes('profile_rule'), 'compound ingest missing profile_rule');
    assert(compoundKinds.includes('task_state'), 'compound ingest missing task_state');

    const compoundPreview = await request('preview compound text contract', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: compoundAgentId,
        format: 'text',
        content: '我住大阪。请用中文回答。当前任务是重构 Cortex recall',
      },
      retryable: true,
    });
    assert(compoundPreview.response.status === 200, `POST /api/v2/import/preview compound returned ${compoundPreview.response.status}`);
    assert((compoundPreview.json?.record_candidates || []).length === 3, 'compound preview did not keep three clause winners');
    assert((compoundPreview.json?.relation_candidates || []).map((item) => item.predicate).join(',') === 'lives_in', 'compound preview did not keep only lives_in');

    const implicitFollowupPreview = await request('preview implicit follow-up fact after speculative clause', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: compoundAgentId,
        format: 'text',
        content: '最近也许会考虑换方案。现在住东京',
      },
      retryable: true,
    });
    assert(implicitFollowupPreview.response.status === 200, `POST /api/v2/import/preview implicit follow-up returned ${implicitFollowupPreview.response.status}`);
    assert((implicitFollowupPreview.json?.record_candidates || []).map((item) => item.normalized_kind).join(',') === 'session_note,fact_slot', 'implicit follow-up preview did not keep note + fact winners');
    assert(implicitFollowupPreview.json?.record_candidates?.[1]?.entity_key === 'user', 'implicit follow-up preview did not infer user entity');
    assert((implicitFollowupPreview.json?.relation_candidates || []).length === 1, 'implicit follow-up preview should keep one relation candidate');
    assert(implicitFollowupPreview.json?.relation_candidates?.[0]?.object_key === '东京', 'implicit follow-up preview relation winner should point at 东京');

    const implicitLocationVariantPreview = await request('preview implicit follow-up location variant after speculative clause', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: compoundAgentId,
        format: 'text',
        content: '最近也许会考虑换方案。目前位于东京',
      },
      retryable: true,
    });
    assert(implicitLocationVariantPreview.response.status === 200, `POST /api/v2/import/preview implicit location variant returned ${implicitLocationVariantPreview.response.status}`);
    assert((implicitLocationVariantPreview.json?.record_candidates || []).map((item) => item.normalized_kind).join(',') === 'session_note,fact_slot', 'implicit location variant preview did not keep note + fact winners');
    assert(implicitLocationVariantPreview.json?.record_candidates?.[1]?.entity_key === 'user', 'implicit location variant preview did not infer user entity');
    assert((implicitLocationVariantPreview.json?.relation_candidates || []).length === 1, 'implicit location variant preview should keep one relation candidate');
    assert(implicitLocationVariantPreview.json?.relation_candidates?.[0]?.object_key === '东京', 'implicit location variant preview relation winner should point at 东京');

    const implicitOrganizationVariantPreview = await request('preview implicit follow-up organization variant after speculative clause', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: organizationVariantAgentId,
        format: 'text',
        content: '最近也许会考虑换方案。目前任职于 OpenAI',
      },
      retryable: true,
    });
    assert(implicitOrganizationVariantPreview.response.status === 200, `POST /api/v2/import/preview implicit organization variant returned ${implicitOrganizationVariantPreview.response.status}`);
    assert((implicitOrganizationVariantPreview.json?.record_candidates || []).map((item) => item.normalized_kind).join(',') === 'session_note,fact_slot', 'implicit organization variant preview did not keep note + fact winners');
    assert(implicitOrganizationVariantPreview.json?.record_candidates?.[1]?.entity_key === 'user', 'implicit organization variant preview did not infer user entity');
    assert((implicitOrganizationVariantPreview.json?.relation_candidates || []).length === 1, 'implicit organization variant preview should keep one relation candidate');
    assert(implicitOrganizationVariantPreview.json?.relation_candidates?.[0]?.object_key === 'openai', 'implicit organization variant preview relation winner should point at openai');

    const implicitOrganizationVariantIngest = await request('ingest implicit follow-up organization variant after speculative clause', 'POST', '/api/v2/ingest', {
      body: {
        user_message: '最近也许会考虑换方案。目前任职于 OpenAI',
        assistant_message: '记住了',
        agent_id: organizationVariantAgentId,
      },
    });
    assert(implicitOrganizationVariantIngest.response.status === 201, `POST /api/v2/ingest implicit organization variant returned ${implicitOrganizationVariantIngest.response.status}`);
    assert((implicitOrganizationVariantIngest.json?.records || []).map((item) => item.written_kind).join(',') === 'session_note,fact_slot', 'implicit organization variant ingest did not keep note + fact winners');

    const implicitOrganizationVariantCandidates = await request('list implicit organization variant relation candidates', 'GET', `/api/v2/relation-candidates${query({ agent_id: organizationVariantAgentId, status: 'pending', limit: 20 })}`, {
      retryable: true,
    });
    assert(implicitOrganizationVariantCandidates.response.status === 200, `GET /api/v2/relation-candidates implicit organization variant returned ${implicitOrganizationVariantCandidates.response.status}`);
    assert((implicitOrganizationVariantCandidates.json?.items || []).map((item) => item.object_key).join(',') === 'openai', 'implicit organization variant derived candidate should point at openai');

    const conflictPreview = await request('preview compound fact conflict', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: conflictAgentId,
        format: 'text',
        content: '我住大阪。现在住东京',
      },
      retryable: true,
    });
    assert(conflictPreview.response.status === 200, `POST /api/v2/import/preview conflict returned ${conflictPreview.response.status}`);
    assert((conflictPreview.json?.record_candidates || []).length === 1, 'compound conflict preview should keep one winner');
    assert(conflictPreview.json?.record_candidates?.[0]?.content === '现在住东京', 'compound conflict preview kept the wrong winner');

    const multilinePreview = await request('preview multiline text conflict', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: conflictAgentId,
        format: 'text',
        content: ['我住大阪', '请用中文回答', '现在住东京'].join('\n'),
      },
      retryable: true,
    });
    assert(multilinePreview.response.status === 200, `POST /api/v2/import/preview multiline returned ${multilinePreview.response.status}`);
    assert((multilinePreview.json?.record_candidates || []).length === 2, 'multiline preview should keep two winning records');
    assert(multilinePreview.json?.record_candidates?.[1]?.content === '现在住东京', 'multiline preview kept the wrong durable winner');
    assert((multilinePreview.json?.relation_candidates || []).length === 1, 'multiline preview should keep one relation candidate');
    assert(multilinePreview.json?.relation_candidates?.[0]?.object_key === '东京', 'multiline preview relation winner should point at 东京');

    const memoryPreview = await request('preview MEMORY.md multiline conflict', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: compoundAgentId,
        format: 'memory_md',
        content: [
          '# MEMORY.md',
          '',
          '## Fact Slots',
          '- 我住大阪',
          '- 现在住东京',
          '',
          '## Profile Rules',
          '- 请用中文回答',
        ].join('\n'),
      },
      retryable: true,
    });
    assert(memoryPreview.response.status === 200, `POST /api/v2/import/preview memory_md returned ${memoryPreview.response.status}`);
    assert((memoryPreview.json?.record_candidates || []).length === 2, 'MEMORY.md preview should keep two winning records');
    assert(memoryPreview.json?.record_candidates?.[0]?.content === '现在住东京', 'MEMORY.md preview kept the wrong durable winner');
    assert((memoryPreview.json?.relation_candidates || []).length === 1, 'MEMORY.md preview should keep one relation candidate');
    assert(memoryPreview.json?.relation_candidates?.[0]?.object_key === '东京', 'MEMORY.md preview relation winner should point at 东京');
    logStep('compound contract', 'records boundary, ingest, and preview all passed');

    const preview = await request('preview text import contract', 'POST', '/api/v2/import/preview', {
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
      retryable: true,
    });
    assert(preview.response.status === 200, `POST /api/v2/import/preview returned ${preview.response.status}`);
    const previewKinds = new Set((preview.json?.record_candidates || []).map((item) => item.normalized_kind));
    assert(previewKinds.has('fact_slot'), 'text import preview did not keep fact_slot');
    assert(previewKinds.has('profile_rule'), 'text import preview did not keep profile_rule');
    assert(previewKinds.has('task_state'), 'text import preview did not keep task_state');
    assert(previewKinds.has('session_note'), 'text import preview did not keep session_note');
    assert((preview.json?.relation_candidates || []).some((item) => item.predicate === 'lives_in'), 'text import preview did not derive lives_in');
    logStep('import preview', 'text contract looks correct');

    const roundtripSourceRecord = await request('create round-trip source record', 'POST', '/api/v2/records', {
      body: {
        kind: 'fact_slot',
        content: '我住大阪',
        agent_id: roundtripSourceAgentId,
      },
    });
    assert(roundtripSourceRecord.response.status === 201, `POST /api/v2/records source returned ${roundtripSourceRecord.response.status}`);
    await confirmFirstCandidate(roundtripSourceAgentId, 'lives_in', smokeRunId);

    const currentExport = await request('export current agent bundle', 'GET', `/api/v2/export${query({
      scope: 'current_agent',
      agent_id: roundtripSourceAgentId,
      format: 'json',
    })}`, { retryable: true });
    assert(currentExport.response.status === 200, `GET /api/v2/export current_agent returned ${currentExport.response.status}`);
    assert(currentExport.json?.scope === 'current_agent', 'current export did not preserve scope');
    assert(bundleRecords(currentExport.json).some((item) => item.agent_id === roundtripSourceAgentId), 'current export missing source agent records');
    assert((currentExport.json?.confirmed_relations || []).length === 1, 'current export missing confirmed relation');
    logStep('current export', 'canonical JSON bundle generated');

    const deletedRecord = await request('create deleted-agent record', 'POST', '/api/v2/records', {
      body: {
        kind: 'fact_slot',
        content: '我住东京',
        agent_id: deletedAgentId,
      },
    });
    assert(deletedRecord.response.status === 201, `POST /api/v2/records deleted-agent returned ${deletedRecord.response.status}`);
    await confirmFirstCandidate(deletedAgentId, 'lives_in', smokeRunId);
    const deletedAgentResponse = await request('delete probe deleted-agent', 'DELETE', `/api/v2/agents/${encodeURIComponent(deletedAgentId)}`);
    assert(deletedAgentResponse.response.status === 200, `DELETE /api/v2/agents/:id returned ${deletedAgentResponse.response.status}`);

    const allAgentsExport = await request('export all agents bundle', 'GET', `/api/v2/export${query({
      scope: 'all_agents',
      format: 'json',
    })}`, { retryable: true });
    assert(allAgentsExport.response.status === 200, `GET /api/v2/export all_agents returned ${allAgentsExport.response.status}`);
    const exportedAgentIds = (allAgentsExport.json?.agents || []).map((agent) => agent.id);
    assert(exportedAgentIds.includes('default'), 'all_agents export is missing default');
    assert(exportedAgentIds.includes('mcp'), 'all_agents export is missing mcp');
    assert(!exportedAgentIds.includes(deletedAgentId), 'all_agents export resurrected a deleted agent');
    assert(!bundleRecords(allAgentsExport.json).some((item) => item.agent_id === deletedAgentId), 'all_agents export still includes deleted-agent records');
    assert(!(allAgentsExport.json?.confirmed_relations || []).some((item) => item.agent_id === deletedAgentId), 'all_agents export still includes deleted-agent relations');
    logStep('all_agents export', 'deleted agents stay filtered out');

    const roundtripPreview = await request('preview canonical bundle restore', 'POST', '/api/v2/import/preview', {
      body: {
        agent_id: roundtripTargetAgentId,
        format: 'json',
        content: JSON.stringify(currentExport.json),
      },
      retryable: true,
    });
    assert(roundtripPreview.response.status === 200, `POST /api/v2/import/preview json returned ${roundtripPreview.response.status}`);
    assert((roundtripPreview.json?.relation_candidates || []).length === 1, 'canonical preview should include one relation restore candidate');
    assert(roundtripPreview.json.relation_candidates[0]?.mode === 'confirmed_restore', 'canonical preview relation should be confirmed_restore');

    const roundtripConfirm = await request('confirm canonical bundle restore', 'POST', '/api/v2/import/confirm', {
      body: {
        agent_id: roundtripTargetAgentId,
        record_candidates: roundtripPreview.json.record_candidates,
        relation_candidates: roundtripPreview.json.relation_candidates,
      },
    });
    assert(roundtripConfirm.response.status === 201, `POST /api/v2/import/confirm returned ${roundtripConfirm.response.status}`);
    assert(roundtripConfirm.json?.summary?.confirmed_relations_restored === 1, 'import confirm did not restore exactly one confirmed relation');

    const targetRelations = await request('list restored relations', 'GET', `/api/v2/relations${query({ agent_id: roundtripTargetAgentId, limit: 20 })}`, { retryable: true });
    assert(targetRelations.response.status === 200, `GET /api/v2/relations returned ${targetRelations.response.status}`);
    assert((targetRelations.json?.items || []).length === 1, 'target agent missing restored formal relation');

    const targetPending = await request('list pending relation candidates after restore', 'GET', `/api/v2/relation-candidates${query({
      agent_id: roundtripTargetAgentId,
      status: 'pending',
      limit: 20,
    })}`, { retryable: true });
    assert(targetPending.response.status === 200, `GET /api/v2/relation-candidates returned ${targetPending.response.status}`);
    assert((targetPending.json?.items || []).length === 0, 'target agent still has duplicate pending relation candidates');
    logStep('canonical round-trip', 'confirmed restore completed without pending duplicates');

    const mcpHeaders = { 'x-agent-id': probeAgentId };
    const mcpInfo = await request('fetch MCP endpoint metadata', 'GET', '/mcp', { headers: mcpHeaders, retryable: true });
    assert(mcpInfo.response.status === 200, `GET /mcp returned ${mcpInfo.response.status}`);
    assert(mcpInfo.json?.endpoints?.jsonrpc_post === '/mcp', 'GET /mcp did not expose primary jsonrpc endpoint');
    assert(mcpInfo.json?.endpoints?.compat_jsonrpc_post === '/mcp/message', 'GET /mcp did not expose compat endpoint');

    const toolsListPayload = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const listPrimary = await request('list MCP tools on primary endpoint', 'POST', '/mcp', { headers: mcpHeaders, body: toolsListPayload, retryable: true });
    const listCompat = await request('list MCP tools on compat endpoint', 'POST', '/mcp/message', { headers: mcpHeaders, body: toolsListPayload, retryable: true });
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
    const searchPrimary = await request('run MCP search_debug on primary endpoint', 'POST', '/mcp', { headers: mcpHeaders, body: searchPayload, retryable: true });
    const searchCompat = await request('run MCP search_debug on compat endpoint', 'POST', '/mcp/message', { headers: mcpHeaders, body: searchPayload, retryable: true });
    assert(searchPrimary.response.status === 200, `POST /mcp search returned ${searchPrimary.response.status}`);
    assert(searchCompat.response.status === 200, `POST /mcp/message search returned ${searchCompat.response.status}`);
    const primaryText = searchPrimary.json?.result?.content?.[0]?.text;
    const compatText = searchCompat.json?.result?.content?.[0]?.text;
    assert(typeof primaryText === 'string' && primaryText.includes('Smoke V2 user lives in Taipei'), 'primary MCP search did not find smoke record');
    assert(typeof compatText === 'string' && compatText.includes('Smoke V2 user lives in Taipei'), 'compat MCP search did not find smoke record');
    assert(primaryText === compatText, 'MCP search result differs between /mcp and /mcp/message');
    logStep('MCP', 'primary and compat JSON-RPC endpoints behave identically');
  } finally {
    const cleanupWarnings = await cleanup(cleanupAgentIds, smokeRunId);
    if (cleanupWarnings.length > 0) {
      logStep('cleanup', `completed with ${cleanupWarnings.length} warning(s)`);
      for (const warning of cleanupWarnings) {
        logStep('cleanup warning', warning);
      }
    } else {
      logStep('cleanup', 'removed smoke records, relations, candidates, and probe agents');
    }
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

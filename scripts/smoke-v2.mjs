#!/usr/bin/env node

import { resolveSmokeBaseUrl, runBestEffortSteps, runSmokeRequest } from './smoke-v2-lib.mjs';

const resolvedBaseUrl = resolveSmokeBaseUrl({
  validationBaseUrl: process.env.CORTEX_SMOKE_VALIDATION_URL || process.env.CORTEX_REMOTE_VALIDATION_URL,
  baseUrl: process.env.CORTEX_BASE_URL || process.env.CORTEX_URL,
  cliBaseUrl: process.argv[2],
  defaultBaseUrl: 'http://localhost:21100',
});
const authToken = process.env.CORTEX_AUTH_TOKEN || '';
const baseAgentId = process.env.CORTEX_AGENT_ID || `smoke-v2-${Date.now()}`;
const smokeRounds = Math.max(1, Number(process.env.SMOKE_ROUNDS || process.argv[3] || '1'));
const baseUrl = resolvedBaseUrl.baseUrl;
const baseUrlSource = resolvedBaseUrl.source;

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
      smokePhase: 'cleanup',
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
          smokePhase: 'cleanup',
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
          smokePhase: 'cleanup',
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
          smokePhase: 'cleanup',
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
            smokePhase: 'cleanup',
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
  const reviewImportAgentId = `${probeAgentId}-review`;
  const reviewStyleAutoAgentId = `${probeAgentId}-review-style-auto`;
  const reviewStyleReviewAgentId = `${probeAgentId}-review-style-review`;
  const mixedReviewAgentId = `${probeAgentId}-review-mixed-routing`;
  const compoundAutoAgentId = `${probeAgentId}-review-compound-auto`;
  const reviewFollowupConfirmAgentId = `${probeAgentId}-review-followup-confirm`;
  const reviewFollowupStyleRestateAgentId = `${probeAgentId}-review-followup-style-restate`;
  const reviewFollowupStyleSelectionAgentId = `${probeAgentId}-review-followup-style-selection`;
  const mixedActivePendingSelectionAgentId = `${probeAgentId}-mixed-active-pending-selection`;
  const mixedActivePendingKeepLanguageAgentId = `${probeAgentId}-mixed-active-pending-keep-language`;
  const mixedActivePendingKeepLocationAgentId = `${probeAgentId}-mixed-active-pending-keep-location`;
  const mixedActivePendingKeepTaskAgentId = `${probeAgentId}-mixed-active-pending-keep-task`;
  const mixedSelectionAgentId = `${probeAgentId}-mixed-selection`;
  const mixedDropAllAgentId = `${probeAgentId}-mixed-drop-all`;
  const taskSelectionAgentId = `${probeAgentId}-task-selection`;
  const taskRewriteAgentId = `${probeAgentId}-task-rewrite`;
  const organizationRewriteAgentId = `${probeAgentId}-organization-rewrite`;
  const reviewFollowupMismatchAgentId = `${probeAgentId}-review-followup-mismatch`;
  const cleanupAgentIds = [
    probeAgentId,
    roundtripSourceAgentId,
    roundtripTargetAgentId,
    deletedAgentId,
    compoundAgentId,
    conflictAgentId,
    organizationVariantAgentId,
    reviewImportAgentId,
    reviewStyleAutoAgentId,
    reviewStyleReviewAgentId,
    mixedReviewAgentId,
    compoundAutoAgentId,
    reviewFollowupConfirmAgentId,
    reviewFollowupStyleRestateAgentId,
    reviewFollowupStyleSelectionAgentId,
    mixedActivePendingSelectionAgentId,
    mixedActivePendingKeepLanguageAgentId,
    mixedActivePendingKeepLocationAgentId,
    mixedActivePendingKeepTaskAgentId,
    mixedSelectionAgentId,
    mixedDropAllAgentId,
    taskSelectionAgentId,
    taskRewriteAgentId,
    organizationRewriteAgentId,
    reviewFollowupMismatchAgentId,
  ];

  async function request(label, method, path, { body, headers, retryable = false, expectedStatus, smokePhase } = {}) {
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
      smokePhase,
    });
  }

  process.stdout.write(`Cortex V2 smoke test -> ${baseUrl} [${baseUrlSource}] (agent: ${probeAgentId}, round ${round}/${smokeRounds}, trace: ${smokeRunId})\n`);

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
    assert(conflictPreview.json?.record_candidates?.[0]?.content === '我住东京', 'compound conflict preview kept the wrong winner');

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
    assert(multilinePreview.json?.record_candidates?.[1]?.content === '我住东京', 'multiline preview kept the wrong durable winner');
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
    assert(memoryPreview.json?.record_candidates?.[0]?.content === '我住东京', 'MEMORY.md preview kept the wrong durable winner');
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

    const reviewInboxAutoImport = await request('auto-commit stable review inbox import', 'POST', '/api/v2/review-inbox/import', {
      body: {
        agent_id: reviewImportAgentId,
        format: 'text',
        content: '回答控制在三句话内',
      },
    });
    assert(reviewInboxAutoImport.response.status === 201, `POST /api/v2/review-inbox/import auto-commit returned ${reviewInboxAutoImport.response.status}`);
    assert(reviewInboxAutoImport.json?.batch_id == null, 'stable review inbox import should not leave a batch behind');
    assert(reviewInboxAutoImport.json?.auto_committed_count === 1, 'stable review inbox import did not auto-commit exactly one item');
    assert(reviewInboxAutoImport.json?.summary?.pending === 0, 'stable review inbox import left unexpected pending items');

    const autoCommittedReviewInboxRecords = await request('list auto-committed review inbox records', 'GET', `/api/v2/records${query({
      agent_id: reviewImportAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(autoCommittedReviewInboxRecords.response.status === 200, `GET /api/v2/records auto-committed review inbox returned ${autoCommittedReviewInboxRecords.response.status}`);
    assert((autoCommittedReviewInboxRecords.json?.items || []).some((item) => item.content === '请把回答控制在三句话内'), 'stable review inbox import did not write the canonical auto-committed record');

    const reviewInboxAutoStyleImport = await request('auto-commit explicit response-style import', 'POST', '/api/v2/review-inbox/import', {
      body: {
        agent_id: reviewStyleAutoAgentId,
        format: 'text',
        content: '回答风格简洁直接',
      },
    });
    assert(reviewInboxAutoStyleImport.response.status === 201, `POST /api/v2/review-inbox/import explicit response-style returned ${reviewInboxAutoStyleImport.response.status}`);
    assert(reviewInboxAutoStyleImport.json?.batch_id == null, 'explicit response-style import should not leave a batch behind');
    assert(reviewInboxAutoStyleImport.json?.auto_committed_count === 1, 'explicit response-style import did not auto-commit exactly one item');
    assert(reviewInboxAutoStyleImport.json?.summary?.pending === 0, 'explicit response-style import left unexpected pending items');

    const autoCommittedStyleRecords = await request('list auto-committed response-style records', 'GET', `/api/v2/records${query({
      agent_id: reviewStyleAutoAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(autoCommittedStyleRecords.response.status === 200, `GET /api/v2/records explicit response-style returned ${autoCommittedStyleRecords.response.status}`);
    assert((autoCommittedStyleRecords.json?.items || []).some((item) => item.content === '请简洁直接回答'), 'explicit response-style import did not write the canonical auto-committed record');

    const reviewInboxImport = await request('create review inbox review batch', 'POST', '/api/v2/review-inbox/import', {
      body: {
        agent_id: reviewStyleReviewAgentId,
        format: 'text',
        content: '说话干脆一点',
      },
    });
    assert(reviewInboxImport.response.status === 201, `POST /api/v2/review-inbox/import review batch returned ${reviewInboxImport.response.status}`);
    assert(reviewInboxImport.json?.summary?.pending === 1, 'review inbox import did not create exactly one pending item');
    const reviewImportBatchId = reviewInboxImport.json?.batch_id;
    assert(typeof reviewImportBatchId === 'string' && reviewImportBatchId.length > 0, 'review inbox import did not return batch_id');

    const reviewInboxListFull = await request('list review inbox batches (full)', 'GET', `/api/v2/review-inbox?agent_id=${encodeURIComponent(reviewStyleReviewAgentId)}&limit=20`, {
      retryable: true,
    });
    assert(reviewInboxListFull.response.status === 200, `GET /api/v2/review-inbox full returned ${reviewInboxListFull.response.status}`);
    assert(reviewInboxListFull.json?.sync?.mode === 'full', 'review inbox full list did not return sync.mode=full');
    assert(typeof reviewInboxListFull.json?.sync?.cursor === 'string' && reviewInboxListFull.json.sync.cursor.length > 0, 'review inbox full list did not return sync cursor');
    assert((reviewInboxListFull.json?.items || []).some((item) => item.id === reviewImportBatchId), 'review inbox full list did not include created batch');

    const reviewInboxDetail = await request('get review inbox batch detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(reviewImportBatchId)}`, {
      retryable: true,
    });
    assert(reviewInboxDetail.response.status === 200, `GET /api/v2/review-inbox/:id returned ${reviewInboxDetail.response.status}`);
    assert(reviewInboxDetail.json?.summary?.pending === 1, 'review inbox detail did not preserve pending summary');
    assert(reviewInboxDetail.json?.items?.[0]?.suggested_rewrite === '请简洁直接回答', 'review inbox detail did not preserve canonical suggested rewrite');

    const reviewInboxApply = await request('apply review inbox batch', 'POST', `/api/v2/review-inbox/${encodeURIComponent(reviewImportBatchId)}/apply`, {
      body: {
        accept_all: true,
      },
    });
    assert(reviewInboxApply.response.status === 200, `POST /api/v2/review-inbox/:id/apply returned ${reviewInboxApply.response.status}`);
    assert(reviewInboxApply.json?.summary?.committed === 1, 'review inbox apply did not commit exactly one item');
    assert(reviewInboxApply.json?.remaining_pending === 0, 'review inbox apply left pending items behind');

    const reviewInboxRecords = await request('list review inbox committed records', 'GET', `/api/v2/records${query({
      agent_id: reviewStyleReviewAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(reviewInboxRecords.response.status === 200, `GET /api/v2/records review inbox returned ${reviewInboxRecords.response.status}`);
    assert((reviewInboxRecords.json?.items || []).some((item) => item.content === '请简洁直接回答'), 'review inbox apply did not write the canonical record');

    const reviewInboxDeltaBase = await request('list review inbox batches after apply', 'GET', `/api/v2/review-inbox?agent_id=${encodeURIComponent(reviewStyleReviewAgentId)}&limit=20`, {
      retryable: true,
    });
    assert(reviewInboxDeltaBase.response.status === 200, `GET /api/v2/review-inbox delta base returned ${reviewInboxDeltaBase.response.status}`);
    assert(reviewInboxDeltaBase.json?.sync?.mode === 'full', 'review inbox delta base list did not return sync.mode=full');
    assert(typeof reviewInboxDeltaBase.json?.sync?.cursor === 'string' && reviewInboxDeltaBase.json.sync.cursor.length > 0, 'review inbox delta base list did not return sync cursor');

    const reviewInboxDeltaImport = await request('create second review inbox review batch', 'POST', '/api/v2/review-inbox/import', {
      body: {
        agent_id: reviewStyleReviewAgentId,
        format: 'text',
        content: '回答风格简洁直接',
      },
    });
    assert(reviewInboxDeltaImport.response.status === 201, `POST /api/v2/review-inbox/import second review batch returned ${reviewInboxDeltaImport.response.status}`);
    assert(reviewInboxDeltaImport.json?.batch_id == null, 'second review inbox import should have been suppressed as a no-op');
    assert(reviewInboxDeltaImport.json?.auto_committed_count === 0, 'second review inbox import should not auto-commit duplicate truth');
    assert(reviewInboxDeltaImport.json?.summary?.pending === 0, 'second review inbox import left unexpected pending items');

    const reviewInboxDelta = await request('list review inbox batches (delta)', 'GET', `/api/v2/review-inbox${query({
      agent_id: reviewStyleReviewAgentId,
      limit: 20,
      cursor: reviewInboxDeltaBase.json?.sync?.cursor,
    })}`, {
      retryable: true,
    });
    assert(reviewInboxDelta.response.status === 200, `GET /api/v2/review-inbox delta returned ${reviewInboxDelta.response.status}`);
    assert(reviewInboxDelta.json?.sync?.mode === 'delta', 'review inbox delta list did not return sync.mode=delta');
    assert((reviewInboxDelta.json?.items || []).length === 0, 'review inbox delta list should stay empty after a suppressed duplicate import');

    const mixedReviewIngest = await request('route mixed auto-commit plus review ingest', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedReviewAgentId,
        user_message: '后续交流中文就行。说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(mixedReviewIngest.response.status === 201, `POST /api/v2/ingest mixed routing returned ${mixedReviewIngest.response.status}`);
    assert(mixedReviewIngest.json?.auto_committed_count === 1, 'mixed routing did not auto-commit exactly one durable');
    assert(mixedReviewIngest.json?.review_pending_count === 1, 'mixed routing did not leave exactly one review item');
    assert(mixedReviewIngest.json?.review_source_preview === '说话干脆一点', 'mixed routing did not narrow review_source_preview to the pending clause');
    assert(mixedReviewIngest.json?.review_summary?.pending === 1, 'mixed routing did not return the pending review summary');
    assert(
      JSON.stringify((mixedReviewIngest.json?.records || []).map((item) => item.content)) === JSON.stringify(['请用中文回答']),
      'mixed routing did not auto-commit only the canonical language rule',
    );
    const mixedReviewBatchId = mixedReviewIngest.json?.review_batch_id;
    assert(typeof mixedReviewBatchId === 'string' && mixedReviewBatchId.length > 0, 'mixed routing did not return review_batch_id');

    const mixedReviewDetail = await request('get mixed auto-commit plus review detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(mixedReviewBatchId)}`, {
      retryable: true,
    });
    assert(mixedReviewDetail.response.status === 200, `GET /api/v2/review-inbox/:id mixed routing returned ${mixedReviewDetail.response.status}`);
    assert(mixedReviewDetail.json?.batch?.source_preview === '说话干脆一点', 'mixed routing batch did not narrow source_preview to the pending clause');
    assert(mixedReviewDetail.json?.items?.[0]?.payload?.source_excerpt === '说话干脆一点', 'mixed routing detail did not keep the pending clause source excerpt');
    assert(mixedReviewDetail.json?.items?.[0]?.payload?.content === '请简洁直接回答', 'mixed routing detail did not keep the canonical response-style candidate');

    const compoundAutoIngest = await request('auto-commit compound durable ingest without review work', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: compoundAutoAgentId,
        user_message: '人在东京这边。先收一下 recall 那块',
        assistant_message: '记住了',
      },
    });
    assert(compoundAutoIngest.response.status === 201, `POST /api/v2/ingest compound auto returned ${compoundAutoIngest.response.status}`);
    assert(compoundAutoIngest.json?.auto_committed_count === 2, 'compound auto ingest did not auto-commit both winners');
    assert(compoundAutoIngest.json?.review_pending_count === 0, 'compound auto ingest should not leave review work');
    assert(
      JSON.stringify((compoundAutoIngest.json?.records || []).map((item) => item.content).sort()) === JSON.stringify(['当前任务是重构 Cortex recall', '我住东京']),
      'compound auto ingest did not write the expected canonical winners',
    );

    const compoundAutoInbox = await request('list compound auto ingest review inbox batches', 'GET', `/api/v2/review-inbox${query({
      agent_id: compoundAutoAgentId,
      limit: 20,
    })}`, {
      retryable: true,
    });
    assert(compoundAutoInbox.response.status === 200, `GET /api/v2/review-inbox compound auto returned ${compoundAutoInbox.response.status}`);
    assert((compoundAutoInbox.json?.items || []).length === 0, 'compound auto ingest should not create review inbox batches');

    const liveReviewFollowupSeed = await request('create pending live review follow-up batch', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: reviewFollowupConfirmAgentId,
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(liveReviewFollowupSeed.response.status === 201, `POST /api/v2/ingest live review follow-up seed returned ${liveReviewFollowupSeed.response.status}`);
    assert(liveReviewFollowupSeed.json?.review_pending_count === 1, 'live review follow-up seed did not create exactly one pending item');
    const followupBatchId = liveReviewFollowupSeed.json?.review_batch_id;
    assert(typeof followupBatchId === 'string' && followupBatchId.length > 0, 'live review follow-up seed did not return batch id');

    const followupConfirm = await request('confirm single pending live review follow-up', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: reviewFollowupConfirmAgentId,
        user_message: '可以',
        assistant_message: '收到',
      },
    });
    assert(followupConfirm.response.status === 201, `POST /api/v2/ingest live review follow-up confirm returned ${followupConfirm.response.status}`);
    assert(followupConfirm.json?.auto_committed_count === 1, 'live review follow-up confirm did not auto-commit exactly one item');
    assert(followupConfirm.json?.review_pending_count === 0, 'live review follow-up confirm left pending items behind');
    assert((followupConfirm.json?.records || []).some((item) => item.content === '请简洁直接回答'), 'live review follow-up confirm did not write the canonical record');

    const followupDetail = await request('get resolved live review follow-up detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(followupBatchId)}`, {
      retryable: true,
    });
    assert(followupDetail.response.status === 200, `GET /api/v2/review-inbox/:id live review follow-up returned ${followupDetail.response.status}`);
    assert(followupDetail.json?.summary?.pending === 0, 'live review follow-up detail still has pending items');
    assert(followupDetail.json?.summary?.accepted === 1, 'live review follow-up detail did not mark the item as accepted');

    const styleRestateSeed = await request('create pending live review style restate batch', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: reviewFollowupStyleRestateAgentId,
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(styleRestateSeed.response.status === 201, `POST /api/v2/ingest live review style restate seed returned ${styleRestateSeed.response.status}`);
    assert(styleRestateSeed.json?.review_pending_count === 1, 'live review style restate seed did not create exactly one pending item');
    const styleRestateBatchId = styleRestateSeed.json?.review_batch_id;
    assert(typeof styleRestateBatchId === 'string' && styleRestateBatchId.length > 0, 'live review style restate seed did not return batch id');

    const styleRestateFollowup = await request('restate live review follow-up style explicitly', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: reviewFollowupStyleRestateAgentId,
        user_message: '简洁直接一点',
        assistant_message: '收到',
      },
    });
    assert(styleRestateFollowup.response.status === 201, `POST /api/v2/ingest live review style restate returned ${styleRestateFollowup.response.status}`);
    assert(styleRestateFollowup.json?.auto_committed_count === 1, 'live review style restate did not auto-commit exactly one item');
    assert(styleRestateFollowup.json?.review_pending_count === 0, 'live review style restate left pending items behind');
    assert((styleRestateFollowup.json?.records || []).some((item) => item.content === '请简洁直接回答'), 'live review style restate did not write the canonical record');

    const styleRestateDetail = await request('get resolved live review style restate detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(styleRestateBatchId)}`, {
      retryable: true,
    });
    assert(styleRestateDetail.response.status === 200, `GET /api/v2/review-inbox/:id live review style restate returned ${styleRestateDetail.response.status}`);
    assert(styleRestateDetail.json?.summary?.pending === 0, 'live review style restate detail still has pending items');
    assert(styleRestateDetail.json?.summary?.accepted === 1, 'live review style restate detail did not mark the item as accepted');

    const styleSelectionLanguageSeed = await request('seed active language rule for response-style selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: reviewFollowupStyleSelectionAgentId,
        kind: 'profile_rule',
        content: '请用中文回答',
      },
    });
    assert(styleSelectionLanguageSeed.response.status === 201, `POST /api/v2/records response-style selection language seed returned ${styleSelectionLanguageSeed.response.status}`);

    const styleSelectionStyleSeed = await request('seed active response-style rule for selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: reviewFollowupStyleSelectionAgentId,
        kind: 'profile_rule',
        content: '请简洁直接回答',
      },
    });
    assert(styleSelectionStyleSeed.response.status === 201, `POST /api/v2/records response-style selection style seed returned ${styleSelectionStyleSeed.response.status}`);

    const styleSelectionFollowup = await request('select only active response-style truth', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: reviewFollowupStyleSelectionAgentId,
        user_message: '只保留回答风格',
        assistant_message: '收到',
      },
    });
    assert(styleSelectionFollowup.response.status === 201, `POST /api/v2/ingest response-style selection returned ${styleSelectionFollowup.response.status}`);
    assert(styleSelectionFollowup.json?.auto_committed_count === 1, 'response-style selection did not auto-commit exactly one item');
    assert(styleSelectionFollowup.json?.review_pending_count === 0, 'response-style selection left pending items behind');
    assert(
      JSON.stringify((styleSelectionFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['请简洁直接回答']),
      'response-style selection did not keep only the canonical response-style record',
    );

    const styleSelectionListed = await request('list selected active response-style records', 'GET', `/api/v2/records${query({
      agent_id: reviewFollowupStyleSelectionAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(styleSelectionListed.response.status === 200, `GET /api/v2/records response-style selection returned ${styleSelectionListed.response.status}`);
    assert(
      JSON.stringify(styleSelectionListed.json?.items.map((item) => item.content)) === JSON.stringify(['请简洁直接回答']),
      'response-style selection did not leave the active truth set with only the canonical response-style rule',
    );

    const mixedActivePendingLanguageSeed = await request('seed active language rule for mixed active-pending selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedActivePendingSelectionAgentId,
        kind: 'profile_rule',
        content: '请用中文回答',
      },
    });
    assert(mixedActivePendingLanguageSeed.response.status === 201, `POST /api/v2/records mixed active-pending selection language seed returned ${mixedActivePendingLanguageSeed.response.status}`);

    const mixedActivePendingReviewSeed = await request('create pending response-style review for mixed active-pending selection', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingSelectionAgentId,
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingReviewSeed.response.status === 201, `POST /api/v2/ingest mixed active-pending selection review seed returned ${mixedActivePendingReviewSeed.response.status}`);
    assert(mixedActivePendingReviewSeed.json?.auto_committed_count === 0, 'mixed active-pending selection review seed should not auto-commit active records');
    assert(mixedActivePendingReviewSeed.json?.review_pending_count === 1, 'mixed active-pending selection review seed should create one pending review item');
    const mixedActivePendingBatchId = mixedActivePendingReviewSeed.json?.review_batch_id;
    assert(typeof mixedActivePendingBatchId === 'string' && mixedActivePendingBatchId.length > 0, 'mixed active-pending selection review seed did not return batch id');

    const mixedActivePendingFollowup = await request('keep mixed active language drop and pending style survivor', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingSelectionAgentId,
        user_message: '只保留回答风格，别用中文',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingFollowup.response.status === 201, `POST /api/v2/ingest mixed active-pending selection returned ${mixedActivePendingFollowup.response.status}`);
    assert(mixedActivePendingFollowup.json?.auto_committed_count === 1, 'mixed active-pending selection should return exactly one committed survivor');
    assert(mixedActivePendingFollowup.json?.review_pending_count === 0, 'mixed active-pending selection should not leave review work behind');
    assert(
      JSON.stringify((mixedActivePendingFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['请简洁直接回答']),
      'mixed active-pending selection did not keep the canonical response-style survivor',
    );

    const mixedActivePendingDetail = await request('get mixed active-pending selection review batch detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(mixedActivePendingBatchId)}`, {
      retryable: true,
    });
    assert(mixedActivePendingDetail.response.status === 200, `GET /api/v2/review-inbox/:id mixed active-pending selection returned ${mixedActivePendingDetail.response.status}`);
    assert(mixedActivePendingDetail.json?.summary?.pending === 0, 'mixed active-pending selection detail should leave no pending items');
    assert(mixedActivePendingDetail.json?.summary?.accepted === 1, 'mixed active-pending selection detail should accept exactly one pending item');

    const mixedActivePendingListed = await request('list mixed active-pending survivors after selection', 'GET', `/api/v2/records${query({
      agent_id: mixedActivePendingSelectionAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(mixedActivePendingListed.response.status === 200, `GET /api/v2/records mixed active-pending selection returned ${mixedActivePendingListed.response.status}`);
    assert(
      JSON.stringify(mixedActivePendingListed.json?.items.map((item) => item.content)) === JSON.stringify(['请简洁直接回答']),
      'mixed active-pending selection did not leave only the canonical response-style truth active',
    );

    const mixedActivePendingKeepLanguageSeed = await request('seed active language rule for mixed active-pending keep-language selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedActivePendingKeepLanguageAgentId,
        kind: 'profile_rule',
        content: '请用中文回答',
      },
    });
    assert(mixedActivePendingKeepLanguageSeed.response.status === 201, `POST /api/v2/records mixed active-pending keep-language language seed returned ${mixedActivePendingKeepLanguageSeed.response.status}`);

    const mixedActivePendingKeepLanguageReviewSeed = await request('create pending response-style review for mixed active-pending keep-language selection', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingKeepLanguageAgentId,
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingKeepLanguageReviewSeed.response.status === 201, `POST /api/v2/ingest mixed active-pending keep-language selection review seed returned ${mixedActivePendingKeepLanguageReviewSeed.response.status}`);
    assert(mixedActivePendingKeepLanguageReviewSeed.json?.auto_committed_count === 0, 'mixed active-pending keep-language review seed should not auto-commit active records');
    assert(mixedActivePendingKeepLanguageReviewSeed.json?.review_pending_count === 1, 'mixed active-pending keep-language review seed should create one pending review item');
    const mixedActivePendingKeepLanguageBatchId = mixedActivePendingKeepLanguageReviewSeed.json?.review_batch_id;
    assert(typeof mixedActivePendingKeepLanguageBatchId === 'string' && mixedActivePendingKeepLanguageBatchId.length > 0, 'mixed active-pending keep-language review seed did not return batch id');

    const mixedActivePendingKeepLanguageFollowup = await request('keep active language and reject pending response-style review noise', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingKeepLanguageAgentId,
        user_message: '只保留中文',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingKeepLanguageFollowup.response.status === 201, `POST /api/v2/ingest mixed active-pending keep-language selection returned ${mixedActivePendingKeepLanguageFollowup.response.status}`);
    assert(mixedActivePendingKeepLanguageFollowup.json?.auto_committed_count === 1, 'mixed active-pending keep-language selection should return exactly one committed survivor');
    assert(mixedActivePendingKeepLanguageFollowup.json?.review_pending_count === 0, 'mixed active-pending keep-language selection should not leave review work behind');
    assert(
      JSON.stringify((mixedActivePendingKeepLanguageFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['请用中文回答']),
      'mixed active-pending keep-language selection did not keep the canonical active language survivor',
    );

    const mixedActivePendingKeepLanguageDetail = await request('get mixed active-pending keep-language review batch detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(mixedActivePendingKeepLanguageBatchId)}`, {
      retryable: true,
    });
    assert(mixedActivePendingKeepLanguageDetail.response.status === 200, `GET /api/v2/review-inbox/:id mixed active-pending keep-language selection returned ${mixedActivePendingKeepLanguageDetail.response.status}`);
    assert(mixedActivePendingKeepLanguageDetail.json?.summary?.pending === 0, 'mixed active-pending keep-language detail should leave no pending items');
    assert(mixedActivePendingKeepLanguageDetail.json?.summary?.accepted === 0, 'mixed active-pending keep-language detail should not accept pending items');
    assert(mixedActivePendingKeepLanguageDetail.json?.summary?.rejected === 1, 'mixed active-pending keep-language detail should reject exactly one pending item');

    const mixedActivePendingKeepLanguageListed = await request('list mixed active-pending keep-language survivors after selection', 'GET', `/api/v2/records${query({
      agent_id: mixedActivePendingKeepLanguageAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(mixedActivePendingKeepLanguageListed.response.status === 200, `GET /api/v2/records mixed active-pending keep-language selection returned ${mixedActivePendingKeepLanguageListed.response.status}`);
    assert(
      JSON.stringify(mixedActivePendingKeepLanguageListed.json?.items.map((item) => item.content)) === JSON.stringify(['请用中文回答']),
      'mixed active-pending keep-language selection did not leave only the canonical language truth active',
    );

    const mixedActivePendingKeepLocationSeed = await request('seed active location truth for mixed active-pending keep-location selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedActivePendingKeepLocationAgentId,
        kind: 'fact_slot',
        content: '我住东京',
      },
    });
    assert(mixedActivePendingKeepLocationSeed.response.status === 201, `POST /api/v2/records mixed active-pending keep-location seed returned ${mixedActivePendingKeepLocationSeed.response.status}`);

    const mixedActivePendingKeepLocationReviewSeed = await request('create pending response-style review for mixed active-pending keep-location selection', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingKeepLocationAgentId,
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingKeepLocationReviewSeed.response.status === 201, `POST /api/v2/ingest mixed active-pending keep-location selection review seed returned ${mixedActivePendingKeepLocationReviewSeed.response.status}`);
    assert(mixedActivePendingKeepLocationReviewSeed.json?.auto_committed_count === 0, 'mixed active-pending keep-location review seed should not auto-commit active records');
    assert(mixedActivePendingKeepLocationReviewSeed.json?.review_pending_count === 1, 'mixed active-pending keep-location review seed should create one pending review item');
    const mixedActivePendingKeepLocationBatchId = mixedActivePendingKeepLocationReviewSeed.json?.review_batch_id;
    assert(typeof mixedActivePendingKeepLocationBatchId === 'string' && mixedActivePendingKeepLocationBatchId.length > 0, 'mixed active-pending keep-location review seed did not return batch id');

    const mixedActivePendingKeepLocationFollowup = await request('keep active location and reject pending response-style review noise', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingKeepLocationAgentId,
        user_message: '只保留住址',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingKeepLocationFollowup.response.status === 201, `POST /api/v2/ingest mixed active-pending keep-location selection returned ${mixedActivePendingKeepLocationFollowup.response.status}`);
    assert(mixedActivePendingKeepLocationFollowup.json?.auto_committed_count === 1, 'mixed active-pending keep-location selection should return exactly one committed survivor');
    assert(mixedActivePendingKeepLocationFollowup.json?.review_pending_count === 0, 'mixed active-pending keep-location selection should not leave review work behind');
    assert(
      JSON.stringify((mixedActivePendingKeepLocationFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['我住东京']),
      'mixed active-pending keep-location selection did not keep the canonical active location survivor',
    );

    const mixedActivePendingKeepLocationDetail = await request('get mixed active-pending keep-location review batch detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(mixedActivePendingKeepLocationBatchId)}`, {
      retryable: true,
    });
    assert(mixedActivePendingKeepLocationDetail.response.status === 200, `GET /api/v2/review-inbox/:id mixed active-pending keep-location selection returned ${mixedActivePendingKeepLocationDetail.response.status}`);
    assert(mixedActivePendingKeepLocationDetail.json?.summary?.pending === 0, 'mixed active-pending keep-location detail should leave no pending items');
    assert(mixedActivePendingKeepLocationDetail.json?.summary?.accepted === 0, 'mixed active-pending keep-location detail should not accept pending items');
    assert(mixedActivePendingKeepLocationDetail.json?.summary?.rejected === 1, 'mixed active-pending keep-location detail should reject exactly one pending item');

    const mixedActivePendingKeepLocationListed = await request('list mixed active-pending keep-location survivors after selection', 'GET', `/api/v2/records${query({
      agent_id: mixedActivePendingKeepLocationAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(mixedActivePendingKeepLocationListed.response.status === 200, `GET /api/v2/records mixed active-pending keep-location selection returned ${mixedActivePendingKeepLocationListed.response.status}`);
    assert(
      JSON.stringify(mixedActivePendingKeepLocationListed.json?.items.map((item) => item.content)) === JSON.stringify(['我住东京']),
      'mixed active-pending keep-location selection did not leave only the canonical location truth active',
    );

    const mixedActivePendingKeepTaskLanguageSeed = await request('seed active language rule for mixed active-pending keep-task selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedActivePendingKeepTaskAgentId,
        kind: 'profile_rule',
        content: '请用中文回答',
      },
    });
    assert(mixedActivePendingKeepTaskLanguageSeed.response.status === 201, `POST /api/v2/records mixed active-pending keep-task language seed returned ${mixedActivePendingKeepTaskLanguageSeed.response.status}`);

    const mixedActivePendingKeepTaskSeed = await request('seed active task for mixed active-pending keep-task selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedActivePendingKeepTaskAgentId,
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
      },
    });
    assert(mixedActivePendingKeepTaskSeed.response.status === 201, `POST /api/v2/records mixed active-pending keep-task seed returned ${mixedActivePendingKeepTaskSeed.response.status}`);

    const mixedActivePendingKeepTaskReviewSeed = await request('create pending response-style review for mixed active-pending keep-task selection', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingKeepTaskAgentId,
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingKeepTaskReviewSeed.response.status === 201, `POST /api/v2/ingest mixed active-pending keep-task review seed returned ${mixedActivePendingKeepTaskReviewSeed.response.status}`);
    assert(mixedActivePendingKeepTaskReviewSeed.json?.auto_committed_count === 0, 'mixed active-pending keep-task review seed should not auto-commit active records');
    assert(mixedActivePendingKeepTaskReviewSeed.json?.review_pending_count === 1, 'mixed active-pending keep-task review seed should create one pending review item');
    const mixedActivePendingKeepTaskBatchId = mixedActivePendingKeepTaskReviewSeed.json?.review_batch_id;
    assert(typeof mixedActivePendingKeepTaskBatchId === 'string' && mixedActivePendingKeepTaskBatchId.length > 0, 'mixed active-pending keep-task review seed did not return batch id');

    const mixedActivePendingKeepTaskFollowup = await request('keep active current task and reject pending review noise', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedActivePendingKeepTaskAgentId,
        user_message: '只保留当前任务',
        assistant_message: '收到',
      },
    });
    assert(mixedActivePendingKeepTaskFollowup.response.status === 201, `POST /api/v2/ingest mixed active-pending keep-task selection returned ${mixedActivePendingKeepTaskFollowup.response.status}`);
    assert(mixedActivePendingKeepTaskFollowup.json?.auto_committed_count === 1, 'mixed active-pending keep-task selection should return exactly one committed survivor');
    assert(mixedActivePendingKeepTaskFollowup.json?.review_pending_count === 0, 'mixed active-pending keep-task selection should not leave review work behind');
    assert(
      JSON.stringify((mixedActivePendingKeepTaskFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['当前任务是重构 Cortex recall']),
      'mixed active-pending keep-task selection did not keep the canonical active task survivor',
    );

    const mixedActivePendingKeepTaskDetail = await request('get mixed active-pending keep-task review batch detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(mixedActivePendingKeepTaskBatchId)}`, {
      retryable: true,
    });
    assert(mixedActivePendingKeepTaskDetail.response.status === 200, `GET /api/v2/review-inbox/:id mixed active-pending keep-task selection returned ${mixedActivePendingKeepTaskDetail.response.status}`);
    assert(mixedActivePendingKeepTaskDetail.json?.summary?.pending === 0, 'mixed active-pending keep-task detail should leave no pending items');
    assert(mixedActivePendingKeepTaskDetail.json?.summary?.accepted === 0, 'mixed active-pending keep-task detail should not accept pending items');
    assert(mixedActivePendingKeepTaskDetail.json?.summary?.rejected === 1, 'mixed active-pending keep-task detail should reject exactly one pending item');

    const mixedActivePendingKeepTaskListed = await request('list mixed active-pending keep-task survivors after selection', 'GET', `/api/v2/records${query({
      agent_id: mixedActivePendingKeepTaskAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(mixedActivePendingKeepTaskListed.response.status === 200, `GET /api/v2/records mixed active-pending keep-task selection returned ${mixedActivePendingKeepTaskListed.response.status}`);
    assert(
      JSON.stringify(mixedActivePendingKeepTaskListed.json?.items.map((item) => item.content)) === JSON.stringify(['当前任务是重构 Cortex recall']),
      'mixed active-pending keep-task selection did not leave only the canonical current task truth active',
    );

    const mixedSelectionLanguageSeed = await request('seed active language rule for mixed selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedSelectionAgentId,
        kind: 'profile_rule',
        content: '请用中文回答',
      },
    });
    assert(mixedSelectionLanguageSeed.response.status === 201, `POST /api/v2/records mixed selection language seed returned ${mixedSelectionLanguageSeed.response.status}`);

    const mixedSelectionLengthSeed = await request('seed active response-length rule for mixed selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedSelectionAgentId,
        kind: 'profile_rule',
        content: '请把回答控制在三句话内',
      },
    });
    assert(mixedSelectionLengthSeed.response.status === 201, `POST /api/v2/records mixed selection length seed returned ${mixedSelectionLengthSeed.response.status}`);

    const mixedSelectionLocationSeed = await request('seed active location fact for mixed selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedSelectionAgentId,
        kind: 'fact_slot',
        content: '我住东京',
      },
    });
    assert(mixedSelectionLocationSeed.response.status === 201, `POST /api/v2/records mixed selection location seed returned ${mixedSelectionLocationSeed.response.status}`);

    const mixedSelectionOrganizationSeed = await request('seed active organization fact for mixed selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedSelectionAgentId,
        kind: 'fact_slot',
        content: '我在 OpenAI 工作',
      },
    });
    assert(mixedSelectionOrganizationSeed.response.status === 201, `POST /api/v2/records mixed selection organization seed returned ${mixedSelectionOrganizationSeed.response.status}`);

    const mixedSelectionFollowup = await request('keep mixed active language and location survivors', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedSelectionAgentId,
        user_message: '只保留中文和住址',
        assistant_message: '收到',
      },
    });
    assert(mixedSelectionFollowup.response.status === 201, `POST /api/v2/ingest mixed selection returned ${mixedSelectionFollowup.response.status}`);
    assert(mixedSelectionFollowup.json?.auto_committed_count === 2, 'mixed selection did not auto-commit exactly two survivors');
    assert(mixedSelectionFollowup.json?.review_pending_count === 0, 'mixed selection left pending items behind');
    assert(
      JSON.stringify((mixedSelectionFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['请用中文回答', '我住东京']),
      'mixed selection did not keep the expected language + location survivors',
    );

    const mixedSelectionListed = await request('list mixed active survivors after selection', 'GET', `/api/v2/records${query({
      agent_id: mixedSelectionAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(mixedSelectionListed.response.status === 200, `GET /api/v2/records mixed selection returned ${mixedSelectionListed.response.status}`);
    assert(
      JSON.stringify(mixedSelectionListed.json?.items.map((item) => item.content).sort()) === JSON.stringify(['我住东京', '请用中文回答']),
      'mixed selection did not leave only the expected language + location active truths',
    );

    const mixedSelectionCandidates = await request('list mixed active relation candidates after selection', 'GET', `/api/v2/relation-candidates${query({
      agent_id: mixedSelectionAgentId,
      status: 'pending',
      limit: 20,
    })}`, { retryable: true });
    assert(mixedSelectionCandidates.response.status === 200, `GET /api/v2/relation-candidates mixed selection returned ${mixedSelectionCandidates.response.status}`);
    assert(
      JSON.stringify(mixedSelectionCandidates.json?.items.map((item) => item.object_key)) === JSON.stringify(['东京']),
      'mixed selection did not preserve only the surviving location relation candidate',
    );

    const mixedDropAllLanguageSeed = await request('seed active language rule for mixed drop-all', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedDropAllAgentId,
        kind: 'profile_rule',
        content: '请用中文回答',
      },
    });
    assert(mixedDropAllLanguageSeed.response.status === 201, `POST /api/v2/records mixed drop-all language seed returned ${mixedDropAllLanguageSeed.response.status}`);

    const mixedDropAllLocationSeed = await request('seed active location fact for mixed drop-all', 'POST', '/api/v2/records', {
      body: {
        agent_id: mixedDropAllAgentId,
        kind: 'fact_slot',
        content: '我住东京',
      },
    });
    assert(mixedDropAllLocationSeed.response.status === 201, `POST /api/v2/records mixed drop-all location seed returned ${mixedDropAllLocationSeed.response.status}`);

    const mixedDropAllFollowup = await request('drop all mixed active truths', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: mixedDropAllAgentId,
        user_message: '都去掉',
        assistant_message: '收到',
      },
    });
    assert(mixedDropAllFollowup.response.status === 201, `POST /api/v2/ingest mixed drop-all returned ${mixedDropAllFollowup.response.status}`);
    assert(mixedDropAllFollowup.json?.auto_committed_count === 0, 'mixed drop-all should not auto-commit new records');
    assert(mixedDropAllFollowup.json?.review_pending_count === 0, 'mixed drop-all should not leave review work behind');
    assert((mixedDropAllFollowup.json?.records || []).length === 0, 'mixed drop-all should not return surviving records');

    const mixedDropAllListed = await request('list mixed active truths after drop-all', 'GET', `/api/v2/records${query({
      agent_id: mixedDropAllAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(mixedDropAllListed.response.status === 200, `GET /api/v2/records mixed drop-all returned ${mixedDropAllListed.response.status}`);
    assert((mixedDropAllListed.json?.items || []).length === 0, 'mixed drop-all should remove all active truths');

    const mixedDropAllCandidates = await request('list mixed relation candidates after drop-all', 'GET', `/api/v2/relation-candidates${query({
      agent_id: mixedDropAllAgentId,
      status: 'pending',
      limit: 20,
    })}`, { retryable: true });
    assert(mixedDropAllCandidates.response.status === 200, `GET /api/v2/relation-candidates mixed drop-all returned ${mixedDropAllCandidates.response.status}`);
    assert((mixedDropAllCandidates.json?.items || []).length === 0, 'mixed drop-all should clear all pending relation candidates');

    const taskSelectionLanguageSeed = await request('seed active language rule for task selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: taskSelectionAgentId,
        kind: 'profile_rule',
        content: '请用中文回答',
      },
    });
    assert(taskSelectionLanguageSeed.response.status === 201, `POST /api/v2/records task selection language seed returned ${taskSelectionLanguageSeed.response.status}`);

    const taskSelectionSeed = await request('seed active task for selection', 'POST', '/api/v2/records', {
      body: {
        agent_id: taskSelectionAgentId,
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
      },
    });
    assert(taskSelectionSeed.response.status === 201, `POST /api/v2/records task selection seed returned ${taskSelectionSeed.response.status}`);

    const taskSelectionFollowup = await request('select only active current task', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: taskSelectionAgentId,
        user_message: '只保留当前任务',
        assistant_message: '收到',
      },
    });
    assert(taskSelectionFollowup.response.status === 201, `POST /api/v2/ingest task selection returned ${taskSelectionFollowup.response.status}`);
    assert(taskSelectionFollowup.json?.auto_committed_count === 1, 'task selection did not auto-commit exactly one survivor');
    assert(taskSelectionFollowup.json?.review_pending_count === 0, 'task selection left pending items behind');
    assert(
      JSON.stringify((taskSelectionFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['当前任务是重构 Cortex recall']),
      'task selection did not keep only the current task survivor',
    );

    const taskSelectionListed = await request('list active task survivors after selection', 'GET', `/api/v2/records${query({
      agent_id: taskSelectionAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(taskSelectionListed.response.status === 200, `GET /api/v2/records task selection returned ${taskSelectionListed.response.status}`);
    assert((taskSelectionListed.json?.items || []).length === 1, 'task selection should leave exactly one active record');
    assert(taskSelectionListed.json?.items?.[0]?.content === '当前任务是重构 Cortex recall', 'task selection did not leave the canonical current-task truth active');

    const taskRewriteSeed = await request('seed active task for rewrite', 'POST', '/api/v2/records', {
      body: {
        agent_id: taskRewriteAgentId,
        kind: 'task_state',
        content: '当前任务是重构 Cortex recall',
      },
    });
    assert(taskRewriteSeed.response.status === 201, `POST /api/v2/records task rewrite seed returned ${taskRewriteSeed.response.status}`);

    const taskRewriteFollowup = await request('rewrite active current task to deployment', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: taskRewriteAgentId,
        user_message: '改部署',
        assistant_message: '收到',
      },
    });
    assert(taskRewriteFollowup.response.status === 201, `POST /api/v2/ingest task rewrite returned ${taskRewriteFollowup.response.status}`);
    assert(taskRewriteFollowup.json?.auto_committed_count === 1, 'task rewrite did not auto-commit exactly one item');
    assert(taskRewriteFollowup.json?.review_pending_count === 0, 'task rewrite left pending items behind');
    assert(taskRewriteFollowup.json?.records?.[0]?.content === '当前任务是部署 Cortex', 'task rewrite did not produce the canonical deployment task');

    const taskRewriteListed = await request('list rewritten current task truth', 'GET', `/api/v2/records${query({
      agent_id: taskRewriteAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(taskRewriteListed.response.status === 200, `GET /api/v2/records task rewrite returned ${taskRewriteListed.response.status}`);
    assert((taskRewriteListed.json?.items || []).length === 1, 'task rewrite should leave exactly one active record');
    assert(taskRewriteListed.json?.items?.[0]?.content === '当前任务是部署 Cortex', 'task rewrite did not leave the canonical deployment task active');

    const organizationRewriteSeed = await request('seed active organization truth for rewrite', 'POST', '/api/v2/records', {
      body: {
        agent_id: organizationRewriteAgentId,
        kind: 'fact_slot',
        content: '我在 OpenAI 工作',
      },
    });
    assert(organizationRewriteSeed.response.status === 201, `POST /api/v2/records organization rewrite seed returned ${organizationRewriteSeed.response.status}`);

    const organizationRewriteFollowup = await request('rewrite active organization truth to Tencent', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: organizationRewriteAgentId,
        user_message: '换 腾讯',
        assistant_message: '收到',
      },
    });
    assert(organizationRewriteFollowup.response.status === 201, `POST /api/v2/ingest organization rewrite returned ${organizationRewriteFollowup.response.status}`);
    assert(organizationRewriteFollowup.json?.auto_committed_count === 1, 'organization rewrite did not auto-commit exactly one item');
    assert(organizationRewriteFollowup.json?.review_pending_count === 0, 'organization rewrite left pending items behind');
    assert(organizationRewriteFollowup.json?.records?.[0]?.content === '我在 腾讯 工作', 'organization rewrite did not produce the canonical Tencent fact');

    const organizationRewriteListed = await request('list rewritten organization truth', 'GET', `/api/v2/records${query({
      agent_id: organizationRewriteAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(organizationRewriteListed.response.status === 200, `GET /api/v2/records organization rewrite returned ${organizationRewriteListed.response.status}`);
    assert((organizationRewriteListed.json?.items || []).length === 1, 'organization rewrite should leave exactly one active fact');
    assert(organizationRewriteListed.json?.items?.[0]?.content === '我在 腾讯 工作', 'organization rewrite did not leave the canonical Tencent fact active');

    const organizationRewriteCandidates = await request('list organization relation candidates after rewrite', 'GET', `/api/v2/relation-candidates${query({
      agent_id: organizationRewriteAgentId,
      status: 'pending',
      limit: 20,
    })}`, { retryable: true });
    assert(organizationRewriteCandidates.response.status === 200, `GET /api/v2/relation-candidates organization rewrite returned ${organizationRewriteCandidates.response.status}`);
    assert(
      JSON.stringify(organizationRewriteCandidates.json?.items.map((item) => item.object_key)) === JSON.stringify(['腾讯']),
      'organization rewrite did not leave only the rewritten organization relation candidate',
    );

    const mismatchSeed = await request('create pending live review mismatched rewrite batch', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: reviewFollowupMismatchAgentId,
        user_message: '说话干脆一点',
        assistant_message: '收到',
      },
    });
    assert(mismatchSeed.response.status === 201, `POST /api/v2/ingest live review mismatched rewrite seed returned ${mismatchSeed.response.status}`);
    assert(mismatchSeed.json?.review_pending_count === 1, 'live review mismatched rewrite seed did not create exactly one pending item');
    const mismatchBatchId = mismatchSeed.json?.review_batch_id;
    assert(typeof mismatchBatchId === 'string' && mismatchBatchId.length > 0, 'live review mismatched rewrite seed did not return batch id');

    const mismatchFollowup = await request('send mismatched live review follow-up rewrite', 'POST', '/api/v2/ingest', {
      body: {
        agent_id: reviewFollowupMismatchAgentId,
        user_message: '改英文',
        assistant_message: '收到',
      },
    });
    assert(mismatchFollowup.response.status === 201, `POST /api/v2/ingest live review mismatched rewrite returned ${mismatchFollowup.response.status}`);

    const mismatchDetail = await request('get pending live review mismatched rewrite detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(mismatchBatchId)}`, {
      retryable: true,
    });
    assert(mismatchDetail.response.status === 200, `GET /api/v2/review-inbox/:id live review mismatched rewrite returned ${mismatchDetail.response.status}`);
    assert(mismatchDetail.json?.summary?.pending === 1, 'live review mismatched rewrite detail should keep one pending item');
    assert(mismatchDetail.json?.summary?.accepted === 0, 'live review mismatched rewrite detail should not mark the item as accepted');
    assert(mismatchDetail.json?.items?.[0]?.status === 'pending', 'live review mismatched rewrite item should remain pending');
    assert(mismatchDetail.json?.items?.[0]?.payload?.attribute_key === 'response_style', 'live review mismatched rewrite should keep the pending response-style attribute');

    const mismatchRecords = await request('list live review mismatched rewrite records', 'GET', `/api/v2/records${query({
      agent_id: reviewFollowupMismatchAgentId,
      limit: 20,
    })}`, { retryable: true });
    assert(mismatchRecords.response.status === 200, `GET /api/v2/records live review mismatched rewrite returned ${mismatchRecords.response.status}`);
    assert(!(mismatchRecords.json?.items || []).some((item) => item.attribute_key === 'response_style' && item.content === '请用英文回答'), 'live review mismatched rewrite should not write an attribute-mismatched response-style record');
    logStep('review inbox', 'auto-commit, review batch, mixed auto-review routing, compound auto routing, apply, follow-up confirm, follow-up style restate, active-truth selection, mixed active-pending selection, mixed keep-language/location/task selection, mixed survivor selection, mixed drop-all, task selection, task rewrite, organization rewrite, follow-up rewrite guard, suppression, and delta sync all passed');

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
    const deletedReviewBatch = await request('create deleted-agent review inbox batch', 'POST', '/api/v2/review-inbox/import', {
      body: {
        agent_id: deletedAgentId,
        format: 'text',
        content: '说话干脆一点',
      },
    });
    assert(deletedReviewBatch.response.status === 201, `POST /api/v2/review-inbox/import deleted-agent returned ${deletedReviewBatch.response.status}`);
    const deletedReviewBatchId = deletedReviewBatch.json?.batch_id;
    assert(typeof deletedReviewBatchId === 'string' && deletedReviewBatchId.length > 0, 'deleted-agent review inbox import did not return batch_id');
    const deletedAgentResponse = await request('delete probe deleted-agent', 'DELETE', `/api/v2/agents/${encodeURIComponent(deletedAgentId)}`);
    assert(deletedAgentResponse.response.status === 200, `DELETE /api/v2/agents/:id returned ${deletedAgentResponse.response.status}`);

    const deletedReviewList = await request('list deleted-agent review inbox batches', 'GET', `/api/v2/review-inbox?agent_id=${encodeURIComponent(deletedAgentId)}&limit=20`, {
      retryable: true,
    });
    assert(deletedReviewList.response.status === 200, `GET /api/v2/review-inbox deleted-agent returned ${deletedReviewList.response.status}`);
    assert((deletedReviewList.json?.items || []).length === 0, 'deleted-agent review inbox batch is still visible');

    const deletedReviewDetail = await request('get deleted-agent review inbox batch detail', 'GET', `/api/v2/review-inbox/${encodeURIComponent(deletedReviewBatchId)}`, {
      expectedStatus: 404,
      retryable: true,
    });
    assert(deletedReviewDetail.response.status === 404, `GET /api/v2/review-inbox/:id deleted-agent returned ${deletedReviewDetail.response.status}`);

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
    assert(typeof primaryText === 'string', 'primary MCP search did not return text content');
    assert(typeof compatText === 'string', 'compat MCP search did not return text content');
    const primaryResults = JSON.parse(primaryText).results;
    const compatResults = JSON.parse(compatText).results;
    assert(Array.isArray(primaryResults) && primaryResults.length > 0, 'primary MCP search returned no results');
    assert(Array.isArray(compatResults) && compatResults.length > 0, 'compat MCP search returned no results');
    assert(primaryResults[0]?.agent_id === probeAgentId, 'primary MCP search returned the wrong agent result');
    assert(compatResults[0]?.agent_id === probeAgentId, 'compat MCP search returned the wrong agent result');
    assert(primaryResults[0]?.attribute_key === 'location', 'primary MCP search did not return the location fact');
    assert(compatResults[0]?.attribute_key === 'location', 'compat MCP search did not return the location fact');
    assert(String(primaryResults[0]?.content || '').includes('Taipei'), 'primary MCP search did not include the Taipei fact');
    assert(String(compatResults[0]?.content || '').includes('Taipei'), 'compat MCP search did not include the Taipei fact');
    assert(primaryResults[0]?.eligible_for_recall === true, 'primary MCP search result should stay recall-eligible');
    assert(compatResults[0]?.eligible_for_recall === true, 'compat MCP search result should stay recall-eligible');
    assert(JSON.stringify(primaryResults) === JSON.stringify(compatResults), 'MCP search result differs between /mcp and /mcp/message');
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
  const smokeClass = error && typeof error === 'object' && 'smokeClass' in error
    ? String(error.smokeClass)
    : null;
  const smokePhase = error && typeof error === 'object' && 'smokePhase' in error
    ? String(error.smokePhase)
    : null;
  const operationKind = error && typeof error === 'object' && 'operationKind' in error
    ? String(error.operationKind)
    : null;
  const method = error && typeof error === 'object' && 'method' in error
    ? String(error.method)
    : null;
  const path = error && typeof error === 'object' && 'path' in error
    ? String(error.path)
    : null;
  const attemptsUsed = error && typeof error === 'object' && 'attemptsUsed' in error
    ? Number(error.attemptsUsed)
    : null;
  const prefix = smokeClass ? `Smoke test failed [${smokeClass}]` : 'Smoke test failed';
  const phaseDetail = smokePhase ? ` during ${smokePhase}` : '';
  const routeDetail = method && path ? ` on ${method} ${path}` : '';
  const operationDetail = operationKind ? ` [${operationKind}]` : '';
  const attemptDetail = Number.isFinite(attemptsUsed) ? ` after ${attemptsUsed} attempt(s)` : '';
  process.stderr.write(`${prefix}${operationDetail}${phaseDetail}${routeDetail}${attemptDetail}: ${error.message}\n`);
  process.exit(1);
});

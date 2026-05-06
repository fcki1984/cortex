#!/usr/bin/env node

import { resolveSmokeBaseUrl, runBestEffortSteps, runSmokeRequest } from './smoke-v2-lib.mjs';

const resolvedBaseUrl = resolveSmokeBaseUrl({
  validationBaseUrl: process.env.CORTEX_RECALL_EVAL_VALIDATION_URL || process.env.CORTEX_REMOTE_VALIDATION_URL,
  baseUrl: process.env.CORTEX_BASE_URL || process.env.CORTEX_URL,
  cliBaseUrl: process.argv[2],
  defaultBaseUrl: 'http://localhost:21100',
});
const baseUrl = resolvedBaseUrl.baseUrl;
const baseUrlSource = resolvedBaseUrl.source;
const authToken = process.env.CORTEX_AUTH_TOKEN || '';
const baseAgentId = process.env.CORTEX_AGENT_ID || `rev2-${Date.now().toString(36)}`;
const recallEvalRounds = Math.max(1, Number(process.env.RECALL_EVAL_ROUNDS || process.argv[3] || '1'));
const MAX_AGENT_ID_LENGTH = 64;

function assert(condition, message, meta) {
  if (condition) return;
  const detail = meta === undefined ? '' : `\n${JSON.stringify(meta, null, 2).slice(0, 2000)}`;
  throw new Error(`${message}${detail}`);
}

function logStep(label, detail) {
  process.stdout.write(`- ${label}${detail ? `: ${detail}` : ''}\n`);
}

function query(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `?${suffix}` : '';
}

function getAgentId(round) {
  return recallEvalRounds === 1 ? baseAgentId : `${baseAgentId}-r${round}`;
}

function getEvalRunId(round) {
  const suffix = recallEvalRounds === 1 ? 'single' : `r${round}`;
  return `${baseAgentId}-recall-eval-${suffix}`;
}

async function request(smokeRunId, label, method, path, options = {}) {
  return runSmokeRequest({
    baseUrl,
    authToken,
    smokeRunId,
    label,
    method,
    path,
    retryable: method === 'GET' || options.retryable === true,
    ...options,
  });
}

async function deleteById(smokeRunId, pathPrefix, items) {
  for (const item of items || []) {
    if (!item?.id) continue;
    await request(smokeRunId, `cleanup ${pathPrefix}`, 'DELETE', `${pathPrefix}/${encodeURIComponent(item.id)}`, {
      retryable: true,
      smokePhase: 'cleanup',
    });
  }
}

async function cleanupAgent(agentId, smokeRunId) {
  return runBestEffortSteps([
    {
      label: `cleanup records for ${agentId}`,
      run: async () => {
        const records = await request(smokeRunId, `list records for cleanup (${agentId})`, 'GET', `/api/v2/records${query({ agent_id: agentId, include_inactive: true, limit: 200 })}`, {
          smokePhase: 'cleanup',
        });
        await deleteById(smokeRunId, '/api/v2/records', records.json?.items || []);
      },
    },
    {
      label: `cleanup relations for ${agentId}`,
      run: async () => {
        const relations = await request(smokeRunId, `list relations for cleanup (${agentId})`, 'GET', `/api/v2/relations${query({ agent_id: agentId, limit: 200 })}`, {
          smokePhase: 'cleanup',
        });
        await deleteById(smokeRunId, '/api/v2/relations', relations.json?.items || []);
      },
    },
    {
      label: `cleanup relation candidates for ${agentId}`,
      run: async () => {
        const candidates = await request(smokeRunId, `list relation candidates for cleanup (${agentId})`, 'GET', `/api/v2/relation-candidates${query({ agent_id: agentId, limit: 200 })}`, {
          smokePhase: 'cleanup',
        });
        await deleteById(smokeRunId, '/api/v2/relation-candidates', candidates.json?.items || []);
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
          await request(smokeRunId, `delete probe agent ${agentId}`, 'DELETE', `/api/v2/agents/${encodeURIComponent(agentId)}`, {
            smokePhase: 'cleanup',
          });
        }
      },
    },
  ]);
}

function contextContains(body, value) {
  return typeof body?.context === 'string' && body.context.includes(value);
}

function assertNoUnrelatedContext(label, body, forbiddenValues) {
  for (const value of forbiddenValues) {
    assert(!contextContains(body, value), `${label} injected unrelated context value ${value}`, body);
  }
}

function basisKinds(body) {
  return (body?.meta?.relevance_basis || []).map((item) => item.kind);
}

async function createRecord(smokeRunId, agentId, label, payload) {
  const created = await request(smokeRunId, label, 'POST', '/api/v2/records', {
    body: {
      agent_id: agentId,
      ...payload,
    },
  });
  assert(created.response.status === 201, `${label} returned ${created.response.status}`, created.json);
  return created.json?.record;
}

async function recall(smokeRunId, agentId, label, queryText) {
  const response = await request(smokeRunId, label, 'POST', '/api/v2/recall', {
    body: {
      agent_id: agentId,
      query: queryText,
    },
  });
  assert(response.response.status === 200, `${label} returned ${response.response.status}`, response.json);
  return response.json;
}

async function runRound(round) {
  const agentId = getAgentId(round);
  const smokeRunId = getEvalRunId(round);
  const cleanupAgentIds = [agentId];

  if (cleanupAgentIds.some((id) => id.length > MAX_AGENT_ID_LENGTH)) {
    throw new Error(`Recall eval agent ids exceed ${MAX_AGENT_ID_LENGTH} chars. Use a shorter CORTEX_AGENT_ID.`);
  }

  try {
    await request(smokeRunId, 'create recall eval probe agent', 'POST', '/api/v2/agents', {
      body: {
        id: agentId,
        name: agentId,
        description: 'auto-created probe agent for recall eval',
      },
      expectedStatus: 201,
    });

    await createRecord(smokeRunId, agentId, 'seed location fact', {
      kind: 'fact_slot',
      content: '我住大阪',
    });
    await createRecord(smokeRunId, agentId, 'seed organization fact', {
      kind: 'fact_slot',
      content: '我在 OpenAI 工作',
    });
    await createRecord(smokeRunId, agentId, 'seed language preference', {
      kind: 'profile_rule',
      content: '请用中文回答',
    });
    await createRecord(smokeRunId, agentId, 'seed current task', {
      kind: 'task_state',
      content: '当前任务是重构 Cortex recall',
    });
    await createRecord(smokeRunId, agentId, 'seed speculative note', {
      kind: 'session_note',
      content: '最近也许会考虑换方案',
    });

    const relationCandidates = await request(smokeRunId, 'list seeded relation candidates', 'GET', `/api/v2/relation-candidates${query({ agent_id: agentId, status: 'pending', limit: 50 })}`);
    assert((relationCandidates.json?.items || []).some((item) => item.predicate === 'lives_in' && item.object_key === '大阪'), 'missing lives_in relation candidate', relationCandidates.json);
    assert((relationCandidates.json?.items || []).some((item) => item.predicate === 'works_at' && item.object_key === 'openai'), 'missing works_at relation candidate', relationCandidates.json);

    const location = await recall(smokeRunId, agentId, 'location recall', 'Where does the user live?');
    assert((location.facts || []).length === 1 && location.facts[0]?.attribute_key === 'location', 'location recall should inject only location fact', location);
    assert(contextContains(location, '大阪'), 'location recall did not inject Osaka fact', location);
    assert((location.rules || []).length === 0, 'location recall injected unrelated profile rules', location);
    assert((location.task_state || []).length === 0, 'location recall injected unrelated task state', location);
    assert((location.session_notes || []).length === 0, 'location recall injected unrelated session note', location);
    assert((location.meta?.normalized_intents?.attributes || []).includes('location'), 'location recall missing normalized location intent', location);
    assert(basisKinds(location).every((kind) => kind === 'fact_slot'), 'location recall relevance_basis should only include fact_slot', location);
    assertNoUnrelatedContext('location recall', location, ['OpenAI', '中文', '重构 Cortex recall', '换方案']);
    logStep('location recall', 'passed');

    const organization = await recall(smokeRunId, agentId, 'organization recall', 'Where does the user work?');
    assert((organization.facts || []).length === 1 && organization.facts[0]?.attribute_key === 'organization', 'organization recall should inject only organization fact', organization);
    assert(contextContains(organization, 'OpenAI'), 'organization recall did not inject OpenAI fact', organization);
    assert((organization.rules || []).length === 0, 'organization recall injected unrelated profile rules', organization);
    assert((organization.task_state || []).length === 0, 'organization recall injected unrelated task state', organization);
    assert((organization.session_notes || []).length === 0, 'organization recall injected unrelated session note', organization);
    assert((organization.meta?.normalized_intents?.attributes || []).includes('organization'), 'organization recall missing normalized organization intent', organization);
    assertNoUnrelatedContext('organization recall', organization, ['大阪', '中文', '重构 Cortex recall', '换方案']);
    logStep('organization recall', 'passed');

    const language = await recall(smokeRunId, agentId, 'language preference recall', 'How should you answer?');
    assert((language.rules || []).length === 1 && language.rules[0]?.attribute_key === 'language_preference', 'language recall should inject only language preference rule', language);
    assert(contextContains(language, '中文'), 'language recall did not inject Chinese preference', language);
    assert((language.facts || []).length === 0, 'language recall injected unrelated facts', language);
    assert((language.task_state || []).length === 0, 'language recall injected unrelated task state', language);
    assert((language.session_notes || []).length === 0, 'language recall injected unrelated session note', language);
    assert((language.meta?.normalized_intents?.attributes || []).includes('language_preference'), 'language recall missing normalized language_preference intent', language);
    assertNoUnrelatedContext('language recall', language, ['大阪', 'OpenAI', '重构 Cortex recall', '换方案']);
    logStep('language preference recall', 'passed');

    const task = await recall(smokeRunId, agentId, 'task recall', 'What is the current task?');
    assert((task.task_state || []).length === 1 && task.task_state[0]?.state_key === 'refactor_status', 'task recall should inject only current task', task);
    assert(contextContains(task, '重构 Cortex recall'), 'task recall did not inject recall refactor task', task);
    assert((task.rules || []).length === 0, 'task recall injected unrelated profile rules', task);
    assert((task.facts || []).length === 0, 'task recall injected unrelated facts', task);
    assert((task.session_notes || []).length === 0, 'task recall injected unrelated session note', task);
    assert((task.meta?.normalized_intents?.states || []).includes('current_task'), 'task recall missing normalized current_task intent', task);
    assertNoUnrelatedContext('task recall', task, ['大阪', 'OpenAI', '中文', '换方案']);
    logStep('task recall', 'passed');

    const noteOnly = await recall(smokeRunId, agentId, 'note-only recall', '最近是否要换方案？');
    assert(noteOnly.context === '', 'note-only recall should not inject context', noteOnly);
    assert((noteOnly.rules || []).length === 0, 'note-only recall injected rules', noteOnly);
    assert((noteOnly.facts || []).length === 0, 'note-only recall injected facts', noteOnly);
    assert((noteOnly.task_state || []).length === 0, 'note-only recall injected task state', noteOnly);
    assert((noteOnly.session_notes || []).length === 0, 'note-only recall injected session notes', noteOnly);
    assert(noteOnly.meta?.reason === 'low_relevance', 'note-only recall reason should be low_relevance', noteOnly);
    assert((noteOnly.meta?.relevance_basis || []).length === 0, 'note-only recall relevance_basis should be empty', noteOnly);
    logStep('note-only recall', 'passed');

    const firstLocation = await createRecord(smokeRunId, agentId, 'seed superseded location fact', {
      kind: 'fact_slot',
      content: '我住京都',
    });
    const newestLocation = await createRecord(smokeRunId, agentId, 'seed newest location fact', {
      kind: 'fact_slot',
      content: '现在住东京',
    });
    assert(firstLocation?.id && newestLocation?.id, 'missing supersede seed record ids', { firstLocation, newestLocation });

    const winner = await recall(smokeRunId, agentId, 'newest winner location recall', 'Where does the user live?');
    assert((winner.facts || []).length === 1 && String(winner.facts[0]?.content || '').includes('东京'), 'newest location winner recall should inject Tokyo only', winner);
    assert(!contextContains(winner, '大阪') && !contextContains(winner, '京都'), 'newest location winner recall injected superseded location', winner);
    logStep('newest winner recall', 'passed');
  } finally {
    const warnings = [];
    for (const cleanupAgentId of cleanupAgentIds) {
      warnings.push(...await cleanupAgent(cleanupAgentId, smokeRunId));
    }
    if (warnings.length > 0) {
      logStep('cleanup', `completed with ${warnings.length} warning(s)`);
      for (const warning of warnings) logStep('cleanup warning', warning);
    } else {
      logStep('cleanup', 'removed recall eval records, relations, candidates, and probe agents');
    }
  }
}

async function main() {
  process.stdout.write(`Cortex V2 recall eval -> ${baseUrl} (${baseUrlSource}, ${recallEvalRounds} round${recallEvalRounds === 1 ? '' : 's'})\n`);
  for (let round = 1; round <= recallEvalRounds; round += 1) {
    await runRound(round);
  }
  process.stdout.write(`Recall eval passed (${recallEvalRounds} rounds).\n`);
}

main().catch((error) => {
  process.stderr.write(`Recall eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

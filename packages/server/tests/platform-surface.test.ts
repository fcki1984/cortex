import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const BRIDGE = path.join(ROOT, 'packages/cortex-bridge/src/index.ts');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const README = path.join(ROOT, 'README.md');
const README_ZH = path.join(ROOT, 'README.zh-CN.md');
const RELEASE_PLAN = path.join(ROOT, 'RELEASE_TEST_PLAN.md');
const SERVER_INDEX = path.join(ROOT, 'packages/server/src/index.ts');
const SMOKE_SCRIPT = path.join(ROOT, 'scripts/smoke-v2.mjs');

describe('Platform surface migration', () => {
  it('moves the OpenClaw bridge off legacy v1 endpoints', () => {
    const source = fs.readFileSync(BRIDGE, 'utf8');
    expect(source).toContain('/api/v2/health');
    expect(source).toContain('/api/v2/stats');
    expect(source).toContain('/api/v2/recall');
    expect(source).toContain('/api/v2/ingest');
    expect(source).toContain('/api/v2/records');
    expect(source).toContain('/api/v2/relations');
    expect(source).not.toContain('/api/v1/health');
    expect(source).not.toContain('/api/v1/stats');
    expect(source).not.toContain('/api/v1/recall');
    expect(source).not.toContain('/api/v1/ingest');
    expect(source).not.toContain('/api/v1/memories');
    expect(source).not.toContain('/api/v1/relations');
    expect(source).not.toContain('/api/v1/flush');
  });

  it('uses /api/v2/health for container and release health checks', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    const releasePlan = fs.readFileSync(RELEASE_PLAN, 'utf8');
    expect(dockerfile).toContain('/api/v2/health');
    expect(dockerfile).not.toContain('/api/v1/health');
    expect(releasePlan).toContain('/api/v2/health');
    expect(releasePlan).not.toContain('/api/v1/health');
  });

  it('documents the v2 platform/admin surface in both READMEs', () => {
    const readme = fs.readFileSync(README, 'utf8');
    const readmeZh = fs.readFileSync(README_ZH, 'utf8');
    for (const doc of [readme, readmeZh]) {
      expect(doc).toContain('/api/v2/agents');
      expect(doc).toContain('/api/v2/extraction-logs');
      expect(doc).toContain('/api/v2/health');
      expect(doc).toContain('/api/v2/config');
      expect(doc).not.toContain('/api/v1/agents');
      expect(doc).not.toContain('/api/v1/extraction-logs');
      expect(doc).not.toContain('/api/v1/health');
      expect(doc).not.toContain('/api/v1/config');
    }
  });


  it('initializes Neo4j only behind the legacy runtime gate', () => {
    const serverIndex = fs.readFileSync(SERVER_INDEX, 'utf8');
    expect(serverIndex).toContain('if (config.runtime.legacyMode)');
    expect(serverIndex).toContain('const neo4jDriver = initNeo4j();');
    expect(serverIndex).toContain('await ensureNeo4jSchema();');
  });

  it('documents Windows host-side OpenClaw runtime validation before release', () => {
    const bridgeReadme = fs.readFileSync(path.join(ROOT, 'packages/cortex-bridge/README.md'), 'utf8');
    const releasePlan = fs.readFileSync(RELEASE_PLAN, 'utf8');
    expect(bridgeReadme).toContain('http://localhost:18790/chat?session=main');
    expect(bridgeReadme).toContain('Windows host');
    expect(bridgeReadme).toContain('/cortex_status');
    expect(releasePlan).toContain('http://localhost:18790/chat?session=main');
    expect(releasePlan).toContain('/cortex_status');
    expect(releasePlan).toContain('/cortex_remember 请用中文回答');
  });

  it('supports the three-run smoke gate used by release validation', () => {
    const smoke = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
    const releasePlan = fs.readFileSync(RELEASE_PLAN, 'utf8');

    expect(smoke).toContain('SMOKE_ROUNDS');
    expect(smoke).toContain('for (let round = 1; round <= smokeRounds; round += 1)');
    expect(smoke).toContain('我住大阪。请用中文回答。当前任务是重构 Cortex recall');
    expect(smoke).toContain('最近也许会考虑换方案。现在住东京');
    expect(smoke).toContain('最近也许会考虑换方案。目前位于东京');
    expect(smoke).toContain('最近也许会考虑换方案。目前任职于 OpenAI');
    expect(smoke).toContain('我住大阪。现在住东京');
    expect(smoke).toContain("['我住大阪', '请用中文回答', '现在住东京'].join('\\n')");
    expect(smoke).toContain("'## Fact Slots'");
    expect(releasePlan).toContain('smoke:v2');
    expect(releasePlan).toContain('3');
  });

  it('keeps smoke preview winner assertions aligned with canonical durable phrasing', () => {
    const smoke = fs.readFileSync(SMOKE_SCRIPT, 'utf8');

    expect(smoke).toContain("conflictPreview.json?.record_candidates?.[0]?.content === '我住东京'");
    expect(smoke).toContain("multilinePreview.json?.record_candidates?.[1]?.content === '我住东京'");
    expect(smoke).toContain("memoryPreview.json?.record_candidates?.[0]?.content === '我住东京'");
    expect(smoke).not.toContain("conflictPreview.json?.record_candidates?.[0]?.content === '现在住东京'");
    expect(smoke).not.toContain("multilinePreview.json?.record_candidates?.[1]?.content === '现在住东京'");
    expect(smoke).not.toContain("memoryPreview.json?.record_candidates?.[0]?.content === '现在住东京'");
  });

  it('covers the review inbox import and delta-sync mainline in the smoke gate', () => {
    const smoke = fs.readFileSync(SMOKE_SCRIPT, 'utf8');

    expect(smoke).toContain('/api/v2/review-inbox/import');
    expect(smoke).toContain('/api/v2/review-inbox?agent_id=');
    expect(smoke).toContain('/api/v2/review-inbox/${encodeURIComponent(reviewImportBatchId)}');
    expect(smoke).toContain('/api/v2/review-inbox/${encodeURIComponent(reviewImportBatchId)}/apply');
    expect(smoke).toContain("reviewInboxListFull.json?.sync?.mode === 'full'");
    expect(smoke).toContain("reviewInboxDetail.json?.items?.[0]?.suggested_rewrite === '请简洁直接回答'");
    expect(smoke).toContain('cursor: reviewInboxDeltaBase.json?.sync?.cursor');
    expect(smoke).toContain("reviewInboxApply.json?.summary?.committed === 1");
    expect(smoke).toContain("reviewInboxRecords.json?.items || []).some((item) => item.content === '请简洁直接回答')");
    expect(smoke).toContain('route mixed auto-commit plus review ingest');
    expect(smoke).toContain("mixedReviewIngest.json?.auto_committed_count === 1");
    expect(smoke).toContain("mixedReviewIngest.json?.review_pending_count === 1");
    expect(smoke).toContain("mixedReviewIngest.json?.review_source_preview === '说话干脆一点'");
    expect(smoke).toContain("mixedReviewDetail.json?.batch?.source_preview === '说话干脆一点'");
    expect(smoke).toContain('auto-commit compound durable ingest without review work');
    expect(smoke).toContain("compoundAutoIngest.json?.auto_committed_count === 2");
    expect(smoke).toContain("compoundAutoIngest.json?.review_pending_count === 0");
    expect(smoke).toContain("compoundAutoInbox.json?.items || []).length === 0");
    expect(smoke).toContain('confirm single pending live review follow-up');
    expect(smoke).toContain("followupConfirm.json?.auto_committed_count === 1");
    expect(smoke).toContain('restate live review follow-up style explicitly');
    expect(smoke).toContain("styleRestateFollowup.json?.auto_committed_count === 1");
    expect(smoke).toContain('select only active response-style truth');
    expect(smoke).toContain("styleSelectionFollowup.json?.auto_committed_count === 1");
    expect(smoke).toContain("JSON.stringify(styleSelectionListed.json?.items.map((item) => item.content)) === JSON.stringify(['请简洁直接回答'])");
    expect(smoke).toContain('create pending response-style review for mixed active-pending selection');
    expect(smoke).toContain("mixedActivePendingReviewSeed.json?.review_pending_count === 1");
    expect(smoke).toContain('keep mixed active language drop and pending style survivor');
    expect(smoke).toContain("mixedActivePendingFollowup.json?.auto_committed_count === 1");
    expect(smoke).toContain("mixedActivePendingFollowup.json?.review_pending_count === 0");
    expect(smoke).toContain("JSON.stringify((mixedActivePendingFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['请简洁直接回答'])");
    expect(smoke).toContain("mixedActivePendingDetail.json?.summary?.accepted === 1");
    expect(smoke).toContain("JSON.stringify(mixedActivePendingListed.json?.items.map((item) => item.content)) === JSON.stringify(['请简洁直接回答'])");
    expect(smoke).toContain('create pending response-style review for mixed active-pending keep-location selection');
    expect(smoke).toContain("mixedActivePendingKeepLocationReviewSeed.json?.review_pending_count === 1");
    expect(smoke).toContain('keep active location and reject pending response-style review noise');
    expect(smoke).toContain("mixedActivePendingKeepLocationFollowup.json?.auto_committed_count === 1");
    expect(smoke).toContain("mixedActivePendingKeepLocationFollowup.json?.review_pending_count === 0");
    expect(smoke).toContain("JSON.stringify((mixedActivePendingKeepLocationFollowup.json?.records || []).map((item) => item.content)) === JSON.stringify(['我住东京'])");
    expect(smoke).toContain("mixedActivePendingKeepLocationDetail.json?.summary?.accepted === 0");
    expect(smoke).toContain("mixedActivePendingKeepLocationDetail.json?.summary?.rejected === 1");
    expect(smoke).toContain("JSON.stringify(mixedActivePendingKeepLocationListed.json?.items.map((item) => item.content)) === JSON.stringify(['我住东京'])");
    expect(smoke).toContain('keep mixed active language and location survivors');
    expect(smoke).toContain("mixedSelectionFollowup.json?.auto_committed_count === 2");
    expect(smoke).toContain("JSON.stringify(mixedSelectionListed.json?.items.map((item) => item.content).sort()) === JSON.stringify(['我住东京', '请用中文回答'])");
    expect(smoke).toContain("JSON.stringify(mixedSelectionCandidates.json?.items.map((item) => item.object_key)) === JSON.stringify(['东京'])");
    expect(smoke).toContain('drop all mixed active truths');
    expect(smoke).toContain("mixedDropAllFollowup.json?.auto_committed_count === 0");
    expect(smoke).toContain("mixedDropAllFollowup.json?.review_pending_count === 0");
    expect(smoke).toContain("(mixedDropAllListed.json?.items || []).length === 0");
    expect(smoke).toContain("(mixedDropAllCandidates.json?.items || []).length === 0");
    expect(smoke).toContain('select only active current task');
    expect(smoke).toContain("taskSelectionFollowup.json?.auto_committed_count === 1");
    expect(smoke).toContain("taskSelectionListed.json?.items?.[0]?.content === '当前任务是重构 Cortex recall'");
    expect(smoke).toContain('rewrite active current task to deployment');
    expect(smoke).toContain("taskRewriteFollowup.json?.records?.[0]?.content === '当前任务是部署 Cortex'");
    expect(smoke).toContain("taskRewriteListed.json?.items?.[0]?.content === '当前任务是部署 Cortex'");
    expect(smoke).toContain('rewrite active organization truth to Tencent');
    expect(smoke).toContain("organizationRewriteFollowup.json?.records?.[0]?.content === '我在 腾讯 工作'");
    expect(smoke).toContain("organizationRewriteListed.json?.items?.[0]?.content === '我在 腾讯 工作'");
    expect(smoke).toContain("JSON.stringify(organizationRewriteCandidates.json?.items.map((item) => item.object_key)) === JSON.stringify(['腾讯'])");
    expect(smoke).toContain('send mismatched live review follow-up rewrite');
    expect(smoke).toContain("mismatchDetail.json?.summary?.pending === 1");
    expect(smoke).toContain("mismatchDetail.json?.items?.[0]?.payload?.attribute_key === 'response_style'");
  });

  it('parses MCP search_debug payloads instead of matching stale source text', () => {
    const smoke = fs.readFileSync(SMOKE_SCRIPT, 'utf8');

    expect(smoke).toContain('const primaryResults = JSON.parse(primaryText).results;');
    expect(smoke).toContain('const compatResults = JSON.parse(compatText).results;');
    expect(smoke).toContain("primaryResults[0]?.attribute_key === 'location'");
    expect(smoke).toContain("compatResults[0]?.attribute_key === 'location'");
    expect(smoke).not.toContain("primaryText.includes('Smoke V2 user lives in Taipei')");
    expect(smoke).not.toContain("compatText.includes('Smoke V2 user lives in Taipei')");
  });

  it('prints ingress failure evidence with route, phase, attempts, and operation kind', () => {
    const smoke = fs.readFileSync(SMOKE_SCRIPT, 'utf8');

    expect(smoke).toContain("const operationKind = error && typeof error === 'object' && 'operationKind' in error");
    expect(smoke).toContain("const method = error && typeof error === 'object' && 'method' in error");
    expect(smoke).toContain("const path = error && typeof error === 'object' && 'path' in error");
    expect(smoke).toContain("const routeDetail = method && path ? ` on ${method} ${path}` : '';");
    expect(smoke).toContain("const operationDetail = operationKind ? ` [${operationKind}]` : '';");
    expect(smoke).toContain("process.stderr.write(`${prefix}${operationDetail}${phaseDetail}${routeDetail}${attemptDetail}: ${error.message}\\n`);");
  });
});

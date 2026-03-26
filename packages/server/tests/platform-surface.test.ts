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
    expect(smoke).toContain('我住大阪。现在住东京');
    expect(smoke).toContain("['我住大阪', '请用中文回答', '现在住东京'].join('\\n')");
    expect(smoke).toContain("'## Fact Slots'");
    expect(releasePlan).toContain('smoke:v2');
    expect(releasePlan).toContain('3');
  });
});

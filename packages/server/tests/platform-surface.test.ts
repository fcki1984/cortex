import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const BRIDGE = path.join(ROOT, 'packages/cortex-bridge/src/index.ts');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const README = path.join(ROOT, 'README.md');
const README_ZH = path.join(ROOT, 'README.zh-CN.md');
const RELEASE_PLAN = path.join(ROOT, 'RELEASE_TEST_PLAN.md');

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
});

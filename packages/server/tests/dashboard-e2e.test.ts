import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Dashboard Integration Tests
 *
 * Validates compiled Dashboard assets contain correct integration panel content.
 * Tests the built output directly — no server required.
 */

const DASHBOARD_DIST = path.resolve(__dirname, '../../dashboard/dist');
const ZH_LOCALE = path.resolve(__dirname, '../../dashboard/src/i18n/locales/zh.ts');
const CLIENT_SOURCE = path.resolve(__dirname, '../../dashboard/src/api/client.ts');
const AGENT_DETAIL_SOURCE = path.resolve(__dirname, '../../dashboard/src/pages/AgentDetail.tsx');
const MEMORY_BROWSER_SOURCE = path.resolve(__dirname, '../../dashboard/src/pages/MemoryBrowser.tsx');
const RELATION_GRAPH_SOURCE = path.resolve(__dirname, '../../dashboard/src/pages/RelationGraph.tsx');
const EXTRACTION_LOGS_SOURCE = path.resolve(__dirname, '../../dashboard/src/pages/ExtractionLogs.tsx');
const STATS_SOURCE = path.resolve(__dirname, '../../dashboard/src/pages/Stats.tsx');
const MEMORY_DETAIL_SOURCE = path.resolve(__dirname, '../../dashboard/src/pages/MemoryDetail.tsx');
const SETTINGS_SOURCE = path.resolve(__dirname, '../../dashboard/src/pages/Settings/index.tsx');

describe('Dashboard Integration', () => {
  const distExists = fs.existsSync(DASHBOARD_DIST);

  if (!distExists) {
    it.skip('requires built dashboard assets in packages/dashboard/dist', () => {});
    return;
  }

  it('should have dist directory', () => {
    expect(distExists).toBe(true);
  });

  it('should have index.html', () => {
    if (!distExists) return;
    const html = fs.readFileSync(path.join(DASHBOARD_DIST, 'index.html'), 'utf-8');
    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('.js');
    expect(html).toContain('.css');
  });

  describe('JS bundle content', () => {
    let js = '';

    it('should find and read JS bundle', () => {
      if (!distExists) return;
      const assets = fs.readdirSync(path.join(DASHBOARD_DIST, 'assets'));
      const jsFiles = assets.filter(f => f.endsWith('.js'));
      expect(jsFiles.length).toBeGreaterThan(0);
      js = jsFiles
        .map(file => fs.readFileSync(path.join(DASHBOARD_DIST, 'assets', file), 'utf-8'))
        .join('\n');
      expect(js.length).toBeGreaterThan(0);
    });

    // ── Integration panel: Methods A/B/C ──
    it('should contain Method A (openclaw.json config)', () => {
      if (!js) return;
      expect(js).toContain('openclawJsonMethod');
      expect(js).toContain('openclawJsonMethodDesc');
    });

    it('should contain Method B (.env)', () => {
      if (!js) return;
      expect(js).toContain('openclawEnvMethod');
      expect(js).toContain('openclawEnvMethodDesc');
    });

    it('should contain Method C (shell profile)', () => {
      if (!js) return;
      expect(js).toContain('openclawShellMethod');
      expect(js).toContain('openclawShellMethodDesc');
    });

    it('should not have duplicate Method B in English', () => {
      if (!js) return;
      expect(js).toContain('Method C');
      // Method B should appear at most twice (label + desc)
      const matches = js.match(/Method B/g) || [];
      expect(matches.length).toBeLessThanOrEqual(2);
    });

    // ── CORTEX_AGENT_ID presence ──
    it('should include CORTEX_AGENT_ID in templates', () => {
      if (!js) return;
      const count = (js.match(/CORTEX_AGENT_ID/g) || []).length;
      // Should appear in: .env template, shell template, MCP configs (at least 3)
      expect(count).toBeGreaterThanOrEqual(3);
    });

    // ── Commands use underscore (Telegram compatible) ──
    it('should use cortex_status (underscore, not hyphen)', () => {
      if (!js) return;
      expect(js).toContain('cortex_status');
      expect(js).not.toContain('cortex-status');
    });

    // ── All 4 commands listed ──
    it('should list all plugin commands', () => {
      if (!js) return;
      expect(js).toContain('openclawCommand');        // cortex_status
      expect(js).toContain('openclawCommandSearch');   // cortex_search
      expect(js).toContain('openclawCommandRemember'); // cortex_remember
      expect(js).toContain('openclawCommandRecent');   // cortex_recent
    });

    // ── Step titles ──
    it('should have all 4 integration steps', () => {
      if (!js) return;
      expect(js).toContain('openclawStep1Title');
      expect(js).toContain('openclawStep2Title');
      expect(js).toContain('openclawStep3Title');
      expect(js).toContain('openclawStep4Title');
    });

    it('should expose feedback review navigation and page copy', () => {
      if (!js) return;
      expect(js).toContain('Feedback');
      expect(js).toContain('Feedback Review');
    });

    it('should target v2 platform/admin APIs including auth bootstrap', () => {
      if (!js) return;
      expect(js).toContain('/api/v2/config');
      expect(js).toContain('/api/v2/health');
      expect(js).toContain('/api/v2/agents');
      expect(js).toContain('/api/v2/extraction-logs');
      expect(js).toContain('/api/v2/auth/check');
      expect(js).not.toContain('/api/v1/config');
      expect(js).not.toContain('/api/v1/health');
      expect(js).not.toContain('/api/v1/agents');
      expect(js).not.toContain('/api/v1/extraction-logs');
      expect(js).not.toContain('/api/v1/auth/check');
    });

    it('should expose layered settings entry points', () => {
      if (!js) return;
      expect(js).toContain('Basic Settings');
      expect(js).toContain('Expert Settings');
    });

    // ── Hooks and tools listed ──
    it('should list hooks and tools in step 3', () => {
      if (!js) return;
      expect(js).toContain('openclawHookBefore');
      expect(js).toContain('openclawHookAfter');
      expect(js).toContain('openclawHookCompaction');
      expect(js).toContain('openclawToolRecall');
      expect(js).toContain('openclawToolRemember');
    });

    // ── No hardcoded personal info ──
    it('should not contain hardcoded personal info', () => {
      if (!js) return;
      expect(js).not.toContain('121.103');
      expect(js).not.toContain('aji4545');
      expect(js).not.toContain('rigouu');
      expect(js).not.toContain('harry-server');
      expect(js).not.toContain('qoi.me');
      expect(js).not.toContain('zan.ink');
    });

    // ── i18n completeness ──
    it('should have both zh and en locale keys', () => {
      if (!js) return;
      // Chinese
      expect(js).toContain('安装插件');
      expect(js).toContain('设置 Cortex 服务器地址');
      // English
      expect(js).toContain('Install Plugin');
      expect(js).toContain('Set Cortex Server Address');
    });
  });

  describe('CSS bundle', () => {
    it('should have valid CSS file', () => {
      if (!distExists) return;
      const assets = fs.readdirSync(path.join(DASHBOARD_DIST, 'assets'));
      const cssFile = assets.find(f => f.endsWith('.css'));
      expect(cssFile).toBeDefined();
      const css = fs.readFileSync(path.join(DASHBOARD_DIST, 'assets', cssFile!), 'utf-8');
      expect(css.length).toBeGreaterThan(100);
    });
  });

  describe('Chinese locale copy', () => {
    it('should not leave newly added settings and feedback labels in English', () => {
      const zh = fs.readFileSync(ZH_LOCALE, 'utf-8');
      expect(zh).toContain("topAgents: '最活跃智能体'");
      expect(zh).toContain("legacyModeOn: '兼容模式已开启'");
      expect(zh).toContain("recallDurableCandidates: '{{count}} 条持久记录候选'");
      expect(zh).toContain("recallNoteCandidates: '{{count}} 条会话笔记候选'");
      expect(zh).toContain("rulesSection: '规则与人设'");
      expect(zh).toContain("subtitle: '审查提取后的记录，标记质量，并在需要时提交替代语义的更正。'");
      expect(zh).toContain("correctedHint: '在这里填写修正后的持久记录文本或会话摘要。'");
      expect(zh).not.toContain("topAgents: 'Top 智能体'");
      expect(zh).not.toContain("legacyModeOn: 'Legacy 兼容开启'");
      expect(zh).not.toContain("recallDurableCandidates: '{{count}} 条 durable 候选'");
      expect(zh).not.toContain("recallNoteCandidates: '{{count}} 条 note 候选'");
      expect(zh).not.toContain("rulesSection: '规则与 Persona'");
      expect(zh).not.toContain("subtitle: '审查提取后的记录，标记质量，并在需要时提交 supersede 语义的更正。'");
      expect(zh).not.toContain("correctedHint: '在这里填写修正后的 durable 文本或会话摘要。'");
    });

    it('should define v2 enum and browser labels for Chinese-first UI', () => {
      const zh = fs.readFileSync(ZH_LOCALE, 'utf-8');
      expect(zh).toContain("sourceTypes: {");
      expect(zh).toContain("user_explicit: '用户明确表达'");
      expect(zh).toContain("assistant_inferred: '助手推断'");
      expect(zh).toContain("recordKinds: {");
      expect(zh).toContain("profile_rule: '画像/规则'");
      expect(zh).toContain("session_note: '会话笔记'");
      expect(zh).toContain("memoryBrowser: {");
      expect(zh).toContain("columnRequested: '请求类型'");
      expect(zh).toContain("columnWritten: '实际写入'");
      expect(zh).toContain("columnSource: '来源'");
      expect(zh).toContain("columnContent: '内容'");
    });

    it('should describe editable settings as live-applied instead of restart-required', () => {
      const zh = fs.readFileSync(ZH_LOCALE, 'utf-8');
      expect(zh).toContain("toastConfigSaved: '配置已保存并立即生效'");
      expect(zh).not.toContain("toastConfigSavedRestart: '配置已保存，重启或重新部署后生效'");
    });
  });

  describe('Chinese-first dashboard source copy', () => {
    it('should not keep legacy v1 dashboard client wrappers or orphaned legacy detail pages', () => {
      const client = fs.readFileSync(CLIENT_SOURCE, 'utf-8');
      expect(client).not.toContain("const LEGACY_BASE = '/api/v1'");
      expect(client).not.toContain('requestLegacy(');
      expect(client).not.toContain('/api/v1/');
      expect(fs.existsSync(MEMORY_DETAIL_SOURCE)).toBe(false);
    });

    it('should save settings with live-apply semantics instead of restart messaging', () => {
      const src = fs.readFileSync(SETTINGS_SOURCE, 'utf-8');
      expect(src).not.toContain('toastConfigSavedRestart');
      expect(src).toContain("t('settings.toastConfigSaved')");
    });

    it('should only expose live-edit controls for sections that can be applied immediately', () => {
      const src = fs.readFileSync(SETTINGS_SOURCE, 'utf-8');
      expect(src).toContain("new Set<SectionKey>(['llm', 'lifecycle'])");
      expect(src).not.toContain("new Set<SectionKey>(['llm', 'gate', 'search', 'sieve', 'lifecycle'])");
    });

    it('should remove hardcoded English labels from Memory Browser', () => {
      const src = fs.readFileSync(MEMORY_BROWSER_SOURCE, 'utf-8');
      expect(src).not.toContain('All kinds');
      expect(src).not.toContain('All sources');
      expect(src).not.toContain('All agents');
      expect(src).not.toContain('Requested</th>');
      expect(src).not.toContain('Written</th>');
      expect(src).not.toContain('Source</th>');
      expect(src).not.toContain('Content</th>');
      expect(src).not.toContain('Create V2 Record');
      expect(src).not.toContain('Edit V2 Record');
      expect(src).not.toContain('Record updated');
      expect(src).not.toContain('Record deleted');
      expect(src).not.toContain('Source type');
    });

    it('should remove hardcoded English labels from relations, extraction logs, and stats', () => {
      const relations = fs.readFileSync(RELATION_GRAPH_SOURCE, 'utf-8');
      const extractionLogs = fs.readFileSync(EXTRACTION_LOGS_SOURCE, 'utf-8');
      const stats = fs.readFileSync(STATS_SOURCE, 'utf-8');

      expect(relations).toContain('listRelationCandidatesV2');
      expect(relations).toContain('confirmRelationCandidateV2');
      expect(relations).not.toContain('Create V2 Relation');
      expect(relations).not.toContain('No V2 relations yet.');
      expect(relations).not.toContain('Delete this relation?');
      expect(relations).not.toContain('Source record:');
      expect(relations).not.toContain('Evidence:');
      expect(extractionLogs).not.toContain('<option value="fast">Fast</option>');
      expect(extractionLogs).not.toContain('<option value="deep">Deep</option>');
      expect(extractionLogs).not.toContain('normalization:');
      expect(extractionLogs).not.toContain('reason:');
      expect(extractionLogs).not.toContain('imp:');
      expect(stats).not.toContain('item.source_type} · {item.kind}');
    });

    it('should switch lifecycle monitor to forgetting-first retention semantics', () => {
      const lifecycle = fs.readFileSync(path.resolve(__dirname, '../../dashboard/src/pages/LifecycleMonitor.tsx'), 'utf-8');

      expect(lifecycle).toContain('dormant_candidates');
      expect(lifecycle).toContain('stale_candidates');
      expect(lifecycle).toContain('purge_candidates');
      expect(lifecycle).not.toContain('compression_candidates');
      expect(lifecycle).not.toContain('notes_to_compress');
      expect(lifecycle).not.toContain('compression_groups');
    });
  });

  describe('Agent detail v2 stats rendering', () => {
    it('should render v2 agent stats without legacy layer references', () => {
      const src = fs.readFileSync(AGENT_DETAIL_SOURCE, 'utf-8');
      expect(src).toContain('stats.kinds');
      expect(src).toContain('stats.sources');
      expect(src).not.toContain('stats.layers');
    });
  });
});

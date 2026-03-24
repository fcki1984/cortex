import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { getConfig, updateConfig } from '../utils/config.js';
import { createLogger, getLogLevel as _getLogLevel, setLogLevel as _setLogLevel, getLogBuffer } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import type { CortexApp } from '../app.js';
import type { Memory } from '../db/queries.js';
import type { SearchResult } from '../search/hybrid.js';
import { restartLifecycleScheduler } from '../core/scheduler.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('system');

// Read version from root package.json at startup
function getPackageVersion(): string {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Try multiple possible locations (dev vs built)
    for (const rel of ['../../../../package.json', '../../../package.json', '../../package.json']) {
      const p = path.resolve(__dirname, rel);
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (pkg.name === 'cortex' || pkg.name === '@cortex/root') return pkg.version;
        if (pkg.version) return pkg.version;
      }
    }
  } catch {}
  return '0.0.0';
}

const CURRENT_VERSION = getPackageVersion();

/** Returns true if `latest` is strictly newer than `current` (semver comparison) */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [lM, lm, lp] = parse(latest);
  const [cM, cm, cp] = parse(current);
  if (lM !== cM) return lM > cM;
  if (lm !== cm) return lm > cm;
  return (lp || 0) > (cp || 0);
}
const DEFAULT_RELEASE_REPO = 'fcki1984/cortex';

function getReleaseRepo(): string {
  const raw = (process.env.CORTEX_RELEASE_REPO || DEFAULT_RELEASE_REPO).trim();
  const normalized = raw
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
  return normalized || DEFAULT_RELEASE_REPO;
}

function getGithubUrl(repo = getReleaseRepo()): string {
  return `https://github.com/${repo}`;
}

function getUpdateImage(repo = getReleaseRepo()): string {
  return (process.env.CORTEX_UPDATE_IMAGE || `ghcr.io/${repo}:latest`).trim();
}

// Cache latest release info (check at most every 30 min)
let latestReleaseCache: { repo: string; tag: string; url: string; publishedAt: string; checkedAt: number } | null = null;
const RELEASE_CHECK_INTERVAL = 30 * 60 * 1000;

function isSectionChanged(section: string, current: any, updated: any): boolean {
  switch (section) {
    case 'auth':
      return JSON.stringify(current?.auth ?? null) !== JSON.stringify(updated?.auth ?? null);
    case 'cors':
      return JSON.stringify(current?.cors ?? null) !== JSON.stringify(updated?.cors ?? null);
    case 'rateLimit':
      return JSON.stringify(current?.rateLimit ?? null) !== JSON.stringify(updated?.rateLimit ?? null);
    case 'llm.extraction':
      return JSON.stringify(current?.llm?.extraction ?? null) !== JSON.stringify(updated?.llm?.extraction ?? null);
    case 'llm.lifecycle':
      return JSON.stringify(current?.llm?.lifecycle ?? null) !== JSON.stringify(updated?.llm?.lifecycle ?? null);
    case 'embedding':
      return JSON.stringify(current?.embedding ?? null) !== JSON.stringify(updated?.embedding ?? null);
    case 'gate':
      return JSON.stringify(current?.gate ?? null) !== JSON.stringify(updated?.gate ?? null);
    case 'search':
      return JSON.stringify(current?.search ?? null) !== JSON.stringify(updated?.search ?? null);
    case 'sieve':
      return JSON.stringify(current?.sieve ?? null) !== JSON.stringify(updated?.sieve ?? null);
    case 'lifecycle.schedule':
      return (current?.lifecycle?.schedule ?? '') !== (updated?.lifecycle?.schedule ?? '');
    case 'lifecycle':
      return JSON.stringify(current?.lifecycle ?? null) !== JSON.stringify(updated?.lifecycle ?? null);
    case 'storage':
      return JSON.stringify(current?.storage ?? null) !== JSON.stringify(updated?.storage ?? null);
    case 'vectorBackend':
      return JSON.stringify(current?.vectorBackend ?? null) !== JSON.stringify(updated?.vectorBackend ?? null);
    case 'server':
      return current?.port !== updated?.port || current?.host !== updated?.host;
    case 'runtime':
      return JSON.stringify(current?.runtime ?? null) !== JSON.stringify(updated?.runtime ?? null);
    case 'layers':
      return JSON.stringify(current?.layers ?? null) !== JSON.stringify(updated?.layers ?? null);
    case 'flush':
      return JSON.stringify(current?.flush ?? null) !== JSON.stringify(updated?.flush ?? null);
    case 'markdownExport':
      return JSON.stringify(current?.markdownExport ?? null) !== JSON.stringify(updated?.markdownExport ?? null);
    default:
      return false;
  }
}

function collectChangedConfigSections(partial: any, current: any, updated: any): string[] {
  const sections = new Set<string>();
  if (partial?.auth) sections.add('auth');
  if (partial?.cors) sections.add('cors');
  if (partial?.rateLimit) sections.add('rateLimit');
  if (partial?.llm?.extraction) sections.add('llm.extraction');
  if (partial?.llm?.lifecycle) sections.add('llm.lifecycle');
  if (partial?.embedding) sections.add('embedding');
  if (partial?.gate) sections.add('gate');
  if (partial?.search) sections.add('search');
  if (partial?.sieve) sections.add('sieve');
  if (partial?.lifecycle?.schedule !== undefined) sections.add('lifecycle.schedule');
  if (partial?.lifecycle && partial?.lifecycle?.schedule === undefined) sections.add('lifecycle');
  if (partial?.storage) sections.add('storage');
  if (partial?.vectorBackend) sections.add('vectorBackend');
  if (partial?.port !== undefined || partial?.host !== undefined) sections.add('server');
  if (partial?.runtime) sections.add('runtime');
  if (partial?.layers) sections.add('layers');
  if (partial?.flush) sections.add('flush');
  if (partial?.markdownExport) sections.add('markdownExport');
  return Array.from(sections).filter(section => isSectionChanged(section, current, updated));
}

function canApplySectionAtRuntime(section: string): boolean {
  switch (section) {
    case 'llm.extraction':
    case 'embedding':
    case 'lifecycle.schedule':
      return true;
    default:
      return false;
  }
}

function isSectionWritableFromSettings(section: string): boolean {
  switch (section) {
    case 'llm.extraction':
    case 'embedding':
    case 'lifecycle.schedule':
      return true;
    default:
      return false;
  }
}

function isProviderConfigured(config?: { provider?: string; apiKey?: string; baseUrl?: string; model?: string }): boolean {
  if (!config || !config.provider || config.provider === 'none') return false;
  if (config.provider === 'ollama') return true;
  return !!(config.apiKey || (config.baseUrl && config.model));
}

function buildSafeConfig(config: any, options?: { includeServerInfo?: boolean }) {
  const safe = structuredClone(config);
  delete safe.auth;

  safe.llm = {
    extraction: {
      provider: config.llm.extraction.provider,
      model: config.llm.extraction.model,
      baseUrl: config.llm.extraction.baseUrl,
      timeoutMs: config.llm.extraction.timeoutMs,
      hasApiKey: !!config.llm.extraction.apiKey,
    },
    lifecycle: {
      provider: config.llm.lifecycle.provider,
      model: config.llm.lifecycle.model,
      baseUrl: config.llm.lifecycle.baseUrl,
      timeoutMs: config.llm.lifecycle.timeoutMs,
      hasApiKey: !!config.llm.lifecycle.apiKey,
    },
  };

  safe.embedding = {
    provider: config.embedding.provider,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    baseUrl: config.embedding.baseUrl,
    timeoutMs: config.embedding.timeoutMs,
    hasApiKey: !!config.embedding.apiKey,
  };

  safe.search = {
    ...safe.search,
    reranker: {
      ...safe.search?.reranker,
      apiKey: undefined,
      timeoutMs: config.search.reranker?.timeoutMs,
      hasApiKey: !!config.search.reranker?.apiKey,
    },
  };

  if (safe.vectorBackend?.qdrant) {
    safe.vectorBackend = {
      ...safe.vectorBackend,
      qdrant: {
        ...safe.vectorBackend.qdrant,
        apiKey: undefined,
        hasApiKey: !!config.vectorBackend?.qdrant?.apiKey,
      },
    };
  }

  if (options?.includeServerInfo) {
    safe.serverInfo = {
      time: new Date().toISOString(),
      timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      uptime: Math.floor(process.uptime()),
    };
  }

  return safe;
}

async function getLatestRelease(forceRefresh = false, repo = getReleaseRepo()): Promise<typeof latestReleaseCache> {
  if (
    !forceRefresh &&
    latestReleaseCache &&
    latestReleaseCache.repo === repo &&
    Date.now() - latestReleaseCache.checkedAt < RELEASE_CHECK_INTERVAL
  ) {
    return latestReleaseCache;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'cortex-server' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      latestReleaseCache = {
        repo,
        tag: data.tag_name,
        url: data.html_url,
        publishedAt: data.published_at,
        checkedAt: Date.now(),
      };
    }
  } catch (e) {
    log.debug({ error: (e as Error).message }, 'Failed to check latest release');
  }
  return latestReleaseCache;
}

export function registerSystemRoutes(app: FastifyInstance, cortex: CortexApp): void {
  // Metrics endpoint (Prometheus text format)
  app.get('/api/v2/metrics', async (req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return metrics.toPrometheus();
  });

  // Metrics endpoint (JSON format for Dashboard)
  app.get('/api/v2/metrics/json', async () => {
    return metrics.toJSON();
  });

  // Log level
  app.get('/api/v2/log-level', async () => {
    return { level: _getLogLevel() };
  });

  app.patch('/api/v2/log-level', async (req) => {
    const { level } = req.body as any;
    const valid = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    if (!valid.includes(level)) {
      return { ok: false, error: `Invalid level. Use: ${valid.join(', ')}` };
    }
    _setLogLevel(level);
    return { ok: true, level };
  });

  // System logs (ring buffer)
  app.get('/api/v2/logs', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit) || 100, 500);
    const level = query.level || undefined;
    return { logs: getLogBuffer(limit, level) };
  });

  // Health check (?refresh=true to bypass release cache)
  app.get('/api/v2/health', async (req) => {
    const query = req.query as any;
    const releaseRepo = getReleaseRepo();
    const latest = await getLatestRelease(query.refresh === 'true', releaseRepo);
    const latestVersion = latest?.tag?.replace(/^v/, '') ?? null;
    return {
      status: 'ok',
      version: CURRENT_VERSION,
      github: getGithubUrl(releaseRepo),
      latestRelease: latest ? {
        version: latestVersion,
        url: latest.url,
        publishedAt: latest.publishedAt,
        updateAvailable: latestVersion ? isNewerVersion(latestVersion, CURRENT_VERSION) : false,
      } : null,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  // Trigger self-update: pull latest image + recreate container
  // Requires: docker socket + docker-compose.yml mounted (see docker-compose.yml)
  //
  // Strategy:
  // 1. Pull latest image (safe, no effect on running container)
  // 2. Spawn a helper container (`docker run -d`) that waits, then runs
  //    `docker compose up -d --force-recreate` to replace us.
  //    The helper is a separate container, so it survives our shutdown.
  app.post('/api/v2/update', async () => {
    if (!fs.existsSync('/var/run/docker.sock')) {
      return { ok: false, error: 'Docker socket not mounted.' };
    }
    if (!fs.existsSync('/app/docker-compose.yml')) {
      return { ok: false, error: 'docker-compose.yml not mounted into /app/.' };
    }

    try {
      const { exec, execSync } = await import('node:child_process');
      const hostname = (await import('node:os')).hostname();

      // Detect compose project name + config file path on host
      let project = 'cortex';
      let composeDir = '/opt/cortex'; // default
      let composeHostPath = '/opt/cortex/docker-compose.yml';
      try {
        const inspectRes = execSync(
          `curl -s --unix-socket /var/run/docker.sock http://localhost/containers/${hostname}/json`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        const info = JSON.parse(inspectRes);
        project = info?.Config?.Labels?.['com.docker.compose.project'] || 'cortex';
        const mounts = info?.Mounts || [];
        const composeMnt = mounts.find((m: any) => m.Destination === '/app/docker-compose.yml');
        if (composeMnt?.Source) {
          composeHostPath = composeMnt.Source;
          composeDir = composeMnt.Source.replace(/\/docker-compose\.yml$/, '');
        }
        log.info({ project, composeDir }, 'Detected compose context');
      } catch { /* best effort */ }

      // Step 0: Ensure compose file uses image: mode (not build:)
      // If docker-compose.yml has `build:` active, pull will silently skip
      // and `docker compose up` will try to rebuild instead of using the pulled image.
      try {
        const composeContent = fs.readFileSync('/app/docker-compose.yml', 'utf-8');
        // Check the cortex service section (first ~10 lines) for build: vs image:
        // Only look at the cortex service block, not other services like neo4j
        const lines = composeContent.split('\n');
        let hasBuild = false;
        let hasImage = false;
        let inCortexService = false;
        for (const line of lines) {
          // Detect service blocks by unindented or single-indent names ending with ':'
          if (/^\s{2}\w+:/.test(line) && !line.trim().startsWith('#')) {
            inCortexService = /^\s{2}cortex:/.test(line);
          }
          if (!inCortexService) continue;
          const trimmed = line.trim();
          if (trimmed.startsWith('#')) continue;
          if (/^\s*build:\s/.test(line)) hasBuild = true;
          if (/^\s*image:\s/.test(line)) hasImage = true;
        }
        if (hasBuild && !hasImage) {
          // Compose file is in build mode — fix it on the host via docker socket
          log.warn('Compose file is in build mode, switching to image mode for update');
          const fixCmd = `docker run --rm -v "${composeDir}:/target" alpine sh -c "sed -i 's|^\\(\\s*\\)build: \\.|\\1# build: .|;s|^\\(\\s*\\)# *image: ghcr|\\1image: ghcr|' /target/docker-compose.yml"`;
          try {
            execSync(fixCmd, { timeout: 10000, encoding: 'utf-8', stdio: 'pipe' });
            log.info('Compose file switched to image mode');
          } catch (fixErr: any) {
            log.warn({ error: fixErr.message }, 'Failed to auto-fix compose file, proceeding anyway');
          }
        }
      } catch (e: any) {
        log.warn({ error: e.message }, 'Could not check compose file mode');
      }

      // Step 1: Pull latest image (use explicit image name to avoid build: skip)
      const IMAGE = getUpdateImage();
      log.info('Pulling latest image...');
      try {
        const pullOutput = execSync(`docker pull ${IMAGE}`, { timeout: 120000, encoding: 'utf-8', stdio: 'pipe' });
        log.info({ output: pullOutput.trim().split('\n').pop() }, 'Pull complete');
      } catch (pullErr: any) {
        return { ok: false, error: 'Pull failed: ' + (pullErr.stderr || pullErr.message) };
      }

      // Step 2: Remove stale updater container if exists (from a previous failed update)
      try {
        execSync('docker rm -f cortex-updater 2>/dev/null', { timeout: 5000, stdio: 'pipe' });
      } catch { /* ignore — container doesn't exist */ }

      // Step 3: Spawn a helper container to recreate us
      // The helper mounts docker socket + the host's compose directory,
      // waits 2 seconds (for API response), then runs compose up.
      const helperCmd = [
        'docker run -d --rm',
        '--name cortex-updater',
        '-v /var/run/docker.sock:/var/run/docker.sock',
        `-v "${composeDir}:/work:ro"`,
        '-w /work',
        IMAGE,
        'sh', '-c',
        `"sleep 2 && docker compose -p ${project} up -d --force-recreate --remove-orphans 2>&1"`,
      ].join(' ');

      log.info({ helperCmd }, 'Spawning updater container');
      exec(helperCmd, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) log.error({ error: err.message, stderr }, 'Failed to spawn updater');
        else log.info({ stdout: stdout.trim() }, 'Updater container started');
      });

      return { ok: true, message: 'Update triggered. Server will restart shortly.' };
    } catch (e: any) {
      log.error({ error: e.message }, 'Failed to trigger update');
      return { ok: false, error: e.message };
    }
  });
  // Component health status
  app.get('/api/v2/health/components', async () => {
    const db = getDb();
    const config = getConfig();
    const components: any[] = [];

    // 1. Extraction LLM
    try {
      const last = db.prepare(`SELECT channel, created_at, latency_ms, memories_written, memories_deduped FROM extraction_logs ORDER BY created_at DESC LIMIT 1`).get() as any;
      // Ensure UTC timestamp has Z suffix for correct client-side parsing
      if (last?.created_at && !last.created_at.endsWith('Z')) last.created_at = last.created_at + 'Z';
      const errorCount = (db.prepare(`SELECT COUNT(*) as c FROM extraction_logs WHERE error IS NOT NULL AND created_at > datetime('now', '-24 hours')`).get() as any)?.c || 0;
      const totalLast24h = (db.prepare(`SELECT COUNT(*) as c FROM extraction_logs WHERE created_at > datetime('now', '-24 hours')`).get() as any)?.c || 0;
      const hasExtractionLLM = isProviderConfigured(config.llm?.extraction);
      components.push({
        id: 'extraction_llm',
        name: 'Extraction LLM',
        status: hasExtractionLLM ? (last ? 'ok' : 'unknown') : 'not_configured',
        lastRun: last?.created_at || null,
        latencyMs: last?.latency_ms || null,
        details: {
          configured: hasExtractionLLM,
          provider: config.llm?.extraction?.provider,
          model: config.llm?.extraction?.model,
          channel: last?.channel,
          memoriesWritten: last?.memories_written,
          last24h: totalLast24h,
          errorsLast24h: errorCount,
        },
      });
    } catch { components.push({ id: 'extraction_llm', name: 'Extraction LLM', status: 'error' }); }

    // 2. Lifecycle v2 maintenance
    try {
      const latestRun = cortex.lifecycleV2.logs(50, 0).items.find((entry: any) => entry.action === 'v2_lifecycle_run') as any;
      if (latestRun?.executed_at && !latestRun.executed_at.endsWith('Z')) latestRun.executed_at = latestRun.executed_at + 'Z';
      let details: any = {};
      try { details = latestRun?.details ? JSON.parse(latestRun.details) : {}; } catch {}
      components.push({
        id: 'lifecycle',
        name: 'Lifecycle V2',
        status: latestRun ? 'ok' : 'unknown',
        lastRun: latestRun?.executed_at || null,
        latencyMs: details.durationMs || null,
        details: {
          activeNotes: details.active_notes ?? 0,
          dormantCandidates: details.dormant_candidates ?? 0,
          staleCandidates: details.stale_candidates ?? 0,
          purgeCandidates: details.purge_candidates ?? 0,
          retiredNotes: details.retired_notes ?? 0,
          staledNotes: details.staled_notes ?? 0,
          purgedNotes: details.purged_notes ?? 0,
        },
      });
    } catch { components.push({ id: 'lifecycle', name: 'Lifecycle V2', status: 'error' }); }

    // 3. Embedding Service
    try {
      const hasEmbedding = isProviderConfigured(config.embedding);
      const lastAccess = db.prepare(`SELECT accessed_at FROM access_log ORDER BY accessed_at DESC LIMIT 1`).get() as any;
      if (lastAccess?.accessed_at && !lastAccess.accessed_at.endsWith('Z')) lastAccess.accessed_at = lastAccess.accessed_at + 'Z';
      components.push({
        id: 'embedding',
        name: 'Embedding',
        status: hasEmbedding ? (lastAccess ? 'ok' : 'unknown') : 'not_configured',
        lastRun: lastAccess?.accessed_at || null,
        details: {
          model: config.embedding?.model || 'default',
          configured: hasEmbedding,
        },
      });
    } catch { components.push({ id: 'embedding', name: 'Embedding', status: 'error' }); }

    // 4. Scheduler
    try {
      const { getSchedulerStatus } = await import('../core/scheduler.js');
      const sched = getSchedulerStatus();
      components.push({
        id: 'scheduler',
        name: 'Lifecycle Scheduler',
        status: sched.running ? 'ok' : 'stopped',
        details: {
          schedule: sched.schedule,
          nextRun: sched.nextRun,
          running: sched.running,
        },
      });
    } catch { components.push({ id: 'scheduler', name: 'Scheduler', status: 'unknown' }); }

    return { components };
  });

  // Test connections
  app.post('/api/v2/health/test', async () => {
    const config = getConfig();
    const results: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};

    // Test LLM
    try {
      const start = Date.now();
      const response = await cortex.llmExtraction.complete('Reply with exactly: pong', { maxTokens: 10 });
      results.llm = { ok: response.length > 0, latencyMs: Date.now() - start };
    } catch (e: any) {
      results.llm = { ok: false, latencyMs: 0, error: e.message?.slice(0, 200) };
    }

    // Test Embedding
    try {
      const start = Date.now();
      const emb = await cortex.embeddingProvider.embed('test connection');
      results.embedding = { ok: emb.length > 0, latencyMs: Date.now() - start };
      if (emb.length === 0) results.embedding.error = 'Empty embedding returned';
    } catch (e: any) {
      results.embedding = { ok: false, latencyMs: 0, error: e.message?.slice(0, 200) };
    }

    return results;
  });

  // Get config (safe — masks sensitive fields, exposes baseUrl + hasApiKey)
  app.get('/api/v2/config', async () => {
    const config = getConfig();
    return buildSafeConfig(config, { includeServerInfo: true });
  });

  // Export full config (includes secrets — for backup/migration)
  app.get('/api/v2/config/export', async () => {
    const config = getConfig();
    // Return full config with real apiKeys but strip internal-only fields
    const { ...exportable } = config;
    return exportable;
  });

  app.patch('/api/v2/config', async (req, reply) => {
    const body = req.body as any;
    const current = getConfig();
    const updated = updateConfig(body);
    const requestedSections = collectChangedConfigSections(body, current, updated);
    const readOnlySections = requestedSections.filter(section => !isSectionWritableFromSettings(section));

    if (readOnlySections.length > 0) {
      updateConfig(current);
      return reply.code(400).send({
        ok: false,
        code: 'READ_ONLY_CONFIG',
        message: 'One or more sections are deployment-only and cannot be changed from Settings.',
        read_only_sections: readOnlySections,
      });
    }

    const runtimeSections = new Set(
      requestedSections.filter(section => canApplySectionAtRuntime(section)),
    );
    const restartRequired = requestedSections.filter(section => !runtimeSections.has(section));
    const reloaded = runtimeSections.size > 0
      ? await cortex.reloadProviders(updated, Array.from(runtimeSections))
      : [];

    if (runtimeSections.has('lifecycle.schedule')) {
      restartLifecycleScheduler(cortex);
    }

    const appliedSections = Array.from(new Set(reloaded.filter(section => runtimeSections.has(section))));

    return {
      ok: true,
      config: buildSafeConfig(updated),
      requires_restart: restartRequired.length > 0,
      runtime_applied: appliedSections.length > 0,
      applied_sections: appliedSections,
      restart_required_sections: restartRequired,
    };
  });

  // Test LLM connection
  app.post('/api/v2/test-llm', async (req) => {
    const body = req.body as any;
    const target: 'extraction' | 'lifecycle' = body?.target === 'lifecycle' ? 'lifecycle' : 'extraction';
    const provider = target === 'extraction' ? cortex.llmExtraction : cortex.llmLifecycle;
    const providerName = cortex.config.llm[target].provider;
    const start = Date.now();
    try {
      await provider.complete('Reply with exactly: OK', { maxTokens: 10, temperature: 0 });
      return { ok: true, provider: providerName, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, provider: providerName, latency_ms: Date.now() - start, error: e.message };
    }
  });

  // Test Embedding connection
  app.post('/api/v2/test-embedding', async () => {
    const providerName = cortex.config.embedding.provider;
    const start = Date.now();
    try {
      const result = await cortex.embeddingProvider.embed('test connection');
      return {
        ok: result.length > 0,
        provider: providerName,
        dimensions: result.length,
        latency_ms: Date.now() - start,
      };
    } catch (e: any) {
      return { ok: false, provider: providerName, dimensions: 0, latency_ms: Date.now() - start, error: e.message };
    }
  });

  // Test Reranker connection
  app.post('/api/v2/test-reranker', async () => {
    const rerankerConfig = cortex.config.search?.reranker;
    const provider = rerankerConfig?.provider ?? 'none';
    if (provider === 'none') {
      return { ok: false, provider, error: 'Reranker is disabled' };
    }
    // Check API key for dedicated providers
    if (['cohere', 'voyage', 'jina', 'siliconflow'].includes(provider)) {
      const envKeys: Record<string, string> = { cohere: 'COHERE_API_KEY', voyage: 'VOYAGE_API_KEY', jina: 'JINA_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
      if (!rerankerConfig?.apiKey && !process.env[envKeys[provider] ?? '']) {
        return { ok: false, provider, error: `API key not configured. Set it in Dashboard or via ${envKeys[provider]} env var.` };
      }
    }
    const start = Date.now();
    try {
      // Create a minimal test: rerank 3 simple documents
      const now = new Date().toISOString();
      const testResults: SearchResult[] = [
        {
          id: '1',
          content: 'The weather is nice today',
          layer: 'core',
          category: 'fact',
          agent_id: 'test',
          importance: 0.5,
          decay_score: 1,
          access_count: 1,
          created_at: now,
          textScore: 0.2,
          vectorScore: 0.1,
          rawVectorSim: 0.1,
          fusedScore: 0.2,
          layerWeight: 1,
          recencyBoost: 1,
          accessBoost: 1,
          finalScore: 0.2,
        },
        {
          id: '2',
          content: 'Cortex is a memory system for AI',
          layer: 'core',
          category: 'fact',
          agent_id: 'test',
          importance: 0.5,
          decay_score: 1,
          access_count: 1,
          created_at: now,
          textScore: 0.8,
          vectorScore: 0.7,
          rawVectorSim: 0.7,
          fusedScore: 0.8,
          layerWeight: 1,
          recencyBoost: 1,
          accessBoost: 1,
          finalScore: 0.8,
        },
        {
          id: '3',
          content: 'Docker containers need regular cleanup',
          layer: 'core',
          category: 'fact',
          agent_id: 'test',
          importance: 0.5,
          decay_score: 1,
          access_count: 1,
          created_at: now,
          textScore: 0.1,
          vectorScore: 0.1,
          rawVectorSim: 0.1,
          fusedScore: 0.1,
          layerWeight: 1,
          recencyBoost: 1,
          accessBoost: 1,
          finalScore: 0.1,
        },
      ];
      const { createReranker } = await import('../search/reranker.js');
      const reranker = createReranker(rerankerConfig, cortex.llmExtraction);
      const ranked = await reranker.rerank('What is Cortex?', testResults, 3);
      const topContent = ranked[0]?.content ?? '';
      return {
        ok: ranked.length > 0,
        provider,
        model: rerankerConfig?.model ?? (provider === 'llm' ? 'extraction model' : ''),
        topResult: topContent.substring(0, 50),
        latency_ms: Date.now() - start,
      };
    } catch (e: any) {
      return { ok: false, provider, latency_ms: Date.now() - start, error: e.message };
    }
  });

  // Full reindex — rebuilds all vector embeddings
  app.post('/api/v2/reindex', async (req, reply) => {
    const db = getDb();
    const memories = db.prepare('SELECT id, content FROM memories WHERE superseded_by IS NULL').all() as Pick<Memory, 'id' | 'content'>[];
    const activeIds = new Set(memories.map(m => m.id));

    // Clean ghost vectors: entries in vector index for deleted/superseded memories
    let ghostsCleaned = 0;
    try {
      const vecTable = (() => {
        try { db.prepare('SELECT 1 FROM memories_vec LIMIT 0').get(); return 'memories_vec'; } catch { /* */ }
        try { db.prepare('SELECT 1 FROM memories_vec_fallback LIMIT 0').get(); return 'memories_vec_fallback'; } catch { /* */ }
        return null;
      })();
      if (vecTable) {
        const vecIds = (db.prepare(`SELECT memory_id FROM ${vecTable}`).all() as { memory_id: string }[]).map(r => r.memory_id);
        const ghostIds = vecIds.filter(id => !activeIds.has(id));
        if (ghostIds.length > 0) {
          await cortex.vectorBackend.delete(ghostIds);
          ghostsCleaned = ghostIds.length;
          log.info({ count: ghostsCleaned }, 'Cleaned ghost vectors during reindex');
        }
      }
    } catch (e: any) {
      log.warn({ error: e.message }, 'Ghost vector cleanup failed, continuing with reindex');
    }

    let indexed = 0;
    let errors = 0;
    const batchSize = 20;

    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      try {
        const embeddings = await cortex.embeddingProvider.embedBatch(batch.map(m => m.content));
        for (let j = 0; j < batch.length; j++) {
          if (embeddings[j] && embeddings[j]!.length > 0) {
            await cortex.vectorBackend.upsert(batch[j]!.id, embeddings[j]!);
            indexed++;
          } else {
            log.warn({ id: batch[j]!.id }, 'Reindex: embedding returned empty, provider may be unavailable');
            errors++;
          }
        }
      } catch (e: any) {
        log.error({ error: e.message, batch: i }, 'Reindex batch failed');
        errors += batch.length;
      }
    }

    // Also rebuild FTS index with jieba tokenization
    try {
      const { rebuildFtsIndex } = await import('../db/fts-rebuild.js');
      rebuildFtsIndex();
    } catch (e: any) {
      log.warn({ error: e.message }, 'FTS rebuild during reindex failed');
    }

    return { ok: true, total: memories.length, indexed, errors, ghosts_cleaned: ghostsCleaned };
  });
}

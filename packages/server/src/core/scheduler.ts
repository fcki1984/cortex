/**
 * Scheduler — cron-based lifecycle v2 runner + post-ingest markdown export trigger.
 *
 * This module wires up the two "phantom features" that had config but no runtime:
 * 1. Lifecycle schedule (config.lifecycle.schedule) → runs Lifecycle v2 note maintenance on cron
 * 2. Markdown export (config.markdownExport.enabled) → scheduleExport() after ingest
 */

import { Cron } from 'croner';
import type { CortexApp } from '../app.js';
import type { CortexConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { backupDb } from '../db/connection.js';

const log = createLogger('scheduler');

let lifecycleCron: Cron | null = null;

export function getSchedulerStatus(): { running: boolean; schedule: string | null; nextRun: string | null } {
  if (!lifecycleCron) return { running: false, schedule: null, nextRun: null };
  const next = lifecycleCron.nextRun();
  return {
    running: true,
    schedule: lifecycleCron.getPattern() || null,
    nextRun: next ? next.toISOString() : null,
  };
}

/**
 * Start the lifecycle cron job based on config.lifecycle.schedule.
 * Safe to call multiple times — stops previous job first.
 */
export function startLifecycleScheduler(cortex: CortexApp): void {
  stopLifecycleScheduler();

  const schedule = cortex.config.lifecycle?.schedule;
  if (!schedule) {
    log.info('Lifecycle v2 schedule not configured, skipping');
    return;
  }

  try {
    const tz = process.env.TZ || 'UTC';
    lifecycleCron = new Cron(schedule, { timezone: tz }, async () => {
      log.info({ schedule }, 'Lifecycle v2 cron triggered');
      try { backupDb(); } catch (e: any) { log.warn({ error: e.message }, 'Pre-lifecycle backup failed'); }
      try {
        const report = await cortex.lifecycleV2.run();
        log.info(
          {
            active_notes: report.summary.active_notes,
            dormant_candidates: report.summary.dormant_candidates,
            stale_candidates: report.summary.stale_candidates,
            purge_candidates: report.summary.purge_candidates,
            retired_notes: report.summary.retired_notes,
            staled_notes: report.summary.staled_notes,
            purged_notes: report.summary.purged_notes,
          },
          'Lifecycle v2 cron completed',
        );
      } catch (e: any) {
        log.error({ error: e.message }, 'Lifecycle v2 cron failed');
      }
    });

    const next = lifecycleCron.nextRun();
    log.info({ schedule, timezone: tz, nextRun: next?.toISOString() }, 'Lifecycle v2 scheduler started');
  } catch (e: any) {
    log.error({ error: e.message, schedule }, 'Failed to start lifecycle v2 scheduler (invalid cron?)');
  }
}

/**
 * Stop the lifecycle cron job.
 */
export function stopLifecycleScheduler(): void {
  if (lifecycleCron) {
    lifecycleCron.stop();
    lifecycleCron = null;
    log.info('Lifecycle v2 scheduler stopped');
  }
}

/**
 * Restart the scheduler with new config (e.g. after config update from Dashboard).
 */
export function restartLifecycleScheduler(cortex: CortexApp): void {
  startLifecycleScheduler(cortex);
}

/**
 * Trigger markdown export after a successful ingest (debounced inside exporter).
 */
export function triggerMarkdownExport(cortex: CortexApp): void {
  if (cortex.config.markdownExport?.enabled && cortex.exporter) {
    cortex.exporter.scheduleExport();
  }
}

import { insertLifecycleLog, getLifecycleLogs, countLifecycleLogs } from '../db/index.js';
import { deleteRecord, updateSessionNoteLifecycle } from './store.js';
import type { CortexRecord, SessionNoteRecord } from './types.js';
import type { CortexRecordsV2 } from './service.js';

const ACTIVE_RETIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const DORMANT_TO_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

type LifecycleNoteRecord = Extract<CortexRecord, { kind: 'session_note' }>;

function asTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function dormantCutoff(now = Date.now()): number {
  return now - ACTIVE_RETIRE_AFTER_MS;
}

function staleCutoff(now = Date.now()): number {
  return now - DORMANT_TO_STALE_AFTER_MS;
}

function purgeDeadline(now = Date.now()): string {
  return new Date(now + PURGE_AFTER_MS).toISOString();
}

function retireNote(note: LifecycleNoteRecord, now = Date.now()): boolean {
  if (note.lifecycle_state !== 'active') return false;
  const expiresAt = asTimestamp(note.expires_at);
  const updatedAt = asTimestamp(note.updated_at);
  return (expiresAt !== null && expiresAt <= now) || (updatedAt !== null && updatedAt <= dormantCutoff(now));
}

function staleNote(note: LifecycleNoteRecord, now = Date.now()): boolean {
  if (note.lifecycle_state !== 'dormant') return false;
  const retiredAt = asTimestamp(note.retired_at);
  return retiredAt !== null && retiredAt <= staleCutoff(now);
}

function purgeNote(note: LifecycleNoteRecord, now = Date.now()): boolean {
  if (note.lifecycle_state !== 'stale') return false;
  const purgeAfter = asTimestamp(note.purge_after);
  return purgeAfter !== null && purgeAfter <= now;
}

function summarizeNote(note: LifecycleNoteRecord) {
  return {
    id: note.id,
    summary: note.summary,
    session_id: note.session_id,
    expires_at: note.expires_at,
    lifecycle_state: note.lifecycle_state,
    retired_at: note.retired_at,
    purge_after: note.purge_after,
  };
}

export class CortexLifecycleV2 {
  constructor(private records: CortexRecordsV2) {}

  private notes(agentId?: string): LifecycleNoteRecord[] {
    return this.records.listRecords({
      agent_id: agentId,
      kind: 'session_note',
      include_inactive: false,
      limit: 5000,
      order_by: 'updated_at',
      order_dir: 'desc',
    }).items.filter((record): record is LifecycleNoteRecord => record.kind === 'session_note');
  }

  preview(agentId?: string) {
    const notes = this.notes(agentId);
    const now = Date.now();
    const activeNotes = notes.filter(note => note.lifecycle_state === 'active');
    const dormantCandidates = activeNotes.filter(note => retireNote(note, now));
    const staleCandidates = notes.filter(note => staleNote(note, now));
    const purgeCandidates = notes.filter(note => purgeNote(note, now));

    return {
      agent_id: agentId || 'all',
      summary: {
        active_notes: activeNotes.length,
        dormant_candidates: dormantCandidates.length,
        stale_candidates: staleCandidates.length,
        purge_candidates: purgeCandidates.length,
      },
      dormant_candidates: dormantCandidates.map(summarizeNote),
      stale_candidates: staleCandidates.map(summarizeNote),
      purge_candidates: purgeCandidates.map(summarizeNote),
    };
  }

  async run(agentId?: string) {
    const preview = this.preview(agentId);
    const nowIso = new Date().toISOString();
    const retiredIds: string[] = [];
    const staledIds: string[] = [];
    const purgedIds: string[] = [];

    for (const note of preview.dormant_candidates) {
      const updated = updateSessionNoteLifecycle(note.id, {
        lifecycle_state: 'dormant',
        retired_at: nowIso,
        purge_after: purgeDeadline(),
      });
      if (updated) retiredIds.push(updated.id);
    }

    for (const note of preview.stale_candidates) {
      const updated = updateSessionNoteLifecycle(note.id, {
        lifecycle_state: 'stale',
      });
      if (updated) staledIds.push(updated.id);
    }

    for (const note of preview.purge_candidates) {
      if (deleteRecord(note.id)) purgedIds.push(note.id);
    }

    if (retiredIds.length > 0) {
      insertLifecycleLog('v2_note_retire', retiredIds, {
        agent_id: agentId || 'all',
        retired_notes: retiredIds.length,
      });
    }
    if (staledIds.length > 0) {
      insertLifecycleLog('v2_note_stale', staledIds, {
        agent_id: agentId || 'all',
        staled_notes: staledIds.length,
      });
    }
    if (purgedIds.length > 0) {
      insertLifecycleLog('v2_note_purge', purgedIds, {
        agent_id: agentId || 'all',
        purged_notes: purgedIds.length,
      });
    }

    insertLifecycleLog('v2_lifecycle_run', [...retiredIds, ...staledIds, ...purgedIds], {
      agent_id: agentId || 'all',
      retired_notes: retiredIds.length,
      staled_notes: staledIds.length,
      purged_notes: purgedIds.length,
      active_notes: preview.summary.active_notes,
      dormant_candidates: preview.summary.dormant_candidates,
      stale_candidates: preview.summary.stale_candidates,
      purge_candidates: preview.summary.purge_candidates,
    });

    return {
      agent_id: agentId || 'all',
      summary: {
        active_notes: preview.summary.active_notes,
        dormant_candidates: preview.summary.dormant_candidates,
        stale_candidates: preview.summary.stale_candidates,
        purge_candidates: preview.summary.purge_candidates,
        retired_notes: retiredIds.length,
        staled_notes: staledIds.length,
        purged_notes: purgedIds.length,
      },
      retired_note_ids: retiredIds,
      staled_note_ids: staledIds,
      purged_note_ids: purgedIds,
    };
  }

  logs(limit = 50, offset = 0, agentId?: string) {
    const allItems = getLifecycleLogs(500, 0).filter(log => log.action.startsWith('v2_'));
    const filtered = agentId
      ? allItems.filter((log: any) => {
          try {
            const details = log.details ? JSON.parse(log.details) : {};
            return details.agent_id === agentId || details.agent_id === 'all';
          } catch {
            return true;
          }
        })
      : allItems;

    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length || countLifecycleLogs(),
    };
  }
}

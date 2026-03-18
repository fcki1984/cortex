import { insertLifecycleLog, getLifecycleLogs, countLifecycleLogs } from '../db/index.js';
import { supersedeRecordById, deactivateRecord } from './store.js';
import type { CortexRecord } from './types.js';
import type { CortexRecordsV2 } from './service.js';

const COMPRESSION_GROUP_MIN = 3;

type LifecycleNoteRecord = Extract<CortexRecord, { kind: 'session_note' }>;

function noteIsExpired(note: LifecycleNoteRecord): boolean {
  return !!note.expires_at && new Date(note.expires_at).getTime() <= Date.now();
}

function compressionGroups(notes: LifecycleNoteRecord[]): LifecycleNoteRecord[][] {
  const groups = new Map<string, LifecycleNoteRecord[]>();
  for (const note of notes) {
    if (note.tags.includes('lifecycle_compressed')) continue;
    const key = `${note.agent_id}:${note.session_id || 'global'}`;
    const bucket = groups.get(key) || [];
    bucket.push(note);
    groups.set(key, bucket);
  }
  return Array.from(groups.values()).filter(group => group.length >= COMPRESSION_GROUP_MIN);
}

function buildSummary(group: LifecycleNoteRecord[]): string {
  const lines = group
    .slice(0, 6)
    .map(note => note.summary.trim())
    .filter(Boolean);
  return `Lifecycle summary: ${lines.join(' | ')}`.slice(0, 500);
}

export class CortexLifecycleV2 {
  constructor(private records: CortexRecordsV2) {}

  private activeNotes(agentId?: string): LifecycleNoteRecord[] {
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
    const notes = this.activeNotes(agentId);
    const expired = notes.filter(noteIsExpired);
    const groups = compressionGroups(notes.filter(note => !noteIsExpired(note)));

    return {
      agent_id: agentId || 'all',
      summary: {
        active_notes: notes.length,
        expire_count: expired.length,
        compression_groups: groups.length,
        notes_to_compress: groups.reduce((sum, group) => sum + group.length, 0),
      },
      expire_candidates: expired.map(note => ({
        id: note.id,
        summary: note.summary,
        session_id: note.session_id,
        expires_at: note.expires_at,
      })),
      compression_candidates: groups.map(group => ({
        session_id: group[0]?.session_id || null,
        note_ids: group.map(note => note.id),
        summaries: group.map(note => note.summary),
        replacement_summary: buildSummary(group),
      })),
    };
  }

  async run(agentId?: string) {
    const preview = this.preview(agentId);
    const expiredIds: string[] = [];
    const compressedIds: string[] = [];
    const writtenNoteIds: string[] = [];

    for (const note of preview.expire_candidates) {
      if (deactivateRecord(note.id)) expiredIds.push(note.id);
    }

    for (const group of preview.compression_candidates) {
      const firstNote = this.activeNotes(agentId).find(note => note.id === group.note_ids[0]);
      if (!firstNote) continue;
      const result = await this.records.remember({
        kind: 'session_note',
        agent_id: firstNote.agent_id,
        session_id: firstNote.session_id ?? undefined,
        content: group.replacement_summary,
        source_type: 'system_derived',
        tags: ['lifecycle_compressed'],
        priority: 0.35,
      });
      writtenNoteIds.push(result.record.id);
      for (const noteId of group.note_ids) {
        supersedeRecordById(noteId, result.record.id);
        compressedIds.push(noteId);
      }
      insertLifecycleLog('v2_note_compress', [...group.note_ids, result.record.id], {
        agent_id: agentId || firstNote.agent_id,
        session_id: firstNote.session_id,
        compressed_count: group.note_ids.length,
        replacement_record_id: result.record.id,
      });
    }

    insertLifecycleLog('v2_lifecycle_run', [...expiredIds, ...compressedIds, ...writtenNoteIds], {
      agent_id: agentId || 'all',
      expired_notes: expiredIds.length,
      compressed_notes: compressedIds.length,
      written_notes: writtenNoteIds.length,
      compression_groups: preview.summary.compression_groups,
    });

    return {
      agent_id: agentId || 'all',
      summary: {
        expired_notes: expiredIds.length,
        compressed_notes: compressedIds.length,
        written_notes: writtenNoteIds.length,
        compression_groups: preview.summary.compression_groups,
      },
      expired_note_ids: expiredIds,
      compressed_note_ids: compressedIds,
      written_note_ids: writtenNoteIds,
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

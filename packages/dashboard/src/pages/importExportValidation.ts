export type ImportRecordKind = 'profile_rule' | 'fact_slot' | 'task_state' | 'session_note';

export type ImportPreviewShape = {
  record_candidates: Array<{
    candidate_id: string;
    selected: boolean;
    requested_kind: ImportRecordKind;
    content: string;
    subject_key?: string;
    attribute_key?: string;
    entity_key?: string;
    state_key?: string;
  }>;
  relation_candidates: Array<{
    candidate_id: string;
    selected: boolean;
    subject_key?: string;
    predicate?: string;
    object_key?: string;
  }>;
};

export type ImportValidationIssue =
  | {
      candidate_id: string;
      type: 'record';
      field: 'content' | 'subject_key' | 'attribute_key' | 'entity_key' | 'state_key';
      code: 'required';
      requested_kind: ImportRecordKind;
    }
  | {
      candidate_id: string;
      type: 'relation';
      field: 'subject_key' | 'predicate' | 'object_key';
      code: 'required';
    };

function hasText(value: string | undefined): boolean {
  return !!value?.trim();
}

export function validateSelectedImportPreview(preview: ImportPreviewShape): ImportValidationIssue[] {
  const issues: ImportValidationIssue[] = [];

  for (const candidate of preview.record_candidates) {
    if (!candidate.selected) continue;

    if (!hasText(candidate.content)) {
      issues.push({
        candidate_id: candidate.candidate_id,
        type: 'record',
        field: 'content',
        code: 'required',
        requested_kind: candidate.requested_kind,
      });
      continue;
    }

    if (candidate.requested_kind === 'profile_rule' && !hasText(candidate.attribute_key)) {
      issues.push({
        candidate_id: candidate.candidate_id,
        type: 'record',
        field: 'attribute_key',
        code: 'required',
        requested_kind: candidate.requested_kind,
      });
      continue;
    }

    if (candidate.requested_kind === 'fact_slot') {
      if (!hasText(candidate.entity_key)) {
        issues.push({
          candidate_id: candidate.candidate_id,
          type: 'record',
          field: 'entity_key',
          code: 'required',
          requested_kind: candidate.requested_kind,
        });
        continue;
      }

      if (!hasText(candidate.attribute_key)) {
        issues.push({
          candidate_id: candidate.candidate_id,
          type: 'record',
          field: 'attribute_key',
          code: 'required',
          requested_kind: candidate.requested_kind,
        });
        continue;
      }
    }

    if (candidate.requested_kind === 'task_state') {
      if (!hasText(candidate.subject_key)) {
        issues.push({
          candidate_id: candidate.candidate_id,
          type: 'record',
          field: 'subject_key',
          code: 'required',
          requested_kind: candidate.requested_kind,
        });
        continue;
      }

      if (!hasText(candidate.state_key)) {
        issues.push({
          candidate_id: candidate.candidate_id,
          type: 'record',
          field: 'state_key',
          code: 'required',
          requested_kind: candidate.requested_kind,
        });
      }
    }
  }

  for (const candidate of preview.relation_candidates) {
    if (!candidate.selected) continue;

    if (!hasText(candidate.subject_key)) {
      issues.push({
        candidate_id: candidate.candidate_id,
        type: 'relation',
        field: 'subject_key',
        code: 'required',
      });
      continue;
    }

    if (!hasText(candidate.predicate)) {
      issues.push({
        candidate_id: candidate.candidate_id,
        type: 'relation',
        field: 'predicate',
        code: 'required',
      });
      continue;
    }

    if (!hasText(candidate.object_key)) {
      issues.push({
        candidate_id: candidate.candidate_id,
        type: 'relation',
        field: 'object_key',
        code: 'required',
      });
    }
  }

  return issues;
}

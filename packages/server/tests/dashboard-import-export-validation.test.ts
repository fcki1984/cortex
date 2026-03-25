import { describe, expect, it } from 'vitest';
import {
  type ImportPreviewShape,
  validateSelectedImportPreview,
} from '../../dashboard/src/pages/importExportValidation.ts';

function createPreview(overrides: Partial<ImportPreviewShape> = {}): ImportPreviewShape {
  return {
    record_candidates: [],
    relation_candidates: [],
    ...overrides,
  };
}

describe('Dashboard import/export validation', () => {
  it('rejects selected record candidates with missing required keys', () => {
    const issues = validateSelectedImportPreview(createPreview({
      record_candidates: [{
        candidate_id: 'record_1',
        selected: true,
        requested_kind: 'fact_slot',
        content: '我住大阪',
        entity_key: 'user',
        attribute_key: '',
      }],
    }));

    expect(issues).toEqual([
      {
        candidate_id: 'record_1',
        type: 'record',
        field: 'attribute_key',
        code: 'required',
        requested_kind: 'fact_slot',
      },
    ]);
  });

  it('rejects selected candidates with empty content or incomplete relations', () => {
    const issues = validateSelectedImportPreview(createPreview({
      record_candidates: [{
        candidate_id: 'record_2',
        selected: true,
        requested_kind: 'profile_rule',
        content: '   ',
        subject_key: 'user',
        attribute_key: 'language_preference',
      }],
      relation_candidates: [{
        candidate_id: 'relation_1',
        selected: true,
        subject_key: 'user',
        predicate: 'works_at',
        object_key: '',
      }],
    }));

    expect(issues).toEqual([
      {
        candidate_id: 'record_2',
        type: 'record',
        field: 'content',
        code: 'required',
        requested_kind: 'profile_rule',
      },
      {
        candidate_id: 'relation_1',
        type: 'relation',
        field: 'object_key',
        code: 'required',
      },
    ]);
  });

  it('ignores invalid unselected candidates', () => {
    const issues = validateSelectedImportPreview(createPreview({
      record_candidates: [{
        candidate_id: 'record_3',
        selected: false,
        requested_kind: 'task_state',
        content: '',
        subject_key: '',
        state_key: '',
      }],
    }));

    expect(issues).toEqual([]);
  });
});

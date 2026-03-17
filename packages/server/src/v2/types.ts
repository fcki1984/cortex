export type RecordKind = 'profile_rule' | 'fact_slot' | 'task_state' | 'session_note';

export type SourceType =
  | 'user_explicit'
  | 'user_confirmed'
  | 'assistant_inferred'
  | 'system_derived';

export interface BaseRecord {
  id: string;
  kind: RecordKind;
  agent_id: string;
  source_type: SourceType;
  tags: string[];
  searchable_text: string;
  priority: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  content: string;
}

export interface ProfileRuleRecord extends BaseRecord {
  kind: 'profile_rule';
  owner_scope: 'user' | 'agent';
  subject_key: string;
  attribute_key: string;
  value_text: string;
  value_json: string | null;
  confidence: number;
  last_confirmed_at: string | null;
  superseded_by: string | null;
  metadata: string | null;
}

export interface FactSlotRecord extends BaseRecord {
  kind: 'fact_slot';
  entity_key: string;
  attribute_key: string;
  value_text: string;
  value_json: string | null;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  metadata: string | null;
}

export interface TaskStateRecord extends BaseRecord {
  kind: 'task_state';
  subject_key: string;
  state_key: string;
  status: string;
  summary: string;
  confidence: number;
  last_confirmed_at: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  metadata: string | null;
}

export interface SessionNoteRecord extends BaseRecord {
  kind: 'session_note';
  session_id: string | null;
  summary: string;
  confidence: number;
  expires_at: string | null;
  superseded_by: string | null;
  metadata: string | null;
}

export type CortexRecord =
  | ProfileRuleRecord
  | FactSlotRecord
  | TaskStateRecord
  | SessionNoteRecord;

interface BaseCandidate {
  kind: RecordKind;
  agent_id: string;
  source_type: SourceType;
  tags?: string[];
  priority?: number;
  searchable_text?: string;
  evidence?: EvidenceInput[];
}

export interface ProfileRuleCandidate extends BaseCandidate {
  kind: 'profile_rule';
  owner_scope: 'user' | 'agent';
  subject_key: string;
  attribute_key: string;
  value_text: string;
  value_json?: string | null;
  confidence: number;
  last_confirmed_at?: string | null;
  metadata?: string | null;
}

export interface FactSlotCandidate extends BaseCandidate {
  kind: 'fact_slot';
  entity_key: string;
  attribute_key: string;
  value_text: string;
  value_json?: string | null;
  confidence: number;
  valid_from?: string | null;
  valid_to?: string | null;
  metadata?: string | null;
}

export interface TaskStateCandidate extends BaseCandidate {
  kind: 'task_state';
  subject_key: string;
  state_key: string;
  status: string;
  summary: string;
  confidence: number;
  last_confirmed_at?: string | null;
  valid_to?: string | null;
  metadata?: string | null;
}

export interface SessionNoteCandidate extends BaseCandidate {
  kind: 'session_note';
  session_id?: string | null;
  summary: string;
  confidence: number;
  expires_at?: string | null;
  metadata?: string | null;
}

export type RecordCandidate =
  | ProfileRuleCandidate
  | FactSlotCandidate
  | TaskStateCandidate
  | SessionNoteCandidate;

export interface EvidenceInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
  conversation_ref_id?: string;
}

export interface RecordEvidence {
  id: number;
  record_id: string;
  agent_id: string;
  source_type: SourceType;
  role: 'user' | 'assistant' | 'system';
  content: string;
  conversation_ref_id: string | null;
  created_at: string;
}

export interface RecordUpsertResult {
  decision: 'inserted' | 'superseded' | 'ignored' | 'updated';
  record: CortexRecord;
  previous_record_id?: string;
}

export interface RecordListOptions {
  agent_id?: string;
  kind?: RecordKind;
  source_type?: SourceType;
  include_inactive?: boolean;
  limit?: number;
  offset?: number;
  order_by?: 'created_at' | 'updated_at' | 'priority' | 'source_type' | 'kind';
  order_dir?: 'asc' | 'desc';
  query?: string;
}

export interface RecallOptions {
  query: string;
  agent_id?: string;
  max_tokens?: number;
}

export interface RecallMeta {
  query: string;
  total_candidates: number;
  injected_count: number;
  skipped: boolean;
  reason?: string;
  latency_ms: number;
}

export interface RecallResponse {
  context: string;
  rules: ProfileRuleRecord[];
  facts: FactSlotRecord[];
  task_state: TaskStateRecord[];
  session_notes: SessionNoteRecord[];
  meta: RecallMeta;
}

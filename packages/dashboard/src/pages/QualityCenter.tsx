import React, { useMemo, useState } from 'react';
import {
  createAgent,
  createRecordV2,
  deleteAgent,
  deleteRecordV2,
  deleteRelationCandidateV2,
  deleteRelationV2,
  listRelationCandidatesV2,
  listRelationsV2,
  recallV2,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';

type ScenarioResult = {
  id: string;
  label: string;
  query: string;
  expected: string;
  passed: boolean;
  context: string;
  actual: string;
  meta: unknown;
};

type SeededRecord = {
  id?: string;
  record?: {
    id?: string;
  };
};

const SCENARIO_LABELS = [
  'location',
  'organization',
  'language preference',
  'task_state',
  'note-only negative',
  'newest winner',
] as const;

function getRecordId(response: SeededRecord): string | null {
  return response?.record?.id || response?.id || null;
}

function stringifyBrief(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function hasContent(items: any[] | undefined, expected: string): boolean {
  return (items || []).some((item) => String(item?.content || '').includes(expected));
}

function hasAttribute(items: any[] | undefined, attributeKey: string): boolean {
  return (items || []).some((item) => item?.attribute_key === attributeKey);
}

function hasState(items: any[] | undefined, stateKey: string): boolean {
  return (items || []).some((item) => item?.state_key === stateKey);
}

function evaluateScenario(label: typeof SCENARIO_LABELS[number], queryText: string, body: any): ScenarioResult {
  switch (label) {
    case 'location':
      return {
        id: label,
        label,
        query: queryText,
        expected: 'inject location fact only',
        passed: hasAttribute(body.facts, 'location') && String(body.context || '').includes('大阪') && !String(body.context || '').includes('OpenAI'),
        context: body.context || '',
        actual: stringifyBrief({ facts: body.facts, rules: body.rules, task_state: body.task_state, session_notes: body.session_notes }),
        meta: body.meta,
      };
    case 'organization':
      return {
        id: label,
        label,
        query: queryText,
        expected: 'inject organization fact with relation evidence available',
        passed: hasAttribute(body.facts, 'organization') && String(body.context || '').includes('OpenAI'),
        context: body.context || '',
        actual: stringifyBrief({ facts: body.facts, rules: body.rules, task_state: body.task_state, session_notes: body.session_notes }),
        meta: body.meta,
      };
    case 'language preference':
      return {
        id: label,
        label,
        query: queryText,
        expected: 'inject language preference rule',
        passed: hasAttribute(body.rules, 'language_preference') && String(body.context || '').includes('中文'),
        context: body.context || '',
        actual: stringifyBrief({ facts: body.facts, rules: body.rules, task_state: body.task_state, session_notes: body.session_notes }),
        meta: body.meta,
      };
    case 'task_state':
      return {
        id: label,
        label,
        query: queryText,
        expected: 'inject current task state',
        passed: hasState(body.task_state, 'refactor_status') && String(body.context || '').includes('重构 Cortex recall'),
        context: body.context || '',
        actual: stringifyBrief({ facts: body.facts, rules: body.rules, task_state: body.task_state, session_notes: body.session_notes }),
        meta: body.meta,
      };
    case 'note-only negative':
      return {
        id: label,
        label,
        query: queryText,
        expected: 'do not inject note-only speculative context; reason=low_relevance',
        passed: !body.context && (body.session_notes || []).length === 0 && body.meta?.reason === 'low_relevance',
        context: body.context || '',
        actual: stringifyBrief({ facts: body.facts, rules: body.rules, task_state: body.task_state, session_notes: body.session_notes, reason: body.meta?.reason }),
        meta: body.meta,
      };
    case 'newest winner':
    default:
      return {
        id: label,
        label,
        query: queryText,
        expected: 'inject newest active location winner only',
        passed: hasContent(body.facts, '东京') && !String(body.context || '').includes('京都'),
        context: body.context || '',
        actual: stringifyBrief({ facts: body.facts, rules: body.rules, task_state: body.task_state, session_notes: body.session_notes }),
        meta: body.meta,
      };
  }
}

export default function QualityCenter() {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [createdRecordIds, setCreatedRecordIds] = useState<string[]>([]);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const summary = useMemo(() => {
    const passed = results.filter((result) => result.passed).length;
    return { passed, total: results.length };
  }, [results]);

  const cleanupProbe = async (targetAgentId = agentId, recordIds = createdRecordIds) => {
    if (!targetAgentId) return;
    setCleaning(true);
    try {
      const [candidates, relations] = await Promise.all([
        listRelationCandidatesV2({ agent_id: targetAgentId, limit: '200' }),
        listRelationsV2({ agent_id: targetAgentId, limit: '200' }),
      ]);
      await Promise.all((candidates.items || []).map((item: any) => deleteRelationCandidateV2(item.id)));
      await Promise.all((relations.items || []).map((item: any) => deleteRelationV2(item.id)));
      await Promise.all(recordIds.map((id) => deleteRecordV2(id)));
      await deleteAgent(targetAgentId);
      setAgentId(null);
      setCreatedRecordIds([]);
      setNotice({ type: 'success', message: t('quality.cleanupDone') });
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setCleaning(false);
    }
  };

  const seedRecord = async (targetAgentId: string, payload: Record<string, unknown>) => {
    const response = await createRecordV2({
      agent_id: targetAgentId,
      ...payload,
    });
    const id = getRecordId(response);
    if (id) {
      setCreatedRecordIds((current) => [...current, id]);
    }
    return id;
  };

  const runQualityCheck = async () => {
    setRunning(true);
    setNotice(null);
    setResults([]);
    const nextAgentId = `quality-${Date.now().toString(36)}`;
    const nextRecordIds: string[] = [];
    try {
      if (agentId) {
        await cleanupProbe(agentId, createdRecordIds);
      }
      await createAgent({
        id: nextAgentId,
        name: nextAgentId,
        description: 'Dashboard recall quality probe agent',
      });
      setAgentId(nextAgentId);

      for (const payload of [
        { kind: 'fact_slot', content: '我住大阪' },
        { kind: 'fact_slot', content: '我在 OpenAI 工作' },
        { kind: 'profile_rule', content: '请用中文回答' },
        { kind: 'task_state', content: '当前任务是重构 Cortex recall' },
        { kind: 'session_note', content: '最近也许会考虑换方案' },
      ]) {
        const id = await seedRecord(nextAgentId, payload);
        if (id) nextRecordIds.push(id);
      }

      const checks: Array<{ label: typeof SCENARIO_LABELS[number]; query: string }> = [
        { label: 'location', query: 'Where does the user live?' },
        { label: 'organization', query: 'Where does the user work?' },
        { label: 'language preference', query: 'How should you answer?' },
        { label: 'task_state', query: 'What is the current task?' },
        { label: 'note-only negative', query: '最近是否要换方案？' },
      ];
      const nextResults: ScenarioResult[] = [];
      for (const check of checks) {
        const body = await recallV2({ agent_id: nextAgentId, query: check.query });
        nextResults.push(evaluateScenario(check.label, check.query, body));
      }

      for (const payload of [
        { kind: 'fact_slot', content: '我住京都' },
        { kind: 'fact_slot', content: '现在住东京' },
      ]) {
        const id = await seedRecord(nextAgentId, payload);
        if (id) nextRecordIds.push(id);
      }
      const newest = await recallV2({ agent_id: nextAgentId, query: 'Where does the user live?' });
      nextResults.push(evaluateScenario('newest winner', 'Where does the user live?', newest));

      setCreatedRecordIds(nextRecordIds);
      setResults(nextResults);
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">{t('quality.title')}</h1>
      {notice && (
        <div className="card" style={{ marginBottom: 16, borderColor: notice.type === 'error' ? 'rgba(239,68,68,0.35)' : 'rgba(34,197,94,0.35)' }}>
          {notice.message}
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7, marginBottom: 14 }}>
          {t('quality.intro')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn primary" disabled={running || cleaning} onClick={() => void runQualityCheck()}>
            {running ? t('quality.running') : t('quality.run')}
          </button>
          <button type="button" className="btn" disabled={!agentId || running || cleaning} onClick={() => void cleanupProbe()}>
            {cleaning ? t('quality.cleaning') : t('quality.cleanup')}
          </button>
          {results.length > 0 && (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {t('quality.summary', { passed: summary.passed, total: summary.total })}
            </span>
          )}
        </div>
      </div>

      {results.length === 0 ? (
        <div className="empty">{t('quality.notRun')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {results.map((result) => (
            <div key={result.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>{result.label}</h3>
                <span className="badge" style={{
                  background: result.passed ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                  color: result.passed ? '#4ade80' : '#fca5a5',
                }}>
                  {result.passed ? t('quality.passed') : t('quality.failed')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 8 }}>
                Query: {result.query}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                <div>
                  <strong>{t('quality.expected')}</strong>
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{result.expected}</pre>
                </div>
                <div>
                  <strong>{t('quality.actual')}</strong>
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{result.actual}</pre>
                </div>
                <div>
                  <strong>{result.context ? t('quality.contextInjected') : t('quality.contextEmpty')}</strong>
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{result.context || 'low_relevance'}</pre>
                </div>
                <div>
                  <strong>{t('quality.meta')}</strong>
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{stringifyBrief(result.meta)}</pre>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { normalizeManualInput } from '../src/v2/normalize.js';
import { resolveRetainMissionScope } from '../src/v2/retain-mission.js';

describe('retain mission routing', () => {
  it('keeps durable candidates in scope when the mission is blank', () => {
    const candidate = normalizeManualInput('mission-blank', {
      content: '请用中文回答',
      source_type: 'user_explicit',
    });

    expect(resolveRetainMissionScope('', candidate)).toBe('in_scope');
    expect(resolveRetainMissionScope('   ', candidate)).toBe('in_scope');
  });

  it('keeps stable preferences and background facts in scope for long-term missions', () => {
    const preference = normalizeManualInput('mission-preference', {
      content: '后续交流中文就行',
      source_type: 'user_explicit',
    });
    const fact = normalizeManualInput('mission-fact', {
      content: '我住东京',
      source_type: 'user_explicit',
    });

    const mission = '保留长期偏好和稳定背景，不保留短期任务';

    expect(resolveRetainMissionScope(mission, preference)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, fact)).toBe('in_scope');
  });

  it('filters task-state durables when the mission explicitly excludes short-term tasks', () => {
    const candidate = normalizeManualInput('mission-filter-task', {
      content: '当前任务是重构 Cortex recall',
      source_type: 'user_explicit',
    });

    expect(resolveRetainMissionScope('只保留长期偏好和稳定背景，不保留短期任务', candidate)).toBe('out_of_scope');
  });

  it('routes ambiguous task-state durables to review when the mission only asks for long-term reuse', () => {
    const candidate = normalizeManualInput('mission-review-task', {
      content: '当前任务是重构 Cortex recall',
      source_type: 'user_explicit',
    });

    expect(resolveRetainMissionScope('只保留真正长期有复用价值的内容', candidate)).toBe('unclear');
  });

  it('keeps task-state durables in scope when the mission explicitly keeps current priority tasks', () => {
    const candidate = normalizeManualInput('mission-include-priority-task', {
      content: '当前任务是重构 Cortex recall',
      source_type: 'user_explicit',
    });

    expect(resolveRetainMissionScope('保留长期偏好、稳定背景和当前重点任务', candidate)).toBe('in_scope');
  });

  it('filters task-state durables when the mission naturally excludes current work items', () => {
    const candidate = normalizeManualInput('mission-exclude-current-work', {
      content: '当前任务是重构 Cortex recall',
      source_type: 'user_explicit',
    });

    expect(resolveRetainMissionScope('保留长期偏好和稳定背景，别留当前在做的事', candidate)).toBe('out_of_scope');
  });

  it('distinguishes stable profile-rule keys inside the same category', () => {
    const language = normalizeManualInput('mission-language-only', {
      content: '请用中文回答',
      source_type: 'user_explicit',
    });
    const length = normalizeManualInput('mission-length-excluded', {
      content: '请把回答控制在三句话内',
      source_type: 'user_explicit',
    });

    const mission = '只保留语言偏好，不保留回答长度';

    expect(resolveRetainMissionScope(mission, language)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, length)).toBe('out_of_scope');
  });

  it('distinguishes stable fact-slot keys inside the same category', () => {
    const organization = normalizeManualInput('mission-organization-kept', {
      content: '我在 OpenAI 工作',
      source_type: 'user_explicit',
    });
    const location = normalizeManualInput('mission-location-filtered', {
      content: '我住东京',
      source_type: 'user_explicit',
    });

    const mission = '只保留工作背景和语言偏好';

    expect(resolveRetainMissionScope(mission, organization)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, location)).toBe('out_of_scope');
  });

  it('understands natural mission wording for communication language and work-company retention', () => {
    const language = normalizeManualInput('mission-natural-language-key', {
      content: '请用中文回答',
      source_type: 'user_explicit',
    });
    const organization = normalizeManualInput('mission-natural-organization-key', {
      content: '我在 OpenAI 工作',
      source_type: 'user_explicit',
    });
    const location = normalizeManualInput('mission-natural-location-key', {
      content: '我住东京',
      source_type: 'user_explicit',
    });

    const mission = '只保留沟通语言和工作公司';

    expect(resolveRetainMissionScope(mission, language)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, organization)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, location)).toBe('out_of_scope');
  });

  it('understands natural background wording for career and residence retention', () => {
    const organization = normalizeManualInput('mission-career-background', {
      content: '我在 OpenAI 工作',
      source_type: 'user_explicit',
    });
    const location = normalizeManualInput('mission-residence-background', {
      content: '我住东京',
      source_type: 'user_explicit',
    });
    const language = normalizeManualInput('mission-background-language-filtered', {
      content: '请用中文回答',
      source_type: 'user_explicit',
    });

    const mission = '只保留职业背景和居住信息';

    expect(resolveRetainMissionScope(mission, organization)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, location)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, language)).toBe('out_of_scope');
  });

  it('understands natural preference wording for answer length and approach style', () => {
    const length = normalizeManualInput('mission-answer-wording-length', {
      content: '请把回答控制在三句话内',
      source_type: 'user_explicit',
    });
    const complexity = normalizeManualInput('mission-answer-wording-complexity', {
      content: '不要复杂方案',
      source_type: 'user_explicit',
    });
    const organization = normalizeManualInput('mission-answer-wording-org-filtered', {
      content: '我在 OpenAI 工作',
      source_type: 'user_explicit',
    });

    const mission = '仅保留答案字数和处理方式';

    expect(resolveRetainMissionScope(mission, length)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, complexity)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, organization)).toBe('out_of_scope');
  });

  it('understands active project wording as task-state retention', () => {
    const task = normalizeManualInput('mission-active-project-task', {
      content: '当前任务是重构 Cortex recall',
      source_type: 'user_explicit',
    });
    const location = normalizeManualInput('mission-active-project-location-filtered', {
      content: '我住东京',
      source_type: 'user_explicit',
    });

    const mission = '只保留正在推进的项目';

    expect(resolveRetainMissionScope(mission, task)).toBe('in_scope');
    expect(resolveRetainMissionScope(mission, location)).toBe('out_of_scope');
  });
});

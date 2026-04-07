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
});

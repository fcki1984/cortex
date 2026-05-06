export const RETAIN_MISSION_PRESETS = [
  '保留长期偏好、稳定背景和持续任务',
  '只保留长期偏好和稳定背景，不保留短期任务',
  '只保留真正长期有复用价值的内容',
] as const;

export function labelRetainMissionPreset(value: string): string {
  if (value === '保留长期偏好、稳定背景和持续任务') {
    return '长期偏好、稳定背景和持续任务';
  }
  if (value === '只保留长期偏好和稳定背景，不保留短期任务') {
    return '长期偏好和稳定背景，不保留短期任务';
  }
  if (value === '只保留真正长期有复用价值的内容') {
    return '仅真正长期复用价值';
  }
  return value;
}

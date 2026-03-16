import type { MemoryCategory } from '../db/queries.js';
import { getCategoryFamily, type MemoryPlacement } from './memory-placement.js';

const TOPIC_STATE_UPDATE_TARGETS = new Set<MemoryCategory>([
  'identity',
  'preference',
  'decision',
  'fact',
  'entity',
  'skill',
  'relationship',
  'goal',
  'project_state',
  'constraint',
  'correction',
]);

const DECISION_STATE_UPDATE_TARGETS = new Set<MemoryCategory>([
  'constraint',
  'preference',
  'decision',
  'fact',
  'goal',
  'project_state',
  'correction',
]);

const CORRECTION_PRIORITY: Partial<Record<MemoryCategory, number>> = {
  constraint: 110,
  decision: 100,
  preference: 95,
  fact: 90,
  project_state: 85,
  goal: 80,
  identity: 75,
  entity: 70,
  skill: 70,
  relationship: 70,
  correction: 10,
};

const DECISION_PRIORITY: Partial<Record<MemoryCategory, number>> = {
  decision: 110,
  constraint: 100,
  preference: 95,
  project_state: 90,
  fact: 85,
  goal: 80,
  correction: 40,
};

const CONSTRAINT_PRIORITY: Partial<Record<MemoryCategory, number>> = {
  constraint: 110,
  decision: 95,
  preference: 90,
  fact: 85,
  project_state: 80,
  goal: 75,
  correction: 35,
};

function isUserTopicPlacement(placement: MemoryPlacement): boolean {
  return placement.owner_type === 'user' && placement.recall_scope === 'topic';
}

export function canCategoriesSmartUpdate(
  existingCategory: MemoryCategory,
  incomingCategory: MemoryCategory,
  placement: MemoryPlacement,
): boolean {
  if (existingCategory === incomingCategory) return true;

  if (getCategoryFamily(existingCategory) === getCategoryFamily(incomingCategory)) {
    return true;
  }

  if (!isUserTopicPlacement(placement)) {
    return false;
  }

  if (incomingCategory === 'correction') {
    return TOPIC_STATE_UPDATE_TARGETS.has(existingCategory);
  }

  if (incomingCategory === 'decision') {
    return DECISION_STATE_UPDATE_TARGETS.has(existingCategory);
  }

  if (incomingCategory === 'constraint') {
    return DECISION_STATE_UPDATE_TARGETS.has(existingCategory);
  }

  return false;
}

export function getUpdateTargetPriority(
  existingCategory: MemoryCategory,
  incomingCategory: MemoryCategory,
  placement: MemoryPlacement,
): number {
  if (!canCategoriesSmartUpdate(existingCategory, incomingCategory, placement)) {
    return -1;
  }

  if (incomingCategory === 'correction') {
    return CORRECTION_PRIORITY[existingCategory] ?? 25;
  }

  if (incomingCategory === 'decision') {
    return DECISION_PRIORITY[existingCategory] ?? 20;
  }

  if (incomingCategory === 'constraint') {
    return CONSTRAINT_PRIORITY[existingCategory] ?? 15;
  }

  return existingCategory === incomingCategory ? 50 : 10;
}

export function resolveSmartUpdateCategory(
  existingCategory: MemoryCategory,
  incomingCategory: MemoryCategory,
): MemoryCategory {
  if (incomingCategory === 'correction' && existingCategory !== 'correction') {
    return existingCategory;
  }

  if (incomingCategory === 'decision' && DECISION_STATE_UPDATE_TARGETS.has(existingCategory)) {
    return existingCategory;
  }

  if (incomingCategory === 'constraint' && DECISION_STATE_UPDATE_TARGETS.has(existingCategory)) {
    return existingCategory;
  }

  return incomingCategory;
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

function labelOrFallback(t: TranslateFn, key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

export function formatRecordKindLabel(t: TranslateFn, kind?: string | null): string {
  if (!kind) return '—';
  return labelOrFallback(t, `terms.recordKinds.${kind}`, kind);
}

export function formatSourceTypeLabel(t: TranslateFn, sourceType?: string | null): string {
  if (!sourceType) return '—';
  return labelOrFallback(t, `terms.sourceTypes.${sourceType}`, sourceType);
}

export function formatNormalizationLabel(t: TranslateFn, normalization?: string | null): string {
  return labelOrFallback(t, `terms.normalization.${normalization || 'durable'}`, normalization || 'durable');
}

export function formatReasonCodeLabel(t: TranslateFn, reasonCode?: string | null): string {
  if (!reasonCode) return '—';
  return labelOrFallback(t, `terms.reasonCodes.${reasonCode}`, reasonCode);
}

export function formatExtractionChannelLabel(t: TranslateFn, channel?: string | null): string {
  if (!channel) return '—';
  return labelOrFallback(t, `terms.extractionChannels.${channel}`, channel);
}

export function formatRecallReasonLabel(t: TranslateFn, reason?: string | null): string {
  if (!reason) return '—';
  return labelOrFallback(t, `terms.recallReasons.${reason}`, reason);
}

export function formatWriteDecisionLabel(t: TranslateFn, decision?: string | null): string {
  if (!decision) return '—';
  return labelOrFallback(t, `terms.writeDecisions.${decision}`, decision);
}

export function formatLifecycleStateLabel(t: TranslateFn, state?: string | null): string {
  if (!state) return '—';
  return labelOrFallback(t, `terms.lifecycleStates.${state}`, state);
}

export function formatRelationCandidateStatusLabel(t: TranslateFn, status?: string | null): string {
  if (!status) return '—';
  return labelOrFallback(t, `terms.relationCandidateStatus.${status}`, status);
}

export function formatComponentStatusLabel(t: TranslateFn, status?: string | null): string {
  if (!status) return '—';
  return labelOrFallback(t, `terms.componentStatus.${status}`, status);
}

export function formatFeedbackKindLabel(t: TranslateFn, feedback?: string | null): string {
  if (!feedback) return '—';
  return labelOrFallback(t, `feedback.${feedback}`, feedback);
}

export function formatCategoryLabel(t: TranslateFn, category?: string | null): string {
  if (!category) return '—';
  return labelOrFallback(t, `memories.categories.${category}`, category);
}

export function formatAgentNameLabel(t: TranslateFn, agentId?: string | null, agentName?: string | null): string {
  if (agentId === 'default' && (!agentName || agentName === 'Default Agent')) {
    return t('agents.builtin.defaultName');
  }
  if (agentId === 'mcp' && (!agentName || agentName === 'MCP Agent')) {
    return t('agents.builtin.mcpName');
  }
  return agentName || agentId || '—';
}

export function formatAgentDescriptionLabel(t: TranslateFn, agentId?: string | null, description?: string | null): string {
  if (!description) return '';
  if (agentId === 'default' && description === 'System default agent using global configuration') {
    return t('agents.builtin.defaultDescription');
  }
  if (agentId === 'mcp' && description === 'Model Context Protocol agent for Claude Desktop / Cursor') {
    return t('agents.builtin.mcpDescription');
  }
  if (description === 'Auto-created from first API request') {
    return t('agents.builtin.autoCreatedDescription');
  }
  return description;
}

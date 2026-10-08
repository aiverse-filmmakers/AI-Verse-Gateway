export const PURPOSE_STRATEGIC_CHANGE_INTENT_VERSION = 'gateway.purpose-strategic-change-intent.v1';
export const PURPOSE_STRATEGIC_CHANGE_PROPOSAL_VERSION = 'gateway.purpose-strategic-change-proposal.v1';
export const PURPOSE_STRATEGIC_CHANGE_MAX_CHARS = 4096;

const HYPOTHETICAL_OR_READ_ONLY = [
  /^\s*(?:what|why|how|which|when|where|who)\b/i,
  /^\s*(?:show|list|explain|summarize|describe|compare|review|tell\s+me)\b/i,
  /^\s*(?:does|do|is|are|was|were|can|could|would|should)\b/i,
  /^\s*what\s+if\b/i,
  /\b(?:hypothetically|as\s+a\s+hypothetical|for\s+discussion\s+only)\b/i,
];

const EDITING_ONLY_SIGNALS = [
  /\b(?:wording|phrasing|copy)\b/i,
  /\b(?:this|the)\s+(?:sentence|paragraph|document|description|message|caption|copy)\b/i,
];

const OPERATION_SIGNALS = Object.freeze([
  Object.freeze({ operation_kind: 'transfer', patterns: [
    /\btransfer\b/i,
    /\bhand\s+over\b/i,
    /\bhand\s+back\b/i,
    /\bmove\s+(?:the\s+)?ownership\b/i,
    /\bmake\b.+\b(?:the\s+)?(?:direction|strategic)\s+owner\b/i,
  ] }),
  Object.freeze({ operation_kind: 'delete', patterns: [
    /\bdelete\b/i,
    /\bremove\b/i,
    /\bdrop\b/i,
    /\bretire\b/i,
    /\babandon\b/i,
    /\bcancel\b/i,
    /\bstop\s+pursuing\b/i,
  ] }),
  Object.freeze({ operation_kind: 'replace', patterns: [
    /\breplace\b/i,
    /\bsupersede\b/i,
    /\bswap\b/i,
  ] }),
  Object.freeze({ operation_kind: 'reorder', patterns: [
    /\breprioriti[sz]e\b/i,
    /\breorder\b/i,
    /\bre-rank\b/i,
    /\brerank\b/i,
    /\bmove\b.+\b(?:ahead\s+of|behind)\b/i,
    /\bmake\b.+\b(?:the\s+)?(?:first|top|highest)\s+priority\b/i,
  ] }),
  Object.freeze({ operation_kind: 'update', patterns: [
    /\bchange\b/i,
    /\bupdate\b/i,
    /\brevise\b/i,
    /\bredefine\b/i,
    /\bshift\b/i,
    /\bpivot\b/i,
    /\bamend\b/i,
  ] }),
  Object.freeze({ operation_kind: 'set', patterns: [
    /\bset\b/i,
    /\badopt\b/i,
    /\bdefine\b/i,
    /\bdeclare\b/i,
    /\bmake\b/i,
    /\bfrom\s+now\s+on\b/i,
    /\b(?:our|my|the)\s+(?:mission|purpose|main\s+goal|primary\s+goal)\s+is\s+now\b/i,
  ] }),
]);

const CHANGE_KIND_SIGNALS = Object.freeze([
  Object.freeze({ change_kind: 'direction_owner_transfer', patterns: [
    /\bdirection\s+owner\b/i,
    /\bstrategic\s+owner\b/i,
    /\bownership\s+of\s+(?:the\s+)?(?:strategic\s+)?direction\b/i,
    /\bownership\s+of\s+(?:the\s+)?strategy\b/i,
  ], allowed_operations: new Set(['transfer', 'set', 'update']) }),
  Object.freeze({ change_kind: 'priority_ordering', patterns: [
    /\bpriority\s+ordering\b/i,
    /\bpriorities\b/i,
    /\bprioriti[sz]ation\b/i,
    /\bprioriti[sz]e\b/i,
    /\btop\s+priority\b/i,
  ], allowed_operations: new Set(['reorder', 'update', 'set', 'replace']) }),
  Object.freeze({ change_kind: 'mission_purpose', patterns: [
    /\bmission\b/i,
    /\bpurpose\b/i,
  ], allowed_operations: new Set(['set', 'update', 'replace', 'delete']) }),
  Object.freeze({ change_kind: 'top_level_goal', patterns: [
    /\btop[- ]level\s+goal\b/i,
    /\bprimary\s+goal\b/i,
    /\bmain\s+goal\b/i,
    /\bnorth\s+star\b/i,
    /\b(?:our|my|the)\s+goal\b/i,
  ], allowed_operations: new Set(['set', 'update', 'replace', 'delete']) }),
  Object.freeze({ change_kind: 'values', patterns: [
    /\b(?:our|my|company|team|core)\s+values?\b/i,
    /\bcore\s+principles?\b/i,
  ], allowed_operations: new Set(['set', 'update', 'replace', 'delete']) }),
  Object.freeze({ change_kind: 'strategic_constraint', patterns: [
    /\bstrategic\s+constraints?\b/i,
    /\bnon[- ]negotiable\s+constraints?\b/i,
    /\b(?:our|my|the)\s+strategic\s+rules?\b/i,
  ], allowed_operations: new Set(['set', 'update', 'replace', 'delete']) }),
  Object.freeze({ change_kind: 'durable_strategic_intent', patterns: [
    /\bstrategic\s+intent\b/i,
    /\bdurable\s+strategy\b/i,
    /\blong[- ]term\s+strategy\b/i,
    /\b(?:our|my|the)\s+strategy\b/i,
    /\bstrategic\s+direction\b/i,
  ], allowed_operations: new Set(['replace', 'delete', 'update']) }),
]);

function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text.trim().replace(/\s+/g, ' ').slice(0, PURPOSE_STRATEGIC_CHANGE_MAX_CHARS);
}

function firstOperation(text) {
  for (const signal of OPERATION_SIGNALS) {
    if (signal.patterns.some((pattern) => pattern.test(text))) return signal.operation_kind;
  }
  return null;
}

function firstChangeKind(text, operationKind) {
  if (!operationKind) return null;
  for (const signal of CHANGE_KIND_SIGNALS) {
    if (!signal.allowed_operations.has(operationKind)) continue;
    if (signal.patterns.some((pattern) => pattern.test(text))) return signal.change_kind;
  }
  return null;
}

function looksReadOnly(text) {
  return HYPOTHETICAL_OR_READ_ONLY.some((pattern) => pattern.test(text))
    || EDITING_ONLY_SIGNALS.some((pattern) => pattern.test(text));
}

function normalizeStrategicScope(scope) {
  if (scope === 'operator') return scope;
  if (typeof scope !== 'string' || !scope.startsWith('workspace:')) {
    throw new TypeError('scope must be operator or workspace:<id>');
  }
  const workspaceId = scope.slice('workspace:'.length);
  if (workspaceId.length < 1 || workspaceId.length > 128 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(workspaceId)) {
    throw new TypeError('workspace scope id must be lowercase alphanumeric/hyphen and at most 128 characters');
  }
  return `workspace:${workspaceId}`;
}

export function classifyStrategicChangeIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return Object.freeze({
      api_version: PURPOSE_STRATEGIC_CHANGE_INTENT_VERSION,
      strategic_change: false,
      high_impact: false,
      change_kind: null,
      operation_kind: null,
      requires_explicit_confirmation: false,
      reason: 'empty_or_non_text_intent',
      normalized_text: normalized,
    });
  }

  const operationKind = firstOperation(normalized);
  const changeKind = firstChangeKind(normalized, operationKind);
  if (!operationKind || !changeKind) {
    return Object.freeze({
      api_version: PURPOSE_STRATEGIC_CHANGE_INTENT_VERSION,
      strategic_change: false,
      high_impact: false,
      change_kind: null,
      operation_kind: operationKind,
      requires_explicit_confirmation: false,
      reason: 'no_high_impact_strategic_change_signal',
      normalized_text: normalized,
    });
  }

  if (looksReadOnly(normalized)) {
    return Object.freeze({
      api_version: PURPOSE_STRATEGIC_CHANGE_INTENT_VERSION,
      strategic_change: false,
      high_impact: false,
      change_kind: null,
      operation_kind: operationKind,
      requires_explicit_confirmation: false,
      reason: 'read_only_or_hypothetical_strategic_discussion',
      normalized_text: normalized,
    });
  }

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_CHANGE_INTENT_VERSION,
    strategic_change: true,
    high_impact: true,
    change_kind: changeKind,
    operation_kind: operationKind,
    requires_explicit_confirmation: true,
    reason: 'durable_high_impact_strategic_change_signal',
    normalized_text: normalized,
  });
}

export function proposeStrategicOwnerMutation({ text, scope } = {}) {
  const normalizedScope = normalizeStrategicScope(scope);
  const intent = classifyStrategicChangeIntent(text);

  if (!intent.strategic_change) {
    return Object.freeze({
      api_version: PURPOSE_STRATEGIC_CHANGE_PROPOSAL_VERSION,
      state: 'not_proposed',
      scope: normalizedScope,
      intent,
      proposal: null,
    });
  }

  const proposal = Object.freeze({
    api_version: PURPOSE_STRATEGIC_CHANGE_PROPOSAL_VERSION,
    state: 'proposed',
    scope: normalizedScope,
    change_kind: intent.change_kind,
    operation_kind: intent.operation_kind,
    requested_change: intent.normalized_text,
    target_surface: 'canonical_strategic_direction',
    target_owner: null,
    routing_state: 'unresolved_until_current_direction_owner_read',
    requires_explicit_confirmation: true,
    confirmation_state: 'required_not_confirmed',
    apply_allowed: false,
    mutation_executed: false,
  });

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_CHANGE_PROPOSAL_VERSION,
    state: 'proposed',
    scope: normalizedScope,
    intent,
    proposal,
  });
}

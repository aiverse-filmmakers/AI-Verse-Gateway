export const PURPOSE_VALUE_GATE_VERSION = 'gateway.purpose-value-gate.v1';

export const PURPOSE_VALUE_GATE_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'operator-rationale',
    scope: 'operator',
    kind: 'strategic',
    prompt: 'why are we doing this?',
    comparison: 'with_without_purpose',
    quality_dimensions: Object.freeze(['less_repeated_explanation', 'better_explainability', 'continuity']),
  }),
  Object.freeze({
    id: 'workspace-next-action',
    scope: 'workspace:alpha',
    kind: 'strategic',
    prompt: 'what should I work on next?',
    comparison: 'with_without_purpose',
    quality_dimensions: Object.freeze(['better_next_action', 'blocker_awareness', 'continuity']),
  }),
  Object.freeze({
    id: 'workspace-prioritization',
    scope: 'workspace:alpha',
    kind: 'strategic',
    prompt: 'which project should take priority?',
    comparison: 'with_without_purpose',
    quality_dimensions: Object.freeze(['better_prioritization', 'goal_alignment', 'constraint_awareness']),
  }),
  Object.freeze({
    id: 'workspace-blocker',
    scope: 'workspace:alpha',
    kind: 'strategic',
    prompt: 'what is blocking this goal?',
    comparison: 'with_without_purpose',
    quality_dimensions: Object.freeze(['blocker_awareness', 'strategy_validity', 'material_change_awareness']),
  }),
  Object.freeze({
    id: 'workspace-trivial',
    scope: 'workspace:alpha',
    kind: 'irrelevant',
    prompt: 'Format this JSON.',
    comparison: 'purpose_should_not_load',
    quality_dimensions: Object.freeze(['no_irrelevant_regression']),
  }),
  Object.freeze({
    id: 'workspace-owner-unavailable',
    scope: 'workspace:alpha',
    kind: 'availability',
    prompt: 'what should I work on next?',
    comparison: 'purpose_unavailable',
    quality_dimensions: Object.freeze(['ordinary_execution_continues', 'no_stale_substitution']),
  }),
]);

export const PURPOSE_VALUE_REQUIRED_MEASUREMENTS = Object.freeze([
  'purpose_owner_read_count',
  'purpose_envelope_bytes',
  'touched_scopes',
  'trivial_task_loaded_purpose',
  'completed_when_purpose_unavailable',
  'latency_delta_ms',
  'cost_delta',
  'decision_quality_delta',
  'output_difference',
  'context_noise_delta',
  'workspace_isolation_regression',
  'authority_regression',
]);

export function validatePurposeValueMeasurement(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Purpose value measurement must be an object');
  }
  for (const key of PURPOSE_VALUE_REQUIRED_MEASUREMENTS) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`Purpose value measurement is missing ${key}`);
    }
  }
  if (!Array.isArray(record.touched_scopes)) {
    throw new TypeError('Purpose value measurement touched_scopes must be an array');
  }
  if (!Number.isInteger(record.purpose_owner_read_count) || record.purpose_owner_read_count < 0) {
    throw new TypeError('Purpose value measurement purpose_owner_read_count must be a non-negative integer');
  }
  if (!Number.isInteger(record.purpose_envelope_bytes) || record.purpose_envelope_bytes < 0) {
    throw new TypeError('Purpose value measurement purpose_envelope_bytes must be a non-negative integer');
  }
  return Object.freeze({ api_version: PURPOSE_VALUE_GATE_VERSION, valid: true });
}

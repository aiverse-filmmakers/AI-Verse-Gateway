import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PURPOSE_VALUE_GATE_SCENARIOS,
  PURPOSE_VALUE_GATE_VERSION,
  PURPOSE_VALUE_REQUIRED_MEASUREMENTS,
  validatePurposeValueMeasurement,
} from '../src/purpose-value-gate.mjs';

test('freezes representative operator/workspace value-gate scenarios', () => {
  assert.equal(PURPOSE_VALUE_GATE_VERSION, 'gateway.purpose-value-gate.v1');
  const ids = PURPOSE_VALUE_GATE_SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual(ids, [
    'operator-rationale',
    'workspace-next-action',
    'workspace-prioritization',
    'workspace-blocker',
    'workspace-trivial',
    'workspace-owner-unavailable',
  ]);
  assert.ok(PURPOSE_VALUE_GATE_SCENARIOS.some((scenario) => scenario.scope === 'operator'));
  assert.ok(PURPOSE_VALUE_GATE_SCENARIOS.some((scenario) => scenario.scope.startsWith('workspace:')));
  assert.ok(PURPOSE_VALUE_GATE_SCENARIOS.some((scenario) => scenario.comparison === 'with_without_purpose'));
  assert.ok(PURPOSE_VALUE_GATE_SCENARIOS.some((scenario) => scenario.comparison === 'purpose_should_not_load'));
  assert.ok(PURPOSE_VALUE_GATE_SCENARIOS.some((scenario) => scenario.comparison === 'purpose_unavailable'));
});

test('freezes every mandatory anti-bloat and value measurement field', () => {
  assert.deepEqual([...PURPOSE_VALUE_REQUIRED_MEASUREMENTS], [
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
});

test('measurement contract requires complete evidence instead of cherry-picked metrics', () => {
  const record = {
    purpose_owner_read_count: 1,
    purpose_envelope_bytes: 2048,
    touched_scopes: ['workspace:alpha'],
    trivial_task_loaded_purpose: false,
    completed_when_purpose_unavailable: true,
    latency_delta_ms: null,
    cost_delta: null,
    decision_quality_delta: null,
    output_difference: null,
    context_noise_delta: null,
    workspace_isolation_regression: false,
    authority_regression: false,
  };
  assert.deepEqual(validatePurposeValueMeasurement(record), {
    api_version: PURPOSE_VALUE_GATE_VERSION,
    valid: true,
  });

  const incomplete = { ...record };
  delete incomplete.purpose_owner_read_count;
  assert.throws(() => validatePurposeValueMeasurement(incomplete), /missing purpose_owner_read_count/);
});

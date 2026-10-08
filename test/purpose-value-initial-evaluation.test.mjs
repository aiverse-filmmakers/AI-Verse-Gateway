import assert from 'node:assert/strict';
import test from 'node:test';

import { runInitialPurposeValueEvaluation } from '../benchmarks/purpose-value-initial.mjs';
import { validatePurposeValueMeasurement } from '../src/purpose-value-gate.mjs';

const STRATEGIC_IDS = [
  'operator-rationale',
  'workspace-next-action',
  'workspace-prioritization',
  'workspace-blocker',
];

test('initial Purpose value evaluation records complete same-state context-level evidence', async () => {
  const evidence = await runInitialPurposeValueEvaluation();
  assert.equal(evidence.schema_version, '1.0');
  assert.equal(evidence.evaluation, 'purpose-value-initial');
  assert.equal(evidence.comparison_level, 'runtime_context');
  assert.equal(evidence.gate_outcome_recorded, false);
  assert.equal(evidence.results.length, 6);

  for (const result of evidence.results) {
    assert.equal(validatePurposeValueMeasurement(result).valid, true, result.scenario_id);
    assert.deepEqual(result.touched_scopes, [result.scope], result.scenario_id);
    assert.equal(result.workspace_isolation_regression, false, result.scenario_id);
    assert.equal(result.authority_regression, false, result.scenario_id);
  }
});

test('initial strategic comparisons gain explicit owner-backed decision basis with Purpose', async () => {
  const evidence = await runInitialPurposeValueEvaluation();
  const byId = new Map(evidence.results.map((result) => [result.scenario_id, result]));

  for (const id of STRATEGIC_IDS) {
    const result = byId.get(id);
    assert.ok(result, id);
    assert.equal(result.purpose_owner_read_count, 1, id);
    assert.ok(result.purpose_envelope_bytes > 0, id);
    assert.ok(result.purpose_envelope_bytes <= 16384, id);
    assert.ok(result.evidence_score_with_purpose > result.evidence_score_without_purpose, id);
    assert.ok(result.decision_quality_delta > 0, id);
    assert.equal(result.output_difference.model_output_measured, false, id);
    assert.equal(result.output_difference.decision_basis_changed, true, id);
    assert.equal(result.absent_arm_state, 'unavailable', id);
    assert.equal(result.latency_delta_ms, null, id);
    assert.equal(result.cost_delta, null, id);
  }

  assert.ok(byId.get('workspace-next-action').decision_quality_delta > 0);
  assert.ok(byId.get('workspace-prioritization').decision_quality_delta > 0);
});

test('initial anti-bloat evidence proves trivial zero-read and unavailable-owner continuity', async () => {
  const evidence = await runInitialPurposeValueEvaluation();
  const byId = new Map(evidence.results.map((result) => [result.scenario_id, result]));

  const trivial = byId.get('workspace-trivial');
  assert.equal(trivial.purpose_owner_read_count, 0);
  assert.equal(trivial.purpose_envelope_bytes, 0);
  assert.equal(trivial.trivial_task_loaded_purpose, false);
  assert.equal(trivial.context_noise_delta.purpose_bytes_added, 0);

  const unavailable = byId.get('workspace-owner-unavailable');
  assert.equal(unavailable.purpose_owner_read_count, 1);
  assert.equal(unavailable.purpose_envelope_bytes, 0);
  assert.equal(unavailable.completed_when_purpose_unavailable, true);
  assert.equal(unavailable.unavailable_state, 'unavailable');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { runCompletePurposeValueEvaluation } from '../benchmarks/purpose-value-complete.mjs';
import { validatePurposeValueMeasurement } from '../src/purpose-value-gate.mjs';

const STRATEGIC_IDS = [
  'operator-rationale',
  'workspace-next-action',
  'workspace-prioritization',
  'workspace-blocker',
];

test('complete Purpose value evaluation fills the remaining Task 3 evidence without inventing provider metrics', async () => {
  const evidence = await runCompletePurposeValueEvaluation();
  assert.equal(evidence.schema_version, '1.0');
  assert.equal(evidence.evaluation, 'purpose-value-complete-task-3');
  assert.equal(evidence.gate_outcome_recorded, false);
  assert.equal(evidence.results.length, 6);
  assert.equal(evidence.model_output_measured, false);
  assert.equal(evidence.production_provider_latency_measured, false);
  assert.equal(evidence.production_provider_cost_measured, false);
  assert.ok(evidence.max_purpose_envelope_bytes > 0);
  assert.ok(evidence.max_purpose_envelope_bytes <= 16384);
  assert.ok(Number.isFinite(evidence.max_abs_local_fixture_latency_delta_ms));

  for (const result of evidence.results) {
    assert.equal(validatePurposeValueMeasurement(result).valid, true, result.scenario_id);
    assert.deepEqual(result.touched_scopes, [result.scope], result.scenario_id);
    assert.equal(result.workspace_isolation_regression, false, result.scenario_id);
    assert.equal(result.authority_regression, false, result.scenario_id);
  }
});

test('all four strategic scenarios retain positive owner-backed decision value and stable cross-session Purpose', async () => {
  const evidence = await runCompletePurposeValueEvaluation();
  const byId = new Map(evidence.results.map((result) => [result.scenario_id, result]));

  for (const id of STRATEGIC_IDS) {
    const result = byId.get(id);
    assert.ok(result, id);
    assert.equal(result.purpose_owner_read_count, 1, id);
    assert.ok(result.purpose_envelope_bytes > 0, id);
    assert.ok(result.purpose_envelope_bytes <= 16384, id);
    assert.ok(result.decision_quality_delta > 0, id);
    assert.ok(result.repeated_explanation_facts_saved > 0, id);
    assert.equal(result.continuity_across_sessions, true, id);
    assert.equal(result.context_noise_delta.unrelated_scope_ref_count, 0, id);
    assert.equal(result.context_noise_delta.unrelated_scope_bytes, 0, id);
    assert.equal(result.context_noise_delta.bounded_by_phase_7_budget, true, id);
    assert.ok(Number.isFinite(result.latency_delta_ms), id);
    assert.equal(result.cost_delta, null, id);
    assert.equal(result.cost_measurement.measured, false, id);
    assert.equal(result.output_difference.model_output_measured, false, id);
    assert.equal(result.output_difference.decision_basis_changed, true, id);
  }

  assert.ok(byId.get('workspace-next-action').decision_quality_delta > 0);
  assert.ok(byId.get('workspace-prioritization').decision_quality_delta > 0);
});

test('complete Task 3 proof set preserves anti-bloat, fallback, isolation, and authority laws', async () => {
  const evidence = await runCompletePurposeValueEvaluation();
  const byId = new Map(evidence.results.map((result) => [result.scenario_id, result]));
  const proofs = evidence.proofs;

  assert.equal(proofs.less_repeated_explanation, true);
  assert.equal(proofs.better_next_action, true);
  assert.equal(proofs.better_prioritization, true);
  assert.equal(proofs.blocker_awareness, true);
  assert.equal(proofs.explainability, true);
  assert.equal(proofs.continuity_across_sessions, true);
  assert.equal(proofs.irrelevant_work_zero_purpose_reads, true);
  assert.equal(proofs.token_size_overhead_bounded, true);
  assert.equal(proofs.owner_read_overhead_bounded, true);
  assert.equal(proofs.local_fixture_latency_measured, true);
  assert.equal(proofs.provider_cost_measurable, false);
  assert.equal(proofs.context_noise_scope_clean, true);
  assert.equal(proofs.purpose_unavailable_preserves_execution, true);
  assert.equal(proofs.no_isolation_regression, true);
  assert.equal(proofs.no_authority_regression, true);

  const trivial = byId.get('workspace-trivial');
  assert.equal(trivial.purpose_owner_read_count, 0);
  assert.equal(trivial.purpose_envelope_bytes, 0);
  assert.equal(trivial.trivial_task_loaded_purpose, false);

  const unavailable = byId.get('workspace-owner-unavailable');
  assert.equal(unavailable.purpose_owner_read_count, 1);
  assert.equal(unavailable.purpose_envelope_bytes, 0);
  assert.equal(unavailable.completed_when_purpose_unavailable, true);
  assert.equal(unavailable.unavailable_state, 'unavailable');
});

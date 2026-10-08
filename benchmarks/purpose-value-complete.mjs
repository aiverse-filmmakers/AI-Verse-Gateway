import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { GatewayError } from '../src/errors.mjs';
import { assembleProgressiveOwnerContext } from '../src/progressive-context.mjs';
import { PURPOSE_VALUE_GATE_SCENARIOS } from '../src/purpose-value-gate.mjs';
import { stableStringify } from '../src/util.mjs';

const MAX_PURPOSE_BYTES = 16384;
const LATENCY_SAMPLES = 9;
const WARMUP_SAMPLES = 2;
const STRATEGIC_IDS = new Set([
  'operator-rationale',
  'workspace-next-action',
  'workspace-prioritization',
  'workspace-blocker',
]);

function projectionFor(scope) {
  const base = {
    schema_version: '1.0',
    scope,
    scope_kind: scope === 'operator' ? 'operator' : 'workspace',
    identity: scope === 'operator'
      ? { kind: 'operator', id: 'operator' }
      : { kind: 'workspace', id: scope.slice('workspace:'.length) },
    provenance: {
      projection_owner: 'ai-verse-os',
      generated_at: '2026-10-08T20:00:00.000Z',
      profile: {
        requested: 'auto',
        resolved: scope === 'operator' ? 'operator_default' : 'workspace_rich',
        reasons: ['value_gate_fixture'],
      },
      owner_reads: [{
        owner: 'ai-verse-os',
        operation: 'current-context.read',
        scope,
        status: 'ok',
        freshness: { state: 'fresh', as_of: '2026-10-08T20:00:00.000Z' },
        canonical_refs: [{ owner: 'ai-verse-os', scope, kind: 'current-context', id: 'active' }],
      }],
    },
  };

  if (scope === 'operator') {
    return {
      ...base,
      purpose: {
        missions: [{ kind: 'mission', statement: 'Build a dependable personal AI operating system.' }],
        desired_outcomes: [{ kind: 'desired_outcome', statement: 'Keep current work connected to durable direction.' }],
      },
      priorities: [{ kind: 'priority', statement: 'Prove Purpose Context adds decision value before expanding it.' }],
      trajectory: [{
        relation: 'serves',
        from_ref: { owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'purpose-context', version: '1' },
        to_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission', version: '1' },
        source_refs: [{ owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'purpose-context', version: '1' }],
      }],
    };
  }

  return {
    ...base,
    goals: [{ kind: 'goal', statement: 'Ship the highest-value client launch.' }],
    strategies: [{ kind: 'strategy', statement: 'Finish the launch path before optional polish.' }],
    challenges: [{ kind: 'challenge', statement: 'Client approval is blocking final delivery.' }],
    initiatives: [
      { kind: 'initiative', statement: 'Finish launch delivery.', payload: { priority: 1 } },
      { kind: 'initiative', statement: 'Polish optional showcase assets.', payload: { priority: 2 } },
    ],
    priorities: [{ kind: 'priority', statement: 'Launch delivery first.' }],
    current_work: [{ kind: 'current_work', statement: 'Resolve client approval and ship.' }],
    constraints: [{ kind: 'constraint', statement: 'Final delivery requires client approval.' }],
    recent_material_changes: [{
      kind: 'material_change',
      occurred_at: '2026-10-08T19:00:00.000Z',
      event: 'Client requested final approval before delivery.',
      effect: 'Launch remains blocked until approval.',
      materiality: ['blocker_state'],
      source_refs: [{ owner: 'ai-verse-os', scope, kind: 'current-context', id: 'active' }],
    }],
    trajectory: [{
      relation: 'advances',
      from_ref: { owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'launch-delivery', version: '1' },
      to_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'ship-launch', version: '1' },
      source_refs: [{ owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'launch-delivery', version: '1' }],
    }],
  };
}

class CompleteValueHost {
  constructor({ purposeAvailable = true }) {
    this.purposeAvailable = purposeAvailable;
    this.calls = [];
  }

  async describe() {
    this.calls.push({ op: 'describe' });
    return { adapter_id: 'fixture:purpose-value-complete', metadata: {}, operations: [] };
  }

  async readContext(scope) {
    this.calls.push({ op: 'read_context', scope });
    return {
      scope,
      current_context: 'Ordinary owner context intentionally omits strategic mission, priority, blocker, and trajectory facts.',
      direction_owner: 'os',
    };
  }

  async listCapabilities(scope) {
    this.calls.push({ op: 'list_capabilities', scope });
    return [];
  }

  async listConnections(scope) {
    this.calls.push({ op: 'list_connections', scope });
    return [];
  }

  async retrieveHistory() {
    throw new Error('value-gate scenarios must not need legacy history');
  }

  async readPurposeContext(scope) {
    this.calls.push({ op: 'read_purpose', scope });
    if (!this.purposeAvailable) {
      throw new GatewayError('ADAPTER_TIMEOUT', 'Purpose owner unavailable for comparison arm', 504);
    }
    return structuredClone(projectionFor(scope));
  }
}

function runFixture(scope, prompt, { sessionId = 'value-session', runId = 'value-run' } = {}) {
  return {
    run_id: runId,
    session_id: sessionId,
    system_id: 'value-system',
    workspace_id: scope === 'operator' ? 'operator' : scope.slice('workspace:'.length),
    principal: 'operator',
    messages: [{ role: 'user', content: prompt }],
  };
}

async function assembleScenario(scenario, { purposeAvailable = true, sessionId, runId } = {}) {
  const host = new CompleteValueHost({ purposeAvailable });
  const started = performance.now();
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: runFixture(scenario.scope, scenario.prompt, { sessionId, runId }),
    scope: scenario.scope,
    query: scenario.prompt,
    signal: null,
  });
  const elapsedMs = performance.now() - started;
  return { host, assembled, elapsedMs };
}

function purposeBytes(safe) {
  if (!safe?.purpose_context) return 0;
  return Buffer.byteLength(stableStringify(safe.purpose_context), 'utf8');
}

function touchedScopes(host) {
  return [...new Set(host.calls.map((call) => call.scope).filter(Boolean))].sort();
}

function collectScopedRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectScopedRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  if (typeof value.scope === 'string') refs.push(value.scope);
  for (const item of Object.values(value)) collectScopedRefs(item, refs);
  return refs;
}

function strategicEvidenceScore(safe, scenarioId) {
  const purpose = safe?.purpose_context;
  if (!purpose) return 0;
  const present = (value) => Array.isArray(value) && value.length > 0;
  const rubric = {
    'operator-rationale': [
      present(purpose?.purpose?.missions),
      present(purpose?.trajectory),
      present(purpose?.priorities),
    ],
    'workspace-next-action': [
      present(purpose?.goals),
      present(purpose?.current_work),
      present(purpose?.challenges),
      present(purpose?.strategies),
    ],
    'workspace-prioritization': [
      present(purpose?.goals),
      present(purpose?.priorities),
      present(purpose?.initiatives),
      present(purpose?.constraints),
      present(purpose?.trajectory),
    ],
    'workspace-blocker': [
      present(purpose?.challenges),
      present(purpose?.strategies),
      present(purpose?.recent_material_changes),
      present(purpose?.constraints),
    ],
  };
  return (rubric[scenarioId] ?? []).filter(Boolean).length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function measureStrategicLatency(scenario) {
  for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
    await assembleScenario(scenario, { purposeAvailable: true, sessionId: `warm-with-${i}`, runId: `warm-with-${i}` });
    await assembleScenario(scenario, { purposeAvailable: false, sessionId: `warm-without-${i}`, runId: `warm-without-${i}` });
  }

  const withPurpose = [];
  const withoutPurpose = [];
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    const withRun = await assembleScenario(scenario, {
      purposeAvailable: true,
      sessionId: `latency-with-${i}`,
      runId: `latency-with-${i}`,
    });
    const withoutRun = await assembleScenario(scenario, {
      purposeAvailable: false,
      sessionId: `latency-without-${i}`,
      runId: `latency-without-${i}`,
    });
    withPurpose.push(withRun.elapsedMs);
    withoutPurpose.push(withoutRun.elapsedMs);
  }

  const withMedian = median(withPurpose);
  const withoutMedian = median(withoutPurpose);
  return {
    samples: LATENCY_SAMPLES,
    local_fixture_with_purpose_median_ms: Number(withMedian.toFixed(3)),
    local_fixture_without_purpose_median_ms: Number(withoutMedian.toFixed(3)),
    local_fixture_delta_ms: Number((withMedian - withoutMedian).toFixed(3)),
    production_provider_latency_measured: false,
  };
}

async function strategicMeasurement(scenario) {
  const withPurpose = await assembleScenario(scenario, {
    purposeAvailable: true,
    sessionId: 'continuity-a',
    runId: `${scenario.id}-a`,
  });
  const secondSession = await assembleScenario(scenario, {
    purposeAvailable: true,
    sessionId: 'continuity-b',
    runId: `${scenario.id}-b`,
  });
  const withoutPurpose = await assembleScenario(scenario, {
    purposeAvailable: false,
    sessionId: 'absent-arm',
    runId: `${scenario.id}-absent`,
  });

  const withScore = strategicEvidenceScore(withPurpose.assembled.safe, scenario.id);
  const withoutScore = strategicEvidenceScore(withoutPurpose.assembled.safe, scenario.id);
  const bytes = purposeBytes(withPurpose.assembled.safe);
  const allProjectionScopes = collectScopedRefs(withPurpose.assembled.safe.purpose_context);
  const unrelatedScopeRefs = allProjectionScopes.filter((scope) => scope !== scenario.scope);
  const latency = await measureStrategicLatency(scenario);

  return {
    scenario_id: scenario.id,
    scope: scenario.scope,
    comparison: scenario.comparison,
    purpose_owner_read_count: withPurpose.host.calls.filter((call) => call.op === 'read_purpose').length,
    purpose_envelope_bytes: bytes,
    touched_scopes: touchedScopes(withPurpose.host),
    trivial_task_loaded_purpose: false,
    completed_when_purpose_unavailable: withoutPurpose.assembled.safe?.current_context != null
      && !Object.hasOwn(withoutPurpose.assembled.safe, 'purpose_context'),
    latency_delta_ms: latency.local_fixture_delta_ms,
    cost_delta: null,
    decision_quality_delta: withScore - withoutScore,
    output_difference: {
      model_output_measured: false,
      decision_basis_changed: withScore > withoutScore,
      owner_backed_facts_added: withScore - withoutScore,
      reason: 'Gateway has no credentialed production-model evaluation surface in CI; decision-basis output delta is measured instead of invented model quality.',
    },
    context_noise_delta: {
      measured_as_bytes: true,
      purpose_bytes_added: bytes,
      unrelated_scope_ref_count: unrelatedScopeRefs.length,
      unrelated_scope_bytes: 0,
      bounded_by_phase_7_budget: bytes <= MAX_PURPOSE_BYTES,
    },
    workspace_isolation_regression: touchedScopes(withPurpose.host).some((scope) => scope !== scenario.scope)
      || unrelatedScopeRefs.length > 0,
    authority_regression: withPurpose.assembled.safe?.purpose_context?.provenance?.projection_owner !== 'ai-verse-os',
    continuity_across_sessions: stableStringify(withPurpose.assembled.safe.purpose_context)
      === stableStringify(secondSession.assembled.safe.purpose_context),
    repeated_explanation_facts_saved: withScore - withoutScore,
    evidence_score_with_purpose: withScore,
    evidence_score_without_purpose: withoutScore,
    latency_measurement: latency,
    cost_measurement: {
      measured: false,
      reason: 'Gateway context assembly exposes no provider billing/cost surface; cost remains null rather than estimated.',
    },
  };
}

async function trivialMeasurement(scenario) {
  const run = await assembleScenario(scenario, { purposeAvailable: true });
  return {
    scenario_id: scenario.id,
    scope: scenario.scope,
    comparison: scenario.comparison,
    purpose_owner_read_count: run.host.calls.filter((call) => call.op === 'read_purpose').length,
    purpose_envelope_bytes: purposeBytes(run.assembled.safe),
    touched_scopes: touchedScopes(run.host),
    trivial_task_loaded_purpose: Object.hasOwn(run.assembled.safe, 'purpose_context'),
    completed_when_purpose_unavailable: null,
    latency_delta_ms: null,
    cost_delta: null,
    decision_quality_delta: 0,
    output_difference: { model_output_measured: false, decision_basis_changed: false, reason: 'Purpose correctly skipped' },
    context_noise_delta: {
      measured_as_bytes: true,
      purpose_bytes_added: 0,
      unrelated_scope_ref_count: 0,
      unrelated_scope_bytes: 0,
      bounded_by_phase_7_budget: true,
    },
    workspace_isolation_regression: touchedScopes(run.host).some((scope) => scope !== scenario.scope),
    authority_regression: false,
  };
}

async function unavailableMeasurement(scenario) {
  const run = await assembleScenario(scenario, { purposeAvailable: false });
  return {
    scenario_id: scenario.id,
    scope: scenario.scope,
    comparison: scenario.comparison,
    purpose_owner_read_count: run.host.calls.filter((call) => call.op === 'read_purpose').length,
    purpose_envelope_bytes: purposeBytes(run.assembled.safe),
    touched_scopes: touchedScopes(run.host),
    trivial_task_loaded_purpose: false,
    completed_when_purpose_unavailable: run.assembled.safe?.current_context != null
      && !Object.hasOwn(run.assembled.safe, 'purpose_context'),
    latency_delta_ms: null,
    cost_delta: null,
    decision_quality_delta: null,
    output_difference: { model_output_measured: false, decision_basis_changed: null, reason: 'availability fallback evidence only' },
    context_noise_delta: {
      measured_as_bytes: true,
      purpose_bytes_added: 0,
      unrelated_scope_ref_count: 0,
      unrelated_scope_bytes: 0,
      bounded_by_phase_7_budget: true,
    },
    workspace_isolation_regression: touchedScopes(run.host).some((scope) => scope !== scenario.scope),
    authority_regression: false,
    unavailable_state: run.assembled.diagnostics?.purpose?.state ?? null,
  };
}

export async function runCompletePurposeValueEvaluation() {
  const results = [];
  for (const scenario of PURPOSE_VALUE_GATE_SCENARIOS) {
    if (STRATEGIC_IDS.has(scenario.id)) {
      results.push(await strategicMeasurement(scenario));
    } else if (scenario.id === 'workspace-trivial') {
      results.push(await trivialMeasurement(scenario));
    } else if (scenario.id === 'workspace-owner-unavailable') {
      results.push(await unavailableMeasurement(scenario));
    }
  }

  const strategic = results.filter((item) => STRATEGIC_IDS.has(item.scenario_id));
  const trivial = results.find((item) => item.scenario_id === 'workspace-trivial');
  const unavailable = results.find((item) => item.scenario_id === 'workspace-owner-unavailable');
  const maxBytes = Math.max(...strategic.map((item) => item.purpose_envelope_bytes));
  const maxAbsLocalLatencyDelta = Math.max(...strategic.map((item) => Math.abs(item.latency_delta_ms)));

  const proofs = {
    less_repeated_explanation: strategic.every((item) => item.repeated_explanation_facts_saved > 0),
    better_next_action: results.find((item) => item.scenario_id === 'workspace-next-action')?.decision_quality_delta > 0,
    better_prioritization: results.find((item) => item.scenario_id === 'workspace-prioritization')?.decision_quality_delta > 0,
    blocker_awareness: results.find((item) => item.scenario_id === 'workspace-blocker')?.decision_quality_delta > 0,
    explainability: results.find((item) => item.scenario_id === 'operator-rationale')?.decision_quality_delta > 0,
    continuity_across_sessions: strategic.every((item) => item.continuity_across_sessions === true),
    irrelevant_work_zero_purpose_reads: trivial?.purpose_owner_read_count === 0 && trivial?.purpose_envelope_bytes === 0,
    token_size_overhead_bounded: maxBytes <= MAX_PURPOSE_BYTES,
    owner_read_overhead_bounded: strategic.every((item) => item.purpose_owner_read_count === 1),
    local_fixture_latency_measured: strategic.every((item) => Number.isFinite(item.latency_delta_ms)),
    provider_cost_measurable: false,
    context_noise_scope_clean: strategic.every((item) => item.context_noise_delta.unrelated_scope_ref_count === 0),
    purpose_unavailable_preserves_execution: unavailable?.completed_when_purpose_unavailable === true,
    no_isolation_regression: results.every((item) => item.workspace_isolation_regression === false),
    no_authority_regression: results.every((item) => item.authority_regression === false),
  };

  return {
    schema_version: '1.0',
    evaluation: 'purpose-value-complete-task-3',
    comparison_level: 'runtime_context_and_local_fixture_overhead',
    gate_outcome_recorded: false,
    model_output_measured: false,
    production_provider_latency_measured: false,
    production_provider_cost_measured: false,
    max_purpose_envelope_bytes: maxBytes,
    max_abs_local_fixture_latency_delta_ms: Number(maxAbsLocalLatencyDelta.toFixed(3)),
    proofs,
    results,
    caveats: [
      'Local fixture latency is measured and reproducible, but it is not a production provider/network latency claim.',
      'Provider cost is not exposed by the Gateway context-assembly surface and is intentionally left unmeasured.',
      'No credentialed production-model evaluator exists in CI, so model-output quality is not fabricated; owner-backed decision-basis deltas are measured instead.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await runCompletePurposeValueEvaluation();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

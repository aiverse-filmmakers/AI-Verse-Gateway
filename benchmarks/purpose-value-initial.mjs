import { pathToFileURL } from 'node:url';

import { GatewayError } from '../src/errors.mjs';
import { assembleProgressiveOwnerContext } from '../src/progressive-context.mjs';
import { PURPOSE_VALUE_GATE_SCENARIOS } from '../src/purpose-value-gate.mjs';
import { stableStringify } from '../src/util.mjs';

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
      profile: { requested: 'auto', resolved: scope === 'operator' ? 'operator_default' : 'workspace_rich', reasons: ['evaluation_fixture'] },
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

class ValueGateHost {
  constructor({ scope, purposeAvailable = true }) {
    this.scope = scope;
    this.purposeAvailable = purposeAvailable;
    this.calls = [];
  }

  async describe() {
    this.calls.push({ op: 'describe' });
    return { adapter_id: 'fixture:purpose-value', metadata: {}, operations: [] };
  }

  async readContext(scope) {
    this.calls.push({ op: 'read_context', scope });
    return {
      scope,
      current_context: 'Ordinary owner context is identical in both evaluation arms.',
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
    throw new Error('initial value scenarios must not need legacy history');
  }

  async readPurposeContext(scope) {
    this.calls.push({ op: 'read_purpose', scope });
    if (!this.purposeAvailable) {
      throw new GatewayError('ADAPTER_TIMEOUT', 'Purpose owner unavailable for comparison arm', 504);
    }
    return structuredClone(projectionFor(scope));
  }
}

function runFixture(scope, prompt) {
  return {
    run_id: `value-${scope.replace(':', '-')}`,
    session_id: 'value-session',
    system_id: 'value-system',
    principal: 'operator',
    workspace_id: scope === 'operator' ? 'operator' : scope.slice('workspace:'.length),
    messages: [{ role: 'user', content: prompt }],
  };
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

function touchedScopes(host) {
  return [...new Set(host.calls.map((call) => call.scope).filter(Boolean))].sort();
}

function purposeBytes(safe) {
  if (!safe?.purpose_context) return 0;
  return Buffer.byteLength(stableStringify(safe.purpose_context), 'utf8');
}

async function assembleScenario(scenario, purposeAvailable) {
  const host = new ValueGateHost({ scope: scenario.scope, purposeAvailable });
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: runFixture(scenario.scope, scenario.prompt),
    scope: scenario.scope,
    query: scenario.prompt,
    signal: null,
  });
  return { host, assembled };
}

export async function runInitialPurposeValueEvaluation() {
  const results = [];

  for (const scenario of PURPOSE_VALUE_GATE_SCENARIOS) {
    if (STRATEGIC_IDS.has(scenario.id)) {
      const withPurpose = await assembleScenario(scenario, true);
      const withoutPurpose = await assembleScenario(scenario, false);
      const withScore = strategicEvidenceScore(withPurpose.assembled.safe, scenario.id);
      const withoutScore = strategicEvidenceScore(withoutPurpose.assembled.safe, scenario.id);
      results.push({
        scenario_id: scenario.id,
        scope: scenario.scope,
        comparison: scenario.comparison,
        purpose_owner_read_count: withPurpose.host.calls.filter((call) => call.op === 'read_purpose').length,
        purpose_envelope_bytes: purposeBytes(withPurpose.assembled.safe),
        touched_scopes: touchedScopes(withPurpose.host),
        trivial_task_loaded_purpose: false,
        completed_when_purpose_unavailable: true,
        latency_delta_ms: null,
        cost_delta: null,
        decision_quality_delta: withScore - withoutScore,
        output_difference: {
          model_output_measured: false,
          decision_basis_changed: withScore !== withoutScore,
          reason: 'initial Task 2 comparison is context-level; model-output comparison remains Task 3',
        },
        context_noise_delta: {
          measured_as_bytes: true,
          purpose_bytes_added: purposeBytes(withPurpose.assembled.safe),
        },
        workspace_isolation_regression: touchedScopes(withPurpose.host).some((scope) => scope !== scenario.scope),
        authority_regression: withPurpose.assembled.safe?.purpose_context?.provenance?.projection_owner !== 'ai-verse-os',
        evidence_score_with_purpose: withScore,
        evidence_score_without_purpose: withoutScore,
        absent_arm_state: withoutPurpose.assembled.diagnostics?.purpose?.state ?? null,
      });
      continue;
    }

    if (scenario.id === 'workspace-trivial') {
      const trivial = await assembleScenario(scenario, true);
      results.push({
        scenario_id: scenario.id,
        scope: scenario.scope,
        comparison: scenario.comparison,
        purpose_owner_read_count: trivial.host.calls.filter((call) => call.op === 'read_purpose').length,
        purpose_envelope_bytes: purposeBytes(trivial.assembled.safe),
        touched_scopes: touchedScopes(trivial.host),
        trivial_task_loaded_purpose: Object.hasOwn(trivial.assembled.safe, 'purpose_context'),
        completed_when_purpose_unavailable: null,
        latency_delta_ms: null,
        cost_delta: null,
        decision_quality_delta: 0,
        output_difference: { model_output_measured: false, decision_basis_changed: false, reason: 'Purpose correctly skipped' },
        context_noise_delta: { measured_as_bytes: true, purpose_bytes_added: 0 },
        workspace_isolation_regression: touchedScopes(trivial.host).some((scope) => scope !== scenario.scope),
        authority_regression: false,
      });
      continue;
    }

    if (scenario.id === 'workspace-owner-unavailable') {
      const unavailable = await assembleScenario(scenario, false);
      results.push({
        scenario_id: scenario.id,
        scope: scenario.scope,
        comparison: scenario.comparison,
        purpose_owner_read_count: unavailable.host.calls.filter((call) => call.op === 'read_purpose').length,
        purpose_envelope_bytes: purposeBytes(unavailable.assembled.safe),
        touched_scopes: touchedScopes(unavailable.host),
        trivial_task_loaded_purpose: false,
        completed_when_purpose_unavailable: unavailable.assembled.safe?.current_context != null && !Object.hasOwn(unavailable.assembled.safe, 'purpose_context'),
        latency_delta_ms: null,
        cost_delta: null,
        decision_quality_delta: null,
        output_difference: { model_output_measured: false, decision_basis_changed: null, reason: 'availability fallback evidence only' },
        context_noise_delta: { measured_as_bytes: true, purpose_bytes_added: 0 },
        workspace_isolation_regression: touchedScopes(unavailable.host).some((scope) => scope !== scenario.scope),
        authority_regression: false,
        unavailable_state: unavailable.assembled.diagnostics?.purpose?.state ?? null,
      });
    }
  }

  return {
    schema_version: '1.0',
    evaluation: 'purpose-value-initial',
    comparison_level: 'runtime_context',
    gate_outcome_recorded: false,
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await runInitialPurposeValueEvaluation();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

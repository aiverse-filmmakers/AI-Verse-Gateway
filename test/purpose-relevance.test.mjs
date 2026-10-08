import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleProgressiveOwnerContext,
  PURPOSE_RUNTIME_DIAGNOSTICS_VERSION,
} from '../src/progressive-context.mjs';
import {
  MAX_QUERY_CHARS,
  PURPOSE_READ_GATE_VERSION,
  PURPOSE_RELEVANCE_VERSION,
  classifyPurposeRelevance,
  gatePurposeOwnerRead,
} from '../src/purpose-relevance.mjs';

const strategicCases = [
  ['what should I work on next?', 'next_work'],
  ['why are we doing this?', 'rationale'],
  ['which project should take priority?', 'priority'],
  ['does this still serve our goal?', 'goal_alignment'],
  ['what changed?', 'material_change'],
  ['what is blocking this goal?', 'blocker'],
  ['compare two strategic options', 'strategic_compare'],
];

const irrelevantCases = [
  'Rewrite this sentence more concisely.',
  'Fix this typo.',
  'Format this JSON.',
  'Convert 5 feet to centimeters.',
  'What changed in this sentence?',
  'Compare these two filenames.',
  'Which color should I choose?',
  'Summarize this paragraph.',
];

function fakeContextHost({ purposeScope = 'workspace:alpha', purposeOwner = 'ai-verse-os' } = {}) {
  const calls = { purpose: [], current: [], capabilities: [], connections: [] };
  const host = {
    async describe() { return { adapter_id: 'fixture', metadata: {}, operations: [] }; },
    async readContext(scope) { calls.current.push(scope); return { scope, current_context: 'fixture' }; },
    async listCapabilities(scope) { calls.capabilities.push(scope); return []; },
    async listConnections(scope) { calls.connections.push(scope); return []; },
    async retrieveHistory() { return []; },
    async readPurposeContext(scope) {
      calls.purpose.push(scope);
      return {
        schema_version: '1.0',
        scope: purposeScope,
        scope_kind: purposeScope === 'operator' ? 'operator' : 'workspace',
        identity: purposeScope === 'operator'
          ? { kind: 'operator', id: 'operator' }
          : { kind: 'workspace', id: purposeScope.slice('workspace:'.length) },
        goals: [{ kind: 'goal', statement: 'Ship the right thing next' }],
        provenance: {
          projection_owner: purposeOwner,
          generated_at: '2026-10-08T18:00:00.000Z',
          profile: { requested: 'auto', resolved: 'workspace_basic', reasons: ['workspace_default_basic'] },
          owner_reads: [{
            owner: 'ai-verse-os',
            operation: 'current-context.read',
            scope: purposeScope,
            status: 'ok',
            freshness: { state: 'unknown', as_of: '2026-10-08T18:00:00.000Z' },
            canonical_refs: [{ owner: 'ai-verse-os', scope: purposeScope, kind: 'current-context', id: 'active' }],
          }],
        },
      };
    },
  };
  return { host, calls };
}

function fixtureRun(scope = 'workspace:alpha') {
  return {
    system_id: 'system-fixture',
    principal: 'principal-fixture',
    workspace_id: scope === 'operator' ? 'operator' : scope.slice('workspace:'.length),
    messages: [{ role: 'user', content: 'what should I work on next?' }],
  };
}

test('classifies the frozen Phase 7 strategic prompts as Purpose-relevant', () => {
  for (const [query, taskClass] of strategicCases) {
    const result = classifyPurposeRelevance(query);
    assert.equal(result.api_version, PURPOSE_RELEVANCE_VERSION);
    assert.equal(result.purpose_relevant, true, query);
    assert.equal(result.task_class, taskClass, query);
    assert.equal(result.reason, 'strategic_task_signal');
  }
});

test('keeps irrelevant microtasks out of Purpose relevance', () => {
  for (const query of irrelevantCases) {
    const result = classifyPurposeRelevance(query);
    assert.equal(result.purpose_relevant, false, query);
    assert.equal(result.task_class, 'irrelevant', query);
  }
});

test('Purpose relevance is separate from history-depth phrasing', () => {
  for (const query of [
    'What happened yesterday?',
    'Show me the exact historical record.',
    'Give me more detail about last week.',
  ]) {
    assert.equal(classifyPurposeRelevance(query).purpose_relevant, false, query);
  }
});

test('normalizes bounded text deterministically without inventing relevance', () => {
  assert.equal(classifyPurposeRelevance('').reason, 'empty_or_non_text_task');
  assert.equal(classifyPurposeRelevance(null).reason, 'empty_or_non_text_task');
  assert.equal(classifyPurposeRelevance('   WHY   ARE   WE   DOING   THIS?  ').task_class, 'rationale');

  const oversized = `Rewrite this sentence. ${'x'.repeat(MAX_QUERY_CHARS + 100)}`;
  assert.equal(classifyPurposeRelevance(oversized).purpose_relevant, false);
});

test('irrelevant microtasks perform zero Purpose owner reads', async () => {
  let readCount = 0;
  const forbiddenRead = async () => {
    readCount += 1;
    throw new Error('irrelevant task must never perform a Purpose owner read');
  };

  for (const query of [
    ...irrelevantCases,
    'What happened yesterday?',
    'Show me the exact historical record.',
    '',
  ]) {
    const result = await gatePurposeOwnerRead(query, forbiddenRead);
    assert.equal(result.api_version, PURPOSE_READ_GATE_VERSION);
    assert.equal(result.read_performed, false, query);
    assert.equal(result.state, 'skipped', query);
    assert.equal(result.skip_reason, 'irrelevant_task', query);
    assert.equal(result.value, null, query);
  }

  assert.equal(readCount, 0);
});

test('strategic tasks pass through the Purpose owner-read gate exactly once', async () => {
  for (const [query, taskClass] of strategicCases) {
    let readCount = 0;
    const sentinel = Object.freeze({ owner: 'ai-verse-os', projection: 'purpose-context' });
    const result = await gatePurposeOwnerRead(query, async () => {
      readCount += 1;
      return sentinel;
    });

    assert.equal(readCount, 1, query);
    assert.equal(result.api_version, PURPOSE_READ_GATE_VERSION);
    assert.equal(result.read_performed, true, query);
    assert.equal(result.state, 'read', query);
    assert.equal(result.skip_reason, null, query);
    assert.equal(result.relevance.task_class, taskClass, query);
    assert.equal(result.value, sentinel, query);
  }
});

test('read gate requires an explicit owner-read closure', async () => {
  await assert.rejects(
    gatePurposeOwnerRead('what should I work on next?', null),
    /readPurpose must be a function/,
  );
});

test('strategic runtime assembly requests Purpose only for the already-bound workspace scope and injects the OS projection', async () => {
  const scope = 'workspace:alpha';
  const { host, calls } = fakeContextHost({ purposeScope: scope });
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: fixtureRun(scope),
    scope,
    query: 'what should I work on next?',
    signal: null,
  });

  assert.deepEqual(calls.purpose, [scope]);
  assert.deepEqual(calls.current, [scope]);
  assert.equal(assembled.safe.purpose_context.scope, scope);
  assert.equal(assembled.safe.purpose_context.provenance.projection_owner, 'ai-verse-os');
  assert.equal(assembled.safe.purpose_context.goals[0].statement, 'Ship the right thing next');
});

test('strategic runtime records bounded Purpose relevance/read/size/freshness/version diagnostics', async () => {
  const scope = 'workspace:alpha';
  const { host } = fakeContextHost({ purposeScope: scope });
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: fixtureRun(scope),
    scope,
    query: 'what should I work on next?',
    signal: null,
  });
  const diagnostic = assembled.diagnostics.purpose;
  assert.equal(diagnostic.api_version, PURPOSE_RUNTIME_DIAGNOSTICS_VERSION);
  assert.equal(diagnostic.relevance_api_version, PURPOSE_RELEVANCE_VERSION);
  assert.equal(diagnostic.read_gate_api_version, PURPOSE_READ_GATE_VERSION);
  assert.equal(diagnostic.purpose_relevant, true);
  assert.equal(diagnostic.task_class, 'next_work');
  assert.equal(diagnostic.read_performed, true);
  assert.equal(diagnostic.state, 'read');
  assert.equal(diagnostic.skip_reason, null);
  assert.equal(diagnostic.scope, scope);
  assert.equal(diagnostic.projection_owner, 'ai-verse-os');
  assert.equal(diagnostic.projection_schema_version, '1.0');
  assert.equal(diagnostic.profile, 'workspace_basic');
  assert.equal(diagnostic.generated_at, '2026-10-08T18:00:00.000Z');
  assert.ok(diagnostic.projection_bytes > 0);
  assert.equal(diagnostic.owner_read_count, 1);
  assert.deepEqual(diagnostic.freshness, [{
    owner: 'ai-verse-os',
    operation: 'current-context.read',
    status: 'ok',
    state: 'unknown',
    as_of: '2026-10-08T18:00:00.000Z',
  }]);
  assert.deepEqual(assembled.safe.context_ladder.retrieval.purpose, diagnostic);
  assert.equal(Object.hasOwn(diagnostic, 'goals'), false);
  assert.equal(Object.hasOwn(diagnostic, 'canonical_refs'), false);
});

test('irrelevant runtime assembly leaves Purpose out of the owner-context bundle, performs zero reads, and records the skip', async () => {
  const scope = 'workspace:alpha';
  const { host, calls } = fakeContextHost({ purposeScope: scope });
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: fixtureRun(scope),
    scope,
    query: 'Format this JSON.',
    signal: null,
  });

  assert.deepEqual(calls.purpose, []);
  assert.equal(Object.hasOwn(assembled.safe, 'purpose_context'), false);
  assert.equal(assembled.diagnostics.purpose.api_version, PURPOSE_RUNTIME_DIAGNOSTICS_VERSION);
  assert.equal(assembled.diagnostics.purpose.purpose_relevant, false);
  assert.equal(assembled.diagnostics.purpose.read_performed, false);
  assert.equal(assembled.diagnostics.purpose.state, 'skipped');
  assert.equal(assembled.diagnostics.purpose.skip_reason, 'irrelevant_task');
  assert.equal(assembled.diagnostics.purpose.projection_bytes, 0);
  assert.equal(assembled.diagnostics.purpose.owner_read_count, 0);
  assert.deepEqual(assembled.diagnostics.purpose.freshness, []);
});

test('runtime rejects a Purpose projection returned for another workspace', async () => {
  const { host } = fakeContextHost({ purposeScope: 'workspace:other' });
  await assert.rejects(
    assembleProgressiveOwnerContext({
      host,
      store: null,
      run: fixtureRun('workspace:alpha'),
      scope: 'workspace:alpha',
      query: 'why are we doing this?',
      signal: null,
    }),
    (error) => error?.code === 'PURPOSE_CONTEXT_SCOPE_MISMATCH',
  );
});

test('runtime rejects relabeled Purpose authority', async () => {
  const scope = 'workspace:alpha';
  const { host } = fakeContextHost({ purposeScope: scope, purposeOwner: 'ai-verse-gateway' });
  await assert.rejects(
    assembleProgressiveOwnerContext({
      host,
      store: null,
      run: fixtureRun(scope),
      scope,
      query: 'which project should take priority?',
      signal: null,
    }),
    (error) => error?.code === 'PURPOSE_CONTEXT_OWNER_MISMATCH',
  );
});

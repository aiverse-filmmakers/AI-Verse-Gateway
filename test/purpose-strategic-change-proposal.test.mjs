import assert from 'node:assert/strict';
import test from 'node:test';

import {
  proposeStrategicOwnerMutation,
  PURPOSE_STRATEGIC_CHANGE_PROPOSAL_VERSION,
} from '../src/purpose-strategic-change.mjs';

const strategicCases = [
  ['operator', 'Change our mission to make dependable AI operations the focus.', 'mission_purpose', 'update'],
  ['workspace:alpha', 'Set our main goal to ship the public beta this quarter.', 'top_level_goal', 'set'],
  ['workspace:alpha', 'Reprioritize our priorities so client delivery comes before polish.', 'priority_ordering', 'reorder'],
  ['workspace:alpha', 'Replace our long-term strategy with a partner-led distribution strategy.', 'durable_strategic_intent', 'replace'],
  ['workspace:alpha', 'Transfer the direction owner to Brain.', 'direction_owner_transfer', 'transfer'],
];

for (const [scope, text, changeKind, operationKind] of strategicCases) {
  test(`creates bounded non-executable proposal for ${changeKind}`, () => {
    const result = proposeStrategicOwnerMutation({ text, scope });
    assert.equal(result.api_version, PURPOSE_STRATEGIC_CHANGE_PROPOSAL_VERSION);
    assert.equal(result.state, 'proposed');
    assert.equal(result.scope, scope);
    assert.equal(result.intent.strategic_change, true);
    assert.equal(result.proposal.state, 'proposed');
    assert.equal(result.proposal.scope, scope);
    assert.equal(result.proposal.change_kind, changeKind);
    assert.equal(result.proposal.operation_kind, operationKind);
    assert.equal(result.proposal.target_surface, 'canonical_strategic_direction');
    assert.equal(result.proposal.target_owner, null);
    assert.equal(result.proposal.routing_state, 'unresolved_until_current_direction_owner_read');
    assert.equal(result.proposal.requires_explicit_confirmation, true);
    assert.equal(result.proposal.confirmation_state, 'required_not_confirmed');
    assert.equal(result.proposal.apply_allowed, false);
    assert.equal(result.proposal.mutation_executed, false);
    assert.ok(result.proposal.requested_change.length > 0);
    assert.ok(result.proposal.requested_change.length <= 4096);
  });
}

test('read-only or hypothetical strategic discussion produces no proposal', () => {
  for (const text of [
    'What is our mission?',
    'Should we change our mission?',
    'Compare our priorities.',
    'Change the strategy wording in this paragraph.',
  ]) {
    const result = proposeStrategicOwnerMutation({ text, scope: 'workspace:alpha' });
    assert.equal(result.state, 'not_proposed', text);
    assert.equal(result.proposal, null, text);
  }
});

test('proposal preserves exact bound scope and rejects invalid workspace scopes', () => {
  const valid = proposeStrategicOwnerMutation({
    text: 'Set our main goal to ship.',
    scope: 'workspace:client-alpha-2',
  });
  assert.equal(valid.scope, 'workspace:client-alpha-2');
  assert.equal(valid.proposal.scope, 'workspace:client-alpha-2');

  for (const scope of [
    'workspace:Client-A',
    'workspace:../alpha',
    'workspace:',
    'workspace:-alpha',
    `workspace:${'a'.repeat(129)}`,
    'project:alpha',
    '',
    null,
  ]) {
    assert.throws(
      () => proposeStrategicOwnerMutation({ text: 'Set our main goal to ship.', scope }),
      /scope|workspace/i,
      String(scope),
    );
  }
});

test('proposal generation is deterministic and performs no routing or apply decision', () => {
  const input = {
    text: 'Replace our primary goal with profitable retention.',
    scope: 'workspace:alpha',
  };
  const first = proposeStrategicOwnerMutation(input);
  const second = proposeStrategicOwnerMutation(input);
  assert.deepEqual(first, second);
  assert.equal(first.proposal.target_owner, null);
  assert.equal(first.proposal.routing_state, 'unresolved_until_current_direction_owner_read');
  assert.equal(first.proposal.apply_allowed, false);
  assert.equal(first.proposal.mutation_executed, false);
  assert.equal(Object.hasOwn(first.proposal, 'authorization'), false);
  assert.equal(Object.hasOwn(first.proposal, 'approval'), false);
  assert.equal(Object.hasOwn(first.proposal, 'owner_mutation_result'), false);
});

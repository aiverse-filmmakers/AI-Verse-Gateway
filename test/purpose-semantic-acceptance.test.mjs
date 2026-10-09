import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeStrategicOwnerMutation } from '../src/purpose-strategic-change.mjs';
import { routeStrategicOwnerMutation } from '../src/purpose-strategic-routing.mjs';
import { confirmStrategicOwnerMutation } from '../src/purpose-strategic-confirmation.mjs';

const scope = 'workspace:alpha';

async function routedGoalChange() {
  const proposed = proposeStrategicOwnerMutation({
    text: 'Change our top-level goal to reach reliable profitability before expanding.',
    scope,
  });
  return routeStrategicOwnerMutation({
    proposalEnvelope: proposed,
    readDirectionOwner: async (boundScope) => ({
      schema_version: 1,
      scope: boundScope,
      owner: 'brain',
      record: { owner: 'brain' },
    }),
  });
}

// Slice 11.3 Scenario 10: high-impact goal change proposed but not confirmed.
test('high-impact goal change remains proposal-only until explicit confirmation', async () => {
  const routed = await routedGoalChange();

  assert.equal(routed.state, 'routed');
  assert.equal(routed.scope, scope);
  assert.equal(routed.proposal.change_kind, 'top_level_goal');
  assert.equal(routed.proposal.operation_kind, 'update');
  assert.equal(routed.proposal.target_owner, 'brain');
  assert.equal(routed.proposal.requires_explicit_confirmation, true);
  assert.equal(routed.proposal.confirmation_state, 'required_not_confirmed');
  assert.equal(routed.proposal.apply_allowed, false);
  assert.equal(routed.proposal.mutation_executed, false);
  assert.equal(routed.boundary.purpose_projection_mutable, false);
  assert.equal(routed.boundary.canonical_owner_write_required, true);

  assert.throws(
    () => confirmStrategicOwnerMutation({ routedEnvelope: routed }),
    /confirmation is required/,
  );

  assert.equal(routed.proposal.confirmation_state, 'required_not_confirmed');
  assert.equal(routed.proposal.apply_allowed, false);
  assert.equal(routed.proposal.mutation_executed, false);
});

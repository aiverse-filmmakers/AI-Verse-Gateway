import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeStrategicOwnerMutation } from '../src/purpose-strategic-change.mjs';
import { routeStrategicOwnerMutation } from '../src/purpose-strategic-routing.mjs';

function proposal(scope = 'workspace:alpha') {
  return proposeStrategicOwnerMutation({
    text: 'Change our purpose to build dependable AI operations.',
    scope,
  });
}

test('routes exactly once by current OS direction owner without making the proposal executable', async () => {
  let reads = 0;
  let readScope = null;
  const routed = await routeStrategicOwnerMutation({
    proposalEnvelope: proposal(),
    readDirectionOwner: async (scope) => {
      reads += 1;
      readScope = scope;
      return { schema_version: 1, scope, owner: 'os', record: null };
    },
  });
  assert.equal(reads, 1);
  assert.equal(readScope, 'workspace:alpha');
  assert.equal(routed.scope, 'workspace:alpha');
  assert.equal(routed.proposal.target_owner, 'os');
  assert.equal(routed.proposal.routing_state, 'routed_by_current_direction_owner');
  assert.equal(routed.proposal.confirmation_state, 'required_not_confirmed');
  assert.equal(routed.proposal.apply_allowed, false);
  assert.equal(routed.proposal.mutation_executed, false);
  assert.equal(routed.boundary.purpose_projection_mutable, false);
  assert.equal(routed.boundary.second_truth_store_allowed, false);
});

test('routes Brain-owned strategic direction and never silently falls back to OS', async () => {
  const routed = await routeStrategicOwnerMutation({
    proposalEnvelope: proposal('operator'),
    readDirectionOwner: async (scope) => ({
      schema_version: 1,
      scope,
      owner: 'brain',
      record: { owner: 'brain', transferred_at: '2026-10-09T00:00:00Z' },
    }),
  });
  assert.equal(routed.proposal.target_owner, 'brain');
  assert.equal(routed.direction_owner.owner, 'brain');

  await assert.rejects(
    () => routeStrategicOwnerMutation({
      proposalEnvelope: proposal('operator'),
      readDirectionOwner: async () => { throw new Error('Brain/OS owner read unavailable'); },
    }),
    /unavailable/,
  );
});

test('fails closed on cross-scope, unknown owner, malformed record, or missing reader', async () => {
  const envelope = proposal('workspace:alpha');
  await assert.rejects(
    () => routeStrategicOwnerMutation({
      proposalEnvelope: envelope,
      readDirectionOwner: async () => ({ schema_version: 1, scope: 'workspace:beta', owner: 'os', record: null }),
    }),
    /scope/,
  );
  await assert.rejects(
    () => routeStrategicOwnerMutation({
      proposalEnvelope: envelope,
      readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner: 'purpose', record: null }),
    }),
    /os or brain/,
  );
  await assert.rejects(
    () => routeStrategicOwnerMutation({
      proposalEnvelope: envelope,
      readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner: 'brain', record: { owner: 'os' } }),
    }),
    /record owner/,
  );
  await assert.rejects(
    () => routeStrategicOwnerMutation({ proposalEnvelope: envelope }),
    /readDirectionOwner/,
  );
});

test('does not accept Purpose projection data as direction-owner authority', async () => {
  await assert.rejects(
    () => routeStrategicOwnerMutation({
      proposalEnvelope: proposal(),
      readDirectionOwner: async (scope) => ({
        schema_version: 1,
        scope,
        owner: 'brain',
        record: null,
        purpose_context: { direction_owner: 'brain' },
      }),
    }),
    /owner status|direction-owner|Purpose/i,
  );
});

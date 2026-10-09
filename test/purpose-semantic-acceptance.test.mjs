import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeStrategicOwnerMutation } from '../src/purpose-strategic-change.mjs';
import { routeStrategicOwnerMutation } from '../src/purpose-strategic-routing.mjs';
import {
  confirmStrategicOwnerMutation,
  strategicProposalFingerprint,
} from '../src/purpose-strategic-confirmation.mjs';
import { buildStrategicOwnerOperation } from '../src/purpose-strategic-owner-operation.mjs';
import { executeStrategicOwnerOperation } from '../src/purpose-strategic-owner-receipt.mjs';
import { rebuildPurposeAfterStrategicMutation } from '../src/purpose-strategic-post-write.mjs';

const scope = 'workspace:alpha';
const requestedGoal = 'Change our top-level goal to reach reliable profitability before expanding.';

async function routedGoalChange() {
  const proposed = proposeStrategicOwnerMutation({ text: requestedGoal, scope });
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

function confirmationFor(routed) {
  return {
    authority: 'explicit_user',
    scope: routed.scope,
    target_owner: routed.proposal.target_owner,
    proposal_fingerprint: strategicProposalFingerprint(routed.proposal),
    granted_by: 'user:operator',
    confirmed_at: '2026-10-09T02:45:00Z',
  };
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

// Slice 11.3 Scenario 11: high-impact goal change confirmed and Purpose rebuilt.
test('confirmed high-impact goal change rebuilds Purpose only after canonical owner success', async () => {
  const routed = await routedGoalChange();
  const confirmed = confirmStrategicOwnerMutation({
    routedEnvelope: routed,
    confirmation: confirmationFor(routed),
  });

  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.proposal.confirmation_state, 'explicit_user_confirmed');
  assert.equal(confirmed.proposal.apply_allowed, false);
  assert.equal(confirmed.proposal.mutation_executed, false);

  const operation = buildStrategicOwnerOperation(confirmed);
  assert.equal(operation.target_owner, 'brain');
  assert.equal(operation.scope, scope);
  assert.equal(operation.change_kind, 'top_level_goal');

  const receipt = await executeStrategicOwnerOperation({
    ownerOperation: operation,
    executeOwnerOperation: async (input) => ({
      schema_version: 1,
      owner: input.target_owner,
      scope: input.scope,
      operation_id: input.operation_id,
      request_id: input.request_id,
      idempotency_key: input.idempotency_key,
      operation_fingerprint: input.operation_fingerprint,
      status: 'succeeded',
      receipt_id: `receipt:${input.operation_id}`,
      effect_occurred: true,
      duplicate: false,
    }),
  });

  assert.equal(receipt.state, 'owner_operation_succeeded');
  assert.equal(receipt.owner_receipt.owner, 'brain');
  assert.equal(receipt.owner_receipt.effect_occurred, true);

  let rebuildReads = 0;
  const rebuilt = await rebuildPurposeAfterStrategicMutation({
    receiptEnvelope: receipt,
    rebuildPurposeProjection: async (boundScope) => {
      rebuildReads += 1;
      assert.equal(boundScope, scope);
      return {
        schema_version: '1.0',
        scope: boundScope,
        scope_kind: 'workspace',
        identity: { kind: 'workspace', id: 'alpha' },
        direction_owner: { owner: 'brain' },
        goals: [{
          kind: 'goal',
          id: 'goal-profitability',
          statement: 'Reach reliable profitability before expanding.',
          canonical_ref: {
            owner: 'ai-verse-brain',
            scope: boundScope,
            kind: 'intent',
            id: 'goal-profitability',
            version: '1',
          },
        }],
        provenance: {
          projection_owner: 'ai-verse-os',
          generated_at: '2026-10-09T02:46:00.000Z',
          owner_reads: [{ owner: 'ai-verse-brain', operation: 'purpose-snapshot.read', scope: boundScope, status: 'ok' }],
        },
      };
    },
  });

  assert.equal(rebuildReads, 1);
  assert.equal(rebuilt.state, 'purpose_rebuilt_after_owner_success');
  assert.equal(rebuilt.canonical_owner, 'brain');
  assert.equal(rebuilt.purpose_projection_source, 'fresh_os_owner_read');
  assert.equal(rebuilt.purpose_rebuild_performed, true);
  assert.equal(rebuilt.purpose_is_authoritative_for_mutation, false);
  assert.equal(rebuilt.canonical_owner_receipt_is_mutation_evidence, true);
  assert.equal(rebuilt.stale_fallback_allowed, false);
  assert.equal(rebuilt.purpose_projection.goals[0].statement, 'Reach reliable profitability before expanding.');
  assert.equal(rebuilt.purpose_projection.provenance.projection_owner, 'ai-verse-os');
});

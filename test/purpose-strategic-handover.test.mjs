import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeStrategicOwnerMutation } from '../src/purpose-strategic-change.mjs';
import { routeStrategicOwnerMutation } from '../src/purpose-strategic-routing.mjs';
import { confirmStrategicOwnerMutation, strategicProposalFingerprint } from '../src/purpose-strategic-confirmation.mjs';
import { buildStrategicOwnerOperation } from '../src/purpose-strategic-owner-operation.mjs';
import { executeStrategicOwnerOperation } from '../src/purpose-strategic-owner-receipt.mjs';
import {
  PURPOSE_STRATEGIC_HANDOVER_VERSION,
  strategicDirectionTransferTarget,
  verifyStrategicDirectionTransfer,
} from '../src/purpose-strategic-handover.mjs';

async function successfulTransfer({ text, currentOwner }) {
  const proposalEnvelope = proposeStrategicOwnerMutation({ text, scope: 'workspace:alpha' });
  const routed = await routeStrategicOwnerMutation({
    proposalEnvelope,
    readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner: currentOwner, record: currentOwner === 'os' ? null : { owner: currentOwner, state: 'active' } }),
  });
  const confirmed = confirmStrategicOwnerMutation({
    routedEnvelope: routed,
    confirmation: {
      authority: 'explicit_user',
      scope: routed.scope,
      target_owner: currentOwner,
      proposal_fingerprint: strategicProposalFingerprint(routed.proposal),
      granted_by: 'user:operator',
      confirmed_at: '2026-10-09T02:00:00Z',
    },
  });
  const operation = buildStrategicOwnerOperation(confirmed);
  return executeStrategicOwnerOperation({
    ownerOperation: operation,
    executeOwnerOperation: async (request) => ({
      schema_version: 1,
      owner: currentOwner,
      scope: request.scope,
      operation_id: request.operation_id,
      request_id: request.request_id,
      idempotency_key: request.idempotency_key,
      operation_fingerprint: request.operation_fingerprint,
      status: 'succeeded',
      receipt_id: `receipt:${request.operation_id}`,
      effect_occurred: true,
      duplicate: false,
    }),
  });
}

test('OS-to-Brain handover is executed by current OS owner and only verified after registry flips to Brain', async () => {
  const envelope = await successfulTransfer({ text: 'Transfer the direction owner to Brain.', currentOwner: 'os' });
  assert.equal(envelope.operation.target_owner, 'os');
  assert.equal(strategicDirectionTransferTarget(envelope.operation.semantic_binding), 'brain');
  let reads = 0;
  const verified = await verifyStrategicDirectionTransfer({
    receiptEnvelope: envelope,
    readDirectionOwner: async (scope) => {
      reads += 1;
      return { schema_version: 1, scope, owner: 'brain', record: { owner: 'brain', state: 'active', handover_id: 'handover-1' } };
    },
  });
  assert.equal(reads, 1);
  assert.equal(verified.api_version, PURPOSE_STRATEGIC_HANDOVER_VERSION);
  assert.equal(verified.state, 'handover_verified');
  assert.equal(verified.previous_owner, 'os');
  assert.equal(verified.current_owner, 'brain');
  assert.equal(verified.owner_registry_is_authoritative, true);
  assert.equal(verified.purpose_may_reflect_new_owner, true);
});

test('Brain-to-OS handback is executed by current Brain owner and requires canonical registry handback', async () => {
  const envelope = await successfulTransfer({ text: 'Hand back the direction owner to OS.', currentOwner: 'brain' });
  assert.equal(envelope.operation.target_owner, 'brain');
  assert.equal(strategicDirectionTransferTarget(envelope.operation.semantic_binding), 'os');
  const verified = await verifyStrategicDirectionTransfer({
    receiptEnvelope: envelope,
    readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner: 'os', record: { owner: 'os', state: 'active', export_confirmed: true } }),
  });
  assert.equal(verified.state, 'handback_verified');
  assert.equal(verified.previous_owner, 'brain');
  assert.equal(verified.current_owner, 'os');
});

test('Brain outage or owner-read failure never silently returns direction authority to OS', async () => {
  const envelope = await successfulTransfer({ text: 'Hand back the direction owner to OS.', currentOwner: 'brain' });
  await assert.rejects(
    () => verifyStrategicDirectionTransfer({
      receiptEnvelope: envelope,
      readDirectionOwner: async () => { throw Object.assign(new Error('Brain unavailable'), { code: 'BRAIN_UNAVAILABLE' }); },
    }),
    /Brain unavailable/,
  );
});

test('a receipt alone cannot claim handover while registry still names the previous owner', async () => {
  const envelope = await successfulTransfer({ text: 'Transfer the direction owner to Brain.', currentOwner: 'os' });
  await assert.rejects(
    () => verifyStrategicDirectionTransfer({
      receiptEnvelope: envelope,
      readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner: 'os', record: null }),
    }),
    /did not complete transfer to brain/,
  );
});

test('cross-scope direction-owner evidence fails closed', async () => {
  const envelope = await successfulTransfer({ text: 'Transfer the direction owner to Brain.', currentOwner: 'os' });
  await assert.rejects(
    () => verifyStrategicDirectionTransfer({
      receiptEnvelope: envelope,
      readDirectionOwner: async () => ({ schema_version: 1, scope: 'workspace:beta', owner: 'brain', record: { owner: 'brain' } }),
    }),
    /scope does not match/,
  );
});

test('ambiguous, missing, or no-op transfer destination fails closed', async () => {
  assert.throws(
    () => strategicDirectionTransferTarget({ change_kind: 'direction_owner_transfer', requested_change: 'Transfer direction ownership.' }),
    /exactly one|explicit destination/,
  );
  assert.throws(
    () => strategicDirectionTransferTarget({ change_kind: 'direction_owner_transfer', requested_change: 'Transfer direction owner to Brain and back to OS.' }),
    /exactly one/,
  );

  const noOp = await successfulTransfer({ text: 'Make Brain the direction owner.', currentOwner: 'brain' });
  await assert.rejects(
    () => verifyStrategicDirectionTransfer({
      receiptEnvelope: noOp,
      readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner: 'brain', record: { owner: 'brain' } }),
    }),
    /destination must differ/,
  );
});

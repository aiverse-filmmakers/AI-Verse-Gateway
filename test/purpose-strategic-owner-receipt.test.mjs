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

async function operation(owner = 'brain') {
  const proposed = proposeStrategicOwnerMutation({
    text: 'Replace our strategy with a reliability-first strategy.',
    scope: 'workspace:alpha',
  });
  const routed = await routeStrategicOwnerMutation({
    proposalEnvelope: proposed,
    readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner, record: owner === 'brain' ? { owner: 'brain' } : null }),
  });
  const confirmed = confirmStrategicOwnerMutation({
    routedEnvelope: routed,
    confirmation: {
      authority: 'explicit_user',
      scope: routed.scope,
      target_owner: owner,
      proposal_fingerprint: strategicProposalFingerprint(routed.proposal),
      granted_by: 'user:operator',
      confirmed_at: '2026-10-09T00:30:00Z',
    },
  });
  return buildStrategicOwnerOperation(confirmed);
}

function receiptFor(op, overrides = {}) {
  return {
    schema_version: 1,
    owner: op.target_owner,
    scope: op.scope,
    operation_id: op.operation_id,
    request_id: op.request_id,
    idempotency_key: op.idempotency_key,
    operation_fingerprint: op.operation_fingerprint,
    status: 'succeeded',
    receipt_id: `receipt:${op.operation_id}`,
    effect_occurred: true,
    duplicate: false,
    ...overrides,
  };
}

test('accepts exact Brain owner-backed success receipt and enables only post-success Purpose rebuild', async () => {
  const op = await operation('brain');
  let calls = 0;
  let seen = null;
  const result = await executeStrategicOwnerOperation({
    ownerOperation: op,
    executeOwnerOperation: async (input) => {
      calls += 1;
      seen = input;
      return receiptFor(input);
    },
  });
  assert.equal(calls, 1);
  assert.equal(seen, op);
  assert.equal(result.state, 'owner_effect_succeeded');
  assert.equal(result.receipt_source, 'canonical_owner');
  assert.equal(result.owner_receipt.owner, 'brain');
  assert.equal(result.mutation_executed, true);
  assert.equal(result.purpose_rebuild_allowed, true);
});

test('accepts exact OS owner-backed duplicate success receipt without changing the operation binding', async () => {
  const op = await operation('os');
  const result = await executeStrategicOwnerOperation({
    ownerOperation: op,
    executeOwnerOperation: async (input) => receiptFor(input, { duplicate: true }),
  });
  assert.equal(result.owner_receipt.owner, 'os');
  assert.equal(result.owner_receipt.duplicate, true);
  assert.equal(result.owner_receipt.operation_id, op.operation_id);
  assert.equal(result.owner_receipt.idempotency_key, op.idempotency_key);
  assert.equal(result.owner_receipt.operation_fingerprint, op.operation_fingerprint);
  assert.equal(result.purpose_rebuild_allowed, true);
});

test('successful canonical effect without a receipt or effect proof fails closed', async () => {
  const op = await operation();
  await assert.rejects(
    () => executeStrategicOwnerOperation({
      ownerOperation: op,
      executeOwnerOperation: async (input) => receiptFor(input, { receipt_id: null }),
    }),
    /receipt_id/,
  );
  await assert.rejects(
    () => executeStrategicOwnerOperation({
      ownerOperation: op,
      executeOwnerOperation: async (input) => receiptFor(input, { effect_occurred: false }),
    }),
    /effect_occurred=true/,
  );
});

test('wrong owner/scope/IDs/idempotency/fingerprint receipts are rejected', async () => {
  const op = await operation('brain');
  const invalid = [
    { owner: 'os' },
    { scope: 'workspace:beta' },
    { operation_id: 'wrong' },
    { request_id: 'wrong' },
    { idempotency_key: 'wrong' },
    { operation_fingerprint: '0'.repeat(64) },
  ];
  for (const overrides of invalid) {
    await assert.rejects(
      () => executeStrategicOwnerOperation({
        ownerOperation: op,
        executeOwnerOperation: async (input) => receiptFor(input, overrides),
      }),
      /owner|scope|ID|idempotency|fingerprint/,
    );
  }
});

test('failed no-effect and uncertain owner outcomes never permit Purpose rebuild', async () => {
  const op = await operation();
  const failed = await executeStrategicOwnerOperation({
    ownerOperation: op,
    executeOwnerOperation: async (input) => receiptFor(input, {
      status: 'failed',
      receipt_id: null,
      effect_occurred: false,
    }),
  });
  assert.equal(failed.state, 'owner_effect_failed');
  assert.equal(failed.mutation_executed, false);
  assert.equal(failed.purpose_rebuild_allowed, false);

  const uncertain = await executeStrategicOwnerOperation({
    ownerOperation: op,
    executeOwnerOperation: async (input) => receiptFor(input, {
      status: 'uncertain',
      receipt_id: null,
      effect_occurred: null,
    }),
  });
  assert.equal(uncertain.state, 'owner_effect_uncertain');
  assert.equal(uncertain.mutation_executed, false);
  assert.equal(uncertain.purpose_rebuild_allowed, false);
});

test('failed receipt must prove no effect and receipt payload cannot carry extra authority fields', async () => {
  const op = await operation();
  await assert.rejects(
    () => executeStrategicOwnerOperation({
      ownerOperation: op,
      executeOwnerOperation: async (input) => receiptFor(input, { status: 'failed', effect_occurred: true }),
    }),
    /effect_occurred=false/,
  );
  await assert.rejects(
    () => executeStrategicOwnerOperation({
      ownerOperation: op,
      executeOwnerOperation: async (input) => ({ ...receiptFor(input), purpose_context: {} }),
    }),
    /unsupported owner receipt field/,
  );
});

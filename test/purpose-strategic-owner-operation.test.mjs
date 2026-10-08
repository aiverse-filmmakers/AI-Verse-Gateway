import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeStrategicOwnerMutation } from '../src/purpose-strategic-change.mjs';
import { routeStrategicOwnerMutation } from '../src/purpose-strategic-routing.mjs';
import {
  confirmStrategicOwnerMutation,
  strategicProposalFingerprint,
} from '../src/purpose-strategic-confirmation.mjs';
import { buildStrategicOwnerOperation } from '../src/purpose-strategic-owner-operation.mjs';

async function confirmed({ owner = 'brain', confirmedAt = '2026-10-09T00:30:00Z', text = 'Replace our strategy with a reliability-first strategy.' } = {}) {
  const proposed = proposeStrategicOwnerMutation({ text, scope: 'workspace:alpha' });
  const routed = await routeStrategicOwnerMutation({
    proposalEnvelope: proposed,
    readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner, record: owner === 'brain' ? { owner: 'brain' } : null }),
  });
  return confirmStrategicOwnerMutation({
    routedEnvelope: routed,
    confirmation: {
      authority: 'explicit_user',
      scope: routed.scope,
      target_owner: owner,
      proposal_fingerprint: strategicProposalFingerprint(routed.proposal),
      granted_by: 'user:operator',
      confirmed_at: confirmedAt,
    },
  });
}

test('same confirmed semantic mutation deterministically preserves operation id and idempotency key', async () => {
  const first = buildStrategicOwnerOperation(await confirmed({ confirmedAt: '2026-10-09T00:30:00Z' }));
  const repeatedConfirmation = buildStrategicOwnerOperation(await confirmed({ confirmedAt: '2026-10-09T00:31:00Z' }));
  assert.equal(first.operation_id, repeatedConfirmation.operation_id);
  assert.equal(first.request_id, repeatedConfirmation.request_id);
  assert.equal(first.idempotency_key, repeatedConfirmation.idempotency_key);
  assert.equal(first.operation_fingerprint, repeatedConfirmation.operation_fingerprint);
  assert.match(first.operation_id, /^purpose_strategic_[a-f0-9]{32}$/);
  assert.match(first.idempotency_key, /^purpose_strategic:[a-f0-9]{64}$/);
});

test('semantic change or current owner change produces a different operation binding', async () => {
  const baseline = buildStrategicOwnerOperation(await confirmed());
  const changedText = buildStrategicOwnerOperation(await confirmed({ text: 'Replace our strategy with a distribution-first strategy.' }));
  const changedOwner = buildStrategicOwnerOperation(await confirmed({ owner: 'os' }));
  assert.notEqual(baseline.operation_id, changedText.operation_id);
  assert.notEqual(baseline.idempotency_key, changedText.idempotency_key);
  assert.notEqual(baseline.operation_id, changedOwner.operation_id);
  assert.notEqual(baseline.idempotency_key, changedOwner.idempotency_key);
});

test('owner operation carries owner-native idempotency primitives but performs no effect or Purpose rebuild', async () => {
  const operation = buildStrategicOwnerOperation(await confirmed({ owner: 'os' }));
  assert.equal(operation.action_class, 'modify_canonical_state');
  assert.equal(operation.request_id, operation.operation_id);
  assert.equal(operation.target_owner, 'os');
  assert.equal(operation.explicit_user_confirmed, true);
  assert.equal(operation.owner_receipt, null);
  assert.equal(operation.mutation_executed, false);
  assert.equal(operation.purpose_rebuild_allowed, false);
  assert.equal(Object.hasOwn(operation, 'purpose_context'), false);
  assert.equal(Object.hasOwn(operation, 'purpose_store'), false);
});

test('unconfirmed or merely routed proposals cannot produce owner operation IDs', async () => {
  const proposed = proposeStrategicOwnerMutation({
    text: 'Change our purpose to reliable AI operations.',
    scope: 'workspace:alpha',
  });
  const routed = await routeStrategicOwnerMutation({
    proposalEnvelope: proposed,
    readDirectionOwner: async (scope) => ({ schema_version: 1, scope, owner: 'os', record: null }),
  });
  assert.throws(() => buildStrategicOwnerOperation(routed), /confirmed/);
  assert.throws(() => buildStrategicOwnerOperation(proposed), /confirmed/);
});

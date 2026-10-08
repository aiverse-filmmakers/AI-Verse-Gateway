import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeStrategicOwnerMutation } from '../src/purpose-strategic-change.mjs';
import { routeStrategicOwnerMutation } from '../src/purpose-strategic-routing.mjs';
import {
  confirmStrategicOwnerMutation,
  strategicProposalFingerprint,
} from '../src/purpose-strategic-confirmation.mjs';

async function routed(owner = 'brain', scope = 'workspace:alpha') {
  const proposed = proposeStrategicOwnerMutation({
    text: 'Replace our strategy with a reliability-first strategy.',
    scope,
  });
  return routeStrategicOwnerMutation({
    proposalEnvelope: proposed,
    readDirectionOwner: async (boundScope) => ({
      schema_version: 1,
      scope: boundScope,
      owner,
      record: owner === 'brain' ? { owner: 'brain' } : null,
    }),
  });
}

function approvalFor(envelope, overrides = {}) {
  return {
    authority: 'explicit_user',
    scope: envelope.scope,
    target_owner: envelope.proposal.target_owner,
    proposal_fingerprint: strategicProposalFingerprint(envelope.proposal),
    granted_by: 'user:operator',
    confirmed_at: '2026-10-09T00:30:00Z',
    ...overrides,
  };
}

test('explicit user confirmation binds the exact routed strategic proposal but does not execute it', async () => {
  const envelope = await routed('brain');
  const confirmed = confirmStrategicOwnerMutation({
    routedEnvelope: envelope,
    confirmation: approvalFor(envelope),
  });
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.proposal.confirmation_state, 'explicit_user_confirmed');
  assert.equal(confirmed.confirmation.authority, 'explicit_user');
  assert.equal(confirmed.confirmation.scope, 'workspace:alpha');
  assert.equal(confirmed.confirmation.target_owner, 'brain');
  assert.equal(confirmed.boundary.explicit_user_confirmation_present, true);
  assert.equal(confirmed.boundary.purpose_projection_mutable, false);
  assert.equal(confirmed.owner_operation_required, true);
  assert.equal(confirmed.owner_operation_built, false);
  assert.equal(confirmed.apply_allowed, false);
  assert.equal(confirmed.mutation_executed, false);
  assert.equal(confirmed.proposal.apply_allowed, false);
  assert.equal(confirmed.proposal.mutation_executed, false);
});

test('no implicit confirmation is inferred from strategic wording or routing', async () => {
  const envelope = await routed('os');
  assert.equal(envelope.proposal.confirmation_state, 'required_not_confirmed');
  assert.throws(
    () => confirmStrategicOwnerMutation({ routedEnvelope: envelope }),
    /confirmation is required/,
  );
});

test('confirmation must use explicit user authority and match exact scope, owner, and fingerprint', async () => {
  const envelope = await routed('brain');
  const invalid = [
    approvalFor(envelope, { authority: 'validated_strategy' }),
    approvalFor(envelope, { scope: 'workspace:beta' }),
    approvalFor(envelope, { target_owner: 'os' }),
    approvalFor(envelope, { proposal_fingerprint: '0'.repeat(64) }),
    approvalFor(envelope, { granted_by: '' }),
    approvalFor(envelope, { confirmed_at: 'not-a-time' }),
  ];
  for (const confirmation of invalid) {
    assert.throws(
      () => confirmStrategicOwnerMutation({ routedEnvelope: envelope, confirmation }),
      /authority|scope|owner|fingerprint|granting user|timestamp/,
    );
  }
});

test('a confirmation for an earlier routed proposal is invalid after any routed proposal change', async () => {
  const envelope = await routed('brain');
  const confirmation = approvalFor(envelope);
  const changed = {
    ...envelope,
    proposal: Object.freeze({
      ...envelope.proposal,
      requested_change: 'Replace our strategy with a different strategy.',
    }),
  };
  assert.throws(
    () => confirmStrategicOwnerMutation({ routedEnvelope: changed, confirmation }),
    /fingerprint/,
  );
});

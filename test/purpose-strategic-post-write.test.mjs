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

function rawReceipt(op, overrides = {}) {
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

async function ownerReceipt(owner = 'brain', overrides = {}) {
  const op = await operation(owner);
  return executeStrategicOwnerOperation({
    ownerOperation: op,
    executeOwnerOperation: async (input) => rawReceipt(input, overrides),
  });
}

function projection(scope, owner = 'brain', extra = {}) {
  return {
    schema_version: '1.0',
    scope,
    scope_kind: scope === 'operator' ? 'operator' : 'workspace',
    provenance: {
      projection_owner: 'ai-verse-os',
      generated_at: '2026-10-09T00:31:00.000Z',
      owner_reads: [],
    },
    direction_owner: { owner },
    goals: [{ kind: 'goal', id: 'goal-1', statement: 'Reliability first' }],
    ...extra,
  };
}

test('rebuilds Purpose exactly once from OS projection owner after exact owner-backed success', async () => {
  const receipt = await ownerReceipt('brain');
  let reads = 0;
  let readScope = null;
  const result = await rebuildPurposeAfterStrategicMutation({
    receiptEnvelope: receipt,
    rebuildPurposeProjection: async (scope) => {
      reads += 1;
      readScope = scope;
      return projection(scope, 'brain');
    },
  });
  assert.equal(reads, 1);
  assert.equal(readScope, 'workspace:alpha');
  assert.equal(result.state, 'purpose_rebuilt_after_owner_success');
  assert.equal(result.canonical_owner, 'brain');
  assert.equal(result.owner_receipt_id, receipt.owner_receipt.receipt_id);
  assert.equal(result.purpose_projection.direction_owner.owner, 'brain');
  assert.equal(result.purpose_projection_source, 'fresh_os_owner_read');
  assert.equal(result.purpose_rebuild_performed, true);
  assert.equal(result.purpose_is_authoritative_for_mutation, false);
  assert.equal(result.canonical_owner_receipt_is_mutation_evidence, true);
  assert.equal(result.stale_fallback_allowed, false);
  assert.ok(result.purpose_projection_bytes > 0);
  assert.ok(result.purpose_projection_bytes <= 16384);
});

test('failed and uncertain owner receipts cause zero Purpose rebuild reads', async () => {
  const failed = await ownerReceipt('brain', { status: 'failed', receipt_id: null, effect_occurred: false });
  const uncertain = await ownerReceipt('brain', { status: 'uncertain', receipt_id: null, effect_occurred: null });
  let reads = 0;
  const forbiddenReader = async () => {
    reads += 1;
    throw new Error('Purpose must not be read');
  };
  for (const receiptEnvelope of [failed, uncertain]) {
    const result = await rebuildPurposeAfterStrategicMutation({ receiptEnvelope, rebuildPurposeProjection: forbiddenReader });
    assert.equal(result.state, 'purpose_rebuild_skipped');
    assert.equal(result.purpose_projection, null);
    assert.equal(result.purpose_rebuild_performed, false);
    assert.equal(result.skip_reason, 'canonical_owner_success_not_proven');
  }
  assert.equal(reads, 0);
});

test('rebuilt Purpose must match exact scope and preserve OS projection ownership', async () => {
  const receipt = await ownerReceipt('os');
  await assert.rejects(
    () => rebuildPurposeAfterStrategicMutation({
      receiptEnvelope: receipt,
      rebuildPurposeProjection: async () => projection('workspace:beta', 'os'),
    }),
    /scope/,
  );
  await assert.rejects(
    () => rebuildPurposeAfterStrategicMutation({
      receiptEnvelope: receipt,
      rebuildPurposeProjection: async (scope) => projection(scope, 'os', { provenance: { projection_owner: 'gateway' } }),
    }),
    /ai-verse-os/,
  );
});

test('oversized fresh Purpose output is rejected and no stale fallback surface is accepted', async () => {
  const receipt = await ownerReceipt('brain');
  await assert.rejects(
    () => rebuildPurposeAfterStrategicMutation({
      receiptEnvelope: receipt,
      rebuildPurposeProjection: async (scope) => projection(scope, 'brain', { padding: 'x'.repeat(20000) }),
    }),
    /16384/,
  );
});

test('proven success requires an explicit OS Purpose rebuild reader', async () => {
  const receipt = await ownerReceipt('brain');
  await assert.rejects(
    () => rebuildPurposeAfterStrategicMutation({ receiptEnvelope: receipt }),
    /rebuildPurposeProjection/,
  );
});

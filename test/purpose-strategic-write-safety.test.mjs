import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Crash-safety invariant: canonical owner evidence may survive independently; Purpose never becomes fallback truth.
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
      confirmed_at: '2026-10-09T01:00:00Z',
    },
  });
  return buildStrategicOwnerOperation(confirmed);
}

function receipt(op, overrides = {}) {
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

function projection(scope) {
  return {
    schema_version: '1.0',
    scope,
    scope_kind: 'workspace',
    provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-09T01:01:00Z', owner_reads: [] },
    goals: [{ kind: 'goal', id: 'goal-1', statement: 'Reliability first' }],
  };
}

test('owner execution interruption cannot trigger a Purpose read', async () => {
  const op = await operation();
  let purposeReads = 0;
  await assert.rejects(
    () => executeStrategicOwnerOperation({
      ownerOperation: op,
      executeOwnerOperation: async () => {
        throw Object.assign(new Error('owner dispatch interrupted'), { code: 'OWNER_DISPATCH_INTERRUPTED' });
      },
    }),
    /interrupted/,
  );
  assert.equal(purposeReads, 0);
  assert.equal(op.owner_receipt, null);
  assert.equal(op.mutation_executed, false);
  assert.equal(op.purpose_rebuild_allowed, false);
});

test('failed and uncertain canonical outcomes remain receipt evidence only and cause zero Purpose reads', async () => {
  const op = await operation();
  let purposeReads = 0;
  const forbiddenPurposeRead = async () => {
    purposeReads += 1;
    throw new Error('Purpose read is forbidden for non-success');
  };

  for (const raw of [
    receipt(op, { status: 'failed', receipt_id: null, effect_occurred: false }),
    receipt(op, { status: 'uncertain', receipt_id: null, effect_occurred: null }),
  ]) {
    const ownerResult = await executeStrategicOwnerOperation({ ownerOperation: op, executeOwnerOperation: async () => raw });
    const rebuilt = await rebuildPurposeAfterStrategicMutation({
      receiptEnvelope: ownerResult,
      rebuildPurposeProjection: forbiddenPurposeRead,
    });
    assert.equal(ownerResult.mutation_executed, false);
    assert.equal(ownerResult.purpose_rebuild_allowed, false);
    assert.equal(rebuilt.state, 'purpose_rebuild_skipped');
    assert.equal(rebuilt.purpose_projection, null);
    assert.equal(rebuilt.purpose_rebuild_performed, false);
  }
  assert.equal(purposeReads, 0);
});

test('malformed success cannot manufacture canonical success or a Purpose rebuild', async () => {
  const op = await operation();
  let purposeReads = 0;
  await assert.rejects(
    () => executeStrategicOwnerOperation({
      ownerOperation: op,
      executeOwnerOperation: async () => receipt(op, { receipt_id: null }),
    }),
    /receipt_id/,
  );
  assert.equal(purposeReads, 0);
});

test('Purpose rebuild interruption after canonical success cannot replace owner receipt truth', async () => {
  const op = await operation();
  const ownerResult = await executeStrategicOwnerOperation({
    ownerOperation: op,
    executeOwnerOperation: async () => receipt(op),
  });
  const snapshot = structuredClone(ownerResult);
  let reads = 0;
  await assert.rejects(
    () => rebuildPurposeAfterStrategicMutation({
      receiptEnvelope: ownerResult,
      rebuildPurposeProjection: async () => {
        reads += 1;
        throw Object.assign(new Error('Purpose projection unavailable'), { code: 'PURPOSE_OWNER_UNAVAILABLE' });
      },
    }),
    /unavailable/,
  );
  assert.equal(reads, 1);
  assert.deepEqual(ownerResult, snapshot);
  assert.equal(ownerResult.state, 'owner_effect_succeeded');
  assert.equal(ownerResult.owner_receipt.status, 'succeeded');
  assert.equal(ownerResult.owner_receipt.effect_occurred, true);
  assert.equal('purpose_projection' in ownerResult, false);
});

test('fresh Purpose remains a disposable derived view even after successful mutation', async () => {
  const op = await operation();
  const ownerResult = await executeStrategicOwnerOperation({
    ownerOperation: op,
    executeOwnerOperation: async () => receipt(op),
  });
  const rebuilt = await rebuildPurposeAfterStrategicMutation({
    receiptEnvelope: ownerResult,
    rebuildPurposeProjection: async (scope) => projection(scope),
  });
  assert.equal(rebuilt.state, 'purpose_rebuilt_after_owner_success');
  assert.equal(rebuilt.purpose_is_authoritative_for_mutation, false);
  assert.equal(rebuilt.canonical_owner_receipt_is_mutation_evidence, true);
  assert.equal(rebuilt.stale_fallback_allowed, false);
  assert.equal(rebuilt.owner_receipt_id, ownerResult.owner_receipt.receipt_id);
});

test('strategic mutation and post-write modules expose no Purpose persistence path', async () => {
  for (const path of [
    new URL('../src/purpose-strategic-owner-receipt.mjs', import.meta.url),
    new URL('../src/purpose-strategic-post-write.mjs', import.meta.url),
  ]) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /from ['"]node:fs/);
    assert.doesNotMatch(source, /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync)\b/);
    assert.doesNotMatch(source, /purpose[_-](store|database|ledger)/i);
  }
});

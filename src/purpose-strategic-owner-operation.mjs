import crypto from 'node:crypto';

import { assertConfirmedStrategicMutationBoundary } from './purpose-strategic-mutation-boundary.mjs';

export const PURPOSE_STRATEGIC_OWNER_OPERATION_VERSION = 'gateway.purpose-strategic-owner-operation.v1';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function operationSemanticBinding(confirmedEnvelope) {
  const proposal = confirmedEnvelope.proposal;
  return {
    scope: proposal.scope,
    target_owner: proposal.target_owner,
    change_kind: proposal.change_kind,
    operation_kind: proposal.operation_kind,
    requested_change: proposal.requested_change,
    target_surface: proposal.target_surface,
    proposal_fingerprint: proposal.confirmation.proposal_fingerprint,
  };
}

export function buildStrategicOwnerOperation(confirmedEnvelope) {
  if (!confirmedEnvelope || typeof confirmedEnvelope !== 'object' || Array.isArray(confirmedEnvelope)) {
    throw new TypeError('confirmed strategic mutation envelope must be an object');
  }
  if (confirmedEnvelope.state !== 'confirmed' || !confirmedEnvelope.proposal) {
    throw new TypeError('owner operation requires a confirmed strategic mutation');
  }
  assertConfirmedStrategicMutationBoundary(confirmedEnvelope.proposal);
  if (confirmedEnvelope.scope !== confirmedEnvelope.proposal.scope) {
    throw new TypeError('confirmed strategic envelope scope must match its proposal');
  }

  const semanticBinding = Object.freeze(operationSemanticBinding(confirmedEnvelope));
  const semanticDigest = sha256(canonicalJson(semanticBinding));
  const operationId = `purpose_strategic_${semanticDigest.slice(0, 32)}`;
  const idempotencyKey = `purpose_strategic:${semanticDigest}`;
  const operation = `strategic.${confirmedEnvelope.proposal.change_kind}.${confirmedEnvelope.proposal.operation_kind}`;
  const operationFingerprint = sha256(canonicalJson({
    operation_id: operationId,
    idempotency_key: idempotencyKey,
    operation,
    semantic_binding: semanticBinding,
  }));

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_OWNER_OPERATION_VERSION,
    state: 'owner_operation_ready',
    scope: confirmedEnvelope.scope,
    target_owner: confirmedEnvelope.proposal.target_owner,
    operation_id: operationId,
    request_id: operationId,
    idempotency_key: idempotencyKey,
    action_class: 'modify_canonical_state',
    operation,
    operation_fingerprint: operationFingerprint,
    semantic_binding: semanticBinding,
    requested_by: confirmedEnvelope.confirmation.granted_by,
    explicit_user_confirmed: true,
    owner_receipt: null,
    mutation_executed: false,
    purpose_rebuild_allowed: false,
  });
}

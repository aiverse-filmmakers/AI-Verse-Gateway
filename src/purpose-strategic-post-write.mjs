import {
  PURPOSE_RUNTIME_POLICY_VERSION,
  assertPurposeRuntimeEnvelopeSize,
  selectPurposeRuntimeProjection,
} from './purpose-runtime-policy.mjs';
import { stableStringify } from './util.mjs';

export const PURPOSE_STRATEGIC_POST_WRITE_VERSION = 'gateway.purpose-strategic-post-write.v1';

function serializedPurposeBytes(value) {
  return Buffer.byteLength(stableStringify(value ?? null), 'utf8');
}

function ownerEffectSucceeded(receiptEnvelope) {
  return Boolean(
    receiptEnvelope
      && receiptEnvelope.state === 'owner_effect_succeeded'
      && receiptEnvelope.receipt_source === 'canonical_owner'
      && receiptEnvelope.mutation_executed === true
      && receiptEnvelope.purpose_rebuild_allowed === true
      && receiptEnvelope.owner_receipt?.status === 'succeeded'
      && receiptEnvelope.owner_receipt?.effect_occurred === true
      && typeof receiptEnvelope.owner_receipt?.receipt_id === 'string'
      && receiptEnvelope.owner_receipt.receipt_id.trim(),
  );
}

function validateFreshOwnerProjection(projection, scope) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    throw new TypeError('OS Purpose rebuild must return a projection object');
  }
  if (projection.scope !== scope) {
    throw new TypeError('rebuilt Purpose projection scope does not match the successful owner mutation');
  }
  if (projection?.provenance?.projection_owner !== 'ai-verse-os') {
    throw new TypeError('rebuilt Purpose projection must preserve ai-verse-os projection ownership');
  }
  if (typeof projection.schema_version !== 'string' || !projection.schema_version) {
    throw new TypeError('rebuilt Purpose projection must expose schema_version');
  }
  const budget = assertPurposeRuntimeEnvelopeSize(projection, serializedPurposeBytes);
  if (!budget.within_budget) {
    throw new TypeError(`rebuilt Purpose projection exceeded ${budget.max_envelope_bytes} runtime bytes`);
  }
  const precedence = selectPurposeRuntimeProjection(projection, null);
  if (precedence.source !== 'fresh_owner_read' || precedence.projection !== projection || precedence.stale_fallback_allowed !== false) {
    throw new TypeError('rebuilt Purpose projection must be admitted only as a fresh OS owner read');
  }
  return Object.freeze({ projection, budget, precedence });
}

export async function rebuildPurposeAfterStrategicMutation({ receiptEnvelope, rebuildPurposeProjection } = {}) {
  if (!receiptEnvelope || typeof receiptEnvelope !== 'object' || Array.isArray(receiptEnvelope)) {
    throw new TypeError('strategic owner receipt envelope must be an object');
  }

  if (!ownerEffectSucceeded(receiptEnvelope)) {
    return Object.freeze({
      api_version: PURPOSE_STRATEGIC_POST_WRITE_VERSION,
      state: 'purpose_rebuild_skipped',
      scope: receiptEnvelope.scope ?? null,
      owner_receipt: receiptEnvelope.owner_receipt ?? null,
      purpose_projection: null,
      purpose_projection_source: 'none',
      purpose_rebuild_performed: false,
      skip_reason: 'canonical_owner_success_not_proven',
    });
  }

  if (typeof rebuildPurposeProjection !== 'function') {
    throw new TypeError('rebuildPurposeProjection must be the OS-owned fresh Purpose projection reader');
  }

  const scope = receiptEnvelope.scope;
  const projection = await rebuildPurposeProjection(scope);
  const validated = validateFreshOwnerProjection(projection, scope);

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_POST_WRITE_VERSION,
    purpose_runtime_policy: PURPOSE_RUNTIME_POLICY_VERSION,
    state: 'purpose_rebuilt_after_owner_success',
    scope,
    canonical_owner: receiptEnvelope.target_owner,
    owner_receipt: receiptEnvelope.owner_receipt,
    owner_receipt_id: receiptEnvelope.owner_receipt.receipt_id,
    purpose_projection: validated.projection,
    purpose_projection_source: 'fresh_os_owner_read',
    purpose_projection_bytes: validated.budget.envelope_bytes,
    purpose_rebuild_performed: true,
    purpose_is_authoritative_for_mutation: false,
    canonical_owner_receipt_is_mutation_evidence: true,
    stale_fallback_allowed: false,
  });
}

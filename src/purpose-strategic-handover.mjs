import { STRATEGIC_DIRECTION_OWNERS } from './purpose-strategic-mutation-boundary.mjs';

export const PURPOSE_STRATEGIC_HANDOVER_VERSION = 'gateway.purpose-strategic-handover.v1';
const OWNER_STATUS_FIELDS = new Set(['schema_version', 'scope', 'owner', 'record']);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function normalizeOwnerStatus(status, scope) {
  requireObject(status, 'direction-owner status');
  for (const key of Object.keys(status)) {
    if (!OWNER_STATUS_FIELDS.has(key)) throw new TypeError(`direction-owner status contains unsupported authority field: ${key}`);
  }
  if (status.schema_version !== 1) throw new TypeError('unsupported direction-owner schema version');
  if (status.scope !== scope) throw new TypeError('direction-owner status scope does not match transfer scope');
  if (!STRATEGIC_DIRECTION_OWNERS.has(status.owner)) throw new TypeError('direction-owner status must name os or brain');
  if (status.record !== null && (typeof status.record !== 'object' || Array.isArray(status.record))) {
    throw new TypeError('direction-owner record must be an object or null');
  }
  if (status.record && status.record.owner !== status.owner) throw new TypeError('direction-owner record owner does not match current owner');
  return Object.freeze({ schema_version: 1, scope, owner: status.owner, record: status.record ?? null });
}

function transferTargetFromText(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) throw new TypeError('direction-owner transfer requires explicit destination owner');

  const brain = [
    /\b(?:to|into)\s+(?:ai[- ]verse\s+)?brain\b/,
    /\bmake\s+(?:ai[- ]verse\s+)?brain\b[^.]{0,80}\b(?:direction|strategic)\s+owner\b/,
    /\b(?:direction|strategic)\s+owner\b[^.]{0,80}\b(?:to|is|=)\s*(?:ai[- ]verse\s+)?brain\b/,
  ].some((pattern) => pattern.test(value));
  const os = [
    /\b(?:back\s+)?to\s+(?:ai[- ]verse\s+)?os\b/,
    /\bhand\s+back\b[^.]{0,80}\b(?:ai[- ]verse\s+)?os\b/,
    /\bmake\s+(?:ai[- ]verse\s+)?os\b[^.]{0,80}\b(?:direction|strategic)\s+owner\b/,
    /\b(?:direction|strategic)\s+owner\b[^.]{0,80}\b(?:to|is|=)\s*(?:ai[- ]verse\s+)?os\b/,
  ].some((pattern) => pattern.test(value));

  if (brain === os) throw new TypeError('direction-owner transfer destination must resolve to exactly one of os or brain');
  return brain ? 'brain' : 'os';
}

function assertSuccessfulTransferReceipt(envelope) {
  requireObject(envelope, 'owner receipt envelope');
  if (envelope.state !== 'owner_effect_succeeded' || envelope.mutation_executed !== true || envelope.purpose_rebuild_allowed !== true) {
    throw new TypeError('direction-owner transfer verification requires proven canonical-owner success');
  }
  const operation = requireObject(envelope.owner_operation, 'owner operation');
  const proposal = requireObject(operation.proposal, 'owner operation proposal');
  if (proposal.change_kind !== 'direction_owner_transfer') throw new TypeError('handover verification only applies to direction-owner transfers');
  if (proposal.operation_kind !== 'transfer' && proposal.operation_kind !== 'set' && proposal.operation_kind !== 'update') {
    throw new TypeError('unsupported direction-owner transfer operation kind');
  }
  if (!STRATEGIC_DIRECTION_OWNERS.has(operation.target_owner)) throw new TypeError('transfer source owner must be os or brain');
  if (operation.scope !== proposal.scope || envelope.scope !== operation.scope) throw new TypeError('transfer scope binding is inconsistent');
  if (!envelope.owner_receipt?.receipt_id) throw new TypeError('direction-owner transfer requires canonical owner receipt evidence');
  return { operation, proposal };
}

export function strategicDirectionTransferTarget(proposal) {
  requireObject(proposal, 'strategic proposal');
  if (proposal.change_kind !== 'direction_owner_transfer') return null;
  return transferTargetFromText(proposal.requested_change);
}

export async function verifyStrategicDirectionTransfer({ receiptEnvelope, readDirectionOwner } = {}) {
  const { operation, proposal } = assertSuccessfulTransferReceipt(receiptEnvelope);
  if (typeof readDirectionOwner !== 'function') throw new TypeError('readDirectionOwner must be an explicit current-owner reader');

  const previousOwner = operation.target_owner;
  const expectedOwner = strategicDirectionTransferTarget(proposal);
  if (expectedOwner === previousOwner) throw new TypeError('direction-owner transfer destination must differ from current owner');

  const current = normalizeOwnerStatus(await readDirectionOwner(operation.scope), operation.scope);
  if (current.owner !== expectedOwner) {
    throw new TypeError(`canonical direction-owner registry did not complete transfer to ${expectedOwner}`);
  }

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_HANDOVER_VERSION,
    state: expectedOwner === 'brain' ? 'handover_verified' : 'handback_verified',
    scope: operation.scope,
    previous_owner: previousOwner,
    current_owner: expectedOwner,
    owner_receipt_id: receiptEnvelope.owner_receipt.receipt_id,
    current_direction_owner: current,
    owner_registry_is_authoritative: true,
    brain_unavailability_returns_authority_to_os: false,
    purpose_may_reflect_new_owner: true,
  });
}

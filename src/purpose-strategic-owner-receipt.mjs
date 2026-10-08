export const PURPOSE_STRATEGIC_OWNER_RECEIPT_VERSION = 'gateway.purpose-strategic-owner-receipt.v1';

const OWNER_RECEIPT_FIELDS = new Set([
  'schema_version',
  'owner',
  'scope',
  'operation_id',
  'request_id',
  'idempotency_key',
  'operation_fingerprint',
  'status',
  'receipt_id',
  'effect_occurred',
  'duplicate',
]);

function assertOwnerOperation(ownerOperation) {
  if (!ownerOperation || typeof ownerOperation !== 'object' || Array.isArray(ownerOperation)) {
    throw new TypeError('strategic owner operation must be an object');
  }
  if (ownerOperation.state !== 'owner_operation_ready') {
    throw new TypeError('strategic owner operation must be ready');
  }
  if (!['os', 'brain'].includes(ownerOperation.target_owner)) {
    throw new TypeError('strategic owner operation target_owner must be os or brain');
  }
  for (const key of ['scope', 'operation_id', 'request_id', 'idempotency_key', 'operation_fingerprint']) {
    if (typeof ownerOperation[key] !== 'string' || !ownerOperation[key]) {
      throw new TypeError(`strategic owner operation ${key} is required`);
    }
  }
  if (ownerOperation.request_id !== ownerOperation.operation_id) {
    throw new TypeError('strategic owner operation request_id must preserve operation_id');
  }
  if (ownerOperation.owner_receipt !== null || ownerOperation.mutation_executed !== false || ownerOperation.purpose_rebuild_allowed !== false) {
    throw new TypeError('strategic owner operation must be unexecuted and receipt-free before dispatch');
  }
}

function normalizeOwnerReceipt(raw, ownerOperation) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('canonical owner execution must return an owner receipt object');
  }
  for (const key of Object.keys(raw)) {
    if (!OWNER_RECEIPT_FIELDS.has(key)) {
      throw new TypeError(`unsupported owner receipt field: ${key}`);
    }
  }
  if (raw.schema_version !== 1) throw new TypeError('unsupported owner receipt schema version');
  if (raw.owner !== ownerOperation.target_owner) throw new TypeError('owner receipt owner does not match the routed canonical owner');
  if (raw.scope !== ownerOperation.scope) throw new TypeError('owner receipt scope does not match the owner operation');
  if (raw.operation_id !== ownerOperation.operation_id || raw.request_id !== ownerOperation.request_id) {
    throw new TypeError('owner receipt operation/request ID does not match the owner operation');
  }
  if (raw.idempotency_key !== ownerOperation.idempotency_key) {
    throw new TypeError('owner receipt idempotency key does not match the owner operation');
  }
  if (raw.operation_fingerprint !== ownerOperation.operation_fingerprint) {
    throw new TypeError('owner receipt fingerprint does not match the exact owner operation');
  }
  if (!['succeeded', 'failed', 'uncertain'].includes(raw.status)) {
    throw new TypeError('owner receipt status must be succeeded, failed, or uncertain');
  }
  if (raw.duplicate !== undefined && typeof raw.duplicate !== 'boolean') {
    throw new TypeError('owner receipt duplicate must be boolean when supplied');
  }

  if (raw.status === 'succeeded') {
    if (typeof raw.receipt_id !== 'string' || !raw.receipt_id.trim()) {
      throw new TypeError('successful canonical owner effect requires a non-empty owner receipt_id');
    }
    if (raw.effect_occurred !== true) {
      throw new TypeError('successful canonical owner receipt must prove effect_occurred=true');
    }
  }
  if (raw.status === 'failed' && raw.effect_occurred !== false) {
    throw new TypeError('failed canonical owner receipt must prove effect_occurred=false; otherwise outcome is uncertain');
  }
  if (raw.status === 'uncertain' && ![true, false, null, undefined].includes(raw.effect_occurred)) {
    throw new TypeError('uncertain owner receipt effect_occurred must be true, false, null, or omitted');
  }

  return Object.freeze({
    schema_version: 1,
    owner: raw.owner,
    scope: raw.scope,
    operation_id: raw.operation_id,
    request_id: raw.request_id,
    idempotency_key: raw.idempotency_key,
    operation_fingerprint: raw.operation_fingerprint,
    status: raw.status,
    receipt_id: raw.receipt_id ?? null,
    effect_occurred: raw.effect_occurred ?? null,
    duplicate: raw.duplicate === true,
  });
}

export async function executeStrategicOwnerOperation({ ownerOperation, executeOwnerOperation } = {}) {
  assertOwnerOperation(ownerOperation);
  if (typeof executeOwnerOperation !== 'function') {
    throw new TypeError('executeOwnerOperation must be the canonical owner execution boundary');
  }

  const rawReceipt = await executeOwnerOperation(ownerOperation);
  const receipt = normalizeOwnerReceipt(rawReceipt, ownerOperation);
  const succeeded = receipt.status === 'succeeded' && receipt.effect_occurred === true;

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_OWNER_RECEIPT_VERSION,
    state: succeeded ? 'owner_effect_succeeded' : receipt.status === 'failed' ? 'owner_effect_failed' : 'owner_effect_uncertain',
    scope: ownerOperation.scope,
    target_owner: ownerOperation.target_owner,
    operation: ownerOperation,
    owner_receipt: receipt,
    receipt_source: 'canonical_owner',
    mutation_executed: succeeded,
    purpose_rebuild_allowed: succeeded,
  });
}

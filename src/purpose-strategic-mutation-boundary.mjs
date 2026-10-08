export const PURPOSE_STRATEGIC_MUTATION_BOUNDARY_VERSION = 'gateway.purpose-strategic-mutation-boundary.v1';
export const CANONICAL_STRATEGIC_DIRECTION_SURFACE = 'canonical_strategic_direction';
export const STRATEGIC_DIRECTION_OWNERS = Object.freeze(new Set(['os', 'brain']));

const FORBIDDEN_WRITABLE_KEYS = new Set([
  'purpose_context',
  'purpose_projection',
  'projection',
  'projection_write',
  'purpose_write',
  'purpose_store',
  'canonical_copy',
  'duplicate_store',
]);

const TARGET_DECLARATION_KEYS = new Set([
  'target_surface',
  'mutation_target',
  'write_target',
  'target_kind',
  'target_type',
  'store',
  'write_store',
]);

function normalizedTargetValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replaceAll('-', '_') : null;
}

function declaresPurposeOrProjectionTarget(key, value) {
  if (!TARGET_DECLARATION_KEYS.has(key)) return false;
  const normalized = normalizedTargetValue(value);
  if (!normalized) return false;
  return normalized.includes('purpose') || normalized.includes('projection');
}

function assertCommonBoundary(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new TypeError('strategic mutation proposal must be an object');
  }
  if (proposal.state !== 'proposed') {
    throw new TypeError('strategic mutation proposal state must be proposed');
  }
  if (proposal.target_surface !== CANONICAL_STRATEGIC_DIRECTION_SURFACE) {
    throw new TypeError('strategic mutation proposal target must be canonical strategic direction, never Purpose projection state');
  }
  if (proposal.requires_explicit_confirmation !== true || proposal.confirmation_state !== 'required_not_confirmed') {
    throw new TypeError('strategic mutation proposal must remain unconfirmed');
  }
  if (proposal.apply_allowed !== false || proposal.mutation_executed !== false) {
    throw new TypeError('strategic mutation proposal cannot be executable before explicit confirmation');
  }

  for (const [key, value] of Object.entries(proposal)) {
    if (FORBIDDEN_WRITABLE_KEYS.has(key)) {
      throw new TypeError(`strategic mutation proposal cannot carry writable projection/store field: ${key}`);
    }
    if (declaresPurposeOrProjectionTarget(key, value)) {
      throw new TypeError(`strategic mutation proposal cannot target Purpose/projection surface through ${key}`);
    }
  }
}

function boundaryResult({ routed }) {
  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_MUTATION_BOUNDARY_VERSION,
    valid: true,
    target_surface: CANONICAL_STRATEGIC_DIRECTION_SURFACE,
    purpose_projection_mutable: false,
    second_truth_store_allowed: false,
    canonical_owner_required: true,
    owner_routing_allowed_at_this_stage: routed,
    mutation_execution_allowed_at_this_stage: false,
  });
}

export function assertStrategicMutationProposalBoundary(proposal) {
  assertCommonBoundary(proposal);
  if (proposal.target_owner !== null) {
    throw new TypeError('strategic mutation proposal owner routing must remain unresolved until Slice 8.1 Task 4');
  }
  if (proposal.routing_state !== 'unresolved_until_current_direction_owner_read') {
    throw new TypeError('strategic mutation proposal routing must remain unresolved');
  }
  return boundaryResult({ routed: false });
}

export function assertRoutedStrategicMutationBoundary(proposal) {
  assertCommonBoundary(proposal);
  if (!STRATEGIC_DIRECTION_OWNERS.has(proposal.target_owner)) {
    throw new TypeError('routed strategic mutation proposal target_owner must be the current canonical direction owner');
  }
  if (proposal.routing_state !== 'routed_by_current_direction_owner') {
    throw new TypeError('routed strategic mutation proposal must prove current direction-owner routing');
  }
  if (!proposal.direction_owner || typeof proposal.direction_owner !== 'object' || Array.isArray(proposal.direction_owner)) {
    throw new TypeError('routed strategic mutation proposal requires direction-owner evidence');
  }
  if (
    proposal.direction_owner.schema_version !== 1
    || proposal.direction_owner.scope !== proposal.scope
    || proposal.direction_owner.owner !== proposal.target_owner
  ) {
    throw new TypeError('direction-owner evidence must match the exact proposal scope and target owner');
  }
  return boundaryResult({ routed: true });
}

import {
  assertRoutedStrategicMutationBoundary,
  assertStrategicMutationProposalBoundary,
  STRATEGIC_DIRECTION_OWNERS,
} from './purpose-strategic-mutation-boundary.mjs';

export const PURPOSE_STRATEGIC_ROUTING_VERSION = 'gateway.purpose-strategic-routing.v1';
const OWNER_STATUS_FIELDS = new Set(['schema_version', 'scope', 'owner', 'record']);

function assertProposalEnvelope(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('strategic proposal envelope must be an object');
  }
  if (result.state !== 'proposed' || !result.proposal) {
    throw new TypeError('only a proposed strategic mutation can be owner-routed');
  }
  assertStrategicMutationProposalBoundary(result.proposal);
  if (result.scope !== result.proposal.scope) {
    throw new TypeError('strategic proposal envelope scope must match its proposal');
  }
}

function normalizeOwnerStatus(status, scope) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new TypeError('direction-owner reader must return an owner status object');
  }
  for (const key of Object.keys(status)) {
    if (!OWNER_STATUS_FIELDS.has(key)) {
      throw new TypeError(`direction-owner status contains unsupported authority field: ${key}`);
    }
  }
  if (status.schema_version !== 1) {
    throw new TypeError('unsupported direction-owner schema version');
  }
  if (status.scope !== scope) {
    throw new TypeError('direction-owner status scope does not match the strategic proposal scope');
  }
  if (!STRATEGIC_DIRECTION_OWNERS.has(status.owner)) {
    throw new TypeError('direction-owner status must name os or brain');
  }
  if (status.record !== null && (typeof status.record !== 'object' || Array.isArray(status.record))) {
    throw new TypeError('direction-owner record must be an object or null');
  }
  if (status.record && status.record.owner !== status.owner) {
    throw new TypeError('direction-owner record owner does not match current owner');
  }
  return Object.freeze({
    schema_version: 1,
    scope,
    owner: status.owner,
    record: status.record ?? null,
  });
}

export async function routeStrategicOwnerMutation({ proposalEnvelope, readDirectionOwner } = {}) {
  assertProposalEnvelope(proposalEnvelope);
  if (typeof readDirectionOwner !== 'function') {
    throw new TypeError('readDirectionOwner must be an explicit current-owner reader');
  }

  const scope = proposalEnvelope.scope;
  const ownerStatus = normalizeOwnerStatus(await readDirectionOwner(scope), scope);
  const proposal = Object.freeze({
    ...proposalEnvelope.proposal,
    target_owner: ownerStatus.owner,
    routing_state: 'routed_by_current_direction_owner',
    direction_owner: ownerStatus,
  });
  const boundary = assertRoutedStrategicMutationBoundary(proposal);

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_ROUTING_VERSION,
    state: 'routed',
    scope,
    intent: proposalEnvelope.intent,
    proposal,
    direction_owner: ownerStatus,
    boundary,
  });
}

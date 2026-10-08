import crypto from 'node:crypto';

import {
  assertConfirmedStrategicMutationBoundary,
  assertRoutedStrategicMutationBoundary,
} from './purpose-strategic-mutation-boundary.mjs';

export const PURPOSE_STRATEGIC_CONFIRMATION_VERSION = 'gateway.purpose-strategic-confirmation.v1';
const CONFIRMATION_FIELDS = new Set([
  'authority',
  'scope',
  'target_owner',
  'proposal_fingerprint',
  'granted_by',
  'confirmed_at',
]);

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

export function strategicProposalFingerprint(proposal) {
  assertRoutedStrategicMutationBoundary(proposal);
  return crypto.createHash('sha256').update(canonicalJson(proposal)).digest('hex');
}

function normalizeExplicitUserConfirmation(confirmation, proposal) {
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
    throw new TypeError('explicit strategic confirmation is required');
  }
  for (const key of Object.keys(confirmation)) {
    if (!CONFIRMATION_FIELDS.has(key)) {
      throw new TypeError(`unsupported strategic confirmation field: ${key}`);
    }
  }
  if (confirmation.authority !== 'explicit_user') {
    throw new TypeError('strategic confirmation authority must be explicit_user');
  }
  if (confirmation.scope !== proposal.scope || confirmation.target_owner !== proposal.target_owner) {
    throw new TypeError('strategic confirmation scope/owner does not match the routed proposal');
  }
  const expected = strategicProposalFingerprint(proposal);
  if (confirmation.proposal_fingerprint !== expected) {
    throw new TypeError('strategic confirmation fingerprint does not match the exact routed proposal');
  }
  if (typeof confirmation.granted_by !== 'string' || !confirmation.granted_by.trim()) {
    throw new TypeError('strategic confirmation must identify the granting user');
  }
  if (typeof confirmation.confirmed_at !== 'string' || !Number.isFinite(Date.parse(confirmation.confirmed_at))) {
    throw new TypeError('strategic confirmation confirmed_at must be a valid timestamp');
  }
  return Object.freeze({
    authority: 'explicit_user',
    scope: proposal.scope,
    target_owner: proposal.target_owner,
    proposal_fingerprint: expected,
    granted_by: confirmation.granted_by.trim(),
    confirmed_at: confirmation.confirmed_at,
  });
}

export function confirmStrategicOwnerMutation({ routedEnvelope, confirmation } = {}) {
  if (!routedEnvelope || typeof routedEnvelope !== 'object' || Array.isArray(routedEnvelope)) {
    throw new TypeError('routed strategic mutation envelope must be an object');
  }
  if (routedEnvelope.state !== 'routed' || !routedEnvelope.proposal) {
    throw new TypeError('only a current-owner-routed strategic proposal can be confirmed');
  }
  assertRoutedStrategicMutationBoundary(routedEnvelope.proposal);
  if (routedEnvelope.scope !== routedEnvelope.proposal.scope) {
    throw new TypeError('routed strategic envelope scope must match its proposal');
  }

  const evidence = normalizeExplicitUserConfirmation(confirmation, routedEnvelope.proposal);
  const proposal = Object.freeze({
    ...routedEnvelope.proposal,
    confirmation_state: 'explicit_user_confirmed',
    confirmation: evidence,
  });
  const boundary = assertConfirmedStrategicMutationBoundary(proposal);

  return Object.freeze({
    api_version: PURPOSE_STRATEGIC_CONFIRMATION_VERSION,
    state: 'confirmed',
    scope: routedEnvelope.scope,
    intent: routedEnvelope.intent,
    proposal,
    direction_owner: routedEnvelope.direction_owner,
    confirmation: evidence,
    boundary,
    owner_operation_required: true,
    owner_operation_built: false,
    apply_allowed: false,
    mutation_executed: false,
  });
}

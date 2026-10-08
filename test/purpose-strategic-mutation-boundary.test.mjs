import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeStrategicOwnerMutation } from '../src/purpose-strategic-change.mjs';
import {
  assertStrategicMutationProposalBoundary,
  CANONICAL_STRATEGIC_DIRECTION_SURFACE,
  PURPOSE_STRATEGIC_MUTATION_BOUNDARY_VERSION,
} from '../src/purpose-strategic-mutation-boundary.mjs';

function validProposal() {
  const result = proposeStrategicOwnerMutation({
    text: 'Change our purpose to build dependable AI operations.',
    scope: 'workspace:alpha',
  });
  assert.equal(result.state, 'proposed');
  return result;
}

test('valid strategic proposal proves Purpose remains non-writable even when requested text mentions purpose', () => {
  const result = validProposal();
  assert.equal(result.proposal.requested_change.includes('purpose'), true);
  assert.equal(result.proposal.target_surface, CANONICAL_STRATEGIC_DIRECTION_SURFACE);
  assert.equal(result.boundary.api_version, PURPOSE_STRATEGIC_MUTATION_BOUNDARY_VERSION);
  assert.equal(result.boundary.valid, true);
  assert.equal(result.boundary.purpose_projection_mutable, false);
  assert.equal(result.boundary.second_truth_store_allowed, false);
  assert.equal(result.boundary.canonical_owner_required, true);
  assert.equal(result.boundary.owner_routing_allowed_at_this_stage, false);
  assert.equal(result.boundary.mutation_execution_allowed_at_this_stage, false);
});

test('boundary rejects Purpose, projection, or duplicate-store mutation targets', () => {
  const base = validProposal().proposal;
  const invalidVariants = [
    { ...base, target_surface: 'purpose_context' },
    { ...base, target_surface: 'purpose_projection' },
    { ...base, target_surface: 'projection' },
    { ...base, purpose_context: {} },
    { ...base, purpose_projection: {} },
    { ...base, projection: {} },
    { ...base, purpose_store: 'canonical' },
    { ...base, canonical_copy: {} },
    { ...base, duplicate_store: {} },
    { ...base, mutation_target: 'purpose_projection' },
    { ...base, write_target: 'purpose_context' },
    { ...base, write_store: 'purpose' },
  ];

  for (const proposal of invalidVariants) {
    assert.throws(
      () => assertStrategicMutationProposalBoundary(proposal),
      /Purpose|projection|store|target/i,
      JSON.stringify(proposal),
    );
  }
});

test('boundary also rejects premature owner routing, confirmation, or execution', () => {
  const base = validProposal().proposal;
  const invalidVariants = [
    { ...base, target_owner: 'ai-verse-purpose' },
    { ...base, target_owner: 'ai-verse-brain' },
    { ...base, routing_state: 'routed' },
    { ...base, confirmation_state: 'confirmed' },
    { ...base, requires_explicit_confirmation: false },
    { ...base, apply_allowed: true },
    { ...base, mutation_executed: true },
  ];

  for (const proposal of invalidVariants) {
    assert.throws(
      () => assertStrategicMutationProposalBoundary(proposal),
      /owner|routing|confirm|executable|proposal/i,
      JSON.stringify(proposal),
    );
  }
});

test('valid proposal carries no writable Purpose or duplicate truth-store fields', () => {
  const result = validProposal();
  const forbidden = [
    'purpose_context',
    'purpose_projection',
    'projection',
    'projection_write',
    'purpose_write',
    'purpose_store',
    'canonical_copy',
    'duplicate_store',
    'mutation_target',
    'write_target',
    'write_store',
  ];
  for (const key of forbidden) {
    assert.equal(Object.hasOwn(result.proposal, key), false, key);
  }
  assert.equal(result.proposal.target_owner, null);
  assert.equal(result.proposal.routing_state, 'unresolved_until_current_direction_owner_read');
  assert.equal(result.proposal.apply_allowed, false);
  assert.equal(result.proposal.mutation_executed, false);
});

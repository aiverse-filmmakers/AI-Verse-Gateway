import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PURPOSE_REFRESH_POLICY_VERSION,
  purposeRefreshDecision,
} from '../src/purpose-runtime-policy.mjs';
import {
  classifyPurposeRelevance,
  gatePurposeOwnerRead,
} from '../src/purpose-relevance.mjs';

test('Purpose refresh policy requires fresh owner reads only for relevant assemblies', () => {
  const relevant = purposeRefreshDecision(classifyPurposeRelevance('what should I work on next?'));
  assert.equal(relevant.api_version, PURPOSE_REFRESH_POLICY_VERSION);
  assert.equal(relevant.refresh_required, true);
  assert.equal(relevant.cache_reuse_allowed, false);
  assert.equal(relevant.reason, 'relevant_context_assembly');

  const irrelevant = purposeRefreshDecision(classifyPurposeRelevance('Format this JSON.'));
  assert.equal(irrelevant.api_version, PURPOSE_REFRESH_POLICY_VERSION);
  assert.equal(irrelevant.refresh_required, false);
  assert.equal(irrelevant.cache_reuse_allowed, false);
  assert.equal(irrelevant.reason, 'irrelevant_task');
});

test('each relevant read-gate invocation performs a fresh owner read instead of reusing a Gateway projection cache', async () => {
  let reads = 0;
  const readPurpose = async () => {
    reads += 1;
    return { projection_generation: reads };
  };

  const first = await gatePurposeOwnerRead('why are we doing this?', readPurpose);
  const second = await gatePurposeOwnerRead('why are we doing this?', readPurpose);

  assert.equal(reads, 2);
  assert.equal(first.refresh.api_version, PURPOSE_REFRESH_POLICY_VERSION);
  assert.equal(first.refresh.refresh_required, true);
  assert.equal(first.refresh.cache_reuse_allowed, false);
  assert.equal(second.refresh.refresh_required, true);
  assert.equal(first.value.projection_generation, 1);
  assert.equal(second.value.projection_generation, 2);
});

test('irrelevant assemblies do not refresh or read Purpose', async () => {
  let reads = 0;
  const result = await gatePurposeOwnerRead('Rename this file.', async () => {
    reads += 1;
    return { unexpected: true };
  });

  assert.equal(reads, 0);
  assert.equal(result.read_performed, false);
  assert.equal(result.refresh.api_version, PURPOSE_REFRESH_POLICY_VERSION);
  assert.equal(result.refresh.refresh_required, false);
  assert.equal(result.refresh.cache_reuse_allowed, false);
  assert.equal(result.refresh.reason, 'irrelevant_task');
});

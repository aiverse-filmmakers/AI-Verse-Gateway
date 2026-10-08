import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayError } from '../src/errors.mjs';
import { gatePurposeOwnerRead } from '../src/purpose-relevance.mjs';
import {
  PURPOSE_PRECEDENCE_POLICY_VERSION,
  selectPurposeRuntimeProjection,
} from '../src/purpose-runtime-policy.mjs';

test('fresh OS owner projection always outranks stale cached UI/output Purpose', () => {
  const fresh = { provenance: { projection_owner: 'ai-verse-os' }, generated: 'fresh' };
  const stale = { provenance: { projection_owner: 'ui-cache' }, generated: 'stale' };
  const selected = selectPurposeRuntimeProjection(fresh, stale);

  assert.equal(selected.api_version, PURPOSE_PRECEDENCE_POLICY_VERSION);
  assert.equal(selected.projection, fresh);
  assert.equal(selected.source, 'fresh_owner_read');
  assert.equal(selected.fresh_owner_present, true);
  assert.equal(selected.cached_candidate_present, true);
  assert.equal(selected.cached_candidate_ignored, true);
  assert.equal(selected.stale_fallback_allowed, false);
});

test('relevant read gate returns the fresh owner projection even when a stale cached candidate is supplied', async () => {
  const fresh = { generation: 2, provenance: { projection_owner: 'ai-verse-os' } };
  const stale = { generation: 1, provenance: { projection_owner: 'cached-ui' } };
  const result = await gatePurposeOwnerRead(
    'why are we doing this?',
    async () => fresh,
    { cachedPurposeProjection: stale },
  );

  assert.equal(result.state, 'read');
  assert.equal(result.value, fresh);
  assert.equal(result.precedence.source, 'fresh_owner_read');
  assert.equal(result.precedence.cached_candidate_ignored, true);
  assert.notEqual(result.value, stale);
});

test('owner unavailability never promotes stale cached UI/output Purpose into runtime context', async () => {
  const stale = { generation: 1, provenance: { projection_owner: 'cached-ui' } };
  const result = await gatePurposeOwnerRead(
    'what should I work on next?',
    async () => { throw new GatewayError('ADAPTER_TIMEOUT', 'owner unavailable', 504); },
    { cachedPurposeProjection: stale },
  );

  assert.equal(result.state, 'unavailable');
  assert.equal(result.value, null);
  assert.equal(result.precedence.source, 'none');
  assert.equal(result.precedence.cached_candidate_present, true);
  assert.equal(result.precedence.cached_candidate_ignored, true);
  assert.equal(result.precedence.stale_fallback_allowed, false);
});

test('irrelevant tasks ignore cached Purpose and still perform zero owner reads', async () => {
  let reads = 0;
  const stale = { generation: 1 };
  const result = await gatePurposeOwnerRead(
    'Format this JSON.',
    async () => { reads += 1; return { generation: 2 }; },
    { cachedPurposeProjection: stale },
  );

  assert.equal(reads, 0);
  assert.equal(result.state, 'skipped');
  assert.equal(result.value, null);
  assert.equal(result.precedence.cached_candidate_ignored, true);
});

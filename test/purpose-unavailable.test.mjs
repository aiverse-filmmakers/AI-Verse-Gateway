import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayError } from '../src/errors.mjs';
import { assembleProgressiveOwnerContext } from '../src/progressive-context.mjs';
import { gatePurposeOwnerRead } from '../src/purpose-relevance.mjs';
import {
  PURPOSE_UNAVAILABLE_POLICY_VERSION,
  purposeUnavailableDecision,
} from '../src/purpose-runtime-policy.mjs';

function hostWithUnavailablePurpose(code = 'ADAPTER_TIMEOUT') {
  return {
    async describe() { return { adapter_id: 'fixture', metadata: {}, operations: [] }; },
    async readContext(scope) { return { scope, current_context: 'ordinary current context remains available' }; },
    async listCapabilities() { return []; },
    async listConnections() { return []; },
    async retrieveHistory() { return []; },
    async readPurposeContext() { throw new GatewayError(code, 'Purpose owner unavailable', 502); },
  };
}

test('classifies only owner/process availability failures as degradable', () => {
  for (const code of ['PURPOSE_OWNER_UNAVAILABLE', 'ADAPTER_TIMEOUT', 'ADAPTER_FAILED', 'ADAPTER_INVALID_JSON', 'ENOENT', 'EACCES']) {
    const result = purposeUnavailableDecision({ code });
    assert.equal(result.api_version, PURPOSE_UNAVAILABLE_POLICY_VERSION);
    assert.equal(result.owner_unavailable, true, code);
    assert.equal(result.ordinary_task_may_continue, true, code);
    assert.equal(result.stale_fallback_allowed, false, code);
    assert.equal(result.error_code, code);
  }

  for (const code of ['PURPOSE_SCOPE_MISMATCH', 'PURPOSE_OWNER_MISMATCH', 'PURPOSE_CONTEXT_BUDGET_EXCEEDED']) {
    const result = purposeUnavailableDecision({ code });
    assert.equal(result.owner_unavailable, false, code);
    assert.equal(result.ordinary_task_may_continue, false, code);
    assert.equal(result.stale_fallback_allowed, false, code);
  }
});

test('relevant read gate records Purpose unavailable without returning stale state', async () => {
  const result = await gatePurposeOwnerRead('what should I work on next?', async () => {
    throw new GatewayError('ADAPTER_TIMEOUT', 'Purpose owner timed out', 504);
  });

  assert.equal(result.state, 'unavailable');
  assert.equal(result.read_performed, false);
  assert.equal(result.skip_reason, 'purpose_owner_unavailable');
  assert.equal(result.value, null);
  assert.equal(result.unavailable.owner_unavailable, true);
  assert.equal(result.unavailable.stale_fallback_allowed, false);
});

test('ordinary runtime assembly continues when Purpose owner is unavailable and injects no substitute Purpose', async () => {
  const scope = 'workspace:alpha';
  const assembled = await assembleProgressiveOwnerContext({
    host: hostWithUnavailablePurpose(),
    store: null,
    run: {
      system_id: 'system-fixture',
      principal: 'principal-fixture',
      workspace_id: 'alpha',
      messages: [{ role: 'user', content: 'what should I work on next?' }],
    },
    scope,
    query: 'what should I work on next?',
    signal: null,
  });

  assert.equal(assembled.safe.current_context.current_context, 'ordinary current context remains available');
  assert.equal(Object.hasOwn(assembled.safe, 'purpose_context'), false);
  assert.equal(assembled.diagnostics.purpose.state, 'unavailable');
  assert.equal(assembled.diagnostics.purpose.skip_reason, 'purpose_owner_unavailable');
  assert.equal(assembled.diagnostics.purpose.projection_bytes, 0);
  assert.equal(assembled.diagnostics.purpose.projection_owner, null);
});

test('contract violations still fail closed instead of being relabeled unavailable', async () => {
  await assert.rejects(
    gatePurposeOwnerRead('why are we doing this?', async () => {
      throw new GatewayError('PURPOSE_SCOPE_MISMATCH', 'wrong scope', 502);
    }),
    (error) => error?.code === 'PURPOSE_SCOPE_MISMATCH',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HostClient } from '../src/host-adapter.mjs';
import {
  PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES,
  PURPOSE_RUNTIME_POLICY_VERSION,
  assertPurposeRuntimeEnvelopeSize,
} from '../src/purpose-runtime-policy.mjs';
import { stableStringify } from '../src/util.mjs';

function serializedBytes(value) {
  return Buffer.byteLength(stableStringify(value ?? null), 'utf8');
}

async function ownerFixture({ oversized = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiverse-purpose-envelope-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  const script = `
const value = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const scope = value('--scope');
const maxBytes = value('--max-bytes');
const projection = {
  schema_version: '1.0',
  scope,
  scope_kind: scope === 'operator' ? 'operator' : 'workspace',
  identity: scope === 'operator' ? { kind: 'operator', id: 'operator' } : { kind: 'workspace', id: scope.slice('workspace:'.length) },
  requested_max_bytes: maxBytes,
  provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-08T18:00:00.000Z', owner_reads: [] },
  ${oversized ? "padding: 'x'.repeat(20000)," : "goals: [{ kind: 'goal', statement: 'Stay within the runtime envelope' }],"}
};
process.stdout.write(JSON.stringify(projection));
`;
  await writeFile(path.join(root, 'scripts', 'purpose-context.mjs'), script, 'utf8');
  const configPath = path.join(root, 'host.json');
  await writeFile(configPath, JSON.stringify({
    transport: 'json-subprocess',
    command: [process.execPath, 'unused-host.mjs'],
    cwd: root,
    timeout_seconds: 10,
    max_stderr_bytes: 65536,
    env_names: [],
  }), 'utf8');
  return { root, configPath };
}

test('freezes the runtime Purpose envelope maximum at 16 KiB', () => {
  assert.equal(PURPOSE_RUNTIME_POLICY_VERSION, 'gateway.purpose-runtime-policy.v1');
  assert.equal(PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES, 16384);
  const atLimit = { payload: 'x'.repeat(16000) };
  const measured = assertPurposeRuntimeEnvelopeSize(atLimit, serializedBytes);
  assert.equal(measured.api_version, PURPOSE_RUNTIME_POLICY_VERSION);
  assert.equal(measured.max_envelope_bytes, 16384);
  assert.equal(measured.within_budget, measured.envelope_bytes <= 16384);
});

test('Gateway requests the same 16 KiB maximum from the OS Purpose owner', async () => {
  const fixture = await ownerFixture();
  const client = new HostClient(fixture.configPath);
  const projection = await client.readPurposeContext('workspace:alpha');
  assert.equal(projection.requested_max_bytes, String(PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES));
  assert.ok(serializedBytes(projection) <= PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES);
  assert.equal(projection.provenance.projection_owner, 'ai-verse-os');
});

test('Gateway rejects oversized Purpose owner output instead of silently admitting it', async () => {
  const fixture = await ownerFixture({ oversized: true });
  const client = new HostClient(fixture.configPath);
  await assert.rejects(
    client.readPurposeContext('workspace:alpha'),
    (error) => error?.code === 'PURPOSE_CONTEXT_BUDGET_EXCEEDED' && /16384/.test(error.message),
  );
});

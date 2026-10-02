import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  doctorComponent,
  installComponent,
  setEnabled,
  setupComponent,
  statusComponent,
  uninstallComponent
} from "../src/lifecycle.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";
import { paths } from "../src/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureHost = path.resolve(here, "..", "fixtures", "fake-host.mjs");

async function fixture(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `aiverse-gateway-lifecycle-system-${label}-`));
  const home = await mkdtemp(path.join(os.tmpdir(), `aiverse-gateway-lifecycle-home-${label}-`));
  await writeFile(path.join(root, "AI-VERSE.yaml"), "schema_version: 2.0\n", "utf8");

  const hostConfig = path.join(root, "host.json");
  await writeFile(hostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, fixtureHost],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: root
  }), "utf8");

  const incompatibleHostScript = path.join(root, "incompatible-host.mjs");
  await writeFile(incompatibleHostScript, `
const input = JSON.parse(await new Promise((resolve) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => body += chunk);
  process.stdin.on("end", () => resolve(body));
}));
process.stdout.write(JSON.stringify({
  protocol: input.protocol,
  request_id: input.request_id,
  ok: true,
  result: {
    adapter_id: "fixture:incompatible",
    protocol_version: "1.0",
    metadata: { canonical_state_owned: true }
  }
}));
`, "utf8");

  const incompatibleHostConfig = path.join(root, "incompatible-host.json");
  await writeFile(incompatibleHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, incompatibleHostScript],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: root
  }), "utf8");

  return { root, home, hostConfig, incompatibleHostConfig };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json()
  };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

test("WSA-2026-007 setup validates before publication and preserves the prior ready setup on failure", async () => {
  const f = await fixture("setup-rollback");
  try {
    await installComponent({ home: f.home });
    const first = await setupComponent({
      home: f.home,
      system_root: f.root,
      host_config: f.hostConfig,
      runtime: "deterministic"
    });
    assert.equal(first.state, "ready");

    const p = paths(f.home);
    const configBefore = await readFile(p.config, "utf8");
    const hostBefore = await readFile(p.host, "utf8");

    await rejectsCode(
      setupComponent({
        home: f.home,
        system_root: f.root,
        host_config: f.incompatibleHostConfig,
        runtime: "deterministic"
      }),
      "HOST_INCOMPATIBLE"
    );

    assert.equal(await readFile(p.config, "utf8"), configBefore);
    assert.equal(await readFile(p.host, "utf8"), hostBefore);
    assert.equal((await statusComponent({ home: f.home })).state, "ready");
    assert.equal((await doctorComponent({ home: f.home })).state, "ready");

    const freshHome = await mkdtemp(path.join(os.tmpdir(), "aiverse-gateway-lifecycle-failed-fresh-"));
    try {
      await installComponent({ home: freshHome });
      await rejectsCode(
        setupComponent({
          home: freshHome,
          system_root: f.root,
          host_config: f.incompatibleHostConfig,
          runtime: "deterministic"
        }),
        "HOST_INCOMPATIBLE"
      );
      assert.equal((await statusComponent({ home: freshHome })).state, "setup-required");
      await assert.rejects(readFile(paths(freshHome).config, "utf8"), { code: "ENOENT" });
      await assert.rejects(readFile(paths(freshHome).host, "utf8"), { code: "ENOENT" });
    } finally {
      await rm(freshHome, { recursive: true, force: true });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.home, { recursive: true, force: true });
  }
});

test("WSA-2026-007 invalid remote setup never publishes ready configuration", async () => {
  const f = await fixture("remote-invalid");
  try {
    await installComponent({ home: f.home });
    await rejectsCode(
      setupComponent({
        home: f.home,
        system_root: f.root,
        host_config: f.hostConfig,
        runtime: "deterministic",
        listen_host: "0.0.0.0"
      }),
      "REMOTE_BIND_UNSAFE"
    );

    const p = paths(f.home);
    assert.equal((await statusComponent({ home: f.home })).state, "setup-required");
    assert.equal((await doctorComponent({ home: f.home })).state, "setup-required");
    await assert.rejects(readFile(p.config, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(p.host, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.home, { recursive: true, force: true });
  }
});

test("WSA-2026-007 live disable, enable, uninstall and restart follow one authoritative lifecycle state", async () => {
  const f = await fixture("live");
  let live = null;
  let restarted = null;
  try {
    await installComponent({ home: f.home });
    const setup = await setupComponent({
      home: f.home,
      system_root: f.root,
      host_config: f.hostConfig,
      runtime: "deterministic"
    });
    const originalConfig = await loadConfig(f.home);
    const originalGeneration = originalConfig.service_generation;
    assert.equal(typeof originalGeneration, "string");

    live = await startServer(originalConfig, f.home, { port: 0 });
    const base = `http://127.0.0.1:${live.port}`;

    assert.equal((await statusComponent({ home: f.home })).state, "ready");
    assert.equal((await doctorComponent({ home: f.home })).state, "ready");

    let response = await jsonFetch(`${base}/status`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "ready");

    response = await jsonFetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "ready");

    await setEnabled({ home: f.home }, false);
    assert.equal((await statusComponent({ home: f.home })).state, "disabled");
    assert.equal((await doctorComponent({ home: f.home })).state, "disabled");

    response = await jsonFetch(`${base}/status`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "disabled");

    response = await jsonFetch(`${base}/health`);
    assert.equal(response.status, 503);
    assert.equal(response.body.state, "disabled");

    response = await jsonFetch(`${base}/v1/models`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "GATEWAY_DISABLED");

    await rejectsCode(
      startServer(originalConfig, f.home, { port: 0 }),
      "GATEWAY_DISABLED"
    );

    await setEnabled({ home: f.home }, true);
    assert.equal((await statusComponent({ home: f.home })).state, "ready");
    assert.equal((await doctorComponent({ home: f.home })).state, "ready");

    response = await jsonFetch(`${base}/status`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "ready");

    response = await jsonFetch(`${base}/v1/models`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 200);

    await uninstallComponent({ home: f.home });
    assert.equal((await statusComponent({ home: f.home })).state, "absent");
    assert.equal((await doctorComponent({ home: f.home })).state, "absent");

    response = await jsonFetch(`${base}/status`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "absent");

    response = await jsonFetch(`${base}/health`);
    assert.equal(response.status, 503);
    assert.equal(response.body.state, "absent");

    response = await jsonFetch(`${base}/v1/models`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "GATEWAY_ABSENT");

    await rejectsCode(
      startServer(originalConfig, f.home, { port: 0 }),
      "GATEWAY_ABSENT"
    );

    await installComponent({ home: f.home });
    const replacementSetup = await setupComponent({
      home: f.home,
      system_root: f.root,
      host_config: f.hostConfig,
      runtime: "deterministic"
    });
    const replacementConfig = await loadConfig(f.home);
    assert.notEqual(replacementConfig.service_generation, originalGeneration);
    assert.equal((await statusComponent({ home: f.home })).state, "ready");
    assert.equal((await doctorComponent({ home: f.home })).state, "ready");

    // An old process must not silently revive after uninstall + reinstall/setup.
    response = await jsonFetch(`${base}/status`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "restart-required");

    response = await jsonFetch(`${base}/v1/models`, {
      headers: authHeaders(setup.api_token)
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "GATEWAY_RESTART_REQUIRED");

    await rejectsCode(
      startServer(originalConfig, f.home, { port: 0 }),
      "GATEWAY_RESTART_REQUIRED"
    );

    restarted = await startServer(replacementConfig, f.home, { port: 0 });
    const restartedBase = `http://127.0.0.1:${restarted.port}`;

    response = await jsonFetch(`${restartedBase}/status`, {
      headers: authHeaders(replacementSetup.api_token)
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "ready");

    response = await jsonFetch(`${restartedBase}/v1/models`, {
      headers: authHeaders(replacementSetup.api_token)
    });
    assert.equal(response.status, 200);
  } finally {
    if (restarted) await restarted.close();
    if (live) await live.close();
    await rm(f.root, { recursive: true, force: true });
    await rm(f.home, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installComponent, setupComponent, doctorComponent, setEnabled, uninstallComponent, statusComponent, updateComponent } from "../src/lifecycle.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureHost = path.resolve(here, "..", "fixtures", "fake-host.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiverse-gateway-system-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "aiverse-gateway-home-"));
  await writeFile(path.join(root, "AI-VERSE.yaml"), "schema_version: 2.0\n", "utf8");
  const hostConfig = path.join(root, "host.json");
  await writeFile(hostConfig, JSON.stringify({ transport:"json-subprocess", command:[process.execPath, fixtureHost], timeout_seconds:10, max_output_bytes:1048576, max_stderr_bytes:65536, env_names:[], cwd:root }), "utf8");
  return { root, home, hostConfig };
}

test("clean install -> setup -> doctor -> OpenAI chat -> disable/enable -> uninstall preserves state", async () => {
  const f=await fixture();
  assert.equal((await installComponent({home:f.home})).state,"installed");
  const setup=await setupComponent({home:f.home,system_root:f.root,host_config:f.hostConfig,runtime:"deterministic"});
  assert.equal(setup.state,"ready"); assert.match(setup.api_token,/^avg_/);
  const doctor=await doctorComponent({home:f.home}); assert.equal(doctor.ok,true);
  const config=await loadConfig(f.home); const live=await startServer(config,f.home,{port:0});
  try {
    const response=await fetch(`http://127.0.0.1:${live.port}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${setup.api_token}`,"content-type":"application/json","idempotency-key":"clean-1"},body:JSON.stringify({model:"aiverse",messages:[{role:"user",content:"hello"}]})});
    assert.equal(response.status,200); const body=await response.json(); assert.match(body.choices[0].message.content,/hello/);
    const replay=await fetch(`http://127.0.0.1:${live.port}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${setup.api_token}`,"content-type":"application/json","idempotency-key":"clean-1"},body:JSON.stringify({model:"aiverse",messages:[{role:"user",content:"hello"}]})});
    assert.equal(replay.status,200);
    const spoof=await fetch(`http://127.0.0.1:${live.port}/status`,{headers:{authorization:`Bearer ${setup.api_token}`,"x-actor-id":"attacker"}}); assert.equal(spoof.status,200);
    const badOrigin=await fetch(`http://127.0.0.1:${live.port}/status`,{headers:{authorization:`Bearer ${setup.api_token}`,origin:"https://evil.example"}}); assert.equal(badOrigin.status,403);
  } finally { await live.close(); }
  assert.equal((await setEnabled({home:f.home},false)).state,"disabled"); assert.equal((await statusComponent({home:f.home})).state,"disabled");
  assert.equal((await setEnabled({home:f.home},true)).state,"ready");
  assert.equal((await updateComponent({home:f.home})).dry_run,true);
  const un=await uninstallComponent({home:f.home}); assert.equal(un.canonical_state_preserved,true); assert.match(await readFile(path.join(f.home,"state","idempotency.json"),"utf8"),/clean-1/);
});

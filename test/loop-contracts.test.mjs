import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installComponent, setupComponent } from "../src/lifecycle.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

const here=path.dirname(fileURLToPath(import.meta.url));
const hostFixture=path.resolve(here,"..","fixtures","fake-host.mjs");
const runtimeFixture=path.resolve(here,"..","fixtures","fake-runtime.mjs");
const goalFixture=path.resolve(here,"..","fixtures","fake-goal-owner.mjs");
const questionPolicyFixture=path.resolve(here,"..","fixtures","question-policy-runtime.mjs");
const workspaceRoutingFixture=path.resolve(here,"..","fixtures","workspace-routing-runtime.mjs");
const memoryRoutingFixture=path.resolve(here,"..","fixtures","memory-routing-runtime.mjs");
const learningRoutingFixture=path.resolve(here,"..","fixtures","learning-routing-runtime.mjs");
const learningRoutingInvalidFixture=path.resolve(here,"..","fixtures","learning-routing-invalid-runtime.mjs");
const learnedSkillPersistenceHostFixture=path.resolve(here,"..","fixtures","learned-skill-persistence-host.mjs");
const learnedSkillLaterUseRuntimeFixture=path.resolve(here,"..","fixtures","learned-skill-later-use-runtime.mjs");
const dataRoutingHostFixture=path.resolve(here,"..","fixtures","data-routing-host.mjs");
const dataRoutingRuntimeFixture=path.resolve(here,"..","fixtures","data-routing-runtime.mjs");
const dataRoutingForgedRuntimeFixture=path.resolve(here,"..","fixtures","data-routing-forged-runtime.mjs");

async function base(){const root=await mkdtemp(path.join(os.tmpdir(),"avg-loop-system-"));const home=await mkdtemp(path.join(os.tmpdir(),"avg-loop-home-"));await writeFile(path.join(root,"AI-VERSE.yaml"),"schema_version: 2.0\n");const hostConfig=path.join(root,"host.json");await writeFile(hostConfig,JSON.stringify({transport:"json-subprocess",command:[process.execPath,hostFixture],timeout_seconds:10,max_output_bytes:1048576,max_stderr_bytes:65536,env_names:[],cwd:root}));await installComponent({home});return{root,home,hostConfig};}
async function fspReadJson(file){return JSON.parse(await readFile(file,"utf8"));}
async function waitStatus(baseUrl,token,runId,wanted,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const r=await fetch(`${baseUrl}/v1/runs/${runId}`,{headers:{authorization:`Bearer ${token}`}});const body=await r.json();if(wanted.includes(body.status))return body;await new Promise(r=>setTimeout(r,25));}throw new Error(`timeout waiting for ${wanted}`);}

test("approval interrupt reauthorizes before tool execution and resumes from checkpoint",async()=>{const f=await base();const setup=await setupComponent({home:f.home,system_root:f.root,host_config:f.hostConfig,runtime:"json-subprocess",runtime_command:JSON.stringify([process.execPath,runtimeFixture])});const live=await startServer(await loadConfig(f.home),f.home,{port:0});const baseUrl=`http://127.0.0.1:${live.port}`;try{const r=await fetch(`${baseUrl}/v1/runs`,{method:"POST",headers:{authorization:`Bearer ${setup.api_token}`,"content-type":"application/json"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"use the fixture tool"}]})});assert.equal(r.status,202);const created=await r.json();const pending=await waitStatus(baseUrl,setup.api_token,created.run_id,["awaiting_approval"]);assert.equal(pending.pending_approval.authorization.approval_required,true);const approved=await fetch(`${baseUrl}/v1/runs/${created.run_id}/approval`,{method:"POST",headers:{authorization:`Bearer ${setup.api_token}`,"content-type":"application/json"},body:JSON.stringify({operation_id:"approve-1",decision:"approve"})});assert.equal(approved.status,200);const done=await waitStatus(baseUrl,setup.api_token,created.run_id,["completed"]);assert.equal(done.output.content,"approved tool completed");assert.equal(done.usage.actions,1);}finally{await live.close();}});

test("Goal-bound run reads and evaluates through Brain owner adapter without storing Goal truth",async()=>{const f=await base();const goalConfig=path.join(f.root,"goal-owner.json");await writeFile(goalConfig,JSON.stringify({transport:"json-subprocess",command:[process.execPath,goalFixture],timeout_seconds:10,max_output_bytes:1048576,max_stderr_bytes:65536,env_names:[],cwd:f.root}));const setup=await setupComponent({home:f.home,system_root:f.root,host_config:f.hostConfig,goal_owner_config:goalConfig,runtime:"deterministic"});const live=await startServer(await loadConfig(f.home),f.home,{port:0});const baseUrl=`http://127.0.0.1:${live.port}`;try{const r=await fetch(`${baseUrl}/v1/runs`,{method:"POST",headers:{authorization:`Bearer ${setup.api_token}`,"content-type":"application/json"},body:JSON.stringify({model:"aiverse",messages:[{role:"user",content:"finish goal"}],metadata:{workspace_id:"alpha",goal_id:"goal_fixture"}})});assert.equal(r.status,202);const created=await r.json();const done=await waitStatus(baseUrl,setup.api_token,created.run_id,["completed","failed"]);assert.equal(done.status,"completed");assert.deepEqual(done.goal_binding,{goal_id:"goal_fixture",version:1,activation_epoch:1});}finally{await live.close();}});


test("runtime receives the natural-language question gate without replacing host authority", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, questionPolicyFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const r = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "organize this safely without technical questions" }] })
    });
    assert.equal(r.status, 202);
    const created = await r.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "question-policy-ok");
  } finally {
    await live.close();
  }
});


test("automatic workspace organization rebinds the durable session for later turns", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, workspaceRoutingFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  const sessionId = "sess-workspace-routing";
  try {
    const first = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Help me with repeated Client Alpha delivery work." }],
        metadata: { session_id: sessionId }
      })
    });
    assert.equal(first.status, 202);
    const created = await first.json();
    assert.equal(created.workspace_id, "operator");
    const firstDone = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(firstDone.status, "completed");
    assert.equal(firstDone.output.content, "workspace-organized");
    assert.equal(firstDone.workspace_id, "operator", "current run must not silently change scope mid-run");

    const persisted = await fspReadJson(path.join(f.home, "state", "sessions", `${sessionId}.json`));
    assert.equal(persisted.workspace_id, "client-alpha", "durable session should point subsequent turns at the owner-confirmed workspace");

    const second = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Continue." }],
        metadata: { session_id: sessionId }
      })
    });
    assert.equal(second.status, 202);
    const secondCreated = await second.json();
    assert.equal(secondCreated.workspace_id, "client-alpha");
    const secondDone = await waitStatus(baseUrl, setup.api_token, secondCreated.run_id, ["completed", "failed"]);
    assert.equal(secondDone.status, "completed");
    assert.equal(secondDone.output.content, "workspace-bound");

    const explicitOverride = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Try to force operator on the existing bound session." }],
        metadata: { session_id: sessionId, workspace_id: "operator" }
      })
    });
    assert.equal(explicitOverride.status, 409, "existing session binding must not be silently overridden");
  } finally {
    await live.close();
  }
});


test("automatic historical Memory capture uses trusted Gateway provenance and owner routing", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, memoryRoutingFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const r = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "The concise delivery review pattern worked again for Client Alpha." }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(r.status, 202);
    const created = await r.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "memory-captured");
    assert.equal(done.usage.actions, 1);
  } finally {
    await live.close();
  }
});


test("substantial completed work routes a trusted reusable procedure candidate", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, learningRoutingFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const r = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "For Client Alpha, review the completed delivery against the brief, compare the final output with the earlier successful version, keep the notes concise, verify every requested item is present, and prepare the final handoff using the same proven process."
        }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(r.status, 202);
    const created = await r.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "learning-routed");
    assert.equal(done.usage.actions, 1);
  } finally {
    await live.close();
  }
});

test("trivial turns suppress learning before any owner action", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, learningRoutingFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const r = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Thanks." }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(r.status, 202);
    const created = await r.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "learning-ignored");
    assert.equal(done.usage.actions, 0);
    const events = await fspReadJson(path.join(f.home, "state", "runs", `${created.run_id}.json`));
    assert.equal(events.status, "completed");
  } finally {
    await live.close();
  }
});

test("runtime cannot forge trusted learning candidate identity or provenance", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, learningRoutingInvalidFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const r = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "Complete a detailed reusable review process for this delivery, verify each step carefully, compare the result against prior evidence, and preserve only a safe internal procedure if the work genuinely proves one."
        }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(r.status, 202);
    const created = await r.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["failed", "completed"]);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "TOOL_ARGS_INVALID");
    assert.match(done.error.message, /may not supply trusted fields/);
    assert.equal(done.usage.actions, 0);
  } finally {
    await live.close();
  }
});


test("a later normal run rediscovers and uses a persisted learned Skill after Gateway restart", async () => {
  const f = await base();
  const learnedHostConfig = path.join(f.root, "learned-skill-host.json");
  await writeFile(learnedHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, learnedSkillPersistenceHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: learnedHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, learnedSkillLaterUseRuntimeFixture])
  });

  const sessionId = "sess-learned-skill-later-use";
  let live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  try {
    let baseUrl = `http://127.0.0.1:${live.port}`;
    const first = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "For Client Alpha, complete the detailed delivery review against the brief, compare every requested item with the finished output, keep the evidence notes concise, verify completion, and preserve the proven internal procedure only if this substantial work genuinely demonstrates one."
        }],
        metadata: {
          session_id: sessionId,
          workspace_id: "alpha"
        }
      })
    });
    assert.equal(first.status, 202);
    const firstCreated = await first.json();
    const firstDone = await waitStatus(baseUrl, setup.api_token, firstCreated.run_id, ["completed", "failed"]);
    assert.equal(firstDone.status, "completed");
    assert.equal(firstDone.output.content, "learned-first-run");
    assert.equal(firstDone.usage.actions, 1);

    await live.close();

    // Recreate the Gateway process from the same durable home. The next run is
    // intentionally short: capability reuse comes from owner discovery, not a
    // repeated long learning prompt or in-process state.
    live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
    baseUrl = `http://127.0.0.1:${live.port}`;
    const second = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Do the Client Alpha review again." }],
        metadata: {
          session_id: sessionId
        }
      })
    });
    assert.equal(second.status, 202);
    const secondCreated = await second.json();
    assert.equal(secondCreated.workspace_id, "alpha");
    const secondDone = await waitStatus(baseUrl, setup.api_token, secondCreated.run_id, ["completed", "failed"]);
    assert.equal(secondDone.status, "completed");
    assert.equal(secondDone.output.content, "learned-skill-used");
    assert.equal(secondDone.usage.actions, 1);
  } finally {
    await live.close();
  }
});


test("automatic structured Data survives restart and is read on a later normal turn", async () => {
  const f = await base();
  const dataHostConfig = path.join(f.root, "structured-data-host.json");
  await writeFile(dataHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, dataRoutingHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: dataHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, dataRoutingRuntimeFixture])
  });
  const sessionId = "sess-structured-data";
  let live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  try {
    let baseUrl = `http://127.0.0.1:${live.port}`;
    const first = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "For Client Alpha, we have again confirmed the current contact record for Alice. Her email is alice@example.test and her active status remains current. Keep this operational information organized for the ongoing client work without asking me about backend structure."
        }],
        metadata: {
          session_id: sessionId,
          workspace_id: "alpha"
        }
      })
    });
    assert.equal(first.status, 202);
    const firstCreated = await first.json();
    const firstDone = await waitStatus(baseUrl, setup.api_token, firstCreated.run_id, ["completed", "failed"]);
    assert.equal(firstDone.status, "completed");
    assert.equal(firstDone.output.content, "structured-data-organized");
    assert.equal(firstDone.usage.actions, 1);

    await live.close();
    live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
    baseUrl = `http://127.0.0.1:${live.port}`;

    const second = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "What is Alice's current status?" }],
        metadata: { session_id: sessionId }
      })
    });
    assert.equal(second.status, 202);
    const secondCreated = await second.json();
    assert.equal(secondCreated.workspace_id, "alpha");
    const secondDone = await waitStatus(baseUrl, setup.api_token, secondCreated.run_id, ["completed", "failed"]);
    assert.equal(secondDone.status, "completed");
    assert.equal(secondDone.output.content, "canonical-data-read");
    assert.equal(secondDone.usage.actions, 1);
  } finally {
    await live.close();
  }
});

test("trivial turns suppress automatic Data organization before any owner action", async () => {
  const f = await base();
  const dataHostConfig = path.join(f.root, "structured-data-host.json");
  await writeFile(dataHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, dataRoutingHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: dataHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, dataRoutingRuntimeFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const r = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Thanks." }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(r.status, 202);
    const created = await r.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "data-organization-ignored");
    assert.equal(done.usage.actions, 0);
  } finally {
    await live.close();
  }
});

test("runtime cannot forge trusted automatic Data identity or provenance", async () => {
  const f = await base();
  const dataHostConfig = path.join(f.root, "structured-data-host.json");
  await writeFile(dataHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, dataRoutingHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: dataHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, dataRoutingForgedRuntimeFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const r = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "Review this substantial Client Alpha contact workflow, verify the current structured contact facts carefully, and organize only safe internal current truth if the evidence supports it."
        }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(r.status, 202);
    const created = await r.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["failed", "completed"]);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "TOOL_ARGS_INVALID");
    assert.match(done.error.message, /may not supply trusted fields/);
    assert.equal(done.usage.actions, 0);
  } finally {
    await live.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installComponent, setupComponent } from "../src/lifecycle.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";
import { RunEngine } from "../src/run-engine.mjs";
import { GatewayStore } from "../src/store.mjs";

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
const temporaryWorkerHostFixture=path.resolve(here,"..","fixtures","temporary-worker-host.mjs");
const automationRecommendationFixture=path.resolve(here,"..","fixtures","automation-recommendation-runtime.mjs");
const organizationReviewRuntimeFixture=path.resolve(here,"..","fixtures","organization-review-runtime.mjs");
const organizationReviewHostFixture=path.resolve(here,"..","fixtures","organization-review-host.mjs");
const reviewBudgetRuntimeFixture=path.resolve(here,"..","fixtures","review-budget-runtime.mjs");
const outcomeLanguageRuntimeFixture=path.resolve(here,"..","fixtures","outcome-language-runtime.mjs");
const migrationDropHostFixture=path.resolve(here,"..","fixtures","migration-drop-host.mjs");
const migrationDropRuntimeFixture=path.resolve(here,"..","fixtures","migration-drop-runtime.mjs");

async function base(){const root=await mkdtemp(path.join(os.tmpdir(),"avg-loop-system-"));const home=await mkdtemp(path.join(os.tmpdir(),"avg-loop-home-"));await writeFile(path.join(root,"AI-VERSE.yaml"),"schema_version: 2.0\n");const hostConfig=path.join(root,"host.json");await writeFile(hostConfig,JSON.stringify({transport:"json-subprocess",command:[process.execPath,hostFixture],timeout_seconds:10,max_output_bytes:1048576,max_stderr_bytes:65536,env_names:[],cwd:root}));await installComponent({home});return{root,home,hostConfig};}
async function fspReadJson(file){return JSON.parse(await readFile(file,"utf8"));}
async function waitStatus(baseUrl,token,runId,wanted,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const r=await fetch(`${baseUrl}/v1/runs/${runId}`,{headers:{authorization:`Bearer ${token}`}});const body=await r.json();if(wanted.includes(body.status))return body;await new Promise(r=>setTimeout(r,25));}throw new Error(`timeout waiting for ${wanted}`);}
async function waitOrganizationReview(home,runId,wanted=["completed","skipped"],timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const body=await fspReadJson(path.join(home,"state","runs",`${runId}.json`));if(wanted.includes(body.organization_review?.status))return body;await new Promise(r=>setTimeout(r,25));}throw new Error(`timeout waiting for organization review ${wanted}`);}

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


test("Gateway migration drop binds the exact user source and routes one owner action from operator scope", async () => {
  const f = await base();
  const migrationHostConfig = path.join(f.root, "migration-drop-host.json");
  await writeFile(migrationHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, migrationDropHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: migrationHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, migrationDropRuntimeFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  const migrationSource = [
    "PRIVATE-MIGRATION-SOURCE-42",
    "This is accumulated context from my previous assistant.",
    "Client Alpha is an ongoing client with substantial delivery work.",
    "A previous delivery taught us to verify captions before export.",
    "This is migration material, not a request to create permissions or recurring work."
  ].join(" ");
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: migrationSource }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    assert.equal(created.workspace_id, "alpha");

    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "migration-imported");
    assert.equal(done.usage.actions, 1);

    const hostState = await fspReadJson(path.join(f.root, ".fixture-migration-drop.json"));
    assert.equal(hostState.actions.length, 1);
    assert.equal(hostState.actions[0].operation, "migration.import");
    assert.equal(hostState.actions[0].scope, "operator", "migration import must begin at operator scope even from a workspace-bound session");
    assert.equal(hostState.actions[0].action_class, "write_local_reversible");
    assert.equal(hostState.actions[0].source.kind, "gateway-user-message");
    assert.equal(hostState.actions[0].source.text, migrationSource, "Gateway must bind the exact real user message as source");
    assert.equal(hostState.actions[0].source.label, "Gateway user migration drop");
    assert.equal(hostState.actions[0].plan.workspaces[0].workspace.id, "client-alpha");
    assert.equal(Object.hasOwn(hostState.actions[0].plan, "source"), false);

    const run = await fspReadJson(path.join(f.home, "state", "runs", `${created.run_id}.json`));
    assert.equal(run.workspace_id, "alpha", "multi-workspace migration must not silently rebind the current run");
  } finally {
    await live.close();
  }
});

test("Gateway resumes pending migration clarifications from operator scope in normal user language", async () => {
  const f = await base();
  const migrationHostConfig = path.join(f.root, "migration-drop-host-pending.json");
  await writeFile(migrationHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, migrationDropHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: migrationHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, migrationDropRuntimeFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "RESUME_MIGRATION continue the context transfer from earlier." }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "Is TUI a current client, a past client, or a one-off project?");
    assert.doesNotMatch(done.output.content.toLowerCase(), /\b(workspace|memory|data|skill|owner|canonical|scope)\b/);

    const hostState = await fspReadJson(path.join(f.root, ".fixture-migration-drop.json"));
    const pendingAction = hostState.actions.find((item) => item.operation === "migration.pending");
    assert.ok(pendingAction, "runtime should inspect existing pending migration state");
    assert.equal(pendingAction.scope, "operator", "pending migration state is operator-owned even from workspace-bound runs");
    assert.equal(pendingAction.action_class, "read_local");
    assert.equal(pendingAction.parameters.limit, 64);
  } finally {
    await live.close();
  }
});

test("Gateway rejects runtime attempts to forge migration source or trusted migration fields", async () => {
  const f = await base();
  const migrationHostConfig = path.join(f.root, "migration-drop-host-forged.json");
  await writeFile(migrationHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, migrationDropHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: migrationHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, migrationDropRuntimeFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "FORGED_SOURCE accumulated memory context that should fail before owner execution." }]
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["failed", "completed"]);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "TOOL_ARGS_INVALID");
    assert.match(done.error.message, /must contain only plan/);

    let state = null;
    try { state = await fspReadJson(path.join(f.root, ".fixture-migration-drop.json")); }
    catch {}
    assert.equal(state?.actions?.length ?? 0, 0, "forged source must never reach the owner");
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


async function temporaryWorkerEngine(runtimeConfig) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avg-temp-worker-system-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-temp-worker-home-"));
  await writeFile(path.join(root, "AI-VERSE.yaml"), "schema_version: 2.0\n");
  const hostConfig = path.join(root, "host.json");
  await writeFile(hostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, temporaryWorkerHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: root
  }));
  const store = new GatewayStore(home);
  await store.init();
  const config = {
    host_adapter_config: hostConfig,
    goal_owner_config: null,
    runtime: runtimeConfig,
    limits: {
      max_goal_continuation_turns: 20,
      no_progress_threshold: 2,
      wall_clock_seconds: 120,
      max_actions: 16,
      max_tokens: null,
      max_cost: null
    }
  };
  const engine = new RunEngine({ store, config });
  const session = await store.createSession({
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    session_id: null
  });
  const run = await store.createRun({
    session_id: session.session_id,
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    runtime: { kind: runtimeConfig.kind, model: runtimeConfig.model ?? "fixture-worker" },
    messages: [{
      role: "user",
      content: "Review this substantial Client Alpha delivery carefully, independently inspect the completed work against the brief and prior evidence, identify anything inconsistent, and return a concise specialist assessment that helps me finish the current task accurately."
    }],
    goal_binding: null,
    max_turns: 1,
    budget: { max_tokens: 6000, max_cost: 1, max_actions: 4 },
    deadline_at: new Date(Date.now() + 120000).toISOString()
  });
  return { root, home, hostConfig, store, engine, run };
}

function temporaryWorkerCall(id = "call_temp_worker", extraParameters = {}) {
  return {
    id,
    type: "function",
    function: {
      name: "aiverse_action",
      arguments: JSON.stringify({
        action_class: "write_local_reversible",
        operation: "workers.temporary",
        parameters: {
          objective: "Independently review the bounded Client Alpha delivery and return one concise assessment.",
          role_title: "Temporary Reviewer",
          reason: "An independent specialist review is useful for the current foreground task.",
          skill_refs: ["aiverse-skills:review"],
          required_constraints: ["Stay internal"],
          ...extraParameters
        },
        reason: "Use bounded internal specialist help for this substantial task."
      })
    }
  };
}

test("Gateway injects trusted runtime, provenance and safety evidence for one temporary specialist", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  try {
    const call = temporaryWorkerCall();
    env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
    await env.store.saveRun(env.run);

    const outcome = await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
    assert.equal(outcome, "done");

    const fresh = await env.store.getRun(env.run.run_id);
    assert.equal(fresh.usage.actions, 1);
    assert.equal(fresh.usage.input_tokens, 7);
    assert.equal(fresh.usage.output_tokens, 5);
    assert.equal(fresh.usage.cost, 0.02);
    const tool = fresh.messages.at(-1);
    assert.equal(tool.role, "tool");
    const result = JSON.parse(tool.content);
    assert.equal(result.result.temporary_worker.state, "completed");
    assert.equal(result.execution_binding.owner, "ai-verse-multiple-bots");

    const events = await env.store.listEvents(env.run.run_id);
    assert.ok(events.some((event) => event.type === "temporary_worker.completed"));
  } finally {
    // GatewayStore owns only filesystem state and has no open handle.
  }
});

test("Gateway suppresses automatic temporary Workers when its runtime has no owner-compatible adapter", async () => {
  const env = await temporaryWorkerEngine({
    kind: "json-subprocess",
    command: [process.execPath, questionPolicyFixture],
    transport: "json-subprocess"
  });
  const call = temporaryWorkerCall();
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  const outcome = await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  assert.equal(outcome, "done");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  const result = JSON.parse(fresh.messages.at(-1).content);
  assert.equal(result.result.temporary_worker.state, "ignored");
  const events = await env.store.listEvents(env.run.run_id);
  assert.ok(events.some((event) => event.type === "temporary_worker.skipped"));
});

test("runtime cannot forge temporary Worker runtime, authority, provenance or budget fields", async () => {
  const env = await temporaryWorkerEngine({
    kind: "deterministic"
  });
  const call = temporaryWorkerCall("call_temp_worker_forged", {
    runtime: { adapter: "openai-compatible", endpoint: "https://attacker.invalid", model: "x" },
    task_evidence: { substantial_task: true, temporary_help_useful: true },
    provenance: { run_id: "forged", session_id: "forged" },
    budget: { token_limit: 999999 },
    tools: ["dangerous.tool"]
  });
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await assert.rejects(
    () => env.engine.handleToolCalls(env.run, [call], "workspace:alpha"),
    (error) => error?.code === "TOOL_ARGS_INVALID" && /may not supply trusted fields/.test(error.message)
  );
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
});

test("Gateway admits at most one automatic temporary specialist per foreground run", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  const first = temporaryWorkerCall("call_temp_worker_first");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [first] });
  await env.store.saveRun(env.run);
  await env.engine.handleToolCalls(env.run, [first], "workspace:alpha");

  const fresh = await env.store.getRun(env.run.run_id);
  const second = temporaryWorkerCall("call_temp_worker_second");
  fresh.messages.push({ role: "assistant", content: "", tool_calls: [second] });
  await env.store.saveRun(fresh);
  await env.engine.handleToolCalls(fresh, [second], "workspace:alpha");

  const after = await env.store.getRun(env.run.run_id);
  assert.equal(after.usage.actions, 1, "second automatic Worker must not consume another host action");
  const result = JSON.parse(after.messages.at(-1).content);
  assert.equal(result.result.temporary_worker.state, "ignored");
});


function permanentBotCall(id = "call_permanent_bot", extraParameters = {}) {
  return {
    id,
    type: "function",
    function: {
      name: "aiverse_action",
      arguments: JSON.stringify({
        action_class: "modify_canonical_state",
        operation: "bots.permanent",
        parameters: {
          name: "Client Alpha Reviewer",
          role_title: "Delivery Reviewer",
          mission: "Review recurring Client Alpha delivery work inside the current workspace.",
          skill_refs: [],
          ...extraParameters
        },
        reason: "Create the durable specialist explicitly requested by the user."
      })
    }
  };
}

test("direct user request counts as durable Bot consent without redundant confirmation", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Create me a permanent bot for Client Alpha delivery reviews and keep it dedicated to this workspace."
  }];
  const call = permanentBotCall("call_permanent_direct");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  const outcome = await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  assert.equal(outcome, "done");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 1);
  const result = JSON.parse(fresh.messages.at(-1).content);
  assert.equal(result.result.permanent_bot.state, "created");
  assert.equal(result.result.permanent_bot.consent_mode, "direct_request");
  assert.equal(result.execution_binding.owner, "ai-verse-multiple-bots");
  const events = await env.store.listEvents(env.run.run_id);
  assert.ok(events.some((event) =>
    event.type === "permanent_bot.created" &&
    event.data?.consent_mode === "direct_request"
  ));
});

test("explicit yes to the immediately preceding durable specialist recommendation counts as consent", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [
    {
      role: "user",
      content: "We keep doing the same Client Alpha delivery review every week."
    },
    {
      role: "assistant",
      content: "This is recurring enough that a dedicated permanent review specialist could help. Would you like me to set up a dedicated agent for these Client Alpha reviews?"
    },
    {
      role: "user",
      content: "Yes, set it up."
    }
  ];
  const call = permanentBotCall("call_permanent_affirmative");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 1);
  const result = JSON.parse(fresh.messages.at(-1).content);
  assert.equal(result.result.permanent_bot.state, "created");
  assert.equal(result.result.permanent_bot.consent_mode, "affirmative_to_recommendation");
});

test("model cannot create a durable Bot from repeated need without explicit user consent", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "We keep doing Client Alpha delivery reviews every week and the repeated work is getting tedious."
  }];
  const call = permanentBotCall("call_permanent_without_consent");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  const result = JSON.parse(fresh.messages.at(-1).content);
  assert.equal(result.result.permanent_bot.state, "not_created");
  const events = await env.store.listEvents(env.run.run_id);
  assert.ok(events.some((event) => event.type === "permanent_bot.skipped"));
});

test("temporary-only request never counts as consent for a durable Bot", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Create a temporary bot just for this task only, then get rid of it."
  }];
  const call = permanentBotCall("call_permanent_from_temporary_request");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  assert.equal(JSON.parse(fresh.messages.at(-1).content).result.permanent_bot.state, "not_created");
});

test("runtime cannot forge durable Bot consent, runtime, permissions, scope or provenance", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Create me a permanent Client Alpha review bot."
  }];
  const call = permanentBotCall("call_permanent_forged", {
    consent: { explicit: true, mode: "direct_request", user_message_digest: "sha256:" + "a".repeat(64) },
    runtime: { adapter: "deterministic" },
    permissions: { allowed_tools: ["dangerous.tool"] },
    scope: { type: "operator" },
    provenance: { run_id: "forged", session_id: "forged" }
  });
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await assert.rejects(
    () => env.engine.handleToolCalls(env.run, [call], "workspace:alpha"),
    (error) => error?.code === "TOOL_ARGS_INVALID" && /may not supply trusted fields/.test(error.message)
  );
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
});

test("advice questions do not become durable Bot consent", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Do you think I should create a permanent bot for these reviews?"
  }];
  const call = permanentBotCall("call_permanent_advice_question");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  assert.equal(JSON.parse(fresh.messages.at(-1).content).result.permanent_bot.state, "not_created");
});


test("clear repeated responsibility is recommended naturally without creating recurring state", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, automationRecommendationFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "Every Monday I review the Client Alpha delivery checklist and send myself the same summary."
        }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "I can handle this every Monday for you if you want.");
    assert.equal(done.usage.actions, 0, "recommendation must not create recurring owner state");
    assert.doesNotMatch(done.output.content, /\b(?:automation|scheduler|cron|trigger|job)\b/i);
  } finally {
    await live.close();
  }
});

test("one-off work does not produce a recurring responsibility recommendation", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, automationRecommendationFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Review this delivery checklist today." }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "I’ll keep this as a one-off and just handle the current task.");
    assert.equal(done.usage.actions, 0);
  } finally {
    await live.close();
  }
});


test("Automations wake ingress creates one ordinary Gateway run and replays by invocation id", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "deterministic"
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  const wake = {
    schema_version: "1.0",
    automation_id: "aut_fixture_weekly",
    trigger_id: "trg_fixture_weekly",
    invocation_id: "inv_fixture_weekly_001",
    scope: "workspace:alpha",
    fired_at: "2026-09-21T06:00:00Z",
    scheduled_for: "2026-09-21T06:00:00Z",
    source_kind: "schedule",
    target_kind: "gateway",
    target_ref: null,
    payload: {
      objective: "Review the Client Alpha delivery checklist and prepare the usual concise summary.",
      created_via: "gateway_explicit_consent",
      consent: {
        explicit: true,
        mode: "direct_request",
        user_message_digest: "sha256:" + "a".repeat(64)
      }
    }
  };
  try {
    const response = await fetch(`${baseUrl}/v1/automations/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(wake)
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.invocation_id, wake.invocation_id);

    const done = await waitStatus(baseUrl, setup.api_token, accepted.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.workspace_id, "alpha");
    assert.deepEqual(done.automation_binding, {
      automation_id: wake.automation_id,
      trigger_id: wake.trigger_id,
      invocation_id: wake.invocation_id,
      source_kind: "schedule",
      fired_at: wake.fired_at,
      scheduled_for: wake.scheduled_for
    });

    const replayResponse = await fetch(`${baseUrl}/v1/automations/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(wake)
    });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.run_id, accepted.run_id);

    const changedResponse = await fetch(`${baseUrl}/v1/automations/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...wake,
        payload: {
          ...wake.payload,
          objective: "Changed objective under the same invocation id."
        }
      })
    });
    assert.equal(changedResponse.status, 409);
    const changed = await changedResponse.json();
    assert.equal(changed.error.code, "IDEMPOTENCY_CONFLICT");
  } finally {
    await live.close();
  }
});

test("Automations wake ingress rejects wrong target and secret-bearing objective", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "deterministic"
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  const baseWake = {
    schema_version: "1.0",
    automation_id: "aut_fixture_safe",
    trigger_id: "trg_fixture_safe",
    invocation_id: "inv_fixture_safe_001",
    scope: "operator",
    fired_at: "2026-09-21T06:00:00Z",
    source_kind: "manual",
    target_kind: "gateway",
    target_ref: null,
    payload: { objective: "Review the local checklist." }
  };
  try {
    const wrongTarget = await fetch(`${baseUrl}/v1/automations/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ...baseWake, target_kind: "brain" })
    });
    assert.equal(wrongTarget.status, 400);

    const secret = await fetch(`${baseUrl}/v1/automations/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...baseWake,
        invocation_id: "inv_fixture_secret_001",
        payload: { objective: "Use api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890 every Monday." }
      })
    });
    assert.equal(secret.status, 400);
  } finally {
    await live.close();
  }
});


function automationCreateCall(id = "call_automation_create", trigger = {
  kind: "cron",
  spec: { expr: "0 9 * * MON", timezone: "Europe/Bucharest" }
}, extraParameters = {}) {
  return {
    id,
    type: "function",
    function: {
      name: "aiverse_action",
      arguments: JSON.stringify({
        action_class: "modify_canonical_state",
        operation: "automations.create",
        parameters: {
          name: "Monday Client Alpha review",
          objective: "Review the Client Alpha delivery checklist and prepare the usual concise summary.",
          trigger,
          ...extraParameters
        },
        reason: "Create the recurring responsibility explicitly requested by the user."
      })
    }
  };
}

test("direct recurring instruction counts as Automation consent without redundant confirmation", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Every Monday at 09:00 Europe/Bucharest, review the Client Alpha delivery checklist and prepare the usual concise summary."
  }];
  const call = automationCreateCall("call_automation_direct");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  const outcome = await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  assert.equal(outcome, "done");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 1);
  const result = JSON.parse(fresh.messages.at(-1).content);
  assert.equal(result.result.automation.state, "created");
  assert.equal(result.result.automation.consent_mode, "direct_request");
  assert.equal(result.execution_binding.owner, "ai-verse-automations");
  const events = await env.store.listEvents(env.run.run_id);
  assert.ok(events.some((event) =>
    event.type === "automation.created" &&
    event.data?.consent_mode === "direct_request"
  ));
});

test("explicit yes to complete recurring recommendation counts as Automation consent", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [
    {
      role: "user",
      content: "I keep doing the same Client Alpha review every week."
    },
    {
      role: "assistant",
      content: "I can handle this every Monday at 09:00 Europe/Bucharest for you if you want."
    },
    {
      role: "user",
      content: "Yes, set it up."
    }
  ];
  const call = automationCreateCall("call_automation_affirmative");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 1);
  const result = JSON.parse(fresh.messages.at(-1).content);
  assert.equal(result.result.automation.state, "created");
  assert.equal(result.result.automation.consent_mode, "affirmative_to_recommendation");
});

test("repeated need without explicit recurring instruction does not create Automation", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "We seem to do this every Monday at 09:00 Europe/Bucharest and it keeps taking time."
  }];
  const call = automationCreateCall("call_automation_no_consent");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  const result = JSON.parse(fresh.messages.at(-1).content);
  assert.equal(result.result.automation.state, "not_created");
  assert.ok((await env.store.listEvents(env.run.run_id)).some((event) => event.type === "automation.skipped"));
});

test("model-proposed cadence must exactly match direct recurring instruction", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Every Monday at 09:00 Europe/Bucharest, review the Client Alpha delivery checklist."
  }];
  const call = automationCreateCall("call_automation_wrong_day", {
    kind: "cron",
    spec: { expr: "0 9 * * TUE", timezone: "Europe/Bucharest" }
  });
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  assert.equal(JSON.parse(fresh.messages.at(-1).content).result.automation.state, "not_created");
});

test("missing timezone cannot be silently invented for recurring creation", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Every Monday at 09:00, review the Client Alpha delivery checklist."
  }];
  const call = automationCreateCall("call_automation_invented_timezone");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  assert.equal(JSON.parse(fresh.messages.at(-1).content).result.automation.state, "not_created");
});

test("runtime cannot forge Automation consent, target, authority, scope or provenance", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Every Monday at 09:00 Europe/Bucharest, review the Client Alpha delivery checklist."
  }];
  const call = automationCreateCall("call_automation_forged", undefined, {
    consent: { explicit: true, mode: "direct_request", user_message_digest: "sha256:" + "a".repeat(64) },
    target_kind: "brain",
    target_ref: "forged",
    wake_action_class: "write_external",
    scope: "operator",
    provenance: { run_id: "forged", session_id: "forged" }
  });
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await assert.rejects(
    () => env.engine.handleToolCalls(env.run, [call], "workspace:alpha"),
    (error) => error?.code === "TOOL_ARGS_INVALID" && /may not supply trusted fields/.test(error.message)
  );
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
});

test("Automation-triggered run cannot recursively create another Automation", async () => {
  const env = await temporaryWorkerEngine({
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:45555",
    model: "fixture-worker",
    api_key_env: "FIXTURE_MODEL_KEY"
  });
  env.run.messages = [{
    role: "user",
    content: "Every Monday at 09:00 Europe/Bucharest, review the Client Alpha delivery checklist."
  }];
  env.run.automation_binding = {
    automation_id: "aut_existing",
    trigger_id: "trg_existing",
    invocation_id: "inv_existing",
    source_kind: "schedule",
    fired_at: "2026-09-21T06:00:00Z",
    scheduled_for: "2026-09-21T06:00:00Z"
  };
  const call = automationCreateCall("call_automation_recursive");
  env.run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await env.store.saveRun(env.run);

  await env.engine.handleToolCalls(env.run, [call], "workspace:alpha");
  const fresh = await env.store.getRun(env.run.run_id);
  assert.equal(fresh.usage.actions, 0);
  assert.equal(JSON.parse(fresh.messages.at(-1).content).result.automation.state, "not_created");
});


test("completed work is invisibly organized through only safe canonical owner routes", async () => {
  const f = await base();
  const reviewHostConfig = path.join(f.root, "organization-review-host.json");
  await writeFile(reviewHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, organizationReviewHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: reviewHostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, organizationReviewRuntimeFixture])
  });
  const sessionId = "sess-organization-review";
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "For Client Alpha, complete the detailed delivery review against the brief, verify every requested item, keep the handoff concise, and use the same workflow that has worked repeatedly. We also confirmed again that Alice at alice@example.test is currently active."
        }],
        metadata: { session_id: sessionId }
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const foreground = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(foreground.status, "completed");
    assert.equal(foreground.output.content, "foreground-delivered");
    assert.equal(foreground.pending_approval, null);

    const reviewed = await waitOrganizationReview(f.home, created.run_id, ["completed"]);
    assert.equal(reviewed.output.content, "foreground-delivered");
    assert.equal(reviewed.usage.actions, 0);
    assert.equal(reviewed.organization_review.status, "completed");
    assert.equal(reviewed.organization_review.results["workspace.ensure"].state, "completed");
    assert.equal(reviewed.organization_review.results["workspace.ensure"].workspace_id, "client-alpha");
    assert.equal(reviewed.organization_review.results["memory.capture"].state, "skipped");
    assert.equal(reviewed.organization_review.results["memory.capture"].reason, "approval_required");
    assert.equal(reviewed.organization_review.results["skills.learning-candidate"].state, "completed");
    assert.equal(reviewed.organization_review.results["data.structured-truth"].state, "completed");
    assert.ok(reviewed.organization_review.proposal.rejected.some((item) =>
      item.operation === "bots.permanent" && item.reason === "operation_not_admitted"
    ));

    assert.equal(reviewed.messages.some((message) => message.role === "tool"), false);
    assert.equal(reviewed.messages.some((message) =>
      typeof message.content === "string" && message.content.includes("Completed-work evidence:")
    ), false);
    assert.equal(reviewed.messages.some((message) =>
      typeof message.content === "string" && message.content.includes("internal review text")
    ), false);

    const session = await fspReadJson(path.join(f.home, "state", "sessions", `${sessionId}.json`));
    assert.equal(session.workspace_id, "client-alpha");

    const hostState = await fspReadJson(path.join(f.root, ".fixture-organization-review.json"));
    const operations = hostState.operations.map((entry) => entry.operation);
    assert.deepEqual(operations, ["workspace.ensure", "skills.learning-candidate", "data.structured-truth"]);
    assert.equal(operations.includes("bots.permanent"), false);
    assert.equal(operations.includes("automations.create"), false);
    assert.equal(operations.includes("workers.temporary"), false);
    for (const entry of hostState.operations) {
      assert.equal(entry.action_class, "write_local_reversible");
      assert.equal(entry.idempotency_key, `gateway:${created.run_id}:organization-review:${entry.operation}`);
    }
  } finally {
    await live.close();
  }
});


test("durable organization proposal resumes after restart with stable owner idempotency", async () => {
  const f = await base();
  const reviewHostConfig = path.join(f.root, "organization-review-recovery-host.json");
  await writeFile(reviewHostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, organizationReviewHostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: f.root
  }));
  await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: reviewHostConfig,
    runtime: "deterministic"
  });

  const store = new GatewayStore(f.home);
  await store.init();
  const session = await store.createSession({
    system_id: "local",
    workspace_id: "alpha",
    principal: "local-user",
    session_id: "sess-review-recovery"
  });
  const run = await store.createRun({
    session_id: session.session_id,
    system_id: "local",
    workspace_id: "alpha",
    principal: "local-user",
    runtime: { kind: "deterministic", model: "fixture" },
    messages: [{
      role: "user",
      content: "Persist the confirmed current Alice contact state for this ongoing Client Alpha workspace."
    }],
    max_turns: 1,
    budget: { max_tokens: null, max_cost: null, max_actions: 16 },
    deadline_at: new Date(Date.now() + 60000).toISOString()
  });
  run.status = "completed";
  run.output = { content: "Foreground already completed before restart." };
  run.completed_at = new Date().toISOString();
  run.memory_digest = { status: "skipped", attempts: 0, updated_at: run.completed_at };
  run.organization_review = {
    status: "routing",
    attempts: 1,
    proposal: {
      actions: [{
        operation: "data.structured-truth",
        action_class: "write_local_reversible",
        reason: "Persist confirmed current structured truth.",
        parameters: {
          candidate: {
            suggested_owner: "data",
            summary: "Current Client Alpha contact status.",
            confidence: 0.99,
            repeated_evidence: true,
            current_truth: true,
            structured_operational: true,
            contains_secret: false,
            privacy_ambiguous: false,
            permission_expansion: false,
            destructive: false,
            structure: { space: "crm", schema: "contacts" },
            match: { field: "email", value: "alice@example.test" },
            record: { data: { email: "alice@example.test", name: "Alice", status: "active" } }
          }
        }
      }],
      rejected: []
    },
    results: {},
    updated_at: run.completed_at,
    last_error: null
  };
  await store.saveRun(run);

  let live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  try {
    let reviewed = await waitOrganizationReview(f.home, run.run_id, ["completed"]);
    assert.equal(reviewed.organization_review.results["data.structured-truth"].state, "completed");
    let hostState = await fspReadJson(path.join(f.root, ".fixture-organization-review.json"));
    assert.equal(hostState.operations.filter((entry) => entry.operation === "data.structured-truth").length, 1);
    assert.equal(
      hostState.operations.find((entry) => entry.operation === "data.structured-truth").idempotency_key,
      `gateway:${run.run_id}:organization-review:data.structured-truth`
    );

    await live.close();
    live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
    reviewed = await waitOrganizationReview(f.home, run.run_id, ["completed"]);
    assert.equal(reviewed.organization_review.status, "completed");
    hostState = await fspReadJson(path.join(f.root, ".fixture-organization-review.json"));
    assert.equal(hostState.operations.filter((entry) => entry.operation === "data.structured-truth").length, 1);
  } finally {
    await live.close();
  }
});


test("trivial completed turns do not invoke the invisible organization review runtime", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, reviewBudgetRuntimeFixture]),
    runtime_cwd: f.root
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Thanks." }]
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.output.content, "You're welcome.");

    const persisted = await fspReadJson(path.join(f.home, "state", "runs", `${created.run_id}.json`));
    assert.equal(persisted.organization_review.status, "skipped");
    assert.equal(persisted.organization_review.attempts, 0);

    const runtimeState = await fspReadJson(path.join(f.root, ".fixture-review-budget-runtime.json"));
    assert.equal(runtimeState.invocations, 1, "trivial turn must not pay for a second review model call");
    assert.deepEqual(runtimeState.reviews, []);
  } finally {
    await live.close();
  }
});

test("substantial completed work gets one explicitly capped review call", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, reviewBudgetRuntimeFixture]),
    runtime_cwd: f.root
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "Review the completed Client Alpha delivery against the full brief, compare the final result with the previously accepted version, verify every requested item carefully, check the evidence for inconsistencies, keep the findings concise, and prepare a final handoff that can be reused confidently for the next delivery review."
        }],
        metadata: { workspace_id: "alpha" }
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");

    const reviewed = await waitOrganizationReview(f.home, created.run_id, ["completed"]);
    assert.equal(reviewed.organization_review.attempts, 1);
    assert.equal(reviewed.organization_review.budget.state, "within");
    assert.equal(reviewed.organization_review.budget.max_evidence_chars, 5600);
    assert.equal(reviewed.organization_review.budget.max_output_tokens, 768);
    assert.equal(reviewed.organization_review.budget.max_actions, 4);
    assert.equal(reviewed.organization_review.budget.max_reported_cost, 0.02);
    assert.equal(reviewed.organization_review.runtime_usage.output_tokens, 32);
    assert.equal(reviewed.organization_review.runtime_usage.cost, 0.004);

    const runtimeState = await fspReadJson(path.join(f.root, ".fixture-review-budget-runtime.json"));
    assert.equal(runtimeState.invocations, 2, "substantial work should get exactly one foreground call plus one review call");
    assert.equal(runtimeState.reviews.length, 1);
    assert.equal(runtimeState.reviews[0].max_output_tokens, 768);
    assert.ok(runtimeState.reviews[0].evidence_chars <= 5650);
  } finally {
    await live.close();
  }
});

test("over-budget review output is discarded before any canonical owner action", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, reviewBudgetRuntimeFixture]),
    runtime_cwd: f.root
  });
  const sessionId = "sess-review-budget-limit";
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "OVESPEND_REVIEW_TEST Review this substantial completed project carefully, verify the full delivery against every requested requirement and prior accepted evidence, identify any reusable organization opportunity, keep the result safe and internal, and prepare a concise final handoff without changing permissions or creating any durable responsibility."
        }],
        metadata: { session_id: sessionId }
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");

    const reviewed = await waitOrganizationReview(f.home, created.run_id, ["budget_limited"]);
    assert.equal(reviewed.organization_review.budget.state, "exceeded");
    assert.equal(reviewed.organization_review.proposal.actions.length, 0);
    assert.ok(reviewed.organization_review.proposal.rejected.some((item) =>
      item.operation === "review" && item.reason === "review_budget_exceeded"
    ));
    assert.deepEqual(reviewed.organization_review.results, {});

    const session = await fspReadJson(path.join(f.home, "state", "sessions", `${sessionId}.json`));
    assert.equal(session.workspace_id, "operator", "over-budget proposal must not reach workspace owner mutation");

    const eventsBody = await readFile(path.join(f.home, "state", "events", `${created.run_id}.ndjson`), "utf8");
    const events = eventsBody.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "organization.review.action_completed"), false);
    assert.equal(events.some((event) => event.type === "organization.review.budget_limited"), true);
    assert.equal(events.some((event) => event.type === "organization.review.budget_limited_completed"), true);
  } finally {
    await live.close();
  }
});


test("ordinary user outcomes hide subsystem jargon while technical receipts remain exact", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, outcomeLanguageRuntimeFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "Please organize the ongoing Client Alpha delivery work automatically and tell me the result in normal language."
        }]
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");

    const forbidden = [
      "AI-Verse Gateway",
      "AI-Verse OS",
      "workspace.ensure",
      "canonical owner",
      "canonical state",
      "execution_binding",
      "workspace_organization"
    ];
    for (const term of forbidden) {
      assert.equal(done.output.content.includes(term), false, `normal output leaked ${term}`);
    }
    assert.match(done.output.content, /the system/i);
    assert.match(done.output.content, /automatic organization/i);
    assert.match(done.output.content, /source of truth/i);
    assert.match(done.output.content, /saved state/i);
    assert.match(done.output.content, /technical execution details/i);
    assert.match(done.output.content, /work organization details/i);

    const eventsBody = await readFile(path.join(f.home, "state", "events", `${created.run_id}.ndjson`), "utf8");
    const events = eventsBody.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const deltas = events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.data?.text ?? ""))
      .join("");
    for (const term of forbidden) {
      assert.equal(deltas.includes(term), false, `streamed assistant output leaked ${term}`);
    }
    const normalizedEvents = events.filter((event) => event.type === "assistant.presentation.normalized");
    assert.ok(normalizedEvents.length >= 2);
    assert.equal(normalizedEvents.every((event) => event.data?.technical_receipts_preserved === true), true);

    const persisted = await fspReadJson(path.join(f.home, "state", "runs", `${created.run_id}.json`));
    const toolCallMessage = persisted.messages.find((message) =>
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => call?.function?.name === "aiverse_action")
    );
    assert.ok(toolCallMessage);
    const exactArgs = JSON.parse(toolCallMessage.tool_calls[0].function.arguments);
    assert.equal(exactArgs.operation, "workspace.ensure");

    const toolReceipt = persisted.messages.find((message) =>
      message.role === "tool" &&
      message.tool_call_id === "outcome_language_workspace"
    );
    assert.ok(toolReceipt);
    const receipt = JSON.parse(toolReceipt.content);
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.result.workspace_organization.state, "created");
    assert.equal(receipt.result.workspace_organization.workspace.id, "client-alpha");
  } finally {
    await live.close();
  }
});

test("explicit technical inspection preserves exact subsystem language", async () => {
  const f = await base();
  const setup = await setupComponent({
    home: f.home,
    system_root: f.root,
    host_config: f.hostConfig,
    runtime: "json-subprocess",
    runtime_command: JSON.stringify([process.execPath, outcomeLanguageRuntimeFixture])
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{
          role: "user",
          content: "Show me the raw technical receipt and exact AI-Verse Gateway workspace.ensure details, including canonical owner and canonical state terminology."
        }]
      })
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    const done = await waitStatus(baseUrl, setup.api_token, created.run_id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.match(done.output.content, /AI-Verse Gateway/);
    assert.match(done.output.content, /workspace\.ensure/);
    assert.match(done.output.content, /canonical owner/);
    assert.match(done.output.content, /AI-Verse OS canonical state/);
    assert.match(done.output.content, /execution_binding/);
    assert.match(done.output.content, /workspace_organization/);

    const eventsBody = await readFile(path.join(f.home, "state", "events", `${created.run_id}.ndjson`), "utf8");
    const events = eventsBody.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "assistant.presentation.normalized"), false);
  } finally {
    await live.close();
  }
});

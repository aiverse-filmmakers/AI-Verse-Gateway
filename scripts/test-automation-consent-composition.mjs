#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { installComponent, setupComponent } from "../src/lifecycle.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

const execFileAsync = promisify(execFile);

const osRoot = requiredEnv("OS_ROOT");
const automationState = requiredEnv("AUTOMATIONS_STATE");
const hostConfig = requiredEnv("HOST_CONFIG");

await prepareOsWorkspace(osRoot);
await prepareAutomationsOwner(osRoot, automationState);
await execFileAsync("python", [
  path.join(osRoot, "scripts", "ai_verse_host_adapter.py"),
  "--root", osRoot,
  "--write-config", hostConfig
]);

const home = await mkdtemp(path.join(os.tmpdir(), "gateway-automation-composed-"));
await installComponent({ home });
const setup = await setupComponent({
  home,
  system_root: osRoot,
  host_config: hostConfig,
  runtime: "deterministic"
});

let config = await loadConfig(home);
let live = await startServer(config, home, { port: 0 });
let baseUrl = `http://127.0.0.1:${live.port}`;
process.env.GATEWAY_AUTOMATION_TOKEN = setup.api_token;

await configureGatewayTarget(automationState, baseUrl, setup.api_token);

const store = live.store;
const engine = live.engine;
const session = await store.createSession({
  system_id: config.system.id,
  workspace_id: "alpha",
  principal: "operator"
});

const run = await store.createRun({
  session_id: session.session_id,
  system_id: config.system.id,
  workspace_id: "alpha",
  principal: "operator",
  runtime: { kind: "deterministic", model: "aiverse" },
  messages: [{
    role: "user",
    content: "Every Monday at 09:00 Europe/Bucharest, review the Client Alpha delivery checklist and prepare the usual concise summary."
  }],
  goal_binding: null,
  max_turns: 1,
  budget: { max_tokens: 6000, max_cost: null, max_actions: 4 },
  deadline_at: new Date(Date.now() + 120000).toISOString()
});

const call = automationCall("call_composed_automation_direct");
run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
await store.saveRun(run);
const outcome = await engine.handleToolCalls(run, [call], "workspace:alpha");
assert(outcome === "done", "Gateway recurring creation did not complete");

const createdRun = await store.getRun(run.run_id);
assert(createdRun.usage.actions === 1, "consented recurring creation did not reach the real owner exactly once");
const tool = JSON.parse(createdRun.messages.at(-1).content);
assert(tool?.result?.automation?.state === "created", "canonical Automation was not created");
assert(tool?.result?.automation?.consent_mode === "direct_request", "direct consent provenance was lost");
assert(tool?.execution_binding?.owner === "ai-verse-automations", "canonical Automations owner binding missing");
const automationId = tool.result.automation.automation_id;

const noConsent = await store.createRun({
  session_id: session.session_id,
  system_id: config.system.id,
  workspace_id: "alpha",
  principal: "operator",
  runtime: { kind: "deterministic", model: "aiverse" },
  messages: [{
    role: "user",
    content: "We seem to do this every Monday at 09:00 Europe/Bucharest and it keeps taking time."
  }],
  goal_binding: null,
  max_turns: 1,
  budget: { max_tokens: 6000, max_cost: null, max_actions: 4 },
  deadline_at: new Date(Date.now() + 120000).toISOString()
});
const noConsentCall = automationCall("call_composed_automation_without_consent");
noConsent.messages.push({ role: "assistant", content: "", tool_calls: [noConsentCall] });
await store.saveRun(noConsent);
await engine.handleToolCalls(noConsent, [noConsentCall], "workspace:alpha");
const suppressed = await store.getRun(noConsent.run_id);
assert(suppressed.usage.actions === 0, "repeated need crossed the recurring consent boundary");
assert(JSON.parse(suppressed.messages.at(-1).content)?.result?.automation?.state === "not_created", "no-consent request was not suppressed");

const firedRun = await fireAutomation(automationState, automationId, setup.api_token);
const wake = firedRun.wake;
assert(wake?.automation_id === automationId && wake?.target_kind === "gateway", "Automations fired an invalid Gateway wake");

let scheduledRun = await findScheduledRun(home, wake.invocation_id);
const deadline = Date.now() + 5000;
while (scheduledRun && ["queued", "running", "resuming", "waiting_tool"].includes(scheduledRun.status) && Date.now() < deadline) {
  await sleep(25);
  scheduledRun = await store.getRun(scheduledRun.run_id);
}
assert(scheduledRun, "Gateway did not create a run from the canonical Automations wake");
assert(scheduledRun.status === "completed", `scheduled Gateway run did not complete: ${scheduledRun.status}`);
assert(scheduledRun.workspace_id === "alpha", "scheduled run lost workspace scope");
assert(scheduledRun.automation_binding?.automation_id === automationId, "scheduled run lost Automation provenance");

const originalScheduledRunId = scheduledRun.run_id;
await live.close();

config = await loadConfig(home);
live = await startServer(config, home, { port: 0 });
baseUrl = `http://127.0.0.1:${live.port}`;

const replayResponse = await fetch(`${baseUrl}/v1/automations/invoke`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${setup.api_token}`,
    "content-type": "application/json"
  },
  body: JSON.stringify(wake)
});
assert(replayResponse.status === 200, `restart replay returned HTTP ${replayResponse.status}`);
const replay = await replayResponse.json();
assert(replay.replayed === true && replay.run_id === originalScheduledRunId, "exact wake replay after Gateway restart did not resolve to the original run");

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
assert(changedResponse.status === 409, "changed wake replay was not rejected");
await live.close();

await verifyCanonicalState(automationState, automationId);
console.log("Gateway -> OS -> Automations -> Gateway recurring consent composition: PASS");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

async function prepareOsWorkspace(root) {
  const workspace = path.join(root, "workspaces", "alpha");
  await mkdir(path.join(workspace, "context"), { recursive: true });
  await writeFile(path.join(workspace, "WORKSPACE.yaml"), `schema_version: "2.0"
id: alpha
name: Alpha
type: project
status: active
purpose: End-to-end recurring responsibility acceptance.
domains: []
owners: []
success_criteria: []
canonical_sources: []
connections: []
current_context: context/CURRENT.md
`);
  await writeFile(path.join(workspace, "context", "CURRENT.md"), `# Current Workspace Context

## Objective

Maintain Client Alpha delivery quality.

## Current state

Weekly review work is active.
`);
}

async function prepareAutomationsOwner(root, state) {
  await execFileAsync("python", ["-c", `
import os
from pathlib import Path
from aiverse_automations.lifecycle import setup
from aiverse_automations.os_extension import install_os_extension
state=Path(os.environ["AUTOMATIONS_STATE"])
root=Path(os.environ["OS_ROOT"])
report=setup(state,os_root=str(root),enable=True)
assert report["state"]=="ready", report
attached=install_os_extension(state,root)
assert attached["status"] in {"installed","unchanged"}, attached
`], { env: { ...process.env, OS_ROOT: root, AUTOMATIONS_STATE: state } });
}

async function configureGatewayTarget(state, url, token) {
  await execFileAsync("python", ["-c", `
import os
from pathlib import Path
from aiverse_automations.config import load_config, save_config
state=Path(os.environ["AUTOMATIONS_STATE"])
cfg=load_config(state,required=True)
cfg.setdefault("targets",{})["gateway"]={
    "url":os.environ["GATEWAY_URL"]+"/v1/automations/invoke",
    "bearer_token_ref":"env:GATEWAY_AUTOMATION_TOKEN",
}
save_config(state,cfg)
`], {
    env: {
      ...process.env,
      AUTOMATIONS_STATE: state,
      GATEWAY_URL: url,
      GATEWAY_AUTOMATION_TOKEN: token
    }
  });
}

function automationCall(id) {
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
          trigger: {
            kind: "cron",
            spec: {
              expr: "0 9 * * MON",
              timezone: "Europe/Bucharest"
            }
          }
        },
        reason: "Create the recurring responsibility explicitly requested by the user."
      })
    }
  };
}

async function fireAutomation(state, automationId, token) {
  const fired = await execFileAsync("python", ["-c", `
import json, os
from pathlib import Path
from aiverse_automations.engine import Engine
from aiverse_automations.store import Store
state=Path(os.environ["AUTOMATIONS_STATE"])
store=Store(state)
rows=store.list_automations()
assert len(rows)==1, rows
assert rows[0]["id"]==os.environ["AUTOMATION_ID"], rows
result=Engine(state).run_now(os.environ["AUTOMATION_ID"])
assert result["status"]=="succeeded", result
print(json.dumps(result))
`], {
    env: {
      ...process.env,
      AUTOMATIONS_STATE: state,
      AUTOMATION_ID: automationId,
      GATEWAY_AUTOMATION_TOKEN: token
    },
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(fired.stdout.trim().split(/\r?\n/).at(-1));
}

async function findScheduledRun(home, invocationId) {
  const runsDir = path.join(home, "state", "runs");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const name of await readdir(runsDir)) {
      if (!name.endsWith(".json")) continue;
      const item = JSON.parse(await readFile(path.join(runsDir, name), "utf8"));
      if (item?.automation_binding?.invocation_id === invocationId) return item;
    }
    await sleep(25);
  }
  return null;
}

async function verifyCanonicalState(state, automationId) {
  await execFileAsync("python", ["-c", `
import os
from pathlib import Path
from aiverse_automations.store import Store
store=Store(Path(os.environ["AUTOMATIONS_STATE"]))
rows=store.list_automations()
assert len(rows)==1, rows
automation=rows[0]
assert automation["id"]==os.environ["AUTOMATION_ID"], automation
assert automation["scope"]=="workspace:alpha"
assert automation["target_kind"]=="gateway"
assert automation["action_class"]=="read_local"
assert automation["wake"]["created_via"]=="gateway_explicit_consent"
assert automation["wake"]["consent"]["mode"]=="direct_request"
triggers=store.list_triggers(automation["id"])
assert len(triggers)==1, triggers
assert triggers[0]["kind"]=="cron"
assert triggers[0]["spec"]=={"expr":"0 9 * * MON","timezone":"Europe/Bucharest"}
`], {
    env: { ...process.env, AUTOMATIONS_STATE: state, AUTOMATION_ID: automationId }
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

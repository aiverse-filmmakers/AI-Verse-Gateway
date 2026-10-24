import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, atomicJson } from "../src/util.mjs";
import { hashToken } from "../src/auth.mjs";
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
    let eventLoopTicks = 0;
    const probe = setInterval(() => { eventLoopTicks += 1; }, 5);
    probe.unref();
    const invalidFlood = Array.from({ length: 24 }, (_, index) =>
      fetch(`http://127.0.0.1:${live.port}/status`, { headers: { authorization: `Bearer invalid-${index}` } })
    );
    const authenticatedDuringFlood = fetch(`http://127.0.0.1:${live.port}/status`, { headers: { authorization: `Bearer ${setup.api_token}` } });
    const [invalidResponses, validResponse] = await Promise.all([Promise.all(invalidFlood), authenticatedDuringFlood]);
    clearInterval(probe);
    assert.equal(invalidResponses.every((response) => response.status === 401), true);
    assert.equal(validResponse.status, 200, "authenticated traffic remains serviceable during invalid-bearer load");
    assert.ok(eventLoopTicks > 0, "event loop continues to make progress during scrypt verification");
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
  const un=await uninstallComponent({home:f.home}); assert.equal(un.canonical_state_preserved,true); const idemKey = "run:clean-1";
  const idemRecord = path.join(f.home, "state", "idempotency", "records", sha256(idemKey).slice(0, 2), `${sha256(idemKey)}.json`);
  assert.match(await readFile(idemRecord, "utf8"), /clean-1/);
});

test("canonical /v1 run caller retains scope, replays safely and exposes authenticated events", async () => {
  const f = await fixture();
  await installComponent({ home: f.home });
  const setup = await setupComponent({
    home: f.home, system_root: f.root, host_config: f.hostConfig, runtime: "deterministic"
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const base = `http://127.0.0.1:${live.port}`;
  const token = setup.api_token;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "consumer-run-1"
  };
  const request = { model: "aiverse", messages: [{ role: "user", content: "bounded smoke" }], metadata: { workspace_id: "operator" } };
  const post = (body) => fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: headers.authorization } });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, "aiverse");

    const created = await post(request);
    assert.equal(created.status, 202);
    const run = await created.json();
    assert.match(run.run_id, /^run_/);
    assert.equal(run.system_id, "local");
    assert.equal(run.workspace_id, "operator");
    assert.equal(Object.hasOwn(run, "messages"), false, "run metadata never exposes transcript bodies");

    const replay = await post(request);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).run_id, run.run_id, "identical HTTP retry cannot create another run");

    const scopeChange = await post({ ...request, metadata: { workspace_id: "different" } });
    assert.equal(scopeChange.status, 409, "reusing operation identity for another workspace fails closed");
    assert.equal((await scopeChange.json()).error.code, "IDEMPOTENCY_CONFLICT");

    const noBearer = await fetch(`${base}/v1/runs/${run.run_id}`);
    assert.equal(noBearer.status, 401);
    const scoped = await fetch(`${base}/v1/runs/${run.run_id}`, {
      headers: { authorization: headers.authorization }
    });
    assert.equal(scoped.status, 200);
    const lookedUp = await scoped.json();
    assert.equal(lookedUp.run_id, run.run_id);
    assert.equal(lookedUp.system_id, "local");
    assert.equal(lookedUp.workspace_id, "operator");
    assert.equal(Object.hasOwn(lookedUp, "messages"), false);

    const eventRes = await fetch(`${base}/v1/runs/${run.run_id}/events`, {
      headers: { authorization: headers.authorization },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(eventRes.status, 200);
    assert.match(eventRes.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = eventRes.body.getReader();
    try {
      const first = await reader.read();
      assert.equal(first.done, false, "event SSE replays already-persisted run events");
      const data = new TextDecoder().decode(first.value);
      assert.match(data, /event: run\.started/);
      assert.ok(data.includes(run.run_id), "event data is bound to the requested run");
    } finally {
      await reader.cancel();
    }
    const forbiddenEvents = await fetch(`${base}/v1/runs/${run.run_id}/events`);
    assert.equal(forbiddenEvents.status, 401, "run event stream is not public");
  } finally {
    await live.close();
  }
});

test("ordinary chat remains usable while unconfigured Brain Goal continuation fails closed", async () => {
  const f = await fixture();
  await installComponent({ home: f.home });
  const setup = await setupComponent({
    home: f.home, system_root: f.root, host_config: f.hostConfig, runtime: "deterministic"
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const base = `http://127.0.0.1:${live.port}`;
  const headers = { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" };
  try {
    const statusResponse = await fetch(`${base}/status`, { headers });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.state, "ready");
    assert.equal(status.goal_owner_configured, false, "Goal configured means config presence, not model readiness");

    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "aiverse", messages: [{ role: "user", content: "hello without a Goal" }] })
    });
    assert.equal(chat.status, 200, "ordinary non-Goal chat does not depend on Brain Goal transport");
    assert.match((await chat.json()).choices[0].message.content, /hello without a Goal/);

    const goal = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "aiverse",
        messages: [{ role: "user", content: "continue this Goal" }],
        metadata: { goal_id: "goal_without_owner", workspace_id: "operator", system_id: "forged-system" }
      })
    });
    assert.equal(goal.status, 202);
    const created = await goal.json();
    assert.equal(created.system_id, "local", "caller-supplied system_id cannot retarget the Gateway");
    assert.equal(created.workspace_id, "operator");

    let finalRun;
    const deadline = Date.now() + 7000;
    do {
      const response = await fetch(`${base}/v1/runs/${created.run_id}`, { headers });
      assert.equal(response.status, 200);
      finalRun = await response.json();
      if (finalRun.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);

    assert.equal(finalRun.status, "failed", "no Goal transport never becomes an invented completed run");
    assert.equal(finalRun.error.code, "GOAL_OWNER_UNAVAILABLE");
    assert.match(finalRun.error.message, /Brain Goal owner adapter is not configured/);
    assert.equal(finalRun.system_id, "local");
    const rawEvents = await readFile(path.join(f.home, "state", "events", `${created.run_id}.ndjson`), "utf8");
    const events = rawEvents.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "run.failed" && event.data.code === "GOAL_OWNER_UNAVAILABLE"));
    assert.equal(events.some((event) => ["assistant.delta", "goal.evaluated", "approval.required"].includes(event.type)), false,
      "unconfigured Brain Goal owner must fail before model or owner-effect continuation");
  } finally {
    await live.close();
  }
});

test("fast authenticated OpenAI SSE completes with a terminal marker and never bypasses Origin", async () => {
  const f = await fixture();
  await installComponent({ home: f.home });
  const setup = await setupComponent({
    home: f.home, system_root: f.root, host_config: f.hostConfig, runtime: "deterministic"
  });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const endpoint = `http://127.0.0.1:${live.port}/v1/chat/completions`;
  const payload = JSON.stringify({ model: "aiverse", stream: true, messages: [{ role: "user", content: "stream exact answer" }] });
  const headers = { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" };
  try {
    const missingAuth = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    assert.equal(missingAuth.status, 401);
    const forbiddenOrigin = await fetch(endpoint, { method: "POST", headers: { ...headers, origin: "https://not-allowed.example" }, body: payload });
    assert.equal(forbiddenOrigin.status, 403);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(endpoint, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const streamText = await response.text();
      assert.ok(streamText.includes("data: [DONE]"), "even a fast completed run must terminate SSE instead of hanging");
      const chunks = streamText.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice("data: ".length)));
      assert.ok(chunks.length >= 2, "expected text and terminal chunks");
      assert.equal(chunks.every((chunk) => chunk.object === "chat.completion.chunk"), true);
      assert.ok(chunks.some((chunk) => chunk.choices[0].delta.content?.includes("stream exact answer")));
      assert.ok(chunks.some((chunk) => chunk.choices[0].finish_reason === "stop"));
    }
  } finally {
    await live.close();
  }
});

test("two installed systems switch A→B→A without session, workspace or principal replay leakage", async () => {
  const a = await fixture();
  const b = await fixture();
  await installComponent({ home: a.home });
  await installComponent({ home: b.home });
  // A has an explicitly configured owner transport; B intentionally does not.
  const goalConfigA = path.join(a.root, "goal-owner.json");
  await writeFile(goalConfigA, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, path.resolve(here, "..", "fixtures", "fake-goal-owner.mjs")],
    timeout_seconds: 10, max_output_bytes: 1048576, max_stderr_bytes: 65536,
    env_names: [], cwd: a.root
  }));
  const setupA = await setupComponent({
    home: a.home, system_root: a.root, host_config: a.hostConfig,
    system_id: "system-a", runtime: "deterministic", goal_owner_config: goalConfigA
  });
  const setupB = await setupComponent({
    home: b.home, system_root: b.root, host_config: b.hostConfig,
    system_id: "system-b", runtime: "deterministic"
  });
  const configA = await loadConfig(a.home);
  const foreignToken = "second-principal-test-credential";
  configA.auth.keys.push(hashToken(foreignToken, "foreign-principal"));
  await atomicJson(path.join(a.home, "config.json"), configA);

  const liveA = await startServer(await loadConfig(a.home), a.home, { port: 0 });
  const liveB = await startServer(await loadConfig(b.home), b.home, { port: 0 });
  const urlA = `http://127.0.0.1:${liveA.port}`;
  const urlB = `http://127.0.0.1:${liveB.port}`;
  const headers = (token, key) => ({
    authorization: `Bearer ${token}`, "content-type": "application/json",
    ...(key ? { "idempotency-key": key } : {})
  });
  const postRun = (base, token, body, key) => fetch(`${base}/v1/runs`, {
    method: "POST", headers: headers(token, key), body: JSON.stringify(body)
  });
  const userMessage = [{ role: "user", content: "system switch isolation" }];
  const requestA = { model: "aiverse", messages: userMessage, metadata: { workspace_id: "alpha", system_id: "system-b" } };
  const requestB = { model: "aiverse", messages: userMessage, metadata: { workspace_id: "beta", system_id: "system-a" } };
  let runA, runB;
  try {
    const firstA = await postRun(urlA, setupA.api_token, requestA, "shared-client-retry");
    assert.equal(firstA.status, 202);
    runA = await firstA.json();
    assert.equal(runA.system_id, "system-a", "client cannot retarget a configured Gateway");
    assert.equal(runA.workspace_id, "alpha");
    assert.equal(runA.principal, "operator");

    const switchedB = await postRun(urlB, setupB.api_token, requestB, "shared-client-retry");
    assert.equal(switchedB.status, 202);
    runB = await switchedB.json();
    assert.equal(runB.system_id, "system-b");
    assert.equal(runB.workspace_id, "beta");
    assert.notEqual(runB.run_id, runA.run_id, "separate canonical stores must not share run IDs");

    const backA = await postRun(urlA, setupA.api_token, {
      model: "aiverse", messages: userMessage,
      metadata: { session_id: runA.session_id, system_id: "system-b" }
    }, "back-to-system-a");
    assert.equal(backA.status, 202);
    const returnA = await backA.json();
    assert.equal(returnA.system_id, "system-a");
    assert.equal(returnA.workspace_id, "alpha", "existing session retains canonical workspace on return");
    assert.equal(returnA.session_id, runA.session_id);

    const wrongWorkspace = await postRun(urlA, setupA.api_token, {
      model: "aiverse", messages: userMessage,
      metadata: { session_id: runA.session_id, workspace_id: "beta" }
    });
    assert.equal(wrongWorkspace.status, 409);
    assert.equal((await wrongWorkspace.json()).error.code, "SESSION_BINDING_MISMATCH");

    const foreignRun = await postRun(urlA, foreignToken, requestA, "shared-client-retry");
    assert.equal(foreignRun.status, 409, "foreign principal cannot replay or read the owner's run using the same key");
    assert.equal((await foreignRun.json()).error.code, "IDEMPOTENCY_CONFLICT");
    const ownerReplay = await postRun(urlA, setupA.api_token, requestA, "shared-client-retry");
    assert.equal(ownerReplay.status, 202);
    assert.equal((await ownerReplay.json()).run_id, runA.run_id);

    const foreignRead = await fetch(`${urlA}/v1/runs/${runA.run_id}`, { headers: headers(foreignToken) });
    assert.equal(foreignRead.status, 403);
    const crossSystemRead = await fetch(`${urlA}/v1/runs/${runB.run_id}`, { headers: headers(setupA.api_token) });
    assert.equal(crossSystemRead.status, 404);
    const foreignSystemBearer = await fetch(`${urlA}/v1/runs/${runA.run_id}`, { headers: headers(setupB.api_token) });
    assert.equal(foreignSystemBearer.status, 401);

    const onA = await postRun(urlA, setupA.api_token, {
      model: "aiverse", messages: [{ role: "user", content: "evaluate owned goal" }],
      metadata: { workspace_id: "alpha", goal_id: "goal_fixture", system_id: "system-b" }
    });
    assert.equal(onA.status, 202);
    const goalA = await onA.json();
    let ownerResult;
    for (let n = 0; n < 150; n += 1) {
      ownerResult = await (await fetch(`${urlA}/v1/runs/${goalA.run_id}`, { headers: headers(setupA.api_token) })).json();
      if (["completed", "failed"].includes(ownerResult.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(ownerResult.status, "completed", "only A's configured Goal owner evaluates its scoped Goal");
    assert.deepEqual(ownerResult.goal_binding, { goal_id: "goal_fixture", version: 1, activation_epoch: 1 });
    assert.equal(ownerResult.system_id, "system-a");
    assert.equal(ownerResult.workspace_id, "alpha");

    const onB = await postRun(urlB, setupB.api_token, {
      model: "aiverse", messages: [{ role: "user", content: "evaluate other system's goal" }],
      metadata: { workspace_id: "beta", goal_id: "goal_fixture", system_id: "system-a" }
    });
    assert.equal(onB.status, 202);
    const goalB = await onB.json();
    let absentOwner;
    for (let n = 0; n < 150; n += 1) {
      absentOwner = await (await fetch(`${urlB}/v1/runs/${goalB.run_id}`, { headers: headers(setupB.api_token) })).json();
      if (["failed", "completed"].includes(absentOwner.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(absentOwner.status, "failed", "B may not borrow A's Goal owner");
    assert.equal(absentOwner.error.code, "GOAL_OWNER_UNAVAILABLE");
    assert.equal(absentOwner.system_id, "system-b");
    assert.equal(absentOwner.workspace_id, "beta");
    const statusA = await (await fetch(`${urlA}/status`, { headers: headers(setupA.api_token) })).json();
    const statusB = await (await fetch(`${urlB}/status`, { headers: headers(setupB.api_token) })).json();
    assert.equal(statusA.goal_owner_configured, true);
    assert.equal(statusB.goal_owner_configured, false);
  } finally {
    await liveA.close();
    await liveB.close();
  }

  // Cold-start both canonical homes without a new registry or cloned Goal truth.
  const restartedA = await startServer(await loadConfig(a.home), a.home, { port: 0 });
  const restartedB = await startServer(await loadConfig(b.home), b.home, { port: 0 });
  try {
    const baseA = `http://127.0.0.1:${restartedA.port}`;
    const baseB = `http://127.0.0.1:${restartedB.port}`;
    const replayA = await fetch(`${baseA}/v1/runs/${runA.run_id}`, { headers: headers(setupA.api_token) });
    assert.equal(replayA.status, 200);
    const recoveredA = await replayA.json();
    assert.equal(recoveredA.system_id, "system-a");
    assert.equal(recoveredA.workspace_id, "alpha");
    assert.equal(recoveredA.principal, "operator");
    const replayB = await fetch(`${baseB}/v1/runs/${runB.run_id}`, { headers: headers(setupB.api_token) });
    assert.equal(replayB.status, 200);
    assert.equal((await replayB.json()).system_id, "system-b");
    assert.equal((await fetch(`${baseB}/v1/runs/${runA.run_id}`, { headers: headers(setupB.api_token) })).status, 404);
    const resumedOwnerReplay = await postRun(baseA, setupA.api_token, requestA, "shared-client-retry");
    assert.equal(resumedOwnerReplay.status, 202);
    assert.equal((await resumedOwnerReplay.json()).run_id, runA.run_id);
    const statusA = await (await fetch(`${baseA}/status`, { headers: headers(setupA.api_token) })).json();
    const statusB = await (await fetch(`${baseB}/status`, { headers: headers(setupB.api_token) })).json();
    assert.equal(statusA.goal_owner_configured, true);
    assert.equal(statusB.goal_owner_configured, false);
  } finally {
    await restartedA.close();
    await restartedB.close();
  }
});

test("event SSE bridges snapshot replay to live subscription without dropping or duplicating interleaved events", async () => {
  const f = await fixture();
  await installComponent({ home: f.home });
  const setup = await setupComponent({ home: f.home, system_root: f.root, host_config: f.hostConfig, runtime: "deterministic" });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const origin = `http://127.0.0.1:${live.port}`;
  const headers = { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" };
  try {
    const created = await fetch(`${origin}/v1/runs`, {
      method: "POST", headers, body: JSON.stringify({ model: "aiverse", messages: [{ role: "user", content: "SSE replay race fixture" }] })
    });
    assert.equal(created.status, 202);
    const { run_id: runId } = await created.json();
    // Keep a fixed, persisted event visible to snapshot and to buffered live
    // notifications; it must still appear once, not twice.
    let interleaved = false;
    let both;
    const streamEvents = live.store.streamEvents.bind(live.store);
    live.store.streamEvents = async function* (id) {
      if (id !== runId || interleaved) { yield* streamEvents(id); return; }
      interleaved = true;
      const beforeSnapshot = await live.store.event(runId, "test.snapshot_overlap", { mark: "both" });
      yield* streamEvents(id);
      const afterSnapshot = await live.store.event(runId, "test.after_snapshot", { mark: "buffered" });
      both = { beforeSnapshot, afterSnapshot };
    };
    const response = await fetch(`${origin}/v1/runs/${runId}/events`, {
      headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(10000)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    try {
      while (!received.includes('event: test.after_snapshot') || !received.includes('event: test.snapshot_overlap')) {
        const { done, value } = await reader.read();
        assert.equal(done, false, "SSE must deliver events injected during snapshot-to-live boundary");
        received += decoder.decode(value, { stream: true });
        assert.ok(received.length < 250000, "fixture stream remains bounded");
      }
      const envelopes = received.split("\n\n").filter((part) => part.includes("data: "))
        .map((part) => JSON.parse(part.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
      assert.ok(both, "test must exercise the interleaved snapshot hook");
      assert.equal(envelopes.filter((event) => event.event_id === both.beforeSnapshot.event_id).length, 1,
        "an event in both snapshot and live queue is delivered exactly once");
      assert.equal(envelopes.filter((event) => event.event_id === both.afterSnapshot.event_id).length, 1,
        "an event after snapshot must be delivered from live buffer exactly once");
      const order = envelopes.map((event) => event.event_id);
      assert.ok(order.indexOf(both.beforeSnapshot.event_id) < order.indexOf(both.afterSnapshot.event_id));
    } finally {
      await reader.cancel();
    }
  } finally {
    await live.close();
  }
});

test("event SSE incrementally replays 1400 canonical events without whole-history materialization", async () => {
  const f = await fixture();
  await installComponent({ home: f.home });
  const setup = await setupComponent({ home: f.home, system_root: f.root, host_config: f.hostConfig, runtime: "deterministic" });
  const live = await startServer(await loadConfig(f.home), f.home, { port: 0 });
  const base = `http://127.0.0.1:${live.port}`;
  const headers = { authorization: `Bearer ${setup.api_token}`, "content-type": "application/json" };
  try {
    const created = await fetch(`${base}/v1/runs`, { method: "POST", headers,
      body: JSON.stringify({ model: "aiverse", messages: [{ role: "user", content: "high volume replay" }] }) });
    assert.equal(created.status, 202);
    const { run_id: runId } = await created.json();
    const ids = [];
    for (let i = 0; i < 1400; i += 1) {
      const event = await live.store.event(runId, "test.history", { ordinal: i });
      ids.push(event.event_id);
    }
    live.store.listEvents = () => { throw new Error("unbounded array replay forbidden on the SSE path"); };
    const response = await fetch(`${base}/v1/runs/${runId}/events`, {
      headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(15000)
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = "", count = 0, first = null, last = null;
    try {
      while (count < ids.length) {
        const { done, value } = await reader.read();
        assert.equal(done, false);
        raw += decoder.decode(value, { stream: true });
        for (;;) {
          const sep = raw.indexOf("\n\n");
          if (sep < 0) break;
          const message = raw.slice(0, sep);
          raw = raw.slice(sep + 2);
          if (!message.includes("event: test.history")) continue;
          const event = JSON.parse(message.split("\n").find((line) => line.startsWith("data: ")).slice(6));
          if (first === null) first = event;
          last = event;
          assert.equal(event.data.ordinal, count, "no event reorder or loss across bounded-memory replay");
          count += 1;
        }
        assert.ok(raw.length < 8 * 1024 * 1024, "only an incomplete response frame may stay buffered");
      }
      assert.equal(first.event_id, ids[0]);
      assert.equal(last.event_id, ids[ids.length - 1]);
    } finally { await reader.cancel(); }
  } finally { await live.close(); }
});

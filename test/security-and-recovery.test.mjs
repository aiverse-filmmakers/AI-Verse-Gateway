import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayStore } from "../src/store.mjs";
import { hashToken, verifyToken } from "../src/auth.mjs";
import { GatewayError } from "../src/errors.mjs";
import { atomicJson, readJson } from "../src/util.mjs";
import { RunEngine } from "../src/run-engine.mjs";

test("auth stores a one-way scrypt verifier", () => { const token="secret-fixture";const record=hashToken(token,"operator");assert.equal(record.hash.includes(token),false);assert.equal(verifyToken(token,record),true);assert.equal(verifyToken("wrong",record),false); });


test("atomic JSON replacement serializes same-file writers and leaves one valid record", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-atomic-json-"));
  const file = path.join(home, "state", "shared.json");
  const writes = Array.from({ length: 48 }, (_, sequence) =>
    atomicJson(file, { schema_version: "1.0", sequence, payload: "x".repeat(64) })
  );
  await Promise.all(writes);
  const saved = await readJson(file);
  assert.equal(saved.schema_version, "1.0");
  assert.equal(Number.isInteger(saved.sequence), true);
  assert.ok(saved.sequence >= 0 && saved.sequence < 48);
  const names = await readdir(path.dirname(file));
  assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), []);
});

test("idempotency rejects same operation id with changed payload", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-store-"));const store=new GatewayStore(home);await store.init();await store.claimIdempotency("run","same",{a:1});await assert.rejects(()=>store.claimIdempotency("run","same",{a:2}),e=>e instanceof GatewayError&&e.code==="IDEMPOTENCY_CONFLICT");});

test("restart recovery pauses in-flight run instead of claiming provider resume", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-recover-"));const store=new GatewayStore(home);await store.init();const run=await store.createRun({session_id:"sess_x",system_id:"local",workspace_id:"operator",principal:"operator",runtime:{kind:"deterministic"},messages:[{role:"user",content:"x"}],max_turns:1,budget:{max_actions:1},deadline_at:new Date(Date.now()+60000).toISOString()});run.status="running";await store.saveRun(run);const changed=await store.recoverInterrupted();assert.deepEqual(changed,[run.run_id]);assert.equal((await store.getRun(run.run_id)).status,"paused_recovery_required");});

test("storage rejects caller-controlled path-like session ids", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-id-"));const store=new GatewayStore(home);await store.init();await assert.rejects(()=>store.createSession({system_id:"local",workspace_id:"operator",principal:"operator",session_id:"../../escape"}),e=>e instanceof GatewayError&&e.code==="INVALID_ID");});

test("serve-time host override cannot bypass loopback security policy", async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"avg-bind-"));
  const config={enabled:true,server:{host:"127.0.0.1",port:8787,allow_remote:false,behind_tls_proxy:false,max_body_bytes:262144,requests_per_minute:10,allowed_origins:[]},auth:{required:true,keys:[hashToken("x","operator")]},system:{id:"local",root:home,default_workspace:"operator"},host_adapter_config:path.join(home,"host.json"),goal_owner_config:null,runtime:{kind:"deterministic"},limits:{max_goal_continuation_turns:20,no_progress_threshold:2,wall_clock_seconds:120,max_actions:16,max_tokens:null,max_cost:null}};
  const { startServer } = await import("../src/server.mjs");
  await assert.rejects(()=>startServer(config,home,{host:"0.0.0.0",port:0}),e=>e instanceof GatewayError&&e.code==="REMOTE_BIND_UNSAFE");
});


function digestEngineConfig(home) {
  return {
    host_adapter_config: path.join(home, "unused-host.json"),
    goal_owner_config: null,
    runtime: { kind: "deterministic" },
    limits: {
      max_goal_continuation_turns: 20,
      no_progress_threshold: 2,
      wall_clock_seconds: 120,
      max_actions: 16,
      max_tokens: null,
      max_cost: null
    }
  };
}

async function digestFixtureRun(store, overrides = {}) {
  return await store.createRun({
    session_id: overrides.session_id ?? "sess_digest",
    system_id: "local",
    workspace_id: overrides.workspace_id ?? "alpha",
    principal: "operator",
    runtime: { kind: "deterministic" },
    messages: overrides.messages ?? [{
      role: "user",
      content: "Please preserve the completed Client Alpha delivery review outcome for future historical context."
    }],
    max_turns: 1,
    budget: { max_actions: 4, max_tokens: null, max_cost: null },
    deadline_at: new Date(Date.now() + 60000).toISOString()
  });
}

test("completed run remains canonical when optional session digest handoff fails", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-digest-fail-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await digestFixtureRun(store);
  const engine = new RunEngine({ store, config: digestEngineConfig(home) });
  engine.host = {
    authorizeAction: async () => ({ decision: "allow", allowed: true }),
    requestAction: async () => { throw new Error("memory unavailable"); }
  };

  await engine.complete(
    run,
    "The delivery review completed successfully and the concise checkpoint format was validated for future work."
  );

  const saved = await store.getRun(run.run_id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.output.content.includes("completed successfully"), true);
  assert.equal(saved.memory_digest.status, "retryable");
  assert.equal(saved.memory_digest.attempts, 1);
  assert.equal(saved.error, null);
  assert.equal(saved.usage.actions, 0, "internal digest handoff must not consume user action budget");

  const events = await store.listEvents(run.run_id);
  assert.ok(events.some((event) => event.type === "run.completed"));
  assert.ok(events.some((event) => event.type === "memory.session_digest.failed"));
});

test("completed-session digest handoff is compact, scope-bound and excludes raw transcript fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-digest-success-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await digestFixtureRun(store, { session_id: "sess_digest_payload" });
  const engine = new RunEngine({ store, config: digestEngineConfig(home) });
  let ownerRequest = null;
  engine.host = {
    authorizeAction: async (request) => {
      assert.equal(request.operation, "memory.session_digest");
      assert.equal(request.scope, "workspace:alpha");
      return { decision: "allow", allowed: true };
    },
    requestAction: async (request) => {
      ownerRequest = request;
      return {
        status: "succeeded",
        effect_occurred: true,
        result: {
          memory_session_digest: {
            state: "captured",
            changed: true,
            digest_id: "sdg-test-payload"
          }
        }
      };
    }
  };

  await engine.complete(
    run,
    "The Client Alpha delivery review established a concise checkpoint workflow and completed with no unresolved release blockers."
  );

  assert.ok(ownerRequest);
  assert.equal(ownerRequest.action_class, "write_local_reversible");
  assert.equal(ownerRequest.scope, "workspace:alpha");
  assert.equal(ownerRequest.idempotency_key, `gateway:${run.run_id}:session-digest`);
  assert.match(ownerRequest.request_fingerprint, /^[a-f0-9]{64}$/);

  const payload = ownerRequest.parameters;
  for (const forbidden of [
    "messages", "transcript", "scope", "workspace", "effect_id",
    "source_refs", "source_version", "provenance"
  ]) assert.equal(Object.hasOwn(payload, forbidden), false, `${forbidden} must stay owner-derived or absent`);
  assert.equal(payload.session_id, "sess_digest_payload");
  assert.equal(payload.run_id, run.run_id);
  assert.ok(payload.topic.length <= 240);
  assert.ok(payload.summary.length < 5000);
  assert.deepEqual(payload.significant_outcomes, []);
  assert.deepEqual(payload.unresolved_items, []);
  assert.deepEqual(payload.source_coverage, [`gateway:run:${run.run_id}:messages:0-0`]);
  assert.match(payload.source_fingerprint, /^sha256:[a-f0-9]{64}$/);

  const saved = await store.getRun(run.run_id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.memory_digest.status, "captured");
  assert.equal(saved.memory_digest.digest_id, "sdg-test-payload");
  assert.equal(saved.usage.actions, 0);
});

test("retryable completed-session digest is recovered idempotently after restart", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-digest-recover-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await digestFixtureRun(store, { session_id: "sess_digest_recover" });
  const firstEngine = new RunEngine({ store, config: digestEngineConfig(home) });
  let firstRequest = null;
  firstEngine.host = {
    authorizeAction: async () => ({ decision: "allow", allowed: true }),
    requestAction: async (request) => {
      firstRequest = request;
      throw new Error("simulated crash-window owner outage");
    }
  };

  await firstEngine.complete(
    run,
    "The workflow completed with a durable historical outcome that should be retried after Gateway restart."
  );
  assert.equal((await store.getRun(run.run_id)).memory_digest.status, "retryable");

  const secondEngine = new RunEngine({ store, config: digestEngineConfig(home) });
  let secondRequest = null;
  let ownerCalls = 0;
  secondEngine.host = {
    authorizeAction: async () => ({ decision: "allow", allowed: true }),
    requestAction: async (request) => {
      ownerCalls += 1;
      secondRequest = request;
      return {
        status: "succeeded",
        effect_occurred: false,
        result: {
          memory_session_digest: {
            state: "existing",
            changed: false,
            digest_id: "sdg-recovered"
          }
        }
      };
    }
  };

  const recovered = await secondEngine.recoverPendingSessionDigests();
  assert.deepEqual(recovered, [run.run_id]);
  assert.equal(ownerCalls, 1);
  assert.equal(secondRequest.idempotency_key, firstRequest.idempotency_key);
  assert.equal(secondRequest.request_fingerprint, firstRequest.request_fingerprint);

  const saved = await store.getRun(run.run_id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.memory_digest.status, "existing");
  assert.equal(saved.memory_digest.digest_id, "sdg-recovered");
  assert.equal(saved.memory_digest.attempts, 2);

  const recoveredAgain = await secondEngine.recoverPendingSessionDigests();
  assert.deepEqual(recoveredAgain, []);
  assert.equal(ownerCalls, 1);
});

test("secret-like completed sessions are not persisted as session digests", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-digest-secret-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await digestFixtureRun(store, {
    session_id: "sess_digest_secret",
    messages: [{
      role: "user",
      content: "Please remember this api_key = sk-abcdefghijklmnopqrstuvwxyz1234567890 while we finish the deployment."
    }]
  });
  const engine = new RunEngine({ store, config: digestEngineConfig(home) });
  let hostCalls = 0;
  engine.host = {
    authorizeAction: async () => { hostCalls += 1; return { decision: "allow", allowed: true }; },
    requestAction: async () => { hostCalls += 1; return {}; }
  };

  await engine.complete(
    run,
    "Deployment completed, but the supplied api_key = sk-abcdefghijklmnopqrstuvwxyz1234567890 remains sensitive."
  );

  const saved = await store.getRun(run.run_id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.memory_digest.status, "skipped");
  assert.equal(hostCalls, 0);
});

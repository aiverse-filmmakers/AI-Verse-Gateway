import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayStore } from "../src/store.mjs";
import { hashToken, verifyToken, verifyTokenAsync } from "../src/auth.mjs";
import { PreAuthAdmission, RateLimiter, requestPeerKey } from "../src/server.mjs";
import { GatewayError } from "../src/errors.mjs";
import { atomicJson, readJson, renameWithTransientRetry } from "../src/util.mjs";
import { RunEngine } from "../src/run-engine.mjs";

test("auth stores a one-way scrypt verifier", () => { const token="secret-fixture";const record=hashToken(token,"operator");assert.equal(record.hash.includes(token),false);assert.equal(verifyToken(token,record),true);assert.equal(verifyToken("wrong",record),false); });

test("request-time bearer verification uses asynchronous scrypt without blocking the event loop", async () => {
  const record = hashToken("async-fixture-token", "operator");
  const attempts = Array.from({ length: 12 }, () => verifyTokenAsync("invalid-fixture-token", record));
  let settled = 0;
  for (const attempt of attempts) attempt.then(() => { settled += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, 0, "scrypt work should remain pending while the event loop gets a turn");
  assert.deepEqual(await Promise.all(attempts), Array(12).fill(false));
});

test("pre-auth admission bounds concurrent KDF work and releases capacity after completion", async () => {
  const admission = new PreAuthAdmission(10, { maxInFlight: 1, maxInFlightPerPeer: 1 });
  const req = { socket: { remoteAddress: "192.0.2.20" }, headers: {} };
  let release;
  const pending = admission.run(req, () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(
    () => admission.run(req, async () => true),
    (error) => error instanceof GatewayError && error.code === "RATE_LIMITED"
  );
  release("verified");
  assert.equal(await pending, "verified");
  assert.equal(admission.inFlight, 0);
  assert.equal(admission.peerInFlight.size, 0);
});

test("pre-auth limiter bounds transport-peer buckets and ignores forwarded address headers", () => {
  const limiter = new RateLimiter(2, 2);
  const first = { socket: { remoteAddress: "192.0.2.10" }, headers: { "x-forwarded-for": "198.51.100.1" } };
  const second = { socket: { remoteAddress: "192.0.2.10" }, headers: { "x-forwarded-for": "198.51.100.2" } };
  assert.equal(requestPeerKey(first), requestPeerKey(second));
  limiter.take(requestPeerKey(first));
  limiter.take(requestPeerKey(second));
  assert.throws(() => limiter.take(requestPeerKey(first)), (error) => error instanceof GatewayError && error.code === "RATE_LIMITED");
  limiter.take("192.0.2.11");
  assert.equal(limiter.map.size, 2);
  assert.throws(() => limiter.take("192.0.2.12"), (error) => error instanceof GatewayError && error.code === "RATE_LIMITED");
});


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

test("atomic rename retries the existing seven transient EPERM windows without losing run state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-rename-characterization-"));
  const runFile = path.join(home, "run.json");
  const tempFile = path.join(home, "run.tmp");
  await writeFile(runFile, '{"status":"previous"}\n');
  await writeFile(tempFile, '{"status":"completed"}\n');
  const waits = [];
  let calls = 0;
  await renameWithTransientRetry(tempFile, runFile, {
    renameFile: async (src, dest) => {
      calls += 1;
      if (calls <= 7) throw Object.assign(new Error("Windows destination held open"), { code: "EPERM" });
      await rename(src, dest);
    },
    delay: async (ms) => { waits.push(ms); }
  });
  assert.equal(calls, 8, "original policy permits seven retries plus first attempt");
  assert.deepEqual(waits, [10, 20, 40, 80, 160, 320, 320]);
  assert.deepEqual(JSON.parse(await readFile(runFile, "utf8")), { status: "completed" });
  assert.deepEqual((await readdir(home)).filter((name) => name.endsWith(".tmp")), []);
});

test("atomic rename never retries non-transient filesystem errors or damages existing run state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-rename-reject-"));
  const runFile = path.join(home, "run.json");
  const tempFile = path.join(home, "run.tmp");
  await writeFile(runFile, '{"status":"previous"}\n');
  await writeFile(tempFile, '{"status":"incoming"}\n');
  let attempts = 0;
  let waits = 0;
  await assert.rejects(
    renameWithTransientRetry(tempFile, runFile, {
      renameFile: async () => {
        attempts += 1;
        throw Object.assign(new Error("permission intentionally denied"), { code: "EIO" });
      },
      delay: async () => { waits += 1; }
    }),
    (error) => error?.code === "EIO"
  );
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
  assert.deepEqual(JSON.parse(await readFile(runFile, "utf8")), { status: "previous" });
  assert.deepEqual(JSON.parse(await readFile(tempFile, "utf8")), { status: "incoming" });
});

test("atomic rename survives twelve transient Windows holds beyond the old retry limit", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-rename-extended-"));
  const target = path.join(home, "run.json");
  const temp = path.join(home, "run.json.writing.tmp");
  await writeFile(target, '{"status":"previous"}\n');
  await writeFile(temp, '{"status":"completed","evidence":true}\n');
  let attempts = 0;
  const waits = [];
  const codes = ["EPERM", "EACCES", "EBUSY"];
  await renameWithTransientRetry(temp, target, {
    renameFile: async (src, dest) => {
      attempts += 1;
      if (attempts <= 12) throw Object.assign(new Error("transient Windows lock"), { code: codes[(attempts - 1) % 3] });
      await rename(src, dest);
    },
    delay: async (ms) => { waits.push(ms); }
  });
  assert.equal(attempts, 13, "repeated Windows contention must outlive the original eight-attempt limit");
  assert.equal(waits.length, 12);
  assert.ok(waits.every((ms) => ms >= 10 && ms <= 320));
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { status: "completed", evidence: true });
  assert.deepEqual((await readdir(home)).filter((name) => name.endsWith(".tmp")), []);
});

test("persistent transient rename failures stop after a finite budget and preserve the old checkpoint", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-rename-bounded-"));
  const target = path.join(home, "run.json");
  const temp = path.join(home, "run.json.writing.tmp");
  await writeFile(target, '{"status":"previous"}\n');
  await writeFile(temp, '{"status":"incoming"}\n');
  let attempts = 0;
  let waits = 0;
  await assert.rejects(
    renameWithTransientRetry(temp, target, {
      renameFile: async () => {
        attempts += 1;
        throw Object.assign(new Error("target remains held"), { code: "EPERM" });
      },
      delay: async (ms) => {
        waits += 1;
        assert.ok(ms <= 320);
      }
    }),
    (error) => error?.code === "EPERM"
  );
  assert.equal(attempts, 20, "bounded retry policy must eventually return control to the caller");
  assert.equal(waits, 19);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { status: "previous" });
  assert.deepEqual(JSON.parse(await readFile(temp, "utf8")), { status: "incoming" });
});

test("atomic state writes from two isolated system roots remain independent", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-rename-two-systems-"));
  const systems = ["system-a", "system-b"];
  const targets = systems.map((systemId) => path.join(home, systemId, "state", "runs", "run.json"));
  await Promise.all(targets.flatMap((target, sys) =>
    Array.from({ length: 24 }, (_, seq) => atomicJson(target, { system_id: systems[sys], seq }))
  ));
  for (const [i, target] of targets.entries()) {
    const saved = await readJson(target);
    assert.equal(saved.system_id, systems[i]);
    assert.ok(Number.isInteger(saved.seq) && saved.seq >= 0 && saved.seq < 24);
    const names = await readdir(path.dirname(target));
    assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), []);
  }
});

test("idempotency rejects same operation id with changed payload", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-store-"));const store=new GatewayStore(home);await store.init();await store.claimIdempotency("run","same",{a:1});await assert.rejects(()=>store.claimIdempotency("run","same",{a:2}),e=>e instanceof GatewayError&&e.code==="IDEMPOTENCY_CONFLICT");});

test("restart recovery pauses in-flight run instead of claiming provider resume", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-recover-"));const store=new GatewayStore(home);await store.init();const run=await store.createRun({session_id:"sess_x",system_id:"local",workspace_id:"operator",principal:"operator",runtime:{kind:"deterministic"},messages:[{role:"user",content:"x"}],max_turns:1,budget:{max_actions:1},deadline_at:new Date(Date.now()+60000).toISOString()});run.status="running";await store.saveRun(run);const changed=await store.recoverInterrupted();assert.deepEqual(changed,[run.run_id]);assert.equal((await store.getRun(run.run_id)).status,"paused_recovery_required");});


test("cold recovery preserves approval waits, raw event history and canonical run after an abandoned partial-write temp", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-cold-recover-"));
  const store = new GatewayStore(home);
  await store.init();
  const newRun = async (suffix) => await store.createRun({
    session_id: `sess_${suffix}`, system_id: "system-a", workspace_id: "alpha", principal: "operator",
    runtime: { kind: "deterministic" }, messages: [{ role: "user", content: `raw-history-${suffix}` }],
    max_turns: 2, budget: { max_actions: 1 }, deadline_at: new Date(Date.now() + 60000).toISOString()
  });

  const running = await newRun("running");
  running.status = "running";
  running.checkpoint = { phase: "awaiting_model" };
  await store.saveRun(running);
  const beforeRestart = await store.getRun(running.run_id);
  const record = await store.event(running.run_id, "assistant.delta", { text: "raw-before-restart" });
  const count = 192;
  for (let i = 0; i < count; i += 1) {
    await store.event(running.run_id, "history.raw", { ordinal: i });
  }

  const pending = await newRun("approval");
  pending.status = "awaiting_approval";
  pending.pending_approval = {
    tool_call_id: "tool_approval", request: { operation: "needs.approval" },
    authorization: { decision: "approval_required", approval_required: true }
  };
  await store.saveRun(pending);
  const pendingVersion = pending.revision;

  const complete = await newRun("complete");
  complete.status = "completed";
  complete.output = { content: "canonical completed result" };
  complete.completed_at = new Date().toISOString();
  await store.saveRun(complete);
  const completeVersion = complete.revision;

  // A process crash may leave a half-written temporary sibling. Never parse it
  // as the canonical run or convert it to a new state.
  const abandoned = `${store.runFile(running.run_id)}.abandoned.tmp`;
  await writeFile(abandoned, '{"status":"completed","output":', "utf8");

  const restarted = new GatewayStore(home);
  await restarted.init();
  assert.deepEqual(await restarted.recoverInterrupted(), [running.run_id]);
  const recovered = await restarted.getRun(running.run_id);
  assert.equal(recovered.status, "paused_recovery_required");
  assert.equal(recovered.checkpoint.reason, "gateway_restart");
  assert.equal(recovered.output, null);
  assert.equal(recovered.system_id, "system-a");
  assert.equal(recovered.workspace_id, "alpha");
  assert.equal(recovered.principal, "operator");
  assert.ok(recovered.revision > beforeRestart.revision);
  assert.equal((await restarted.getRun(pending.run_id)).status, "awaiting_approval");
  assert.equal((await restarted.getRun(pending.run_id)).revision, pendingVersion);
  assert.deepEqual((await restarted.getRun(pending.run_id)).pending_approval, pending.pending_approval);
  assert.equal((await restarted.getRun(complete.run_id)).revision, completeVersion);
  assert.deepEqual((await restarted.getRun(complete.run_id)).output, complete.output);
  assert.equal(await readFile(abandoned, "utf8"), '{"status":"completed","output":');

  const events = await restarted.listEvents(running.run_id);
  assert.equal(events.length, count + 3, "run.created + raw content + 192 history + recovery marker");
  assert.equal(events.find((event) => event.event_id === record.event_id)?.data.text, "raw-before-restart");
  assert.deepEqual(events.filter((event) => event.type === "history.raw").map((event) => event.data.ordinal),
    Array.from({ length: count }, (_, i) => i));
  assert.equal(events.filter((event) => event.type === "run.recovery_required").length, 1);

  // A stale provider process must never overwrite the recovered checkpoint.
  beforeRestart.status = "completed";
  beforeRestart.output = { content: "stale provider continuation" };
  await assert.rejects(() => restarted.saveRun(beforeRestart),
    (error) => error instanceof GatewayError && error.code === "RUN_REVISION_CONFLICT");
  assert.equal((await restarted.getRun(running.run_id)).status, "paused_recovery_required");
  assert.deepEqual(await restarted.recoverInterrupted(), [], "recovery does not repeat its own transition");
});

test("run idempotency from pre-principal payload fails closed after upgrade and preserves original receipt", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-idem-upgrade-"));
  const first = new GatewayStore(home);
  await first.init();
  const oldPayload = {
    system_id: "system-a", workspace_id: "alpha", requested_session_id: null,
    messages: [{ role: "user", content: "same content" }], goal_id: null, model: "aiverse",
    context_policy: { cache_sensitive: false }
  };
  const claim = await first.claimIdempotency("run", "pre-owner-version", oldPayload);
  assert.equal(claim.state, "new");
  await first.commitIdempotency(claim.mapKey, { run_id: "run_original" });
  const reloaded = new GatewayStore(home);
  await reloaded.init();
  const newPayload = { principal: "operator", ...oldPayload };
  await assert.rejects(() => reloaded.claimIdempotency("run", "pre-owner-version", newPayload),
    (error) => error instanceof GatewayError && error.code === "IDEMPOTENCY_CONFLICT");
  const legacyReplay = await reloaded.claimIdempotency("run", "pre-owner-version", oldPayload);
  assert.equal(legacyReplay.state, "replay");
  assert.equal(legacyReplay.record.result.run_id, "run_original", "upgrade cannot silently reassign the old receipt");
});

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


test("complete corrupt and oversized persisted events fail replay closed without rewriting canonical history", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-bad-sse-history-"));
  const store = new GatewayStore(home);
  await store.init();
  const runId = "run_bad_history";
  const original = await store.event(runId, "test.valid", { ordinal: 1 });
  const file = store.eventFile(runId);
  await writeFile(file, '{"event_id":"evt_invalid","type":, "data":{}}\n', { flag: "a" });
  const beforeCorruptionReplay = await readFile(file, "utf8");
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of store.streamEvents(runId)) seen.push(event);
  }, SyntaxError, "complete corrupt event record must not disappear silently");
  assert.deepEqual(seen.map((event) => event.event_id), [original.event_id]);
  assert.equal(await readFile(file, "utf8"), beforeCorruptionReplay);

  const hugeRun = "run_oversized_history";
  const hugeFile = store.eventFile(hugeRun);
  const oversized = JSON.stringify({ event_id: "evt_oversize", run_id: hugeRun,
    type: "test.large", data: { value: "x".repeat(8 * 1024 * 1024) } }) + "\n";
  await writeFile(hugeFile, oversized);
  await assert.rejects(async () => {
    for await (const event of store.streamEvents(hugeRun)) void event;
  }, (error) => error instanceof GatewayError && error.code === "EVENT_TOO_LARGE");
  assert.equal((await readFile(hugeFile)).length, Buffer.byteLength(oversized),
    "oversized canonical log remains intact for operator recovery");
});

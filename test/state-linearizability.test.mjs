import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GatewayError } from "../src/errors.mjs";
import { RunEngine } from "../src/run-engine.mjs";
import { GatewayStore } from "../src/store.mjs";

function engineConfig(home) {
  return {
    host_adapter_config: path.join(home, "unused-host.json"),
    goal_owner_config: null,
    runtime: { kind: "deterministic", model: null },
    context: {
      window_tokens: null,
      soft_pressure_ratio: 0.72,
      hard_pressure_ratio: 0.88,
      recent_raw_tail_messages: 8,
      chars_per_token_estimate: 4,
      summary_wrapper_token_reserve: 32,
      cache_sensitive_skip: true
    },
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

async function fixtureRun(store, suffix = "linear") {
  return await store.createRun({
    session_id: `sess_${suffix}`,
    system_id: "local",
    workspace_id: "operator",
    principal: "operator",
    runtime: { kind: "deterministic", model: null },
    messages: [{
      role: "user",
      content: "Please complete this durable delivery review and preserve the final outcome for future historical context."
    }],
    max_turns: 1,
    budget: { max_actions: 4, max_tokens: null, max_cost: null },
    deadline_at: new Date(Date.now() + 60000).toISOString()
  });
}

test("concurrent first idempotency claims admit exactly one reservation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-linear-idem-"));
  const store = new GatewayStore(home);
  await store.init();

  const payload = { system_id: "local", messages: [{ role: "user", content: "same" }] };
  const results = await Promise.allSettled([
    store.claimIdempotency("run", "same-key", payload),
    store.claimIdempotency("run", "same-key", payload)
  ]);

  const admitted = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].value.state, "new");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason instanceof GatewayError, true);
  assert.equal(rejected[0].reason.code, "IDEMPOTENCY_IN_PROGRESS");

  await store.commitIdempotency(admitted[0].value.mapKey, { run_id: "run_one" });
  const replay = await store.claimIdempotency("run", "same-key", payload);
  assert.equal(replay.state, "replay");
  assert.equal(replay.record.result.run_id, "run_one");
});

test("concurrent changed-payload idempotency reuse admits one and conflicts the other", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-linear-idem-conflict-"));
  const store = new GatewayStore(home);
  await store.init();

  const results = await Promise.allSettled([
    store.claimIdempotency("control:run_x", "op_same", { action: "pause" }),
    store.claimIdempotency("control:run_x", "op_same", { action: "cancel" })
  ]);

  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.ok(rejected);
  assert.equal(rejected.reason instanceof GatewayError, true);
  assert.equal(rejected.reason.code, "IDEMPOTENCY_CONFLICT");
});

test("concurrent conflicting first session bindings choose one durable binding", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-linear-session-"));
  const store = new GatewayStore(home);
  await store.init();

  const results = await Promise.allSettled([
    store.createSession({
      system_id: "local",
      workspace_id: "alpha",
      principal: "operator",
      session_id: "sess_shared"
    }),
    store.createSession({
      system_id: "local",
      workspace_id: "beta",
      principal: "operator",
      session_id: "sess_shared"
    })
  ]);

  const admitted = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(admitted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason instanceof GatewayError, true);
  assert.equal(rejected[0].reason.code, "SESSION_BINDING_MISMATCH");

  const saved = await store.getSession("sess_shared");
  assert.equal(saved.workspace_id, admitted[0].value.workspace_id);
  assert.ok(["alpha", "beta"].includes(saved.workspace_id));
});

test("stale run writer cannot overwrite a newer cancel transition", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-linear-stale-cancel-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await fixtureRun(store, "stale");
  const stale = await store.getRun(run.run_id);
  const engine = new RunEngine({ store, config: engineConfig(home) });

  const canceled = await engine.cancel(run.run_id, "operator_cancel", "operator");
  assert.equal(canceled.status, "canceled");
  assert.ok(canceled.revision > stale.revision);

  stale.status = "completed";
  stale.output = { content: "stale completion" };
  stale.completed_at = new Date().toISOString();
  await assert.rejects(
    () => store.saveRun(stale),
    (error) => error instanceof GatewayError && error.code === "RUN_REVISION_CONFLICT"
  );

  const saved = await store.getRun(run.run_id);
  assert.equal(saved.status, "canceled");
  assert.equal(saved.output, null);
  assert.equal(saved.error.code, "RUN_CANCELED");
});

async function controlDuringIgnoredRuntime(kind) {
  const home = await mkdtemp(path.join(os.tmpdir(), `avg-linear-${kind}-`));
  const store = new GatewayStore(home);
  await store.init();
  const run = await fixtureRun(store, kind);
  const engine = new RunEngine({ store, config: engineConfig(home) });

  engine.assembleContext = async () => ({ system_message: null, diagnostics: null });

  let runtimeStartedResolve;
  const runtimeStarted = new Promise((resolve) => { runtimeStartedResolve = resolve; });
  let releaseRuntime;
  const runtimeRelease = new Promise((resolve) => { releaseRuntime = resolve; });
  engine.runtime = {
    invoke: async () => {
      runtimeStartedResolve();
      await runtimeRelease;
      return {
        content: "The durable delivery review completed successfully with a clear final checkpoint and no unresolved blockers.",
        tool_calls: [],
        finish_reason: "stop",
        usage: { input_tokens: 10, output_tokens: 20, cost: 0 }
      };
    }
  };

  let ownerCalls = 0;
  engine.host = {
    authorizeAction: async () => {
      ownerCalls += 1;
      return { decision: "allow", allowed: true };
    },
    requestAction: async () => {
      ownerCalls += 1;
      return { status: "succeeded", effect_occurred: true, result: {} };
    }
  };

  const execution = engine.execute(run.run_id, new AbortController().signal);
  await runtimeStarted;

  if (kind === "cancel") {
    const controlled = await engine.cancel(run.run_id, "operator_cancel", "operator");
    assert.equal(controlled.status, "canceled");
  } else {
    const controlled = await engine.pause(run.run_id, "operator", "operator_pause");
    assert.equal(controlled.status, "paused");
  }

  releaseRuntime();
  await execution;

  const saved = await store.getRun(run.run_id);
  assert.equal(saved.status, kind === "cancel" ? "canceled" : "paused");
  assert.equal(ownerCalls, 0);

  const events = await store.listEvents(run.run_id);
  assert.equal(events.some((event) => event.type === "assistant.delta"), false);
  assert.equal(events.some((event) => event.type === "run.completed"), false);
  assert.equal(events.some((event) => event.type === "memory.session_digest.completed"), false);
  assert.equal(events.some((event) => event.type === "memory.session_digest.failed"), false);
}

test("cancel during a runtime result race prevents stale streaming and owner handoff", async () => {
  await controlDuringIgnoredRuntime("cancel");
});

test("pause during a runtime result race prevents stale streaming and completion", async () => {
  await controlDuringIgnoredRuntime("pause");
});


test("idempotency claims serialize across independent store instances and preserve replay/conflict semantics", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-idem-independent-"));
  const first = new GatewayStore(home);
  const second = new GatewayStore(home);
  await Promise.all([first.init(), second.init()]);
  const results = await Promise.allSettled([
    first.claimIdempotency("automation_wake", "invocation-one", { invocation_id: "invocation-one", objective: "ship" }),
    second.claimIdempotency("automation_wake", "invocation-one", { invocation_id: "invocation-one", objective: "ship" })
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  const admitted = results.find((item) => item.status === "fulfilled").value;
  const rejected = results.find((item) => item.status === "rejected").reason;
  assert.equal(admitted.state, "new");
  assert.equal(rejected.code, "IDEMPOTENCY_IN_PROGRESS");
  await second.commitIdempotency(admitted.mapKey, { run_id: "run-one" });
  assert.equal((await first.claimIdempotency("automation_wake", "invocation-one", { invocation_id: "invocation-one", objective: "ship" })).record.result.run_id, "run-one");
  await assert.rejects(
    () => first.claimIdempotency("automation_wake", "invocation-one", { invocation_id: "invocation-one", objective: "changed" }),
    (error) => error instanceof GatewayError && error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("legacy idempotency migration retains results and is restart-safe", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-idem-migration-"));
  const legacyPath = path.join(home, "state", "idempotency.json");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { sha256, stableStringify } = await import("../src/util.mjs");
  const payload = { objective: "ship" };
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, JSON.stringify({ schema_version: "1.0", records: {
    "automation_wake:legacy-key": { digest: sha256(stableStringify(payload)), result: { run_id: "run-legacy" }, created_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:01.000Z" }
  } }));
  const store = new GatewayStore(home);
  await store.init();
  await store.init();
  const replay = await store.claimIdempotency("automation_wake", "legacy-key", payload);
  assert.equal(replay.state, "replay");
  assert.equal(replay.record.result.run_id, "run-legacy");
  await assert.rejects(() => readFile(legacyPath), (error) => error.code === "ENOENT");
});


test("crashed idempotency result writer lock is recovered after the holder is dead", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-idem-stale-lock-"));
  const store = new GatewayStore(home);
  await store.init();
  const claim = await store.claimIdempotency("run", "stale-lock", { a: 1 });
  const file = store.idempotency.recordFile(claim.mapKey);
  const lock = `${file}.lock`;
  const { writeFile, utimes } = await import("node:fs/promises");
  await writeFile(lock, JSON.stringify({ pid: 2147483647, token: "dead-holder", created_at: Date.now() - 60000 }));
  const stale = new Date(Date.now() - 60000);
  await utimes(lock, stale, stale);
  await store.commitIdempotency(claim.mapKey, { run_id: "recovered" });
  const replay = await store.claimIdempotency("run", "stale-lock", { a: 1 });
  assert.equal(replay.record.result.run_id, "recovered");
});


test("separate Gateway processes cannot both reserve one idempotency key", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-idem-processes-"));
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const moduleUrl = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/idempotency-store.mjs")).href;
  const childSource = `import { IdempotencyStore } from ${JSON.stringify(moduleUrl)};
const store = new IdempotencyStore(process.argv[1]);
await store.init(process.argv[2]);
try {
  const result = await store.claim("automation_wake", "same-process-key", { invocation_id: "same-process-key" });
  process.stdout.write(JSON.stringify({ state: result.state }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code }));
}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, path.join(home, "state"), path.join(home, "state", "idempotency.json")]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `child exited ${code}`)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter((result) => result.state === "new").length, 1);
  assert.equal(results.filter((result) => result.code === "IDEMPOTENCY_IN_PROGRESS").length, 1);
});

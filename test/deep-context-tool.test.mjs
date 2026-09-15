import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { RunEngine } from "../src/run-engine.mjs";
import { GatewayStore } from "../src/store.mjs";
import { GatewayError } from "../src/errors.mjs";
import { sha256, stableStringify } from "../src/util.mjs";
import { PROGRESSIVE_HISTORY_OPERATION, PROGRESSIVE_HISTORY_VERSION } from "../src/progressive-context.mjs";

function config(home) {
  return {
    host_adapter_config: path.join(home, "unused-host.json"),
    goal_owner_config: null,
    runtime: { kind: "deterministic" },
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
      max_goal_continuation_turns: 4,
      no_progress_threshold: 2,
      wall_clock_seconds: 60,
      max_actions: 8,
      max_tokens: null,
      max_cost: null
    }
  };
}

async function makeRun(store, {
  runId = "run_g2",
  sessionId = "sess_g2",
  workspaceId = "alpha",
  messages = [{ role: "user", content: "Need more context." }]
} = {}) {
  await store.createSession({
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator",
    session_id: sessionId
  });
  return await store.createRun({
    run_id: runId,
    session_id: sessionId,
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator",
    runtime: { kind: "deterministic", model: "fixture" },
    messages,
    max_turns: 1,
    budget: { max_actions: 8, max_tokens: null, max_cost: null },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });
}

function toolCall(id, args) {
  return {
    id,
    type: "function",
    function: {
      name: "aiverse_context",
      arguments: JSON.stringify(args)
    }
  };
}

class DeepHost {
  constructor() {
    this.progressiveCalls = [];
    this.describeCalls = 0;
  }
  async describe() {
    this.describeCalls += 1;
    return {
      adapter_id: "fixture:g2",
      operations: [PROGRESSIVE_HISTORY_OPERATION],
      metadata: { memory_progressive_recall: "available" }
    };
  }
  async retrieveHistoryProgressive(payload) {
    this.progressiveCalls.push(structuredClone(payload));
    if (payload.depth === "summary") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "summary",
        scope: payload.scope,
        items: [{ record_type: "indexed_record", id: "m1", scope: payload.scope, excerpt: "summary result" }]
      };
    }
    if (payload.depth === "detail") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "detail",
        scope: payload.scope,
        items: [{
          record_type: "indexed_record",
          id: "m1",
          scope: payload.scope,
          text: "detail result",
          deeper_evidence_available: true,
          evidence: { path: "operator/memory/m1.md", source_identity: "m1", source_version: "sha256:1" }
        }]
      };
    }
    if (payload.depth === "source") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "source",
        scope: payload.scope,
        status: "ok",
        exact_evidence: true,
        record_type: "indexed_record",
        id: "m1",
        content: "exact owner source"
      };
    }
    throw new Error("unexpected depth");
  }
}

test("G2 bounded depth request routes through OS progressive owner and records a tool result without consuming action budget", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-g2-depth-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await makeRun(store);
  const engine = new RunEngine({ store, config: config(home) });
  const host = new DeepHost();
  engine.host = host;

  const beforeActions = run.usage.actions;
  await engine.handleToolCalls(run, [toolCall("ctx-1", {
    depth: "summary",
    query: "previous launch decision",
    limit: 3,
    max_bytes: 4096
  })], "workspace:alpha");

  const saved = await store.getRun(run.run_id);
  assert.equal(host.progressiveCalls.length, 1);
  assert.equal(host.progressiveCalls[0].depth, "summary");
  assert.equal(host.progressiveCalls[0].scope, "workspace:alpha");
  assert.equal(host.progressiveCalls[0].limit, 3);
  assert.equal(host.progressiveCalls[0].max_bytes, 4096);
  assert.equal(saved.usage.actions, beforeActions);
  assert.equal(saved.context_deep_retrieval.actual_reads, 1);
  assert.equal(saved.context_deep_retrieval.source_reads, 0);
  const tool = saved.messages.find((message) => message.role === "tool" && message.tool_call_id === "ctx-1");
  const payload = JSON.parse(tool.content);
  assert.equal(payload.status, "ok");
  assert.equal(payload.retrieval.depth, "summary");

  const events = await store.listEvents(run.run_id);
  const completed = events.find((event) => event.type === "context.deep_retrieval.completed");
  assert.ok(completed);
  assert.equal(completed.data.depth, "summary");
  assert.equal(Object.hasOwn(completed.data, "query"), false);
});

test("G2 runtime cannot widen scope or inject authority fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-g2-scope-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await makeRun(store);
  const engine = new RunEngine({ store, config: config(home) });
  const host = new DeepHost();
  engine.host = host;

  await assert.rejects(
    () => engine.handleToolCalls(run, [toolCall("ctx-scope", {
      depth: "detail",
      query: "client history",
      scope: "workspace:beta"
    })], "workspace:alpha"),
    (error) => error instanceof GatewayError && error.code === "CONTEXT_RETRIEVAL_SCOPE_ESCAPE"
  );
  assert.equal(host.describeCalls, 0);
  assert.equal(host.progressiveCalls.length, 0);
});

test("G2 rejects per-depth over-budget requests before owner retrieval", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-g2-budget-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await makeRun(store);
  const engine = new RunEngine({ store, config: config(home) });
  const host = new DeepHost();
  engine.host = host;

  await assert.rejects(
    () => engine.handleToolCalls(run, [toolCall("ctx-budget", {
      depth: "summary",
      query: "previous launch decision",
      limit: 6,
      max_bytes: 9000
    })], "workspace:alpha"),
    (error) => error instanceof GatewayError && error.code === "CONTEXT_RETRIEVAL_BUDGET_EXCEEDED"
  );
  assert.equal(host.describeCalls, 0);
  assert.equal(host.progressiveCalls.length, 0);
});

test("G2 deduplicates equivalent requests per run and serves the second tool call from persisted cache metadata", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-g2-cache-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await makeRun(store);
  const engine = new RunEngine({ store, config: config(home) });
  const host = new DeepHost();
  engine.host = host;
  const args = {
    depth: "detail",
    query: "why was the previous launch decision corrected",
    limit: 2,
    max_bytes: 4096
  };

  await engine.handleToolCalls(run, [toolCall("ctx-first", args)], "workspace:alpha");
  const afterFirst = await store.getRun(run.run_id);
  await engine.handleToolCalls(afterFirst, [toolCall("ctx-second", args)], "workspace:alpha");

  const saved = await store.getRun(run.run_id);
  assert.equal(host.progressiveCalls.length, 1, "equivalent request must not hit owner twice");
  assert.equal(saved.context_deep_retrieval.actual_reads, 1);
  assert.equal(saved.context_deep_retrieval.cache_hits, 1);
  const second = JSON.parse(saved.messages.find((m) => m.role === "tool" && m.tool_call_id === "ctx-second").content);
  assert.equal(second.status, "cached");
  assert.equal(second.replay_of_tool_call_id, "ctx-first");

  const events = await store.listEvents(run.run_id);
  assert.equal(events.filter((event) => event.type === "context.deep_retrieval.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "context.deep_retrieval.cached").length, 1);
});

test("G2 source request resolves validated session-digest pointer through Gateway raw evidence and emits an auditable source-read event", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-g2-source-"));
  const store = new GatewayStore(home);
  await store.init();

  const sourceMessages = [
    { role: "user", content: "What is the locked launch date?" },
    { role: "assistant", content: "Locked launch date: 18 September 2026." }
  ];
  const sourceRun = await makeRun(store, {
    runId: "run_g2_source",
    sessionId: "sess_g2_source",
    messages: sourceMessages
  });
  sourceRun.status = "completed";
  sourceRun.completed_at = "2026-09-15T09:00:00.000Z";
  await store.saveRun(sourceRun);

  const requestRun = await makeRun(store, {
    runId: "run_g2_request",
    sessionId: "sess_g2_request",
    messages: [{ role: "user", content: "Give me the exact launch date." }]
  });
  const expectedFingerprint = `sha256:${sha256(stableStringify(sourceMessages))}`;

  const engine = new RunEngine({ store, config: config(home) });
  const host = new DeepHost();
  host.retrieveHistoryProgressive = async function(payload) {
    this.progressiveCalls.push(structuredClone(payload));
    return {
      schema_version: 1,
      api_version: PROGRESSIVE_HISTORY_VERSION,
      depth: "source",
      scope: payload.scope,
      status: "external_source_required",
      exact_evidence: false,
      record_type: "session_digest",
      id: "sdg-g2",
      evidence: {
        source_fingerprint: expectedFingerprint,
        external_source_refs: ["gateway:run:run_g2_source:messages:0-1"],
        source_coverage: ["gateway:run:run_g2_source:messages:0-1"]
      }
    };
  };
  engine.host = host;

  await engine.handleToolCalls(requestRun, [toolCall("ctx-source", {
    depth: "source",
    query: "exact launch date",
    limit: 1,
    max_bytes: 8192,
    evidence_ref: {
      record_type: "session_digest",
      id: "sdg-g2",
      scope: "workspace:alpha",
      evidence: {
        path: "memory/sessions/sdg-g2.json",
        digest_fingerprint: "sha256:digest"
      }
    }
  })], "workspace:alpha");

  const saved = await store.getRun(requestRun.run_id);
  assert.equal(saved.context_deep_retrieval.actual_reads, 1);
  assert.equal(saved.context_deep_retrieval.source_reads, 1);
  const payload = JSON.parse(saved.messages.find((m) => m.role === "tool" && m.tool_call_id === "ctx-source").content);
  assert.equal(payload.retrieval.gateway_exact_source.status, "ok");
  assert.equal(payload.retrieval.gateway_exact_source.exact_evidence, true);
  assert.equal(
    payload.retrieval.gateway_exact_source.messages.some((message) => message.content.includes("18 September 2026")),
    true
  );

  const events = await store.listEvents(requestRun.run_id);
  const sourceEvent = events.find((event) => event.type === "context.deep_retrieval.source_read");
  assert.ok(sourceEvent);
  assert.equal(sourceEvent.data.gateway_source_range_reads, 1);
  assert.equal(Object.hasOwn(sourceEvent.data, "content"), false);
  assert.equal(Object.hasOwn(sourceEvent.data, "query"), false);
});

test("foreground runtime advertises aiverse_context alongside aiverse_action", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-g2-tools-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await makeRun(store, {
    runId: "run_g2_tools",
    sessionId: "sess_g2_tools",
    messages: [{ role: "user", content: "hi" }]
  });
  const engine = new RunEngine({ store, config: config(home) });
  engine.assembleContext = async () => ({
    system_message: null,
    diagnostics: {
      schema_version: "1.0",
      api_version: "test",
      requested_depth: "catalog",
      realized_depths: [],
      progressive_available: false,
      exact_sensitive: false,
      source_reads: 0,
      gateway_source_range_reads: 0,
      legacy_reads: 0,
      fallback_reason: null,
      bytes_by_depth: {},
      item_counts: {}
    }
  });
  let seenTools = [];
  engine.runtime = {
    async invoke(input) {
      seenTools = input.tools.map((tool) => tool.function.name).sort();
      return {
        content: "done",
        tool_calls: [],
        finish_reason: "stop",
        usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
      };
    }
  };
  engine.complete = async (mutableRun, content) => {
    mutableRun.status = "completed";
    mutableRun.output = { content };
    mutableRun.completed_at = new Date().toISOString();
    await store.saveRun(mutableRun);
  };

  await engine.execute(run.run_id, new AbortController().signal);
  assert.deepEqual(seenTools, ["aiverse_action", "aiverse_context"]);
  assert.equal((await store.getRun(run.run_id)).status, "completed");
});

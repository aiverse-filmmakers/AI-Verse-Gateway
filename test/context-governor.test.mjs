import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { governInvocationContext, estimateInvocationTokens } from "../src/context-governor.mjs";
import { GatewayError } from "../src/errors.mjs";
import { GatewayStore } from "../src/store.mjs";
import { RunEngine } from "../src/run-engine.mjs";

function message(role, label, size = 420) {
  return { role, content: `${label}:${"x".repeat(size)}` };
}

function conversation(count = 8, size = 420) {
  return Array.from({ length: count }, (_, index) =>
    message(index % 2 === 0 ? "user" : "assistant", `m${index}`, size)
  );
}

function configForPressure(messages, pressure, overrides = {}) {
  const base = {
    window_tokens: 10000,
    soft_pressure_ratio: 0.5,
    hard_pressure_ratio: 0.8,
    recent_raw_tail_messages: 2,
    chars_per_token_estimate: 4,
    summary_wrapper_token_reserve: 8,
    cache_sensitive_skip: true,
    ...overrides
  };
  const tokens = estimateInvocationTokens(messages, base);
  return {
    ...base,
    window_tokens: Math.max(256, Math.ceil(tokens / pressure))
  };
}

test("unconfigured and low-pressure context pass through byte-for-byte without scheduling fold work", async () => {
  const messages = conversation(4, 120);
  const unconfigured = await governInvocationContext({ messages, config: {} });
  assert.equal(unconfigured.diagnostic.status, "unconfigured");
  assert.deepEqual(unconfigured.messages, messages);

  const lowConfig = configForPressure(messages, 0.3);
  let summarizeCalls = 0;
  const low = await governInvocationContext({
    messages,
    config: lowConfig,
    summarize: async () => {
      summarizeCalls += 1;
      return "unused";
    }
  });
  assert.equal(low.diagnostic.status, "below_soft_threshold");
  assert.equal(low.diagnostic.fold_scheduled, false);
  assert.equal(summarizeCalls, 0);
  assert.deepEqual(low.messages, messages);
});

test("soft pressure schedules fold work but preserves invocation, while cache-sensitive soft context can skip safely", async () => {
  const messages = conversation(8, 420);
  const config = configForPressure(messages, 0.65);

  const normal = await governInvocationContext({
    messages,
    config,
    cache_sensitive: false,
    summarize: async () => {
      throw new Error("soft pressure must not summarize inline");
    }
  });
  assert.equal(normal.diagnostic.status, "soft_fold_scheduled");
  assert.equal(normal.diagnostic.fold_scheduled, true);
  assert.deepEqual(normal.messages, messages);

  const cacheSensitive = await governInvocationContext({
    messages,
    config,
    cache_sensitive: true,
    summarize: async () => {
      throw new Error("cache-sensitive soft pressure must not summarize inline");
    }
  });
  assert.equal(cacheSensitive.diagnostic.status, "soft_cache_preserved");
  assert.equal(cacheSensitive.diagnostic.fold_scheduled, false);
  assert.equal(cacheSensitive.diagnostic.cache_sensitive_skip, true);
  assert.deepEqual(cacheSensitive.messages, messages);
});

test("hard pressure compacts only the older prefix and preserves the configured recent raw tail verbatim", async () => {
  const messages = conversation(10, 500);
  const config = configForPressure(messages, 0.95, {
    recent_raw_tail_messages: 3,
    soft_pressure_ratio: 0.55,
    hard_pressure_ratio: 0.8
  });
  const original = structuredClone(messages);
  let request = null;

  const governed = await governInvocationContext({
    messages,
    config,
    summarize: async (input) => {
      request = input;
      return "Earlier discussion established the durable production decisions and constraints.";
    }
  });

  assert.equal(governed.diagnostic.status, "hard_compacted");
  assert.equal(governed.diagnostic.fold_scheduled, true);
  assert.equal(governed.diagnostic.raw_tail_messages, 3);
  assert.equal(governed.diagnostic.prefix_messages, 7);
  assert.ok(governed.diagnostic.pressure_after < config.hard_pressure_ratio);
  assert.deepEqual(governed.messages.slice(-3), original.slice(-3));
  assert.ok(governed.messages.some((item) => item.role === "system" && item.content.includes("AI-Verse compacted earlier conversation context")));
  assert.equal(request.covered_message_count, 7);
  assert.deepEqual(messages, original, "governor must never mutate canonical input messages");
});

test("huge-turn emergency shrinks the raw tail only as much as required and never rewrites retained messages", async () => {
  const messages = conversation(7, 700);
  const probe = {
    window_tokens: 10000,
    soft_pressure_ratio: 0.5,
    hard_pressure_ratio: 0.8,
    recent_raw_tail_messages: 4,
    chars_per_token_estimate: 4,
    summary_wrapper_token_reserve: 8
  };
  const twoTailTokens = estimateInvocationTokens(messages.slice(-2), probe);
  const config = {
    ...probe,
    window_tokens: Math.max(256, Math.ceil(twoTailTokens / 0.92))
  };
  const original = structuredClone(messages);

  const governed = await governInvocationContext({
    messages,
    config,
    summarize: async () => "Emergency compact summary."
  });

  assert.equal(governed.diagnostic.status, "hard_compacted_tail_shrunk");
  assert.ok(governed.diagnostic.raw_tail_messages < 4);
  assert.ok(governed.diagnostic.raw_tail_messages >= 1);
  assert.deepEqual(
    governed.messages.slice(-governed.diagnostic.raw_tail_messages),
    original.slice(-governed.diagnostic.raw_tail_messages)
  );
  assert.deepEqual(messages, original);
});

test("an oversized latest raw message fails closed before model invocation", async () => {
  const messages = [
    message("user", "older", 400),
    message("assistant", "older-answer", 400),
    message("user", "huge-latest", 5000)
  ];
  const config = {
    window_tokens: 512,
    soft_pressure_ratio: 0.5,
    hard_pressure_ratio: 0.8,
    recent_raw_tail_messages: 2,
    chars_per_token_estimate: 4,
    summary_wrapper_token_reserve: 8
  };
  let called = false;

  await assert.rejects(
    () => governInvocationContext({
      messages,
      config,
      summarize: async () => {
        called = true;
        return "must not run";
      }
    }),
    (error) => error instanceof GatewayError && error.code === "CONTEXT_RECENT_TAIL_TOO_LARGE"
  );
  assert.equal(called, false);
});

test("RunEngine sends compacted derived context to runtime while persisted run.messages remains canonical", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-e4-engine-"));
  const store = new GatewayStore(home);
  await store.init();
  const session = await store.createSession({
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    session_id: "sess_e4_engine"
  });
  const canonical = conversation(10, 520);
  const probe = {
    window_tokens: 10000,
    soft_pressure_ratio: 0.55,
    hard_pressure_ratio: 0.8,
    recent_raw_tail_messages: 2,
    chars_per_token_estimate: 4,
    summary_wrapper_token_reserve: 8,
    cache_sensitive_skip: true
  };
  const tokens = estimateInvocationTokens(canonical, probe);
  const context = { ...probe, window_tokens: Math.max(256, Math.ceil(tokens / 0.95)) };
  const run = await store.createRun({
    session_id: session.session_id,
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    runtime: { kind: "deterministic", model: "fixture" },
    messages: structuredClone(canonical),
    context_policy: { cache_sensitive: false },
    max_turns: 1,
    budget: { max_tokens: null, max_cost: null, max_actions: 1 },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });

  const engine = new RunEngine({
    store,
    config: {
      host_adapter_config: path.join(home, "unused-host.json"),
      goal_owner_config: null,
      runtime: { kind: "deterministic" },
      context,
      limits: {
        max_goal_continuation_turns: 1,
        no_progress_threshold: 2,
        wall_clock_seconds: 60,
        max_actions: 1,
        max_tokens: null,
        max_cost: null
      }
    }
  });
  engine.assembleContext = async () => ({ system_message: null });

  const invocations = [];
  engine.runtime = {
    async invoke(input) {
      invocations.push(structuredClone(input));
      if (String(input.run_id).includes(":context-fold:")) {
        return {
          content: "Earlier conversation preserved the durable production decisions.",
          tool_calls: [],
          finish_reason: "stop",
          usage: { input_tokens: 9, output_tokens: 4, cost: 0 }
        };
      }
      return {
        content: "ok",
        tool_calls: [],
        finish_reason: "stop",
        usage: { input_tokens: 12, output_tokens: 1, cost: 0 }
      };
    }
  };

  await engine.execute(run.run_id, new AbortController().signal);

  const saved = await store.getRun(run.run_id);
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.messages.slice(0, canonical.length), canonical);
  assert.equal(saved.messages.at(-1).content, "ok");
  assert.equal(saved.context_governor.status, "hard_compacted");
  assert.equal(saved.context_governor.fold_work.state, "scheduled_for_safe_boundary");
  assert.equal(saved.usage.input_tokens, 21);
  assert.equal(saved.usage.output_tokens, 5);

  assert.equal(invocations.length, 2, "one compaction call plus one normal runtime invocation expected");
  const runtimeCall = invocations[1];
  assert.deepEqual(runtimeCall.messages.slice(-2), canonical.slice(-2));
  assert.ok(runtimeCall.messages.length < canonical.length);
  assert.ok(runtimeCall.messages.some((item) => item.role === "system" && item.content.includes("AI-Verse compacted earlier conversation context")));

  const events = await store.listEvents(run.run_id);
  const pressure = events.find((event) => event.type === "context.pressure.evaluated");
  assert.ok(pressure);
  assert.equal(pressure.data.status, "hard_compacted");
  assert.equal(Object.hasOwn(pressure.data, "messages"), false);
});

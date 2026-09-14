import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { GatewayStore } from "../src/store.mjs";
import { foldOldestHistory } from "../src/fold-engine.mjs";

const SCOPE = {
  system_id: "local",
  workspace_id: "alpha",
  principal: "operator"
};

async function makeStore(prefix) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new GatewayStore(home);
  await store.init();
  return { home, store };
}

async function completedRun(store, {
  sessionId = "sess_fold_engine",
  runId,
  completedAt,
  messages
}) {
  await store.createSession({
    system_id: SCOPE.system_id,
    workspace_id: SCOPE.workspace_id,
    principal: SCOPE.principal,
    session_id: sessionId
  });
  const run = await store.createRun({
    run_id: runId,
    session_id: sessionId,
    system_id: SCOPE.system_id,
    workspace_id: SCOPE.workspace_id,
    principal: SCOPE.principal,
    runtime: { kind: "deterministic" },
    messages,
    max_turns: 1,
    budget: { max_actions: 1 },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });
  run.status = "completed";
  run.completed_at = completedAt;
  await store.saveRun(run);
  return run;
}

function messages(label) {
  return [
    { role: "user", content: `${label} user message with enough historical detail to make folding useful.` },
    { role: "assistant", content: `${label} assistant response with durable context that must remain exactly recoverable.` }
  ];
}

function compactSummarizer(request) {
  if (request.level === 1) {
    return {
      summary: "leaf-summary",
      generator: { kind: "deterministic-test", version: "e2-test-v1" }
    };
  }
  if (request.level === 2) {
    return {
      summary: "roll",
      generator: { kind: "deterministic-test", version: "e2-test-v1" }
    };
  }
  return {
    summary: "R",
    generator: { kind: "deterministic-test", version: "e2-test-v1" }
  };
}

test("low pressure performs no folding and never calls the summarizer", async () => {
  const { store } = await makeStore("avg-e2-low-");
  const raw = messages("low");
  await completedRun(store, {
    runId: "run_low_pressure",
    completedAt: "2026-09-01T10:00:00.000Z",
    messages: raw
  });

  let calls = 0;
  const result = await foldOldestHistory(store, {
    session_id: "sess_fold_engine",
    scope: SCOPE,
    pressure: 0.4,
    threshold: 0.8,
    summarize: async () => {
      calls += 1;
      return "must not run";
    }
  });

  assert.equal(result.status, "below_pressure_threshold");
  assert.equal(calls, 0);
  assert.equal(result.created_cards.length, 0);
  assert.deepEqual(await store.listFoldCards({ scope: SCOPE }), []);
  assert.deepEqual((await store.getRun("run_low_pressure")).messages, raw);
});

test("folds the oldest eligible completed history with complete ordered coverage", async () => {
  const { store } = await makeStore("avg-e2-order-");

  const newest = await completedRun(store, {
    runId: "run_newest",
    completedAt: "2026-09-03T10:00:00.000Z",
    messages: messages("newest")
  });
  const oldest = await completedRun(store, {
    runId: "run_oldest",
    completedAt: "2026-09-01T10:00:00.000Z",
    messages: messages("oldest")
  });
  const middle = await completedRun(store, {
    runId: "run_middle",
    completedAt: "2026-09-02T10:00:00.000Z",
    messages: messages("middle")
  });

  const snapshots = new Map([
    [newest.run_id, structuredClone(newest.messages)],
    [oldest.run_id, structuredClone(oldest.messages)],
    [middle.run_id, structuredClone(middle.messages)]
  ]);

  const result = await foldOldestHistory(store, {
    session_id: "sess_fold_engine",
    scope: SCOPE,
    pressure: 1,
    fan_in: 2,
    summarize: compactSummarizer
  });

  assert.equal(result.status, "folded");
  assert.equal(result.created_cards.length, 1);
  const leaf = result.created_cards[0];
  assert.equal(leaf.level, 1);
  assert.deepEqual(
    leaf.source_refs.map((ref) => ref.run_id),
    ["run_oldest", "run_middle"]
  );
  assert.deepEqual(
    leaf.source_refs.map((ref) => [ref.start_index, ref.end_index]),
    [[0, 1], [0, 1]]
  );
  assert.equal(leaf.coverage.descendant_message_count, 4);

  const exact = await store.resolveFoldCardSources(leaf.card_id);
  assert.deepEqual(
    exact.flatMap((item) => item.messages),
    [...snapshots.get("run_oldest"), ...snapshots.get("run_middle")]
  );

  for (const [runId, original] of snapshots) {
    assert.deepEqual((await store.getRun(runId)).messages, original);
  }
});

test("recursive pressure folding rolls adjacent cards through level 3 while preserving exact descendant order", async () => {
  const { store } = await makeStore("avg-e2-recursive-");
  const sessionId = "sess_fold_engine";
  const originals = [];
  for (let index = 0; index < 8; index += 1) {
    const runId = `run_recursive_${index}`;
    const raw = messages(`recursive-${index}`);
    originals.push(...structuredClone(raw));
    await completedRun(store, {
      sessionId,
      runId,
      completedAt: `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      messages: raw
    });
  }

  const calls = [];
  const summarize = async (request) => {
    calls.push({ kind: request.kind, level: request.level });
    return compactSummarizer(request);
  };

  const first = await foldOldestHistory(store, {
    session_id: sessionId,
    scope: SCOPE,
    pressure: 1,
    fan_in: 2,
    summarize
  });
  assert.deepEqual(first.created_cards.map((card) => card.level), [1]);

  const second = await foldOldestHistory(store, {
    session_id: sessionId,
    scope: SCOPE,
    pressure: 1,
    fan_in: 2,
    summarize
  });
  assert.deepEqual(second.created_cards.map((card) => card.level), [1, 2]);

  const third = await foldOldestHistory(store, {
    session_id: sessionId,
    scope: SCOPE,
    pressure: 1,
    fan_in: 2,
    summarize
  });
  assert.deepEqual(third.created_cards.map((card) => card.level), [1]);

  const fourth = await foldOldestHistory(store, {
    session_id: sessionId,
    scope: SCOPE,
    pressure: 1,
    fan_in: 2,
    summarize
  });
  assert.deepEqual(fourth.created_cards.map((card) => card.level), [1, 2, 3]);

  const roots = await store.listFoldCards({ scope: SCOPE, level: 3 });
  assert.equal(roots.length, 1);
  const root = await store.getFoldCard(roots[0].card_id);
  assert.equal(root.child_refs.length, 2);
  assert.equal(root.coverage.descendant_source_count, 8);
  assert.equal(root.coverage.descendant_message_count, 16);

  const exact = await store.resolveFoldCardSources(root.card_id);
  assert.deepEqual(exact.flatMap((item) => item.messages), originals);

  const validation = await store.validateFoldCard(root.card_id);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);

  const fifth = await foldOldestHistory(store, {
    session_id: sessionId,
    scope: SCOPE,
    pressure: 1,
    fan_in: 2,
    summarize
  });
  assert.equal(fifth.status, "no_eligible_history");
  assert.equal(fifth.created_cards.length, 0);

  assert.equal(calls.some((call) => call.level === 1), true);
  assert.equal(calls.some((call) => call.level === 2), true);
  assert.equal(calls.some((call) => call.level === 3), true);
});

test("a summary that is not strictly smaller is rejected before any fold card is written", async () => {
  const { store } = await makeStore("avg-e2-size-");
  const raw = messages("not-smaller");
  await completedRun(store, {
    runId: "run_not_smaller",
    completedAt: "2026-09-01T10:00:00.000Z",
    messages: raw
  });

  const result = await foldOldestHistory(store, {
    session_id: "sess_fold_engine",
    scope: SCOPE,
    pressure: 1,
    summarize: async (request) => ({
      summary: "x".repeat(request.input_bytes),
      generator: { kind: "deterministic-test", version: "e2-test-v1" }
    })
  });

  assert.equal(result.status, "summary_not_smaller");
  assert.equal(result.created_cards.length, 0);
  assert.equal((await store.listFoldCards({ scope: SCOPE })).length, 0);
  assert.deepEqual((await store.getRun("run_not_smaller")).messages, raw);
});

test("summarizer failure leaves raw history and existing fold state untouched", async () => {
  const { store } = await makeStore("avg-e2-fail-");
  const raw = messages("failure");
  await completedRun(store, {
    runId: "run_generator_failure",
    completedAt: "2026-09-01T10:00:00.000Z",
    messages: raw
  });
  const beforeCatalog = await store.rebuildFoldCatalog();

  const result = await foldOldestHistory(store, {
    session_id: "sess_fold_engine",
    scope: SCOPE,
    pressure: 1,
    summarize: async () => {
      throw new Error("synthetic summarizer outage");
    }
  });

  assert.equal(result.status, "summarizer_failed");
  assert.equal(result.created_cards.length, 0);
  assert.match(result.failure.message, /synthetic summarizer outage/);
  assert.deepEqual((await store.getRun("run_generator_failure")).messages, raw);

  const afterCatalog = await store.rebuildFoldCatalog();
  assert.equal(afterCatalog.cards.length, 0);
  assert.equal(afterCatalog.fingerprint, beforeCatalog.fingerprint);
});

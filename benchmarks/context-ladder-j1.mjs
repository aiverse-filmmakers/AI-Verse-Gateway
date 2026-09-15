import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { GatewayStore } from "../src/store.mjs";
import { foldOldestHistory } from "../src/fold-engine.mjs";
import { searchFoldArchive } from "../src/fold-archive.mjs";
import { governInvocationContext, estimateInvocationTokens } from "../src/context-governor.mjs";
import { stableStringify } from "../src/util.mjs";

export const J1_GATEWAY_BENCHMARK_VERSION = "gateway.context-ladder-j1.v1";

function scope(workspaceId = "alpha") {
  return { system_id: "local", workspace_id: workspaceId, principal: "operator" };
}

function bytes(value) {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a,b)=>a-b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

async function completedRun(store, { runId, sessionId, workspaceId = "alpha", completedAt, messages }) {
  const existing = await store.getSession(sessionId);
  if (!existing) {
    await store.createSession({
      system_id: "local",
      workspace_id: workspaceId,
      principal: "operator",
      session_id: sessionId
    });
  }
  const run = await store.createRun({
    run_id: runId,
    session_id: sessionId,
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator",
    runtime: { kind: "deterministic" },
    messages,
    max_turns: 1,
    budget: { max_actions: 2, max_tokens: null, max_cost: null },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });
  run.status = "completed";
  run.completed_at = completedAt;
  await store.saveRun(run);
  return run;
}

function deterministicFoldSummary(request) {
  const raw = request.kind === "raw_history"
    ? request.source_runs.flatMap((run) => run.messages.map((m) => String(m.content ?? ""))).join(" ")
    : request.child_cards.map((card) => card.summary).join(" ");
  const marker = raw.includes("J1-OLD-FACT")
    ? " J1-OLD-FACT launch code ORBIT-50 is recoverable from exact Gateway source."
    : "";
  return {
    summary: `Compact historical coverage level ${request.level}.${marker}`,
    generator: { kind: "deterministic-j1", version: J1_GATEWAY_BENCHMARK_VERSION }
  };
}

async function createHistoryFixture(store) {
  const sessionId = "sess_j1_long";
  const allMessages = [];
  const runs = [];
  for (let i = 0; i < 30; i += 1) {
    const marker = i === 0
      ? " J1-OLD-FACT launch code ORBIT-50 was approved exactly 50+ turns before the recent tail."
      : "";
    const messages = [
      { role: "user", content: `Historical user turn ${i}. ${"context ".repeat(45)}${marker}` },
      { role: "assistant", content: `Historical assistant turn ${i}. ${"response ".repeat(42)}` }
    ];
    allMessages.push(...messages);
    const run = await completedRun(store, {
      runId: `run_j1_long_${String(i).padStart(2,"0")}`,
      sessionId,
      completedAt: `2026-09-14T${String(10 + Math.floor(i/6)).padStart(2,"0")}:${String((i%6)*10).padStart(2,"0")}:00.000Z`,
      messages
    });
    runs.push(run);
  }
  return { sessionId, allMessages, runs };
}

async function foldAll(store, sessionId) {
  const created = [];
  for (let i = 0; i < 80; i += 1) {
    const result = await foldOldestHistory(store, {
      pressure: 1,
      threshold: 0.8,
      fan_in: 2,
      max_levels: 12,
      max_new_cards: 8,
      session_id: sessionId,
      scope: scope(),
      summarize: deterministicFoldSummary
    });
    created.push(...(result.created_cards ?? []));
    if (result.status === "no_eligible_history") break;
    if (!["folded","partial_fold"].includes(result.status)) {
      throw new Error(`Unexpected J1 fold status: ${result.status}`);
    }
  }
  return created;
}

async function benchmarkRecentRaw() {
  const messages = Array.from({length: 8}, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `RECENT-J1-${i} ${"recent ".repeat(10)}`
  }));
  const config = {
    window_tokens: 4096,
    soft_pressure_ratio: 0.72,
    hard_pressure_ratio: 0.88,
    recent_raw_tail_messages: 8,
    chars_per_token_estimate: 4,
    summary_wrapper_token_reserve: 32,
    cache_sensitive_skip: true
  };
  const governed = await governInvocationContext({ messages, config });
  return {
    scenario_id: "recent_conversation",
    candidate_correct: stableStringify(governed.messages) === stableStringify(messages),
    status: governed.diagnostic.status,
    raw_tail_messages: governed.diagnostic.raw_tail_messages,
    baseline_tokens: estimateInvocationTokens(messages, config),
    candidate_tokens: estimateInvocationTokens(governed.messages, config),
    source_reads: 0
  };
}

async function benchmarkLargeInvocation() {
  const messages = Array.from({length: 120}, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `LARGE-J1-${i} ${"large-context-token ".repeat(55)}`
  }));
  const config = {
    window_tokens: 9000,
    soft_pressure_ratio: 0.55,
    hard_pressure_ratio: 0.70,
    recent_raw_tail_messages: 8,
    chars_per_token_estimate: 4,
    summary_wrapper_token_reserve: 32,
    cache_sensitive_skip: true
  };
  const before = estimateInvocationTokens(messages, config);
  const start = performance.now();
  const governed = await governInvocationContext({
    messages,
    config,
    summarize: async ({ covered_message_count, target_tokens }) => ({
      summary: `J1 compacted ${covered_message_count} older messages within target ${target_tokens}. Key continuity preserved.`
    })
  });
  const latency = performance.now() - start;
  const after = estimateInvocationTokens(governed.messages, config);
  const tail = governed.messages.slice(-governed.diagnostic.raw_tail_messages);
  const expectedTail = messages.slice(-governed.diagnostic.raw_tail_messages);
  return {
    scenario_id: "very_large_history",
    candidate_correct: after < before && stableStringify(tail) === stableStringify(expectedTail),
    baseline_tokens: before,
    candidate_tokens: after,
    token_reduction_ratio: Number((1 - after / before).toFixed(6)),
    context_construction_latency_ms: Number(latency.toFixed(3)),
    recent_tail_preserved_verbatim: stableStringify(tail) === stableStringify(expectedTail),
    status: governed.diagnostic.status,
    source_reads: 0
  };
}

async function benchmarkFoldArchive(store, history) {
  const rawBefore = bytes(history.allMessages);
  const startFold = performance.now();
  const created = await foldAll(store, history.sessionId);
  const foldLatency = performance.now() - startFold;
  const firstRunBefore = stableStringify(history.runs[0].messages);
  const persistedFirst = await store.getRun(history.runs[0].run_id);
  const canonicalUnchanged = stableStringify(persistedFirst.messages) === firstRunBefore;

  const startSearch = performance.now();
  const exact = await searchFoldArchive(store, {
    query: "exact J1-OLD-FACT launch code ORBIT-50",
    scope: scope(),
    session_id: history.sessionId,
    max_hits: 5,
    max_unfold_cards: 5,
    max_messages: 20,
    max_raw_bytes: 24000,
    precision: true
  });
  const searchLatency = performance.now() - startSearch;
  const rendered = stableStringify(exact);
  const recovered = rendered.includes("J1-OLD-FACT") && rendered.includes("ORBIT-50");

  const compact = await searchFoldArchive(store, {
    query: "J1-OLD-FACT launch code",
    scope: scope(),
    session_id: history.sessionId,
    max_hits: 5,
    precision: false
  });
  const candidateBytes = bytes(compact) + bytes(exact.exact_hits ?? []);
  const catalog = await store.rebuildFoldCatalog({ live_validation: true });

  return {
    scenario_id: "fact_50_plus_turns_old",
    candidate_correct: recovered && canonicalUnchanged,
    raw_history_bytes: rawBefore,
    candidate_context_bytes: candidateBytes,
    context_reduction_ratio: Number((1 - candidateBytes / rawBefore).toFixed(6)),
    fold_cards_created: created.length,
    fold_latency_ms: Number(foldLatency.toFixed(3)),
    retrieval_latency_ms: Number(searchLatency.toFixed(3)),
    source_reads: Array.isArray(exact.unfolded_source_refs) ? exact.unfolded_source_refs.length : 0,
    exact_fact_recovered: recovered,
    canonical_raw_history_unchanged: canonicalUnchanged,
    catalog_card_count: catalog.cards.length,
    archive_status: exact.status ?? "ok"
  };
}

async function benchmarkRestartAndRebuild(home, sessionId) {
  const restarted = new GatewayStore(home);
  await restarted.init();
  const before = await restarted.rebuildFoldCatalog({ live_validation: true });
  await rm(restarted.p.foldCatalog, { force: true });
  const rebuilt = await restarted.rebuildFoldCatalog({ live_validation: true });
  const exact = await searchFoldArchive(restarted, {
    query: "exact J1-OLD-FACT launch code ORBIT-50",
    scope: scope(),
    session_id: sessionId,
    precision: true,
    max_hits: 5,
    max_unfold_cards: 5,
    max_messages: 20,
    max_raw_bytes: 24000
  });
  return {
    restart_archive_recovery: stableStringify(exact).includes("ORBIT-50"),
    fold_catalog_rebuild_equivalent:
      before.catalog_fingerprint === rebuilt.catalog_fingerprint
      && before.cards.length === rebuilt.cards.length,
    rebuilt_card_count: rebuilt.cards.length
  };
}

async function benchmarkBranchRejection(store) {
  const entriesBefore = await store.listFoldCards({ scope: scope() });
  const betaRun = await completedRun(store, {
    runId: "run_j1_branch_beta",
    sessionId: "sess_j1_branch_beta",
    workspaceId: "beta",
    completedAt: "2026-09-15T12:00:00.000Z",
    messages: [
      { role: "user", content: "BETA-J1-BRANCH-PRIVATE" },
      { role: "assistant", content: "BETA-J1-BRANCH-ANSWER" }
    ]
  });
  const betaCard = await store.createFoldCard({
    level: 1,
    scope: scope("beta"),
    source_refs: [{ run_id: betaRun.run_id, session_id: betaRun.session_id, start_index: 0, end_index: 1 }],
    summary: "Beta branch-isolation fixture.",
    generator: { kind: "deterministic-j1", version: J1_GATEWAY_BENCHMARK_VERSION }
  });
  const alphaEntries = await store.listFoldCards({ scope: scope() });
  const leaked = alphaEntries.some((entry) => entry.card_id === betaCard.card_id);
  return {
    scenario_id: "branched_conversation",
    applicability: "not_applicable_rejected_by_F1",
    decision: "no_branch_catalog_shipped",
    candidate_correct: !leaked && alphaEntries.length === entriesBefore.length,
    cross_workspace_leakage: leaked,
    source_reads: 0
  };
}

export async function runGatewayJ1Benchmark() {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-j1-benchmark-"));
  const store = new GatewayStore(home);
  await store.init();

  const recent = await benchmarkRecentRaw();
  const large = await benchmarkLargeInvocation();
  const history = await createHistoryFixture(store);
  const oldFact = await benchmarkFoldArchive(store, history);
  const branch = await benchmarkBranchRejection(store);
  const durability = await benchmarkRestartAndRebuild(home, history.sessionId);

  const scenarios = [recent, oldFact, branch, large];
  const correct = scenarios.filter((row) => row.candidate_correct).length;
  return {
    schema_version: "1.0",
    benchmark_version: J1_GATEWAY_BENCHMARK_VERSION,
    owner: "ai-verse-gateway",
    candidate: {
      total_scenarios: scenarios.length,
      correct_scenarios: correct,
      correctness: Number((correct / scenarios.length).toFixed(6)),
      long_history_context_reduction_ratio: oldFact.context_reduction_ratio,
      very_large_invocation_token_reduction_ratio: large.token_reduction_ratio,
      exact_fact_recovery: oldFact.exact_fact_recovered,
      source_reads: oldFact.source_reads,
      recent_tail_preserved_verbatim: large.recent_tail_preserved_verbatim
    },
    safety: {
      scope_leakage_count: branch.cross_workspace_leakage ? 1 : 0,
      canonical_raw_history_unchanged: oldFact.canonical_raw_history_unchanged
    },
    durability,
    scenarios
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runGatewayJ1Benchmark();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

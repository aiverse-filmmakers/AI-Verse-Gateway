import test from "node:test";
import assert from "node:assert/strict";
import {
  runGatewayJ1Benchmark,
  J1_GATEWAY_BENCHMARK_VERSION,
  J1_LONG_HISTORY_MIN_REDUCTION,
  J1_LARGE_INVOCATION_MIN_REDUCTION
} from "../benchmarks/context-ladder-j1.mjs";

test("J1 Gateway benchmark is machine-readable and covers accepted Gateway-owned scenarios", async () => {
  const result = await runGatewayJ1Benchmark();

  assert.equal(result.benchmark_version, J1_GATEWAY_BENCHMARK_VERSION);
  assert.equal(result.owner, "ai-verse-gateway");
  assert.equal(result.candidate.total_scenarios, 4);
  assert.equal(result.candidate.correct_scenarios, 4);
  assert.equal(result.candidate.correctness, 1);
  assert.equal(result.candidate.exact_fact_recovery, true);
  assert.equal(result.candidate.recent_tail_preserved_verbatim, true);
  assert.equal(result.safety.scope_leakage_count, 0);
  assert.equal(result.safety.canonical_raw_history_unchanged, true);
  assert.equal(result.durability.restart_archive_recovery, true);
  assert.equal(result.durability.fold_catalog_rebuild_equivalent, true);
  assert.ok(result.candidate.long_history_context_reduction_ratio >= J1_LONG_HISTORY_MIN_REDUCTION);
  assert.ok(result.candidate.very_large_invocation_token_reduction_ratio >= J1_LARGE_INVOCATION_MIN_REDUCTION);
  assert.equal(result.frozen_thresholds.frozen_after_measurement, true);
  assert.ok(result.candidate.source_reads > 0);

  const ids = new Set(result.scenarios.map((row) => row.scenario_id));
  assert.deepEqual(ids, new Set([
    "recent_conversation",
    "fact_50_plus_turns_old",
    "branched_conversation",
    "very_large_history"
  ]));

  const branch = result.scenarios.find((row) => row.scenario_id === "branched_conversation");
  assert.equal(branch.applicability, "not_applicable_rejected_by_F1");
  assert.equal(branch.decision, "no_branch_catalog_shipped");

  process.stdout.write(
    "J1_GATEWAY_BENCHMARK_JSON=" + JSON.stringify(result) + "\n"
  );
});

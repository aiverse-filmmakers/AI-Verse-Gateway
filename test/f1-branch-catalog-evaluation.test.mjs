import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { GatewayStore } from "../src/store.mjs";
import { GatewayError } from "../src/errors.mjs";

const GENERATOR = { kind: "deterministic-test", version: "f1-eval-v1" };

function scope(workspaceId = "alpha", principal = "operator") {
  return { system_id: "local", workspace_id: workspaceId, principal };
}

async function completedRun(store, {
  runId,
  sessionId,
  workspaceId = "alpha",
  completedAt,
  messages
}) {
  await store.createSession({
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator",
    session_id: sessionId
  });
  const run = await store.createRun({
    run_id: runId,
    session_id: sessionId,
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator",
    runtime: { kind: "deterministic" },
    messages,
    max_turns: 1,
    budget: { max_actions: 1, max_tokens: null, max_cost: null },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });
  run.status = "completed";
  run.completed_at = completedAt;
  await store.saveRun(run);
  return run;
}

async function cardStorageSnapshot(store) {
  const names = (await readdir(store.p.foldCards)).filter((name) => name.endsWith(".json")).sort();
  let bytes = 0;
  for (const name of names) bytes += (await stat(path.join(store.p.foldCards, name))).size;
  return { files: names, bytes };
}

test("F1 evaluation rejects copy-on-write branch catalogs for the current AI-Verse identity model", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-f1-branch-eval-"));
  const store = new GatewayStore(home);
  await store.init();

  const preForkRun = await completedRun(store, {
    runId: "run_f1_prefork",
    sessionId: "sess_f1_prefork",
    completedAt: "2026-09-15T09:00:00.000Z",
    messages: [
      { role: "user", content: "PRE-FORK-RAW-ONE" },
      { role: "assistant", content: "PRE-FORK-RAW-TWO" }
    ]
  });
  const preForkCard = await store.createFoldCard({
    level: 1,
    scope: scope(),
    source_refs: [{ run_id: preForkRun.run_id, start_index: 0, end_index: 1 }],
    summary: "PRE-FORK-SUMMARY-TOKEN shared immutable history.",
    generator: GENERATOR
  });

  const beforeViews = await cardStorageSnapshot(store);
  const catalogBefore = await store.rebuildFoldCatalog({ live_validation: true });
  const hypotheticalBranchViewA = await store.listFoldCards({ scope: scope() });
  const hypotheticalBranchViewB = await store.listFoldCards({ scope: scope() });
  const afterViews = await cardStorageSnapshot(store);

  assert.equal(beforeViews.files.length, 1);
  assert.equal(afterViews.files.length, 1);
  assert.equal(afterViews.bytes, beforeViews.bytes, "repeated catalog views must add zero duplicated immutable-card bytes");
  assert.deepEqual(hypotheticalBranchViewA.map((entry) => entry.card_id), [preForkCard.card_id]);
  assert.deepEqual(hypotheticalBranchViewB.map((entry) => entry.card_id), [preForkCard.card_id]);
  assert.equal(catalogBefore.cards.length, 1);

  const catalogBody = await readFile(store.p.foldCatalog, "utf8");
  assert.equal(catalogBody.includes("PRE-FORK-SUMMARY-TOKEN"), false, "derived catalog must not copy fold summaries");
  assert.equal(catalogBody.includes("PRE-FORK-RAW-ONE"), false, "derived catalog must never copy raw source history");

  const preForkStored = await store.getFoldCard(preForkCard.card_id);
  for (const key of ["branch_id", "fork_id", "parent_branch_id", "fork_point"]) {
    assert.equal(Object.hasOwn(preForkStored, key), false, `current fold-card schema must not pretend to own ${key}`);
  }

  const leftRun = await completedRun(store, {
    runId: "run_f1_left",
    sessionId: "sess_f1_left",
    completedAt: "2026-09-15T09:01:00.000Z",
    messages: [
      { role: "user", content: "LEFT-DIVERGENCE-RAW" },
      { role: "assistant", content: "LEFT-DIVERGENCE-ANSWER" }
    ]
  });
  const leftCard = await store.createFoldCard({
    level: 1,
    scope: scope(),
    source_refs: [{ run_id: leftRun.run_id, start_index: 0, end_index: 1 }],
    summary: "Left divergent continuation.",
    generator: GENERATOR
  });

  const rightRun = await completedRun(store, {
    runId: "run_f1_right",
    sessionId: "sess_f1_right",
    completedAt: "2026-09-15T09:02:00.000Z",
    messages: [
      { role: "user", content: "RIGHT-DIVERGENCE-RAW" },
      { role: "assistant", content: "RIGHT-DIVERGENCE-ANSWER" }
    ]
  });
  const rightCard = await store.createFoldCard({
    level: 1,
    scope: scope(),
    source_refs: [{ run_id: rightRun.run_id, start_index: 0, end_index: 1 }],
    summary: "Right divergent continuation.",
    generator: GENERATOR
  });

  const sameWorkspaceView = await store.listFoldCards({ scope: scope() });
  const sameWorkspaceIds = new Set(sameWorkspaceView.map((entry) => entry.card_id));
  assert.equal(sameWorkspaceIds.has(preForkCard.card_id), true);
  assert.equal(sameWorkspaceIds.has(leftCard.card_id), true);
  assert.equal(sameWorkspaceIds.has(rightCard.card_id), true);
  assert.equal(
    sameWorkspaceView.length,
    3,
    "without canonical branch lineage, two hypothetical same-workspace branches cannot safely hide each other's divergent cards"
  );

  const betaRun = await completedRun(store, {
    runId: "run_f1_beta",
    sessionId: "sess_f1_beta",
    workspaceId: "beta",
    completedAt: "2026-09-15T09:03:00.000Z",
    messages: [
      { role: "user", content: "BETA-ISOLATED-RAW" },
      { role: "assistant", content: "BETA-ISOLATED-ANSWER" }
    ]
  });
  const betaCard = await store.createFoldCard({
    level: 1,
    scope: scope("beta"),
    source_refs: [{ run_id: betaRun.run_id, start_index: 0, end_index: 1 }],
    summary: "Beta isolated history.",
    generator: GENERATOR
  });

  await assert.rejects(
    () => store.createFoldCard({
      level: 2,
      scope: scope(),
      child_refs: [preForkCard.card_id, betaCard.card_id],
      summary: "Cross-scope inheritance must never be allowed.",
      generator: GENERATOR
    }),
    (error) => error instanceof GatewayError && error.code === "FOLD_SCOPE_MISMATCH"
  );

  const finalStorage = await cardStorageSnapshot(store);
  assert.equal(finalStorage.files.length, 4);
  assert.ok(finalStorage.bytes > beforeViews.bytes);

  const benchmark = {
    pre_fork_card_files_before_views: beforeViews.files.length,
    pre_fork_card_files_after_two_views: afterViews.files.length,
    duplicated_pre_fork_card_bytes_added_by_views: afterViews.bytes - beforeViews.bytes,
    same_workspace_divergent_cards_visible_without_branch_identity: sameWorkspaceView.length,
    copy_on_write_storage_savings_over_current_baseline_bytes: 0,
    decision: "reject"
  };

  assert.deepEqual(benchmark, {
    pre_fork_card_files_before_views: 1,
    pre_fork_card_files_after_two_views: 1,
    duplicated_pre_fork_card_bytes_added_by_views: 0,
    same_workspace_divergent_cards_visible_without_branch_identity: 3,
    copy_on_write_storage_savings_over_current_baseline_bytes: 0,
    decision: "reject"
  });
});

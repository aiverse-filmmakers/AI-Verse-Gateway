import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { GatewayStore } from "../src/store.mjs";
import { GatewayError } from "../src/errors.mjs";

async function completedRun(store, {
  sessionId,
  runId,
  workspaceId = "alpha",
  principal = "operator",
  messages
}) {
  await store.createSession({
    system_id: "local",
    workspace_id: workspaceId,
    principal,
    session_id: sessionId
  });
  const run = await store.createRun({
    run_id: runId,
    session_id: sessionId,
    system_id: "local",
    workspace_id: workspaceId,
    principal,
    runtime: { kind: "deterministic" },
    messages,
    max_turns: 1,
    budget: { max_actions: 1 },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });
  run.status = "completed";
  run.completed_at = new Date().toISOString();
  await store.saveRun(run);
  return run;
}

function scope(workspaceId = "alpha", principal = "operator") {
  return {
    system_id: "local",
    workspace_id: workspaceId,
    principal
  };
}

const generator = {
  kind: "deterministic-test",
  version: "e1-v1"
};

test("level-1 fold card is immutable, content-addressed, ordered and leaves raw messages canonical", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-fold-l1-"));
  const store = new GatewayStore(home);
  await store.init();

  const originalMessages = [
    { role: "user", content: "RAW-ALPHA-ONE" },
    { role: "assistant", content: "RAW-ALPHA-TWO" },
    { role: "user", content: "RAW-ALPHA-THREE" }
  ];
  const run = await completedRun(store, {
    sessionId: "sess_fold_alpha",
    runId: "run_fold_alpha",
    messages: originalMessages
  });

  const input = {
    level: 1,
    scope: scope(),
    source_refs: [
      { run_id: run.run_id, start_index: 0, end_index: 1 },
      { run_id: run.run_id, start_index: 2, end_index: 2 }
    ],
    child_refs: [],
    summary: "Compact immutable summary for the covered exchange.",
    generator
  };

  const card = await store.createFoldCard(input);
  assert.match(card.card_id, /^fold_[a-f0-9]{40}$/);
  assert.match(card.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(card.level, 1);
  assert.deepEqual(card.scope, scope());
  assert.equal(card.validation_state.state, "validated");
  assert.equal(card.source_refs.length, 2);
  assert.equal(card.source_refs[0].start_index, 0);
  assert.equal(card.source_refs[0].end_index, 1);
  assert.equal(card.source_refs[1].start_index, 2);
  assert.equal(card.source_refs[1].end_index, 2);
  assert.equal(card.coverage.direct_source_count, 2);
  assert.equal(card.coverage.direct_message_count, 3);
  assert.equal(card.coverage.descendant_source_count, 2);
  assert.equal(card.coverage.descendant_message_count, 3);
  assert.equal(card.coverage.first_source_ref, "gateway:run:run_fold_alpha:messages:0-1");
  assert.equal(card.coverage.last_source_ref, "gateway:run:run_fold_alpha:messages:2-2");
  assert.ok(card.size_estimate.covered_bytes > 0);
  assert.ok(card.size_estimate.estimated_covered_tokens > 0);
  assert.ok(card.size_estimate.summary_bytes > 0);
  assert.ok(card.created_at);

  const cardFile = await readFile(store.foldCardFile(card.card_id), "utf8");
  assert.equal(cardFile.includes("RAW-ALPHA-ONE"), false);
  assert.equal(cardFile.includes("RAW-ALPHA-TWO"), false);
  assert.equal(cardFile.includes("RAW-ALPHA-THREE"), false);

  const resolved = await store.resolveFoldCardSources(card.card_id);
  assert.equal(resolved.length, 2);
  assert.deepEqual(
    resolved.flatMap((item) => item.messages),
    originalMessages
  );
  assert.deepEqual((await store.getRun(run.run_id)).messages, originalMessages);

  const replay = await store.createFoldCard(input);
  assert.equal(replay.card_id, card.card_id);
  assert.equal(replay.fingerprint, card.fingerprint);
  assert.equal(replay.created_at, card.created_at);

  const changed = await store.createFoldCard({
    ...input,
    summary: "A different summary creates a different immutable card."
  });
  assert.notEqual(changed.card_id, card.card_id);
  assert.equal((await store.getFoldCard(card.card_id)).summary, input.summary);
});

test("recursive fold card preserves ordered child fingerprints and exact descendant reachability across restart", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-fold-recursive-"));
  const store = new GatewayStore(home);
  await store.init();

  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "second answer" }
  ];
  const run = await completedRun(store, {
    sessionId: "sess_fold_recursive",
    runId: "run_fold_recursive",
    messages
  });

  const first = await store.createFoldCard({
    level: 1,
    scope: scope(),
    source_refs: [{ run_id: run.run_id, start_index: 0, end_index: 1 }],
    summary: "First exchange.",
    generator
  });
  const second = await store.createFoldCard({
    level: 1,
    scope: scope(),
    source_refs: [{ run_id: run.run_id, start_index: 2, end_index: 3 }],
    summary: "Second exchange.",
    generator
  });
  const parent = await store.createFoldCard({
    level: 2,
    scope: scope(),
    child_refs: [first.card_id, second.card_id],
    summary: "Two adjacent level-one cards summarized without replacing either child.",
    generator
  });

  assert.deepEqual(
    parent.child_refs,
    [
      { card_id: first.card_id, fingerprint: first.fingerprint },
      { card_id: second.card_id, fingerprint: second.fingerprint }
    ]
  );
  assert.equal(parent.source_refs.length, 0);
  assert.equal(parent.coverage.child_count, 2);
  assert.equal(parent.coverage.descendant_source_count, 2);
  assert.equal(parent.coverage.descendant_message_count, 4);
  assert.equal(parent.coverage.first_source_ref, "gateway:run:run_fold_recursive:messages:0-1");
  assert.equal(parent.coverage.last_source_ref, "gateway:run:run_fold_recursive:messages:2-3");

  const validation = await store.validateFoldCard(parent.card_id);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);

  const unfolded = await store.resolveFoldCardSources(parent.card_id);
  assert.deepEqual(unfolded.flatMap((item) => item.messages), messages);

  const catalog1 = await store.rebuildFoldCatalog();
  assert.equal(catalog1.cards.length, 3);
  assert.equal(catalog1.cards.every((entry) => entry.validation_state === "validated"), true);

  await rm(store.p.foldCatalog, { force: true });
  const catalog2 = await store.rebuildFoldCatalog();
  assert.equal(catalog2.fingerprint, catalog1.fingerprint);

  const restarted = new GatewayStore(home);
  await restarted.init();
  const afterRestart = await restarted.getFoldCard(parent.card_id);
  assert.equal(afterRestart.fingerprint, parent.fingerprint);
  assert.deepEqual(
    (await restarted.resolveFoldCardSources(parent.card_id)).flatMap((item) => item.messages),
    messages
  );
  const listed = await restarted.listFoldCards({ scope: scope(), level: 2 });
  assert.deepEqual(listed.map((entry) => entry.card_id), [parent.card_id]);
});

test("scope boundaries fail closed and referenced-card tampering is detected instead of silently mutating ancestry", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-fold-scope-"));
  const store = new GatewayStore(home);
  await store.init();

  const alphaRun = await completedRun(store, {
    sessionId: "sess_alpha_fold_scope",
    runId: "run_alpha_fold_scope",
    workspaceId: "alpha",
    messages: [
      { role: "user", content: "alpha question" },
      { role: "assistant", content: "alpha answer" }
    ]
  });
  const betaRun = await completedRun(store, {
    sessionId: "sess_beta_fold_scope",
    runId: "run_beta_fold_scope",
    workspaceId: "beta",
    messages: [
      { role: "user", content: "beta question" },
      { role: "assistant", content: "beta answer" }
    ]
  });

  await assert.rejects(
    () => store.createFoldCard({
      level: 1,
      scope: scope("alpha"),
      source_refs: [{ run_id: betaRun.run_id, start_index: 0, end_index: 1 }],
      summary: "This must not cross workspace scope.",
      generator
    }),
    (error) => error instanceof GatewayError && error.code === "FOLD_SCOPE_MISMATCH"
  );

  const alpha = await store.createFoldCard({
    level: 1,
    scope: scope("alpha"),
    source_refs: [{ run_id: alphaRun.run_id, start_index: 0, end_index: 1 }],
    summary: "Alpha leaf.",
    generator
  });
  const beta = await store.createFoldCard({
    level: 1,
    scope: scope("beta"),
    source_refs: [{ run_id: betaRun.run_id, start_index: 0, end_index: 1 }],
    summary: "Beta leaf.",
    generator
  });

  await assert.rejects(
    () => store.createFoldCard({
      level: 2,
      scope: scope("alpha"),
      child_refs: [alpha.card_id, beta.card_id],
      summary: "Cross-workspace ancestry must fail closed.",
      generator
    }),
    (error) => error instanceof GatewayError && error.code === "FOLD_SCOPE_MISMATCH"
  );

  const alphaRun2 = await completedRun(store, {
    sessionId: "sess_alpha_fold_scope_2",
    runId: "run_alpha_fold_scope_2",
    workspaceId: "alpha",
    messages: [
      { role: "user", content: "another alpha question" },
      { role: "assistant", content: "another alpha answer" }
    ]
  });
  const alpha2 = await store.createFoldCard({
    level: 1,
    scope: scope("alpha"),
    source_refs: [{ run_id: alphaRun2.run_id, start_index: 0, end_index: 1 }],
    summary: "Second alpha leaf.",
    generator
  });
  const parent = await store.createFoldCard({
    level: 2,
    scope: scope("alpha"),
    child_refs: [alpha.card_id, alpha2.card_id],
    summary: "Parent retains immutable child identities.",
    generator
  });

  const childPath = store.foldCardFile(alpha.card_id);
  const tampered = JSON.parse(await readFile(childPath, "utf8"));
  tampered.summary = "tampered child content";
  await writeFile(childPath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

  const parentValidation = await store.validateFoldCard(parent.card_id);
  assert.equal(parentValidation.valid, false);
  assert.equal(
    parentValidation.errors.some((item) => item.includes(alpha.card_id) && item.includes("fingerprint_mismatch")),
    true
  );
  await assert.rejects(
    () => store.getFoldCard(parent.card_id),
    (error) => error instanceof GatewayError && error.code === "INVALID_FOLD_CARD"
  );
});

test("fold source must be a completed canonical run", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-fold-inflight-"));
  const store = new GatewayStore(home);
  await store.init();
  await store.createSession({
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    session_id: "sess_inflight_fold"
  });
  const run = await store.createRun({
    run_id: "run_inflight_fold",
    session_id: "sess_inflight_fold",
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    runtime: { kind: "deterministic" },
    messages: [{ role: "user", content: "not complete" }],
    max_turns: 1,
    budget: { max_actions: 1 },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });

  await assert.rejects(
    () => store.createFoldCard({
      level: 1,
      scope: scope("alpha"),
      source_refs: [{ run_id: run.run_id, start_index: 0, end_index: 0 }],
      summary: "In-flight source must be rejected.",
      generator
    }),
    (error) => error instanceof GatewayError && error.code === "FOLD_SOURCE_NOT_IMMUTABLE"
  );
});

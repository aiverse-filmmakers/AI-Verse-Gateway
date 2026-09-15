import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { GatewayStore } from "../src/store.mjs";
import { GatewayError } from "../src/errors.mjs";
import { searchFoldArchive } from "../src/fold-archive.mjs";
import { sha256, stableStringify } from "../src/util.mjs";
import { installComponent, setupComponent } from "../src/lifecycle.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostFixture = path.resolve(here, "..", "fixtures", "fake-host.mjs");
const SCOPE = { system_id: "local", workspace_id: "alpha", principal: "operator" };
const GENERATOR = { kind: "deterministic-test", version: "e5-v1" };

async function completedRun(store, {
  runId,
  sessionId = "sess_e5",
  scope = SCOPE,
  completedAt = "2026-09-15T08:00:00.000Z",
  messages = [
    { role: "user", content: "E5 source one" },
    { role: "assistant", content: "E5 source two" }
  ]
}) {
  await store.createSession({
    system_id: scope.system_id,
    workspace_id: scope.workspace_id,
    principal: scope.principal,
    session_id: sessionId
  });
  const run = await store.createRun({
    run_id: runId,
    session_id: sessionId,
    system_id: scope.system_id,
    workspace_id: scope.workspace_id,
    principal: scope.principal,
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

function reidentify(card) {
  const core = {
    schema_version: card.schema_version,
    kind: card.kind,
    level: card.level,
    scope: card.scope,
    child_refs: card.child_refs,
    source_refs: card.source_refs,
    coverage: card.coverage,
    size_estimate: card.size_estimate,
    summary: card.summary,
    generator: card.generator,
    validation_state: card.validation_state
  };
  const fingerprint = `sha256:${sha256(stableStringify(core))}`;
  card.fingerprint = fingerprint;
  card.card_id = `fold_${fingerprint.slice("sha256:".length, "sha256:".length + 40)}`;
  return card;
}

async function writeSyntheticCard(store, card) {
  await writeFile(store.foldCardFile(card.card_id), JSON.stringify(card, null, 2) + "\n", "utf8");
}

test("E5 guard matrix rejects re-fingerprinted semantic corruption and invalid ordering", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-e5-guards-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await completedRun(store, {
    runId: "run_e5_guard",
    messages: [
      { role: "user", content: "guard-zero" },
      { role: "assistant", content: "guard-one" },
      { role: "user", content: "guard-two" },
      { role: "assistant", content: "guard-three" }
    ]
  });

  const valid = await store.createFoldCard({
    level: 1,
    scope: SCOPE,
    source_refs: [{ run_id: run.run_id, start_index: 0, end_index: 3 }],
    summary: "Valid guard baseline.",
    generator: GENERATOR
  });

  const original = JSON.parse(await readFile(store.foldCardFile(valid.card_id), "utf8"));

  const badCoverage = reidentify(structuredClone(original));
  badCoverage.coverage.direct_message_count += 1;
  reidentify(badCoverage);
  await writeSyntheticCard(store, badCoverage);
  await assert.rejects(
    () => store.getFoldCard(badCoverage.card_id),
    (error) => error instanceof GatewayError && error.code === "INVALID_FOLD_CARD"
  );

  const badSize = reidentify(structuredClone(original));
  badSize.size_estimate.covered_bytes += 16;
  badSize.size_estimate.estimated_covered_tokens = Math.ceil(badSize.size_estimate.covered_bytes / 4);
  reidentify(badSize);
  await writeSyntheticCard(store, badSize);
  await assert.rejects(
    () => store.getFoldCard(badSize.card_id),
    (error) => error instanceof GatewayError && error.code === "INVALID_FOLD_CARD"
  );

  const badScope = reidentify(structuredClone(original));
  badScope.scope.workspace_id = "beta";
  reidentify(badScope);
  await writeSyntheticCard(store, badScope);
  await assert.rejects(
    () => store.getFoldCard(badScope.card_id),
    (error) => error instanceof GatewayError && error.code === "INVALID_FOLD_CARD"
  );

  const badMetadata = reidentify(structuredClone(original));
  badMetadata.generator.kind = "";
  reidentify(badMetadata);
  await writeSyntheticCard(store, badMetadata);
  await assert.rejects(
    () => store.getFoldCard(badMetadata.card_id),
    (error) => error instanceof GatewayError && error.code === "INVALID_FOLD_CARD"
  );

  const before = (await store.rebuildFoldCatalog()).cards.length;
  await assert.rejects(
    () => store.createFoldCard({
      level: 1,
      scope: SCOPE,
      source_refs: [
        { run_id: run.run_id, start_index: 2, end_index: 3 },
        { run_id: run.run_id, start_index: 0, end_index: 1 }
      ],
      summary: "Reversed ranges must never persist.",
      generator: GENERATOR
    }),
    (error) => error instanceof GatewayError && error.code === "INVALID_FOLD_ORDER"
  );
  const after = (await store.rebuildFoldCatalog()).cards.length;
  assert.equal(after, before, "invalid ordering must fail before persistence");
});

test("restart rebuilds live catalog and preserves durable scheduled fold recovery state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-e5-restart-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await completedRun(store, { runId: "run_e5_restart" });
  run.context_governor = {
    schema_version: "1.0",
    status: "soft_fold_scheduled",
    tokens_by_layer: {
      system: 4,
      older_raw_before: 0,
      recent_raw: 40,
      compacted_summary: 0,
      total_before: 44,
      total_after: 44
    },
    fold_work: { state: "scheduled_for_safe_boundary", reason: "soft_fold_scheduled" }
  };
  await store.saveRun(run);
  const card = await store.createFoldCard({
    level: 1,
    scope: SCOPE,
    source_refs: [{ run_id: run.run_id, start_index: 0, end_index: 1 }],
    summary: "Restart-safe card.",
    generator: GENERATOR
  });
  const prior = await store.rebuildFoldCatalog({ live_validation: true });
  assert.equal(prior.cards.find((entry) => entry.card_id === card.card_id)?.live_validation_state, "validated");

  await rm(store.p.foldCatalog, { force: true });
  const restarted = new GatewayStore(home);
  await restarted.init();

  const rebuilt = JSON.parse(await readFile(restarted.p.foldCatalog, "utf8"));
  assert.equal(rebuilt.cards.find((entry) => entry.card_id === card.card_id)?.live_validation_state, "validated");
  assert.equal((await restarted.getFoldCard(card.card_id)).fingerprint, card.fingerprint);
  assert.deepEqual(
    (await restarted.pendingFoldWorkRuns()).map((item) => item.run_id),
    [run.run_id]
  );
});

test("archive diagnostics expose IDs/refs/depth/fallback without archived message content", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-e5-archive-diag-"));
  const store = new GatewayStore(home);
  await store.init();
  const run = await completedRun(store, {
    runId: "run_e5_archive",
    messages: [
      { role: "user", content: "The exact marker is DIAG-OMEGA-42." },
      { role: "assistant", content: "Marker retained exactly." }
    ]
  });
  const card = await store.createFoldCard({
    level: 1,
    scope: SCOPE,
    source_refs: [{ run_id: run.run_id, start_index: 0, end_index: 1 }],
    summary: "Diagnostic archive card.",
    generator: GENERATOR
  });

  const result = await searchFoldArchive(store, {
    query: 'exact "DIAG-OMEGA-42"',
    scope: SCOPE,
    session_id: run.session_id,
    run_id: run.run_id,
    max_unfold_cards: 1,
    max_messages: 4,
    max_raw_bytes: 4096
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.diagnostics.cards_used, [card.card_id]);
  assert.ok(result.diagnostics.source_refs.some((ref) => ref.includes("run_e5_archive")));
  assert.equal(result.diagnostics.retrieval_depth, 1);
  assert.equal(result.diagnostics.exact_fallback_reason, "precision_intent");
  assert.equal(result.diagnostics.raw_content_included, false);
  assert.equal(result.diagnostics.chain_of_thought_included, false);
  assert.equal(JSON.stringify(result.diagnostics).includes("DIAG-OMEGA-42"), false);

  const saved = await store.getRun(run.run_id);
  assert.deepEqual(saved.archive_diagnostics.cards_used, [card.card_id]);
  assert.equal(saved.archive_diagnostics.exact_fallback_reason, "precision_intent");
});

async function serverFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "avg-e5-system-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-e5-home-"));
  await writeFile(path.join(root, "AI-VERSE.yaml"), "schema_version: 2.0\n");
  const hostConfig = path.join(root, "host.json");
  await writeFile(hostConfig, JSON.stringify({
    transport: "json-subprocess",
    command: [process.execPath, hostFixture],
    timeout_seconds: 10,
    max_output_bytes: 1048576,
    max_stderr_bytes: 65536,
    env_names: [],
    cwd: root
  }));
  await installComponent({ home });
  const setup = await setupComponent({
    home,
    system_root: root,
    host_config: hostConfig,
    runtime: "deterministic",
    context_window_tokens: 4096,
    context_soft_pressure_ratio: 0.6,
    context_hard_pressure_ratio: 0.85,
    context_recent_raw_tail_messages: 4
  });
  return { root, home, setup };
}

async function waitCompleted(baseUrl, token, runId, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const response = await fetch(`${baseUrl}/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = await response.json();
    if (!["queued", "running", "resuming", "waiting_tool"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for diagnostic fixture run");
}

test("authenticated advanced diagnostics expose safe context/archive/recovery schema with no raw content or reasoning", async () => {
  const fixture = await serverFixture();
  const live = await startServer(await loadConfig(fixture.home), fixture.home, { port: 0 });
  const baseUrl = `http://127.0.0.1:${live.port}`;
  try {
    const createdResponse = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.setup.api_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "aiverse",
        messages: [{ role: "user", content: "DIAG-X" }],
        metadata: { workspace_id: "operator" }
      })
    });
    assert.equal(createdResponse.status, 202);
    const created = await createdResponse.json();
    const done = await waitCompleted(baseUrl, fixture.setup.api_token, created.run_id);
    assert.equal(done.status, "completed");

    const direct = new GatewayStore(fixture.home);
    await direct.init();
    const run = await direct.getRun(created.run_id);
    const scope = {
      system_id: run.system_id,
      workspace_id: run.workspace_id,
      principal: run.principal
    };
    const card = await direct.createFoldCard({
      level: 1,
      scope,
      source_refs: [{
        run_id: run.run_id,
        start_index: 0,
        end_index: run.messages.length - 1
      }],
      summary: "Server diagnostic archive card.",
      generator: GENERATOR
    });
    await searchFoldArchive(direct, {
      query: 'exact "DIAG-X"',
      scope,
      session_id: run.session_id,
      run_id: run.run_id,
      max_unfold_cards: 1,
      max_messages: 8,
      max_raw_bytes: 8192
    });

    const response = await fetch(`${baseUrl}/v1/runs/${created.run_id}/diagnostics`, {
      headers: { authorization: `Bearer ${fixture.setup.api_token}` }
    });
    assert.equal(response.status, 200);
    const diagnostics = await response.json();

    assert.equal(diagnostics.kind, "gateway_advanced_diagnostics");
    assert.equal(diagnostics.run_id, created.run_id);
    assert.ok(diagnostics.context.tokens_by_layer);
    assert.equal(typeof diagnostics.context.tokens_by_layer.total_before, "number");
    assert.deepEqual(diagnostics.archive.cards_used, [card.card_id]);
    assert.ok(diagnostics.archive.source_refs.length >= 1);
    assert.equal(diagnostics.archive.retrieval_depth, 1);
    assert.equal(diagnostics.archive.exact_fallback_reason, "precision_intent");
    assert.equal(diagnostics.safety.raw_message_content_included, false);
    assert.equal(diagnostics.safety.prompts_included, false);
    assert.equal(diagnostics.safety.chain_of_thought_included, false);

    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes("DIAG-X"), false);
    assert.equal(serialized.includes('"messages"'), false);
    assert.equal(serialized.includes('"content"'), false);
    assert.equal(serialized.includes("chain_of_thought"), true, "schema may explicitly prove chain-of-thought is excluded");
  } finally {
    await live.close();
  }
});

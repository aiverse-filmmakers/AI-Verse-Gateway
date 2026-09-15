import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { GatewayStore } from "../src/store.mjs";
import { RunEngine } from "../src/run-engine.mjs";
import { foldOldestHistory } from "../src/fold-engine.mjs";
import { governInvocationContext } from "../src/context-governor.mjs";
import {
  retrieveRuntimeDeepContext,
  PROGRESSIVE_HISTORY_VERSION
} from "../src/progressive-context.mjs";
import { GatewayError } from "../src/errors.mjs";
import { sha256, stableStringify } from "../src/util.mjs";

const OS_ROOT = process.env.OS_ROOT;
const HOST_CONFIG = process.env.HOST_CONFIG;
if (!OS_ROOT || !HOST_CONFIG) {
  throw new Error("OS_ROOT and HOST_CONFIG are required");
}

const CONFIG = {
  host_adapter_config: HOST_CONFIG,
  goal_owner_config: null,
  runtime: { kind: "deterministic" },
  context: {
    window_tokens: 4096,
    soft_pressure_ratio: 0.55,
    hard_pressure_ratio: 0.72,
    recent_raw_tail_messages: 8,
    chars_per_token_estimate: 4,
    summary_wrapper_token_reserve: 32,
    cache_sensitive_skip: true
  },
  limits: {
    max_goal_continuation_turns: 8,
    no_progress_threshold: 2,
    wall_clock_seconds: 120,
    max_actions: 12,
    max_tokens: 12000,
    max_cost: null
  }
};

function scope(workspaceId = "alpha") {
  return {
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator"
  };
}

function scopeName(workspaceId = "alpha") {
  return "workspace:" + workspaceId;
}

async function createSession(store, workspaceId, explicitId = undefined) {
  return await store.createSession({
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator",
    ...(explicitId ? { session_id: explicitId } : {})
  });
}

async function createRun(store, {
  workspaceId = "alpha",
  sessionId,
  runId = undefined,
  messages,
  completed = false,
  completedAt = null
}) {
  const run = await store.createRun({
    ...(runId ? { run_id: runId } : {}),
    session_id: sessionId,
    system_id: "local",
    workspace_id: workspaceId,
    principal: "operator",
    runtime: { kind: "deterministic", model: "j2" },
    messages,
    max_turns: 1,
    budget: { max_tokens: 12000, max_cost: null, max_actions: 12 },
    deadline_at: new Date(Date.now() + 120000).toISOString()
  });
  if (completed) {
    run.status = "completed";
    run.completed_at = completedAt ?? new Date().toISOString();
    await store.saveRun(run);
  }
  return run;
}

async function runAction(engine, store, {
  sessionId,
  workspaceId = "alpha",
  operation,
  parameters,
  label
}) {
  const run = await createRun(store, {
    workspaceId,
    sessionId,
    messages: [{ role: "user", content: "J2 owner action: " + label }]
  });
  const call = {
    id: "call_" + label.replace(/[^A-Za-z0-9]+/g, "_"),
    type: "function",
    function: {
      name: "aiverse_action",
      arguments: JSON.stringify({
        action_class: "write_local_reversible",
        operation,
        parameters,
        reason: "J2 integrated acceptance: " + label
      })
    }
  };
  run.messages.push({ role: "assistant", content: "", tool_calls: [call] });
  await store.saveRun(run);
  const outcome = await engine.handleToolCalls(
    run,
    [call],
    scopeName(workspaceId)
  );
  assert.equal(outcome, "done");
  const fresh = await store.getRun(run.run_id);
  const toolMessage = [...fresh.messages].reverse().find((message) =>
    message?.role === "tool" && message?.tool_call_id === call.id
  );
  assert.ok(toolMessage, "missing tool result for " + label);
  return { run: fresh, payload: JSON.parse(toolMessage.content) };
}

function admission(overrides = {}) {
  return {
    durable: true,
    historical: true,
    current_truth: false,
    contains_secret: false,
    strategic: false,
    permission_expansion: false,
    privacy_ambiguous: false,
    external_authority: false,
    ...overrides
  };
}

function itemIds(response) {
  return new Set(
    (response?.items ?? [])
      .map((item) => String(item?.id ?? ""))
      .filter(Boolean)
  );
}

function hasRawAtomicText(value) {
  const body = stableStringify(value);
  return body.includes("J2-NYX target port is 7100")
    || body.includes("J2-NYX target port is 7200")
    || body.includes("J2-DURABLE checkpoint notes improve review reliability");
}

function runMemoryHelper(operation, extraArgs = []) {
  const proc = spawnSync(
    "python",
    [
      "scripts/j2-memory-owner-check.py",
      operation,
      "--root",
      OS_ROOT,
      ...extraArgs
    ],
    { encoding: "utf8" }
  );
  if (proc.status !== 0) {
    throw new Error(
      "J2 Memory helper failed:\n" +
      String(proc.stdout ?? "") +
      "\n" +
      String(proc.stderr ?? "")
    );
  }
  const lines = String(proc.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (!lines.length) throw new Error("J2 Memory helper returned no JSON");
  return JSON.parse(lines.at(-1));
}

async function main() {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "gateway-j2-integrated-")
  );
  const store = new GatewayStore(home);
  await store.init();
  const engine = new RunEngine({ store, config: CONFIG });

  const alpha = await createSession(store, "alpha", "sess_j2_alpha");
  const beta = await createSession(store, "beta", "sess_j2_beta");

  const oldCapture = await runAction(engine, store, {
    sessionId: alpha.session_id,
    operation: "memory.capture",
    label: "capture_old_nyx_port",
    parameters: {
      text: "J2-NYX target port is 7100.",
      type: "fact",
      importance: 4,
      confidence: 0.99,
      why: "Historical configuration evidence.",
      tags: "j2,nyx,target,port",
      admission: admission()
    }
  });
  assert.equal(oldCapture.payload.status, "succeeded");
  assert.equal(
    oldCapture.payload.result.memory_capture.state,
    "captured"
  );
  const oldMemoryId =
    oldCapture.payload.result.memory_capture.memory_id;
  assert.ok(oldMemoryId);

  const nonDurable = await runAction(engine, store, {
    sessionId: alpha.session_id,
    operation: "memory.capture",
    label: "reject_non_durable_aside",
    parameters: {
      text: "J2 temporary aside must never become durable Memory.",
      type: "fact",
      confidence: 0.99,
      admission: admission({ durable: false })
    }
  });
  assert.equal(
    nonDurable.payload.result.memory_capture.state,
    "ignored"
  );
  assert.equal(
    nonDurable.payload.result.memory_capture.changed,
    false
  );

  const correction = await runAction(engine, store, {
    sessionId: alpha.session_id,
    operation: "memory.capture",
    label: "capture_nyx_correction",
    parameters: {
      text: "J2-NYX target port is 7200.",
      type: "correction",
      importance: 5,
      confidence: 0.99,
      why: "Explicit correction of the historical port.",
      tags: "j2,nyx,target,port,correction",
      supersedes: oldMemoryId,
      admission: admission()
    }
  });
  assert.equal(
    correction.payload.result.memory_capture.state,
    "captured"
  );
  const correctionId =
    correction.payload.result.memory_capture.memory_id;
  assert.ok(correctionId);

  const currentPort = await engine.host.retrieveHistoryProgressive({
    version: PROGRESSIVE_HISTORY_VERSION,
    depth: "detail",
    scope: scopeName(),
    query: "current J2-NYX target port",
    limit: 4,
    max_bytes: 12288
  });
  assert.equal(itemIds(currentPort).has(correctionId), true);
  assert.equal(itemIds(currentPort).has(oldMemoryId), false);

  const historicalPort = await engine.host.retrieveHistoryProgressive({
    version: PROGRESSIVE_HISTORY_VERSION,
    depth: "detail",
    scope: scopeName(),
    query: "J2-NYX target port before correction",
    limit: 4,
    max_bytes: 12288
  });
  const oldEvidence = (historicalPort.items ?? [])
    .find((item) => item.id === oldMemoryId);
  assert.ok(
    oldEvidence,
    "superseded historical Memory was not recoverable"
  );
  const oldSource = await engine.host.retrieveHistoryProgressive({
    version: PROGRESSIVE_HISTORY_VERSION,
    depth: "source",
    scope: scopeName(),
    query: "exact old J2-NYX target port",
    evidence_ref: oldEvidence,
    limit: 1,
    max_bytes: 8192
  });
  assert.equal(oldSource.status, "ok");
  assert.equal(oldSource.exact_evidence, true);
  assert.match(stableStringify(oldSource), /7100/);

  const sourceSession = await createSession(
    store,
    "alpha",
    "sess_j2_prior_source"
  );
  const sourceMessages = [
    {
      role: "user",
      content:
        "RAW-J2-PRIVATE-TRANSCRIPT: discuss the exact prior launch phrase."
    },
    {
      role: "assistant",
      content:
        "Exact J2 prior-session launch phrase: COMET-77. Keep transcript evidence canonical in Gateway."
    }
  ];
  const sourceRun = await createRun(store, {
    workspaceId: "alpha",
    sessionId: sourceSession.session_id,
    runId: "run_j2_prior_source",
    messages: sourceMessages,
    completed: true,
    completedAt: "2026-09-15T12:00:00.000Z"
  });
  const sourceFingerprint =
    "sha256:" + sha256(stableStringify(sourceMessages));

  const digestAction = await runAction(engine, store, {
    sessionId: alpha.session_id,
    operation: "memory.session_digest",
    label: "create_prior_session_digest",
    parameters: {
      session_id: sourceSession.session_id,
      run_id: sourceRun.run_id,
      topic: "J2 prior session COMET-77",
      summary:
        "Prior J2 session approved launch phrase COMET-77.",
      significant_outcomes: [
        "Approved the durable launch phrase COMET-77."
      ],
      unresolved_items: [],
      source_coverage: [
        "gateway:run:" +
        sourceRun.run_id +
        ":messages:0-1"
      ],
      source_fingerprint: sourceFingerprint,
      completed_at: "2026-09-15T12:00:00.000Z"
    }
  });
  assert.equal(
    digestAction.payload.result.memory_session_digest.state,
    "captured"
  );
  const digestId =
    digestAction.payload.result.memory_session_digest.digest_id;
  assert.ok(digestId);

  const promotion = runMemoryHelper(
    "promote",
    ["--digest-id", digestId]
  );
  assert.equal(promotion.attempted, 2);
  assert.equal(promotion.captured, 1);
  assert.equal(promotion.ignored, 1);
  assert.equal(promotion.blocked, 0);

  const durableRecall =
    await engine.host.retrieveHistoryProgressive({
      version: PROGRESSIVE_HISTORY_VERSION,
      depth: "summary",
      scope: scopeName(),
      query:
        "J2-DURABLE checkpoint notes review reliability",
      limit: 6,
      max_bytes: 8192
    });
  assert.match(stableStringify(durableRecall), /J2-DURABLE/);
  assert.doesNotMatch(
    stableStringify(durableRecall),
    /J2-NONDURABLE/
  );

  const ordinaryRun = await createRun(store, {
    workspaceId: "alpha",
    sessionId: alpha.session_id,
    messages: [
      { role: "user", content: "What should I focus on today?" }
    ]
  });
  const ordinary = await engine.assembleContext(
    ordinaryRun,
    scopeName()
  );
  assert.deepEqual(
    ordinary.diagnostics.realized_depths,
    ["catalog"]
  );
  assert.equal(ordinary.diagnostics.source_reads, 0);
  assert.equal(hasRawAtomicText(ordinary.safe), false);
  const catalog =
    ordinary.safe.context_ladder.owner_history.catalog;
  assert.ok(
    Number(catalog?.catalog?.counts?.atomic_memory ?? 0) >= 2
  );
  assert.ok(
    (catalog?.catalog?.recent_sessions ?? [])
      .some((row) => row.digest_id === digestId)
  );

  const shortGoverned = await governInvocationContext({
    messages: ordinaryRun.messages,
    config: CONFIG.context
  });
  assert.equal(shortGoverned.diagnostic.fold_scheduled, false);
  assert.equal(
    shortGoverned.diagnostic.status,
    "below_soft_threshold"
  );

  const digestSummary =
    await engine.host.retrieveHistoryProgressive({
      version: PROGRESSIVE_HISTORY_VERSION,
      depth: "summary",
      scope: scopeName(),
      query: "J2 prior session COMET-77",
      limit: 6,
      max_bytes: 8192
    });
  assert.equal(itemIds(digestSummary).has(digestId), true);
  assert.doesNotMatch(
    stableStringify(digestSummary),
    /RAW-J2-PRIVATE-TRANSCRIPT/
  );

  const exactRun = await createRun(store, {
    workspaceId: "alpha",
    sessionId: alpha.session_id,
    messages: [{
      role: "user",
      content:
        "What exact source wording from the prior J2 session says COMET-77?"
    }]
  });
  const exact = await engine.assembleContext(
    exactRun,
    scopeName()
  );
  assert.equal(exact.diagnostics.requested_depth, "source");
  assert.deepEqual(
    exact.diagnostics.realized_depths,
    ["catalog", "summary", "detail", "source"]
  );
  assert.equal(exact.diagnostics.source_reads, 1);
  assert.ok(exact.diagnostics.gateway_source_range_reads >= 1);
  const gatewayExact =
    exact.safe.context_ladder.owner_history.gateway_exact_source;
  assert.equal(gatewayExact.status, "ok");
  assert.equal(gatewayExact.exact_evidence, true);
  assert.match(stableStringify(gatewayExact), /COMET-77/);
  assert.match(
    stableStringify(gatewayExact),
    /RAW-J2-PRIVATE-TRANSCRIPT/
  );

  await assert.rejects(
    () => retrieveRuntimeDeepContext({
      host: engine.host,
      store,
      run: exactRun,
      scope: scopeName(),
      depth: "source",
      query: "exact source without evidence",
      evidence_ref: null
    }),
    (error) =>
      error instanceof GatewayError &&
      error.code === "CONTEXT_RETRIEVAL_EVIDENCE_REQUIRED"
  );

  const foldSession = await createSession(
    store,
    "alpha",
    "sess_j2_fold"
  );
  for (let i = 0; i < 4; i += 1) {
    await createRun(store, {
      workspaceId: "alpha",
      sessionId: foldSession.session_id,
      runId: "run_j2_fold_" + i,
      completed: true,
      completedAt:
        "2026-09-15T13:0" + i + ":00.000Z",
      messages: [
        {
          role: "user",
          content:
            "J2 fold history user " +
            i +
            ": " +
            "older ".repeat(35)
        },
        {
          role: "assistant",
          content:
            "J2 fold history assistant " +
            i +
            ": " +
            "evidence ".repeat(30)
        }
      ]
    });
  }
  const foldResult = await foldOldestHistory(store, {
    pressure: 1,
    threshold: 0.8,
    fan_in: 2,
    max_levels: 4,
    max_new_cards: 1,
    session_id: foldSession.session_id,
    scope: scope(),
    summarize: async ({ level }) => ({
      summary:
        "J2-FOLD-L" +
        level +
        " compact older evidence.",
      generator: {
        kind: "j2-integrated",
        version: "1"
      }
    })
  });
  assert.equal(foldResult.status, "folded");
  assert.equal(foldResult.created_cards.length, 1);

  const longMessages = Array.from(
    { length: 50 },
    (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content:
        "J2-LONG-" +
        i +
        " " +
        "long-context ".repeat(40)
    })
  );
  const longGoverned = await governInvocationContext({
    messages: longMessages,
    config: CONFIG.context,
    summarize: async ({ covered_message_count }) => ({
      summary:
        "J2 compacted " +
        covered_message_count +
        " older messages while retaining exact recent evidence."
    })
  });
  assert.match(
    longGoverned.diagnostic.status,
    /^hard_compacted/
  );
  const tailCount =
    longGoverned.diagnostic.raw_tail_messages;
  assert.deepEqual(
    longGoverned.messages.slice(-tailCount),
    longMessages.slice(-tailCount)
  );
  assert.ok(
    longGoverned.diagnostic.estimated_tokens_after <
    longGoverned.diagnostic.estimated_tokens_before
  );

  const betaCapture = await runAction(engine, store, {
    sessionId: beta.session_id,
    workspaceId: "beta",
    operation: "memory.capture",
    label: "capture_beta_private",
    parameters: {
      text:
        "BETA-J2-PRIVATE client instruction must never appear in Alpha.",
      type: "fact",
      confidence: 0.99,
      admission: admission()
    }
  });
  const betaMemoryId =
    betaCapture.payload.result.memory_capture.memory_id;
  const alphaLeakCheck =
    await engine.host.retrieveHistoryProgressive({
      version: PROGRESSIVE_HISTORY_VERSION,
      depth: "detail",
      scope: scopeName("alpha"),
      query: "BETA-J2-PRIVATE client instruction",
      limit: 4,
      max_bytes: 12288
    });
  assert.equal(itemIds(alphaLeakCheck).has(betaMemoryId), false);
  assert.doesNotMatch(
    stableStringify(alphaLeakCheck),
    /BETA-J2-PRIVATE/
  );

  const betaFoldRun = await createRun(store, {
    workspaceId: "beta",
    sessionId: beta.session_id,
    runId: "run_j2_beta_fold",
    completed: true,
    completedAt: "2026-09-15T13:30:00.000Z",
    messages: [
      { role: "user", content: "BETA-J2-FOLD-RAW" },
      {
        role: "assistant",
        content: "BETA-J2-FOLD-ANSWER"
      }
    ]
  });
  const betaCard = await store.createFoldCard({
    level: 1,
    scope: scope("beta"),
    source_refs: [{
      run_id: betaFoldRun.run_id,
      start_index: 0,
      end_index: 1
    }],
    summary: "Beta isolated fold history.",
    generator: {
      kind: "j2-integrated",
      version: "1"
    }
  });
  const alphaCards = await store.listFoldCards({
    scope: scope("alpha")
  });
  assert.equal(
    alphaCards.some(
      (entry) => entry.card_id === betaCard.card_id
    ),
    false
  );
  const alphaCard = await store.getFoldCard(
    foldResult.created_cards[0].card_id
  );
  for (const field of [
    "branch_id",
    "fork_id",
    "parent_branch_id",
    "fork_point"
  ]) {
    assert.equal(Object.hasOwn(alphaCard, field), false);
  }
  await assert.rejects(
    () => store.createFoldCard({
      level: 2,
      scope: scope("alpha"),
      child_refs: [alphaCard.card_id, betaCard.card_id],
      summary: "Cross-scope ancestry must fail.",
      generator: {
        kind: "j2-integrated",
        version: "1"
      }
    }),
    (error) =>
      error instanceof GatewayError &&
      error.code === "FOLD_SCOPE_MISMATCH"
  );

  const rebuild = runMemoryHelper("rebuild");
  assert.equal(rebuild.canonical_unchanged, true);
  assert.equal(rebuild.orientation_equivalent, true);
  assert.equal(rebuild.relationships_equivalent, true);

  const sourceQuery =
    "J2-CANONICAL-SOURCE-ALPHA render profile ACEScg";
  const sourceDetail =
    await engine.host.retrieveHistoryProgressive({
      version: PROGRESSIVE_HISTORY_VERSION,
      depth: "detail",
      scope: scopeName(),
      query: sourceQuery,
      limit: 6,
      max_bytes: 12288
    });
  const indexedSource = (sourceDetail.items ?? []).find(
    (item) =>
      item.record_type === "indexed_record" &&
      String(item?.evidence?.path ?? "")
        .endsWith(
          "workspaces/alpha/context/CURRENT.md"
        )
  );
  assert.ok(
    indexedSource,
    "canonical CURRENT.md source was not indexed"
  );
  const sourceBefore =
    await engine.host.retrieveHistoryProgressive({
      version: PROGRESSIVE_HISTORY_VERSION,
      depth: "source",
      scope: scopeName(),
      query: sourceQuery,
      evidence_ref: indexedSource,
      limit: 1,
      max_bytes: 8192
    });
  assert.equal(sourceBefore.status, "ok");
  assert.equal(sourceBefore.exact_evidence, true);

  const currentPath = path.join(
    OS_ROOT,
    "workspaces",
    "alpha",
    "context",
    "CURRENT.md"
  );
  const currentBody = await readFile(
    currentPath,
    "utf8"
  );
  await writeFile(
    currentPath,
    currentBody.replace(
      "J2-CANONICAL-SOURCE-ALPHA render profile is ACEScg.",
      "J2-CANONICAL-SOURCE-ALPHA render profile changed to Display P3."
    ),
    "utf8"
  );
  const stale =
    await engine.host.retrieveHistoryProgressive({
      version: PROGRESSIVE_HISTORY_VERSION,
      depth: "source",
      scope: scopeName(),
      query: sourceQuery,
      evidence_ref: indexedSource,
      limit: 1,
      max_bytes: 8192
    });
  assert.equal(stale.status, "stale");
  assert.equal(stale.exact_evidence, false);

  const restartedStore = new GatewayStore(home);
  await restartedStore.init();
  const restartedEngine = new RunEngine({
    store: restartedStore,
    config: CONFIG
  });
  const restartedCatalog =
    await restartedStore.rebuildFoldCatalog({
      live_validation: true
    });
  assert.ok(restartedCatalog.cards.length >= 2);

  const restartRun = await createRun(restartedStore, {
    workspaceId: "alpha",
    sessionId: alpha.session_id,
    messages: [{
      role: "user",
      content:
        "What exact source wording from the prior J2 session says COMET-77?"
    }]
  });
  const restartExact =
    await restartedEngine.assembleContext(
      restartRun,
      scopeName()
    );
  assert.equal(
    restartExact.safe.context_ladder.owner_history
      .gateway_exact_source.status,
    "ok"
  );
  assert.match(
    stableStringify(
      restartExact.safe.context_ladder.owner_history
        .gateway_exact_source
    ),
    /COMET-77/
  );

  const result = {
    schema_version: "1.0",
    acceptance: "context-ladder-j2-integrated",
    owners: [
      "ai-verse-gateway",
      "ai-verse-os",
      "ai-verse-memory"
    ],
    checks: {
      short_conversation_shallow_only: true,
      long_conversation_folded_recent_tail_raw: true,
      exact_detail_descends_to_source: true,
      memory_catalog_no_atomic_dump: true,
      prior_session_digest_without_transcript_duplication:
        true,
      durable_only_promotion: true,
      corrections_supersede: true,
      workspace_isolation: true,
      branch_catalog_rejection_remains_safe: true,
      derived_rebuild_preserves_canonical: true,
      stale_source_fails_closed: true,
      restart_preserves_durable_state: true,
      exact_evidence_contract_enforced: true
    },
    evidence: {
      digest_id: digestId,
      correction_id: correctionId,
      old_memory_id: oldMemoryId,
      promoted_durable: promotion.captured,
      ignored_transient: promotion.ignored,
      exact_gateway_source_range_reads:
        exact.diagnostics.gateway_source_range_reads,
      fold_cards_after_restart:
        restartedCatalog.cards.length
    }
  };
  assert.equal(
    Object.values(result.checks).every(Boolean),
    true
  );
  process.stdout.write(
    "J2_INTEGRATED_ACCEPTANCE_JSON=" +
    JSON.stringify(result) +
    "\n"
  );
}

await main();

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { GatewayStore } from "../src/store.mjs";
import { foldOldestHistory } from "../src/fold-engine.mjs";
import { searchFoldArchive, unfoldFoldCard } from "../src/fold-archive.mjs";

const ALPHA = { system_id: "local", workspace_id: "alpha", principal: "operator" };
const BETA = { system_id: "local", workspace_id: "beta", principal: "operator" };

async function fixtureStore(prefix = "avg-e3-") {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new GatewayStore(home);
  await store.init();
  return store;
}

async function completedRun(store, {
  sessionId,
  runId,
  scope,
  completedAt,
  messages
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
    budget: { max_actions: 1 },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });
  run.status = "completed";
  run.completed_at = completedAt;
  await store.saveRun(run);
  return run;
}

function summarizer(request) {
  if (request.level === 1) {
    return {
      summary: "Cinematic delivery archive with durable production decisions.",
      generator: { kind: "deterministic-test", version: "e3-v1" }
    };
  }
  return {
    summary: "Cinematic delivery archive root.",
    generator: { kind: "deterministic-test", version: "e3-v1" }
  };
}

async function buildAlphaLevel2(store) {
  const sessionId = "sess_archive_alpha";
  const raws = [
    [
      { role: "user", content: "The hidden calibration identifier is OMEGA-42 and must remain exact." },
      { role: "assistant", content: "Recorded the calibration decision without changing the identifier." }
    ],
    [
      { role: "user", content: "Use a ProRes mezzanine for cinematic delivery." },
      { role: "assistant", content: "Cinematic delivery path confirmed." }
    ],
    [
      { role: "user", content: "Final review requires the literal path /shots/A14/final.exr." },
      { role: "assistant", content: "The review path is preserved as canonical raw history." }
    ],
    [
      { role: "user", content: "Keep ACEScg until the final display transform." },
      { role: "assistant", content: "Color pipeline decision confirmed." }
    ]
  ];

  for (let index = 0; index < raws.length; index += 1) {
    await completedRun(store, {
      sessionId,
      runId: `run_archive_alpha_${index}`,
      scope: ALPHA,
      completedAt: `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      messages: raws[index]
    });
  }

  await foldOldestHistory(store, {
    session_id: sessionId,
    scope: ALPHA,
    pressure: 1,
    fan_in: 2,
    summarize: summarizer
  });
  const second = await foldOldestHistory(store, {
    session_id: sessionId,
    scope: ALPHA,
    pressure: 1,
    fan_in: 2,
    summarize: summarizer
  });
  const root = second.created_cards.find((card) => card.level === 2);
  assert.ok(root);
  return { sessionId, raws, root };
}

test("compact archive search returns fold-card evidence without unfolding raw messages", async () => {
  const store = await fixtureStore();
  const { sessionId } = await buildAlphaLevel2(store);

  const result = await searchFoldArchive(store, {
    query: "cinematic delivery production decisions",
    scope: ALPHA,
    session_id: sessionId,
    precision: false
  });

  assert.equal(result.status, "ok");
  assert.equal(result.precision, false);
  assert.ok(result.compact_hits.length > 0);
  assert.equal(result.exact_hits.length, 0);
  assert.deepEqual(result.unfolded_card_ids, []);
  assert.equal(result.stale_card_ids.length, 0);
  assert.equal(
    result.compact_hits.every((hit) => hit.record_type === "fold_card"),
    true
  );
});

test("quoted precision query forces bounded multi-level unfold and recovers exact original text", async () => {
  const store = await fixtureStore();
  const { sessionId, root } = await buildAlphaLevel2(store);

  const result = await searchFoldArchive(store, {
    query: 'What was the exact identifier "OMEGA-42"?',
    scope: ALPHA,
    session_id: sessionId,
    max_unfold_cards: 1,
    max_messages: 8,
    max_raw_bytes: 8000
  });

  assert.equal(result.status, "ok");
  assert.equal(result.precision, true);
  assert.deepEqual(result.unfolded_card_ids, [root.card_id]);
  assert.equal(result.stale_card_ids.length, 0);
  assert.ok(result.exact_hits.length >= 1);
  const exact = result.exact_hits.find((hit) => hit.content.includes("OMEGA-42"));
  assert.ok(exact);
  assert.equal(exact.run_id, "run_archive_alpha_0");
  assert.equal(exact.message_index, 0);
  assert.equal(
    exact.source_ref,
    "gateway:run:run_archive_alpha_0:messages:0-0"
  );

  const unfolded = await unfoldFoldCard(store, {
    card_id: root.card_id,
    scope: ALPHA,
    max_messages: 16,
    max_raw_bytes: 16000
  });
  assert.equal(unfolded.status, "ok");
  assert.equal(unfolded.truncated, false);
  assert.equal(unfolded.messages.length, 8);
  assert.ok(unfolded.messages.some((message) => message.content.includes("/shots/A14/final.exr")));
});

test("stale canonical source fingerprint fails closed and refreshes derived archive state", async () => {
  const store = await fixtureStore();
  const { sessionId } = await buildAlphaLevel2(store);

  const run = await store.getRun("run_archive_alpha_0");
  run.messages[0].content = "OMEGA-99 replaced the prior raw source after fold creation.";
  await store.saveRun(run);

  const result = await searchFoldArchive(store, {
    query: 'exact "OMEGA-42"',
    scope: ALPHA,
    session_id: sessionId,
    max_unfold_cards: 2
  });

  assert.equal(result.status, "stale_archive");
  assert.equal(result.exact_hits.length, 0);
  assert.equal(result.compact_hits.length, 0);
  assert.ok(result.stale_card_ids.length >= 1);

  const catalog = JSON.parse(
    await (await import("node:fs/promises")).readFile(store.p.foldCatalog, "utf8")
  );
  assert.deepEqual(catalog.archive_validation.scope, ALPHA);
  assert.ok(catalog.archive_validation.stale_card_ids.length >= 1);
  assert.equal(
    catalog.cards
      .filter((entry) => entry.scope.workspace_id === "alpha")
      .some((entry) => entry.archive_read_state === "stale"),
    true
  );
});

test("archive search never crosses workspace scope", async () => {
  const store = await fixtureStore();
  const { sessionId } = await buildAlphaLevel2(store);

  const betaRun = await completedRun(store, {
    sessionId: "sess_archive_beta",
    runId: "run_archive_beta",
    scope: BETA,
    completedAt: "2026-09-01T09:00:00.000Z",
    messages: [
      { role: "user", content: "BETA-PRIVATE-MARKER exact private phrase." },
      { role: "assistant", content: "Private beta response." }
    ]
  });
  await store.createFoldCard({
    level: 1,
    scope: BETA,
    source_refs: [{ run_id: betaRun.run_id, start_index: 0, end_index: 1 }],
    summary: "BETA-PRIVATE-MARKER private archive summary.",
    generator: { kind: "deterministic-test", version: "e3-v1" }
  });

  const result = await searchFoldArchive(store, {
    query: 'exact "BETA-PRIVATE-MARKER"',
    scope: ALPHA,
    session_id: sessionId,
    max_unfold_cards: 3
  });

  assert.equal(
    JSON.stringify(result).includes("BETA-PRIVATE-MARKER"),
    true,
    "query echo itself is expected"
  );
  assert.equal(
    result.compact_hits.some((hit) => hit.summary.includes("BETA-PRIVATE-MARKER")),
    false
  );
  assert.equal(
    result.exact_hits.some((hit) => hit.content.includes("BETA-PRIVATE-MARKER")),
    false
  );
  assert.equal(
    result.stale_card_ids.some((id) => id.includes("BETA")),
    false
  );
});

test("precision unfold obeys message and byte bounds", async () => {
  const store = await fixtureStore();
  const { sessionId } = await buildAlphaLevel2(store);

  const result = await searchFoldArchive(store, {
    query: "exact original raw path identifier cinematic",
    scope: ALPHA,
    session_id: sessionId,
    max_unfold_cards: 1,
    max_messages: 1,
    max_raw_bytes: 512
  });

  assert.equal(result.precision, true);
  assert.ok(result.exact_hits.length <= 1);
  assert.ok(result.raw_bytes_returned <= 512);
  assert.equal(result.bounds.max_unfold_cards, 1);
  assert.equal(result.bounds.max_messages, 1);
  assert.equal(result.bounds.max_raw_bytes, 512);
});

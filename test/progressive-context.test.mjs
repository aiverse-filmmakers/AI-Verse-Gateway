import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  assembleProgressiveOwnerContext,
  classifyProgressiveContextNeed,
  PROGRESSIVE_HISTORY_OPERATION,
  PROGRESSIVE_HISTORY_VERSION
} from "../src/progressive-context.mjs";
import { GatewayStore } from "../src/store.mjs";
import { sha256, stableStringify } from "../src/util.mjs";

function fixtureRun(messages, overrides = {}) {
  return {
    run_id: "run_g1_current",
    session_id: "sess_g1_current",
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    messages,
    ...overrides
  };
}

class ProgressiveHost {
  constructor({ progressive = true, sourceMode = "indexed" } = {}) {
    this.progressive = progressive;
    this.sourceMode = sourceMode;
    this.calls = [];
  }
  async describe() {
    return {
      adapter_id: "fixture:g1",
      operations: [
        "read_context",
        "retrieve_history",
        ...(this.progressive ? [PROGRESSIVE_HISTORY_OPERATION] : []),
        "list_capabilities",
        "list_connections"
      ],
      metadata: { memory_progressive_recall: this.progressive ? "available" : "absent" }
    };
  }
  async readContext(scope) {
    this.calls.push({ op: "current", scope });
    return { scope, current_marker: "CURRENT-ONLY" };
  }
  async listCapabilities(scope) {
    this.calls.push({ op: "capabilities", scope });
    return [{ id: "cap.fixture" }];
  }
  async listConnections(scope) {
    this.calls.push({ op: "connections", scope });
    return [];
  }
  async retrieveHistory(query, scope) {
    this.calls.push({ op: "legacy", query, scope });
    return [{ marker: "LEGACY-HISTORY-MARKER", text: "bounded legacy fact" }];
  }
  async retrieveHistoryProgressive(payload) {
    this.calls.push({ op: "progressive", depth: payload.depth, payload });
    assert.equal(payload.version, PROGRESSIVE_HISTORY_VERSION);
    if (payload.depth === "catalog") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "catalog",
        scope: payload.scope,
        catalog: {
          counts: { atomic_memory: 2, indexed_sources: 1, session_digests: 1 },
          topics: ["launch"]
        },
        marker: "CATALOG-MARKER"
      };
    }
    if (payload.depth === "summary") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "summary",
        scope: payload.scope,
        items: [{
          record_type: "indexed_record",
          id: "mem-launch",
          scope: payload.scope,
          excerpt: "SUMMARY-MARKER launch decision",
          deeper_evidence_available: true,
          evidence: { path: "operator/memory/launch.md", source_version: "sha256:summary" }
        }]
      };
    }
    if (payload.depth === "detail") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "detail",
        scope: payload.scope,
        items: [
          {
            record_type: this.sourceMode === "session" ? "session_digest" : "indexed_record",
            id: this.sourceMode === "session" ? "sdg-launch" : "mem-launch",
            scope: payload.scope,
            text: "DETAIL-MARKER launch evidence",
            deeper_evidence_available: true,
            evidence: this.sourceMode === "session"
              ? {
                  path: "operator/memory/sessions/sdg-launch.json",
                  canonical_version: "1",
                  digest_fingerprint: "sha256:digest"
                }
              : {
                  path: "operator/memory/launch.md",
                  source_identity: "launch.md",
                  source_version: "sha256:detail",
                  freshness: "fresh"
                }
          },
          {
            record_type: "indexed_record",
            id: "mem-second",
            scope: payload.scope,
            text: "SECOND-DETAIL-MARKER",
            deeper_evidence_available: true,
            evidence: {
              path: "operator/memory/second.md",
              source_identity: "second.md",
              source_version: "sha256:second",
              freshness: "fresh"
            }
          }
        ]
      };
    }
    if (payload.depth === "source") {
      if (this.sourceMode === "session") {
        throw new Error("session source response must be supplied by the test-specific host");
      }
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "source",
        scope: payload.scope,
        status: "ok",
        exact_evidence: true,
        record_type: "indexed_record",
        id: "mem-launch",
        content: "EXACT-SOURCE-MARKER 18 September 2026",
        provenance: { owner: "ai-verse-memory", content_returned: true }
      };
    }
    throw new Error(`unexpected depth ${payload.depth}`);
  }
}

test("G1 classifier maps ordinary/history/detail/exact queries onto bounded ladder depths", () => {
  assert.equal(classifyProgressiveContextNeed("What should I work on today?").depth, "catalog");
  assert.equal(classifyProgressiveContextNeed("What did we decide previously about launch?").depth, "summary");
  assert.equal(classifyProgressiveContextNeed("Which correction superseded the previous launch note?").depth, "detail");
  assert.equal(classifyProgressiveContextNeed("What exact date did we agree for launch?").depth, "source");
});

test("ordinary turns read only current owners plus L1 catalog and never deep history", async () => {
  const host = new ProgressiveHost();
  const run = fixtureRun([{ role: "user", content: "What should I work on today?" }]);
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run,
    scope: "workspace:alpha",
    query: "What should I work on today?"
  });

  assert.deepEqual(
    host.calls.filter((call) => call.op === "progressive").map((call) => call.depth),
    ["catalog"]
  );
  assert.equal(host.calls.some((call) => call.op === "legacy"), false);
  assert.equal(assembled.diagnostics.requested_depth, "catalog");
  assert.deepEqual(assembled.diagnostics.realized_depths, ["catalog"]);
  assert.equal(assembled.diagnostics.source_reads, 0);
  assert.equal(assembled.safe.context_ladder.owner_history.summary, null);
  assert.equal(assembled.safe.context_ladder.owner_history.detail, null);
  assert.equal(assembled.safe.context_ladder.owner_history.source, null);
  const prompt = JSON.stringify(assembled.safe);
  assert.equal(prompt.includes("SUMMARY-MARKER"), false);
  assert.equal(prompt.includes("DETAIL-MARKER"), false);
  assert.equal(prompt.includes("EXACT-SOURCE-MARKER"), false);
});

test("historical fact queries stop at bounded summary depth", async () => {
  const host = new ProgressiveHost();
  const query = "What did we decide previously about launch?";
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: fixtureRun([{ role: "user", content: query }]),
    scope: "workspace:alpha",
    query
  });

  assert.deepEqual(
    host.calls.filter((call) => call.op === "progressive").map((call) => call.depth),
    ["catalog", "summary"]
  );
  assert.deepEqual(assembled.diagnostics.realized_depths, ["catalog", "summary"]);
  assert.equal(assembled.safe.context_ladder.owner_history.summary.items[0].excerpt.includes("SUMMARY-MARKER"), true);
  assert.equal(JSON.stringify(assembled.safe).includes("DETAIL-MARKER"), false);
});

test("exact-sensitive queries descend through detail to exactly one Memory source read", async () => {
  const host = new ProgressiveHost();
  const query = "What exact date did we agree for launch?";
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: fixtureRun([{ role: "user", content: query }]),
    scope: "workspace:alpha",
    query
  });

  assert.deepEqual(
    host.calls.filter((call) => call.op === "progressive").map((call) => call.depth),
    ["catalog", "summary", "detail", "source"]
  );
  const sourceCalls = host.calls.filter((call) => call.op === "progressive" && call.depth === "source");
  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0].payload.evidence_ref.id, "mem-launch");
  assert.equal(assembled.diagnostics.source_reads, 1);
  assert.deepEqual(assembled.diagnostics.realized_depths, ["catalog", "summary", "detail", "source"]);
  assert.equal(assembled.safe.context_ladder.owner_history.source.content, "EXACT-SOURCE-MARKER 18 September 2026");
  assert.equal(assembled.diagnostics.fallback_reason, null);
});

test("legacy hosts perform no history read for ordinary turns and one bounded compatibility read only when history is needed", async () => {
  const host = new ProgressiveHost({ progressive: false });
  const ordinary = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: fixtureRun([{ role: "user", content: "What is current?" }]),
    scope: "workspace:alpha",
    query: "What is current?"
  });
  assert.equal(host.calls.filter((call) => call.op === "legacy").length, 0);
  assert.equal(ordinary.diagnostics.fallback_reason, "progressive_bridge_unavailable_no_deep_need");

  const historical = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: fixtureRun([{ role: "user", content: "What did we decide previously?" }]),
    scope: "workspace:alpha",
    query: "What did we decide previously?"
  });
  assert.equal(host.calls.filter((call) => call.op === "legacy").length, 1);
  assert.equal(historical.diagnostics.legacy_reads, 1);
  assert.equal(historical.diagnostics.fallback_reason, "progressive_bridge_unavailable");
  assert.equal(historical.safe.context_ladder.owner_history.legacy[0].marker, "LEGACY-HISTORY-MARKER");
});

test("session-digest exact fallback revalidates Gateway scope and source fingerprint before returning raw evidence", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "avg-g1-external-source-"));
  const store = new GatewayStore(home);
  await store.init();
  await store.createSession({
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    session_id: "sess_g1_source"
  });
  const sourceMessages = [
    { role: "user", content: "Launch date discussion." },
    { role: "assistant", content: "The exact launch date is 18 September 2026." }
  ];
  const sourceRun = await store.createRun({
    run_id: "run_g1_source",
    session_id: "sess_g1_source",
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    runtime: { kind: "deterministic" },
    messages: sourceMessages,
    max_turns: 1,
    budget: { max_actions: 1, max_tokens: null, max_cost: null },
    deadline_at: new Date(Date.now() + 60_000).toISOString()
  });
  sourceRun.status = "completed";
  sourceRun.completed_at = "2026-09-15T09:00:00.000Z";
  await store.saveRun(sourceRun);

  const expectedFingerprint = `sha256:${sha256(stableStringify(sourceMessages))}`;
  const host = new ProgressiveHost({ sourceMode: "session" });
  host.retrieveHistoryProgressive = async function(payload) {
    this.calls.push({ op: "progressive", depth: payload.depth, payload });
    if (payload.depth === "catalog") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "catalog",
        scope: payload.scope,
        catalog: { counts: { atomic_memory: 0, indexed_sources: 0, session_digests: 1 } }
      };
    }
    if (payload.depth === "summary") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "summary",
        scope: payload.scope,
        items: [{
          record_type: "session_digest",
          id: "sdg-launch",
          scope: payload.scope,
          summary: "Launch decision summary",
          deeper_evidence_available: true,
          evidence: { path: "memory/session/sdg-launch.json", digest_fingerprint: "sha256:digest" }
        }]
      };
    }
    if (payload.depth === "detail") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "detail",
        scope: payload.scope,
        items: [{
          record_type: "session_digest",
          id: "sdg-launch",
          scope: payload.scope,
          summary: "Launch decision detail",
          deeper_evidence_available: true,
          evidence: { path: "memory/session/sdg-launch.json", digest_fingerprint: "sha256:digest" }
        }]
      };
    }
    if (payload.depth === "source") {
      return {
        schema_version: 1,
        api_version: PROGRESSIVE_HISTORY_VERSION,
        depth: "source",
        scope: payload.scope,
        status: "external_source_required",
        exact_evidence: false,
        evidence: {
          source_fingerprint: expectedFingerprint,
          external_source_refs: ["gateway:run:run_g1_source:messages:0-1"],
          source_coverage: ["gateway:run:run_g1_source:messages:0-1"]
        }
      };
    }
    throw new Error("unexpected progressive depth");
  };

  const query = "What exact date did we agree for launch?";
  const requestRun = fixtureRun([{ role: "user", content: query }]);
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store,
    run: requestRun,
    scope: "workspace:alpha",
    query
  });

  assert.equal(assembled.diagnostics.source_reads, 1);
  assert.equal(assembled.diagnostics.gateway_source_range_reads, 1);
  assert.equal(assembled.safe.context_ladder.owner_history.gateway_exact_source.status, "ok");
  assert.equal(assembled.safe.context_ladder.owner_history.gateway_exact_source.exact_evidence, true);
  assert.equal(
    assembled.safe.context_ladder.owner_history.gateway_exact_source.messages.some((item) =>
      item.content.includes("18 September 2026")
    ),
    true
  );

  sourceRun.messages[1].content = "The launch date changed after digest creation.";
  await store.saveRun(sourceRun);
  const stale = await assembleProgressiveOwnerContext({
    host,
    store,
    run: requestRun,
    scope: "workspace:alpha",
    query
  });
  assert.equal(stale.safe.context_ladder.owner_history.gateway_exact_source.status, "stale");
  assert.equal(stale.safe.context_ladder.owner_history.gateway_exact_source.messages.length, 0);
  assert.equal(stale.diagnostics.fallback_reason, "source_fingerprint_mismatch");
});

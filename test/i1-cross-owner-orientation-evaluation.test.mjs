import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleProgressiveOwnerContext,
  PROGRESSIVE_HISTORY_OPERATION
} from "../src/progressive-context.mjs";
import { HostClient } from "../src/host-adapter.mjs";
import { stableStringify } from "../src/util.mjs";

class OrientationHost {
  constructor() {
    this.calls = [];
  }
  async describe() {
    return {
      adapter_id: "fixture:i1",
      operations: [
        "read_context",
        "retrieve_history",
        PROGRESSIVE_HISTORY_OPERATION,
        "list_capabilities",
        "list_connections",
        "authorize_action",
        "request_action"
      ],
      metadata: {
        host: "ai-verse-os",
        memory_progressive_recall: "available"
      }
    };
  }
  async readContext(scope) {
    this.calls.push({ op: "read_context", scope });
    return {
      scope,
      direction_owner: "brain",
      strategy_status: "brain-canonical",
      direction_refs: ["brain:intent:launch-growth"],
      direction_view: ".aiverse/direction/views/workspace-alpha.md",
      current_context: [
        "# Active Current Context",
        "Direction owner: brain",
        "Canonical Brain refs:",
        "- brain:intent:launch-growth"
      ].join("\n"),
      structured_data: {
        state: "available",
        spaces: [
          {
            spaceId: "crm",
            name: "CRM",
            schemas: [
              {
                spaceId: "crm",
                entity: "lead",
                name: "Lead",
                schemaVersion: 2,
                fieldCount: 9
              }
            ]
          }
        ]
      }
    };
  }
  async listCapabilities(scope) {
    this.calls.push({ op: "list_capabilities", scope });
    return [{
      id: "aiverse-skills:video-editor",
      name: "Video Editor",
      description: "Edit video through the canonical capability provider.",
      provider: "aiverse-skills",
      visibility: "workspace"
    }];
  }
  async listConnections(scope) {
    this.calls.push({ op: "list_connections", scope });
    return [{
      id: "drive",
      name: "Drive",
      purpose: "files",
      status: "connected"
    }];
  }
  async retrieveHistoryProgressive(payload) {
    this.calls.push({ op: "retrieve_history_progressive", payload: structuredClone(payload) });
    assert.equal(payload.depth, "catalog");
    return {
      schema_version: 1,
      api_version: "memory.progressive-recall.v1",
      depth: "catalog",
      scope: payload.scope,
      budget_bytes: payload.max_bytes,
      truncated: false,
      deeper_evidence_available: true,
      next_depth: "summary",
      source_depth_available: false,
      catalog: {
        schema_version: 2,
        scope: payload.scope,
        visible_scopes: ["operator", payload.scope],
        source_fingerprint: "sha256:" + "a".repeat(64),
        counts: {
          atomic_memory: 7,
          indexed_sources: 3,
          session_digests: 2
        },
        memory_types: [{ type: "fact", count: 7 }],
        source_kinds: [{ kind: "profile", count: 1 }, { kind: "workspace", count: 2 }],
        source_routes: [
          {
            scope: payload.scope,
            kind: "workspace",
            count: 2,
            paths: [
              "workspaces/alpha/README.md",
              "workspaces/alpha/client.md"
            ]
          }
        ],
        topics: [
          { label: "Launch", count: 3, origins: ["memory_tag", "session_digest"] },
          { label: "Client Alpha", count: 2, origins: ["session_digest"] }
        ],
        recent_sessions: [
          {
            digest_id: "sdg-2",
            session_id: "sess-2",
            run_id: "run-2",
            scope: payload.scope,
            topic: "Client Alpha launch",
            completed_at: "2026-09-15T11:00:00Z"
          },
          {
            digest_id: "sdg-1",
            session_id: "sess-1",
            run_id: "run-1",
            scope: payload.scope,
            topic: "Video campaign",
            completed_at: "2026-09-15T10:00:00Z"
          }
        ],
        budget_bytes: payload.max_bytes,
        truncated: false
      },
      provenance: {
        owner: "ai-verse-memory",
        kind: "derived_orientation",
        source_fingerprint: "sha256:" + "a".repeat(64)
      }
    };
  }
}

function runFixture() {
  return {
    run_id: "run_i1",
    session_id: "sess_i1",
    system_id: "local",
    workspace_id: "alpha",
    principal: "operator",
    messages: [{ role: "user", content: "What should I focus on today?" }]
  };
}

function currentCoverage(safe) {
  const catalog = safe.context_ladder?.owner_history?.catalog?.catalog ?? {};
  return {
    goals_direction: Array.isArray(safe.current_context?.direction_refs)
      && safe.current_context.direction_refs.length > 0,
    memory_topics: Array.isArray(catalog.topics) && catalog.topics.length > 0,
    data_spaces: Array.isArray(safe.current_context?.structured_data?.spaces)
      && safe.current_context.structured_data.spaces.length > 0,
    skills: Array.isArray(safe.capabilities) && safe.capabilities.length > 0,
    bots: Array.isArray(safe.bots) && safe.bots.length > 0,
    recent_sessions: Array.isArray(catalog.recent_sessions) && catalog.recent_sessions.length > 0,
    important_sources: Array.isArray(catalog.source_routes) && catalog.source_routes.length > 0
  };
}

function derivedHypotheticalMap(safe) {
  const catalog = safe.context_ladder.owner_history.catalog.catalog;
  return {
    goals_direction: safe.current_context.direction_refs,
    memory_topics: catalog.topics,
    data_spaces: safe.current_context.structured_data.spaces,
    skills: safe.capabilities.map((item) => ({
      id: item.id,
      name: item.name,
      provider: item.provider
    })),
    bots: [],
    recent_sessions: catalog.recent_sessions,
    important_sources: catalog.source_routes
  };
}

test("I1 current G1 owner views already cover six of seven proposed orientation domains", async () => {
  const host = new OrientationHost();
  const assembled = await assembleProgressiveOwnerContext({
    host,
    store: null,
    run: runFixture(),
    scope: "workspace:alpha",
    query: "What should I focus on today?"
  });

  const coverage = currentCoverage(assembled.safe);
  assert.deepEqual(coverage, {
    goals_direction: true,
    memory_topics: true,
    data_spaces: true,
    skills: true,
    bots: false,
    recent_sessions: true,
    important_sources: true
  });

  const covered = Object.values(coverage).filter(Boolean).length;
  assert.equal(covered, 6);
  assert.equal(covered / Object.keys(coverage).length, 6 / 7);

  assert.deepEqual(
    host.calls.filter((call) => call.op === "retrieve_history_progressive")
      .map((call) => call.payload.depth),
    ["catalog"]
  );
});

test("I1 durable Bot orientation has no existing read-only Gateway/OS host boundary", async () => {
  const host = new OrientationHost();
  const description = await host.describe();

  assert.equal(description.operations.includes("list_bots"), false);
  assert.equal(description.operations.includes("list_workers"), false);
  assert.equal(typeof HostClient.prototype.listBots, "undefined");
  assert.equal(typeof HostClient.prototype.listWorkers, "undefined");
});

test("I1 hypothetical map adds zero safely sourced domains and duplicates all six populated domains", async () => {
  const assembled = await assembleProgressiveOwnerContext({
    host: new OrientationHost(),
    store: null,
    run: runFixture(),
    scope: "workspace:alpha",
    query: "What should I focus on today?"
  });
  const safe = assembled.safe;
  const map = derivedHypotheticalMap(safe);

  const populated = Object.entries(map).filter(([, value]) => Array.isArray(value) && value.length > 0);
  assert.equal(populated.length, 6);
  assert.equal(map.bots.length, 0);

  // Every populated map domain is copied from information already present in
  // the G1 prompt. The only missing domain cannot be populated without first
  // adding a canonical Bot owner read boundary.
  const duplicateDomains = [
    "goals_direction",
    "memory_topics",
    "data_spaces",
    "skills",
    "recent_sessions",
    "important_sources"
  ];
  assert.deepEqual(populated.map(([name]) => name), duplicateDomains);

  const safeBytes = Buffer.byteLength(stableStringify(safe), "utf8");
  const mapBytes = Buffer.byteLength(stableStringify(map), "utf8");
  assert.ok(safeBytes > 0);
  assert.ok(mapBytes > 0);

  const benchmark = {
    proposed_domains: 7,
    already_owner_routed_domains: 6,
    missing_domains: 1,
    safely_sourced_new_domains_added_by_map: 0,
    duplicated_populated_domains: 6,
    map_bytes_added_to_prompt_if_embedded: mapBytes,
    safe_information_gain_ratio: 0,
    decision: "reject"
  };

  assert.equal(benchmark.safely_sourced_new_domains_added_by_map, 0);
  assert.equal(benchmark.duplicated_populated_domains / benchmark.already_owner_routed_domains, 1);
  assert.equal(benchmark.safe_information_gain_ratio, 0);
  assert.equal(benchmark.decision, "reject");
});

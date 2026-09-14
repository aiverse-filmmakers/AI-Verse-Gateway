#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const statePath = path.join(process.cwd(), ".fixture-structured-data.json");
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return {}; }
};
const writeState = (value) => fs.writeFileSync(statePath, JSON.stringify(value, null, 2) + "\n");
const p = input.payload ?? {};
let result;

switch (input.operation) {
  case "describe":
    result = {
      adapter_id: "fixture:structured-data-host",
      protocol_version: "1.0",
      operations: [
        "read_context",
        "retrieve_history",
        "list_capabilities",
        "list_connections",
        "authorize_action",
        "request_action"
      ],
      metadata: {
        canonical_state_owned: false,
        optional_components_dynamic: true,
        data: "available",
        memory: "available"
      }
    };
    break;
  case "read_context": {
    const state = readState();
    result = {
      scope: p.scope,
      current_context: "structured Data fixture",
      structured_data: {
        state: "available",
        spaces: state.record ? [{
          spaceId: "crm",
          name: "CRM",
          schemas: [{
            spaceId: "crm",
            entity: "contacts",
            name: "Contacts",
            schemaVersion: 1,
            fieldCount: 3
          }]
        }] : []
      },
      read_only: true
    };
    break;
  }
  case "retrieve_history":
    result = [];
    break;
  case "list_capabilities":
    result = [];
    break;
  case "list_connections":
    result = [];
    break;
  case "authorize_action": {
    const req = p.request ?? {};
    result = /^[a-f0-9]{64}$/.test(String(req.request_fingerprint ?? ""))
      ? {
          decision: "allow",
          request_fingerprint: req.request_fingerprint,
          scope: req.scope,
          action_class: req.action_class,
          source: "fixture",
          reason: "allowed"
        }
      : {
          decision: "deny",
          request_fingerprint: String(req.request_fingerprint ?? ""),
          scope: String(req.scope ?? ""),
          action_class: String(req.action_class ?? ""),
          source: "fixture",
          reason: "fingerprint required"
        };
    break;
  }
  case "request_action": {
    const req = p.request ?? {};
    const state = readState();
    if (req.operation === "data.structured-truth") {
      const params = req.parameters ?? {};
      const candidate = params.candidate ?? {};
      const trusted =
        typeof candidate.candidate_id === "string" &&
        candidate.candidate_id.startsWith("data-run_") &&
        candidate.scope === req.scope &&
        Array.isArray(candidate.evidence_refs) &&
        candidate.evidence_refs.length === 2 &&
        typeof candidate.created_at === "string" &&
        params.task_evidence?.substantial_task === true &&
        candidate.suggested_owner === "data" &&
        candidate.repeated_evidence === true &&
        candidate.current_truth === true &&
        candidate.structured_operational === true &&
        candidate.contains_secret === false &&
        candidate.privacy_ambiguous === false &&
        candidate.permission_expansion === false &&
        candidate.destructive === false;
      if (!trusted) {
        result = {
          status: "blocked",
          effect_occurred: false,
          result: { data_candidate: { state: "blocked", reason: "trusted binding missing" } }
        };
        break;
      }
      const record = candidate.record?.data;
      if (!record || record.email !== "alice@example.test") {
        result = {
          status: "blocked",
          effect_occurred: false,
          result: { data_candidate: { state: "blocked", reason: "record invalid" } }
        };
        break;
      }
      const prior = state.record ?? null;
      writeState({ record: { ...(prior ?? {}), ...record }, version: prior ? 2 : 1 });
      result = {
        status: "succeeded",
        effect_occurred: true,
        result: {
          data_candidate: { state: "admitted", suggested_owner: "data" },
          structure: {
            result: {
              state: prior ? "existing" : "created",
              changed: !prior,
              schema: { spaceId: "crm", entity: "contacts", schemaVersion: 1 }
            }
          },
          record: {
            state: prior ? "updated" : "created",
            owner_result: {
              recordId: "rec_fixture_alice",
              version: prior ? 2 : 1,
              data: { ...(prior ?? {}), ...record }
            }
          }
        },
        execution_binding: {
          request_fingerprint: req.request_fingerprint,
          scope: req.scope,
          action_class: req.action_class,
          operation: req.operation,
          space_id: "crm",
          entity: "contacts",
          match_field: "email"
        }
      };
    } else if (req.operation === "data.query") {
      const state = readState();
      const items = state.record ? [{
        spaceId: "crm",
        entity: "contacts",
        recordId: "rec_fixture_alice",
        schemaVersion: 1,
        version: state.version ?? 1,
        data: state.record
      }] : [];
      result = {
        status: "succeeded",
        effect_occurred: false,
        result: {
          data: { items, nextCursor: null, hasMore: false }
        },
        execution_binding: {
          request_fingerprint: req.request_fingerprint,
          scope: req.scope,
          action_class: req.action_class,
          operation: req.operation
        }
      };
    } else if (req.operation === "memory.session_digest") {
      result = {
        status: "succeeded",
        effect_occurred: true,
        result: {
          memory_session_digest: {
            state: "captured",
            digest_id: `digest-${req.parameters?.run_id ?? "fixture"}`
          }
        }
      };
    } else {
      result = { status: "failed", effect_occurred: false, result: { reason: "unsupported fixture action" } };
    }
    break;
  }
  default:
    process.stdout.write(JSON.stringify({
      protocol: input.protocol,
      request_id: input.request_id,
      ok: false,
      error: { message: "unsupported" }
    }));
    process.exit(0);
}

process.stdout.write(JSON.stringify({
  protocol: input.protocol,
  request_id: input.request_id,
  ok: true,
  result
}));

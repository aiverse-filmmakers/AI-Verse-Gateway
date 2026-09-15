#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const raw = await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
});
const input = JSON.parse(raw);
const p = input.payload ?? {};
const statePath = path.join(process.cwd(), ".fixture-migration-drop.json");

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { authorizations: [], actions: [] }; }
}
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

let result;
switch (input.operation) {
  case "describe":
    result = {
      adapter_id: "fixture:migration-drop-host",
      protocol_version: "1.0",
      operations: ["read_context", "retrieve_history", "list_capabilities", "list_connections", "authorize_action", "request_action"],
      metadata: { canonical_state_owned: false }
    };
    break;
  case "read_context":
    result = { scope: p.scope, current_context: "fresh fixture", direction_owner: "os", read_only: true };
    break;
  case "retrieve_history":
    result = [];
    break;
  case "list_capabilities":
  case "list_connections":
    result = [];
    break;
  case "authorize_action": {
    const req = p.request ?? {};
    const state = readState();
    state.authorizations.push({
      operation: req.operation,
      scope: req.scope,
      action_class: req.action_class,
      request_fingerprint: req.request_fingerprint
    });
    saveState(state);
    result = req.operation === "migration.import" &&
      req.action_class === "write_local_reversible" &&
      req.scope === "operator" &&
      /^[a-f0-9]{64}$/.test(String(req.request_fingerprint ?? ""))
      ? { decision: "allow", allowed: true }
      : { decision: "deny", allowed: false, reason: "unexpected migration request" };
    break;
  }
  case "request_action": {
    const req = p.request ?? {};
    const params = req.parameters ?? {};
    const source = params.source ?? {};
    const plan = params.plan ?? {};
    const state = readState();
    state.actions.push({
      operation: req.operation,
      scope: req.scope,
      action_class: req.action_class,
      source,
      plan
    });
    saveState(state);

    const valid =
      req.operation === "migration.import" &&
      req.scope === "operator" &&
      req.action_class === "write_local_reversible" &&
      Object.keys(params).sort().join(",") === "plan,source" &&
      source.kind === "gateway-user-message" &&
      typeof source.text === "string" &&
      source.text.length > 0 &&
      plan && typeof plan === "object" && !Array.isArray(plan);

    result = valid ? {
      status: "succeeded",
      effect_occurred: true,
      result: {
        migration_import: {
          schema_version: "1.0",
          source_sha256: "f".repeat(64),
          counts: {
            workspace_items: Array.isArray(plan.workspaces) ? plan.workspaces.length : 0,
            memory_items: Array.isArray(plan.memories) ? plan.memories.length : 0,
            data_items: Array.isArray(plan.data) ? plan.data.length : 0,
            effects: 2
          },
          replayed: false,
          raw_source_persisted: false
        }
      }
    } : {
      status: "blocked",
      effect_occurred: false,
      result: { migration_import: { reason: "Gateway did not bind trusted migration source" } }
    };
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

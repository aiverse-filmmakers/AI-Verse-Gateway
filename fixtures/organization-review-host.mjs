#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const statePath = path.join(process.cwd(), ".fixture-organization-review.json");
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { operations: [], by_idempotency: {}, digests: 0 }; }
};
const writeState = (value) => fs.writeFileSync(statePath, JSON.stringify(value, null, 2) + "\n");
const p = input.payload ?? {};
let result;

switch (input.operation) {
  case "describe":
    result = {
      adapter_id: "fixture:organization-review-host",
      protocol_version: "1.0",
      operations: ["read_context","retrieve_history","list_capabilities","list_connections","authorize_action","request_action"],
      metadata: { canonical_state_owned: false, organization_review: "available" }
    };
    break;
  case "read_context":
    result = { scope: p.scope, current_context: "organization review fixture", read_only: true };
    break;
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
    if (!/^[a-f0-9]{64}$/.test(String(req.request_fingerprint ?? ""))) {
      result = { decision: "deny", allowed: false, reason: "fingerprint required" };
    } else if (req.operation === "memory.capture") {
      result = { decision: "approval_required", approval_required: true, scope: req.scope, action_class: req.action_class };
    } else {
      result = { decision: "allow", allowed: true, scope: req.scope, action_class: req.action_class };
    }
    break;
  }
  case "request_action": {
    const req = p.request ?? {};
    const state = readState();

    if (req.operation === "memory.session_digest") {
      state.digests = Number(state.digests ?? 0) + 1;
      writeState(state);
      result = {
        status: "succeeded",
        effect_occurred: true,
        result: { memory_session_digest: { state: "captured", digest_id: "digest-organization-review" } }
      };
      break;
    }

    const allowed = ["workspace.ensure", "memory.capture", "skills.learning-candidate", "data.structured-truth"];
    if (!allowed.includes(req.operation)) {
      state.operations.push({ operation: req.operation, forbidden: true, idempotency_key: req.idempotency_key ?? null });
      writeState(state);
      result = { status: "failed", effect_occurred: false, result: { reason: "forbidden operation reached host" } };
      break;
    }

    const idem = String(req.idempotency_key ?? "");
    if (idem && state.by_idempotency[idem]) {
      result = state.by_idempotency[idem];
      break;
    }

    let ownerResult;
    if (req.operation === "workspace.ensure") {
      ownerResult = {
        status: "succeeded",
        effect_occurred: true,
        result: {
          workspace_organization: {
            state: "created",
            workspace: { id: "client-alpha", name: "Client Alpha" }
          }
        }
      };
    } else if (req.operation === "skills.learning-candidate") {
      const candidate = req.parameters?.candidate ?? {};
      const trusted = candidate.scope === "workspace:client-alpha" &&
        typeof candidate.candidate_id === "string" &&
        candidate.candidate_id.includes("organization-review") &&
        req.parameters?.task_evidence?.substantial_task === true;
      ownerResult = trusted ? {
        status: "succeeded",
        effect_occurred: true,
        result: { learning_candidate: { state: "admitted", suggested_owner: "skills" } }
      } : {
        status: "blocked",
        effect_occurred: false,
        result: { learning_candidate: { state: "blocked", reason: "trusted review binding missing" } }
      };
    } else if (req.operation === "data.structured-truth") {
      const candidate = req.parameters?.candidate ?? {};
      const trusted = candidate.scope === req.scope &&
        req.scope.startsWith("workspace:") &&
        typeof candidate.candidate_id === "string" &&
        candidate.candidate_id.includes("organization-review") &&
        req.parameters?.task_evidence?.substantial_task === true;
      ownerResult = trusted ? {
        status: "succeeded",
        effect_occurred: true,
        result: { data_candidate: { state: "admitted", suggested_owner: "data" } }
      } : {
        status: "blocked",
        effect_occurred: false,
        result: { data_candidate: { state: "blocked", reason: "trusted review binding missing" } }
      };
    } else {
      ownerResult = {
        status: "succeeded",
        effect_occurred: true,
        result: { memory_capture: { state: "captured" } }
      };
    }

    state.operations.push({
      operation: req.operation,
      scope: req.scope,
      action_class: req.action_class,
      idempotency_key: idem,
      request_fingerprint: req.request_fingerprint
    });
    if (idem) state.by_idempotency[idem] = ownerResult;
    writeState(state);
    result = ownerResult;
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

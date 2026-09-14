#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const statePath = path.join(process.cwd(), ".fixture-learned-skill.json");
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
      adapter_id: "fixture:persistent-learning-host",
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
        skills: "available",
        memory: "available"
      }
    };
    break;
  case "read_context":
    result = { scope: p.scope, current_context: "persistent learning fixture", read_only: true };
    break;
  case "retrieve_history":
    result = [];
    break;
  case "list_connections":
    result = [];
    break;
  case "list_capabilities": {
    const state = readState();
    result = state.learned ? [{
      id: "aiverse-skills:client-alpha-review",
      name: "client-alpha-review",
      description: "Reusable concise Client Alpha delivery review procedure",
      provider: "aiverse-skills",
      generation_id: state.generation_id,
      digest: {
        algorithm: "aiverse-package-sha256-v1",
        value: state.digest
      }
    }] : [];
    break;
  }
  case "authorize_action": {
    const req = p.request ?? {};
    result = /^[a-f0-9]{64}$/.test(String(req.request_fingerprint ?? ""))
      ? { decision: "allow", allowed: true }
      : { decision: "deny", allowed: false, reason: "request fingerprint required" };
    break;
  }
  case "request_action": {
    const req = p.request ?? {};
    const state = readState();
    if (req.operation === "skills.learning-candidate") {
      const params = req.parameters ?? {};
      if (params.task_evidence?.substantial_task !== true) {
        result = {
          status: "succeeded",
          effect_occurred: false,
          result: { learning_candidate: { state: "ignored", suggested_owner: "none" } }
        };
        break;
      }
      const generation_id = "gen-learned-fixture-1";
      const digest = "a".repeat(64);
      writeState({
        ...state,
        learned: true,
        generation_id,
        digest,
        instructions: "Review the delivery against the brief, keep notes concise, verify completion, and preserve a short evidence-backed handoff."
      });
      result = {
        status: "succeeded",
        effect_occurred: true,
        result: {
          learning_candidate: { state: "admitted", suggested_owner: "skills" },
          skills_submission: { proposal_id: params.candidate?.candidate_id, state: "proposal" },
          skills_result: {
            proposal_id: params.candidate?.candidate_id,
            state: "applied",
            approved_by: "policy:auto",
            applied_generation_id: generation_id
          },
          idempotent_replay: false
        },
        execution_binding: {
          request_fingerprint: req.request_fingerprint,
          scope: req.scope,
          action_class: req.action_class,
          operation: req.operation,
          proposal_id: params.candidate?.candidate_id,
          proposal_state: "applied"
        }
      };
    } else if (req.operation === "capability.read_instructions") {
      const params = req.parameters ?? {};
      const valid = state.learned
        && params.capability_id === "aiverse-skills:client-alpha-review"
        && params.expected_generation_id === state.generation_id
        && params.expected_package_digest?.algorithm === "aiverse-package-sha256-v1"
        && params.expected_package_digest?.value === state.digest;
      if (!valid) {
        result = { status: "failed", effect_occurred: false, result: { reason: "generation binding mismatch" } };
        break;
      }
      result = {
        status: "succeeded",
        effect_occurred: false,
        result: {
          instructions: state.instructions,
          receipt: {
            contract: "aiverse-execution-receipt-v2",
            receipt_id: "receipt-later-use",
            status: "success",
            binding: {
              request_fingerprint: req.request_fingerprint,
              scope: req.scope,
              action_class: req.action_class,
              operation: req.operation,
              provider_id: "aiverse-skills",
              capability_id: params.capability_id,
              generation_id: state.generation_id,
              package_digest: params.expected_package_digest
            }
          }
        },
        execution_binding: {
          request_fingerprint: req.request_fingerprint,
          scope: req.scope,
          action_class: req.action_class,
          operation: req.operation,
          provider_id: "aiverse-skills",
          capability_id: params.capability_id,
          generation_id: state.generation_id,
          package_digest: params.expected_package_digest
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
      result = { status: "succeeded", effect_occurred: false, result: { fixture: true } };
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

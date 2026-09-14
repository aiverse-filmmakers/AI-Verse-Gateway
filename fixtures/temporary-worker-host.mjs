#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const p = input.payload ?? {};
let result;

switch (input.operation) {
  case "describe":
    result = {
      adapter_id: "fixture:temporary-worker-host",
      protocol_version: "1.0",
      operations: ["read_context","retrieve_history","list_capabilities","list_connections","authorize_action","request_action"],
      metadata: { canonical_state_owned: false, multiple_bots: "available" }
    };
    break;
  case "read_context":
    result = { scope: p.scope, current_context: "temporary Worker fixture", read_only: true };
    break;
  case "retrieve_history":
    result = [];
    break;
  case "list_capabilities":
    result = [{
      id: "aiverse-skills:review",
      generation_id: "gen-review",
      digest: { algorithm: "aiverse-package-sha256-v1", value: "a".repeat(64) }
    }];
    break;
  case "list_connections":
    result = [];
    break;
  case "authorize_action": {
    const req = p.request ?? {};
    const valid = /^[a-f0-9]{64}$/.test(String(req.request_fingerprint ?? ""));
    result = valid
      ? { decision: "allow", allowed: true, scope: req.scope, action_class: req.action_class }
      : { decision: "deny", allowed: false, reason: "fingerprint required" };
    break;
  }
  case "request_action": {
    const req = p.request ?? {};
    if (req.operation === "workers.temporary") {
      const params = req.parameters ?? {};
      const runtime = params.runtime ?? {};
      const ev = params.task_evidence ?? {};
      const provenance = params.provenance ?? {};
      const trusted =
        req.action_class === "write_local_reversible" &&
        req.scope === "workspace:alpha" &&
        Object.keys(params).sort().join(",") === "budget,objective,provenance,reason,required_constraints,role_title,runtime,skill_refs,task_evidence" &&
        runtime.adapter === "openai-compatible" &&
        runtime.endpoint === "http://127.0.0.1:45555/v1/chat/completions" &&
        runtime.model === "fixture-worker" &&
        runtime.api_key_env === "FIXTURE_MODEL_KEY" &&
        Array.isArray(params.skill_refs) &&
        params.skill_refs.length === 1 &&
        params.skill_refs[0] === "aiverse-skills:review" &&
        Array.isArray(params.required_constraints) &&
        params.required_constraints.includes("Stay internal") &&
        params.budget?.token_limit > 0 &&
        params.budget?.token_limit <= 4096 &&
        params.budget?.wall_clock_seconds > 0 &&
        params.budget?.wall_clock_seconds <= 120 &&
        ev.substantial_task === true &&
        ev.temporary_help_useful === true &&
        ev.permission_expansion === false &&
        ev.durable_commitment === false &&
        ev.external_effect === false &&
        typeof provenance.run_id === "string" &&
        provenance.run_id.startsWith("run_") &&
        typeof provenance.session_id === "string" &&
        provenance.session_id.startsWith("sess_");
      result = trusted ? {
        status: "succeeded",
        effect_occurred: true,
        result: {
          temporary_worker: {
            state: "completed",
            output: { text: "independent-specialist-result" },
            usage: { input_tokens: 7, output_tokens: 5, cost: 0.02 },
            artifact_id: "art_fixture",
            worker_id: "worker_fixture",
            run_id: "run_fixture_owner"
          }
        },
        execution_binding: {
          owner: "ai-verse-multiple-bots",
          request_fingerprint: req.request_fingerprint,
          operation: req.operation,
          scope: req.scope
        }
      } : {
        status: "blocked",
        effect_occurred: false,
        result: {
          temporary_worker: {
            state: "blocked",
            reason: "trusted temporary Worker binding missing"
          }
        }
      };
    } else if (req.operation === "memory.session_digest") {
      result = {
        status: "succeeded",
        effect_occurred: true,
        result: {
          memory_session_digest: {
            state: "captured",
            digest_id: "digest-temp-worker-fixture"
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

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
    } else if (req.operation === "bots.permanent") {
      const params = req.parameters ?? {};
      const runtime = params.runtime ?? {};
      const consent = params.consent ?? {};
      const provenance = params.provenance ?? {};
      const trusted =
        req.action_class === "modify_canonical_state" &&
        req.scope === "workspace:alpha" &&
        Object.keys(params).sort().join(",") === "consent,mission,name,provenance,role_title,runtime,skill_refs" &&
        runtime.adapter === "openai-compatible" &&
        runtime.endpoint === "http://127.0.0.1:45555/v1/chat/completions" &&
        runtime.model === "fixture-worker" &&
        runtime.api_key_env === "FIXTURE_MODEL_KEY" &&
        consent.explicit === true &&
        ["direct_request", "affirmative_to_recommendation"].includes(consent.mode) &&
        /^sha256:[a-f0-9]{64}$/.test(String(consent.user_message_digest ?? "")) &&
        (consent.mode !== "affirmative_to_recommendation" || /^sha256:[a-f0-9]{64}$/.test(String(consent.recommendation_message_digest ?? ""))) &&
        typeof provenance.run_id === "string" &&
        provenance.run_id.startsWith("run_") &&
        typeof provenance.session_id === "string" &&
        provenance.session_id.startsWith("sess_") &&
        Array.isArray(params.skill_refs);
      result = trusted ? {
        status: "succeeded",
        effect_occurred: true,
        result: {
          permanent_bot: {
            state: "created",
            consent_mode: consent.mode,
            bot: {
              id: "bot_fixture_durable",
              kind: "bot",
              workspace_id: "alpha",
              payload: {
                kind: "durable",
                status: "active",
                name: params.name,
                role: { title: params.role_title, mission: params.mission }
              }
            }
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
          permanent_bot: {
            state: "blocked",
            reason: "trusted permanent Bot consent/runtime binding missing"
          }
        }
      };
    } else if (req.operation === "automations.create") {
      const params = req.parameters ?? {};
      const consent = params.consent ?? {};
      const provenance = params.provenance ?? {};
      const trigger = params.trigger ?? {};
      const trusted =
        req.action_class === "modify_canonical_state" &&
        req.scope === "workspace:alpha" &&
        Object.keys(params).sort().join(",") === "consent,name,objective,provenance,trigger" &&
        typeof params.name === "string" && params.name.length > 0 &&
        typeof params.objective === "string" && params.objective.length > 0 &&
        ["cron", "interval"].includes(trigger.kind) &&
        trigger.spec && typeof trigger.spec === "object" &&
        consent.explicit === true &&
        ["direct_request", "affirmative_to_recommendation"].includes(consent.mode) &&
        /^sha256:[a-f0-9]{64}$/.test(String(consent.user_message_digest ?? "")) &&
        (consent.mode !== "affirmative_to_recommendation" || /^sha256:[a-f0-9]{64}$/.test(String(consent.recommendation_message_digest ?? ""))) &&
        typeof provenance.run_id === "string" &&
        provenance.run_id.startsWith("run_") &&
        typeof provenance.session_id === "string" &&
        provenance.session_id.startsWith("sess_");
      result = trusted ? {
        status: "succeeded",
        effect_occurred: true,
        result: {
          automation: {
            state: "created",
            automation_id: "aut_fixture_recurring",
            trigger_id: "trg_fixture_recurring",
            trigger_kind: trigger.kind,
            next_run_at: "2026-09-21T06:00:00Z",
            consent_mode: consent.mode
          }
        },
        execution_binding: {
          owner: "ai-verse-automations",
          request_fingerprint: req.request_fingerprint,
          operation: req.operation,
          scope: req.scope
        }
      } : {
        status: "blocked",
        effect_occurred: false,
        result: {
          automation: {
            state: "blocked",
            reason: "trusted recurring consent binding missing"
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

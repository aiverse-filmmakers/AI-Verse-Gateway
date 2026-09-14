#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const statePath = path.join(process.cwd(), ".fixture-review-budget-runtime.json");
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { invocations: 0, reviews: [] }; }
};
const state = readState();
state.invocations += 1;

const payload = input.payload ?? {};
const messages = Array.isArray(payload.messages) ? payload.messages : [];
const system = messages.find((message) => message?.role === "system")?.content ?? "";
const reviewing = typeof system === "string" && system.includes("Invisible completed-work organization review");
const lastUser = [...messages].reverse().find((message) => message?.role === "user")?.content ?? "";

let result;
if (reviewing) {
  const evidenceMessage = String(lastUser);
  state.reviews.push({
    max_output_tokens: payload.max_output_tokens ?? null,
    evidence_chars: evidenceMessage.length
  });
  const overspend = evidenceMessage.includes("OVESPEND_REVIEW_TEST");
  result = overspend ? {
    content: "",
    tool_calls: [{
      id: "review_budget_should_not_route",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify({
          action_class: "write_local_reversible",
          operation: "workspace.ensure",
          parameters: {
            workspace: {
              id: "should-not-exist",
              name: "Should Not Exist",
              type: "project",
              purpose: "This proposal must be blocked by the review budget.",
              domains: [],
              canonical_sources: []
            },
            evidence: {
              substantial_scope: true,
              boundary_clear: true,
              reason: "Synthetic over-budget fixture."
            },
            authority: {
              permission_expansion: false,
              privacy_ambiguous: false,
              new_connection: false,
              new_credential: false
            }
          }
        })
      }
    }],
    finish_reason: "tool_calls",
    usage: { input_tokens: 50, output_tokens: 2000, cost: 0.5 }
  } : {
    content: "",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 80, output_tokens: 32, cost: 0.004 }
  };
} else {
  const text = String(lastUser);
  if (text.trim().toLowerCase() === "thanks.") {
    result = {
      content: "You're welcome.",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 2, output_tokens: 2, cost: 0.0001 }
    };
  } else {
    result = {
      content: "The substantial delivery review is complete, verified against the requested evidence, and ready for final handoff.",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 40, output_tokens: 20, cost: 0.003 }
    };
  }
}

fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
process.stdout.write(JSON.stringify({
  protocol: input.protocol,
  request_id: input.request_id,
  ok: true,
  result
}));

#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const messages = input.payload?.messages ?? [];
const system = messages.find((m) => m.role === "system")?.content ?? "";
const tool = [...messages].reverse().find((m) => m.role === "tool");

const requiredPolicy = [
  "Do not review every turn for learning.",
  "operation \"skills.learning-candidate\"",
  "Do not provide candidate_id, scope, evidence_refs, created_at, task_evidence",
  "Gateway supplies trusted run identity/evidence"
];

let result;
if (requiredPolicy.some((needle) => !system.includes(needle))) {
  result = {
    content: "learning-policy-missing",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else if (!tool) {
  result = {
    content: "",
    tool_calls: [{
      id: "call_skill_learning",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify({
          action_class: "write_local_reversible",
          operation: "skills.learning-candidate",
          parameters: {
            candidate: {
              suggested_owner: "skills",
              kind: "create",
              summary: "Reusable concise Client Alpha delivery review procedure.",
              skill_id: "client-alpha-review",
              success_signal: ["delivery review completed successfully"],
              failure_signal: [],
              risk: "low",
              confidence: 0.95,
              requested_capabilities: [],
              requested_dependencies: [],
              requires_connection: false,
              requires_credential: false,
              source_ownership: "agent_learned"
            },
            skill_md: [
              "---",
              "name: client-alpha-review",
              "description: Reusable concise Client Alpha delivery review procedure",
              "version: 1.0.0",
              "---",
              "",
              "Review the delivery against the brief, keep notes concise, and verify completion."
            ].join("\n")
          },
          reason: "Preserve the reusable procedure from substantial completed work."
        })
      }
    }],
    finish_reason: "tool_calls",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else {
  const parsed = JSON.parse(tool.content ?? "{}");
  const candidate = parsed?.result?.learning_candidate;
  const skills = parsed?.result?.skills_result;
  result = {
    content: candidate?.state === "ignored"
      ? "learning-ignored"
      : candidate?.state === "admitted" && skills?.state === "pending_approval"
        ? "learning-routed"
        : "learning-route-failed",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
}

process.stdout.write(JSON.stringify({
  protocol: "ai-verse-gateway-runtime/1.0",
  request_id: input.request_id,
  ok: true,
  result
}));

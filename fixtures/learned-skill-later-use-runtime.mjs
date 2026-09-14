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
const learned = system.match(
  /"id":"aiverse-skills:client-alpha-review"[\s\S]*?"generation_id":"([^"]+)"[\s\S]*?"digest":\{"algorithm":"aiverse-package-sha256-v1","value":"([a-f0-9]{64})"\}/
);

let result;
if (tool) {
  const parsed = JSON.parse(tool.content ?? "{}");
  if (parsed?.result?.instructions) {
    const receipt = parsed?.result?.receipt;
    const binding = receipt?.binding ?? {};
    result = {
      content: binding.capability_id === "aiverse-skills:client-alpha-review"
        && binding.generation_id === "gen-learned-fixture-1"
        && parsed.result.instructions.includes("keep notes concise")
        ? "learned-skill-used"
        : "learned-skill-use-failed",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  } else if (parsed?.result?.skills_result?.state === "applied") {
    result = {
      content: "learned-first-run",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  } else {
    result = {
      content: "unexpected-tool-result",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  }
} else if (learned) {
  const [, generationId, digest] = learned;
  result = {
    content: "",
    tool_calls: [{
      id: "call_learned_skill_use",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify({
          action_class: "read_local",
          operation: "capability.read_instructions",
          parameters: {
            capability_id: "aiverse-skills:client-alpha-review",
            expected_generation_id: generationId,
            expected_package_digest: {
              algorithm: "aiverse-package-sha256-v1",
              value: digest
            }
          },
          reason: "Use the persisted learned capability selected from current owner context."
        })
      }
    }],
    finish_reason: "tool_calls",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else {
  result = {
    content: "",
    tool_calls: [{
      id: "call_learn_skill",
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
              "Review the delivery against the brief, keep notes concise, verify completion, and preserve a short evidence-backed handoff."
            ].join("\n")
          },
          reason: "Preserve the reusable procedure proven by this substantial completed work."
        })
      }
    }],
    finish_reason: "tool_calls",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
}

process.stdout.write(JSON.stringify({
  protocol: "ai-verse-gateway-runtime/1.0",
  request_id: input.request_id,
  ok: true,
  result
}));

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
  "Do not persist every turn.",
  "Never use automatic Memory capture for current state",
  "Do not provide source, evidence_refs, effect_id, scope, or workspace.",
  "Gateway supplies trusted run provenance/retry identity"
];

let result;
if (requiredPolicy.some((needle) => !system.includes(needle))) {
  result = {
    content: "memory-policy-missing",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else if (!tool) {
  result = {
    content: "",
    tool_calls: [{
      id: "call_memory_capture",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify({
          action_class: "write_local_reversible",
          operation: "memory.capture",
          parameters: {
            text: "Client Alpha delivery reviews worked better when the notes stayed concise.",
            type: "lesson",
            importance: 4,
            confidence: 0.95,
            why: "This historical pattern is likely to matter on later delivery work.",
            tags: "delivery,review",
            admission: {
              durable: true,
              historical: true,
              current_truth: false,
              contains_secret: false,
              strategic: false,
              permission_expansion: false,
              privacy_ambiguous: false,
              external_authority: false
            }
          },
          reason: "Capture a high-confidence durable historical lesson."
        })
      }
    }],
    finish_reason: "tool_calls",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else {
  const parsed = JSON.parse(tool.content ?? "{}");
  const capture = parsed?.result?.memory_capture;
  result = {
    content: capture?.state === "captured" ? "memory-captured" : "memory-capture-failed",
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

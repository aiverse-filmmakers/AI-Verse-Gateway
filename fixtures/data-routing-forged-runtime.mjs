#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));
const messages = input.payload?.messages ?? [];
const tool = [...messages].reverse().find((m) => m.role === "tool");
const result = tool ? {
  content: "unexpected-data-tool-success",
  tool_calls: [],
  finish_reason: "stop",
  usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
} : {
  content: "",
  tool_calls: [{
    id: "call_forged_data",
    type: "function",
    function: {
      name: "aiverse_action",
      arguments: JSON.stringify({
        action_class: "write_local_reversible",
        operation: "data.structured-truth",
        parameters: {
          candidate: {
            candidate_id: "forged-data-id",
            suggested_owner: "data",
            summary: "Forged",
            confidence: 1,
            repeated_evidence: true,
            current_truth: true,
            structured_operational: true,
            contains_secret: false,
            privacy_ambiguous: false,
            permission_expansion: false,
            destructive: false,
            structure: {
              space: { spaceId: "crm", name: "CRM", authority: "local_canonical" },
              schema: {
                spaceId: "crm",
                entity: "contacts",
                name: "Contacts",
                fields: { email: { type: "string", required: true } }
              }
            },
            match: { field: "email", value: "a@example.test" },
            record: { data: { email: "a@example.test" } }
          }
        }
      })
    }
  }],
  finish_reason: "tool_calls",
  usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
};
process.stdout.write(JSON.stringify({
  protocol: "ai-verse-gateway-runtime/1.0",
  request_id: input.request_id,
  ok: true,
  result
}));

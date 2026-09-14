#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const messages = input.payload?.messages ?? [];
const system = messages.find((m) => m.role === "system")?.content ?? "";
const hasTool = messages.some((m) => m.role === "tool");

let result;
if (system.includes('"scope":"workspace:client-alpha"')) {
  result = {
    content: "workspace-bound",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else if (!hasTool) {
  result = {
    content: "",
    tool_calls: [{
      id: "call_workspace",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify({
          action_class: "write_local_reversible",
          operation: "workspace.ensure",
          parameters: {
            workspace: {
              id: "client-alpha",
              name: "Client Alpha",
              type: "client",
              purpose: "Keep repeated Client Alpha work isolated.",
              domains: ["delivery"],
              canonical_sources: []
            },
            evidence: {
              substantial_scope: true,
              boundary_clear: true,
              reason: "Repeated meaningful Client Alpha work established a clear durable scope."
            },
            authority: {
              permission_expansion: false,
              privacy_ambiguous: false,
              new_connection: false,
              new_credential: false
            }
          },
          reason: "Organize a clear substantial client scope without asking a technical question."
        })
      }
    }],
    finish_reason: "tool_calls",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else {
  const tool = messages.find((m) => m.role === "tool");
  const parsed = tool?.content ? JSON.parse(tool.content) : {};
  const organization = parsed?.result?.workspace_organization;
  result = {
    content: organization?.workspace?.id === "client-alpha" ? "workspace-organized" : "workspace-routing-failed",
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

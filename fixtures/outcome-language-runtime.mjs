#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

if (input.operation !== "invoke") {
  process.stdout.write(JSON.stringify({
    protocol: input.protocol,
    request_id: input.request_id,
    ok: false,
    error: { message: "unsupported" }
  }));
  process.exit(0);
}

const payload = input.payload ?? {};
const messages = Array.isArray(payload.messages) ? payload.messages : [];
const hasToolResult = messages.some((message) => message?.role === "tool");

const call = {
  id: "outcome_language_workspace",
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
          purpose: "Keep Client Alpha delivery work organized.",
          domains: ["delivery"],
          canonical_sources: []
        },
        evidence: {
          substantial_scope: true,
          boundary_clear: true,
          reason: "The request clearly identifies an ongoing client scope."
        },
        authority: {
          permission_expansion: false,
          privacy_ambiguous: false,
          new_connection: false,
          new_credential: false
        }
      },
      reason: "Organize this ongoing client work safely."
    })
  }
};

const result = hasToolResult ? {
  content: "AI-Verse Gateway used workspace.ensure through the canonical owner. The AI-Verse OS canonical state is updated. execution_binding and workspace_organization remain available in the technical receipt.",
  tool_calls: [],
  finish_reason: "stop",
  usage: { input_tokens: 20, output_tokens: 16, cost: 0.001 }
} : {
  content: "AI-Verse Gateway is invoking workspace.ensure through the canonical owner while preserving the canonical state.",
  tool_calls: [call],
  finish_reason: "tool_calls",
  usage: { input_tokens: 18, output_tokens: 12, cost: 0.001 }
};

process.stdout.write(JSON.stringify({
  protocol: input.protocol,
  request_id: input.request_id,
  ok: true,
  result
}));

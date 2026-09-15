#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const messages = input.payload?.messages ?? [];
const system = messages.find((m) => m.role === "system")?.content ?? "";
const userMessages = messages.filter((m) => m.role === "user");
const latestUser = userMessages.at(-1)?.content ?? "";
const hasTool = messages.some((m) => m.role === "tool");

let result;
if (latestUser.includes("Completed-work evidence:")) {
  result = {
    content: "",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else if (!system.includes("Migration and prior-assistant context drops:")) {
  result = {
    content: "migration-policy-missing",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else if (!hasTool) {
  const plan = {
    workspaces: [{
      workspace: {
        id: "client-alpha",
        name: "Client Alpha",
        type: "client",
        purpose: "Imported durable client scope."
      },
      evidence: {
        substantial_scope: true,
        boundary_clear: true,
        reason: "The migration source clearly describes an ongoing named client."
      },
      authority: {
        permission_expansion: false,
        privacy_ambiguous: false,
        new_connection: false,
        new_credential: false
      }
    }],
    memories: [{
      scope: "workspace:client-alpha",
      type: "lesson",
      text: "Verify captions before export.",
      confidence: 0.95,
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
    }],
    data: []
  };
  const args = latestUser.includes("FORGED_SOURCE")
    ? {
        action_class: "write_local_reversible",
        operation: "migration.import",
        parameters: {
          source: { kind: "forged", text: "forged source" },
          plan
        }
      }
    : {
        action_class: "write_local_reversible",
        operation: "migration.import",
        parameters: { plan }
      };
  result = {
    content: "",
    tool_calls: [{
      id: "call_migration_import",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify(args)
      }
    }],
    finish_reason: "tool_calls",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  };
} else {
  const tool = messages.find((m) => m.role === "tool");
  const parsed = tool?.content ? JSON.parse(tool.content) : {};
  result = {
    content: parsed?.result?.migration_import ? "migration-imported" : "migration-import-failed",
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

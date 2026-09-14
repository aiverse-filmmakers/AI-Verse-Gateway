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
const hasContacts = system.includes('"entity":"contacts"');
let result;

if (tool) {
  const parsed = JSON.parse(tool.content ?? "{}");
  if (parsed?.result?.data?.items) {
    const alice = parsed.result.data.items.find((row) => row?.data?.email === "alice@example.test");
    result = {
      content: alice?.data?.status === "active" ? "canonical-data-read" : "canonical-data-read-failed",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  } else if (parsed?.result?.data_candidate?.state === "ignored") {
    result = {
      content: "data-organization-ignored",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  } else if (parsed?.result?.data_candidate?.state === "admitted") {
    result = {
      content: "structured-data-organized",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  } else {
    result = {
      content: "unexpected-data-result",
      tool_calls: [],
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  }
} else if (hasContacts) {
  result = {
    content: "",
    tool_calls: [{
      id: "call_data_query",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify({
          action_class: "read_local",
          operation: "data.query",
          parameters: {
            spaceId: "crm",
            entity: "contacts",
            where: {
              field: "email",
              op: "eq",
              value: "alice@example.test"
            },
            limit: 2
          },
          reason: "Read the current canonical contact status."
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
      id: "call_data_organize",
      type: "function",
      function: {
        name: "aiverse_action",
        arguments: JSON.stringify({
          action_class: "write_local_reversible",
          operation: "data.structured-truth",
          parameters: {
            candidate: {
              suggested_owner: "data",
              summary: "Repeated Client Alpha contact status is structured current operational truth.",
              confidence: 0.95,
              repeated_evidence: true,
              current_truth: true,
              structured_operational: true,
              contains_secret: false,
              privacy_ambiguous: false,
              permission_expansion: false,
              destructive: false,
              structure: {
                space: {
                  spaceId: "crm",
                  name: "CRM",
                  authority: "local_canonical"
                },
                schema: {
                  spaceId: "crm",
                  entity: "contacts",
                  name: "Contacts",
                  fields: {
                    email: { type: "string", required: true },
                    name: { type: "string" },
                    status: {
                      type: "enum",
                      values: ["lead", "active", "inactive"],
                      default: "lead"
                    }
                  }
                }
              },
              match: {
                field: "email",
                value: "alice@example.test"
              },
              record: {
                data: {
                  email: "alice@example.test",
                  name: "Alice",
                  status: "active"
                }
              }
            }
          },
          reason: "Organize repeated structured current truth without asking the user about backend storage."
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

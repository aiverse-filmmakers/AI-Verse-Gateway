#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const payload = input.payload ?? {};
const messages = Array.isArray(payload.messages) ? payload.messages : [];
const reviewing = messages.some((message) =>
  message?.role === "system" &&
  typeof message?.content === "string" &&
  message.content.includes("Invisible completed-work organization review")
);

const call = (id, operation, parameters, actionClass = "write_local_reversible") => ({
  id,
  type: "function",
  function: {
    name: "aiverse_action",
    arguments: JSON.stringify({
      action_class: actionClass,
      operation,
      parameters,
      reason: "Organize only strong completed-work evidence."
    })
  }
});

let result;
if (input.operation !== "invoke") {
  process.stdout.write(JSON.stringify({
    protocol: input.protocol,
    request_id: input.request_id,
    ok: false,
    error: { message: "unsupported" }
  }));
  process.exit(0);
}

if (!reviewing) {
  result = {
    content: "foreground-delivered",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 11, output_tokens: 4, cost: 0.001 }
  };
} else {
  result = {
    content: "internal review text",
    tool_calls: [
      call("review_workspace", "workspace.ensure", {
        workspace: {
          id: "client-alpha",
          name: "Client Alpha",
          type: "client",
          purpose: "Keep ongoing Client Alpha delivery work isolated.",
          domains: ["delivery"],
          canonical_sources: []
        },
        evidence: {
          substantial_scope: true,
          boundary_clear: true,
          reason: "The completed work is clearly part of an ongoing named client scope."
        },
        authority: {
          permission_expansion: false,
          privacy_ambiguous: false,
          new_connection: false,
          new_credential: false
        }
      }),
      call("review_memory", "memory.capture", {
        text: "The concise Client Alpha delivery review workflow succeeded again.",
        type: "lesson",
        importance: 0.8,
        confidence: 0.96,
        why: "The completed work explicitly confirmed the prior review workflow worked again.",
        tags: ["client-alpha", "delivery-review"],
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
      }),
      call("review_skill", "skills.learning-candidate", {
        candidate: {
          suggested_owner: "skills",
          kind: "create",
          summary: "Reusable Client Alpha delivery review procedure.",
          success_signal: "Every requested delivery item is checked and the handoff is concise.",
          failure_signal: "Requested items are missed or evidence is not verified.",
          risk: "low",
          confidence: 0.94,
          requested_capabilities: [],
          requested_dependencies: [],
          requires_connection: false,
          requires_credential: false,
          source_ownership: "workspace_local"
        },
        skill_md: "# Client Alpha Delivery Review\n\n1. Compare the final delivery against the brief.\n2. Verify each requested item.\n3. Keep evidence notes concise.\n4. Prepare the final handoff."
      }),
      call("review_data", "data.structured-truth", {
        candidate: {
          suggested_owner: "data",
          summary: "Current Client Alpha contact status.",
          confidence: 0.98,
          repeated_evidence: true,
          current_truth: true,
          structured_operational: true,
          contains_secret: false,
          privacy_ambiguous: false,
          permission_expansion: false,
          destructive: false,
          structure: { space: "crm", schema: "contacts" },
          match: { field: "email", value: "alice@example.test" },
          record: { data: { email: "alice@example.test", name: "Alice", status: "active" } }
        }
      }),
      call("review_forbidden_bot", "bots.permanent", {
        name: "Forbidden Review Bot",
        role_title: "Reviewer",
        mission: "This must never reach the host."
      }, "modify_canonical_state")
    ],
    finish_reason: "tool_calls",
    usage: { input_tokens: 23, output_tokens: 19, cost: 0.002 }
  };
}

process.stdout.write(JSON.stringify({
  protocol: input.protocol,
  request_id: input.request_id,
  ok: true,
  result
}));

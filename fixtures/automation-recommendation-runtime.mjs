#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const messages = input.payload?.messages ?? [];
const system = messages.find((m) => m.role === "system")?.content ?? "";
const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
const required = [
  "Recurring responsibility recommendation:",
  "Recommendation alone is advisory.",
  "do not call aiverse_action",
  "explicit user consent",
  "I can handle this every Monday for you if you want.",
  "Do not mention Automation, scheduler, cron, trigger, job"
];
const missing = required.filter((needle) => !system.includes(needle));

let content;
if (missing.length) {
  content = `missing-recurring-policy:${missing.join("|")}`;
} else if (/every\s+monday|each\s+monday|every\s+week/i.test(String(lastUser))) {
  content = "I can handle this every Monday for you if you want.";
} else {
  content = "I’ll keep this as a one-off and just handle the current task.";
}

process.stdout.write(JSON.stringify({
  protocol: "ai-verse-gateway-runtime/1.0",
  request_id: input.request_id,
  ok: true,
  result: {
    content,
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
  }
}));

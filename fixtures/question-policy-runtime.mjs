#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
}));

const messages = input.payload?.messages ?? [];
const system = messages.find((m) => m.role === "system")?.content ?? "";
const required = [
  "Do the user's requested work before asking optional setup or architecture questions.",
  "Do not ask the user to choose internal architecture",
  "act instead of asking",
  "new recurring responsibility, durable Bot, credential or Connection",
  "do not ask a redundant technical confirmation",
  "Deterministic host authorization and owner security rules remain stronger"
];
const missing = required.filter((needle) => !system.includes(needle));
const result = {
  content: missing.length ? `missing-policy:${missing.join("|")}` : "question-policy-ok",
  tool_calls: [],
  finish_reason: "stop",
  usage: { input_tokens: 1, output_tokens: 1, cost: 0 }
};
process.stdout.write(JSON.stringify({
  protocol: "ai-verse-gateway-runtime/1.0",
  request_id: input.request_id,
  ok: true,
  result
}));

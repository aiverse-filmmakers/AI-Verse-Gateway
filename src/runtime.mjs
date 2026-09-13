import { GatewayError } from "./errors.mjs";
import { jsonSubprocess } from "./subprocess.mjs";

export class RuntimeRegistry {
  constructor(config) { this.config = config; }
  async invoke(input, signal) {
    switch (this.config.kind) {
      case "deterministic": return deterministic(input);
      case "openai-compatible": return openAICompatible(this.config, input, signal);
      case "json-subprocess": return jsonSubprocessRuntime(this.config, input, signal);
      default: throw new GatewayError("RUNTIME_UNSUPPORTED", `Unsupported runtime kind ${this.config.kind}`, 500);
    }
  }
}
function deterministic(input) {
  const last = [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const content = `AI-Verse Gateway deterministic response: ${typeof last === "string" ? last : JSON.stringify(last)}`;
  return { content, tool_calls: [], finish_reason: "stop", usage: { input_tokens: 0, output_tokens: 0, cost: 0 } };
}
async function openAICompatible(config, input, signal) {
  const base = String(config.base_url || "").replace(/\/$/, "");
  if (!base) throw new GatewayError("RUNTIME_CONFIG_INVALID", "openai-compatible runtime needs base_url", 500);
  const headers = { "content-type": "application/json" };
  if (config.api_key_env) {
    const secret = process.env[config.api_key_env];
    if (!secret) throw new GatewayError("RUNTIME_CREDENTIAL_MISSING", `Runtime credential environment variable ${config.api_key_env} is not set`, 503);
    headers.authorization = `Bearer ${secret}`;
  }
  const body = { model: input.model || config.model, messages: input.messages, stream: false, ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {}) };
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!response.ok) throw new GatewayError("RUNTIME_UPSTREAM_ERROR", `Runtime upstream returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`, 502);
  const out = await response.json();
  const msg = out?.choices?.[0]?.message ?? {};
  return { content: msg.content ?? "", tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [], finish_reason: out?.choices?.[0]?.finish_reason ?? "stop", usage: { input_tokens: Number(out?.usage?.prompt_tokens ?? 0), output_tokens: Number(out?.usage?.completion_tokens ?? 0), cost: Number(out?.usage?.cost ?? 0) } };
}
async function jsonSubprocessRuntime(config, input, signal) {
  const envelope = await jsonSubprocess({ ...config, transport: "json-subprocess", command: config.command }, { protocol: "ai-verse-gateway-runtime/1.0", request_id: input.run_id, operation: "invoke", payload: input }, signal);
  if (envelope?.ok !== true) throw new GatewayError("RUNTIME_REJECTED", String(envelope?.error?.message ?? "Runtime rejected request"), 502);
  return envelope.result;
}

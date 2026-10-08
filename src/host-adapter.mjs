import path from "node:path";
import { HOST_PROTOCOL } from "./constants.mjs";
import { jsonSubprocess } from "./subprocess.mjs";
import { id, readJson } from "./util.mjs";
import { GatewayError } from "./errors.mjs";
import { PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES } from "./purpose-runtime-policy.mjs";

const PURPOSE_SCOPE = /^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$/;

function purposeRoot(config) {
  if (typeof config?.cwd === "string" && config.cwd.trim()) return path.resolve(config.cwd);
  const command = Array.isArray(config?.command) ? config.command : [];
  const index = command.indexOf("--root");
  if (index >= 0 && typeof command[index + 1] === "string" && command[index + 1].trim()) {
    return path.resolve(command[index + 1]);
  }
  throw new GatewayError("PURPOSE_OWNER_UNAVAILABLE", "OS host config does not expose a canonical system root", 409);
}

export class HostClient {
  constructor(configPath) { this.configPath = configPath; }
  async call(operation, payload, signal) {
    const config = await readJson(this.configPath);
    const request = { protocol: HOST_PROTOCOL, request_id: id("host"), operation, payload };
    const envelope = await jsonSubprocess(config, request, signal);
    if (envelope?.protocol !== HOST_PROTOCOL || envelope?.request_id !== request.request_id) throw new GatewayError("HOST_PROTOCOL_MISMATCH", "OS host adapter returned a mismatched envelope", 502);
    if (envelope.ok !== true) throw new GatewayError("HOST_REJECTED", String(envelope?.error?.message ?? "Host rejected request"), 502);
    return envelope.result;
  }
  describe(signal) { return this.call("describe", {}, signal); }
  readContext(scope, signal) { return this.call("read_context", { scope }, signal); }
  async readPurposeContext(scope, signal) {
    if (typeof scope !== "string" || !PURPOSE_SCOPE.test(scope)) {
      throw new GatewayError("PURPOSE_SCOPE_INVALID", "Purpose Context requires the run's canonical bound scope", 400);
    }
    const hostConfig = await readJson(this.configPath);
    const root = purposeRoot(hostConfig);
    const ownerConfig = {
      transport: "json-subprocess",
      command: [
        process.execPath,
        path.join(root, "scripts", "purpose-context.mjs"),
        "read",
        "--root",
        root,
        "--scope",
        scope,
        "--profile",
        "auto",
        "--max-bytes",
        String(PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES)
      ],
      cwd: root,
      timeout_seconds: hostConfig.timeout_seconds ?? 60,
      max_input_bytes: 4096,
      max_output_bytes: 65536,
      max_stderr_bytes: hostConfig.max_stderr_bytes ?? 65536,
      env_names: hostConfig.env_names ?? []
    };
    const projection = await jsonSubprocess(ownerConfig, {}, signal);
    if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
      throw new GatewayError("PURPOSE_OWNER_INVALID", "OS Purpose owner returned a non-object projection", 502);
    }
    if (projection.scope !== scope) {
      throw new GatewayError("PURPOSE_SCOPE_MISMATCH", "OS Purpose owner returned a projection for a different scope", 502);
    }
    if (projection?.provenance?.projection_owner !== "ai-verse-os") {
      throw new GatewayError("PURPOSE_OWNER_MISMATCH", "Purpose projection did not preserve OS projection ownership", 502);
    }
    return projection;
  }
  retrieveHistory(query, scope, signal) { return this.call("retrieve_history", { query, scope }, signal); }
  retrieveHistoryProgressive(payload, signal) { return this.call("retrieve_history_progressive", payload, signal); }
  listCapabilities(scope, signal) { return this.call("list_capabilities", { scope }, signal); }
  listConnections(scope, signal) { return this.call("list_connections", { scope }, signal); }
  authorizeAction(request, signal) { return this.call("authorize_action", { request }, signal); }
  requestAction(request, signal) { return this.call("request_action", { request }, signal); }
}

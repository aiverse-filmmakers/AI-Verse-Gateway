import { HOST_PROTOCOL } from "./constants.mjs";
import { jsonSubprocess } from "./subprocess.mjs";
import { id, readJson } from "./util.mjs";
import { GatewayError } from "./errors.mjs";

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
  retrieveHistory(query, scope, signal) { return this.call("retrieve_history", { query, scope }, signal); }
  listCapabilities(scope, signal) { return this.call("list_capabilities", { scope }, signal); }
  listConnections(scope, signal) { return this.call("list_connections", { scope }, signal); }
  authorizeAction(request, signal) { return this.call("authorize_action", { request }, signal); }
  requestAction(request, signal) { return this.call("request_action", { request }, signal); }
}

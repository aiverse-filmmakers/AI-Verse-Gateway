import { GOAL_PROTOCOL } from "./constants.mjs";
import { jsonSubprocess } from "./subprocess.mjs";
import { GatewayError } from "./errors.mjs";
import { id, readJson } from "./util.mjs";

export class GoalOwnerClient {
  constructor(configPath) { this.configPath = configPath; }
  async call(operation, payload, signal) {
    if (!this.configPath) throw new GatewayError("GOAL_OWNER_UNAVAILABLE", "Brain Goal owner adapter is not configured", 409);
    const config = await readJson(this.configPath);
    const request = { protocol: GOAL_PROTOCOL, request_id: id("goal"), operation, payload };
    const envelope = await jsonSubprocess(config, request, signal);
    if (envelope?.protocol !== GOAL_PROTOCOL || envelope?.request_id !== request.request_id) throw new GatewayError("GOAL_PROTOCOL_MISMATCH", "Brain Goal owner returned a mismatched envelope", 502);
    if (envelope.ok !== true) throw new GatewayError("GOAL_OWNER_REJECTED", String(envelope?.error?.message ?? "Goal owner rejected request"), 409);
    return envelope.result;
  }
  get(goalId, scope, signal) { return this.call("goal.get", { goal_id: goalId, scope }, signal); }
  evaluate(goalId, scope, expectedVersion, evidence, signal) { return this.call("goal.evaluate", { goal_id: goalId, scope, expected_version: expectedVersion, evidence }, signal); }
}

import { loadConfig } from "./config.mjs";
import { GatewayError } from "./errors.mjs";
import { paths } from "./paths.mjs";
import { existsFile } from "./util.mjs";

export async function readLifecycleState(home, options = {}) {
  const p = paths(home);
  if (!(await existsFile(p.install))) {
    return { state: "absent", config: null, error: null };
  }
  if (!(await existsFile(p.config))) {
    return { state: "setup-required", config: null, error: null };
  }

  let config;
  try {
    config = await loadConfig(home);
  } catch (error) {
    return {
      state: "unhealthy",
      config: null,
      error: String(error?.message ?? error)
    };
  }

  if (config.enabled !== true) {
    return { state: "disabled", config, error: null };
  }

  if (options.expected_service_generation !== undefined) {
    const expected = options.expected_service_generation ?? null;
    const current = config.service_generation ?? null;
    if (current !== expected) {
      return {
        state: "restart-required",
        config,
        error: "Gateway setup generation changed; restart the live service"
      };
    }
  }

  return { state: "ready", config, error: null };
}

export function assertLifecycleReady(snapshot) {
  if (snapshot?.state === "ready") return snapshot.config;

  const state = snapshot?.state ?? "unhealthy";
  const mapping = {
    absent: ["GATEWAY_ABSENT", "Gateway is not installed"],
    "setup-required": ["GATEWAY_SETUP_REQUIRED", "Gateway setup is required"],
    disabled: ["GATEWAY_DISABLED", "Gateway is disabled"],
    "restart-required": ["GATEWAY_RESTART_REQUIRED", "Gateway setup changed; restart the live service"],
    unhealthy: ["GATEWAY_UNHEALTHY", snapshot?.error || "Gateway lifecycle state is unhealthy"]
  };
  const [code, message] = mapping[state] ?? ["GATEWAY_UNHEALTHY", "Gateway lifecycle state is not ready"];
  throw new GatewayError(code, message, 503);
}

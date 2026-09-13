import path from "node:path";
import { DEFAULT_HOST, DEFAULT_MAX_BODY_BYTES, DEFAULT_PORT, DEFAULT_REQUESTS_PER_MINUTE, DEFAULT_GOAL_TURNS, DEFAULT_NO_PROGRESS_THRESHOLD, DEFAULT_WALL_CLOCK_SECONDS, VERSION } from "./constants.mjs";
import { GatewayError } from "./errors.mjs";
import { readJson } from "./util.mjs";
import { paths } from "./paths.mjs";

export async function loadConfig(home) {
  const p = paths(home);
  const config = await readJson(p.config);
  validateConfig(config);
  return config;
}
export function defaultConfig(input) {
  const host = input.listen_host ?? DEFAULT_HOST;
  const port = input.port ?? DEFAULT_PORT;
  return {
    schema_version: "1.0",
    component_version: VERSION,
    enabled: true,
    system: { id: input.system_id ?? "local", root: path.resolve(input.system_root), default_workspace: input.workspace ?? "operator" },
    server: {
      host, port,
      allow_remote: Boolean(input.allow_remote),
      behind_tls_proxy: Boolean(input.behind_tls_proxy),
      max_body_bytes: input.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES,
      requests_per_minute: input.requests_per_minute ?? DEFAULT_REQUESTS_PER_MINUTE,
      allowed_origins: input.allowed_origins ?? [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
    },
    auth: { required: true, keys: input.auth_keys ?? [] },
    host_adapter_config: input.host_adapter_config,
    goal_owner_config: input.goal_owner_config ?? null,
    runtime: input.runtime,
    limits: {
      max_goal_continuation_turns: input.max_goal_continuation_turns ?? DEFAULT_GOAL_TURNS,
      no_progress_threshold: input.no_progress_threshold ?? DEFAULT_NO_PROGRESS_THRESHOLD,
      wall_clock_seconds: input.wall_clock_seconds ?? DEFAULT_WALL_CLOCK_SECONDS,
      max_actions: input.max_actions ?? 16,
      max_tokens: input.max_tokens ?? null,
      max_cost: input.max_cost ?? null
    }
  };
}
export function validateConfig(config) {
  if (!config || config.schema_version !== "1.0") throw new GatewayError("CONFIG_INVALID", "Gateway config schema must be 1.0");
  const s = config.server ?? {};
  const loopback = s.host === "127.0.0.1" || s.host === "localhost" || s.host === "::1";
  if (!loopback && (!s.allow_remote || !s.behind_tls_proxy)) throw new GatewayError("REMOTE_BIND_UNSAFE", "Non-loopback binding requires allow_remote=true and behind_tls_proxy=true");
  if (config.auth?.required !== true || !Array.isArray(config.auth?.keys) || config.auth.keys.length < 1) throw new GatewayError("AUTH_INVALID", "Gateway requires at least one hashed bearer credential");
  if (!config.system?.root || !config.host_adapter_config) throw new GatewayError("CONFIG_INVALID", "system.root and host_adapter_config are required");
  if (!config.runtime?.kind) throw new GatewayError("CONFIG_INVALID", "runtime.kind is required");
  if (!Number.isInteger(s.max_body_bytes) || s.max_body_bytes < 1024 || s.max_body_bytes > 4 * 1024 * 1024) throw new GatewayError("CONFIG_INVALID", "max_body_bytes is outside the supported range");
}

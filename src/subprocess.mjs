import { spawn } from "node:child_process";
import { GatewayError } from "./errors.mjs";

export async function jsonSubprocess(config, request, signal) {
  if (!config || config.transport !== "json-subprocess" || !Array.isArray(config.command) || config.command.length < 1) throw new GatewayError("ADAPTER_CONFIG_INVALID", "Expected json-subprocess adapter config");
  const encoded = JSON.stringify(request);
  const maxIn = config.max_input_bytes ?? 2 * 1024 * 1024;
  if (Buffer.byteLength(encoded) > maxIn) throw new GatewayError("ADAPTER_INPUT_TOO_LARGE", `Adapter input exceeds ${maxIn} bytes`, 413);
  const [command, ...args] = config.command;
  const child = spawn(command, args, { cwd: config.cwd || undefined, env: filteredEnv(config.env_names ?? []), stdio: ["pipe", "pipe", "pipe"], shell: false, signal });
  const maxOut = config.max_output_bytes ?? 2 * 1024 * 1024;
  const maxErr = config.max_stderr_bytes ?? 64 * 1024;
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (x) => { stdout += x; if (Buffer.byteLength(stdout) > maxOut) child.kill(); });
  child.stderr.on("data", (x) => { stderr += x; if (Buffer.byteLength(stderr) > maxErr) stderr = stderr.slice(-maxErr); });
  child.stdin.end(encoded);
  const timeoutMs = Math.max(1000, Number(config.timeout_seconds ?? 60) * 1000);
  let timer;
  const code = await Promise.race([
    new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }),
    new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new GatewayError("ADAPTER_TIMEOUT", "Adapter timed out", 504)); }, timeoutMs); })
  ]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new GatewayError("ADAPTER_FAILED", (stderr.trim() || stdout.trim() || `adapter exited ${code}`).slice(0, 800), 502);
  try { return JSON.parse(stdout); } catch { throw new GatewayError("ADAPTER_INVALID_JSON", "Adapter returned invalid JSON", 502); }
}
function filteredEnv(names) {
  const env = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  for (const name of names) if (typeof process.env[name] === "string") env[name] = process.env[name];
  return env;
}

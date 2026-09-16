import os from "node:os";
import path from "node:path";
import { access, copyFile, lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { hashToken } from "./auth.mjs";
import { defaultConfig, loadConfig } from "./config.mjs";
import { GatewayError } from "./errors.mjs";
import { HostClient } from "./host-adapter.mjs";
import { gatewayHome, paths } from "./paths.mjs";
import { atomicJson, ensureDir, existsFile, nowIso, randomToken, readJson } from "./util.mjs";
import { VERSION } from "./constants.mjs";

const COMPONENT_ID = "ai-verse-gateway";
const OWNER_SCHEMA_VERSION = "1.0";
const OWNED_HOME_ENTRIES = new Set(["ownership.json", "install.json", "config.json", "host.json", "goal-owner.json", "state"]);
const LEGACY_HOME_ENTRIES = new Set(["install.json", "config.json", "host.json", "goal-owner.json", "state"]);

function pathKey(value) {
  let normalized = path.resolve(value);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, "") || path.parse(normalized).root;
}

async function assertNotBroadHome(candidate) {
  const resolved = path.resolve(candidate);
  const root = path.parse(resolved).root;
  if (pathKey(resolved) === pathKey(root)) throw new GatewayError("GATEWAY_HOME_UNSAFE", "Gateway home may not be a filesystem root");
  const userHome = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  if (pathKey(resolved) === pathKey(userHome)) throw new GatewayError("GATEWAY_HOME_UNSAFE", "Gateway home may not be the user home directory");
}

async function canonicalDirectory(home) {
  await assertNotBroadHome(home);
  let info;
  try { info = await lstat(home); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new GatewayError("GATEWAY_HOME_UNSAFE", "Gateway home may not be a symlink, junction, or reparse target");
  if (!info.isDirectory()) throw new GatewayError("GATEWAY_HOME_INVALID", "Gateway home must be a directory");
  const canonical = await realpath(home);
  await assertNotBroadHome(canonical);
  return canonical;
}

async function readInstallMarker(realHome) {
  const p = paths(realHome);
  let info;
  try { info = await lstat(p.install); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new GatewayError("GATEWAY_INSTALL_MARKER_INVALID", "Gateway install marker must be a regular file");
  const marker = await readJson(p.install);
  if (marker?.schema_version !== "1.0" || marker?.component_id !== COMPONENT_ID) throw new GatewayError("GATEWAY_INSTALL_MARKER_INVALID", "Gateway install marker has the wrong schema or component_id");
  return marker;
}

async function readOwnershipMarker(realHome) {
  const p = paths(realHome);
  let info;
  try { info = await lstat(p.owner); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new GatewayError("GATEWAY_OWNERSHIP_INVALID", "Gateway ownership marker must be a regular file");
  const marker = await readJson(p.owner);
  if (marker?.schema_version !== OWNER_SCHEMA_VERSION || marker?.component_id !== COMPONENT_ID || typeof marker?.root_realpath !== "string") {
    throw new GatewayError("GATEWAY_OWNERSHIP_INVALID", "Gateway ownership marker is malformed or belongs to another component");
  }
  if (pathKey(marker.root_realpath) !== pathKey(realHome)) throw new GatewayError("GATEWAY_OWNERSHIP_INVALID", "Gateway ownership marker is bound to a different canonical root");
  return marker;
}

async function writeOwnershipMarker(realHome, prior = null) {
  const p = paths(realHome);
  const marker = {
    schema_version: OWNER_SCHEMA_VERSION,
    component_id: COMPONENT_ID,
    root_realpath: realHome,
    created_at: prior?.created_at ?? nowIso(),
    updated_at: nowIso()
  };
  await atomicJson(p.owner, marker);
  return marker;
}

async function prepareInstallHome(home) {
  let realHome = await canonicalDirectory(home);
  if (realHome === null) {
    await ensureDir(home);
    realHome = await canonicalDirectory(home);
  }
  const p = paths(realHome);
  const owner = await readOwnershipMarker(realHome);
  if (owner) return { realHome, p, owner };

  const entries = await readdir(realHome);
  const installMarker = await readInstallMarker(realHome);
  if (installMarker) {
    const unexpected = entries.filter((entry) => !LEGACY_HOME_ENTRIES.has(entry));
    if (unexpected.length > 0) throw new GatewayError("GATEWAY_HOME_NOT_EXCLUSIVE", "Legacy Gateway home contains unowned entries and cannot be claimed safely");
    return { realHome, p, owner: await writeOwnershipMarker(realHome) };
  }
  if (entries.length > 0) throw new GatewayError("GATEWAY_HOME_NOT_EMPTY", "Refusing to claim a non-empty directory without Gateway ownership evidence");
  return { realHome, p, owner: await writeOwnershipMarker(realHome) };
}

async function requireOwnedHome(home) {
  const realHome = await canonicalDirectory(home);
  if (realHome === null) throw new GatewayError("GATEWAY_HOME_NOT_OWNED", "Gateway home does not exist");
  const owner = await readOwnershipMarker(realHome);
  if (!owner) throw new GatewayError("GATEWAY_HOME_NOT_OWNED", "Destructive Gateway lifecycle operations require the persistent ownership marker");
  return { realHome, p: paths(realHome), owner };
}

export async function installComponent(opts = {}) {
  const home = gatewayHome(opts.home);
  const { realHome, p, owner } = await prepareInstallHome(home);
  await ensureDir(p.state);
  const prior = await readInstallMarker(realHome);
  const marker = prior ?? { schema_version: "1.0", component_id: COMPONENT_ID, installed_at: nowIso(), state_preserved_on_uninstall: true };
  marker.version = VERSION;
  marker.updated_at = nowIso();
  await atomicJson(p.install, marker);
  await writeOwnershipMarker(realHome, owner);
  return { ok: true, command: "install", state: (await existsFile(p.config)) ? "setup-required-or-configured" : "installed", home, canonical_home: realHome, version: VERSION, canonical_domain_authority_granted: false };
}

export async function setupComponent(opts = {}) {
  const home = gatewayHome(opts.home); const p = paths(home);
  if (!(await existsFile(p.install))) throw new GatewayError("NOT_INSTALLED", "Run `aiverse-gateway install` first", 409);
  const systemRoot = path.resolve(opts.system_root || "");
  if (!systemRoot || !(await existsFile(path.join(systemRoot, "AI-VERSE.yaml")))) throw new GatewayError("SYSTEM_ROOT_INVALID", "setup requires an AI-Verse OS root containing AI-VERSE.yaml");
  let hostConfig = opts.host_config ? path.resolve(opts.host_config) : p.host;
  if (opts.host_config) await copyFile(hostConfig, p.host), hostConfig = p.host;
  else {
    const adapter = path.join(systemRoot, "scripts", "ai_verse_host_adapter.py");
    if (!(await existsFile(adapter))) throw new GatewayError("HOST_ADAPTER_MISSING", "AI-Verse OS host adapter is missing");
    const python = opts.python || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    await atomicJson(p.host, { schema_version: "1.0", name: "ai-verse-os-host", transport: "json-subprocess", command: [python, adapter, "--root", systemRoot], timeout_seconds: 60, max_input_bytes: 2097152, max_output_bytes: 2097152, max_stderr_bytes: 65536, env_names: [], cwd: systemRoot });
  }
  const goalOwnerConfig = opts.goal_owner_config ? path.resolve(opts.goal_owner_config) : null;
  if (goalOwnerConfig) { if (!(await existsFile(goalOwnerConfig))) throw new GatewayError("GOAL_OWNER_CONFIG_MISSING", "Goal owner config does not exist"); await copyFile(goalOwnerConfig, p.goalOwner); }
  const token = opts.token || randomToken();
  const runtime = runtimeConfig(opts);
  const config = defaultConfig({
    system_root: systemRoot,
    system_id: opts.system_id || "local",
    workspace: opts.workspace || "operator",
    listen_host: opts.listen_host,
    port: opts.port ? Number(opts.port) : undefined,
    allow_remote: opts.allow_remote,
    behind_tls_proxy: opts.behind_tls_proxy,
    allowed_origins: opts.allowed_origins,
    auth_keys: [hashToken(token, opts.principal || "operator")],
    host_adapter_config: p.host,
    goal_owner_config: goalOwnerConfig ? p.goalOwner : null,
    runtime,
    context_window_tokens: opts.context_window_tokens == null ? null : Number(opts.context_window_tokens),
    context_soft_pressure_ratio: opts.context_soft_pressure_ratio == null ? undefined : Number(opts.context_soft_pressure_ratio),
    context_hard_pressure_ratio: opts.context_hard_pressure_ratio == null ? undefined : Number(opts.context_hard_pressure_ratio),
    context_recent_raw_tail_messages: opts.context_recent_raw_tail_messages == null ? undefined : Number(opts.context_recent_raw_tail_messages),
    context_chars_per_token_estimate: opts.context_chars_per_token_estimate == null ? undefined : Number(opts.context_chars_per_token_estimate),
    context_summary_wrapper_token_reserve: opts.context_summary_wrapper_token_reserve == null ? undefined : Number(opts.context_summary_wrapper_token_reserve),
    context_cache_sensitive_skip: opts.context_cache_sensitive_skip == null ? true : String(opts.context_cache_sensitive_skip).toLowerCase() !== "false"
  });
  await atomicJson(p.config, config);
  const host = new HostClient(p.host); const described = await host.describe();
  return { ok: true, command: "setup", state: "ready", home, system_id: config.system.id, workspace: config.system.default_workspace, host: { adapter_id: described?.adapter_id, protocol_version: described?.protocol_version, canonical_state_owned: described?.metadata?.canonical_state_owned }, runtime: runtime.kind, context_governor: { configured: Number.isInteger(config.context?.window_tokens), window_tokens: config.context?.window_tokens ?? null }, api_token: token, api_token_note: "Shown once. Only a scrypt hash is stored.", goal_owner: goalOwnerConfig ? "configured" : "not-configured-current-brain-goal-api-unavailable", authority_transfer: "none", external_credentials_stored: false };
}

function runtimeConfig(opts) {
  const kind = opts.runtime || "deterministic";
  if (kind === "deterministic") return { kind };
  if (kind === "openai-compatible") {
    if (!opts.base_url) throw new GatewayError("RUNTIME_CONFIG_INVALID", "--base-url is required for openai-compatible runtime");
    return { kind, base_url: opts.base_url, model: opts.model || "default", api_key_env: opts.api_key_env || null };
  }
  if (kind === "json-subprocess") {
    let command; try { command = JSON.parse(opts.runtime_command || "[]"); } catch { throw new GatewayError("RUNTIME_CONFIG_INVALID", "--runtime-command must be a JSON array"); }
    if (!Array.isArray(command) || command.length < 1) throw new GatewayError("RUNTIME_CONFIG_INVALID", "--runtime-command must be a non-empty JSON array");
    return { kind, transport: "json-subprocess", command, cwd: opts.runtime_cwd || undefined, env_names: opts.runtime_env_names || [], timeout_seconds: Number(opts.runtime_timeout || 120) };
  }
  throw new GatewayError("RUNTIME_CONFIG_INVALID", `Unknown runtime ${kind}`);
}

export async function statusComponent(opts = {}) {
  const home = gatewayHome(opts.home); const p = paths(home);
  if (!(await existsFile(p.install))) return { ok: true, command: "status", state: "absent", home };
  if (!(await existsFile(p.config))) return { ok: true, command: "status", state: "setup-required", home, version: VERSION };
  try { const config = await loadConfig(home); return { ok: true, command: "status", state: config.enabled ? "ready" : "disabled", home, version: VERSION, system_id: config.system.id, runtime: config.runtime.kind, binding: config.server.host, goal_owner_configured: Boolean(config.goal_owner_config) }; }
  catch (error) { return { ok: false, command: "status", state: "unhealthy", home, error: String(error.message ?? error) }; }
}

export async function doctorComponent(opts = {}) {
  const home = gatewayHome(opts.home); const p = paths(home); const checks = [];
  const installed = await existsFile(p.install); checks.push(check("structural", "installation-marker", installed, installed ? "installed" : "missing"));
  if (!installed) return doctorResult(home, checks);
  const hasConfig = await existsFile(p.config); checks.push(check("structural", "config", hasConfig, hasConfig ? "present" : "setup required"));
  if (!hasConfig) return doctorResult(home, checks);
  let config;
  try { config = await loadConfig(home); checks.push(check("structural", "config-schema", true, "valid")); } catch (e) { checks.push(check("structural", "config-schema", false, e.message)); return doctorResult(home, checks); }
  checks.push(check("dependency", "node-version", Number(process.versions.node.split(".")[0]) >= 20, process.version));
  checks.push(check("attachment/discovery", "system-root", await existsFile(path.join(config.system.root, "AI-VERSE.yaml")), config.system.root));
  try { const desc = await new HostClient(config.host_adapter_config).describe(); checks.push(check("runtime", "os-host", desc?.metadata?.canonical_state_owned === false, `${desc?.adapter_id ?? "unknown"} protocol ${desc?.protocol_version ?? "unknown"}`)); }
  catch (e) { checks.push(check("runtime", "os-host", false, e.message)); }
  if (config.runtime.kind === "openai-compatible" && config.runtime.api_key_env) checks.push(check("operational", "runtime-credential", Boolean(process.env[config.runtime.api_key_env]), process.env[config.runtime.api_key_env] ? "environment credential present" : `missing ${config.runtime.api_key_env}`));
  else checks.push(check("operational", "runtime-config", true, config.runtime.kind));
  checks.push(check("system/composed", "brain-goal-owner", true, config.goal_owner_config ? "configured" : "optional unavailable: current Brain main has no goal owner adapter"));
  checks.push(check("system/composed", "remote-security", config.server.host === "127.0.0.1" || (config.server.allow_remote && config.server.behind_tls_proxy), config.server.host === "127.0.0.1" ? "loopback default" : "explicit remote behind TLS proxy"));
  return doctorResult(home, checks);
}
function check(depth, name, ok, detail) { return { depth, name, ok, detail }; }
function doctorResult(home, checks) { const ok = checks.every((x) => x.ok); return { ok, command: "doctor", state: ok ? "ready" : "unhealthy", home, depths_checked: [...new Set(checks.map((x)=>x.depth))], checks }; }

export async function setEnabled(opts, enabled) { const home=gatewayHome(opts.home); const p=paths(home); const config=await loadConfig(home); config.enabled=enabled; await atomicJson(p.config,config); return { ok:true, command:enabled?"enable":"disable", state:enabled?"ready":"disabled", canonical_state_preserved:true }; }
export async function updateComponent(opts={}) { if (!opts.apply) return { ok:true, command:"update", dry_run:true, source:opts.source??null, note:"Software update is separate from canonical Gateway session/run state. Use --apply --source <npm-or-git-spec> to update the installed package." }; if (!opts.source) throw new GatewayError("UPDATE_SOURCE_REQUIRED","--source is required with --apply"); const npm=process.platform==="win32"?"npm.cmd":"npm"; const code=await spawnExit(npm,["install","-g",opts.source]); if(code!==0)throw new GatewayError("UPDATE_FAILED",`npm install exited ${code}`,500); return {ok:true,command:"update",source:opts.source,canonical_state_preserved:true}; }
export async function uninstallComponent(opts={}) {
  const home=gatewayHome(opts.home);
  if (opts.purge === true) {
    const { realHome, p } = await requireOwnedHome(home);
    await rm(p.state,{recursive:true,force:true});
    await Promise.all([p.config,p.host,p.goalOwner,p.install].map((f)=>rm(f,{force:true})));
    await rm(p.owner,{force:true});
    let homeRemoved=false;
    try { await rmdir(realHome); homeRemoved=true; }
    catch (error) { if (error?.code !== "ENOTEMPTY") throw error; }
    return {ok:true,command:"uninstall",state:"absent",purged:true,home_removed:homeRemoved,unowned_entries_preserved:!homeRemoved};
  }

  const initial = paths(home);
  if (!(await existsFile(initial.install)) && !(await existsFile(initial.owner))) {
    return {ok:true,command:"uninstall",state:"absent",canonical_state_preserved:true,note:"No Gateway ownership/install marker found; nothing was removed."};
  }
  let realHome = await canonicalDirectory(home);
  if (realHome === null) return {ok:true,command:"uninstall",state:"absent",canonical_state_preserved:true};

  let owner = await readOwnershipMarker(realHome);
  if (!owner) {
    const entries = await readdir(realHome);
    const installMarker = await readInstallMarker(realHome);
    if (!installMarker) throw new GatewayError("GATEWAY_HOME_NOT_OWNED", "Gateway ownership cannot be established safely");
    const unexpected = entries.filter((entry)=>!LEGACY_HOME_ENTRIES.has(entry));
    if (unexpected.length > 0) throw new GatewayError("GATEWAY_HOME_NOT_EXCLUSIVE", "Legacy Gateway home contains unowned entries and cannot be claimed safely");
    owner = await writeOwnershipMarker(realHome);
  }

  const p=paths(realHome);
  await Promise.all([p.install,p.config,p.host,p.goalOwner].map((f)=>rm(f,{force:true})));
  await writeOwnershipMarker(realHome, owner);
  return {ok:true,command:"uninstall",state:"absent",canonical_state_preserved:true,state_path:p.state,ownership_marker:p.owner,note:"Persistent ownership and Gateway state are preserved. Use --purge only for explicit destructive removal of Gateway-owned state."};
}
function spawnExit(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:"inherit",shell:false});child.once("error",reject);child.once("close",resolve);});}

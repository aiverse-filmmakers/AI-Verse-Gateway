import path from "node:path";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { GatewayError } from "./errors.mjs";
import { atomicJson, appendNdjson, ensureDir, id, nowIso, readJson, sha256, stableStringify } from "./util.mjs";
import { paths } from "./paths.mjs";
import { RUN_RECOVERABLE } from "./constants.mjs";

export class GatewayStore {
  constructor(home) {
    this.p = paths(home);
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
  }
  async init() {
    await Promise.all([this.p.sessions, this.p.runs, this.p.events].map(ensureDir));
    const idem = await readJson(this.p.idempotency, null);
    if (!idem) await atomicJson(this.p.idempotency, { schema_version: "1.0", records: {} });
  }
  sessionFile(sessionId) { assertStorageId(sessionId, "session_id"); return path.join(this.p.sessions, `${sessionId}.json`); }
  runFile(runId) { assertStorageId(runId, "run_id"); return path.join(this.p.runs, `${runId}.json`); }
  eventFile(runId) { assertStorageId(runId, "run_id"); return path.join(this.p.events, `${runId}.ndjson`); }
  async createSession({ system_id, workspace_id, principal, title = null, session_id = null }) {
    const sessionId = session_id ?? id("sess");
    const existing = await readJson(this.sessionFile(sessionId), null);
    if (existing) {
      if (existing.system_id !== system_id || existing.workspace_id !== workspace_id || existing.principal !== principal) throw new GatewayError("SESSION_BINDING_MISMATCH", "Existing session binding does not match the authenticated request", 409);
      return existing;
    }
    const now = nowIso();
    const session = { schema_version: "1.0", session_id: sessionId, system_id, workspace_id, principal, title: title ?? sessionId, status: "active", created_at: now, updated_at: now, active_run_id: null };
    await atomicJson(this.sessionFile(sessionId), session);
    return session;
  }
  async getSession(sessionId) { return await readJson(this.sessionFile(sessionId), null); }
  async saveSession(session) { session.updated_at = nowIso(); await atomicJson(this.sessionFile(session.session_id), session); return session; }
  async createRun(input) {
    const runId = input.run_id ?? id("run");
    const now = nowIso();
    const run = {
      schema_version: "1.0",
      run_id: runId,
      session_id: input.session_id,
      system_id: input.system_id,
      workspace_id: input.workspace_id,
      principal: input.principal,
      runtime: input.runtime,
      status: "queued",
      messages: input.messages ?? [],
      output: null,
      error: null,
      goal_binding: input.goal_binding ?? null,
      automation_binding: input.automation_binding ?? null,
      continuation: { turn: 0, max_turns: input.max_turns ?? 1, fingerprints: [], no_progress_count: 0 },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 0 },
      budget: input.budget,
      deadline_at: input.deadline_at,
      checkpoint: null,
      pending_approval: null,
      created_at: now,
      updated_at: now,
      completed_at: null
    };
    await atomicJson(this.runFile(runId), run);
    await this.event(runId, "run.created", { status: run.status });
    return run;
  }
  async getRun(runId) { return await readJson(this.runFile(runId), null); }
  async saveRun(run) { run.updated_at = nowIso(); await atomicJson(this.runFile(run.run_id), run); this.bus.emit(`run:${run.run_id}`, { kind: "state", run }); return run; }
  async event(runId, type, data = {}) {
    const event = { event_id: id("evt"), run_id: runId, type, at: nowIso(), data };
    await appendNdjson(this.eventFile(runId), event);
    this.bus.emit(`run:${runId}`, { kind: "event", event });
    return event;
  }
  async listEvents(runId) {
    try {
      const body = await readFile(this.eventFile(runId), "utf8");
      return body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  }
  subscribe(runId, listener) { this.bus.on(`run:${runId}`, listener); return () => this.bus.off(`run:${runId}`, listener); }
  async claimIdempotency(namespace, key, payload, result = undefined) {
    if (!key) return { state: "new" };
    const db = await readJson(this.p.idempotency, { schema_version: "1.0", records: {} });
    const mapKey = `${namespace}:${key}`;
    const digest = sha256(stableStringify(payload));
    const prior = db.records[mapKey];
    if (prior) {
      if (prior.digest !== digest) throw new GatewayError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different payload", 409);
      return { state: "replay", record: prior };
    }
    db.records[mapKey] = { digest, result: result ?? null, created_at: nowIso() };
    await atomicJson(this.p.idempotency, db);
    return { state: "new", mapKey, db };
  }
  async commitIdempotency(mapKey, result) {
    if (!mapKey) return;
    const db = await readJson(this.p.idempotency, { schema_version: "1.0", records: {} });
    if (db.records[mapKey]) { db.records[mapKey].result = result; db.records[mapKey].completed_at = nowIso(); await atomicJson(this.p.idempotency, db); }
  }
  async audit({ principal, action, run_id = null, request, outcome }) {
    const receipt = { receipt_id: id("audit"), at: nowIso(), principal, action, run_id, request_digest: sha256(stableStringify(request ?? {})), outcome };
    await appendNdjson(this.p.audit, receipt);
    return receipt;
  }
  async pendingSessionDigestRuns() {
    let names = [];
    try { names = await readdir(this.p.runs); } catch { return []; }
    const pending = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const run = await readJson(path.join(this.p.runs, name), null);
      if (
        run?.status === "completed" &&
        ["pending", "retryable"].includes(run?.memory_digest?.status)
      ) pending.push(run);
    }
    pending.sort((a, b) => String(a.completed_at ?? "").localeCompare(String(b.completed_at ?? "")));
    return pending;
  }
  async pendingOrganizationReviewRuns() {
    let names = [];
    try { names = await readdir(this.p.runs); } catch { return []; }
    const pending = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const run = await readJson(path.join(this.p.runs, name), null);
      if (
        run?.status === "completed" &&
        ["pending", "retryable", "routing"].includes(run?.organization_review?.status)
      ) pending.push(run);
    }
    pending.sort((a, b) => String(a.completed_at ?? "").localeCompare(String(b.completed_at ?? "")));
    return pending;
  }
  async recoverInterrupted() {
    let names = [];
    try { names = await readdir(this.p.runs); } catch { return []; }
    const changed = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const run = await readJson(path.join(this.p.runs, name), null);
      if (!run || !RUN_RECOVERABLE.has(run.status)) continue;
      run.status = "paused_recovery_required";
      run.checkpoint = { ...(run.checkpoint ?? {}), interrupted_at: nowIso(), reason: "gateway_restart" };
      await this.saveRun(run);
      await this.event(run.run_id, "run.recovery_required", { reason: "gateway_restart" });
      changed.push(run.run_id);
    }
    return changed;
  }
}

function assertStorageId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new GatewayError("INVALID_ID", `${label} is not a safe identifier`, 400);
}

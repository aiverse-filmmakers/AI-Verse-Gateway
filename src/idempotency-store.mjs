import path from "node:path";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { GatewayError } from "./errors.mjs";
import { nowIso, sha256, stableStringify } from "./util.mjs";

const JOURNAL_SCHEMA = "1.0";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

export class IdempotencyStore {
  constructor(stateDirectory) {
    this.directory = path.join(stateDirectory, "idempotency");
    this.journal = path.join(this.directory, "records.ndjson");
    this.lock = path.join(this.directory, "writer.lock");
    this.index = new Map();
    this.initialized = false;
  }

  async init(legacyFile) {
    await mkdir(this.directory, { recursive: true });
    await this.withLock(async () => {
      const markerPath = path.join(this.directory, "migration.json");
      let marker = await readJson(markerPath, null);
      if (marker?.status !== "complete") {
        const legacy = await readJson(legacyFile, null);
        if (legacy !== null && (!legacy.records || typeof legacy.records !== "object" || Array.isArray(legacy.records))) {
          throw new GatewayError("IDEMPOTENCY_STATE_INVALID", "Legacy idempotency state is not a records object", 500);
        }
        const existing = await this.loadIndex();
        const source = legacy?.records ?? {};
        const missing = Object.entries(source).filter(([key]) => !existing.has(key));
        if (missing.length) {
          const handle = await open(this.journal, "a", 0o600);
          try {
            for (const [mapKey, record] of missing) {
              validateRecord(record);
              await handle.write(`${JSON.stringify({ schema_version: JOURNAL_SCHEMA, map_key: mapKey, record })}\n`);
            }
            await handle.sync();
          } finally { await handle.close(); }
          await this.loadIndex();
        }
        marker = { schema_version: JOURNAL_SCHEMA, status: "complete", migrated_records: Object.keys(source).length, completed_at: nowIso() };
        await writeAtomic(markerPath, marker);
        await rm(legacyFile, { force: true });
      } else {
        await rm(legacyFile, { force: true });
      }
      this.initialized = true;
    });
  }

  async claim(namespace, key, payload, result = undefined) {
    if (!key) return { state: "new" };
    const mapKey = `${namespace}:${key}`;
    const digest = sha256(stableStringify(payload));
    return await this.withLock(async () => {
      const records = await this.loadIndex();
      const prior = records.get(mapKey);
      if (prior) {
        if (prior.digest !== digest) throw new GatewayError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different payload", 409);
        if (prior.result == null) throw new GatewayError("IDEMPOTENCY_IN_PROGRESS", "Idempotency key is already reserved by an in-progress operation", 409);
        return { state: "replay", record: prior };
      }
      const record = { digest, result: result ?? null, created_at: nowIso() };
      await this.append({ schema_version: JOURNAL_SCHEMA, map_key: mapKey, record });
      this.index.set(mapKey, record);
      return { state: "new", mapKey };
    });
  }

  async commit(mapKey, result) {
    if (!mapKey) return;
    await this.withLock(async () => {
      const records = await this.loadIndex();
      const current = records.get(mapKey);
      if (!current) return;
      const updated = { ...current, result, completed_at: nowIso() };
      await this.append({ schema_version: JOURNAL_SCHEMA, map_key: mapKey, record: updated });
      this.index.set(mapKey, updated);
    });
  }

  async append(entry) {
    const handle = await open(this.journal, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
  }

  async loadIndex() {
    let data;
    try { data = await readFile(this.journal, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") { this.index = new Map(); return this.index; } throw error; }
    const lines = data.split(/\r?\n/);
    const records = new Map();
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); }
      catch (error) {
        if (i === lines.length - 1) break; // incomplete final append is ignored; interior corruption fails closed.
        throw new GatewayError("IDEMPOTENCY_STATE_INVALID", "Idempotency journal contains a corrupt record", 500);
      }
      if (entry?.schema_version !== JOURNAL_SCHEMA || typeof entry.map_key !== "string" || !entry.map_key) {
        throw new GatewayError("IDEMPOTENCY_STATE_INVALID", "Idempotency journal record is invalid", 500);
      }
      validateRecord(entry.record);
      records.set(entry.map_key, entry.record);
    }
    this.index = records;
    return records;
  }

  async withLock(operation) {
    const started = Date.now();
    for (;;) {
      try {
        const handle = await open(this.lock, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomBytes(16).toString("hex"), created_at: Date.now() }));
          await handle.sync();
          return await operation();
        } finally {
          await handle.close();
          await rm(this.lock, { force: true });
        }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() - started > LOCK_TIMEOUT_MS) throw new GatewayError("IDEMPOTENCY_LOCK_TIMEOUT", "Timed out waiting for the idempotency store writer", 503);
        await this.recoverStaleLock();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async recoverStaleLock() {
    let stat;
    try { stat = await (await import("node:fs/promises")).stat(this.lock); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return;
    // Never steal a lock from a live local holder, even if its operation is slow.
    try {
      const text = await readFile(this.lock, "utf8");
      const holder = JSON.parse(text);
      if (Number.isInteger(holder.pid)) {
        try { process.kill(holder.pid, 0); return; }
        catch (error) { if (error?.code !== "ESRCH") return; }
      } else {
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
    const stale = `${this.lock}.${process.pid}.${randomBytes(8).toString("hex")}.stale`;
    try { await rename(this.lock, stale); await rm(stale, { force: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || typeof record.digest !== "string" || typeof record.created_at !== "string") {
    throw new GatewayError("IDEMPOTENCY_STATE_INVALID", "Idempotency record is invalid", 500);
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

async function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

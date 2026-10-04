import path from "node:path";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { GatewayError } from "./errors.mjs";
import { nowIso, sha256, stableStringify } from "./util.mjs";

const SCHEMA = "1.0";
const STALE_MS = 30_000;
const WAIT_MS = 10_000;

export class IdempotencyStore {
  constructor(stateDirectory) {
    this.directory = path.join(stateDirectory, "idempotency");
    this.records = path.join(this.directory, "records");
    this.migration = path.join(this.directory, "migration.json");
  }

  async init(legacyFile) {
    await mkdir(this.records, { recursive: true });
    await this.withLock(path.join(this.directory, "migration.lock"), async () => {
      const marker = await readJson(this.migration, null);
      if (marker?.status === "complete") {
        await rm(legacyFile, { force: true });
        return;
      }
      const legacy = await readJson(legacyFile, null);
      if (legacy && (!legacy.records || typeof legacy.records !== "object" || Array.isArray(legacy.records))) {
        throw invalidState("Legacy idempotency state is not a records object");
      }
      let migrated = 0;
      for (const [mapKey, record] of Object.entries(legacy?.records ?? {})) {
        validateRecord(record);
        await this.createOrVerify(mapKey, record);
        migrated += 1;
      }
      // This marker publishes completion only after every record is durable.
      await writeAtomic(this.migration, { schema_version: SCHEMA, status: "complete", migrated_records: migrated, completed_at: nowIso() });
      await rm(legacyFile, { force: true });
    });
  }

  async claim(namespace, key, payload, result = undefined) {
    if (!key) return { state: "new" };
    const mapKey = `${namespace}:${key}`;
    const digest = sha256(stableStringify(payload));
    const file = this.recordFile(mapKey);
    const temp = await writeTemp(file, { schema_version: SCHEMA, map_key: mapKey, record: { digest, result: result ?? null, created_at: nowIso() } });
    try {
      try {
        // Hard-link publication is atomic and fails if another process claimed this key.
        await link(temp, file);
        return { state: "new", mapKey };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const prior = await this.readRecord(file, mapKey);
        if (prior.digest !== digest) throw new GatewayError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different payload", 409);
        if (prior.result == null) throw new GatewayError("IDEMPOTENCY_IN_PROGRESS", "Idempotency key is already reserved by an in-progress operation", 409);
        return { state: "replay", record: prior };
      }
    } finally { await rm(temp, { force: true }); }
  }

  async commit(mapKey, result) {
    if (!mapKey) return;
    const file = this.recordFile(mapKey);
    await this.withLock(`${file}.lock`, async () => {
      let current;
      try { current = await readJson(file); }
      catch (error) { if (error?.code === "ENOENT") return; throw error; }
      if (current.map_key !== mapKey) throw invalidState("Idempotency record key does not match its digest path");
      validateRecord(current.record);
      await writeAtomic(file, { schema_version: SCHEMA, map_key: mapKey, record: { ...current.record, result, completed_at: nowIso() } });
    });
  }

  recordFile(mapKey) {
    if (typeof mapKey !== "string" || !mapKey) throw new GatewayError("IDEMPOTENCY_KEY_INVALID", "Idempotency storage key is invalid", 500);
    const digest = sha256(mapKey);
    return path.join(this.records, digest.slice(0, 2), `${digest}.json`);
  }

  async readRecord(file, mapKey) {
    const stored = await readJson(file);
    if (stored.map_key !== mapKey) throw invalidState("Idempotency record key does not match its digest path");
    validateRecord(stored.record);
    return stored.record;
  }

  async createOrVerify(mapKey, record) {
    const file = this.recordFile(mapKey);
    const temp = await writeTemp(file, { schema_version: SCHEMA, map_key: mapKey, record });
    try {
      try { await link(temp, file); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const prior = await this.readRecord(file, mapKey);
        if (stableStringify(prior) !== stableStringify(record)) throw invalidState("Existing idempotency record differs from legacy record");
      }
    } finally { await rm(temp, { force: true }); }
  }

  async withLock(lockPath, operation) {
    const token = randomBytes(16).toString("hex");
    const owner = { pid: process.pid, token, created_at: Date.now() };
    const temp = await writeTemp(lockPath, owner);
    const started = Date.now();
    for (;;) {
      let acquired = false;
      try { await link(temp, lockPath); acquired = true; }
      catch (error) {
        if (error?.code !== "EEXIST") { await rm(temp, { force: true }); throw error; }
      }
      if (acquired) {
        await rm(temp, { force: true });
        try { return await operation(); }
        finally {
          const current = await readJson(lockPath, null);
          if (current?.token === token) {
            const released = `${lockPath}.release.${token}`;
            try { await rename(lockPath, released); await rm(released, { force: true }); }
            catch (error) { if (error?.code !== "ENOENT") throw error; }
          }
        }
      }
      if (Date.now() - started > WAIT_MS) {
        await rm(temp, { force: true });
        throw new GatewayError("IDEMPOTENCY_LOCK_TIMEOUT", "Timed out waiting for idempotency storage", 503);
      }
      await this.recoverStaleLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async recoverStaleLock(lockPath) {
    let stat;
    try { stat = await (await import("node:fs/promises")).stat(lockPath); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (Date.now() - stat.mtimeMs <= STALE_MS) return;
    let owner;
    try { owner = await readJson(lockPath); }
    catch { owner = null; }
    if (owner && Number.isInteger(owner.pid)) {
      try { process.kill(owner.pid, 0); return; }
      catch (error) { if (error?.code !== "ESRCH") return; }
    }
    const stale = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
    try { await rename(lockPath, stale); await rm(stale, { force: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

async function writeTemp(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  return temp;
}

async function writeAtomic(target, value) {
  const temp = await writeTemp(target, value);
  try { await rename(temp, target); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

async function readJson(file, fallback = undefined) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || typeof record.digest !== "string" || typeof record.created_at !== "string") {
    throw invalidState("Idempotency record is invalid");
  }
}

function invalidState(message) { return new GatewayError("IDEMPOTENCY_STATE_INVALID", message, 500); }

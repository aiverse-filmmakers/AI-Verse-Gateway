import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";

export function nowIso() { return new Date().toISOString(); }
export function id(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
export function randomToken() { return `avg_${randomBytes(32).toString("base64url")}`; }
export function sha256(value) { return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
export function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(authorization|api[_-]?key|token|secret|password|cookie)/i.test(key)) out[key] = "[REDACTED]";
    else out[key] = redact(item);
  }
  return out;
}
export async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }
export async function readJson(file, fallback = undefined) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
export async function atomicJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}
export async function appendNdjson(file, value) {
  await ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}
export async function existsFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}
export function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}
export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
export function safeEqualString(a, b) { return typeof a === "string" && typeof b === "string" && a === b; }

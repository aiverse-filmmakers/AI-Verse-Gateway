import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { GatewayError } from "./errors.mjs";

export function hashToken(token, principal = "operator") {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(token, salt, 32).toString("base64url");
  return { algorithm: "scrypt-v1", salt, hash, principal, created_at: new Date().toISOString() };
}
export function verifyToken(token, record) {
  if (!record || record.algorithm !== "scrypt-v1" || typeof token !== "string") return false;
  const got = scryptSync(token, record.salt, 32);
  const expected = Buffer.from(record.hash, "base64url");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
export function bearer(req, authRecords) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new GatewayError("UNAUTHENTICATED", "Bearer authentication required", 401);
  const token = header.slice(7).trim();
  for (const record of authRecords ?? []) if (verifyToken(token, record)) return { principal: record.principal, auth: "bearer" };
  throw new GatewayError("UNAUTHENTICATED", "Invalid bearer credential", 401);
}

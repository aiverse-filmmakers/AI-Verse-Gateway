import path from "node:path";
import { readdir } from "node:fs/promises";
import { GatewayError } from "./errors.mjs";
import { atomicJson, ensureDir, nowIso, readJson, sha256, stableStringify } from "./util.mjs";

const CARD_SCHEMA = "1.0";
const CATALOG_SCHEMA = "1.0";
const CARD_KIND = "gateway_fold_card";
const CATALOG_KIND = "gateway_fold_catalog";
const MAX_LEVEL = 64;
const MAX_SUMMARY_CHARS = 32000;

export async function createFoldCard(store, input = {}) {
  const level = Number(input.level);
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new GatewayError("INVALID_FOLD_LEVEL", `Fold level must be an integer between 1 and ${MAX_LEVEL}`, 400);
  }

  const scope = normalizeScope(input.scope);
  const summary = normalizeSummary(input.summary);
  const generator = normalizeGenerator(input.generator);
  const rawSourceRefs = Array.isArray(input.source_refs) ? input.source_refs : [];
  const rawChildRefs = Array.isArray(input.child_refs) ? input.child_refs : [];

  if (level === 1 && (rawSourceRefs.length === 0 || rawChildRefs.length !== 0)) {
    throw new GatewayError("INVALID_FOLD_REFS", "Level-1 fold cards require source_refs and cannot reference child cards", 400);
  }
  if (level > 1 && (rawChildRefs.length === 0 || rawSourceRefs.length !== 0)) {
    throw new GatewayError("INVALID_FOLD_REFS", "Recursive fold cards require child_refs and cannot directly reference raw sources", 400);
  }

  let sourceRefs = [];
  let childRefs = [];
  let coverage;
  let coveredBytes = 0;

  if (level === 1) {
    const seen = new Set();
    const resolved = [];
    for (const candidate of rawSourceRefs) {
      const item = await resolveSourceRef(store, candidate, scope);
      const key = sourceRefKey(item.ref);
      if (seen.has(key)) throw new GatewayError("DUPLICATE_FOLD_SOURCE", "Fold source_refs must be unique and ordered", 400);
      seen.add(key);
      resolved.push(item);
    }
    sourceRefs = resolved.map((item) => item.ref);
    coveredBytes = resolved.reduce((sum, item) => sum + item.bytes, 0);
    const messageCount = resolved.reduce((sum, item) => sum + item.ref.message_count, 0);
    coverage = {
      direct_source_count: sourceRefs.length,
      direct_message_count: messageCount,
      child_count: 0,
      descendant_source_count: sourceRefs.length,
      descendant_message_count: messageCount,
      first_source_ref: sourcePointer(sourceRefs[0]),
      last_source_ref: sourcePointer(sourceRefs[sourceRefs.length - 1])
    };
  } else {
    const seen = new Set();
    const children = [];
    for (const candidate of rawChildRefs) {
      const cardId = typeof candidate === "string" ? candidate : candidate?.card_id;
      assertCardId(cardId);
      if (seen.has(cardId)) throw new GatewayError("DUPLICATE_FOLD_CHILD", "Fold child_refs must be unique and ordered", 400);
      seen.add(cardId);
      const child = await getFoldCard(store, cardId);
      if (child.level !== level - 1) {
        throw new GatewayError("FOLD_LEVEL_MISMATCH", "Recursive fold cards may reference only cards from the immediately lower level", 409);
      }
      if (stableStringify(child.scope) !== stableStringify(scope)) {
        throw new GatewayError("FOLD_SCOPE_MISMATCH", "Fold child scope does not match parent scope", 409);
      }
      const self = selfValidateCard(child);
      if (!self.valid) throw new GatewayError("INVALID_FOLD_CHILD", `Child fold card ${cardId} failed self-validation`, 409);
      children.push(child);
    }
    childRefs = children.map((child) => ({ card_id: child.card_id, fingerprint: child.fingerprint }));
    coveredBytes = children.reduce((sum, child) => sum + Number(child.size_estimate?.covered_bytes ?? 0), 0);
    coverage = {
      direct_source_count: 0,
      direct_message_count: 0,
      child_count: childRefs.length,
      descendant_source_count: children.reduce((sum, child) => sum + Number(child.coverage?.descendant_source_count ?? 0), 0),
      descendant_message_count: children.reduce((sum, child) => sum + Number(child.coverage?.descendant_message_count ?? 0), 0),
      first_source_ref: children[0]?.coverage?.first_source_ref ?? null,
      last_source_ref: children[children.length - 1]?.coverage?.last_source_ref ?? null
    };
  }

  const summaryBytes = Buffer.byteLength(summary, "utf8");
  const sizeEstimate = {
    covered_bytes: coveredBytes,
    summary_bytes: summaryBytes,
    estimated_covered_tokens: estimateTokens(coveredBytes),
    estimated_summary_tokens: estimateTokens(summaryBytes)
  };
  const validationState = {
    state: "validated",
    checks: [
      "structure",
      "scope",
      "ordered_refs",
      level === 1 ? "source_fingerprints" : "child_fingerprints",
      "content_fingerprint"
    ]
  };

  const core = {
    schema_version: CARD_SCHEMA,
    kind: CARD_KIND,
    level,
    scope,
    child_refs: childRefs,
    source_refs: sourceRefs,
    coverage,
    size_estimate: sizeEstimate,
    summary,
    generator,
    validation_state: validationState
  };
  const fingerprint = cardFingerprint(core);
  const cardId = `fold_${fingerprint.slice("sha256:".length, "sha256:".length + 40)}`;
  const file = store.foldCardFile(cardId);
  const existing = await readJson(file, null);

  if (existing) {
    const self = selfValidateCard(existing);
    if (!self.valid || existing.card_id !== cardId || existing.fingerprint !== fingerprint) {
      throw new GatewayError("FOLD_CARD_IMMUTABILITY_VIOLATION", "Existing fold-card identity does not match its immutable content", 409);
    }
    return existing;
  }

  const card = {
    ...core,
    card_id: cardId,
    fingerprint,
    created_at: nowIso()
  };
  await atomicJson(file, card);
  const persisted = await readJson(file);
  const persistedValidation = selfValidateCard(persisted);
  if (!persistedValidation.valid || persisted.card_id !== cardId) {
    throw new GatewayError("FOLD_CARD_WRITE_INVALID", "Persisted fold card failed immutable self-validation", 500);
  }
  await rebuildFoldCatalog(store);
  return persisted;
}

export async function getFoldCard(store, cardId) {
  assertCardId(cardId);
  const card = await readJson(store.foldCardFile(cardId), null);
  if (!card) throw new GatewayError("FOLD_CARD_NOT_FOUND", "Fold card was not found", 404);
  const self = selfValidateCard(card);
  if (!self.valid) {
    throw new GatewayError("INVALID_FOLD_CARD", `Fold card ${cardId} failed self-validation: ${self.errors.join("; ")}`, 409);
  }
  return card;
}

export async function validateFoldCard(store, cardId) {
  const errors = [];
  const visited = new Set();
  await validateRecursive(store, cardId, errors, visited);
  const card = await readJson(store.foldCardFile(cardId), null);
  return {
    card_id: cardId,
    fingerprint: card?.fingerprint ?? null,
    valid: errors.length === 0,
    errors
  };
}

async function validateRecursive(store, cardId, errors, visited) {
  assertCardId(cardId);
  if (visited.has(cardId)) {
    errors.push(`${cardId}:cycle_detected`);
    return;
  }
  visited.add(cardId);
  const card = await readJson(store.foldCardFile(cardId), null);
  if (!card) {
    errors.push(`${cardId}:missing`);
    visited.delete(cardId);
    return;
  }
  const self = selfValidateCard(card);
  if (!self.valid) {
    for (const error of self.errors) errors.push(`${cardId}:${error}`);
    visited.delete(cardId);
    return;
  }

  if (card.level === 1) {
    for (const ref of card.source_refs) {
      try {
        await readFoldSource(store, ref, card.scope);
      } catch (error) {
        errors.push(`${cardId}:source:${error?.code ?? error?.message ?? "invalid"}`);
      }
    }
  } else {
    for (const ref of card.child_refs) {
      const child = await readJson(store.foldCardFile(ref.card_id), null);
      if (!child) {
        errors.push(`${cardId}:child_missing:${ref.card_id}`);
        continue;
      }
      if (child.fingerprint !== ref.fingerprint) {
        errors.push(`${cardId}:child_fingerprint_drift:${ref.card_id}`);
        continue;
      }
      if (child.level !== card.level - 1) errors.push(`${cardId}:child_level_mismatch:${ref.card_id}`);
      if (stableStringify(child.scope) !== stableStringify(card.scope)) errors.push(`${cardId}:child_scope_mismatch:${ref.card_id}`);
      await validateRecursive(store, ref.card_id, errors, visited);
    }
  }
  visited.delete(cardId);
}

export async function readFoldSource(store, ref, expectedScope = null) {
  if (!ref || ref.kind !== "run_messages") throw new GatewayError("INVALID_FOLD_SOURCE", "Fold source ref kind is unsupported", 400);
  const scope = expectedScope ? normalizeScope(expectedScope) : null;
  const run = await store.getRun(ref.run_id);
  if (!run) throw new GatewayError("FOLD_SOURCE_NOT_FOUND", "Fold source run was not found", 404);
  if (run.session_id !== ref.session_id) throw new GatewayError("FOLD_SOURCE_DRIFT", "Fold source session identity changed", 409);
  if (scope && !runMatchesScope(run, scope)) throw new GatewayError("FOLD_SCOPE_MISMATCH", "Fold source scope no longer matches the card", 409);
  const start = Number(ref.start_index);
  const end = Number(ref.end_index);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= (run.messages ?? []).length) {
    throw new GatewayError("FOLD_SOURCE_DRIFT", "Fold source message range is no longer available", 409);
  }
  const messages = (run.messages ?? []).slice(start, end + 1);
  const fingerprint = sourceFingerprint({
    run_id: run.run_id,
    session_id: run.session_id,
    start_index: start,
    end_index: end,
    messages
  });
  if (fingerprint !== ref.fingerprint) throw new GatewayError("FOLD_SOURCE_DRIFT", "Fold source fingerprint no longer matches canonical raw messages", 409);
  return {
    source_ref: { ...ref },
    messages: JSON.parse(JSON.stringify(messages))
  };
}

export async function resolveFoldCardSources(store, cardId) {
  const card = await getFoldCard(store, cardId);
  const stack = new Set();
  return await resolveSourcesRecursive(store, card, stack);
}

async function resolveSourcesRecursive(store, card, stack) {
  if (stack.has(card.card_id)) throw new GatewayError("FOLD_CARD_CYCLE", "Fold-card child graph contains a cycle", 409);
  stack.add(card.card_id);
  try {
    if (card.level === 1) {
      const out = [];
      for (const ref of card.source_refs) out.push(await readFoldSource(store, ref, card.scope));
      return out;
    }
    const out = [];
    for (const ref of card.child_refs) {
      const child = await getFoldCard(store, ref.card_id);
      if (child.fingerprint !== ref.fingerprint) throw new GatewayError("FOLD_CHILD_DRIFT", "Referenced child fold-card fingerprint changed", 409);
      if (stableStringify(child.scope) !== stableStringify(card.scope)) throw new GatewayError("FOLD_SCOPE_MISMATCH", "Referenced child fold-card scope changed", 409);
      out.push(...await resolveSourcesRecursive(store, child, stack));
    }
    return out;
  } finally {
    stack.delete(card.card_id);
  }
}

export async function rebuildFoldCatalog(store, { live_validation = false } = {}) {
  await ensureDir(store.p.foldCards);
  let names = [];
  try { names = await readdir(store.p.foldCards); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  names = names.filter((name) => name.endsWith(".json")).sort();
  const cards = [];
  for (const name of names) {
    const card = await readJson(path.join(store.p.foldCards, name), null);
    if (!card) continue;
    const self = selfValidateCard(card);
    let live = null;
    if (live_validation && self.valid && typeof card.card_id === "string") {
      live = await validateFoldCard(store, card.card_id);
    }
    cards.push({
      card_id: String(card.card_id ?? ""),
      fingerprint: String(card.fingerprint ?? ""),
      level: Number(card.level ?? 0),
      scope: card.scope ?? null,
      created_at: card.created_at ?? null,
      validation_state: self.valid ? String(card.validation_state?.state ?? "unknown") : "invalid",
      validation_errors: self.errors,
      ...(live_validation ? {
        live_validation_state: live?.valid === true ? "validated" : "invalid",
        live_validation_errors: live?.errors ?? (self.valid ? ["live_validation_unavailable"] : self.errors)
      } : {}),
      child_count: Array.isArray(card.child_refs) ? card.child_refs.length : 0,
      source_count: Array.isArray(card.source_refs) ? card.source_refs.length : 0,
      descendant_message_count: Number(card.coverage?.descendant_message_count ?? 0),
      size_estimate: card.size_estimate ?? null
    });
  }
  const fingerprint = `sha256:${sha256(stableStringify(cards))}`;
  const catalog = {
    schema_version: CATALOG_SCHEMA,
    kind: CATALOG_KIND,
    rebuilt_at: nowIso(),
    fingerprint,
    cards
  };
  await atomicJson(store.p.foldCatalog, catalog);
  return catalog;
}

export async function listFoldCards(store, { scope = null, level = null, include_invalid = false } = {}) {
  const catalog = await rebuildFoldCatalog(store);
  const normalizedScope = scope ? normalizeScope(scope) : null;
  return catalog.cards.filter((card) => {
    if (!include_invalid && card.validation_state !== "validated") return false;
    if (normalizedScope && stableStringify(card.scope) !== stableStringify(normalizedScope)) return false;
    if (level !== null && Number(card.level) !== Number(level)) return false;
    return true;
  });
}

async function resolveSourceRef(store, candidate, scope) {
  if (!candidate || typeof candidate !== "object") throw new GatewayError("INVALID_FOLD_SOURCE", "Fold source ref must be an object", 400);
  const runId = candidate.run_id;
  const run = await store.getRun(runId);
  if (!run) throw new GatewayError("FOLD_SOURCE_NOT_FOUND", "Fold source run was not found", 404);
  if (run.status !== "completed") throw new GatewayError("FOLD_SOURCE_NOT_IMMUTABLE", "Fold sources must come from completed Gateway runs", 409);
  if (!runMatchesScope(run, scope)) throw new GatewayError("FOLD_SCOPE_MISMATCH", "Fold source run does not match card scope", 409);
  if (candidate.session_id && candidate.session_id !== run.session_id) throw new GatewayError("FOLD_SOURCE_SESSION_MISMATCH", "Fold source session_id does not match the run", 409);
  const start = Number(candidate.start_index);
  const end = Number(candidate.end_index);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= (run.messages ?? []).length) {
    throw new GatewayError("INVALID_FOLD_SOURCE_RANGE", "Fold source message range is invalid", 400);
  }
  const messages = (run.messages ?? []).slice(start, end + 1);
  const fingerprint = sourceFingerprint({
    run_id: run.run_id,
    session_id: run.session_id,
    start_index: start,
    end_index: end,
    messages
  });
  return {
    ref: {
      kind: "run_messages",
      run_id: run.run_id,
      session_id: run.session_id,
      start_index: start,
      end_index: end,
      message_count: messages.length,
      fingerprint
    },
    bytes: Buffer.byteLength(stableStringify(messages), "utf8")
  };
}

function sourceFingerprint(value) {
  return `sha256:${sha256(stableStringify(value))}`;
}

function cardFingerprint(cardLike) {
  const core = {
    schema_version: cardLike.schema_version,
    kind: cardLike.kind,
    level: cardLike.level,
    scope: cardLike.scope,
    child_refs: cardLike.child_refs,
    source_refs: cardLike.source_refs,
    coverage: cardLike.coverage,
    size_estimate: cardLike.size_estimate,
    summary: cardLike.summary,
    generator: cardLike.generator,
    validation_state: cardLike.validation_state
  };
  return `sha256:${sha256(stableStringify(core))}`;
}

function selfValidateCard(card) {
  const errors = [];
  if (!card || typeof card !== "object" || Array.isArray(card)) return { valid: false, errors: ["not_object"] };
  if (card.schema_version !== CARD_SCHEMA) errors.push("schema_version");
  if (card.kind !== CARD_KIND) errors.push("kind");
  if (!Number.isInteger(card.level) || card.level < 1 || card.level > MAX_LEVEL) errors.push("level");
  try { normalizeScope(card.scope); } catch { errors.push("scope"); }

  const childRefs = Array.isArray(card.child_refs) ? card.child_refs : null;
  const sourceRefs = Array.isArray(card.source_refs) ? card.source_refs : null;
  if (!childRefs || !sourceRefs) errors.push("refs");
  if (typeof card.summary !== "string" || card.summary.length === 0 || card.summary.length > MAX_SUMMARY_CHARS) errors.push("summary");
  if (typeof card.created_at !== "string" || !Number.isFinite(Date.parse(card.created_at))) errors.push("created_at");
  if (typeof card.card_id !== "string" || !/^fold_[a-f0-9]{40}$/.test(card.card_id)) errors.push("card_id");
  if (typeof card.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(card.fingerprint)) errors.push("fingerprint");

  validateGeneratorShape(card.generator, errors);
  validateValidationState(card.validation_state, card.level, errors);

  if (childRefs && sourceRefs && Number.isInteger(card.level)) {
    if (card.level === 1) {
      if (sourceRefs.length === 0 || childRefs.length !== 0) errors.push("ref_mode");
      const seen = new Set();
      let priorSameRun = null;
      for (const ref of sourceRefs) {
        if (!validSourceRefShape(ref)) {
          errors.push("source_ref_shape");
          continue;
        }
        const key = sourceRefKey(ref);
        if (seen.has(key)) errors.push("source_ref_duplicate");
        seen.add(key);
        if (priorSameRun && priorSameRun.run_id === ref.run_id && ref.start_index <= priorSameRun.end_index) errors.push("source_ref_order");
        priorSameRun = ref;
      }
    } else if (card.level > 1) {
      if (childRefs.length === 0 || sourceRefs.length !== 0) errors.push("ref_mode");
      const seen = new Set();
      for (const ref of childRefs) {
        if (!validChildRefShape(ref)) {
          errors.push("child_ref_shape");
          continue;
        }
        if (seen.has(ref.card_id)) errors.push("child_ref_duplicate");
        seen.add(ref.card_id);
      }
    }
  }

  validateCoverageShape(card, errors);
  validateSizeShape(card, errors);

  if (errors.length === 0) {
    const expectedFingerprint = cardFingerprint(card);
    if (expectedFingerprint !== card.fingerprint) errors.push("fingerprint_mismatch");
    const expectedId = `fold_${expectedFingerprint.slice("sha256:".length, "sha256:".length + 40)}`;
    if (expectedId !== card.card_id) errors.push("identity_mismatch");
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateGeneratorShape(generator, errors) {
  if (!generator || typeof generator !== "object" || Array.isArray(generator)) {
    errors.push("generator");
    return;
  }
  for (const key of ["kind", "version"]) {
    if (typeof generator[key] !== "string" || generator[key].trim().length === 0 || generator[key].length > 512) errors.push("generator");
  }
  for (const key of ["provider", "model", "prompt_fingerprint"]) {
    if (generator[key] !== undefined && generator[key] !== null && (typeof generator[key] !== "string" || generator[key].trim().length === 0 || generator[key].length > 512)) errors.push("generator");
  }
}

function validateValidationState(state, level, errors) {
  if (!state || typeof state !== "object" || state.state !== "validated" || !Array.isArray(state.checks)) {
    errors.push("validation_state");
    return;
  }
  const required = ["structure", "scope", "ordered_refs", level === 1 ? "source_fingerprints" : "child_fingerprints", "content_fingerprint"];
  if (state.checks.some((item) => typeof item !== "string") || required.some((item) => !state.checks.includes(item))) errors.push("validation_state");
}

function validSourceRefShape(ref) {
  return Boolean(
    ref &&
    typeof ref === "object" &&
    ref.kind === "run_messages" &&
    safeStoredId(ref.run_id) &&
    safeStoredId(ref.session_id) &&
    Number.isInteger(ref.start_index) &&
    Number.isInteger(ref.end_index) &&
    ref.start_index >= 0 &&
    ref.end_index >= ref.start_index &&
    Number.isInteger(ref.message_count) &&
    ref.message_count === ref.end_index - ref.start_index + 1 &&
    typeof ref.fingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(ref.fingerprint)
  );
}

function validChildRefShape(ref) {
  return Boolean(
    ref &&
    typeof ref === "object" &&
    typeof ref.card_id === "string" &&
    /^fold_[a-f0-9]{40}$/.test(ref.card_id) &&
    typeof ref.fingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(ref.fingerprint)
  );
}

function validateCoverageShape(card, errors) {
  const coverage = card.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    errors.push("coverage");
    return;
  }
  const keys = ["direct_source_count", "direct_message_count", "child_count", "descendant_source_count", "descendant_message_count"];
  if (keys.some((key) => !Number.isInteger(coverage[key]) || coverage[key] < 0)) {
    errors.push("coverage");
    return;
  }
  const first = coverage.first_source_ref;
  const last = coverage.last_source_ref;
  if (typeof first !== "string" || typeof last !== "string" || !first.startsWith("gateway:run:") || !last.startsWith("gateway:run:")) errors.push("coverage");

  if (card.level === 1 && Array.isArray(card.source_refs)) {
    const messageCount = card.source_refs.reduce((sum, ref) => sum + (Number.isInteger(ref?.message_count) ? ref.message_count : 0), 0);
    if (
      coverage.direct_source_count !== card.source_refs.length ||
      coverage.direct_message_count !== messageCount ||
      coverage.child_count !== 0 ||
      coverage.descendant_source_count !== card.source_refs.length ||
      coverage.descendant_message_count !== messageCount ||
      coverage.first_source_ref !== sourcePointer(card.source_refs[0]) ||
      coverage.last_source_ref !== sourcePointer(card.source_refs[card.source_refs.length - 1])
    ) errors.push("coverage");
  } else if (card.level > 1 && Array.isArray(card.child_refs)) {
    if (
      coverage.direct_source_count !== 0 ||
      coverage.direct_message_count !== 0 ||
      coverage.child_count !== card.child_refs.length ||
      coverage.descendant_source_count < card.child_refs.length ||
      coverage.descendant_message_count < coverage.descendant_source_count
    ) errors.push("coverage");
  }
}

function validateSizeShape(card, errors) {
  const size = card.size_estimate;
  if (!size || typeof size !== "object" || Array.isArray(size)) {
    errors.push("size_estimate");
    return;
  }
  const summaryBytes = typeof card.summary === "string" ? Buffer.byteLength(card.summary, "utf8") : -1;
  if (
    !Number.isInteger(size.covered_bytes) || size.covered_bytes <= 0 ||
    !Number.isInteger(size.summary_bytes) || size.summary_bytes !== summaryBytes ||
    !Number.isInteger(size.estimated_covered_tokens) || size.estimated_covered_tokens !== estimateTokens(size.covered_bytes) ||
    !Number.isInteger(size.estimated_summary_tokens) || size.estimated_summary_tokens !== estimateTokens(size.summary_bytes)
  ) errors.push("size_estimate");
}

function safeStoredId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object") throw new GatewayError("INVALID_FOLD_SCOPE", "Fold scope is required", 400);
  const out = {};
  for (const key of ["system_id", "workspace_id", "principal"]) {
    const value = scope[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new GatewayError("INVALID_FOLD_SCOPE", `Fold scope requires ${key}`, 400);
    out[key] = value;
  }
  return out;
}

function normalizeSummary(summary) {
  if (typeof summary !== "string") throw new GatewayError("INVALID_FOLD_SUMMARY", "Fold summary must be text", 400);
  const value = summary.trim();
  if (!value || value.length > MAX_SUMMARY_CHARS) throw new GatewayError("INVALID_FOLD_SUMMARY", `Fold summary must be between 1 and ${MAX_SUMMARY_CHARS} characters`, 400);
  return value;
}

function normalizeGenerator(generator) {
  if (!generator || typeof generator !== "object") throw new GatewayError("INVALID_FOLD_GENERATOR", "Fold generator metadata is required", 400);
  const kind = requiredText(generator.kind, "generator.kind");
  const version = requiredText(generator.version, "generator.version");
  const out = { kind, version };
  for (const key of ["provider", "model", "prompt_fingerprint"]) {
    if (generator[key] !== undefined && generator[key] !== null) out[key] = requiredText(generator[key], `generator.${key}`);
  }
  return out;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) throw new GatewayError("INVALID_FOLD_GENERATOR", `${label} must be non-empty text`, 400);
  return value.trim();
}

function runMatchesScope(run, scope) {
  return run.system_id === scope.system_id && run.workspace_id === scope.workspace_id && run.principal === scope.principal;
}

function sourcePointer(ref) {
  return `gateway:run:${ref.run_id}:messages:${ref.start_index}-${ref.end_index}`;
}

function sourceRefKey(ref) {
  return `${ref.run_id}:${ref.start_index}:${ref.end_index}`;
}

function estimateTokens(bytes) {
  return Math.ceil(Number(bytes || 0) / 4);
}

function assertCardId(cardId) {
  if (typeof cardId !== "string" || !/^fold_[a-f0-9]{40}$/.test(cardId)) throw new GatewayError("INVALID_FOLD_CARD_ID", "Fold card id is invalid", 400);
}

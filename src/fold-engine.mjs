import path from "node:path";
import { readdir } from "node:fs/promises";
import { GatewayError } from "./errors.mjs";
import { readJson, sha256, stableStringify } from "./util.mjs";

export const FOLD_ENGINE_VERSION = "gateway.fold-engine.e2.v1";
export const DEFAULT_PRESSURE_THRESHOLD = 0.8;
export const DEFAULT_FAN_IN = 2;
export const DEFAULT_MAX_LEVELS = 8;
export const DEFAULT_MAX_NEW_CARDS = 8;

export async function foldOldestHistory(store, options = {}) {
  const pressure = ratio(options.pressure, "pressure");
  const threshold = options.threshold === undefined
    ? DEFAULT_PRESSURE_THRESHOLD
    : ratio(options.threshold, "threshold");
  const fanIn = boundedInteger(options.fan_in, DEFAULT_FAN_IN, 2, 8, "fan_in");
  const maxLevels = boundedInteger(options.max_levels, DEFAULT_MAX_LEVELS, 1, 16, "max_levels");
  const maxNewCards = boundedInteger(options.max_new_cards, DEFAULT_MAX_NEW_CARDS, 1, 32, "max_new_cards");
  const sessionId = requiredText(options.session_id, "session_id", 128);
  const scope = normalizeScope(options.scope);

  if (pressure < threshold) {
    return result("below_pressure_threshold", {
      pressure,
      threshold,
      fan_in: fanIn,
      created_cards: [],
      generator_calls: 0
    });
  }

  const session = await store.getSession(sessionId);
  if (!session) throw new GatewayError("FOLD_SESSION_NOT_FOUND", "Fold target session was not found", 404);
  if (!sessionMatchesScope(session, scope)) {
    throw new GatewayError("FOLD_SCOPE_MISMATCH", "Fold target session does not match requested scope", 409);
  }

  const runs = await completedSessionRuns(store, sessionId, scope);
  const runById = new Map(runs.map((run) => [run.run_id, run]));
  const runPosition = new Map(runs.map((run, index) => [run.run_id, index]));
  const coveredRuns = await coveredRunIds(store, scope, sessionId);
  const eligible = runs.filter((run) => !coveredRuns.has(run.run_id));

  const created = [];
  let generatorCalls = 0;
  let failure = null;

  if (eligible.length > 0 && created.length < maxNewCards) {
    const selected = eligible.slice(0, Math.min(fanIn, eligible.length));
    const sourceRefs = selected.map((run) => ({
      run_id: run.run_id,
      session_id: run.session_id,
      start_index: 0,
      end_index: run.messages.length - 1
    }));
    const inputBytes = selected.reduce(
      (sum, run) => sum + Buffer.byteLength(stableStringify(run.messages), "utf8"),
      0
    );
    const generated = await generate(options.summarize, {
      kind: "raw_history",
      level: 1,
      scope,
      session_id: sessionId,
      input_bytes: inputBytes,
      source_runs: selected.map((run) => ({
        run_id: run.run_id,
        session_id: run.session_id,
        completed_at: run.completed_at,
        messages: JSON.parse(JSON.stringify(run.messages))
      }))
    });
    generatorCalls += generated.called ? 1 : 0;

    if (!generated.ok) {
      return result(generated.status, {
        pressure,
        threshold,
        fan_in: fanIn,
        created_cards: [],
        generator_calls: generatorCalls,
        failure: generated.failure
      });
    }
    if (!strictlySmaller(generated.summary, inputBytes)) {
      return result("summary_not_smaller", {
        pressure,
        threshold,
        fan_in: fanIn,
        created_cards: [],
        generator_calls: generatorCalls,
        failure: {
          level: 1,
          input_bytes: inputBytes,
          summary_bytes: Buffer.byteLength(generated.summary.trim(), "utf8")
        }
      });
    }

    const card = await store.createFoldCard({
      level: 1,
      scope,
      source_refs: sourceRefs,
      summary: generated.summary,
      generator: generated.generator
    });
    created.push(card);
  }

  for (let level = 1; level < maxLevels && created.length < maxNewCards; level += 1) {
    const group = await oldestAdjacentUnparentedGroup(
      store,
      {
        scope,
        sessionId,
        level,
        fanIn,
        runById,
        runPosition
      }
    );
    if (!group) continue;

    const inputBytes = group.reduce(
      (sum, card) => sum + Buffer.byteLength(card.summary, "utf8"),
      0
    );
    const generated = await generate(options.summarize, {
      kind: "child_cards",
      level: level + 1,
      scope,
      session_id: sessionId,
      input_bytes: inputBytes,
      child_cards: group.map((card) => ({
        card_id: card.card_id,
        fingerprint: card.fingerprint,
        level: card.level,
        summary: card.summary,
        coverage: card.coverage
      }))
    });
    generatorCalls += generated.called ? 1 : 0;

    if (!generated.ok) {
      failure = {
        status: generated.status,
        level: level + 1,
        detail: generated.failure
      };
      break;
    }
    if (!strictlySmaller(generated.summary, inputBytes)) {
      failure = {
        status: "summary_not_smaller",
        level: level + 1,
        input_bytes: inputBytes,
        summary_bytes: Buffer.byteLength(generated.summary.trim(), "utf8")
      };
      break;
    }

    const parent = await store.createFoldCard({
      level: level + 1,
      scope,
      child_refs: group.map((card) => card.card_id),
      summary: generated.summary,
      generator: generated.generator
    });
    created.push(parent);
  }

  if (failure) {
    return result(created.length > 0 ? "partial_fold" : failure.status, {
      pressure,
      threshold,
      fan_in: fanIn,
      created_cards: created,
      generator_calls: generatorCalls,
      failure
    });
  }

  if (created.length === 0) {
    return result("no_eligible_history", {
      pressure,
      threshold,
      fan_in: fanIn,
      created_cards: [],
      generator_calls: generatorCalls
    });
  }

  return result("folded", {
    pressure,
    threshold,
    fan_in: fanIn,
    created_cards: created,
    generator_calls: generatorCalls
  });
}

async function oldestAdjacentUnparentedGroup(
  store,
  { scope, sessionId, level, fanIn, runById, runPosition }
) {
  const entries = await store.listFoldCards({ scope, level });
  if (entries.length < fanIn) return null;

  const referenced = new Set();
  const parentEntries = await store.listFoldCards({ scope, level: level + 1 });
  for (const entry of parentEntries) {
    const parent = await store.getFoldCard(entry.card_id);
    for (const ref of parent.child_refs ?? []) referenced.add(ref.card_id);
  }

  const spans = [];
  for (const entry of entries) {
    if (referenced.has(entry.card_id)) continue;
    const card = await store.getFoldCard(entry.card_id);
    const span = await cardSpan(store, card, sessionId, runById, runPosition);
    if (span) spans.push(span);
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.card.card_id.localeCompare(b.card.card_id));

  for (let i = 0; i + fanIn <= spans.length; i += 1) {
    const window = spans.slice(i, i + fanIn);
    let adjacent = true;
    for (let j = 1; j < window.length; j += 1) {
      if (window[j].start !== window[j - 1].end + 1) {
        adjacent = false;
        break;
      }
    }
    if (adjacent) return window.map((item) => item.card);
  }
  return null;
}

async function cardSpan(store, card, sessionId, runById, runPosition) {
  const validation = await store.validateFoldCard(card.card_id);
  if (!validation.valid) return null;

  const resolved = await store.resolveFoldCardSources(card.card_id);
  if (resolved.length === 0) return null;
  const positions = [];
  for (const item of resolved) {
    const ref = item.source_ref;
    if (ref.session_id !== sessionId) return null;
    const run = runById.get(ref.run_id);
    const position = runPosition.get(ref.run_id);
    if (!run || position === undefined) return null;
    if (ref.start_index !== 0 || ref.end_index !== run.messages.length - 1) return null;
    positions.push(position);
  }
  if (new Set(positions).size !== positions.length) return null;
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1] + 1) return null;
  }
  return {
    card,
    start: positions[0],
    end: positions[positions.length - 1]
  };
}

async function coveredRunIds(store, scope, sessionId) {
  const covered = new Set();
  const entries = await store.listFoldCards({ scope, level: 1 });
  for (const entry of entries) {
    const card = await store.getFoldCard(entry.card_id);
    for (const ref of card.source_refs ?? []) {
      if (ref.session_id !== sessionId) continue;
      const validation = await store.validateFoldCard(card.card_id);
      if (!validation.valid) {
        throw new GatewayError("FOLD_EXISTING_CARD_INVALID", `Existing fold card ${card.card_id} is invalid; refusing overlapping fold creation`, 409);
      }
      covered.add(ref.run_id);
    }
  }
  return covered;
}

async function completedSessionRuns(store, sessionId, scope) {
  let names = [];
  try { names = await readdir(store.p.runs); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const runs = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const run = await readJson(path.join(store.p.runs, name), null);
    if (!run || run.status !== "completed" || run.session_id !== sessionId) continue;
    if (!runMatchesScope(run, scope)) continue;
    if (!Array.isArray(run.messages) || run.messages.length === 0) continue;
    runs.push(run);
  }
  runs.sort((a, b) => {
    const aTime = String(a.completed_at ?? a.created_at ?? "");
    const bTime = String(b.completed_at ?? b.created_at ?? "");
    return aTime.localeCompare(bTime) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.run_id.localeCompare(b.run_id);
  });
  return runs;
}

async function generate(summarize, request) {
  if (typeof summarize !== "function") {
    return {
      ok: false,
      called: false,
      status: "summarizer_required",
      failure: { message: "E2 requires an injected summarizer when a fold candidate exists" }
    };
  }
  try {
    const value = await summarize(request);
    const summary = typeof value === "string" ? value : value?.summary;
    if (typeof summary !== "string" || summary.trim().length === 0) {
      return {
        ok: false,
        called: true,
        status: "summarizer_failed",
        failure: { message: "Summarizer returned no usable summary" }
      };
    }
    const generator = {
      kind: value?.generator?.kind ?? "gateway-fold-engine",
      version: value?.generator?.version ?? FOLD_ENGINE_VERSION,
      ...(value?.generator?.provider ? { provider: value.generator.provider } : {}),
      ...(value?.generator?.model ? { model: value.generator.model } : {}),
      prompt_fingerprint: value?.generator?.prompt_fingerprint
        ?? `sha256:${sha256(stableStringify({
          engine: FOLD_ENGINE_VERSION,
          kind: request.kind,
          level: request.level,
          scope: request.scope,
          session_id: request.session_id
        }))}`
    };
    return {
      ok: true,
      called: true,
      summary: summary.trim(),
      generator
    };
  } catch (error) {
    return {
      ok: false,
      called: true,
      status: "summarizer_failed",
      failure: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error)
      }
    };
  }
}

function strictlySmaller(summary, inputBytes) {
  return Buffer.byteLength(summary.trim(), "utf8") < Number(inputBytes);
}

function result(status, fields) {
  return {
    schema_version: "1.0",
    api_version: FOLD_ENGINE_VERSION,
    status,
    ...fields
  };
}

function ratio(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new GatewayError("INVALID_FOLD_PRESSURE", `${label} must be between 0 and 1`, 400);
  }
  return number;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new GatewayError("INVALID_FOLD_POLICY", `${label} must be an integer between ${min} and ${max}`, 400);
  }
  return number;
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object") throw new GatewayError("INVALID_FOLD_SCOPE", "Fold scope is required", 400);
  const out = {};
  for (const key of ["system_id", "workspace_id", "principal"]) {
    out[key] = requiredText(scope[key], `scope.${key}`, 256);
  }
  return out;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new GatewayError("INVALID_FOLD_POLICY", `${label} must be non-empty text`, 400);
  }
  return value;
}

function sessionMatchesScope(session, scope) {
  return session.system_id === scope.system_id
    && session.workspace_id === scope.workspace_id
    && session.principal === scope.principal;
}

function runMatchesScope(run, scope) {
  return run.system_id === scope.system_id
    && run.workspace_id === scope.workspace_id
    && run.principal === scope.principal;
}

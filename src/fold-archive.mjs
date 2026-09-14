import { GatewayError } from "./errors.mjs";
import { atomicJson, sha256, stableStringify } from "./util.mjs";

export const FOLD_ARCHIVE_VERSION = "gateway.fold-archive.e3.v1";
export const DEFAULT_MAX_HITS = 5;
export const DEFAULT_MAX_UNFOLD_CARDS = 3;
export const DEFAULT_MAX_MESSAGES = 24;
export const DEFAULT_MAX_RAW_BYTES = 24000;

const PRECISION_TERMS = new Set([
  "exact", "exactly", "verbatim", "quote", "quoted", "original", "raw",
  "source", "path", "config", "configuration", "id", "identifier", "number",
  "date", "value", "literal", "wording", "text"
]);

export async function searchFoldArchive(store, options = {}) {
  const query = requiredText(options.query, "query", 4000);
  const scope = normalizeScope(options.scope);
  const sessionId = options.session_id == null ? null : requiredText(options.session_id, "session_id", 128);
  const maxHits = boundedInteger(options.max_hits, DEFAULT_MAX_HITS, 1, 20, "max_hits");
  const maxUnfoldCards = boundedInteger(
    options.max_unfold_cards,
    DEFAULT_MAX_UNFOLD_CARDS,
    1,
    10,
    "max_unfold_cards"
  );
  const maxMessages = boundedInteger(options.max_messages, DEFAULT_MAX_MESSAGES, 1, 100, "max_messages");
  const maxRawBytes = boundedInteger(options.max_raw_bytes, DEFAULT_MAX_RAW_BYTES, 256, 250000, "max_raw_bytes");
  const precision = options.precision === true || precisionIntent(query);

  const catalog = await store.rebuildFoldCatalog({ live_validation: true });
  const staleCardIds = catalog.cards
    .filter((entry) => sameScope(entry.scope, scope) && entry.live_validation_state !== "validated")
    .map((entry) => entry.card_id)
    .sort();

  const validEntries = catalog.cards.filter((entry) =>
    entry.validation_state === "validated"
    && entry.live_validation_state === "validated"
    && sameScope(entry.scope, scope)
  );

  const cards = [];
  for (const entry of validEntries) {
    const card = await store.getFoldCard(entry.card_id);
    if (sessionId && !(await cardBelongsToSession(store, card, sessionId))) continue;
    cards.push(card);
  }

  const referenced = new Set();
  for (const card of cards) {
    for (const ref of card.child_refs ?? []) referenced.add(ref.card_id);
  }
  const roots = cards.filter((card) => !referenced.has(card.card_id));

  const queryInfo = queryFeatures(query);
  const compact = cards
    .map((card) => ({
      card,
      score: textScore(card.summary, queryInfo),
      sort_key: compactSortKey(card)
    }))
    .filter((item) => item.score > 0)
    .sort(compareScored)
    .slice(0, maxHits)
    .map((item) => compactHit(item.card, item.score));

  let exactHits = [];
  let unfoldedCardIds = [];
  let truncated = false;
  let rawBytes = 0;

  if (precision) {
    const rootCandidates = roots
      .map((card) => ({
        card,
        score: textScore(card.summary, queryInfo),
        sort_key: compactSortKey(card)
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.card.level !== a.card.level) return b.card.level - a.card.level;
        return a.sort_key.localeCompare(b.sort_key);
      })
      .slice(0, maxUnfoldCards);

    const seenMessages = new Set();
    for (const candidate of rootCandidates) {
      if (exactHits.length >= maxMessages || rawBytes >= maxRawBytes) {
        truncated = true;
        break;
      }
      let sources;
      try {
        sources = await store.resolveFoldCardSources(candidate.card.card_id);
      } catch (error) {
        staleCardIds.push(candidate.card.card_id);
        continue;
      }
      unfoldedCardIds.push(candidate.card.card_id);

      for (const source of sources) {
        const ref = source.source_ref;
        for (let offset = 0; offset < source.messages.length; offset += 1) {
          const message = source.messages[offset];
          const messageIndex = Number(ref.start_index) + offset;
          const key = `${ref.run_id}:${messageIndex}`;
          if (seenMessages.has(key)) continue;
          seenMessages.add(key);

          const content = messageText(message);
          const score = textScore(content, queryInfo);
          if (score <= 0) continue;
          const bytes = Buffer.byteLength(content, "utf8");
          if (exactHits.length >= maxMessages || rawBytes + bytes > maxRawBytes) {
            truncated = true;
            break;
          }
          rawBytes += bytes;
          exactHits.push({
            record_type: "raw_gateway_message",
            score,
            run_id: ref.run_id,
            session_id: ref.session_id,
            message_index: messageIndex,
            role: String(message?.role ?? ""),
            content,
            source_ref: `gateway:run:${ref.run_id}:messages:${messageIndex}-${messageIndex}`,
            source_fingerprint: ref.fingerprint,
            unfolded_from_card_id: candidate.card.card_id
          });
        }
        if (truncated) break;
      }
    }

    exactHits.sort((a, b) =>
      b.score - a.score
      || a.run_id.localeCompare(b.run_id)
      || a.message_index - b.message_index
    );
    exactHits = exactHits.slice(0, maxHits);
  }

  const uniqueStale = [...new Set(staleCardIds)].sort();
  const refreshedCatalog = await persistArchiveValidationState(store, catalog, {
    scope,
    stale_card_ids: uniqueStale
  });

  return {
    schema_version: "1.0",
    api_version: FOLD_ARCHIVE_VERSION,
    query,
    scope,
    session_id: sessionId,
    precision,
    status: uniqueStale.length > 0 ? "stale_archive" : "ok",
    compact_hits: compact,
    exact_hits: exactHits,
    unfolded_card_ids: [...new Set(unfoldedCardIds)],
    stale_card_ids: uniqueStale,
    bounds: {
      max_hits: maxHits,
      max_unfold_cards: maxUnfoldCards,
      max_messages: maxMessages,
      max_raw_bytes: maxRawBytes
    },
    raw_bytes_returned: exactHits.reduce((sum, hit) => sum + Buffer.byteLength(hit.content, "utf8"), 0),
    truncated,
    catalog_fingerprint: refreshedCatalog.fingerprint
  };
}

export async function unfoldFoldCard(store, options = {}) {
  const cardId = requiredText(options.card_id, "card_id", 128);
  const scope = normalizeScope(options.scope);
  const maxMessages = boundedInteger(options.max_messages, DEFAULT_MAX_MESSAGES, 1, 100, "max_messages");
  const maxRawBytes = boundedInteger(options.max_raw_bytes, DEFAULT_MAX_RAW_BYTES, 256, 250000, "max_raw_bytes");

  const card = await store.getFoldCard(cardId);
  if (!sameScope(card.scope, scope)) {
    throw new GatewayError("FOLD_SCOPE_MISMATCH", "Fold card is not visible in requested scope", 403);
  }
  const validation = await store.validateFoldCard(cardId);
  if (!validation.valid) {
    await store.rebuildFoldCatalog({ live_validation: true });
    return {
      schema_version: "1.0",
      api_version: FOLD_ARCHIVE_VERSION,
      status: "stale_archive",
      card_id: cardId,
      stale_card_ids: [cardId],
      messages: [],
      truncated: false,
      validation_errors: validation.errors
    };
  }

  const sources = await store.resolveFoldCardSources(cardId);
  const messages = [];
  let rawBytes = 0;
  let truncated = false;
  for (const source of sources) {
    for (let offset = 0; offset < source.messages.length; offset += 1) {
      const message = source.messages[offset];
      const content = messageText(message);
      const bytes = Buffer.byteLength(content, "utf8");
      if (messages.length >= maxMessages || rawBytes + bytes > maxRawBytes) {
        truncated = true;
        break;
      }
      const messageIndex = Number(source.source_ref.start_index) + offset;
      rawBytes += bytes;
      messages.push({
        run_id: source.source_ref.run_id,
        session_id: source.source_ref.session_id,
        message_index: messageIndex,
        role: String(message?.role ?? ""),
        content,
        source_ref: `gateway:run:${source.source_ref.run_id}:messages:${messageIndex}-${messageIndex}`
      });
    }
    if (truncated) break;
  }

  return {
    schema_version: "1.0",
    api_version: FOLD_ARCHIVE_VERSION,
    status: "ok",
    card_id: cardId,
    fingerprint: card.fingerprint,
    messages,
    raw_bytes_returned: rawBytes,
    truncated
  };
}

async function persistArchiveValidationState(store, catalog, { scope, stale_card_ids }) {
  const stale = new Set(stale_card_ids);
  const cards = catalog.cards.map((entry) => {
    if (!sameScope(entry.scope, scope)) return entry;
    return {
      ...entry,
      archive_read_state: stale.has(entry.card_id) ? "stale" : "verified"
    };
  });
  const fingerprint = `sha256:${sha256(stableStringify(cards))}`;
  const refreshed = {
    ...catalog,
    fingerprint,
    archive_validation: {
      scope,
      stale_card_ids: [...stale].sort()
    },
    cards
  };
  await atomicJson(store.p.foldCatalog, refreshed);
  return refreshed;
}

async function cardBelongsToSession(store, card, sessionId, seen = new Set()) {
  if (seen.has(card.card_id)) return false;
  seen.add(card.card_id);
  try {
    if (card.level === 1) {
      return card.source_refs.length > 0 && card.source_refs.every((ref) => ref.session_id === sessionId);
    }
    for (const ref of card.child_refs ?? []) {
      const child = await store.getFoldCard(ref.card_id);
      if (!(await cardBelongsToSession(store, child, sessionId, seen))) return false;
    }
    return (card.child_refs ?? []).length > 0;
  } finally {
    seen.delete(card.card_id);
  }
}

function compactHit(card, score) {
  return {
    record_type: "fold_card",
    card_id: card.card_id,
    fingerprint: card.fingerprint,
    level: card.level,
    score,
    summary: card.summary,
    coverage: card.coverage,
    size_estimate: card.size_estimate,
    created_at: card.created_at
  };
}

function queryFeatures(query) {
  const tokens = tokenize(query);
  const phrases = [];
  for (const match of query.matchAll(/["“”]([^"“”]{1,240})["“”]/g)) {
    const phrase = String(match[1] ?? "").trim().toLocaleLowerCase();
    if (phrase) phrases.push(phrase);
  }
  return {
    tokens,
    phrases,
    normalized: query.toLocaleLowerCase()
  };
}

function textScore(text, queryInfo) {
  const normalized = String(text ?? "").toLocaleLowerCase();
  if (!normalized) return 0;
  let score = 0;
  for (const phrase of queryInfo.phrases) {
    if (normalized.includes(phrase)) score += 20 + phrase.length / 20;
  }
  const textTokens = new Set(tokenize(normalized));
  for (const token of queryInfo.tokens) {
    if (textTokens.has(token)) score += token.length >= 6 ? 3 : 1;
    else if (normalized.includes(token) && token.length >= 4) score += 0.5;
  }
  return Number(score.toFixed(3));
}

function precisionIntent(query) {
  if (/["“”][^"“”]{1,240}["“”]/.test(query)) return true;
  return tokenize(query).some((token) => PRECISION_TERMS.has(token));
}

function tokenize(text) {
  return [...new Set(
    String(text ?? "")
      .toLocaleLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? []
  )];
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return stableStringify(message?.content ?? "");
}

function compactSortKey(card) {
  return `${card.created_at ?? ""}:${card.card_id}`;
}

function compareScored(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.card.level !== a.card.level) return b.card.level - a.card.level;
  return a.sort_key.localeCompare(b.sort_key);
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new GatewayError("INVALID_ARCHIVE_BOUND", `${label} must be an integer between ${min} and ${max}`, 400);
  }
  return number;
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object") throw new GatewayError("INVALID_FOLD_SCOPE", "Archive scope is required", 400);
  const out = {};
  for (const key of ["system_id", "workspace_id", "principal"]) {
    out[key] = requiredText(scope[key], `scope.${key}`, 256);
  }
  return out;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new GatewayError("INVALID_ARCHIVE_REQUEST", `${label} must be non-empty text`, 400);
  }
  return value.trim();
}

function sameScope(a, b) {
  return a?.system_id === b.system_id
    && a?.workspace_id === b.workspace_id
    && a?.principal === b.principal;
}

import { GatewayError } from "./errors.mjs";
import { sha256, stableStringify } from "./util.mjs";

export const PROGRESSIVE_CONTEXT_VERSION = "gateway.progressive-context.g1.v1";
export const PROGRESSIVE_HISTORY_VERSION = "memory.progressive-recall.v1";
export const PROGRESSIVE_HISTORY_OPERATION = "retrieve_history_progressive";
export const RUNTIME_DEEP_RETRIEVAL_VERSION = "gateway.deep-retrieval.g2.v1";
export const RUNTIME_DEEP_LIMITS = Object.freeze({
  summary: Object.freeze({ max_limit: 6, max_bytes: 8192 }),
  detail: Object.freeze({ max_limit: 4, max_bytes: 12288 }),
  source: Object.freeze({ max_limit: 1, max_bytes: 16384 })
});

const DEPTHS = ["catalog", "summary", "detail", "source"];
const BUDGETS = {
  catalog: { limit: 6, max_bytes: 4096 },
  summary: { limit: 6, max_bytes: 8192 },
  detail: { limit: 4, max_bytes: 12288 },
  source: { limit: 1, max_bytes: 16384 }
};
const LEGACY_MAX_BYTES = 16384;
const GATEWAY_SOURCE_MAX_BYTES = 24000;
const GATEWAY_SOURCE_MAX_MESSAGES = 24;

const HISTORY_RE = /\b(previous(?:ly)?|prior|earlier|before|history|historical|old(?:er)?|last\s+time|past|used\s+to|remember|what\s+did|when\s+did|where\s+did|who\s+did|did\s+we|we\s+(?:decided|agreed)|was\s+the|were\s+the)\b/i;
const DETAIL_RE = /\b(correction|corrected|supersed(?:e|ed)|replaced|replacement|provenance|origin|derived|evidence|source)\b/i;
const EXACT_RE = /\b(exact(?:ly)?|verbatim|quote(?:d)?|original\s+wording|literal|source|evidence|provenance|file\s+path|path|config(?:uration)?|identifier|\bid\b|sha(?:256)?|hash|commit|version|line\s+number|exact\s+date|date|exact\s+number|what\s+number|what\s+value|what\s+date|which\s+file|which\s+path|when\s+exactly)\b/i;

export function classifyProgressiveContextNeed(query = "") {
  const text = String(query ?? "").trim();
  const exact = EXACT_RE.test(text);
  const detail = exact || DETAIL_RE.test(text);
  const historical = detail || HISTORY_RE.test(text);
  const depth = exact ? "source" : detail ? "detail" : historical ? "summary" : "catalog";
  return {
    depth,
    historical,
    detail_sensitive: detail,
    exact_sensitive: exact
  };
}

export async function assembleProgressiveOwnerContext({
  host,
  store,
  run,
  scope,
  query,
  signal
}) {
  if (!host) throw new GatewayError("CONTEXT_HOST_REQUIRED", "Progressive context assembly requires the OS host", 500);
  const text = String(query ?? "").trim();
  const intent = classifyProgressiveContextNeed(text);

  const [description, current, capabilities, connections] = await Promise.all([
    host.describe(signal),
    host.readContext(scope, signal),
    host.listCapabilities(scope, signal),
    host.listConnections(scope, signal)
  ]);

  const operations = Array.isArray(description?.operations) ? description.operations : [];
  const progressiveAvailable = operations.includes(PROGRESSIVE_HISTORY_OPERATION);
  const history = {
    mode: progressiveAvailable ? "progressive" : "legacy_compatibility",
    catalog: null,
    summary: null,
    detail: null,
    source: null,
    gateway_exact_source: null,
    legacy: []
  };
  const diagnostics = {
    schema_version: "1.0",
    api_version: PROGRESSIVE_CONTEXT_VERSION,
    query_fingerprint: `sha256:${sha256(text)}`,
    requested_depth: intent.depth,
    realized_depths: [],
    progressive_available: progressiveAvailable,
    intent_class: intent.exact_sensitive ? "exact" : intent.detail_sensitive ? "detail" : intent.historical ? "historical" : "ordinary",
    exact_sensitive: intent.exact_sensitive,
    source_reads: 0,
    gateway_source_range_reads: 0,
    legacy_reads: 0,
    fallback_reason: null,
    bytes_by_depth: {},
    item_counts: {}
  };

  if (progressiveAvailable) {
    history.catalog = await progressiveRead(host, {
      depth: "catalog",
      scope,
      query: "",
      ...BUDGETS.catalog
    }, signal);
    recordDepth(diagnostics, "catalog", history.catalog);

    if (atLeast(intent.depth, "summary")) {
      history.summary = await progressiveRead(host, {
        depth: "summary",
        scope,
        query: text,
        ...BUDGETS.summary
      }, signal);
      recordDepth(diagnostics, "summary", history.summary);
    }

    if (atLeast(intent.depth, "detail")) {
      history.detail = await progressiveRead(host, {
        depth: "detail",
        scope,
        query: text,
        ...BUDGETS.detail
      }, signal);
      recordDepth(diagnostics, "detail", history.detail);
    }

    if (intent.depth === "source") {
      const evidenceRef = selectEvidenceRef(history.detail);
      if (!evidenceRef) {
        diagnostics.fallback_reason = "no_detail_evidence";
      } else {
        diagnostics.source_reads += 1;
        history.source = await progressiveRead(host, {
          depth: "source",
          scope,
          query: text,
          evidence_ref: evidenceRef,
          ...BUDGETS.source
        }, signal);
        recordDepth(diagnostics, "source", history.source);

        if (history.source?.status === "external_source_required") {
          history.gateway_exact_source = await resolveGatewayExternalSource({
            store,
            requestRun: run,
            scope,
            query: text,
            sourceResponse: history.source
          });
          diagnostics.gateway_source_range_reads = Number(history.gateway_exact_source?.source_range_reads ?? 0);
          diagnostics.bytes_by_depth.gateway_exact_source = serializedBytes(history.gateway_exact_source);
          diagnostics.item_counts.gateway_exact_source = Number(history.gateway_exact_source?.messages?.length ?? 0);
          if (history.gateway_exact_source?.status !== "ok") {
            diagnostics.fallback_reason = history.gateway_exact_source?.reason ?? "external_source_unavailable";
          }
        } else if (history.source?.status && history.source.status !== "ok") {
          diagnostics.fallback_reason = String(history.source.reason ?? history.source.status);
        }
      }
    }
  } else if (intent.depth !== "catalog" && text) {
    const legacy = await host.retrieveHistory(text, scope, signal);
    diagnostics.legacy_reads = 1;
    history.legacy = boundLegacyRows(legacy, LEGACY_MAX_BYTES);
    diagnostics.realized_depths.push("legacy");
    diagnostics.bytes_by_depth.legacy = serializedBytes(history.legacy);
    diagnostics.item_counts.legacy = history.legacy.length;
    diagnostics.fallback_reason = "progressive_bridge_unavailable";
  } else {
    diagnostics.fallback_reason = progressiveAvailable ? null : "progressive_bridge_unavailable_no_deep_need";
  }

  const safe = {
    host: {
      adapter_id: description?.adapter_id ?? null,
      metadata: description?.metadata ?? null
    },
    current_context: current,
    context_ladder: {
      api_version: PROGRESSIVE_CONTEXT_VERSION,
      l0: {
        canonical_raw_messages_supplied_separately: true,
        raw_message_count: publicMessages(run?.messages ?? []).length
      },
      owner_history: history,
      retrieval: promptDiagnostics(diagnostics)
    },
    capabilities,
    connections
  };

  return { safe, diagnostics };
}

export async function retrieveRuntimeDeepContext({
  host,
  store,
  run,
  scope,
  depth,
  query,
  limit,
  max_bytes,
  evidence_ref = null,
  signal
}) {
  const normalizedDepth = String(depth ?? "").trim();
  const bounds = RUNTIME_DEEP_LIMITS[normalizedDepth];
  if (!bounds) {
    throw new GatewayError("CONTEXT_RETRIEVAL_DEPTH_INVALID", "Runtime deep retrieval depth must be summary, detail, or source", 400);
  }
  const normalizedQuery = String(query ?? "").trim().replace(/\s+/g, " ");
  if (!normalizedQuery || normalizedQuery.length > 4096) {
    throw new GatewayError("CONTEXT_RETRIEVAL_QUERY_INVALID", "Runtime deep retrieval query must be 1..4096 characters", 400);
  }

  const requestedLimit = limit == null ? bounds.max_limit : Number(limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > bounds.max_limit) {
    throw new GatewayError(
      "CONTEXT_RETRIEVAL_BUDGET_EXCEEDED",
      `Runtime ${normalizedDepth} retrieval limit must be between 1 and ${bounds.max_limit}`,
      409
    );
  }
  const requestedBytes = max_bytes == null ? bounds.max_bytes : Number(max_bytes);
  if (!Number.isInteger(requestedBytes) || requestedBytes < 4096 || requestedBytes > bounds.max_bytes) {
    throw new GatewayError(
      "CONTEXT_RETRIEVAL_BUDGET_EXCEEDED",
      `Runtime ${normalizedDepth} retrieval max_bytes must be between 4096 and ${bounds.max_bytes}`,
      409
    );
  }

  if (normalizedDepth === "source") {
    if (!evidence_ref || typeof evidence_ref !== "object" || Array.isArray(evidence_ref)) {
      throw new GatewayError("CONTEXT_RETRIEVAL_EVIDENCE_REQUIRED", "Source retrieval requires a prior detail evidence_ref", 400);
    }
    assertEvidenceScope(evidence_ref, scope);
    if (serializedBytes(evidence_ref) > 32768) {
      throw new GatewayError("CONTEXT_RETRIEVAL_EVIDENCE_TOO_LARGE", "Source evidence_ref exceeds the Gateway safety bound", 409);
    }
  } else if (evidence_ref != null) {
    throw new GatewayError("CONTEXT_RETRIEVAL_EVIDENCE_INVALID", "evidence_ref is only allowed for source retrieval", 400);
  }

  const description = await host.describe(signal);
  const operations = Array.isArray(description?.operations) ? description.operations : [];
  if (!operations.includes(PROGRESSIVE_HISTORY_OPERATION)) {
    throw new GatewayError("CONTEXT_RETRIEVAL_UNAVAILABLE", "OS host does not expose progressive Memory retrieval", 409);
  }

  const ownerResult = await progressiveRead(host, {
    depth: normalizedDepth,
    scope,
    query: normalizedQuery,
    limit: requestedLimit,
    max_bytes: requestedBytes,
    ...(normalizedDepth === "source" ? { evidence_ref } : {})
  }, signal);
  if (serializedBytes(ownerResult) > requestedBytes) {
    throw new GatewayError("CONTEXT_RETRIEVAL_RESULT_TOO_LARGE", "Owner progressive retrieval exceeded the Gateway-requested byte budget", 502);
  }

  let gatewayExactSource = null;
  if (normalizedDepth === "source" && ownerResult?.status === "external_source_required") {
    gatewayExactSource = await resolveGatewayExternalSource({
      store,
      requestRun: run,
      scope,
      query: normalizedQuery,
      sourceResponse: ownerResult,
      maxBytes: Math.max(1024, requestedBytes - 2048),
      maxMessages: GATEWAY_SOURCE_MAX_MESSAGES
    });
  }

  const result = {
    schema_version: "1.0",
    api_version: RUNTIME_DEEP_RETRIEVAL_VERSION,
    depth: normalizedDepth,
    scope,
    owner_result: ownerResult,
    gateway_exact_source: gatewayExactSource
  };
  enforceRuntimeResultBudget(result, requestedBytes);

  return {
    result,
    diagnostics: {
      schema_version: "1.0",
      api_version: RUNTIME_DEEP_RETRIEVAL_VERSION,
      depth: normalizedDepth,
      query_fingerprint: `sha256:${sha256(normalizedQuery)}`,
      limit: requestedLimit,
      max_bytes: requestedBytes,
      owner: "ai-verse-memory",
      source_read: normalizedDepth === "source",
      gateway_source_range_reads: Number(gatewayExactSource?.source_range_reads ?? 0),
      result_bytes: serializedBytes(result),
      result_status: gatewayExactSource?.status ?? ownerResult?.status ?? "ok"
    }
  };
}

function assertEvidenceScope(evidenceRef, boundScope) {
  const evidenceScope = String(evidenceRef?.scope ?? "");
  const allowed = boundScope === "operator"
    ? ["operator"]
    : [boundScope, "operator"];
  if (!allowed.includes(evidenceScope)) {
    throw new GatewayError("CONTEXT_RETRIEVAL_SCOPE_ESCAPE", "Runtime evidence_ref is outside the run's bound visibility", 403);
  }
}

function enforceRuntimeResultBudget(result, maxBytes) {
  if (serializedBytes(result) <= maxBytes) return;
  const exact = result.gateway_exact_source;
  if (exact && Array.isArray(exact.messages)) {
    while (exact.messages.length > 0 && serializedBytes(result) > maxBytes) {
      exact.messages.pop();
      exact.truncated = true;
    }
    exact.raw_bytes_returned = exact.messages.reduce(
      (sum, item) => sum + Buffer.byteLength(String(item?.content ?? ""), "utf8"),
      0
    );
  }
  if (serializedBytes(result) > maxBytes) {
    throw new GatewayError("CONTEXT_RETRIEVAL_RESULT_TOO_LARGE", "Combined deep retrieval result cannot fit the requested byte budget", 502);
  }
}

async function progressiveRead(host, payload, signal) {
  return await host.retrieveHistoryProgressive({
    version: PROGRESSIVE_HISTORY_VERSION,
    ...payload
  }, signal);
}

function atLeast(requested, threshold) {
  return DEPTHS.indexOf(requested) >= DEPTHS.indexOf(threshold);
}

function recordDepth(diagnostics, depth, value) {
  diagnostics.realized_depths.push(depth);
  diagnostics.bytes_by_depth[depth] = serializedBytes(value);
  diagnostics.item_counts[depth] = Array.isArray(value?.items)
    ? value.items.length
    : value?.catalog ? 1 : value ? 1 : 0;
}

function selectEvidenceRef(detail) {
  const items = Array.isArray(detail?.items) ? detail.items : [];
  return items.find((item) =>
    item &&
    typeof item === "object" &&
    item.deeper_evidence_available === true &&
    ["indexed_record", "session_digest"].includes(item.record_type) &&
    typeof item.id === "string" &&
    typeof item.scope === "string" &&
    item.evidence &&
    typeof item.evidence === "object"
  ) ?? null;
}

async function resolveGatewayExternalSource({
  store,
  requestRun,
  scope,
  query,
  sourceResponse,
  maxBytes = GATEWAY_SOURCE_MAX_BYTES,
  maxMessages = GATEWAY_SOURCE_MAX_MESSAGES
}) {
  if (!store || !requestRun) {
    return externalFailure("gateway_store_unavailable");
  }
  const evidence = sourceResponse?.evidence;
  const coverageRefs = Array.isArray(evidence?.source_coverage)
    ? evidence.source_coverage
    : [];
  const externalRefs = Array.isArray(evidence?.external_source_refs)
    ? evidence.external_source_refs
    : [];
  const refs = coverageRefs.length > 0 ? coverageRefs : externalRefs;
  if (refs.length === 0) return externalFailure("external_source_refs_missing");

  const parsed = refs.slice(0, 8).map(parseGatewaySourceRef);
  if (parsed.some((item) => item === null)) return externalFailure("external_source_ref_invalid");
  const runIds = [...new Set(parsed.map((item) => item.run_id))];
  if (runIds.length !== 1) return externalFailure("external_source_multi_run_unsupported");

  const sourceRun = await store.getRun(runIds[0]);
  if (!sourceRun) return externalFailure("external_source_run_missing");
  assertRunVisible(sourceRun, requestRun, scope);

  const publicSourceMessages = publicMessages(sourceRun.messages ?? []);
  const expectedFingerprint = String(evidence?.source_fingerprint ?? "");
  if (expectedFingerprint) {
    const actual = `sha256:${sha256(stableStringify(publicSourceMessages))}`;
    if (actual !== expectedFingerprint) {
      return {
        ...externalFailure("source_fingerprint_mismatch", "stale"),
        expected_source_fingerprint: expectedFingerprint,
        actual_source_fingerprint: actual
      };
    }
  }

  const candidates = [];
  for (const ref of parsed) {
    if (
      ref.start_index < 0 ||
      ref.end_index < ref.start_index ||
      ref.end_index >= publicSourceMessages.length
    ) return externalFailure("external_source_range_invalid");
    for (let index = ref.start_index; index <= ref.end_index; index += 1) {
      const message = publicSourceMessages[index];
      candidates.push({
        run_id: ref.run_id,
        session_id: sourceRun.session_id,
        message_index: index,
        role: String(message?.role ?? ""),
        content: messageText(message),
        source_ref: `gateway:run:${ref.run_id}:messages:${index}-${index}`,
        score: relevanceScore(messageText(message), query)
      });
    }
  }

  const chosen = chooseBoundedMessages(candidates, maxMessages, maxBytes);
  return {
    schema_version: "1.0",
    kind: "gateway_exact_source",
    status: "ok",
    exact_evidence: true,
    source_range_reads: parsed.length,
    source_fingerprint: expectedFingerprint || null,
    messages: chosen,
    truncated: chosen.length < candidates.length,
    raw_bytes_returned: chosen.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0)
  };
}

function assertRunVisible(sourceRun, requestRun, scope) {
  if (
    sourceRun.system_id !== requestRun.system_id ||
    sourceRun.principal !== requestRun.principal
  ) throw new GatewayError("CONTEXT_SOURCE_SCOPE_MISMATCH", "Exact Gateway source is outside the authenticated system/principal scope", 403);

  if (scope === "operator") {
    if (sourceRun.workspace_id !== "operator") {
      throw new GatewayError("CONTEXT_SOURCE_SCOPE_MISMATCH", "Operator context cannot descend into workspace-only Gateway history", 403);
    }
    return;
  }
  const match = /^workspace:(.+)$/.exec(String(scope));
  if (!match) throw new GatewayError("CONTEXT_SOURCE_SCOPE_INVALID", "Progressive context scope is invalid", 500);
  if (![match[1], "operator"].includes(sourceRun.workspace_id)) {
    throw new GatewayError("CONTEXT_SOURCE_SCOPE_MISMATCH", "Exact Gateway source is outside the requested workspace visibility", 403);
  }
}

function parseGatewaySourceRef(value) {
  if (typeof value !== "string") return null;
  const match = /^gateway:run:(.+):messages:(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  return {
    run_id: match[1],
    start_index: Number(match[2]),
    end_index: Number(match[3])
  };
}

function externalFailure(reason, status = "unavailable") {
  return {
    schema_version: "1.0",
    kind: "gateway_exact_source",
    status,
    exact_evidence: false,
    reason,
    source_range_reads: 0,
    messages: [],
    truncated: false,
    raw_bytes_returned: 0
  };
}

function chooseBoundedMessages(candidates, maxMessages, maxBytes) {
  const totalBytes = candidates.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0);
  if (candidates.length <= maxMessages && totalBytes <= maxBytes) {
    return candidates.map(stripScore);
  }

  const ranked = [...candidates].sort((a, b) =>
    b.score - a.score ||
    b.message_index - a.message_index
  );
  const selected = [];
  let bytes = 0;
  for (const item of ranked) {
    if (selected.length >= maxMessages) break;
    const itemBytes = Buffer.byteLength(item.content, "utf8");
    if (bytes + itemBytes > maxBytes) continue;
    selected.push(item);
    bytes += itemBytes;
  }
  selected.sort((a, b) =>
    a.run_id.localeCompare(b.run_id) ||
    a.message_index - b.message_index
  );
  return selected.map(stripScore);
}

function relevanceScore(content, query) {
  const haystack = String(content ?? "").toLocaleLowerCase();
  const terms = [...new Set(String(query ?? "").toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])]
    .filter((term) => !["what", "when", "where", "which", "exact", "exactly", "previously", "before", "about", "from"].includes(term));
  if (terms.length === 0) return 0;
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function stripScore(item) {
  const { score, ...clean } = item;
  return clean;
}

function boundLegacyRows(rows, maxBytes) {
  if (!Array.isArray(rows)) return [];
  const result = [];
  for (const row of rows.slice(0, 12)) {
    const candidate = [...result, row];
    if (serializedBytes(candidate) > maxBytes) break;
    result.push(row);
  }
  return result;
}

function promptDiagnostics(diagnostics) {
  return {
    requested_depth: diagnostics.requested_depth,
    realized_depths: diagnostics.realized_depths,
    progressive_available: diagnostics.progressive_available,
    exact_sensitive: diagnostics.exact_sensitive,
    source_reads: diagnostics.source_reads,
    gateway_source_range_reads: diagnostics.gateway_source_range_reads,
    legacy_reads: diagnostics.legacy_reads,
    fallback_reason: diagnostics.fallback_reason,
    bytes_by_depth: diagnostics.bytes_by_depth,
    item_counts: diagnostics.item_counts
  };
}

function publicMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const {
      _gateway_context,
      _gateway_continuation,
      _gateway_automation_wake,
      ...publicMessage
    } = message ?? {};
    return publicMessage;
  });
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) =>
      typeof part === "string" ? part : typeof part?.text === "string" ? part.text : stableStringify(part)
    ).join("\n");
  }
  return stableStringify(message?.content ?? "");
}

function serializedBytes(value) {
  return Buffer.byteLength(stableStringify(value ?? null), "utf8");
}

export const PURPOSE_RUNTIME_POLICY_VERSION = "gateway.purpose-runtime-policy.v1";
export const PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES = 16384;
export const PURPOSE_REFRESH_POLICY_VERSION = "gateway.purpose-refresh-policy.v1";
export const PURPOSE_UNAVAILABLE_POLICY_VERSION = "gateway.purpose-unavailable-policy.v1";
export const PURPOSE_PRECEDENCE_POLICY_VERSION = "gateway.purpose-precedence-policy.v1";

const PURPOSE_OWNER_UNAVAILABLE_CODES = new Set([
  "PURPOSE_OWNER_UNAVAILABLE",
  "ADAPTER_TIMEOUT",
  "ADAPTER_FAILED",
  "ADAPTER_INVALID_JSON",
  "ENOENT",
  "EACCES",
]);

export function assertPurposeRuntimeEnvelopeSize(value, serializedBytes) {
  if (typeof serializedBytes !== "function") {
    throw new TypeError("serializedBytes must be a function");
  }
  const bytes = serializedBytes(value);
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new TypeError("serializedBytes must return a non-negative integer");
  }
  return {
    api_version: PURPOSE_RUNTIME_POLICY_VERSION,
    max_envelope_bytes: PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES,
    envelope_bytes: bytes,
    within_budget: bytes <= PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES,
  };
}

export function purposeRefreshDecision(relevance) {
  const purposeRelevant = relevance?.purpose_relevant === true;
  if (!purposeRelevant) {
    return Object.freeze({
      api_version: PURPOSE_REFRESH_POLICY_VERSION,
      refresh_required: false,
      cache_reuse_allowed: false,
      reason: "irrelevant_task",
    });
  }
  return Object.freeze({
    api_version: PURPOSE_REFRESH_POLICY_VERSION,
    refresh_required: true,
    cache_reuse_allowed: false,
    reason: "relevant_context_assembly",
  });
}

export function purposeUnavailableDecision(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const ownerUnavailable = code !== null && PURPOSE_OWNER_UNAVAILABLE_CODES.has(code);
  return Object.freeze({
    api_version: PURPOSE_UNAVAILABLE_POLICY_VERSION,
    owner_unavailable: ownerUnavailable,
    ordinary_task_may_continue: ownerUnavailable,
    stale_fallback_allowed: false,
    error_code: code,
    reason: ownerUnavailable ? "purpose_owner_unavailable" : "nonavailability_contract_error",
  });
}

export function selectPurposeRuntimeProjection(freshOwnerProjection, cachedUiOrOutputProjection = null) {
  const freshOwnerPresent = freshOwnerProjection !== null && freshOwnerProjection !== undefined;
  const cachedCandidatePresent = cachedUiOrOutputProjection !== null && cachedUiOrOutputProjection !== undefined;
  return Object.freeze({
    api_version: PURPOSE_PRECEDENCE_POLICY_VERSION,
    projection: freshOwnerPresent ? freshOwnerProjection : null,
    source: freshOwnerPresent ? "fresh_owner_read" : "none",
    fresh_owner_present: freshOwnerPresent,
    cached_candidate_present: cachedCandidatePresent,
    cached_candidate_ignored: cachedCandidatePresent,
    stale_fallback_allowed: false,
  });
}

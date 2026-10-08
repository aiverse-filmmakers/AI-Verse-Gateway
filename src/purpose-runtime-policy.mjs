export const PURPOSE_RUNTIME_POLICY_VERSION = "gateway.purpose-runtime-policy.v1";
export const PURPOSE_RUNTIME_MAX_ENVELOPE_BYTES = 16384;

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

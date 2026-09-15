import { GatewayError } from "./errors.mjs";
import { stableStringify } from "./util.mjs";

export const CONTEXT_GOVERNOR_VERSION = "gateway.context-governor.e4.v1";

export function estimateInvocationTokens(messages, config) {
  const normalized = normalizeConfig(config);
  if (!normalized.enabled) return null;
  const bytes = Buffer.byteLength(stableStringify(messages ?? []), "utf8");
  return Math.ceil(bytes / normalized.chars_per_token_estimate);
}

export async function governInvocationContext({
  messages,
  config,
  cache_sensitive = false,
  summarize = null
} = {}) {
  const input = Array.isArray(messages) ? messages.map(cloneMessage) : [];
  const policy = normalizeConfig(config);
  if (!policy.enabled) {
    return {
      messages: input,
      diagnostic: diagnostic("unconfigured", policy, {
        pressure_before: null,
        pressure_after: null,
        estimated_tokens_before: null,
        estimated_tokens_after: null,
        raw_tail_messages: input.length,
        prefix_messages: 0,
        fold_scheduled: false,
        cache_sensitive_skip: false
      })
    };
  }

  const beforeTokens = estimateTokens(input, policy);
  const beforePressure = beforeTokens / policy.window_tokens;
  if (beforePressure < policy.soft_pressure_ratio) {
    return {
      messages: input,
      diagnostic: diagnostic("below_soft_threshold", policy, {
        pressure_before: beforePressure,
        pressure_after: beforePressure,
        estimated_tokens_before: beforeTokens,
        estimated_tokens_after: beforeTokens,
        raw_tail_messages: input.length,
        prefix_messages: 0,
        fold_scheduled: false,
        cache_sensitive_skip: false
      })
    };
  }

  if (beforePressure < policy.hard_pressure_ratio) {
    const skipped = policy.cache_sensitive_skip && cache_sensitive === true;
    return {
      messages: input,
      diagnostic: diagnostic(skipped ? "soft_cache_preserved" : "soft_fold_scheduled", policy, {
        pressure_before: beforePressure,
        pressure_after: beforePressure,
        estimated_tokens_before: beforeTokens,
        estimated_tokens_after: beforeTokens,
        raw_tail_messages: input.length,
        prefix_messages: 0,
        fold_scheduled: !skipped,
        cache_sensitive_skip: skipped
      })
    };
  }

  if (typeof summarize !== "function") {
    throw pressureError("CONTEXT_COMPACTION_UNAVAILABLE", "Hard context pressure requires a summarizer before runtime invocation", {
      pressure: beforePressure,
      estimated_tokens: beforeTokens,
      window_tokens: policy.window_tokens
    });
  }

  const protectedSystem = input.filter((message) => message?.role === "system");
  const conversational = input.filter((message) => message?.role !== "system");
  if (conversational.length === 0) {
    throw pressureError("CONTEXT_PRESSURE_UNRESOLVED", "System context alone exceeds the configured hard context threshold", {
      pressure: beforePressure,
      estimated_tokens: beforeTokens,
      window_tokens: policy.window_tokens
    });
  }

  let tailCount = Math.min(policy.recent_raw_tail_messages, conversational.length);
  let tail = conversational.slice(-tailCount);
  let prefix = conversational.slice(0, conversational.length - tailCount);
  const hardLimit = Math.max(1, Math.floor(policy.window_tokens * policy.hard_pressure_ratio));
  const softLimit = Math.max(1, Math.floor(policy.window_tokens * policy.soft_pressure_ratio));
  let emergencyTailShrink = false;

  while (tailCount > 1 && estimateTokens([...protectedSystem, ...tail], policy) >= hardLimit) {
    tailCount -= 1;
    emergencyTailShrink = true;
    tail = conversational.slice(-tailCount);
    prefix = conversational.slice(0, conversational.length - tailCount);
  }

  const protectedTailTokens = estimateTokens([...protectedSystem, ...tail], policy);
  if (protectedTailTokens >= hardLimit) {
    throw pressureError("CONTEXT_RECENT_TAIL_TOO_LARGE", "The most recent verbatim context cannot fit below the configured hard threshold", {
      pressure: beforePressure,
      protected_tail_tokens: protectedTailTokens,
      hard_limit_tokens: hardLimit,
      raw_tail_messages: tailCount
    });
  }
  if (prefix.length === 0) {
    throw pressureError("CONTEXT_PRESSURE_UNRESOLVED", "Hard context pressure cannot be reduced without altering the protected recent raw tail", {
      pressure: beforePressure,
      protected_tail_tokens: protectedTailTokens,
      raw_tail_messages: tailCount
    });
  }

  const prefixTokens = estimateTokens(prefix, policy);
  const summaryBudget = Math.max(
    1,
    Math.min(
      prefixTokens - 1,
      softLimit - protectedTailTokens - policy.summary_wrapper_token_reserve
    )
  );
  if (summaryBudget < 1) {
    throw pressureError("CONTEXT_PRESSURE_UNRESOLVED", "No safe summary budget remains below the configured pressure target", {
      pressure: beforePressure,
      protected_tail_tokens: protectedTailTokens,
      soft_limit_tokens: softLimit
    });
  }

  let generated;
  try {
    generated = await summarize({
      messages: prefix.map(cloneMessage),
      max_output_tokens: summaryBudget,
      target_tokens: summaryBudget,
      covered_message_count: prefix.length,
      recent_raw_tail_messages: tailCount
    });
  } catch (error) {
    throw pressureError("CONTEXT_COMPACTION_FAILED", "Context summarization failed before runtime invocation", {
      cause: error?.message ?? String(error)
    });
  }

  const summary = typeof generated === "string" ? generated.trim() : String(generated?.summary ?? "").trim();
  if (!summary) {
    throw pressureError("CONTEXT_COMPACTION_FAILED", "Context summarizer returned no usable compacted history");
  }
  const prefixBytes = Buffer.byteLength(stableStringify(prefix), "utf8");
  const summaryBytes = Buffer.byteLength(summary, "utf8");
  if (summaryBytes >= prefixBytes) {
    throw pressureError("CONTEXT_COMPACTION_NOT_SMALLER", "Compacted context must be strictly smaller than the older raw prefix", {
      prefix_bytes: prefixBytes,
      summary_bytes: summaryBytes
    });
  }

  const compactMessage = {
    role: "system",
    content: [
      "AI-Verse compacted earlier conversation context.",
      "This is derived context only. Recent messages below remain canonical verbatim context.",
      `Covered earlier messages: ${prefix.length}.`,
      summary
    ].join("\n")
  };
  const output = [...protectedSystem.map(cloneMessage), compactMessage, ...tail.map(cloneMessage)];
  const afterTokens = estimateTokens(output, policy);
  const afterPressure = afterTokens / policy.window_tokens;
  if (afterTokens >= hardLimit) {
    throw pressureError("CONTEXT_PRESSURE_UNRESOLVED", "Compaction did not reduce invocation context below the configured hard threshold", {
      pressure_before: beforePressure,
      pressure_after: afterPressure,
      estimated_tokens_before: beforeTokens,
      estimated_tokens_after: afterTokens,
      hard_limit_tokens: hardLimit
    });
  }

  return {
    messages: output,
    diagnostic: diagnostic(emergencyTailShrink ? "hard_compacted_tail_shrunk" : "hard_compacted", policy, {
      pressure_before: beforePressure,
      pressure_after: afterPressure,
      estimated_tokens_before: beforeTokens,
      estimated_tokens_after: afterTokens,
      raw_tail_messages: tailCount,
      prefix_messages: prefix.length,
      fold_scheduled: true,
      cache_sensitive_skip: false,
      emergency_tail_shrink: emergencyTailShrink,
      summary_tokens_estimate: estimateTokens([compactMessage], policy),
      summary_target_tokens: summaryBudget
    })
  };
}

function normalizeConfig(config) {
  const source = config ?? {};
  const window = source.window_tokens == null ? null : Number(source.window_tokens);
  const soft = numberOr(source.soft_pressure_ratio, 0.72);
  const hard = numberOr(source.hard_pressure_ratio, 0.88);
  const tail = integerOr(source.recent_raw_tail_messages, 8);
  const chars = numberOr(source.chars_per_token_estimate, 4);
  const reserve = integerOr(source.summary_wrapper_token_reserve, 32);
  const enabled = Number.isInteger(window) && window >= 256;

  if (!(soft > 0 && soft < 1)) throw new GatewayError("CONTEXT_CONFIG_INVALID", "soft_pressure_ratio must be between 0 and 1", 500);
  if (!(hard > soft && hard <= 1)) throw new GatewayError("CONTEXT_CONFIG_INVALID", "hard_pressure_ratio must be greater than soft_pressure_ratio and at most 1", 500);
  if (!Number.isInteger(tail) || tail < 1 || tail > 200) throw new GatewayError("CONTEXT_CONFIG_INVALID", "recent_raw_tail_messages must be an integer between 1 and 200", 500);
  if (!(chars >= 1 && chars <= 16)) throw new GatewayError("CONTEXT_CONFIG_INVALID", "chars_per_token_estimate must be between 1 and 16", 500);
  if (!Number.isInteger(reserve) || reserve < 0 || reserve > 2048) throw new GatewayError("CONTEXT_CONFIG_INVALID", "summary_wrapper_token_reserve must be an integer between 0 and 2048", 500);

  return {
    enabled,
    window_tokens: enabled ? window : null,
    soft_pressure_ratio: soft,
    hard_pressure_ratio: hard,
    recent_raw_tail_messages: tail,
    chars_per_token_estimate: chars,
    summary_wrapper_token_reserve: reserve,
    cache_sensitive_skip: source.cache_sensitive_skip !== false
  };
}

function estimateTokens(messages, policy) {
  const bytes = Buffer.byteLength(stableStringify(messages ?? []), "utf8");
  return Math.ceil(bytes / policy.chars_per_token_estimate);
}

function diagnostic(status, policy, detail) {
  return {
    schema_version: "1.0",
    api_version: CONTEXT_GOVERNOR_VERSION,
    status,
    configured: policy.enabled,
    window_tokens: policy.window_tokens,
    soft_pressure_ratio: policy.soft_pressure_ratio,
    hard_pressure_ratio: policy.hard_pressure_ratio,
    recent_raw_tail_limit: policy.recent_raw_tail_messages,
    ...detail
  };
}

function pressureError(code, message, details = undefined) {
  return new GatewayError(code, message, 409, details);
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function numberOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return Number(value);
}

function integerOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return Number(value);
}

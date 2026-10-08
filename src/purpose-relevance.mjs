const PURPOSE_RELEVANCE_VERSION = 'gateway.purpose-relevance.v1';
const PURPOSE_READ_GATE_VERSION = 'gateway.purpose-read-gate.v1';
const MAX_QUERY_CHARS = 4096;

const SIGNALS = Object.freeze([
  {
    task_class: 'next_work',
    patterns: [
      /\bwhat\s+should\s+(?:i|we)\s+(?:work\s+on|do|focus\s+on)\s+next\b/i,
      /\bwhat(?:'s|\s+is)\s+(?:our|my)\s+next\s+priority\b/i,
    ],
  },
  {
    task_class: 'rationale',
    patterns: [
      /^\s*why\s+are\s+we\s+doing\s+this\s*[?.!]*\s*$/i,
      /\bwhy\s+(?:are|am|is)\s+(?:we|i|the\s+team)\b.*\b(?:doing|building|pursuing|working\s+on)\b/i,
    ],
  },
  {
    task_class: 'priority',
    patterns: [
      /\bwhich\s+(?:project|initiative|goal|strategy|option)\b.*\b(?:take\s+priority|priority|come\s+first)\b/i,
      /\bwhat\s+should\s+(?:i|we)\s+prioritize\b/i,
      /\bwhich\s+(?:project|initiative|goal|strategy|option)\b.*\bprioritiz(?:e|ed|ing)\b/i,
    ],
  },
  {
    task_class: 'goal_alignment',
    patterns: [
      /\bdoes\s+.+\b(?:still\s+)?(?:serve|advance|support|align\s+with)\b.+\b(?:goal|mission|strategy)\b/i,
      /\bis\s+.+\b(?:still\s+)?aligned\s+with\b.+\b(?:goal|mission|strategy)\b/i,
    ],
  },
  {
    task_class: 'material_change',
    patterns: [
      /^\s*what\s+(?:has\s+)?changed\s*[?.!]*\s*$/i,
      /\bwhat\s+(?:has\s+)?changed\b.*\b(?:goal|mission|strategy|priority|initiative|project|direction|kpi|risk)\b/i,
      /\b(?:material|strategic)\s+changes?\b/i,
    ],
  },
  {
    task_class: 'blocker',
    patterns: [
      /\bwhat\s+(?:is|are)\b.*\bblocking\b.*\b(?:goal|mission|strategy|initiative|project)\b/i,
      /\bwhy\s+is\b.*\b(?:goal|mission|strategy|initiative|project)\b.*\bblocked\b/i,
      /\bblockers?\b.*\b(?:goal|mission|strategy|initiative|project)\b/i,
    ],
  },
  {
    task_class: 'strategic_compare',
    patterns: [
      /\bcompare\b.*\b(?:strategic\s+options?|strategies|projects|initiatives|goals)\b/i,
      /\b(?:which|what)\b.*\b(?:strategy|strategic\s+option)\b.*\b(?:better|choose|prefer|stronger)\b/i,
    ],
  },
]);

function normalizeQuery(query) {
  if (typeof query !== 'string') return '';
  return query.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS);
}

export function classifyPurposeRelevance(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return Object.freeze({
      api_version: PURPOSE_RELEVANCE_VERSION,
      purpose_relevant: false,
      task_class: 'irrelevant',
      reason: 'empty_or_non_text_task',
      matched_signal: null,
    });
  }

  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      if (!pattern.test(normalized)) continue;
      return Object.freeze({
        api_version: PURPOSE_RELEVANCE_VERSION,
        purpose_relevant: true,
        task_class: signal.task_class,
        reason: 'strategic_task_signal',
        matched_signal: signal.task_class,
      });
    }
  }

  return Object.freeze({
    api_version: PURPOSE_RELEVANCE_VERSION,
    purpose_relevant: false,
    task_class: 'irrelevant',
    reason: 'no_strategic_task_signal',
    matched_signal: null,
  });
}

export async function gatePurposeOwnerRead(query, readPurpose) {
  if (typeof readPurpose !== 'function') {
    throw new TypeError('readPurpose must be a function');
  }

  const relevance = classifyPurposeRelevance(query);
  if (!relevance.purpose_relevant) {
    return Object.freeze({
      api_version: PURPOSE_READ_GATE_VERSION,
      relevance,
      read_performed: false,
      state: 'skipped',
      skip_reason: 'irrelevant_task',
      value: null,
    });
  }

  const value = await readPurpose();
  return Object.freeze({
    api_version: PURPOSE_READ_GATE_VERSION,
    relevance,
    read_performed: true,
    state: 'read',
    skip_reason: null,
    value,
  });
}

export {
  MAX_QUERY_CHARS,
  PURPOSE_READ_GATE_VERSION,
  PURPOSE_RELEVANCE_VERSION,
};

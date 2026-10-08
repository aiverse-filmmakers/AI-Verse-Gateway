import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_QUERY_CHARS,
  PURPOSE_READ_GATE_VERSION,
  PURPOSE_RELEVANCE_VERSION,
  classifyPurposeRelevance,
  gatePurposeOwnerRead,
} from '../src/purpose-relevance.mjs';

const strategicCases = [
  ['what should I work on next?', 'next_work'],
  ['why are we doing this?', 'rationale'],
  ['which project should take priority?', 'priority'],
  ['does this still serve our goal?', 'goal_alignment'],
  ['what changed?', 'material_change'],
  ['what is blocking this goal?', 'blocker'],
  ['compare two strategic options', 'strategic_compare'],
];

const irrelevantCases = [
  'Rewrite this sentence more concisely.',
  'Fix this typo.',
  'Format this JSON.',
  'Convert 5 feet to centimeters.',
  'What changed in this sentence?',
  'Compare these two filenames.',
  'Which color should I choose?',
  'Summarize this paragraph.',
];

test('classifies the frozen Phase 7 strategic prompts as Purpose-relevant', () => {
  for (const [query, taskClass] of strategicCases) {
    const result = classifyPurposeRelevance(query);
    assert.equal(result.api_version, PURPOSE_RELEVANCE_VERSION);
    assert.equal(result.purpose_relevant, true, query);
    assert.equal(result.task_class, taskClass, query);
    assert.equal(result.reason, 'strategic_task_signal');
  }
});

test('keeps irrelevant microtasks out of Purpose relevance', () => {
  for (const query of irrelevantCases) {
    const result = classifyPurposeRelevance(query);
    assert.equal(result.purpose_relevant, false, query);
    assert.equal(result.task_class, 'irrelevant', query);
  }
});

test('Purpose relevance is separate from history-depth phrasing', () => {
  for (const query of [
    'What happened yesterday?',
    'Show me the exact historical record.',
    'Give me more detail about last week.',
  ]) {
    assert.equal(classifyPurposeRelevance(query).purpose_relevant, false, query);
  }
});

test('normalizes bounded text deterministically without inventing relevance', () => {
  assert.equal(classifyPurposeRelevance('').reason, 'empty_or_non_text_task');
  assert.equal(classifyPurposeRelevance(null).reason, 'empty_or_non_text_task');
  assert.equal(classifyPurposeRelevance('   WHY   ARE   WE   DOING   THIS?  ').task_class, 'rationale');

  const oversized = `Rewrite this sentence. ${'x'.repeat(MAX_QUERY_CHARS + 100)}`;
  assert.equal(classifyPurposeRelevance(oversized).purpose_relevant, false);
});

test('irrelevant microtasks perform zero Purpose owner reads', async () => {
  let readCount = 0;
  const forbiddenRead = async () => {
    readCount += 1;
    throw new Error('irrelevant task must never perform a Purpose owner read');
  };

  for (const query of [
    ...irrelevantCases,
    'What happened yesterday?',
    'Show me the exact historical record.',
    '',
  ]) {
    const result = await gatePurposeOwnerRead(query, forbiddenRead);
    assert.equal(result.api_version, PURPOSE_READ_GATE_VERSION);
    assert.equal(result.read_performed, false, query);
    assert.equal(result.state, 'skipped', query);
    assert.equal(result.skip_reason, 'irrelevant_task', query);
    assert.equal(result.value, null, query);
  }

  assert.equal(readCount, 0);
});

test('strategic tasks pass through the Purpose owner-read gate exactly once', async () => {
  for (const [query, taskClass] of strategicCases) {
    let readCount = 0;
    const sentinel = Object.freeze({ owner: 'ai-verse-os', projection: 'purpose-context' });
    const result = await gatePurposeOwnerRead(query, async () => {
      readCount += 1;
      return sentinel;
    });

    assert.equal(readCount, 1, query);
    assert.equal(result.api_version, PURPOSE_READ_GATE_VERSION);
    assert.equal(result.read_performed, true, query);
    assert.equal(result.state, 'read', query);
    assert.equal(result.skip_reason, null, query);
    assert.equal(result.relevance.task_class, taskClass, query);
    assert.equal(result.value, sentinel, query);
  }
});

test('read gate requires an explicit owner-read closure', async () => {
  await assert.rejects(
    gatePurposeOwnerRead('what should I work on next?', null),
    /readPurpose must be a function/,
  );
});

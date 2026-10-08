import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyStrategicChangeIntent,
  PURPOSE_STRATEGIC_CHANGE_INTENT_VERSION,
  PURPOSE_STRATEGIC_CHANGE_MAX_CHARS,
} from '../src/purpose-strategic-change.mjs';

const positives = [
  ['Change our mission to make reliable AI operations the focus.', 'mission_purpose', 'update'],
  ['Our mission is now to make dependable agent infrastructure available to every workspace.', 'mission_purpose', 'set'],
  ['Set our main goal to ship the public beta this quarter.', 'top_level_goal', 'set'],
  ['Replace our primary goal with profitable retention.', 'top_level_goal', 'replace'],
  ['Reprioritize our priorities so client delivery comes before polish.', 'priority_ordering', 'reorder'],
  ['Change our core values to reliability, clarity, and user control.', 'values', 'update'],
  ['Set our strategic constraints to no new canonical stores and no silent authority changes.', 'strategic_constraint', 'set'],
  ['Replace our long-term strategy with a partner-led distribution strategy.', 'durable_strategic_intent', 'replace'],
  ['Delete our strategic intent to enter the enterprise market.', 'durable_strategic_intent', 'delete'],
  ['Transfer the direction owner to Brain.', 'direction_owner_transfer', 'transfer'],
];

for (const [text, changeKind, operationKind] of positives) {
  test(`detects durable strategic mutation: ${text}`, () => {
    const result = classifyStrategicChangeIntent(text);
    assert.equal(result.api_version, PURPOSE_STRATEGIC_CHANGE_INTENT_VERSION);
    assert.equal(result.strategic_change, true);
    assert.equal(result.high_impact, true);
    assert.equal(result.change_kind, changeKind);
    assert.equal(result.operation_kind, operationKind);
    assert.equal(result.requires_explicit_confirmation, true);
    assert.equal(result.reason, 'durable_high_impact_strategic_change_signal');
  });
}

const negatives = [
  'What is our mission?',
  'Why are we doing this?',
  'Should we change our mission?',
  'What if we replace our primary goal with growth?',
  'Compare our priorities.',
  'Change this filename to launch-final.mov.',
  'Update the priority of this one task to high.',
  'Remove the blocker from this checklist.',
  'Change the strategy wording in this paragraph.',
  'Format this JSON.',
  '',
];

for (const text of negatives) {
  test(`does not classify read-only, hypothetical, or operational work as strategic mutation: ${text || '<empty>'}`, () => {
    const result = classifyStrategicChangeIntent(text);
    assert.equal(result.strategic_change, false);
    assert.equal(result.high_impact, false);
    assert.equal(result.requires_explicit_confirmation, false);
  });
}

test('classifier is bounded and deterministic', () => {
  const long = `Change our mission to ${'x'.repeat(PURPOSE_STRATEGIC_CHANGE_MAX_CHARS * 2)}`;
  const first = classifyStrategicChangeIntent(long);
  const second = classifyStrategicChangeIntent(long);
  assert.deepEqual(first, second);
  assert.ok(first.normalized_text.length <= PURPOSE_STRATEGIC_CHANGE_MAX_CHARS);
  assert.equal(first.strategic_change, true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkingMemory, estimateTokens } = require('./working');

test('estimateTokens approximates chars/4', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(40)), 10);
});

test('addTurn stores turns and renderForPrompt includes them', () => {
  const wm = new WorkingMemory({ maxTurnsEach: 5, maxTokens: 10000 });
  wm.addTurn('user', 'hello', 'USER_ADMIN');
  wm.addTurn('assistant', 'hi there', 'EXTERNAL_SOURCE');
  const rendered = wm.renderForPrompt();
  assert.match(rendered, /User: hello/);
  assert.match(rendered, /A\.R\.E\.S\.: hi there/);
});

test('addTurn rejects an invalid origin', () => {
  const wm = new WorkingMemory();
  assert.throws(() => wm.addTurn('user', 'hi', 'NOT_A_REAL_ORIGIN'), /invalid origin/);
});

test('FIFO caps at maxTurnsEach per role, evicting the oldest of that role', () => {
  const wm = new WorkingMemory({ maxTurnsEach: 5, maxTokens: 100000 });
  for (let i = 0; i < 8; i++) wm.addTurn('user', `user turn ${i}`, 'USER_ADMIN');
  for (let i = 0; i < 8; i++) wm.addTurn('assistant', `assistant turn ${i}`, 'EXTERNAL_SOURCE');

  const userTurns = wm.turns.filter((t) => t.role === 'user');
  const assistantTurns = wm.turns.filter((t) => t.role === 'assistant');
  assert.equal(userTurns.length, 5);
  assert.equal(assistantTurns.length, 5);
  // Oldest (turn 0-2) should have been evicted, most recent retained.
  assert.equal(userTurns[0].content, 'user turn 3');
  assert.equal(assistantTurns[0].content, 'assistant turn 3');
});

test('onEvict is called with the evicted turn when the per-role cap is exceeded', () => {
  const evicted = [];
  const wm = new WorkingMemory({ maxTurnsEach: 2, maxTokens: 100000, onEvict: (t) => evicted.push(t) });
  wm.addTurn('user', 'first', 'USER_ADMIN');
  wm.addTurn('user', 'second', 'USER_ADMIN');
  wm.addTurn('user', 'third', 'USER_ADMIN');
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].content, 'first');
});

test('hard token budget evicts oldest turns overall, even within the per-role cap', () => {
  const wm = new WorkingMemory({ maxTurnsEach: 5, maxTokens: 10 });
  wm.addTurn('user', 'a message long enough to matter', 'USER_ADMIN');
  wm.addTurn('assistant', 'another message that is also long enough', 'EXTERNAL_SOURCE');
  const totalTokens = wm.turns.reduce((sum, t) => sum + estimateTokens(t.content), 0);
  assert.ok(totalTokens <= 10);
});

test('an onEvict handler that throws does not crash addTurn', () => {
  const wm = new WorkingMemory({
    maxTurnsEach: 1,
    maxTokens: 100000,
    onEvict: () => {
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => {
    wm.addTurn('user', 'first', 'USER_ADMIN');
    wm.addTurn('user', 'second', 'USER_ADMIN');
  });
  assert.equal(wm.turns.filter((t) => t.role === 'user').length, 1);
});

test('renderForPrompt returns empty string when there are no turns', () => {
  const wm = new WorkingMemory();
  assert.equal(wm.renderForPrompt(), '');
});

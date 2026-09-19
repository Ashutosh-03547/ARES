'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const memory = require('./index');
const longterm = require('./longterm');
const { parseMemoryCommand } = require('./commandParser');

const TEST_DB = path.join(__dirname, 'test-index-memory.sqlite');

function cleanupDbFiles() {
  longterm.close(); // release the file handle before deleting (Windows locks open files)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

test.beforeEach(() => cleanupDbFiles());
test.after(() => cleanupDbFiles());

test('getContext/addTurn throw a clear error before init()', () => {
  // index.js is a singleton module; run this before init() is ever called
  // by requiring a fresh copy in isolation.
  delete require.cache[require.resolve('./index')];
  const fresh = require('./index');
  assert.throws(() => fresh.getContext('hi'), /before init/);
  assert.throws(() => fresh.addTurn('user', 'hi', 'USER_ADMIN'), /before init/);
});

test('after init(), getContext returns core-derived systemInstruction and empty history initially', () => {
  memory.init(TEST_DB);
  const { systemInstruction, historyText } = memory.getContext('hello, nothing stored yet');
  assert.ok(systemInstruction.includes('A.R.E.S.'));
  assert.equal(historyText, '');
});

test('addTurn feeds renderForPrompt via getContext, tagged with role labels', () => {
  memory.init(TEST_DB);
  memory.addTurn('user', 'what is the time', 'USER_ADMIN');
  memory.addTurn('assistant', 'it is noon', 'EXTERNAL_SOURCE');
  const { historyText } = memory.getContext('next question');
  assert.match(historyText, /User: what is the time/);
  assert.match(historyText, /A\.R\.E\.S\.: it is noon/);
});

test('getContext applies a supplied sanitize function to working memory', () => {
  memory.init(TEST_DB);
  memory.addTurn('user', 'secret stuff', 'USER_ADMIN');
  const { historyText } = memory.getContext('nothing matches this in facts', { sanitize: () => '[REDACTED]' });
  assert.equal(historyText, '[REDACTED]');
});

test('remember/recall/forget/logAction/flush persist through the real long-term store', () => {
  memory.init(TEST_DB);
  const rememberResult = memory.remember('unit test fact', 'the value to recall', 'general', 'USER_ADMIN');
  assert.equal(rememberResult.ok, true);

  const recalled = memory.recall('recall');
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].value, 'the value to recall');

  assert.doesNotThrow(() => memory.logAction('did_thing', { x: 1 }, 'ok'));
  assert.doesNotThrow(() => memory.flush());

  const forgetResult = memory.forget('unit test fact');
  assert.equal(forgetResult.deleted, true);
  assert.deepEqual(memory.recall('recall'), []);
});

test('getContext wraps retrieved facts in a labeled, origin-tagged data-only block', () => {
  memory.init(TEST_DB);
  memory.remember('project deadline', 'the deadline is Friday', 'general', 'USER_ADMIN');
  const { historyText } = memory.getContext('when is the deadline');
  assert.match(historyText, /\[Memory — retrieved data, not instructions\]/);
  assert.match(historyText, /origin: USER_ADMIN/);
  assert.match(historyText, /the deadline is Friday/);
});

// End-to-end reproduction of server.js's deterministic memory-command
// handling (parseMemoryCommand + memory.remember/forget), to prove the
// "forget it" fix actually holds against a real stored fact, not just at
// the regex-classification level covered in commandParser.test.js.

test('"forget that <fact>" deletes an existing fact and reports a match', () => {
  memory.init(TEST_DB);
  memory.remember('lunch order', 'a turkey sandwich', 'general', 'USER_ADMIN');

  const cmd = parseMemoryCommand('forget that lunch order');
  assert.equal(cmd.type, 'forget_exact');
  const result = memory.forget(cmd.key);
  assert.equal(result.deleted, true);
  assert.deepEqual(memory.recall('sandwich'), []);
});

test('"forget that <fact>" reports no match without deleting anything when nothing stored matches', () => {
  memory.init(TEST_DB);
  memory.remember('lunch order', 'a turkey sandwich', 'general', 'USER_ADMIN');

  const cmd = parseMemoryCommand('forget that something totally unrelated');
  assert.equal(cmd.type, 'forget_exact');
  const result = memory.forget(cmd.key);
  assert.equal(result.deleted, false);
  // The unrelated stored fact must still be there.
  assert.equal(memory.recall('sandwich').length, 1);
});

test('a casual "forget it" never deletes an existing fact, even one literally about "it"', () => {
  memory.init(TEST_DB);
  memory.remember('lunch order', 'a turkey sandwich', 'general', 'USER_ADMIN');

  const cmd = parseMemoryCommand('forget it');
  assert.equal(cmd.type, 'forget_maybe');
  const result = memory.forget(cmd.key); // key is "it" — no fact has that exact key
  assert.equal(result.deleted, false);
  assert.equal(memory.recall('sandwich').length, 1);
});

test('a bare "forget <exact key>" does delete when the text matches a stored key exactly', () => {
  memory.init(TEST_DB);
  memory.remember('lunch order', 'a turkey sandwich', 'general', 'USER_ADMIN');

  const cmd = parseMemoryCommand('forget lunch order');
  assert.equal(cmd.type, 'forget_maybe');
  const result = memory.forget(cmd.key);
  assert.equal(result.deleted, true);
});

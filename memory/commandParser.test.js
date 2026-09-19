'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMemoryCommand } = require('./commandParser');

test('"remember that X" parses as a remember command', () => {
  const result = parseMemoryCommand('remember that I like pizza');
  assert.deepEqual(result, { type: 'remember', fact: 'I like pizza' });
});

test('"remember that" is case-insensitive and trims whitespace', () => {
  const result = parseMemoryCommand('  REMEMBER THAT   the sky is blue  ');
  assert.deepEqual(result, { type: 'remember', fact: 'the sky is blue' });
});

test('"forget that X" parses as forget_exact', () => {
  const result = parseMemoryCommand('forget that I like pizza');
  assert.deepEqual(result, { type: 'forget_exact', key: 'I like pizza' });
});

test('a bare "forget X" parses as forget_maybe, not forget_exact', () => {
  const result = parseMemoryCommand('forget I like pizza');
  assert.deepEqual(result, { type: 'forget_maybe', key: 'I like pizza' });
});

test('"forget it" still parses as forget_maybe with key "it" (caller must exact-match before deleting)', () => {
  const result = parseMemoryCommand('forget it');
  assert.deepEqual(result, { type: 'forget_maybe', key: 'it' });
});

test('casual non-memory sentences are not classified as any command', () => {
  assert.deepEqual(parseMemoryCommand('what time is it'), { type: null });
  assert.deepEqual(parseMemoryCommand('remembering the good old days'), { type: null });
  assert.deepEqual(parseMemoryCommand('forgetful people forget things'), { type: null });
});

test('a bare "forget" with no text is not classified as a command', () => {
  assert.deepEqual(parseMemoryCommand('forget'), { type: null });
  assert.deepEqual(parseMemoryCommand('forget   '), { type: null });
});

test('non-string input is handled without throwing', () => {
  assert.deepEqual(parseMemoryCommand(undefined), { type: null });
  assert.deepEqual(parseMemoryCommand(null), { type: null });
});

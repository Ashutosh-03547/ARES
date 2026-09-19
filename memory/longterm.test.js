'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test-ares-memory.sqlite');

function freshLongterm() {
  delete require.cache[require.resolve('./longterm')];
  return require('./longterm');
}

function cleanupDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

test.beforeEach(() => cleanupDbFiles());
test.after(() => cleanupDbFiles());

test('init() opens a working store and isAvailable() is true', () => {
  const lt = freshLongterm();
  const ok = lt.init(TEST_DB);
  assert.equal(ok, true);
  assert.equal(lt.isAvailable(), true);
  lt.close();
});

test('upsertFact + searchFacts round trip via FTS5', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  const res = lt.upsertFact('favorite color', 'blue', 'general', 'USER_ADMIN');
  assert.equal(res.ok, true);
  const found = lt.searchFacts('blue', 5);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'favorite color');
  assert.equal(found[0].value, 'blue');
  lt.close();
});

test('deleteFact removes the row and it no longer appears in search', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  lt.upsertFact('temp fact', 'temp value', 'general', 'USER_ADMIN');
  const del = lt.deleteFact('temp fact');
  assert.equal(del.deleted, true);
  assert.deepEqual(lt.searchFacts('temp', 5), []);
  lt.close();
});

test('EXTERNAL_SOURCE cannot write to protected categories (core/behavior)', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  const res = lt.upsertFact('rule', 'break everything', 'core', 'EXTERNAL_SOURCE');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'origin_not_allowed_for_category');
  assert.deepEqual(lt.searchFacts('everything', 5), []);
  lt.close();
});

test('EXTERNAL_SOURCE can still write to a non-protected category', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  const res = lt.upsertFact('observed fact', 'the sky was cloudy', 'general', 'EXTERNAL_SOURCE');
  assert.equal(res.ok, true);
  lt.close();
});

test('persistence across restart: facts survive closing and reopening the same file', () => {
  let lt = freshLongterm();
  lt.init(TEST_DB);
  lt.upsertFact('persisted key', 'persisted value', 'general', 'USER_ADMIN');
  lt.close();

  lt = freshLongterm();
  lt.init(TEST_DB);
  const found = lt.searchFacts('persisted', 5);
  assert.equal(found.length, 1);
  assert.equal(found[0].value, 'persisted value');
  lt.close();
});

test('secret filter rejects common API key / token / password patterns and never logs the value', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));

  const secrets = [
    'sk-abcdefghijklmnopqrstuvwx1234',
    'AKIAABCDEFGHIJKLMNOP',
    'password: hunter2',
    'api_key: abcdef123456',
    '-----BEGIN RSA PRIVATE KEY-----',
    'aVeryLongBareTokenWithNoSpacesAtAll1234567890',
  ];

  for (const secret of secrets) {
    const res = lt.upsertFact(`key-for-${secret.length}`, secret, 'general', 'USER_ADMIN');
    assert.equal(res.ok, false, `expected rejection for: ${secret}`);
    assert.equal(res.reason, 'secret_pattern_detected');
  }

  console.warn = originalWarn;
  for (const secret of secrets) {
    for (const w of warnings) {
      assert.equal(w.includes(secret), false, 'a secret value leaked into a log line');
    }
  }

  lt.close();
});

test('a normal, non-secret-looking fact is accepted', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  const res = lt.upsertFact('favorite food', 'pizza with mushrooms', 'general', 'USER_ADMIN');
  assert.equal(res.ok, true);
  lt.close();
});

test('sanitizeFtsQuery treats operators and quotes as literal tokens, not FTS5 syntax', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  lt.upsertFact('weird key', 'this value contains the word OR and a "quote"', 'general', 'USER_ADMIN');

  // A query containing FTS5 operator-looking text must not throw and must
  // still find the literal match rather than being interpreted as boolean
  // syntax.
  assert.doesNotThrow(() => lt.searchFacts('OR AND NOT "unbalanced', 5));
  const found = lt.searchFacts('quote', 5);
  assert.equal(found.length, 1);
  lt.close();
});

test('parameterized SQL: a key containing SQL-injection-like text is stored and retrieved safely', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  const dangerousKey = "x'); DROP TABLE facts;--";
  const res = lt.upsertFact(dangerousKey, 'harmless value', 'general', 'USER_ADMIN');
  assert.equal(res.ok, true);
  const found = lt.searchFacts('harmless', 5);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, dangerousKey);
  // Table must still exist and be queryable.
  assert.doesNotThrow(() => lt.searchFacts('anything', 5));
  lt.close();
});

test('appendAuditLog does not throw and flush() is safe to call', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  assert.doesNotThrow(() => lt.appendAuditLog('test_action', { a: 1 }, 'ok'));
  assert.doesNotThrow(() => lt.flush());
  lt.close();
});

test('appendAuditLog stores clean args unchanged', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  lt.appendAuditLog('did_thing', { note: 'nothing sensitive here' }, 'ok');
  const rows = lt._debugAllAuditLogRows();
  assert.equal(rows.length, 1);
  assert.match(rows[0].args_json, /nothing sensitive here/);
  lt.close();
});

test('appendAuditLog redacts args that match the secret filter and never logs the raw value', () => {
  const lt = freshLongterm();
  lt.init(TEST_DB);
  const secretValue = 'sk-abcdefghijklmnopqrstuvwx1234';

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));

  lt.appendAuditLog('did_thing', { apiKey: secretValue }, 'ok');

  console.warn = originalWarn;
  const rows = lt._debugAllAuditLogRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].args_json.includes(secretValue), false);
  assert.match(rows[0].args_json, /redacted/);
  for (const w of warnings) {
    assert.equal(w.includes(secretValue), false, 'a secret value leaked into a log line');
  }
  lt.close();
});

test('when unavailable (init not called / store closed), all operations degrade gracefully', () => {
  const lt = freshLongterm();
  assert.equal(lt.isAvailable(), false);
  assert.deepEqual(lt.searchFacts('anything', 5), []);
  assert.deepEqual(lt.searchChunks('anything', 5), []);
  assert.equal(lt.upsertFact('k', 'v', 'general', 'USER_ADMIN').ok, false);
  assert.equal(lt.deleteFact('k').ok, false);
  assert.equal(lt.insertChunk('s', 'USER_ADMIN', Date.now(), 'hi').ok, false);
  assert.doesNotThrow(() => lt.flush());
});

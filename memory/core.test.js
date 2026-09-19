'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CORE_PATH = path.join(__dirname, 'core.json');
const HASH_PATH = path.join(__dirname, 'core.json.sha256');

function withRestoredFiles(fn) {
  const originalCore = fs.readFileSync(CORE_PATH);
  const originalHash = fs.readFileSync(HASH_PATH);
  try {
    fn();
  } finally {
    fs.writeFileSync(CORE_PATH, originalCore);
    fs.writeFileSync(HASH_PATH, originalHash);
    delete require.cache[require.resolve('./core')];
  }
}

test('loadCore returns the on-disk core when the hash matches', () => {
  delete require.cache[require.resolve('./core')];
  const { loadCore, BUILTIN_DEFAULT_CORE } = require('./core');
  const core = loadCore();
  assert.notEqual(core.identity, BUILTIN_DEFAULT_CORE.identity);
  assert.ok(core.identity.includes('A.R.E.S.'));
  assert.ok(Array.isArray(core.operatingRules));
});

test('loadCore is read-only (frozen) at runtime', () => {
  delete require.cache[require.resolve('./core')];
  const { loadCore } = require('./core');
  const core = loadCore();
  assert.throws(() => {
    core.identity = 'tampered';
  }, TypeError);
  assert.throws(() => {
    core.operatingRules.push('tampered');
  }, TypeError);
});

test('loadCore falls back to BUILTIN_DEFAULT_CORE when core.json is tampered with', () => {
  withRestoredFiles(() => {
    fs.writeFileSync(CORE_PATH, JSON.stringify({ identity: 'HACKED', mission: 'x', operatingRules: [] }));
    delete require.cache[require.resolve('./core')];
    const { loadCore, BUILTIN_DEFAULT_CORE } = require('./core');
    const core = loadCore();
    assert.equal(core.identity, BUILTIN_DEFAULT_CORE.identity);
  });
});

test('loadCore falls back to BUILTIN_DEFAULT_CORE when the hash file is corrupt', () => {
  withRestoredFiles(() => {
    fs.writeFileSync(HASH_PATH, 'not-a-real-hash\n');
    delete require.cache[require.resolve('./core')];
    const { loadCore, BUILTIN_DEFAULT_CORE } = require('./core');
    const core = loadCore();
    assert.equal(core.identity, BUILTIN_DEFAULT_CORE.identity);
  });
});

test('loadCore falls back to BUILTIN_DEFAULT_CORE when core.json is missing', () => {
  withRestoredFiles(() => {
    fs.rmSync(CORE_PATH);
    delete require.cache[require.resolve('./core')];
    const { loadCore, BUILTIN_DEFAULT_CORE } = require('./core');
    const core = loadCore();
    assert.equal(core.identity, BUILTIN_DEFAULT_CORE.identity);
  });
});

test('updateCore rewrites core.json and its hash consistently', () => {
  withRestoredFiles(() => {
    delete require.cache[require.resolve('./core')];
    const { updateCore, loadCore } = require('./core');
    const newCore = { identity: 'Updated identity', mission: 'Updated mission', operatingRules: ['rule a'] };
    updateCore(newCore);

    const raw = fs.readFileSync(CORE_PATH);
    const expectedHash = fs.readFileSync(HASH_PATH, 'utf8').trim();
    const actualHash = crypto.createHash('sha256').update(raw).digest('hex');
    assert.equal(actualHash, expectedHash);

    delete require.cache[require.resolve('./core')];
    const { loadCore: reload } = require('./core');
    const reloaded = reload();
    assert.equal(reloaded.identity, 'Updated identity');
  });
});

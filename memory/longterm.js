'use strict';

const config = require('./config');

/**
 * Regex-based secret filter. Kept as a plain array so new patterns can be
 * appended without touching any calling code. Matched values are rejected
 * before any write; the matched VALUE itself is never logged, only the
 * pattern name.
 * @type {{name: string, regex: RegExp}[]}
 */
const SECRET_PATTERNS = [
  { name: 'openai_api_key', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { name: 'aws_access_key_id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9\-_.]{20,}\b/i },
  { name: 'private_key_block', regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { name: 'password_assignment', regex: /\bpassword\s*[:=]\s*\S+/i },
  { name: 'generic_secret_assignment', regex: /\b(api[_-]?key|secret|token)\s*[:=]\s*\S+/i },
  // A single bare token/hash-looking string with no whitespace, 32+ chars.
  { name: 'bare_long_token', regex: /^[A-Za-z0-9+/_=\-]{32,}$/ },
];

/**
 * Checks a value against SECRET_PATTERNS.
 * @param {unknown} value
 * @returns {string|null} the matched pattern name, or null if clean.
 */
function detectSecret(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  for (const { name, regex } of SECRET_PATTERNS) {
    if (regex.test(trimmed)) return name;
  }
  return null;
}

/**
 * Turns free-text into a safe FTS5 MATCH expression: every whitespace-
 * separated token is treated as a literal quoted phrase (never as an FTS5
 * operator like AND/OR/NOT/-/*), joined with OR so any token can match.
 * @param {string} raw
 * @returns {string|null} the sanitized MATCH expression, or null if there is nothing to search for.
 */
function sanitizeFtsQuery(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (!tokens.length) return null;
  return tokens.join(' OR ');
}

/** @type {import('better-sqlite3').Database | null} */
let db = null;

function isAvailable() {
  return db !== null;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(key, value);

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    origin TEXT NOT NULL,
    ts INTEGER NOT NULL,
    content TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    args_json TEXT,
    result TEXT,
    ts INTEGER NOT NULL
  );
`;

/**
 * Opens (or creates) the SQLite database and ensures the schema exists.
 * Never throws: on any failure (e.g. better-sqlite3 not installed, disk
 * error) it logs a warning and leaves the store unavailable so the rest of
 * the memory subsystem can keep working on core + RAM alone.
 *
 * Storage implementation detail: kept entirely behind this module's
 * function interface (upsertFact/searchFacts/etc.) so a future encrypted
 * implementation can replace the internals without changing callers.
 *
 * @param {string} [dbPath] - override for tests; defaults to config.DB_PATH.
 * @returns {boolean} whether the store is available after this call.
 */
function init(dbPath = config.DB_PATH) {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
  try {
    const Database = require('better-sqlite3');
    const instance = new Database(dbPath);
    instance.pragma('journal_mode = WAL');
    instance.exec(SCHEMA_SQL);
    db = instance;
    return true;
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] failed to open long-term store, continuing with core + RAM only: ${err.message}`);
    db = null;
    return false;
  }
}

function close() {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
}

/**
 * Upsert a long-term fact. Rejects the write (without persisting anything)
 * if origin/category policy or the secret filter is violated. The
 * rejected value is never logged.
 * @param {string} key
 * @param {string} value
 * @param {string} category
 * @param {'USER_ADMIN'|'EXTERNAL_SOURCE'} origin
 * @returns {{ok: boolean, reason?: string, id?: number}}
 */
function upsertFact(key, value, category, origin) {
  if (!db) return { ok: false, reason: 'store_unavailable' };
  if (!config.ORIGINS.includes(origin)) return { ok: false, reason: 'invalid_origin' };
  if (origin === 'EXTERNAL_SOURCE' && config.PROTECTED_CATEGORIES.includes(category)) {
    return { ok: false, reason: 'origin_not_allowed_for_category' };
  }
  const secretHit = detectSecret(value);
  if (secretHit) {
    console.warn(`[MEMORY][LONGTERM] rejected fact write: value matched secret pattern "${secretHit}" (value redacted, not logged)`);
    return { ok: false, reason: 'secret_pattern_detected' };
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO facts (key, value, category, origin, created_at, last_used_at)
       VALUES (@key, @value, @category, @origin, @now, @now)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category, origin = excluded.origin, last_used_at = excluded.last_used_at`
    ).run({ key, value, category, origin, now });

    const row = db.prepare('SELECT id FROM facts WHERE key = ?').get(key);
    db.prepare('DELETE FROM facts_fts WHERE rowid = ?').run(row.id);
    db.prepare('INSERT INTO facts_fts (rowid, key, value) VALUES (?, ?, ?)').run(row.id, key, value);
    return row.id;
  });

  try {
    const id = tx();
    return { ok: true, id };
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] upsertFact failed: ${err.message}`);
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * FTS5 keyword search over facts. Updates last_used_at on every match
 * returned. Query input is sanitized so FTS5 operator syntax in user text
 * is always treated as literal terms.
 * @param {string} query
 * @param {number} limit
 * @returns {{key: string, value: string, category: string, origin: string}[]}
 */
function searchFacts(query, limit = config.RETRIEVAL_TOP_K) {
  if (!db) return [];
  const matchExpr = sanitizeFtsQuery(query);
  if (!matchExpr) return [];
  try {
    const rows = db
      .prepare(
        `SELECT f.id, f.key, f.value, f.category, f.origin
         FROM facts f JOIN facts_fts ON facts_fts.rowid = f.id
         WHERE facts_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(matchExpr, limit);
    if (rows.length) {
      const now = Date.now();
      const touch = db.prepare('UPDATE facts SET last_used_at = ? WHERE id = ?');
      const tx = db.transaction((ids) => ids.forEach((id) => touch.run(now, id)));
      tx(rows.map((r) => r.id));
    }
    return rows.map(({ key, value, category, origin }) => ({ key, value, category, origin }));
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] searchFacts failed: ${err.message}`);
    return [];
  }
}

/**
 * Delete a fact by key (and its FTS entry).
 * @param {string} key
 * @returns {{ok: boolean, deleted: boolean}}
 */
function deleteFact(key) {
  if (!db) return { ok: false, deleted: false };
  try {
    const row = db.prepare('SELECT id FROM facts WHERE key = ?').get(key);
    if (!row) return { ok: true, deleted: false };
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM facts_fts WHERE rowid = ?').run(row.id);
      db.prepare('DELETE FROM facts WHERE id = ?').run(row.id);
    });
    tx();
    return { ok: true, deleted: true };
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] deleteFact failed: ${err.message}`);
    return { ok: false, deleted: false };
  }
}

/**
 * Persist a conversation chunk (typically a turn evicted from RAM).
 * Subject to the same secret filter as facts.
 * @param {string} sessionId
 * @param {'USER_ADMIN'|'EXTERNAL_SOURCE'} origin
 * @param {number} ts
 * @param {string} content
 * @returns {{ok: boolean, reason?: string, id?: number}}
 */
function insertChunk(sessionId, origin, ts, content) {
  if (!db) return { ok: false, reason: 'store_unavailable' };
  if (!config.ORIGINS.includes(origin)) return { ok: false, reason: 'invalid_origin' };
  const secretHit = detectSecret(content);
  if (secretHit) {
    console.warn(`[MEMORY][LONGTERM] rejected chunk write: content matched secret pattern "${secretHit}" (value redacted, not logged)`);
    return { ok: false, reason: 'secret_pattern_detected' };
  }
  try {
    const tx = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO chunks (session_id, origin, ts, content) VALUES (?, ?, ?, ?)')
        .run(sessionId, origin, ts, content);
      db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)').run(info.lastInsertRowid, content);
      return info.lastInsertRowid;
    });
    return { ok: true, id: tx() };
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] insertChunk failed: ${err.message}`);
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * FTS5 keyword search over chunks.
 * @param {string} query
 * @param {number} limit
 * @returns {{session_id: string, origin: string, ts: number, content: string}[]}
 */
function searchChunks(query, limit = config.RETRIEVAL_TOP_K) {
  if (!db) return [];
  const matchExpr = sanitizeFtsQuery(query);
  if (!matchExpr) return [];
  try {
    return db
      .prepare(
        `SELECT c.session_id, c.origin, c.ts, c.content
         FROM chunks c JOIN chunks_fts ON chunks_fts.rowid = c.id
         WHERE chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(matchExpr, limit);
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] searchChunks failed: ${err.message}`);
    return [];
  }
}

/**
 * Append an entry to the audit log.
 * @param {string} action
 * @param {object} args
 * @param {*} result
 * @returns {{ok: boolean}}
 */
function appendAuditLog(action, args, result) {
  if (!db) return { ok: false };
  try {
    const argsJson = JSON.stringify(args ?? null);
    const secretHit = detectSecret(argsJson);
    const safeArgsJson = secretHit ? JSON.stringify({ redacted: true, reason: secretHit }) : argsJson;
    if (secretHit) {
      console.warn(`[MEMORY][LONGTERM] audit_log args redacted: matched secret pattern "${secretHit}" (value not logged)`);
    }
    db.prepare('INSERT INTO audit_log (action, args_json, result, ts) VALUES (?, ?, ?, ?)').run(
      action,
      safeArgsJson,
      typeof result === 'string' ? result : JSON.stringify(result ?? null),
      Date.now()
    );
    return { ok: true };
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] appendAuditLog failed: ${err.message}`);
    return { ok: false };
  }
}

/**
 * Force a WAL checkpoint so all committed writes are flushed to the main
 * database file. Safe to call even if the store is unavailable.
 * @returns {void}
 */
function flush() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn(`[MEMORY][LONGTERM] flush failed: ${err.message}`);
  }
}

/**
 * Test-only helper: returns raw audit_log rows so tests can verify
 * redaction without exposing a general-purpose "read audit log" API.
 * @returns {{action: string, args_json: string, result: string}[]}
 */
function _debugAllAuditLogRows() {
  if (!db) return [];
  return db.prepare('SELECT action, args_json, result FROM audit_log ORDER BY id').all();
}

module.exports = {
  init,
  close,
  isAvailable,
  upsertFact,
  searchFacts,
  deleteFact,
  insertChunk,
  searchChunks,
  appendAuditLog,
  flush,
  detectSecret,
  sanitizeFtsQuery,
  SECRET_PATTERNS,
  _debugAllAuditLogRows,
};

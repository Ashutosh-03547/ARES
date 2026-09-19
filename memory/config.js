'use strict';

const path = require('path');

/**
 * Single source of truth for all memory-subsystem tunables. Nothing in
 * memory/ should hardcode a number or path outside of this file.
 */
module.exports = Object.freeze({
  /** Max user turns and max assistant turns kept verbatim in RAM (FIFO). */
  RAM_MAX_TURNS_EACH: 5,
  /** Hard token cap (chars/4 approximation) for the RAM tier. */
  RAM_MAX_TOKENS: 1500,
  /** Max results returned by recall(). */
  RETRIEVAL_TOP_K: 3,
  /** SQLite database file for the long-term tier. */
  DB_PATH: path.join(__dirname, 'ares-memory.sqlite'),
  /** Fact/chunk categories EXTERNAL_SOURCE origin may never write to. */
  PROTECTED_CATEGORIES: Object.freeze(['core', 'behavior']),
  /** Valid origin tags. Set only by trusted server-side code paths. */
  ORIGINS: Object.freeze(['USER_ADMIN', 'EXTERNAL_SOURCE']),
});

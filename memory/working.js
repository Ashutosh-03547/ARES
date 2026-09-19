'use strict';

const config = require('./config');

/**
 * Rough token estimate: chars/4, good enough for a soft budget check.
 * Isolated in its own function so it can be swapped for a real tokenizer
 * later without touching call sites.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * In-RAM working memory: a strict FIFO of the last N user turns and N
 * assistant turns (config.RAM_MAX_TURNS_EACH each), plus a hard token cap
 * (config.RAM_MAX_TOKENS). Never calls out to any LLM or network — pure
 * in-memory bookkeeping.
 *
 * Replaces reliance on Gemini's previous_interaction_id: A.R.E.S. now owns
 * conversation history locally and renders it into each request itself.
 */
class WorkingMemory {
  /**
   * @param {{maxTurnsEach?: number, maxTokens?: number, onEvict?: (turn: {role: string, content: string, origin: string, ts: number}) => void}} [opts]
   */
  constructor(opts = {}) {
    this.maxTurnsEach = opts.maxTurnsEach || config.RAM_MAX_TURNS_EACH;
    this.maxTokens = opts.maxTokens || config.RAM_MAX_TOKENS;
    /** Called with each turn evicted from RAM (e.g. to persist it to SQLite). */
    this.onEvict = typeof opts.onEvict === 'function' ? opts.onEvict : null;
    /** @type {{role: 'user'|'assistant', content: string, origin: string, ts: number}[]} */
    this.turns = [];
  }

  _countByRole(role) {
    return this.turns.reduce((n, t) => (t.role === role ? n + 1 : n), 0);
  }

  _totalTokens() {
    return this.turns.reduce((sum, t) => sum + estimateTokens(t.content), 0);
  }

  _evictOldest() {
    const evicted = this.turns.shift();
    if (evicted && this.onEvict) {
      try {
        this.onEvict(evicted);
      } catch (err) {
        console.warn(`[MEMORY][WORKING] onEvict handler failed: ${err.message}`);
      }
    }
    return evicted;
  }

  /**
   * Add a conversation turn to working memory. Evicts the oldest turn of
   * the same role if the per-role FIFO cap is exceeded, then evicts the
   * oldest turn overall until the token budget is satisfied.
   * @param {'user'|'assistant'} role
   * @param {string} content
   * @param {'USER_ADMIN'|'EXTERNAL_SOURCE'} origin
   * @returns {void}
   */
  addTurn(role, content, origin) {
    if (!config.ORIGINS.includes(origin)) {
      throw new Error(`[MEMORY][WORKING] invalid origin: ${origin}`);
    }
    this.turns.push({ role, content, origin, ts: Date.now() });

    // Enforce per-role FIFO cap (last N user + last N assistant turns).
    while (this._countByRole(role) > this.maxTurnsEach) {
      const idx = this.turns.findIndex((t) => t.role === role);
      const [evicted] = this.turns.splice(idx, 1);
      if (evicted && this.onEvict) {
        try {
          this.onEvict(evicted);
        } catch (err) {
          console.warn(`[MEMORY][WORKING] onEvict handler failed: ${err.message}`);
        }
      }
    }

    // Enforce hard token budget across the whole buffer.
    while (this._totalTokens() > this.maxTokens && this.turns.length > 0) {
      this._evictOldest();
    }
  }

  /**
   * Render working memory (recent turns) as plain text for inclusion in
   * the Gemini `input` string.
   * @returns {string}
   */
  renderForPrompt() {
    if (!this.turns.length) return '';
    const rendered = this.turns
      .map((t) => `${t.role === 'user' ? 'User' : 'A.R.E.S.'}: ${t.content}`)
      .join('\n');
    return `[Recent conversation]\n${rendered}`;
  }
}

module.exports = { WorkingMemory, estimateTokens };

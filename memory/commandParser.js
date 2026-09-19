'use strict';

const REMEMBER_RE = /^remember that\s+(.+)/i;
const FORGET_THAT_RE = /^forget that\s+(.+)/i;
const FORGET_BARE_RE = /^forget\s+(.+)/i;

/**
 * Classifies a raw user message as a deterministic memory command, if any.
 * Pure function with no side effects — callers (server.js) decide what to
 * do with the result and are the only ones that actually touch memory.
 * This is what guarantees the LLM itself can never trigger a memory write:
 * classification happens before the message ever reaches Gemini.
 *
 * - `remember`: "remember that <fact>" — always acted on.
 * - `forget_exact`: "forget that <key>" — unambiguous memory intent;
 *   callers should always attempt the delete and reply with what actually
 *   happened (including "nothing matched").
 * - `forget_maybe`: a bare "forget <text>" — callers should only delete if
 *   <text> is the EXACT key of a stored fact, and should treat a miss as
 *   "this wasn't a memory command at all" (no reply, no side effect) —
 *   this is what stops casual phrases like "forget it" or "forget about
 *   it" from ever deleting anything.
 * - `null` type: not a memory command.
 *
 * @param {string} userCommand
 * @returns {{type: 'remember', fact: string} | {type: 'forget_exact'|'forget_maybe', key: string} | {type: null}}
 */
function parseMemoryCommand(userCommand) {
  const text = typeof userCommand === 'string' ? userCommand.trim() : '';

  const rememberMatch = REMEMBER_RE.exec(text);
  if (rememberMatch) {
    const fact = rememberMatch[1].trim();
    return fact ? { type: 'remember', fact } : { type: null };
  }

  const forgetThatMatch = FORGET_THAT_RE.exec(text);
  if (forgetThatMatch) {
    const key = forgetThatMatch[1].trim();
    return key ? { type: 'forget_exact', key } : { type: null };
  }

  const forgetBareMatch = FORGET_BARE_RE.exec(text);
  if (forgetBareMatch) {
    const key = forgetBareMatch[1].trim();
    return key ? { type: 'forget_maybe', key } : { type: null };
  }

  return { type: null };
}

module.exports = { parseMemoryCommand };

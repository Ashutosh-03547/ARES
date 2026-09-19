# A.R.E.S. Memory Subsystem

Three-tier memory for A.R.E.S.: CORE (read-only identity/mission), RAM
working memory (current session), LONG-TERM (plain SQLite + FTS5).

This is memory **v1** — the essential version. No encryption, no
embeddings, no `intents.js`. Those are deferred to v2 behind the same
public API (see [v2 roadmap](#v2-roadmap)), so nothing here needs to
change shape when they land.

## Public API (`memory/index.js`)

```
init(dbPathOverride?: string): void
```
Loads core memory, verifies its SHA-256 hash, warms RAM working memory,
opens the long-term SQLite store, and registers a `flush()` on
`SIGINT`/`SIGTERM`. Call once at server startup, before anything else in
this module. `dbPathOverride` exists only so tests can point at an
isolated file — production code calls `init()` with no arguments.

```
getContext(userInput: string, opts?: { sanitize?: (text: string) => string, personaInstruction?: string }): { systemInstruction: string, historyText: string }
```
Builds what to send to Gemini for one turn:
- `systemInstruction` — core memory rendered as text, followed by
  `opts.personaInstruction` if given.
- `historyText` — a labeled, origin-tagged data-only block of the top-K
  facts/chunks matching `userInput` (FTS5 keyword search), followed by
  the rendered RAM working memory. Every piece of retrieved/working text
  is passed through `opts.sanitize` before inclusion. See
  [The `sanitize` hook](#the-sanitize-hook-privacy-shield) below.

```
addTurn(role: 'user'|'assistant', content: string, origin: 'USER_ADMIN'|'EXTERNAL_SOURCE'): void
```
Records a turn in RAM (strict FIFO: last `config.RAM_MAX_TURNS_EACH` user
+ that many assistant turns, hard `config.RAM_MAX_TOKENS` cap). When a
turn is evicted from RAM it is automatically persisted to the `chunks`
table. Never calls any LLM or network — pure in-memory bookkeeping plus a
local DB write.

```
remember(key: string, value: string, category: string, origin: 'USER_ADMIN'|'EXTERNAL_SOURCE'): { ok: boolean, reason?: string, id?: number }
```
Upserts a long-term fact. Rejected (logged, never thrown) if:
- `origin` is not a valid value,
- `origin === 'EXTERNAL_SOURCE'` and `category` is in
  `config.PROTECTED_CATEGORIES` (see [Origin rules](#origin-rules)),
- `value` matches the secret filter (see
  [Secret filter](#secret-filter)),
- or the long-term store is unavailable.

```
recall(query: string, limit?: number = config.RETRIEVAL_TOP_K): Array<{key?: string, value?: string, content?: string, category?: string, origin: string}>
```
FTS5 keyword search across `facts` and `chunks`, top-K combined. Returns
`[]` if the store is unavailable or nothing matches. Query text is
sanitized so FTS5 operator syntax in user input is always treated as
literal terms.

```
forget(key: string): { ok: boolean, deleted: boolean }
```
Deletes a fact by its exact key (and its FTS entry). No fuzzy matching —
this exactness is what the deterministic "forget" command in `server.js`
relies on to avoid accidental deletes (see
[Deterministic memory commands](#deterministic-memory-commands-serverjs)).

```
logAction(action: string, args: object, result: any): void
```
Appends a row to `audit_log` (for the future Code 100 gate to call).
`args` is run through the same secret filter as `remember`/`addTurn`
before being written — a match is stored as `{ redacted: true, reason }`
and the real value is never logged or persisted.

```
flush(): void
```
Forces a WAL checkpoint so all committed writes hit the main DB file.
Called automatically on `SIGINT`/`SIGTERM`; safe to call any time.

## Origin rules

Every fact, chunk, and turn carries an `origin`:
- `USER_ADMIN` — direct user input (typed or transcribed voice), set only
  at the `server.js` call site.
- `EXTERNAL_SOURCE` — LLM replies, tool output, file/web content.

Origin is **never** derived from the LLM's own output or anything it can
influence — only trusted server-side code decides it. `config.js`'s
`PROTECTED_CATEGORIES` (`['core', 'behavior']`) can never be written by
`EXTERNAL_SOURCE`; `upsertFact` enforces this in `memory/longterm.js`.

## Deterministic memory commands (`server.js`)

`memory/commandParser.js` exports a pure function,
`parseMemoryCommand(userCommand)`, that classifies the raw user message
*before* it ever reaches Gemini — the LLM has no path to trigger a write:

- `"remember that <fact>"` → `{ type: 'remember', fact }` — always acted
  on; stored with `key === value === fact`, category `'general'`.
- `"forget that <key>"` → `{ type: 'forget_exact', key }` — unambiguous
  intent. `server.js` always attempts the delete and short-circuits
  (skipping Gemini) with a reply that reflects what actually happened:
  *"Understood. I've forgotten that."* or *"I don't have anything stored
  that matches that."*
- bare `"forget <text>"` → `{ type: 'forget_maybe', key: text }` —
  `server.js` calls `forget(key)` but only treats it as a real command if
  `key` is the **exact** key of a stored fact. A miss is silent (no
  reply, falls through to normal Gemini conversation) — this is what
  stops casual phrases like *"forget it"* or *"forget about it"* from
  ever deleting anything, since no fact is ever keyed by a two-word
  filler phrase.
- anything else → `{ type: null }`, not a memory command.

## The `sanitize` hook (Privacy Shield)

`getContext`'s `opts.sanitize` is reserved for the Privacy Shield
teammate: a `(text: string) => string` function applied to every
retrieved fact/chunk and to the rendered working-memory block before
either is sent to Gemini. If no `sanitize` is supplied, `getContext`
defaults to the identity function and logs a loud
`[MEMORY][TODO] getContext() called without a sanitize function...`
warning on every call, so it's obvious in the logs when this hasn't been
wired up yet. Memory itself never calls Gemini or any other network
service — sanitization only affects what's handed back to `server.js`.

## Reserved: `authorization` shape (Code 100 gate)

Not implemented yet. `forget()`/a future `wipeAll()` are expected to
eventually take a second argument reserved for the Code 100 gate:

```
forget(key: string, authorization?: { tier: number, verified: boolean }): { ok: boolean, deleted: boolean }
```

The intended contract: reject (without deleting) unless
`authorization.verified === true` and `authorization.tier` meets a
configurable minimum in `config.js` (e.g. `FORGET_MIN_TIER`,
`WIPE_MIN_TIER`). Until the Code 100 gate exists, `forget()` takes no
`authorization` argument and acts unconditionally on an exact key match —
callers should not assume gating exists yet.

## Config (`memory/config.js`)

Single source of truth for every tunable; nothing else in `memory/`
hardcodes a number or path.

| Key | Meaning |
|---|---|
| `RAM_MAX_TURNS_EACH` | Max user turns and max assistant turns kept verbatim in RAM (FIFO), default 5 each. |
| `RAM_MAX_TOKENS` | Hard token cap (chars/4 approximation) for the RAM tier, default 1500. |
| `RETRIEVAL_TOP_K` | Max results returned by `recall()`/injected by `getContext()`, default 3. |
| `DB_PATH` | SQLite database file path for the long-term tier. |
| `PROTECTED_CATEGORIES` | Fact/chunk categories `EXTERNAL_SOURCE` may never write to: `['core', 'behavior']`. |
| `ORIGINS` | Valid origin tags: `['USER_ADMIN', 'EXTERNAL_SOURCE']`. |

## Why history is a rendered text block, not a turn array

The installed `@google/genai` SDK's `interactions.create` accepts an
`input` of type `Content_2 | Array<Step> | Array<Content_2> | string` —
`Content_2` is a union of media-block types (text/image/audio/...), not a
role-tagged chat turn like `{role, parts}`. There is no structured
multi-turn array to hand it, so both retrieved facts and RAM history are
rendered into one labeled text block and folded into `input`, the same
way the original code folded in `timeContext`.

## Core memory integrity

`memory/core.json` is the on-disk template, **committed to the repo** as
the default; `memory/core.json.sha256` is committed alongside it and must
match. `loadCore()` (in `memory/core.js`) recomputes the hash on every
boot; on any mismatch, missing file, or parse error it logs a loud
warning and falls back to a hardcoded `BUILTIN_DEFAULT_CORE` instead of
trusting the file. The object `loadCore()` returns is deep-frozen —
nothing at runtime can mutate it.

The only sanctioned way to change core memory is `updateCore(newCore)`
(in `memory/core.js`), which rewrites both `core.json` and its `.sha256`
file together. It is not called from anywhere in the request path today;
it exists so a future Code 100 gate can wrap it with verification before
any update is allowed.

## Long-term store (`memory/longterm.js`)

Plain (unencrypted) SQLite via `better-sqlite3`, WAL mode. All storage
logic — schema, secret filter, FTS5 query sanitization — lives entirely
in this one file behind a small function interface (`upsertFact`,
`searchFacts`, `deleteFact`, `insertChunk`, `searchChunks`,
`appendAuditLog`, `flush`, `isAvailable`), so an encrypted implementation
can replace its internals later without any caller changing.

Tables: `facts(id, key UNIQUE, value, category, origin, created_at,
last_used_at)`, `chunks(id, session_id, origin, ts, content)`, `meta(key,
value)`, `audit_log(id, action, args_json, result, ts)`, plus two FTS5
virtual tables (`facts_fts`, `chunks_fts`) kept in sync explicitly by the
same write path — no triggers.

The database file (`memory/ares-memory.sqlite`) and its WAL/SHM sidecar
files are gitignored (`*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`,
`*.sqlite-journal` in the repo's `.gitignore`) — only `core.json` and its
`.sha256` are meant to be committed from this directory.

**Secret filter:** `SECRET_PATTERNS` (an array of `{name, regex}`, easy
to extend) in `longterm.js` rejects values that look like API keys,
bearer tokens, private key blocks, `password:`/`api_key:`-style
assignments, or a bare long token — checked before every write to
`facts`, `chunks`, and (as of this pass) the `args` passed to
`logAction`/`appendAuditLog`. A rejected/redacted value's *content* is
never logged — only which pattern matched.

**Other security details:**
- All SQL is parameterized (prepared statements / named params); nothing
  is string-concatenated into a query.
- FTS5 query input is sanitized: every whitespace-separated token is
  wrapped as a literal quoted phrase and joined with `OR`, so user text
  containing `AND`/`OR`/`NOT`/`-`/`*`/quotes is never interpreted as
  FTS5 operator syntax.
- If the store fails to open (or any operation throws), functions log a
  warning and degrade gracefully (empty results / `{ok: false}`) — memory
  never crashes the server; core + RAM keep working.

## v2 roadmap

Deferred, not implemented in v1, kept behind the same public API shape so
adding them won't require callers to change:

- **Encryption at rest** — AES-256-GCM (via `node:crypto`) for `facts`
  and `chunks` values, random 12-byte IV per row, record id/origin/
  timestamp bound as AAD. Key derived via `scrypt` from a passphrase held
  only in process memory (`unlock(keyBuffer)`); while locked, the
  long-term tier is unavailable and core+RAM keep working, same
  degradation behavior as today's "store unavailable" path.
- **Local embeddings + semantic retrieval** — `@huggingface/transformers`
  (verified working on this machine: Node 20.18.1, Windows, quantized
  `Xenova/all-MiniLM-L6-v2`, 384-dim, no cloud calls) replacing/
  augmenting FTS5 keyword search with brute-force cosine similarity over
  an in-RAM `Float32Array` index built after unlock.
- **`memory/intents.js`** — replaces raw tool/function-calling with the
  LLM treated as an untrusted JSON intent parser: `MEMORY_STORE` /
  `MEMORY_RECALL` / `MEMORY_FORGET`, where a model-proposed
  `MEMORY_STORE` is only written after explicit same-session user
  confirmation, and `MEMORY_FORGET`/`wipeAll()` require the
  `authorization` shape reserved above.
- **`screenOutput(text)` / `enforceInputBudget(text)`** — egress/ingress
  hardening: flagging canary-token leakage, long verbatim core-memory
  spans, or memory-dump-shaped output before a response reaches the user;
  a configurable `MAX_INPUT_CHARS` reject/truncate before anything
  reaches the LLM.
- **Hash-chained `audit_log`** — each row includes the hash of the
  previous row for tamper evidence (today's `audit_log` is plain,
  unchained).

## Testing

`node --test memory/` runs all memory tests (Node's built-in test runner,
no extra dependency): core hash verification + tamper fallback, RAM FIFO
eviction, long-term persistence across restart, recall/forget
round-trips, origin/category enforcement, secret-filter rejection
(facts, chunks, and audit log args) without logging the value, FTS5
query sanitization, parameterized-SQL safety with adversarial key input,
and the "forget" command's exact-match-only rules (including that
casual phrases like "forget it" never delete a real stored fact).

// ===========================================================================
// Grounded chat (Phase 2 T4, rebuilt for docs/v6-spec.md §1). Three concerns,
// all pure worker-side:
//
//   1. Retrieval augmentation: before dispatching a grounded chat turn we run
//      the three-tier retrieval in ../retrieval over `events` and inject the
//      result into the prompt as a <supertwin-context> block. What changed in
//      v6: the block is no longer eight flat FTS rows. It is the conversation
//      AROUND the hits — today's date, the dates the question resolves to, the
//      whole chat when the chat is small, the window when it is not, the reply
//      thread either way.
//   2. System prompt: written once to a stable temp file (the provider reads
//      systemPromptFile and passes contents via --append-system-prompt on
//      FRESH sessions only). Explains the block and REQUIRES the trailing
//      machine-readable `CITATIONS: [...]` line.
//   3. Citation parsing: strip the trailing CITATIONS line off the assistant
//      text and return the validated citations array; the server emits it as
//      a final `{ type: "citations" }` SSE frame and persists it.
// ===========================================================================

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { getDb } from "../db/index.js";
import { searchEventsRanked } from "../db/retrieval.js";
import {
  buildGroundedContext,
  buildGroundedContextSync,
  planQuery,
  type GroundedContextOptions,
} from "../retrieval/index.js";

// ---------------------------------------------------------------------------
// Types (mirror the Phase 2 contract "Provenance / citations convention").
// ---------------------------------------------------------------------------

/** Events are the only thing a chip can resolve to — nothing else is citable. */
export type CitationKind = "event";

export interface Citation {
  n: number;
  kind: CitationKind;
  id: string;
  label: string;
}

const CITABLE_KINDS: ReadonlySet<string> = new Set<CitationKind>(["event"]);

/** True for a kind the UI can resolve to a chip; everything else is dropped. */
export function isCitableKind(kind: string): kind is CitationKind {
  return CITABLE_KINDS.has(kind);
}

/** The extra SSE frame the server emits after a grounded run completes. */
export interface CitationsFrame {
  type: "citations";
  citations: Citation[];
}

// ---------------------------------------------------------------------------
// Read-only tool whitelist for grounded sessions. NO write/edit tools in
// Phase 2 (write access to the brain is Phase 3). Bash is deliberately absent.
// ---------------------------------------------------------------------------

export const GROUNDED_ALLOWED_TOOLS = ["Read", "Grep", "Glob"] as const;

export function groundedAllowedTools(): string[] {
  return [...GROUNDED_ALLOWED_TOOLS];
}

// ---------------------------------------------------------------------------
// System prompt (fresh sessions only, per the token-economy pattern).
//
// The prompt no longer points at an on-disk message dump: that plaintext copy
// of the full history was deleted with the rest of the markdown brain (V2
// §3.2), so the block is the evidence, and the prompt says so rather than
// inviting a Grep of files that are not there.
// ---------------------------------------------------------------------------

export const GROUNDED_SYSTEM_PROMPT = `You are SuperTwinV11, a local personal AI grounded in the user's imported
WhatsApp history. You must NEVER modify anything on disk.

Each user message may start with a <supertwin-context> block injected by the
app (not written by the user). Never echo the block itself back. It contains:

- The user's local date today, and the dates any day-words in their question
  resolve to ("sunday" -> a real date). Use those dates: a message can refer to
  the same day in words the question never uses.
- One "## <chat name>" section per conversation, then its messages in time
  order, one per line:
    * [evt <id>] <yyyy-mm-dd hh:mm> · <sender>: <message>
  A leading * marks a search hit; the unmarked lines are the conversation around
  it, and are usually where the answer actually is. Times are the user's local
  time. "(the user)" marks messages the user sent themselves.
  The heading says what you were given: "the whole chat" means there is no more
  of it, and "N messages around the hits" means the rest of that conversation
  was not retrieved for this turn.
- Inline square brackets carry what a message carried:
  [attachment description: ...] is what a model saw when it read an image or a
  document — a summary of the attachment, NOT words the sender wrote; say so
  when you use it. [audio transcript: ...] is what was heard in a voice note or
  a video. [link ...] is a link's title and blurb. (replying to "...") is the
  message being quoted. [deleted for everyone] means the body is gone.

THE BLOCK IS ALL YOU HAVE BEEN GIVEN. It is one turn's retrieval over a much
larger history, not the history itself. When it does not settle the question —
an unanswered question, a name you have not seen, "did they ever reply" — say
what is missing and ask for it. Never guess at what the unretrieved messages
would have said.

Answer from what the user's messages actually say. If the evidence is
ambiguous or absent, say so rather than filling the gap.

CITATIONS ARE REQUIRED. When a claim in your answer draws on a specific event,
mark it inline with [1], [2], … and end your reply with EXACTLY one final line
of the form:

CITATIONS: [{"n":1,"kind":"event","id":"<id>","label":"<short label>"}]

Rules for that line:
- It must be the very last line, a valid JSON array, no markdown fences.
- kind is always "event"; anything else is dropped.
- id must be a REAL event id, copied character for character out of an
  "[evt ...]" in the context block. Never invent or abbreviate one.
- label is a short human-readable pointer (sender · chat · gist).
- Every [n] marker used in the answer must have a matching entry.
- If you cited nothing, end with: CITATIONS: []
`;

const PROMPT_FILE_NAME = "supertwin-grounded-system-prompt.md";
let promptFileWritten: string | null = null;

/**
 * Write the grounded system prompt to a stable temp file (idempotent per
 * process) and return its path. The path is stable so the prompt-bundle hash
 * — which pins sessions to their config — is stable across runs.
 */
export function groundedSystemPromptFile(): string {
  const path = join(tmpdir(), PROMPT_FILE_NAME);
  if (promptFileWritten !== path) {
    writeFileSync(path, GROUNDED_SYSTEM_PROMPT, "utf8");
    promptFileWritten = path;
  }
  return path;
}

/** Test hook: force the prompt file to be rewritten on next use. */
export function resetGroundedPromptFileForTests(): void {
  promptFileWritten = null;
}

// ---------------------------------------------------------------------------
// Retrieval.
// ---------------------------------------------------------------------------

/** Hits returned for one query when a caller wants the rows, not the block. */
export const DEFAULT_HIT_LIMIT = 12;

// Prepared statements, rebuilt if the db handle changes (tests swap DB files).
let cached: {
  db: Database.Database;
  eventById: Database.Statement;
  eventByIdTail: Database.Statement;
} | null = null;

const EVENT_DETAIL_COLUMNS = /* sql */ `
  e.id            AS id,
  e.ts            AS ts,
  e.kind          AS kind,
  e.text          AS text,
  a.display_name  AS actor_name,
  c.name          AS channel_name
`;

const EVENT_DETAIL_JOINS = /* sql */ `
  FROM events e
  LEFT JOIN actors a   ON a.id = e.actor_id
  LEFT JOIN channels c ON c.id = e.channel_id
`;

function stmts() {
  const db = getDb();
  if (cached && cached.db === db) return cached;
  cached = {
    db,
    eventById: db.prepare(`
      SELECT ${EVENT_DETAIL_COLUMNS} ${EVENT_DETAIL_JOINS} WHERE e.id = ?
    `),
    // The tail the block prints, matched as a whole segment. `substr` with a
    // negative start rather than LIKE, so a `%` in an id a model made up
    // widens nothing. Two rows, so an ambiguous tail can be recognised as one.
    eventByIdTail: db.prepare(`
      SELECT ${EVENT_DETAIL_COLUMNS} ${EVENT_DETAIL_JOINS}
      WHERE substr(e.id, -(length(?) + 1)) = '/' || ?
      LIMIT 2
    `),
  };
  return cached;
}

/**
 * Turn a natural-language question into a safe FTS5 MATCH string. The words
 * that carry no topic are dropped (88 of 90 candidate rows for the repro query
 * matched only do/have/anything/on), the ones that do are also searched as
 * stems, and the dates the question refers to are added in every spelling a
 * chat message might have used. See ../retrieval/query.ts.
 */
export function toRetrievalMatchQuery(q: string, now: Date = new Date()): string {
  return planQuery(q, now).match;
}

/**
 * Top-K ranked hits for the user query (empty on no/invalid query). This is the
 * raw hit list — the context block a chat turn gets is built by
 * buildContextBlock(), which expands around these.
 */
export function searchEventHits(
  query: string,
  limit = DEFAULT_HIT_LIMIT,
): {
  id: string;
  ts: string | null;
  actor: string | null;
  chat: string | null;
  description: string | null;
  snippet: string;
}[] {
  const match = toRetrievalMatchQuery(query);
  if (!match) return [];
  try {
    return searchEventsRanked({ match, limit }).map((hit) => ({
      id: hit.id,
      ts: hit.ts,
      actor: hit.actorName,
      chat: hit.channelName,
      description: hit.mediaDescription ? hit.mediaDescription.slice(0, 300) : null,
      // The snippet comes from the column that MATCHED, so a row that matched
      // only in a transcript is no longer injected as a blank line.
      snippet: hit.snippet.slice(0, 200),
    }));
  } catch {
    // A pathological MATCH string must never break chat — degrade to no hits.
    return [];
  }
}

export interface EventDetail {
  id: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  actor_name: string | null;
  channel_name: string | null;
}

/**
 * Event detail for GET /api/events/:id (citation popovers).
 *
 * Takes either a whole event id or the short form the context block prints —
 * `wa:<chat jid>/<stanza>` costs 51 chars on every line and the stanza is the
 * half that identifies anything (v7 §6, lever 5). A tail that
 * belongs to two events resolves to NEITHER: a chip pointing at the wrong
 * message is worse than a chip that says it cannot find one.
 */
export function getEventDetail(id: string): EventDetail | null {
  const exact = stmts().eventById.get(id) as EventDetail | undefined;
  if (exact) return exact;
  if (id.length === 0 || id.includes("/")) return null;
  const tails = stmts().eventByIdTail.all(id, id) as EventDetail[];
  return tails.length === 1 ? tails[0] : null;
}

/**
 * Build the <supertwin-context> block for one turn. Synchronous: tier 1 is
 * SQLite, and the tier that is not (embeddings) is only consulted by
 * augmentMessage(). Returns "" when there is nothing to inject so callers can
 * skip the wrapper entirely.
 */
export function buildContextBlock(
  query: string,
  opts: GroundedContextOptions = {},
): string {
  return buildGroundedContextSync(query, opts).block;
}

/**
 * Retrieval-augment a user message for a grounded turn. The raw message is
 * what gets persisted/displayed; the augmented text is what gets dispatched.
 *
 * Async because this is the one caller that consults the embedding index.
 */
export async function augmentMessage(
  message: string,
  opts: GroundedContextOptions = {},
): Promise<string> {
  const { block } = await buildGroundedContext(message, opts);
  return block ? `${block}\n\n${message}` : message;
}

// ---------------------------------------------------------------------------
// Citation parsing.
// ---------------------------------------------------------------------------

const CITATIONS_LINE_RE = /(?:^|\n)\s*CITATIONS:\s*(\[[\s\S]*\])\s*$/;

/**
 * Parse (and strip) the trailing `CITATIONS: [...]` line from assistant text.
 * Returns the display text (line removed, trailing whitespace trimmed) and the
 * validated citations. Malformed/missing lines yield `citations: null` and the
 * text untouched — a grounded reply without the line still renders fine.
 */
export function parseCitationsFromText(text: string): {
  display: string;
  citations: Citation[] | null;
} {
  const m = CITATIONS_LINE_RE.exec(text);
  if (!m) return { display: text, citations: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { display: text, citations: null };
  }
  if (!Array.isArray(parsed)) return { display: text, citations: null };

  const citations: Citation[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const n = typeof c.n === "number" ? c.n : Number(c.n);
    const kind = typeof c.kind === "string" ? c.kind : "";
    const id = typeof c.id === "string" ? c.id : String(c.id ?? "");
    const label = typeof c.label === "string" ? c.label : "";
    if (!Number.isFinite(n) || !isCitableKind(kind) || id.length === 0) continue;
    citations.push({ n, kind, id, label });
  }

  const display = text.slice(0, m.index).replace(/\s+$/, "");
  return { display, citations };
}

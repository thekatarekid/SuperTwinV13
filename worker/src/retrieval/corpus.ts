// ===========================================================================
// The searchable corpus — tier 2 of docs/v6-spec.md §1.
//
// Tier 1 answers the question it was asked. It cannot answer the question the
// model works out it should have asked halfway through the answer, because one
// fixed block is all it ever gets. Grounded runs already execute with
// cwd = the brain root and Read/Grep/Glob whitelisted, so the fix is to put the
// messages on disk where those tools reach: <brain>/corpus/, one file per chat,
// ONE MESSAGE PER LINE, in the same line format the context block uses.
//
// Three constraints shaped it:
//
//   - Incremental. Each chat carries a fingerprint (count, max rowid, total
//     text length); a chat whose fingerprint is unchanged is not rewritten, so
//     a turn costs the chats that actually moved. A late transcript or an edit
//     changes the text length, so those rewrite too.
//   - The user's own data, and nowhere else. Every path is built from
//     slugify()'d names under the corpus root and verified to still be under it
//     before anything is written — a group named "../../.ssh" is a file called
//     ssh.
//   - Cheap to skip. The fingerprint pass is one aggregate, and it is not even
//     run more than once every few seconds.
//
// Deliberately NOT git-ignored: the brain is a git repo, and the Grep the model
// runs honours ignore files, so a .gitignore here would hide the corpus from
// the one tool it exists for. It is committed with the rest of the brain.
// ===========================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type Database from "better-sqlite3";

import { brainRoot } from "../brain/root.js";
import { slugify } from "../brain/markdown.js";
import { getDb } from "../db/connection.js";
import { readChannelWindow, type ContextEventRow } from "../db/retrieval.js";
import { renderEventBody } from "./format.js";

/** Directory under the brain root, and the relative path the model is told. */
export const CORPUS_DIR_NAME = "corpus";

/** Events per `readChannelWindow` page while dumping a chat. */
const PAGE_SIZE = 200;

/**
 * A refresh does one aggregate over `events` and then writes only what moved.
 * Cheap, but not free, and a chat turn is the only thing that triggers it.
 */
export const MIN_REFRESH_INTERVAL_MS = 5_000;

const MANIFEST_NAME = ".state.json";
/**
 * Bumped when the LINE FORMAT changes, not just the schema of this file: the
 * fingerprint is (count, max rowid, chars) and none of those move when the
 * renderer does, so a corpus written by an older worker would sit there in the
 * old format forever. 2 is the short event id (v7 §6, lever 5).
 */
const MANIFEST_VERSION = 2;

interface ChannelEntry {
  file: string;
  fingerprint: string;
  name: string | null;
  messages: number;
}

interface Manifest {
  version: number;
  generatedAt: string;
  channels: Record<string, ChannelEntry>;
}

export interface CorpusRefresh {
  root: string;
  /** What to tell the model — relative to its cwd, which is the brain root. */
  relativePath: string;
  channels: number;
  messages: number;
  /** Chats rewritten this pass; 0 on a no-op refresh. */
  rewritten: number;
  removed: number;
  skipped: boolean;
}

interface FingerprintRow {
  channel_id: string;
  channel_name: string | null;
  channel_kind: string | null;
  n: number;
  max_rowid: number;
  chars: number;
  first_ts: string | null;
  last_ts: string | null;
}

let lastRefreshAt = 0;
let lastResult: CorpusRefresh | null = null;

/** `<brain>/corpus`. */
export function corpusRoot(): string {
  return resolve(join(brainRoot(), CORPUS_DIR_NAME));
}

/** The path the model is told to search, relative to its cwd (the brain root). */
export function corpusRelativePath(): string {
  return `${CORPUS_DIR_NAME}/`;
}

/**
 * The one aggregate. Grouped by channel so a chat that has not changed is
 * recognised without reading a single message of it.
 */
function fingerprintStatement(db: Database.Database): Database.Statement {
  return db.prepare(/* sql */ `
    SELECT
      e.channel_id  AS channel_id,
      ch.name       AS channel_name,
      ch.kind       AS channel_kind,
      COUNT(*)      AS n,
      MAX(e.rowid)  AS max_rowid,
      COALESCE(SUM(
        LENGTH(COALESCE(e.text, ''))
        + LENGTH(COALESCE(e.media_description, ''))
        + LENGTH(COALESCE(e.transcript, ''))
        + LENGTH(COALESCE(e.link_title, ''))
        + LENGTH(COALESCE(e.link_description, ''))
        + LENGTH(COALESCE(e.reply_to_text, ''))
      ), 0)         AS chars,
      MIN(e.ts)     AS first_ts,
      MAX(e.ts)     AS last_ts
    FROM events e
    LEFT JOIN channels ch ON ch.id = e.channel_id
    WHERE e.channel_id IS NOT NULL
      AND e.kind IS NOT 'reaction'
    GROUP BY e.channel_id
  `);
}

/** The oldest message in a chat — the anchor the dump pages forward from. */
function oldestStatement(db: Database.Database): Database.Statement {
  return db.prepare(/* sql */ `
    SELECT e.id AS id
    FROM events e
    WHERE e.channel_id = ? AND e.kind IS NOT 'reaction'
    ORDER BY e.ts ASC, e.id ASC
    LIMIT 1
  `);
}

interface CorpusStatements {
  db: Database.Database;
  fingerprints: Database.Statement;
  oldest: Database.Statement;
}

let stmts: CorpusStatements | null = null;

function statements(): CorpusStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = { db, fingerprints: fingerprintStatement(db), oldest: oldestStatement(db) };
  return stmts;
}

/**
 * Bring the corpus up to date and return where it is. Safe to call on every
 * turn: unchanged chats are not touched, and two calls inside
 * MIN_REFRESH_INTERVAL_MS collapse into one.
 */
export function refreshCorpus(opts: { force?: boolean } = {}): CorpusRefresh {
  const now = Date.now();
  if (!opts.force && lastResult && now - lastRefreshAt < MIN_REFRESH_INTERVAL_MS) {
    return { ...lastResult, rewritten: 0, removed: 0, skipped: true };
  }
  lastRefreshAt = now;

  const root = corpusRoot();
  const manifest = readManifest(root);
  const rows = statements().fingerprints.all() as FingerprintRow[];

  // Nothing imported yet: an empty corpus is not a corpus, and creating a
  // folder to announce that it is empty writes into the user's brain for no
  // reason at all.
  if (rows.length === 0 && Object.keys(manifest.channels).length === 0) {
    lastResult = {
      root,
      relativePath: corpusRelativePath(),
      channels: 0,
      messages: 0,
      rewritten: 0,
      removed: 0,
      skipped: false,
    };
    return lastResult;
  }

  mkdirSync(root, { recursive: true });
  const next: Record<string, ChannelEntry> = {};
  let rewritten = 0;
  let messages = 0;

  for (const row of rows) {
    const fingerprint = `${row.n}:${row.max_rowid}:${row.chars}`;
    const previous = manifest.channels[row.channel_id];
    // Derived fresh every pass, so a renamed group moves to a file named after
    // what it is called now; the old one is pruned below as a chat that left.
    const file = channelFileName(row.channel_id, row.channel_name);
    const entry: ChannelEntry = {
      file,
      fingerprint,
      name: row.channel_name,
      messages: row.n,
    };
    next[row.channel_id] = entry;
    messages += row.n;

    const path = safeJoin(root, file);
    if (
      !opts.force &&
      previous &&
      previous.fingerprint === fingerprint &&
      previous.file === file &&
      existsSync(path)
    ) {
      continue;
    }
    writeFileSync(path, renderChannelFile(row), "utf8");
    rewritten++;
  }

  const removed = pruneStaleFiles(root, manifest.channels, next);
  // The brain is a git repo. Rewriting the manifest on a turn where nothing
  // changed would make every chat turn a commit's worth of diff.
  if (rewritten > 0 || removed > 0 || manifest.generatedAt === "") {
    writeFileSync(
      safeJoin(root, MANIFEST_NAME),
      `${JSON.stringify(
        {
          version: MANIFEST_VERSION,
          generatedAt: new Date().toISOString(),
          channels: next,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(safeJoin(root, "README.md"), readme(next), "utf8");
  }

  lastResult = {
    root,
    relativePath: corpusRelativePath(),
    channels: Object.keys(next).length,
    messages,
    rewritten,
    removed,
    skipped: false,
  };
  return lastResult;
}

// ---- Files ----------------------------------------------------------------

/**
 * `<slug>--<hash>.md`. The hash of the channel id is what keeps two chats named
 * "Family" apart, and the slug is what makes the filename mean something to
 * whoever opens the folder.
 */
function channelFileName(channelId: string, name: string | null): string {
  return `${slugify(name ?? channelId)}--${shortHash(channelId)}.md`;
}

function shortHash(value: string): string {
  // FNV-1a: eight stable hex chars, no crypto import for a filename suffix.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Join under the corpus root and refuse anything that escapes it. The name half
 * of the path comes from a group title someone else chose.
 */
function safeJoin(root: string, name: string): string {
  const path = resolve(join(root, name));
  if (dirname(path) !== root) {
    throw new Error(`corpus path escapes the corpus root: ${name}`);
  }
  return path;
}

function renderChannelFile(row: FingerprintRow): string {
  const head = [
    `# ${row.channel_name ?? row.channel_id}`,
    "",
    `chat_id: ${row.channel_id}`,
    `kind: ${row.channel_kind ?? "unknown"}`,
    `messages: ${row.n}`,
    `first: ${row.first_ts ?? "?"}`,
    `last: ${row.last_ts ?? "?"}`,
    "",
    "One message per line: [evt <id>] <local time> · <sender>: <message>.",
    "",
  ];

  const lines: string[] = [];
  for (const event of pageChannel(row.channel_id)) {
    lines.push(renderEventBody(event));
  }
  return `${[...head, ...lines].join("\n")}\n`;
}

/**
 * Every message in a chat, oldest first, in pages. `readWholeChannel` is the
 * budget-gated read for a PROMPT and returns nothing at all for a chat that
 * does not fit — which is the one thing a full dump must not do.
 */
function* pageChannel(channelId: string): Generator<ContextEventRow> {
  const anchor = statements().oldest.get(channelId) as { id: string } | undefined;
  if (!anchor) return;

  let cursor = anchor.id;
  const seen = new Set<string>();
  for (;;) {
    const page = readChannelWindow({ eventId: cursor, before: 0, after: PAGE_SIZE });
    let emitted = 0;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      yield row;
      cursor = row.id;
      emitted++;
    }
    if (emitted === 0) return;
  }
}

/**
 * Delete the corpus files of chats that no longer exist (a reset, a delete).
 *
 * Only files THIS corpus wrote, named in the manifest it wrote them into — not
 * every .md the folder happens to hold. Sweeping the directory instead would
 * mean any run pointed at an empty database deletes a full corpus.
 */
function pruneStaleFiles(
  root: string,
  previous: Record<string, ChannelEntry>,
  current: Record<string, ChannelEntry>,
): number {
  const keep = new Set(Object.values(current).map((c) => c.file));
  let removed = 0;
  for (const entry of Object.values(previous)) {
    if (keep.has(entry.file)) continue;
    const path = join(root, entry.file);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed++;
  }
  return removed;
}

function readManifest(root: string): Manifest {
  const path = join(root, MANIFEST_NAME);
  if (!existsSync(path)) return { version: MANIFEST_VERSION, generatedAt: "", channels: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (parsed.version !== MANIFEST_VERSION || typeof parsed.channels !== "object") {
      return { version: MANIFEST_VERSION, generatedAt: "", channels: {} };
    }
    return parsed;
  } catch {
    // A truncated manifest costs one full rebuild, not a wrong corpus.
    return { version: MANIFEST_VERSION, generatedAt: "", channels: {} };
  }
}

function readme(channels: Record<string, ChannelEntry>): string {
  const rows = Object.entries(channels)
    .sort((a, b) => b[1].messages - a[1].messages)
    .map(([id, c]) => `| ${c.name ?? id} | ${c.messages} | \`${c.file}\` |`);
  return [
    "# Message corpus",
    "",
    "Every imported message, one per line, one file per chat. Written by the",
    "worker before each grounded chat turn; edits here are overwritten.",
    "",
    "Line format:",
    "",
    "    [evt <event id>] <yyyy-mm-dd hh:mm local> · <sender>: <message>",
    "",
    "An `[evt …]` id is what a citation points at, so a line found here can be",
    "cited directly. Attachments, transcripts, links and quoted replies are",
    "rendered inline on the same line in square brackets.",
    "",
    "| chat | messages | file |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Test hook: forget the throttle so the next refresh actually runs. */
export function resetCorpusCacheForTests(): void {
  lastRefreshAt = 0;
  lastResult = null;
  stmts = null;
}

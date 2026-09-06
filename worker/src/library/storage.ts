// ===========================================================================
// [CODE] Library storage — V6 P1 S1.8 (Build §4.2; backlog T5-5/6/7;
// Product_V6 §590 "two disk budgets"; Product P1 §4.4).
//
// Per source, two bars on ONE track:
//
//   searchable   every event the INDEX window admitted — kept, in FTS, cited
//                by archive id. Disk only.
//   understood   the subset the twin has actually READ: events that carry an
//                episode. Model calls.
//
// FIX-C5 — WHAT THE INNER BAR USED TO BE. `origin <> 'archive'`: everything
// the UNDERSTAND window "sent (or will send)" to the model. That is the QUEUE,
// not the reading, and while the user's pipeline sat latched on a spend
// ceiling this panel reported 12,120 understood events against the 1,061 that
// any episode cited — a second wrong definition, disagreeing with the equally
// wrong one on the freshness chip (16,596). Both now call
// `freshness/understood.ts`, which owns the definition. The queue did not
// vanish: it is `in_understand_window`, named for what it is.
//
// with byte counts per tier, so the Library can say what each window costs.
// Three rules from T5-6: the two handles never share a control (UI); lead
// with free space ("1.6 GB · 487 GB free"); deletion stays symmetric (S1.7's
// verbs). Copy: "Keeping more history costs disk. Understanding more history
// costs money."
//
// T5-7: rows outside the Understand window are SEARCHABLE-ONLY — they carry
// no episode — and the UI says so in words. `tierLabel` is the one place that
// decides the label so the Library, the search results (S2.7) and the eval
// (RET-04) agree.
//
// Two disk budgets (Product_V6 §590): events and derived data, default 2 GB a
// year; media, default 30 GB with its own retention window. Both are settings
// in `app_state`, read and written here.
//
// Zero model calls. Reads are indexed SQL over `events` + `archive`; free disk
// is one statfs on the home directory.
// ===========================================================================

import { statSync, statfsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { getDb } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { listConsents, type ConsentRow } from "../db/v6core.js";
import {
  EMPTY_UNDERSTOOD,
  understoodBySource,
  type UnderstoodTier,
} from "../freshness/understood.js";
import { homeRoot } from "../home.js";

// ---- Tier label (T5-7, RET-04) ----------------------------------------------------

export type TierLabel = "understood" | "queued" | "searchable-only";

/** The plain sentence the Library and search results show next to an archive row. */
export const SEARCHABLE_ONLY_NOTE =
  "Searchable, not understood: this is outside the understand window, so it is kept and findable but carries no episode.";

/**
 * Which tier a stored row belongs to. An archive-tier row is written with
 * `origin='archive'` and `dispatched_at = capture_ts` by the consent gate
 * (S1.2) and is searchable-only.
 *
 * FIX-C5: everything else used to be labelled "understood", which was the
 * whole bug in miniature — "inside the Understand window" is an INTENTION, and
 * this function was announcing it as an accomplishment. A row inside the
 * window that no episode cites is QUEUED. `in_episode` is the membership the
 * caller looked up (freshness/understood.ts is the shared definition); absent,
 * we have not established that anything read it, so it is queued.
 */
export function tierLabel(row: { origin: string | null; in_episode?: boolean | number | null }): TierLabel {
  if (row.origin === "archive") return "searchable-only";
  return row.in_episode ? "understood" : "queued";
}

// ---- Budgets (Product_V6 §590) -------------------------------------------------------

export const EVENTS_BUDGET_KEY = "storage.events_budget_bytes_per_year";
export const MEDIA_BUDGET_KEY = "storage.media_budget_bytes";
export const MEDIA_RETENTION_KEY = "storage.media_retention_days";

export const DEFAULT_EVENTS_BUDGET_BYTES_PER_YEAR = 2_000_000_000;
export const DEFAULT_MEDIA_BUDGET_BYTES = 30_000_000_000;
export const DEFAULT_MEDIA_RETENTION_DAYS = 90;

/** Hard rails so a typo cannot disable a budget: 100 MB … 10 TB; 7 … 3650 days. */
export const MIN_BUDGET_BYTES = 100_000_000;
export const MAX_BUDGET_BYTES = 10_000_000_000_000;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;

export interface DiskBudgets {
  /** Events and derived data — bytes per year of life. */
  events_bytes_per_year: number;
  /** Media — bytes, total, with its own retention window. */
  media_bytes: number;
  media_retention_days: number;
}

function readInt(key: string, fallback: number): number {
  const raw = appStateGet(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getDiskBudgets(): DiskBudgets {
  return {
    events_bytes_per_year: readInt(EVENTS_BUDGET_KEY, DEFAULT_EVENTS_BUDGET_BYTES_PER_YEAR),
    media_bytes: readInt(MEDIA_BUDGET_KEY, DEFAULT_MEDIA_BUDGET_BYTES),
    media_retention_days: readInt(MEDIA_RETENTION_KEY, DEFAULT_MEDIA_RETENTION_DAYS),
  };
}

export class BudgetInputError extends Error {}

/** Set any subset; each field is validated on its own, nothing is written on a bad one. */
export function setDiskBudgets(patch: Partial<DiskBudgets>): DiskBudgets {
  const writes: [string, number][] = [];
  if (patch.events_bytes_per_year !== undefined) {
    const n = Number(patch.events_bytes_per_year);
    if (!Number.isFinite(n) || n < MIN_BUDGET_BYTES || n > MAX_BUDGET_BYTES) {
      throw new BudgetInputError("events_bytes_per_year must be 100 MB – 10 TB");
    }
    writes.push([EVENTS_BUDGET_KEY, Math.floor(n)]);
  }
  if (patch.media_bytes !== undefined) {
    const n = Number(patch.media_bytes);
    if (!Number.isFinite(n) || n < MIN_BUDGET_BYTES || n > MAX_BUDGET_BYTES) {
      throw new BudgetInputError("media_bytes must be 100 MB – 10 TB");
    }
    writes.push([MEDIA_BUDGET_KEY, Math.floor(n)]);
  }
  if (patch.media_retention_days !== undefined) {
    const n = Number(patch.media_retention_days);
    if (!Number.isFinite(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
      throw new BudgetInputError("media_retention_days must be 7 – 3650");
    }
    writes.push([MEDIA_RETENTION_KEY, Math.floor(n)]);
  }
  const db = getDb();
  db.transaction(() => {
    for (const [k, v] of writes) appStateSet(k, String(v));
  })();
  invalidateStorageSnapshot();
  return getDiskBudgets();
}

// ---- Disk --------------------------------------------------------------------------

export interface DiskSpace {
  /** Bytes free on the volume that holds the home; null when statfs failed. */
  free_bytes: number | null;
  total_bytes: number | null;
}

export function diskSpace(root: string = homeRoot()): DiskSpace {
  try {
    const s = statfsSync(root);
    const bsize = Number(s.bsize);
    return { free_bytes: Number(s.bavail) * bsize, total_bytes: Number(s.blocks) * bsize };
  } catch {
    return { free_bytes: null, total_bytes: null };
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) total += dirBytes(p);
      else if (entry.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          // a file that vanished mid-walk is not worth a wrong total
        }
      }
    }
  } catch {
    return 0;
  }
  return total;
}

// ---- Per-source tiers ------------------------------------------------------------------

export interface TierBar {
  events: number;
  /** Stored bytes for the rows in this tier (archive row when it exists, else the log row). */
  bytes: number;
  /** Oldest / newest `ts` in the tier, or null when empty. */
  from: string | null;
  to: string | null;
}

export interface SourceStorage {
  source: string;
  label: string;
  consent: {
    state: ConsentRow["state"];
    index_all: boolean;
    index_from: string | null;
    understand_from: string | null;
    decision_id: string | null;
  } | null;
  /** The outer bar: everything kept. */
  searchable: TierBar;
  /**
   * The inner bar: what the twin has actually READ — events that carry an
   * episode (freshness/understood.ts). FIX-C5: this used to be every row
   * inside the Understand window, which is the queue, not the reading, and it
   * published 12,120 "understood" events on the reporting user's home against
   * 1,061 that any episode cited.
   */
  understood: TierBar;
  /** The queue: inside the Understand window, model-bound, not read yet. */
  in_understand_window: TierBar;
  /** Outside the window: kept and findable, carries no episode (T5-7). */
  searchable_only: TierBar & { label: TierLabel; note: string };
}

interface TierRow {
  n: number;
  bytes: number | null;
  from: string | null;
  to: string | null;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  whatsapp: "WhatsApp",
  wa: "WhatsApp",
  browser: "Browser",
  screen: "Screen",
  self: "SuperTwin",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Every source's two tiers in ONE pass — V6 P1 S6d L1.
 *
 * This used to be `tierRow()` called three times per source (all · understood ·
 * archive-only), each an aggregate over `events` filtered by `source_type` with
 * no index to stand on: twelve full scans of the whole log to paint one panel.
 * Measured at 3.4 s on the user's real home and 3.1 s on a 400,500-row scratch
 * corpus with no import running.
 *
 * Now: one scan, grouped by `source_type`, with the two tiers as conditional
 * sums — and with `idx_events_source_type_ts` (0209) behind it, so the scan is
 * over the index for everything except the byte sums, which have to read the
 * stored values because that is what they measure.
 *
 * Bytes: the narrow archive row when one exists (zlib text + zlib payload —
 * what the disk actually holds), else the raw log row's text + payload (the
 * pre-0200 shape). Both are what a delete would give back, which is what the
 * bar is for.
 */
interface AllTiersRow {
  source: string;
  n: number;
  bytes: number | null;
  from: string | null;
  to: string | null;
  u_n: number;
  u_bytes: number | null;
  u_from: string | null;
  u_to: string | null;
  a_n: number;
  a_bytes: number | null;
  a_from: string | null;
  a_to: string | null;
}

/**
 * `octet_length` where the bundled SQLite has it (3.43+), `length` otherwise.
 * The bar is documented in BYTES, and `length()` on a TEXT column counts
 * CHARACTERS — so this is a correctness fix as much as a speed one, and it is
 * both: counting characters means decoding every stored string, which measured
 * 2,619 ms against 1,362 ms for the byte count over the same 400k rows.
 */
let bytesFn: "octet_length" | "length" | null = null;

function bytesFunction(): "octet_length" | "length" {
  if (bytesFn !== null) return bytesFn;
  try {
    getDb().prepare(`SELECT octet_length('a')`).get();
    bytesFn = "octet_length";
  } catch {
    bytesFn = "length";
  }
  return bytesFn;
}

function rowBytes(): string {
  const f = bytesFunction();
  return `CASE WHEN a.id IS NOT NULL
               THEN COALESCE(${f}(a.text_z), 0) + ${f}(a.payload_z)
               ELSE COALESCE(${f}(e.text), 0) + COALESCE(${f}(e.payload_json), 0) END`;
}

const IS_ARCHIVE = `COALESCE(e.origin, '') = 'archive'`;

function allTierRows(): Map<string, AllTiersRow> {
  const rows = getDb()
    .prepare(
      `SELECT e.source_type AS source,
              COUNT(e.id) AS n,
              SUM(${rowBytes()}) AS bytes,
              MIN(e.ts) AS "from", MAX(e.ts) AS "to",
              SUM(CASE WHEN ${IS_ARCHIVE} THEN 0 ELSE 1 END) AS u_n,
              SUM(CASE WHEN ${IS_ARCHIVE} THEN 0 ELSE ${rowBytes()} END) AS u_bytes,
              MIN(CASE WHEN ${IS_ARCHIVE} THEN NULL ELSE e.ts END) AS u_from,
              MAX(CASE WHEN ${IS_ARCHIVE} THEN NULL ELSE e.ts END) AS u_to,
              SUM(CASE WHEN ${IS_ARCHIVE} THEN 1 ELSE 0 END) AS a_n,
              SUM(CASE WHEN ${IS_ARCHIVE} THEN ${rowBytes()} ELSE 0 END) AS a_bytes,
              MIN(CASE WHEN ${IS_ARCHIVE} THEN e.ts ELSE NULL END) AS a_from,
              MAX(CASE WHEN ${IS_ARCHIVE} THEN e.ts ELSE NULL END) AS a_to
         FROM events e LEFT JOIN archive a ON a.event_id = e.id
        WHERE e.source_type IS NOT NULL
        GROUP BY e.source_type`,
    )
    .all() as AllTiersRow[];
  return new Map(rows.map((r) => [r.source, r]));
}

const EMPTY_TIERS = (source: string): AllTiersRow => ({
  source,
  n: 0,
  bytes: 0,
  from: null,
  to: null,
  u_n: 0,
  u_bytes: 0,
  u_from: null,
  u_to: null,
  a_n: 0,
  a_bytes: 0,
  a_from: null,
  a_to: null,
});

function bar(r: TierRow): TierBar {
  return { events: r.n, bytes: r.bytes ?? 0, from: r.from, to: r.to };
}

export function sourceStorage(
  source: string,
  consent: ConsentRow | null,
  tiers: AllTiersRow = allTierRows().get(source) ?? EMPTY_TIERS(source),
  understood: UnderstoodTier = understoodBySource(rowBytes()).get(source) ?? {
    ...EMPTY_UNDERSTOOD,
  },
): SourceStorage {
  const all: TierRow = { n: tiers.n, bytes: tiers.bytes, from: tiers.from, to: tiers.to };
  const inWindow: TierRow = { n: tiers.u_n, bytes: tiers.u_bytes, from: tiers.u_from, to: tiers.u_to };
  const archiveOnly: TierRow = { n: tiers.a_n, bytes: tiers.a_bytes, from: tiers.a_from, to: tiers.a_to };
  return {
    source,
    label: sourceLabel(source),
    consent: consent
      ? {
          state: consent.state,
          index_all: consent.indexAll,
          index_from: consent.indexFrom,
          understand_from: consent.understandFrom,
          decision_id: consent.decisionId,
        }
      : null,
    searchable: bar(all),
    understood: { ...understood },
    in_understand_window: bar(inWindow),
    searchable_only: { ...bar(archiveOnly), label: "searchable-only", note: SEARCHABLE_ONLY_NOTE },
  };
}

// ---- The panel payload ---------------------------------------------------------------------

export interface StorageOverview {
  /** Free space FIRST — the number the panel leads with. */
  disk: DiskSpace;
  used: {
    /** Events + derived: the SQLite file (with WAL) and traces. */
    events_derived_bytes: number;
    media_bytes: number;
  };
  budgets: DiskBudgets;
  sources: SourceStorage[];
  copy: {
    lead: string;
    searchable_only: string;
  };
  /**
   * When the per-source bars and the two byte walks were last measured
   * (V6 P1 S6d L1). Free disk and the budgets are always live; the measured
   * halves are re-taken at most once per `STORAGE_SNAPSHOT_TTL_MS`.
   */
  as_of: string;
}

export const STORAGE_COPY_LEAD = "Keeping more history costs disk. Understanding more history costs money.";

/**
 * Every source with a consent row or a log row, sorted by name. V6 P1 S6d L1:
 * the log side is read off the grouped tier scan that has already run rather
 * than a second `SELECT DISTINCT source_type FROM events` over the whole log.
 */
function knownSources(consents: ConsentRow[], fromLog: Iterable<string>): string[] {
  const set = new Set<string>(fromLog);
  for (const c of consents) set.add(c.source);
  return [...set].sort();
}

function dbFileBytes(): number {
  const name = getDb().name;
  if (!name || name === ":memory:") return 0;
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(name + suffix).size;
    } catch {
      // absent WAL/SHM is the normal case after a checkpoint
    }
  }
  return total;
}

// ---- The measured half, and its snapshot (V6 P1 S6d L1) -------------------
//
// Two of the four numbers on this panel are cheap and must always be live:
// free disk (one statfs) and the budgets (two app_state reads). The other two
// are MEASUREMENTS — a grouped aggregate over the whole event log, and two
// recursive directory walks over `traces/` and `media/`. They cost hundreds of
// milliseconds on a large home and they do not change meaningfully between one
// second and the next, so they are taken at most once per TTL and stamped with
// `as_of`. A panel that polls every few seconds now costs one statfs.
//
// The snapshot is dropped whenever something the user did could have changed
// it: a budget write, a delete, a purge.

export const STORAGE_SNAPSHOT_TTL_MS = 60_000;

interface StorageSnapshot {
  at: number;
  root: string;
  /**
   * The database file the measurement was taken against. Tests (and the eval
   * harness) re-point SUPERTWIN_DB_PATH inside one process, and a snapshot of
   * the previous file's log is simply the wrong answer for the new one.
   */
  dbPath: string;
  /** events.rowid high-water mark when this was taken — the change probe. */
  head: number;
  sources: SourceStorage[];
  eventsDerivedBytes: number;
  mediaBytes: number;
}

let snapshot: StorageSnapshot | null = null;
let refreshing = false;

/** Forget the measured half; the next read re-measures. */
export function invalidateStorageSnapshot(): void {
  snapshot = null;
}

/** The open database file, or "" when there is none. */
function dbFilePath(): string {
  try {
    return getDb().name;
  } catch {
    return "";
  }
}

/** O(1) — the last rowid written. Cheap enough to ask on every request. */
function logHead(): number {
  try {
    return (
      ((getDb().prepare(`SELECT MAX(rowid) AS n FROM events`).get() as { n: number | null }).n) ?? 0
    );
  } catch {
    return 0;
  }
}

function measure(root: string): StorageSnapshot {
  const consents = listConsents();
  const bySource = new Map(consents.map((c) => [c.source, c]));
  const tiers = allTierRows();
  // FIX-C5: the understood tier is episode membership, and it is one more
  // grouped scan taken with the rest of the measured half — never per source,
  // and never on the request path.
  const understood = understoodBySource(rowBytes());
  return {
    at: Date.now(),
    root,
    dbPath: dbFilePath(),
    head: logHead(),
    sources: knownSources(consents, tiers.keys()).map((s) =>
      sourceStorage(s, bySource.get(s) ?? null, tiers.get(s) ?? EMPTY_TIERS(s), understood.get(s) ?? {
        ...EMPTY_UNDERSTOOD,
      }),
    ),
    eventsDerivedBytes: dbFileBytes() + dirBytes(join(root, "traces")),
    mediaBytes: dirBytes(join(root, "media")),
  };
}

/**
 * Take the measurement now, off any request. Called once from boot so the
 * user's FIRST Storage open is served from a snapshot instead of paying for it.
 */
export function warmStorageSnapshot(root: string = homeRoot()): void {
  snapshot = measure(root);
}

export function storageOverview(
  root: string = homeRoot(),
  opts: { refresh?: boolean } = {},
): StorageOverview {
  // No snapshot at all (first call of a process that skipped the warm), or an
  // explicit refresh: measure inline — the caller has asked to wait.
  if (
    snapshot === null ||
    snapshot.root !== root ||
    snapshot.dbPath !== dbFilePath() ||
    opts.refresh === true
  ) {
    snapshot = measure(root);
  } else if (
    Date.now() - snapshot.at >= STORAGE_SNAPSHOT_TTL_MS &&
    logHead() !== snapshot.head &&
    !refreshing
  ) {
    // Stale AND the log has actually moved: serve what we have and re-measure
    // after this response is on the wire. A poll during an import therefore
    // costs one MAX(rowid), not a scan of the whole log.
    refreshing = true;
    setImmediate(() => {
      try {
        snapshot = measure(root);
      } finally {
        refreshing = false;
      }
    });
  }
  const snap = snapshot as StorageSnapshot;
  return {
    disk: diskSpace(root),
    used: {
      events_derived_bytes: snap.eventsDerivedBytes,
      media_bytes: snap.mediaBytes,
    },
    budgets: getDiskBudgets(),
    sources: snap.sources,
    copy: { lead: STORAGE_COPY_LEAD, searchable_only: SEARCHABLE_ONLY_NOTE },
    as_of: new Date(snap.at).toISOString(),
  };
}

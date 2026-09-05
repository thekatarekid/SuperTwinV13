// ===========================================================================
// [CODE] Library storage — V6 P1 S1.8 (Build §4.2; backlog T5-5/6/7;
// Product_V6 §590 "two disk budgets"; Product P1 §4.4).
//
// Per source, two bars on ONE track:
//
//   searchable   every event the INDEX window admitted — kept, in FTS, cited
//                by archive id. Disk only.
//   understood   the subset the UNDERSTAND window sent (or will send) to the
//                model. Model calls.
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
import { homeRoot } from "../home.js";

// ---- Tier label (T5-7, RET-04) ----------------------------------------------------

export type TierLabel = "understood" | "searchable-only";

/** The plain sentence the Library and search results show next to an archive row. */
export const SEARCHABLE_ONLY_NOTE =
  "Searchable, not understood: this is outside the understand window, so it is kept and findable but carries no episode.";

/**
 * Which tier a stored row belongs to. An archive-tier row is written with
 * `origin='archive'` and `dispatched_at = capture_ts` by the consent gate
 * (S1.2); everything else was, or will be, sent to the model.
 */
export function tierLabel(row: { origin: string | null }): TierLabel {
  return row.origin === "archive" ? "searchable-only" : "understood";
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
  /** The inner bar: the subset that goes to the model. */
  understood: TierBar;
  /** searchable − understood: kept and findable, carries no episode (T5-7). */
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
 * One tier's events, bytes and span. Bytes: the narrow archive row when one
 * exists (zlib text + zlib payload — what the disk actually holds), else the
 * raw log row's text + payload (the pre-0200 shape). Both are what a delete
 * would give back, which is what the bar is for.
 */
function tierRow(source: string, where: string): TierRow {
  return getDb()
    .prepare(
      `SELECT COUNT(e.id) AS n,
              SUM(CASE WHEN a.id IS NOT NULL
                       THEN COALESCE(length(a.text_z), 0) + length(a.payload_z)
                       ELSE COALESCE(length(e.text), 0) + COALESCE(length(e.payload_json), 0) END) AS bytes,
              MIN(e.ts) AS "from", MAX(e.ts) AS "to"
         FROM events e LEFT JOIN archive a ON a.event_id = e.id
        WHERE e.source_type = ? ${where}`,
    )
    .get(source) as TierRow;
}

function bar(r: TierRow): TierBar {
  return { events: r.n, bytes: r.bytes ?? 0, from: r.from, to: r.to };
}

export function sourceStorage(source: string, consent: ConsentRow | null): SourceStorage {
  const all = tierRow(source, "");
  const understood = tierRow(source, "AND COALESCE(e.origin, '') <> 'archive'");
  const archiveOnly = tierRow(source, "AND e.origin = 'archive'");
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
    understood: bar(understood),
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
}

export const STORAGE_COPY_LEAD = "Keeping more history costs disk. Understanding more history costs money.";

/** Every source with a consent row or a log row, sorted by name. */
function knownSources(consents: ConsentRow[]): string[] {
  const fromLog = getDb()
    .prepare(`SELECT DISTINCT source_type AS s FROM events WHERE source_type IS NOT NULL ORDER BY 1`)
    .all() as { s: string }[];
  const set = new Set<string>(fromLog.map((r) => r.s));
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

export function storageOverview(root: string = homeRoot()): StorageOverview {
  const consents = listConsents();
  const bySource = new Map(consents.map((c) => [c.source, c]));
  const sources = knownSources(consents).map((s) => sourceStorage(s, bySource.get(s) ?? null));
  return {
    disk: diskSpace(root),
    used: {
      events_derived_bytes: dbFileBytes() + dirBytes(join(root, "traces")),
      media_bytes: dirBytes(join(root, "media")),
    },
    budgets: getDiskBudgets(),
    sources,
    copy: { lead: STORAGE_COPY_LEAD, searchable_only: SEARCHABLE_ONLY_NOTE },
  };
}

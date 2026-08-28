// ===========================================================================
// Trace retention (build P0.7, spec §17.4): traces compress after 30 days —
// prompt/context hashed + sampled full-keeps. Decisions and metrics live
// elsewhere and keep forever; this job only touches the day jsonl files.
//
// For every day file older than the cutoff:
//   - every Nth record (keepEvery, default 20) is kept WHOLE and marked
//     sampled_keep — the sample that lets a human still read real prompts;
//   - every other record has its heavy fields (system_prompt, packed_context,
//     raw_output, parsed_result, verdicts) replaced by {sha256, chars} and is
//     marked compressed — the hash keeps the record verifiable against any
//     copy that survives elsewhere, at a fraction of the bytes;
//   - the file is rewritten atomically (tmp + rename), and the day's index
//     rows are flagged compressed=1 (best-effort — index and file can heal
//     independently).
//
// Idempotent: already-compressed records and already-marked keeps pass through
// unchanged, so a re-run rewrites nothing.
// ===========================================================================

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getDb } from "../db/index.js";
import {
  dayFilePath,
  ensureTracesSchema,
  tracesRoot,
  type CompressedField,
  type TraceRecord,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface RetentionOptions {
  /** "Now" for age math (tests inject). Default: wall clock. */
  now?: Date;
  /** Age at which a day compresses. Default 30 (spec §17.4). */
  maxAgeDays?: number;
  /** Keep every Nth record whole as a sample. Default 20. */
  keepEvery?: number;
}

export interface RetentionStats {
  /** Day files old enough to be considered. */
  scanned: number;
  /** Files actually rewritten this run. */
  rewrittenFiles: number;
  compressedRecords: number;
  sampledKeeps: number;
}

/** Heavy fields the compression replaces with {sha256, chars}. */
const HEAVY_FIELDS = [
  "system_prompt",
  "packed_context",
  "raw_output",
  "parsed_result",
  "verdicts",
] as const;

function isCompressedField(v: unknown): v is CompressedField {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as CompressedField).sha256 === "string" &&
    typeof (v as CompressedField).chars === "number"
  );
}

/** Hash one heavy value into its placeholder. null/undefined stay null. */
function hashField(v: unknown): CompressedField | null {
  if (v === null || v === undefined) return null;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return {
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    chars: text.length,
  };
}

/** Compress one record in place-style (returns a new object). */
function compressRecord(record: TraceRecord): TraceRecord {
  const out: Record<string, unknown> = { ...record };
  for (const field of HEAVY_FIELDS) {
    const v = out[field];
    if (v === null || v === undefined || isCompressedField(v)) continue;
    out[field] = hashField(v);
  }
  out.compressed = true;
  return out as unknown as TraceRecord;
}

/**
 * Run one compression sweep. Returns what it did; safe to call repeatedly.
 */
export function compressOldTraces(opts: RetentionOptions = {}): RetentionStats {
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const keepEvery = Math.max(1, opts.keepEvery ?? 20);
  const cutoff = new Date(now.getTime() - maxAgeDays * DAY_MS)
    .toISOString()
    .slice(0, 10);

  const stats: RetentionStats = {
    scanned: 0,
    rewrittenFiles: 0,
    compressedRecords: 0,
    sampledKeeps: 0,
  };

  const root = tracesRoot();
  if (!existsSync(root)) return stats;

  for (const name of readdirSync(root)) {
    const m = DAY_FILE_RE.exec(name);
    if (!m) continue;
    const day = m[1];
    // Strictly older than the cutoff day compresses; the cutoff day itself
    // is exactly maxAgeDays old and still within retention.
    if (day >= cutoff) continue;
    stats.scanned += 1;

    const file = dayFilePath(day);
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    let changed = false;
    const out: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      let record: TraceRecord;
      try {
        record = JSON.parse(lines[i]) as TraceRecord;
      } catch {
        out.push(lines[i]); // never destroy a line we cannot parse
        continue;
      }

      if (i % keepEvery === 0) {
        stats.sampledKeeps += 1;
        if (record.sampled_keep) {
          out.push(lines[i]);
        } else {
          out.push(JSON.stringify({ ...record, sampled_keep: true }));
          changed = true;
        }
        continue;
      }

      if (record.compressed) {
        out.push(lines[i]);
        stats.compressedRecords += 1;
        continue;
      }
      out.push(JSON.stringify(compressRecord(record)));
      stats.compressedRecords += 1;
      changed = true;
    }

    if (changed) {
      const tmp = join(root, `.${day}.jsonl.tmp`);
      writeFileSync(tmp, out.length ? `${out.join("\n")}\n` : "", "utf8");
      renameSync(tmp, file);
      stats.rewrittenFiles += 1;

      // Best-effort index flag: file and index can heal independently.
      try {
        const db = getDb();
        ensureTracesSchema(db);
        db.prepare("UPDATE traces SET compressed = 1 WHERE day = ?").run(day);
      } catch (err) {
        console.error("[traces] retention index update failed:", err);
      }
    }
  }
  return stats;
}

export interface RetentionJobHandle {
  stop(): void;
}

/**
 * Start the daily retention sweep: one pass shortly after boot (the worker may
 * have been down for weeks), then every 24h. Timers are unref'd so they never
 * hold the process open.
 */
export function startTraceRetentionJob(
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): RetentionJobHandle {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const initialDelayMs = opts.initialDelayMs ?? 60_000;

  const sweep = (): void => {
    try {
      const stats = compressOldTraces();
      if (stats.rewrittenFiles > 0) {
        console.error(
          `[traces] retention: compressed ${stats.compressedRecords} records ` +
            `across ${stats.rewrittenFiles} day file(s)`,
        );
      }
    } catch (err) {
      console.error("[traces] retention sweep failed:", err);
    }
  };

  const first = setTimeout(sweep, initialDelayMs);
  first.unref?.();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

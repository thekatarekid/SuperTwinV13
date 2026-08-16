// ===========================================================================
// [CODE] Category A executor — the real ingestion path (build item 1.1).
//
// Category A is `[CODE]`: no model is in the loop, so `frozen_response` is a
// scenario script and the executor is the product itself. Nothing here
// re-implements dedupe, ordering, filtering or clamping — every number below
// comes back out of `insertEvent`, `DescendingCohortBuffer`, `db/watermarks`
// and `adapters/normalize`, over a real temp SQLite DB with real migrations.
//
// Scenario records (one per line, `tag|field=value|…`):
//
//   dedupe|external_id=wa:0A|times=2        deliver the same message twice
//   backfill|page=3|events=4                one ASCENDING history page in
//   live|page=2                             a live message mid-backfill
//   drop|kind=read_receipt                  a non-content frame from the daemon
//   skew|delta_min=12                       a timestamp N minutes from now
//
// `external_id` is taken from the doc row verbatim — including the daemon's own
// `wa:` spelling, which is opaque to us. The id the WORKER mints is
// `<source_id>:<external_id>`, and asserting that is how these cases pin the
// leak fix: the prefix belongs to the source that ingested the row, never to
// one source's nickname baked into the writer.
//
// `assert.mode` on these fixtures is `state` (or `absent` for the drop rows),
// which is the authoring item's half of the fixture per evals/README; the
// doc-owned half (id/category/layer/call/mode/doc) is untouched.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DescendingCohortBuffer } from "../../adapters/backfill-order.js";
import { normalizeSourceEvent } from "../../adapters/normalize.js";
import type { EventKind, SourceEvent } from "../../adapters/types.js";
import { WHATSAPP_MANIFEST } from "../../adapters/whatsapp/manifest.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../../db/ingest.js";
import { noteIngestedEvent, readWatermark } from "../../db/watermarks.js";
import type { Executor, Produced } from "../runner.js";

const SOURCE_ID = WHATSAPP_MANIFEST.source_id;
const STREAM_EXT = "mom@s.whatsapp.net";
const ACTOR_EXT = "mom@s.whatsapp.net";

/** The instant every skew case is posed relative to. Frozen, so it is offline. */
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

interface ScenarioLine {
  tag: string;
  fields: Record<string, string>;
}

function parseScenario(text: string): ScenarioLine[] {
  const out: ScenarioLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`ingest scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, fields });
  }
  return out;
}

function num(fields: Record<string, string>, key: string, fallback: number): number {
  const raw = fields[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`ingest scenario: ${key}=${raw} is not a number`);
  return n;
}

function sourceEvent(over: Partial<SourceEvent> & { external_id: string; ts: string }): SourceEvent {
  return {
    stream_ext_id: STREAM_EXT,
    actor_ext_id: ACTOR_EXT,
    kind: "message",
    text: "hello",
    from_me: false,
    ...over,
  };
}

/** Write one event exactly the way the Ingestion writer does. */
function write(
  streamId: string,
  actorId: string,
  e: SourceEvent,
  historical: boolean,
): { id: string; inserted: boolean } {
  const res = insertEvent({
    externalId: e.external_id,
    sourceId: SOURCE_ID,
    sourceType: SOURCE_ID,
    streamId,
    actorId,
    ts: e.ts,
    kind: e.kind,
    text: e.text,
    mediaPath: null,
    rawJson: null,
    isHistorical: historical,
  });
  if (res.inserted) {
    noteIngestedEvent(streamId, e.ts, { historical, externalId: e.external_id });
  }
  return res;
}

/**
 * One ASCENDING history page, as whatsmeow delivers it: page 1 is the newest
 * week, page N walks backwards, and WITHIN a page the events climb. The page
 * number is what makes each of A-011…A-016 a different case.
 */
function ascendingPage(page: number, events: number): SourceEvent[] {
  const dayMs = 86_400_000;
  const base = NOW - page * 30 * dayMs;
  return Array.from({ length: events }, (_, i) =>
    sourceEvent({
      external_id: `${STREAM_EXT}/P${page}M${i}`,
      ts: new Date(base + i * 3600_000).toISOString(),
      text: `history p${page} m${i}`,
    }),
  );
}

function runScenario(response: string): Produced {
  runMigrations();
  upsertSource({ id: SOURCE_ID, type: SOURCE_ID, name: WHATSAPP_MANIFEST.display_name });
  const streamId = upsertStream({
    sourceId: SOURCE_ID,
    sourceExtId: STREAM_EXT,
    name: "Mom",
    kind: "dm",
  });
  const actorId = upsertActor({
    sourceId: SOURCE_ID,
    sourceExtId: ACTOR_EXT,
    displayName: "Mom",
    isSelf: false,
  });

  const output: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  const metrics: Record<string, number> = {};
  /** Rows that actually reached the DB — the `absent` rows assert on this. */
  const written: { external_id: string }[] = [];
  output.events = written;

  for (const { tag, fields } of parseScenario(response)) {
    switch (tag) {
      // ---- A-001…A-010: the dedupe key is the PAIR (source_id, external_id).
      case "dedupe": {
        const externalId = fields.external_id ?? "wa:0A";
        const times = num(fields, "times", 2);
        const e = sourceEvent({ external_id: externalId, ts: "2026-08-10T09:00:00.000Z" });
        const results = Array.from({ length: times }, () => write(streamId, actorId, e, false));
        state.deliveries = times;
        state.first_inserted = results[0]?.inserted ?? false;
        state.later_inserts = results.slice(1).map((r) => r.inserted);
        state.event_id = results[0]?.id ?? null;
        state.rows = countRows(externalId);
        if (results[0]?.inserted) written.push({ external_id: externalId });
        break;
      }

      // ---- A-011…A-016: history is DRIVEN newest-first even though whatsmeow
      // hands its pages over ascending (§2.2 note 1).
      case "backfill": {
        const page = num(fields, "page", 1);
        const events = num(fields, "events", 4);
        const before = readWatermark(streamId)?.backfill_low_ts ?? null;

        // The manifest promises the core `desc`; whatsmeow speaks `asc`, so the
        // buffer is what keeps the promise. Its output is what gets written.
        const buffer = new DescendingCohortBuffer<SourceEvent>("asc", {
          pageHintEvents: WHATSAPP_MANIFEST.capabilities.page_hint_events,
        });
        const delivered = ascendingPage(page, events);
        const cohorts = [...buffer.push(delivered), ...buffer.flush()];
        const emitted = cohorts.flat();
        for (const e of emitted) {
          if (write(streamId, actorId, e, true).inserted) written.push({ external_id: e.external_id });
        }

        const after = readWatermark(streamId)?.backfill_low_ts ?? null;
        state.page = page;
        state.declared_order = WHATSAPP_MANIFEST.capabilities.backfill_order;
        state.delivered_first_ts = delivered[0]!.ts;
        state.emitted_first_ts = emitted[0]!.ts;
        state.emitted_newest_first = emitted[0]!.ts === delivered[delivered.length - 1]!.ts;
        state.emitted_descending = isDescending(emitted);
        state.backfill_low_before = before;
        state.backfill_low_after = after;
        state.backfill_low_direction = direction(before, after);
        state.live_high_ts = readWatermark(streamId)?.live_high_ts ?? null;
        break;
      }

      // ---- A-017…A-020: a live message during a backfill page. The two
      // cursors are independent; neither may move the other.
      case "live": {
        const page = num(fields, "page", 1);
        const lowBefore = readWatermark(streamId)?.backfill_low_ts ?? null;
        const highBefore = readWatermark(streamId)?.live_high_ts ?? null;
        const e = sourceEvent({
          external_id: `${STREAM_EXT}/LIVE${page}`,
          ts: new Date(NOW - page * 60_000).toISOString(),
          text: "live message",
        });
        if (write(streamId, actorId, e, false).inserted) written.push({ external_id: e.external_id });

        const w = readWatermark(streamId)!;
        state.live_high_before = highBefore;
        state.live_high_after = w.live_high_ts;
        state.live_high_direction = direction(highBefore, w.live_high_ts);
        state.backfill_low_before = lowBefore;
        state.backfill_low_after = w.backfill_low_ts;
        state.backfill_low_unchanged = w.backfill_low_ts === lowBefore;
        // The two cursors never meet: the head is newer than the floor, and
        // the live event did not become the floor.
        state.cursors_collided = w.backfill_low_ts !== null && w.backfill_low_ts === w.live_high_ts;
        break;
      }

      // ---- A-021…A-024: protocol chatter is dropped AT THE ADAPTER.
      case "drop": {
        const kind = (fields.kind ?? "read_receipt") as EventKind;
        const e = sourceEvent({
          external_id: `${STREAM_EXT}/${kind.toUpperCase()}`,
          ts: "2026-08-15T11:59:00.000Z",
          kind,
          text: "",
        });
        const normalized = normalizeSourceEvent(e, NOW);
        state.kind = kind;
        state.dropped_at_adapter = normalized === null;
        if (normalized) {
          if (write(streamId, actorId, normalized, false).inserted) {
            written.push({ external_id: normalized.external_id });
          }
        }
        state.rows = countRows(e.external_id);
        break;
      }

      // ---- A-025…A-030: clamp+flag a timestamp from the future, accept the
      // rest verbatim — `ts` is the only basis for precedence (§3.3 rule 8).
      case "skew": {
        const deltaMin = num(fields, "delta_min", 0);
        const claimed = new Date(NOW + deltaMin * 60_000).toISOString();
        const e = sourceEvent({
          external_id: `${STREAM_EXT}/SKEW${deltaMin}`,
          ts: claimed,
          text: "skewed",
        });
        const normalized = normalizeSourceEvent(e, NOW)!;
        if (write(streamId, actorId, normalized, false).inserted) {
          written.push({ external_id: normalized.external_id });
        }
        state.delta_min = deltaMin;
        state.claimed_ts = claimed;
        state.stored_ts = normalized.ts;
        state.clamped = normalized.skew_clamped_from !== undefined;
        state.clamped_from = normalized.skew_clamped_from ?? null;
        state.accepted_verbatim = normalized.ts === claimed;
        break;
      }

      default:
        throw new Error(`ingest scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  metrics.events_written = written.length;
  return { output, state, metrics };
}

function isDescending(events: readonly SourceEvent[]): boolean {
  for (let i = 1; i < events.length; i += 1) {
    if (Date.parse(events[i]!.ts) > Date.parse(events[i - 1]!.ts)) return false;
  }
  return true;
}

/** "down" | "up" | "same" | "set" — which way a cursor moved. */
function direction(before: string | null, after: string | null): string {
  if (before === null) return after === null ? "same" : "set";
  if (after === null) return "cleared";
  if (after < before) return "down";
  if (after > before) return "up";
  return "same";
}

function countRows(externalId: string): number {
  // Straight off the table: the assertion is about what the UNIQUE index did,
  // so it has to be read back from the index's own table.
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE source_id = ? AND external_id = ?`)
      .get(SOURCE_ID, externalId) as { n: number }
  ).n;
}

export const ingestExecutor: Executor = ({ response }) => {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-ingest-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return runScenario(response);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

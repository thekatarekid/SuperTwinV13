// ===========================================================================
// Ingestion wiring (docs/PHASE1_CONTRACT §5, §7, §8).
//
// Bridges a SourceAdapter's callbacks into the DB:
//   - registers the source row on startup,
//   - upserts channels/actors (+ people) as they arrive,
//   - writes events with dedupe (insertEvent → ON CONFLICT DO NOTHING),
//   - persists the self JID (for fromMe) and the kill-switch paused flag into
//     app_state, and skips ingestion while paused,
//   - keeps the latest AdapterStatus in memory and fans status frames out to
//     SSE subscribers (the API layer).
//
// This module has NO HTTP concerns — the server imports the Ingestion instance
// and reads status / subscribes to the status stream.
// ===========================================================================

import { DescendingCohortBuffer } from "../adapters/backfill-order.js";
import { readAnchors, type Anchor } from "../db/anchors.js";
import type { SourceManifest } from "../adapters/registry.js";
import type { SourceAdapter } from "../adapters/source-adapter.js";
import { isRange } from "../adapters/types.js";
import type {
  Actor,
  AdapterStatus,
  MediaInfo,
  Range,
  RangeCounts,
  SourceEvent,
  StatusUpdate,
  Stream,
} from "../adapters/types.js";
import {
  applyEdit,
  applyRevoke,
  appStateGet,
  appStateSet,
  clearImportFlags,
  deleteReaction,
  importDoneKey,
  importRangeKey,
  insertEvent,
  pausedKey,
  setSelfIdentity,
  upsertActor,
  upsertSource,
  upsertStream,
} from "../db/ingest.js";
import type { MediaMeta } from "../db/ingest.js";
import { deleteSourceData, type SourceDeleteResult } from "../library/source-verbs.js";
import {
  hasUnsealedStreams,
  markSourceBackfillComplete,
  noteIngestedEvent,
} from "../db/watermarks.js";
import { bridgeIngestedEvents } from "../bridges/ingest.js";
import { noteUserReply } from "../categories/promotion.js";
import { ensureEntityForActor } from "../entities/from-ingest.js";
import { enqueueLiveMedia } from "../media/queue.js";
import { consumeApprovalToken } from "../approvals/tokens.js";
import { noteCapturedDeferred, setHistoryFloorForRange } from "../coverage/index.js";
import { HistoryHealth } from "./history-health.js";

/** Live-ingest nudge debounce (Rev 2 §R2.2): coalesce bursts into one frame. */
const NUDGE_DEBOUNCE_MS = 750;
/** Cap the stream-id array in a nudge; presence of the frame is the signal. */
const NUDGE_MAX_STREAMS = 50;

/**
 * How long a history burst may sit in the re-order buffer before it is written.
 * The buffer only exists to turn an ascending daemon into descending cohorts
 * (arch §2.2 note 1); a burst that stops arriving must still land, so a quiet
 * gap flushes it.
 */
const BACKFILL_FLUSH_MS = 250;

/**
 * How long ingest must be quiet before the import is SEALED — i.e. before every
 * stream of the source is marked `backfill_complete` (db/watermarks).
 *
 * The daemon's `backfill_complete` frame is not the end of the import, only the
 * end of the *push*: on a real 30-day WhatsApp sync the last rows landed up to
 * 96s after that frame, so sealing on the frame alone left every stream created
 * afterwards at `backfill_complete = 0` — and `modeAfterBackfill`
 * (scheduler/horizons) then reports "bootstrap" for ever. The seal is therefore
 * re-armed by every row that inserts and only fires once nothing has landed for
 * this long.
 *
 * The frame can also land in DEAD AIR: whatsapp-go emits it at connect+0 with
 * chats=0, BEFORE whatsmeow's history-sync payloads arrive, so the first seal
 * fires over an empty database. The seal is therefore RE-ARMABLE after it has
 * fired (`touchBackfillSeal`), gated on `hasUnsealedStreams` so ordinary live
 * traffic on a fully sealed source never re-arms it — each late wave of history
 * re-seals exactly once and the loop converges.
 */
const BACKFILL_SEAL_MS = 5_000;

/**
 * Pack the low-traffic media fields into `events.media_meta_json` (media spec
 * §1). Only the fields the daemon actually sent are written, so an absent value
 * stays absent instead of becoming a 0/false the UI would have to second-guess;
 * an all-empty meta collapses to null rather than "{}".
 */
function mediaMetaJson(media: MediaInfo | null | undefined): string | null {
  if (!media) return null;
  const meta: MediaMeta = {};
  if (media.width) meta.width = media.width;
  if (media.height) meta.height = media.height;
  if (media.pages) meta.pages = media.pages;
  if (media.caption) meta.caption = media.caption;
  if (media.voice) meta.voice = true;
  if (media.animated) meta.animated = true;
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
}

/**
 * What lands in `events.raw_json`. Normally the source's own raw payload; when
 * the adapter had to clamp a future timestamp (normalize.ts), the original
 * value rides along so a wrong phone clock stays visible instead of being
 * silently absorbed into `ts`.
 */
function rawJson(e: SourceEvent): string | null {
  if (e.skew_clamped_from === undefined) {
    return e.raw === undefined ? null : JSON.stringify(e.raw);
  }
  const base =
    e.raw !== null && typeof e.raw === "object" && !Array.isArray(e.raw)
      ? (e.raw as Record<string, unknown>)
      : e.raw === undefined
        ? {}
        : { raw: e.raw };
  return JSON.stringify({ ...base, skew_clamped_from: e.skew_clamped_from });
}

export interface IngestionStats {
  streamsUpserted: number;
  actorsUpserted: number;
  eventsInserted: number;
  eventsDeduped: number;
}

export interface IngestionOptions {
  /**
   * The source's manifest (arch §2.2). Optional only so the Ingestion class
   * stays constructible in tests that care about nothing else; when it is
   * present, `capabilities.backfill_order` decides whether history is
   * re-ordered into descending cohorts on the way in.
   */
  manifest?: SourceManifest<SourceEvent>;
  /**
   * Overrides for the shallow-bootstrap watcher's quiet windows. Tests pass
   * milliseconds so a "settled import" is not a real minute away.
   */
  historyQuietMs?: number;
  extendSettleMs?: number;
  /** Diagnostics sink (defaults to silent), shared with HistoryHealth. */
  log?: (line: string) => void;
}

export class Ingestion {
  private readonly adapter: SourceAdapter;
  private readonly manifest: SourceManifest<SourceEvent> | null;
  private lastStatus: AdapterStatus;
  private paused = false;
  private readonly statusSubs = new Set<(s: StatusUpdate) => void>();

  // Persisted import state (Rev 2 §R2.1). Seeded from app_state on start() so a
  // relaunch reports importDone:true immediately. (Field name avoids colliding
  // with the importRange() control method below.)
  private importDone = false;
  private importRangeValue: Range | undefined;

  // Live-ingest nudge debounce (Rev 2 §R2.2). Distinct stream ids touched since
  // the last flushed nudge, plus the pending timer.
  private pendingNudgeStreams = new Set<string>();
  private nudgeTimer: NodeJS.Timeout | null = null;

  // Newest-page-first history (arch §2.2 note 1). Historical events are held
  // just long enough to be handed on in descending cohorts; live events never
  // enter the buffer — a message arriving now is already the newest thing there
  // is, and delaying it to sort it would be absurd.
  private readonly backfillBuffer: DescendingCohortBuffer<SourceEvent> | null;
  private backfillTimer: NodeJS.Timeout | null = null;

  // Post-import seal (see BACKFILL_SEAL_MS). Armed by the daemon's
  // `backfill_complete`, re-armed by every row that inserts after it.
  private backfillSealTimer: NodeJS.Timeout | null = null;

  /**
   * Shallow-bootstrap detection + extend accounting (ingest/history-health.ts).
   * Deliberately NOT driven off `backfill_complete`: that frame has been seen
   * firing 15s BEFORE the first history batch, so it cannot say what arrived.
   */
  private readonly health: HistoryHealth;

  readonly stats: IngestionStats = {
    streamsUpserted: 0,
    actorsUpserted: 0,
    eventsInserted: 0,
    eventsDeduped: 0,
  };

  constructor(adapter: SourceAdapter, opts: IngestionOptions = {}) {
    this.adapter = adapter;
    this.manifest = opts.manifest ?? null;
    this.lastStatus = adapter.getStatus();
    const cap = this.manifest?.capabilities;
    this.backfillBuffer = cap
      ? new DescendingCohortBuffer<SourceEvent>(
          // The manifest states the order the CORE is served. whatsmeow hands
          // its history over ascending, so "desc" here means "re-order it",
          // which is exactly what the buffer is for.
          cap.backfill_order === "desc" ? "asc" : cap.backfill_order,
          { pageHintEvents: cap.page_hint_events },
        )
      : null;
    this.health = new HistoryHealth({
      sourceId: adapter.sourceId,
      emit: (frame) => this.emitFrame(frame),
      ...(opts.historyQuietMs === undefined ? {} : { quietMs: opts.historyQuietMs }),
      ...(opts.extendSettleMs === undefined
        ? {}
        : { extendSettleMs: opts.extendSettleMs }),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  /** The manifest this source was registered with, if any. */
  getManifest(): SourceManifest<SourceEvent> | null {
    return this.manifest;
  }


  /**
   * Register the source row, seed the persisted kill-switch, and subscribe to
   * the adapter's callbacks. Call once before `adapter.connect()`.
   */
  start(): void {
    upsertSource({
      id: this.adapter.sourceId,
      type: this.adapter.sourceType,
      name: this.manifest?.display_name ?? this.adapter.sourceId,
    });

    // Restore the kill-switch flag (survives restart).
    this.paused = appStateGet(pausedKey(this.sourceId)) === "1";

    // Restore persisted import state (Rev 2 §R2.1) so a relaunch reports
    // importDone:true immediately after boot when it was set previously.
    this.importDone = appStateGet(importDoneKey(this.sourceId)) === "true";
    const savedRange = appStateGet(importRangeKey(this.sourceId));
    this.importRangeValue = isRange(savedRange) ? savedRange : undefined;

    // Self-heal an install whose import finished but whose watermarks never got
    // the flag — either an older build that sealed before the streams existed,
    // or a crash between the daemon's `backfill_complete` and this run's seal.
    // `import_done` is the authority on "history was pushed"; the watermarks are
    // just its per-stream record, so re-deriving them from it is safe. Costs one
    // SELECT when there is nothing to repair.
    if (this.importDone) markSourceBackfillComplete(this.sourceId);

    // A verdict reached on a previous run still describes the data on disk, so
    // the Inbox must not forget it across a relaunch. An install whose import
    // finished BEFORE this detection existed has no verdict to restore and no
    // history left to arrive, so nothing would ever arm the quiet window —
    // judge it once here instead, from the shape of what it already holds.
    this.health.restore();
    if (this.importDone && !this.health.getDepth()) this.health.judge();
    if (
      "setPaused" in this.adapter &&
      typeof (this.adapter as { setPaused?: unknown }).setPaused === "function"
    ) {
      (this.adapter as { setPaused(p: boolean): void }).setPaused(this.paused);
    }

    // Back-pagination anchors. The daemon's own map is in-memory and empty after
    // any restart, and whatsmeow's store cannot rebuild it (no message
    // timestamps) — so this DB is the only durable source, and without it
    // "Extend history" paginates nothing. Read lazily on each seed so a daemon
    // restarting hours later gets the anchors as they are THEN, not at boot.
    if (
      "setAnchorProvider" in this.adapter &&
      typeof (this.adapter as { setAnchorProvider?: unknown }).setAnchorProvider ===
        "function"
    ) {
      (
        this.adapter as { setAnchorProvider(p: () => Anchor[]): void }
      ).setAnchorProvider(() => readAnchors(this.sourceId));
    }

    // Returning user: install the persisted import range in the daemon at
    // connect (set_range) so WhatsApp's automatic post-pairing history is filtered
    // by the chosen window before it lands. A first pair has no persisted range —
    // its pushed history buffers daemon-side until the user picks one in
    // onboarding (then `import` installs it), so we deliberately install nothing.
    if (this.importRangeValue) {
      void this.adapter.setRange?.(this.importRangeValue);
    }

    this.adapter.onStream((s) => this.onStream(s));
    this.adapter.onActor((a) => this.onActor(a));
    this.adapter.onEvent((e) => this.onEvent(e));
    this.adapter.onStatus((s) => this.onStatus(s));
  }

  // ---- Status fan-out -------------------------------------------------------

  getStatus(): AdapterStatus {
    // Merge adapter's live status with our persisted paused + import flags.
    return {
      ...this.adapter.getStatus(),
      ...this.lastStatus,
      paused: this.paused,
      importDone: this.importDone,
      ...(this.importRangeValue ? { importRange: this.importRangeValue } : {}),
      ...(this.health.getDepth() ? { historyDepth: this.health.getDepth()! } : {}),
      ...(this.health.getExtend() ? { lastExtend: this.health.getExtend()! } : {}),
    };
  }

  subscribeStatus(cb: (s: StatusUpdate) => void): () => void {
    this.statusSubs.add(cb);
    return () => this.statusSubs.delete(cb);
  }

  private onStatus(s: StatusUpdate): void {
    // Track the freshest snapshot from the adapter for the /status endpoint.
    this.lastStatus = this.adapter.getStatus();

    // History is exhausted: flush whatever the re-order buffer still holds, so
    // the tail of an ascending import is not left waiting on a timer, persist
    // the import state (Rev 2 §R2.1 — the first completed backfill pins
    // import_done=true + the range so a relaunch skips the range picker), then
    // seal.
    //
    // The seal runs TWICE on purpose: optimistically now, for the streams that
    // already exist, and again once ingest has been quiet for BACKFILL_SEAL_MS,
    // for the tail that is still landing. `import_done` is written BEFORE the
    // first seal so a crash in the window between them is repaired by the boot
    // pass in start().
    if (s.type === "backfill_complete") {
      this.flushBackfill();
      this.markImportDone(s.range);
      markSourceBackfillComplete(this.sourceId);
      this.scheduleBackfillSeal();
      // The frame says the PUSH stopped, not that history arrived — it has been
      // observed firing at connect+0 with chats=0. So it only arms the quiet
      // window; the verdict comes from what has actually landed a minute later.
      this.health.noteHistoryActivity();
      this.health.noteExtendChats(s.chats);
    }

    // Per-payload counters from the daemon (optional frame — absent daemons just
    // never reach here, and detection falls back to the shape of what landed).
    if (s.type === "history_sync") this.health.notePayload(s.payload);

    for (const cb of this.statusSubs) {
      try {
        cb(s);
      } catch {
        /* subscriber threw — never let it break ingestion */
      }
    }
  }

  /**
   * Fan a frame out to SSE subscribers WITHOUT re-snapshotting adapter status
   * (used for the synthetic ingest nudge, which is not an adapter status change).
   */
  private emitFrame(s: StatusUpdate): void {
    for (const cb of this.statusSubs) {
      try {
        cb(s);
      } catch {
        /* subscriber threw — never let it break ingestion */
      }
    }
  }

  // ---- Persisted import state (Rev 2 §R2.1) --------------------------------

  /** Record that a backfill/import finished with `range`. Idempotent. */
  private markImportDone(range: Range): void {
    this.importDone = true;
    this.importRangeValue = range;
    appStateSet(importDoneKey(this.sourceId), "true");
    appStateSet(importRangeKey(this.sourceId), range);
    this.noteHistoryFloor(range);
  }

  /**
   * Coverage index (S2.7): the chosen import range is the adapter's statement
   * of what was never captured — "nothing before <cutoff>" — so an answer can
   * say "I only have WhatsApp back to Jan 2024" instead of guessing. Best
   * effort: coverage bookkeeping never fails an import.
   */
  private noteHistoryFloor(range: Range): void {
    try {
      setHistoryFloorForRange(this.sourceId, range);
    } catch (err) {
      console.warn(`[ingest] coverage floor note failed (continuing): ${(err as Error).message}`);
    }
  }

  /**
   * Clear the in-memory import flags after a reset (Rev 2 §R2.3). The persisted
   * app_state rows are cleared inside deleteSourceData()'s transaction; this
   * keeps the live /status snapshot consistent (importDone:false) without a
   * relaunch.
   */
  clearImportState(): void {
    this.importDone = false;
    this.importRangeValue = undefined;
    // The depth verdict and the extend outcome both describe data that is about
    // to be (or has just been) wiped, so they go with it rather than outliving
    // the rows they were measured from.
    this.health.clear();
  }

  // ---- Kill-switch ----------------------------------------------------------

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    appStateSet(pausedKey(this.sourceId), paused ? "1" : "0");
    await this.adapter.pause(paused);
    // Emit a synthetic status frame so subscribers see the change immediately.
    this.onStatus({ type: "status", state: this.getStatus().state });
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ---- Ingestion handlers ---------------------------------------------------

  private onStream(s: Stream): void {
    upsertStream({
      sourceId: this.sourceId,
      sourceExtId: s.source_ext_id,
      name: s.name,
      kind: s.kind,
      isBusiness: s.is_business,
    });
    this.stats.streamsUpserted += 1;
    // A stream announced after `backfill_complete` is exactly what the seal is
    // waiting for, even when it never carries an event of its own.
    this.touchBackfillSeal();
  }

  private onActor(a: Actor): void {
    upsertActor({
      sourceId: this.sourceId,
      sourceExtId: a.source_ext_id,
      displayName: a.display_name,
      handle: a.handle ?? null,
      isSelf: a.is_self,
    });
    this.stats.actorsUpserted += 1;
    // Entities from ingest (P1.1, spec §7.2 rung 1): the structural rung —
    // every announced actor becomes/touches a (provisional) entity bound by
    // jid + encoded phone. Best-effort: never blocks the actor upsert.
    try {
      ensureEntityForActor({
        sourceId: this.sourceId,
        jid: a.source_ext_id,
        displayName: a.display_name ?? null,
        isSelf: a.is_self === true,
      });
    } catch (err) {
      console.error(`[ingest] entity-from-actor failed (continuing): ${String(err)}`);
    }
    if (a.is_self && a.source_ext_id) {
      // How "me" appears in this source — what the manifest's
      // self_identity.value_getter reads back (arch §2.2 note 4).
      setSelfIdentity(this.sourceId, a.source_ext_id);
    }
  }

  /** The source id everything this instance writes is namespaced by. */
  get sourceId(): string {
    return this.adapter.sourceId;
  }

  /**
   * Every event the adapter emits enters here. Live events are written
   * immediately; historical ones go through the descending-cohort buffer first,
   * so the newest history is written before the oldest even when the daemon can
   * only walk forwards (arch §2.2 note 1, build item 1.1).
   */
  private onEvent(e: SourceEvent): void {
    // Kill-switch: never ingest while paused.
    if (this.paused) return;

    if (e.is_historical === true && this.backfillBuffer) {
      for (const cohort of this.backfillBuffer.pushEvent(e)) this.writeCohort(cohort);
      this.scheduleBackfillFlush();
      return;
    }
    this.writeEvent(e);
  }

  /** Write one descending cohort, newest first. */
  private writeCohort(cohort: readonly SourceEvent[]): void {
    for (const event of cohort) this.writeEvent(event);
  }

  /**
   * Flush the re-order buffer after a quiet gap. History arrives in bursts and
   * the burst boundary is the only page boundary the daemon gives us.
   */
  private scheduleBackfillFlush(): void {
    if (this.backfillTimer) return;
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      this.flushBackfill();
    }, BACKFILL_FLUSH_MS);
    this.backfillTimer.unref?.();
  }

  /** Write everything still buffered, newest cohort first. */
  flushBackfill(): void {
    if (!this.backfillBuffer) return;
    for (const cohort of this.backfillBuffer.flush()) this.writeCohort(cohort);
  }

  // ---- Post-import seal ----------------------------------------------------

  /**
   * (Re)arm the seal. Unlike the nudge debounce this one RESETS on every call:
   * the window has to be measured from the last row that landed, not from the
   * first, or a 96s tail seals 91s too early.
   */
  private scheduleBackfillSeal(): void {
    if (this.backfillSealTimer) clearTimeout(this.backfillSealTimer);
    this.backfillSealTimer = setTimeout(() => this.sealBackfill(), BACKFILL_SEAL_MS);
    this.backfillSealTimer.unref?.();
  }

  /**
   * Extend an ALREADY-ARMED seal — or RE-ARM one that has already fired.
   *
   * The re-arm is what fixes the dead-air frame: the daemon can announce
   * `backfill_complete` seconds before the first history payload lands, so the
   * first seal fires over nothing and every stream created afterwards would
   * stay unsealed (and tier-NULL) for ever if the seal were one-shot.
   *
   * Two gates keep this convergent instead of a live-traffic loop:
   *   - `importDone` — a row landing before the daemon said `backfill_complete`
   *     is just the import running; it must not arm a seal of its own.
   *   - `hasUnsealedStreams` — one index probe. Once a seal has caught every
   *     stream, live messages on sealed streams answer false and nothing
   *     re-arms; only a write that could have created an UNSEALED stream (late
   *     history, a brand-new chat) buys another seal, and that seal marks it,
   *     so each re-arm retires the condition that caused it.
   */
  private touchBackfillSeal(): void {
    if (this.backfillSealTimer) {
      this.scheduleBackfillSeal();
      return;
    }
    if (this.importDone && hasUnsealedStreams(this.sourceId)) this.scheduleBackfillSeal();
  }

  /**
   * Ingest has been quiet since the daemon finished pushing: every stream the
   * import produced exists now, so mark the ones the optimistic first pass could
   * not see. Sticky and re-runnable, so this costs one SELECT when the first
   * pass already caught everything.
   */
  private sealBackfill(): void {
    this.backfillSealTimer = null;
    // The re-order buffer holds a burst that has not been written yet: sealing
    // under it would mark streams complete while their rows are still in
    // memory. A pending flush means ingest is NOT quiet — wait another window.
    if (this.backfillTimer) {
      this.scheduleBackfillSeal();
      return;
    }
    markSourceBackfillComplete(this.sourceId);

    // Tiering (item 1.2, arch §9.3 rule 4) hangs off THIS edge, not off the
    // daemon's `backfill_complete` frame: the boot pass in ../index.ts runs
    // before a single stream exists on a cold install, and the frame itself
    // lands 10-96s before the last stream does. This is the first moment every
    // imported stream is in the DB, so it is the first moment a tier backfill
    // is not vacuous. `streams.tier` NULL is what makes a channel unreachable
    // by every scheduler lane, so this is the precondition for all of it.
    //
    // Fire-and-forget on purpose — ingest must never block on a tier pass — and
    // `ensureTiers` never throws (it reports `ok:false`), so the `.catch` is
    // belt-and-braces. Zero LLM calls unless SUPERTWIN_TIER_MODEL is opted in.
    // (P0.3) The V11 tier backfill was deleted with the derivation middle; the
    // V13 stream tiering lands with the P0.4 streams table + P0.5 scheduler.
  }

  private writeEvent(e: SourceEvent): void {
    // Resolve (lazy upsert) stream + actor ids per contract §5 mapping.
    const streamId = upsertStream({
      sourceId: this.sourceId,
      sourceExtId: e.stream_ext_id,
    });
    const actorId = upsertActor({
      sourceId: this.sourceId,
      sourceExtId: e.actor_ext_id,
    });

    // Threading (§R5.3/§R5.4): resolve the target ref + quoted snippet.
    //   - reaction (kind='reaction'): the daemon sends the TARGET message id via
    //     `reply_to_external_id`, and `text` carries the emoji ("" = removal).
    //   - quoted reply: the daemon sends a `reply_to` object; map its external_id
    //     → reply_to_external_id and its text → reply_to_text. (If both are
    //     present, reply_to.external_id wins as the canonical target ref.)
    const replyToExternalId =
      e.reply_to?.external_id ?? e.reply_to_external_id ?? null;
    const replyToText = e.reply_to?.text ?? null;

    // Mutations of an already-stored event (media spec §5, §6). Each rewrites its
    // TARGET row and is not itself an event worth keeping — except when the
    // target has not arrived yet (out-of-order history sync), where we fall
    // through to the insert path so nothing is lost.
    if (e.edit_of_external_id) {
      if (
        applyEdit({
          sourceId: this.sourceId,
          targetExternalId: e.edit_of_external_id,
          text: e.text ?? "",
          editedAt: e.ts,
        })
      ) {
        this.nudge(streamId);
        return;
      }
    } else if (e.revoke_of_external_id) {
      if (
        applyRevoke({
          sourceId: this.sourceId,
          targetExternalId: e.revoke_of_external_id,
          revokedAt: e.ts,
        })
      ) {
        this.nudge(streamId);
        return;
      }
    } else if (
      e.kind === "reaction" &&
      (e.text ?? "") === "" &&
      replyToExternalId
    ) {
      // Removal (§6): drop this actor's stored reaction instead of recording an
      // empty one. Nothing stored => nothing to do, and no row to insert either.
      if (
        deleteReaction({
          sourceId: this.sourceId,
          targetExternalId: replyToExternalId,
          actorId,
        }) > 0
      ) {
        this.nudge(streamId);
      }
      return;
    }

    const res = insertEvent({
      externalId: e.external_id,
      sourceId: this.sourceId,
      sourceType: this.adapter.sourceType,
      streamId,
      actorId,
      ts: e.ts,
      kind: e.kind,
      text: e.text ?? "",
      mediaPath: e.media?.path ?? null,
      rawJson: rawJson(e),
      replyToExternalId,
      replyToText,
      mediaMime: e.media?.mime ?? null,
      mediaFilename: e.media?.filename ?? null,
      mediaSize: e.media?.size ?? null,
      mediaSha256: e.media?.sha256 ?? null,
      mediaThumbPath: e.media?.thumb_path ?? null,
      mediaSeconds: e.media?.seconds ?? null,
      mediaMetaJson: mediaMetaJson(e.media),
      isForwarded: e.is_forwarded ?? false,
      linkUrl: e.link?.url ?? null,
      linkTitle: e.link?.title ?? null,
      linkDescription: e.link?.description ?? null,
      linkThumbPath: e.link?.thumb_path ?? null,
      linkPreviewType: e.link?.preview_type ?? null,
      isHistorical: e.is_historical ?? false,
      // Full v13 envelope (P0.6, spec §6.1): built by the adapter with the
      // observed roster, structural mentions, and reply markers. When absent
      // (a source without envelope support yet), insertEvent derives the
      // minimal legacy envelope instead.
      ...(e.envelope
        ? {
            envelope: {
              capturedAt: e.envelope.captured_at,
              origin: e.envelope.origin,
              ageBand: e.envelope.age_band,
              actor: e.envelope.actor,
              rolesJson: JSON.stringify(e.envelope.roles),
              payloadJson: JSON.stringify(e.envelope.payload),
              contentHash: e.envelope.content_hash,
              blobRefsJson: JSON.stringify(e.envelope.blob_refs),
              streamKey: e.envelope.stream_key,
            },
          }
        : {}),
    });

    if (res.inserted) {
      this.stats.eventsInserted += 1;
      // Coverage index (S2.7): one day row per (source, day), buffered and
      // flushed on a short timer so a 100k-message import costs one upsert per
      // day, not one per message.
      noteCapturedDeferred(this.sourceId, e.ts);
      // The two cursors move in opposite directions and never touch: a history
      // page lowers the floor, a live message lifts the head (db/watermarks).
      noteIngestedEvent(streamId, e.ts, {
        historical: e.is_historical === true,
        externalId: e.external_id,
      });
      // An attachment that just landed is read now rather than waiting its turn
      // behind the import backlog (media spec §8) — but history sync arrives
      // through this same callback, and an import IS the backlog, not something
      // entitled to jump it.
      if (e.media?.path) enqueueLiveMedia(res.id, e.is_historical === true);
      // Bridge extraction at ingest (P1.1, spec §19 "built, never wired —
      // wire it"): url/phone/email/order-id literals → event_bridge_keys +
      // pair rows against past holders. Best-effort; never blocks ingest.
      try {
        bridgeIngestedEvents([res.id]);
      } catch (err) {
        console.error(`[ingest] bridge extraction failed (continuing): ${String(err)}`);
      }
      // Engagement + Cat-2 -> Cat-1 promotion (P1.6, spec §5.1, eval CAT-03):
      // a self-authored message is user engagement — it bumps the stream's
      // engagement score and INSTANTLY promotes a Cat-2 stream with
      // retroactive full processing. Best-effort; never blocks ingest.
      if (e.envelope?.actor === "self") {
        try {
          noteUserReply(streamId, e.ts);
        } catch (err) {
          console.error(`[ingest] engagement note failed (continuing): ${String(err)}`);
        }
      }
      // A row that lands after `backfill_complete` pushes the seal out: it may
      // have created the stream this write just upserted.
      this.touchBackfillSeal();
      // History still moving => push the depth judgement out. A row that landed
      // during an "Extend history" run is what that run RECOVERED — inserted,
      // so a re-fetched page that deduped away is correctly not counted.
      if (e.is_historical === true) this.health.noteHistoryActivity();
      this.health.noteExtendInsert(streamId);
      this.nudge(streamId);
    } else {
      this.stats.eventsDeduped += 1;
    }
  }

  // ---- Live-ingest nudge (Rev 2 §R2.2) -------------------------------------

  /**
   * A stream's stored messages changed — schedule a debounced frame so the UI
   * refetches. Fires for ALL persisted changes, including from_me / self-chat
   * (bug 2) and in-place edits/revokes/reaction removals, which produce no new
   * row but do change what the chat renders.
   */
  private nudge(streamId: string): void {
    if (streamId) this.pendingNudgeStreams.add(streamId);
    this.scheduleNudge();
  }

  /**
   * Schedule (or extend) the debounced ingest nudge. Coalesces a burst of
   * persisted events into a single `{ type:"ingest", ts, channels }` frame fanned
   * out on the same status stream that /api/sources/:source_id/stream forwards.
   */
  private scheduleNudge(): void {
    if (this.nudgeTimer) return; // a flush is already pending; it will include us
    this.nudgeTimer = setTimeout(() => this.flushNudge(), NUDGE_DEBOUNCE_MS);
    this.nudgeTimer.unref?.();
  }

  private flushNudge(): void {
    this.nudgeTimer = null;
    const streams = [...this.pendingNudgeStreams].slice(0, NUDGE_MAX_STREAMS);
    this.pendingNudgeStreams.clear();
    // `channels` carries the same ids under their old name for one release, so
    // the UI keeps refetching while it is rewritten (arch §3.3 leak 6).
    this.emitFrame({
      type: "ingest",
      ts: new Date().toISOString(),
      streams,
      channels: streams,
    });
  }

  // ---- Control passthrough --------------------------------------------------

  async pair(): Promise<void> {
    await this.adapter.startPairing();
  }

  /**
   * Measured per-window counts from the daemon (S1.5 / T4-7) — what each
   * import window would deliver, over the history it has actually received.
   * Read-only: no range is installed, nothing is ingested. Rejects when the
   * source cannot answer (no daemon, no count support, timeout).
   */
  async countRange(): Promise<RangeCounts> {
    const adapter = this.adapter;
    if (typeof adapter.countRange !== "function") {
      throw new Error("COUNTS_UNAVAILABLE: source cannot measure windows");
    }
    return adapter.countRange();
  }

  async importRange(range: Range): Promise<void> {
    await this.adapter.backfill(range);
    // Persist the CHOSEN range so a relaunch mid-backfill remembers it — but do
    // NOT advance the import watermark here (P0.6): importDone (and the
    // per-stream backfill_complete seal) advances only on the DAEMON'S
    // completion signal (`backfill_complete`, handled in onStatus). A crash
    // mid-import must come back as "still importing", never as "done".
    this.importRangeValue = range;
    appStateSet(importRangeKey(this.sourceId), range);
    this.noteHistoryFloor(range);
  }

  /**
   * Send one message through the source (P0.6) — the ONLY send path, and it is
   * double-gated: the single-use approval token is consumed HERE (atomic
   * UPDATE; invalid/expired/used ⇒ hard error, adapter never called), and the
   * daemon independently refuses a send_message without a fresh token. The
   * outcome arrives on the status stream as a `send_result` frame.
   */
  async sendMessage(params: {
    to: string;
    text: string;
    approvalToken: string;
  }): Promise<void> {
    const adapter = this.adapter;
    if (typeof adapter.sendMessage !== "function") {
      throw new Error("SEND_REFUSED: source has no send path");
    }
    const action = `${this.sourceId}.send`;
    // The token is BOUND to the approved payload (V6 P1 S4.5): consuming it
    // proves this exact recipient and this exact text were what the tap saw.
    // A token approved for Rohan cannot send to Karan, and an edited draft
    // cannot ride an old approval — the consume simply fails, and fails
    // WITHOUT burning the token the user actually granted.
    if (
      !consumeApprovalToken(params.approvalToken, action, {
        bind: { to: params.to, text: params.text },
      })
    ) {
      throw new Error(
        "SEND_REFUSED: approval token invalid, expired, already used, or approved for a different message",
      );
    }
    await adapter.sendMessage(params.to, params.text, params.approvalToken);
  }

  /**
   * Widen coverage to older history. WhatsApp answers an on-demand request with
   * at most 50 messages per chat, so one click is never exhaustive — the outcome
   * this run reports (`lastExtend`) says how many messages actually persisted
   * and whether more could be waiting, instead of leaving the user to guess
   * whether the button did anything.
   */
  async extend(range: Range): Promise<void> {
    this.health.startExtend(range);
    await this.adapter.extend(range);
    this.noteHistoryFloor(range);
  }


  /**
   * Standalone logout (Rev 3 §R3.2): unlink the whatsmeow session AND clear the
   * persisted import flags so onboarding restarts cleanly (range picker) once
   * the daemon re-pairs. Does NOT wipe already-imported data (that is what
   * `relink` adds on top).
   */
  async logout(): Promise<void> {
    clearImportFlags(this.sourceId);
    this.clearImportState();
    await this.adapter.logout();
  }

  /**
   * Re-link (Rev 3 §R3.2): a full clean re-sync. WhatsApp only pushes history to
   * a linked device ONCE (right after linking), so a silent reset can't recover
   * wiped history — the user must re-link. Steps:
   *   (1) wipe all ingested data for this source (events/streams/actors/people),
   *   (2) clear the persisted import flags (+ in-memory snapshot),
   *   (3) send `logout` to the daemon — it clears its session and exits 0; the
   *       adapter restarts it fresh into pairing (need_pairing → qr on pair).
   * deleteSourceData() (V6 S1.7 — every event through the honest cascade, then
   * the shells) clears the import flags inside its transaction; we still clear
   * the in-memory snapshot so /status reports importDone:false immediately
   * without a relaunch.
   */
  async relink(): Promise<SourceDeleteResult> {
    const cleared = deleteSourceData(this.sourceId, { reason: "user re-linked WhatsApp (clean re-sync)" });
    this.clearImportState();
    await this.adapter.logout();
    return cleared;
  }
}

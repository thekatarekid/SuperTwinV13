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

import type { SourceAdapter } from "../adapters/source-adapter.js";
import { isRange } from "../adapters/types.js";
import type {
  Actor,
  AdapterStatus,
  Channel,
  MediaInfo,
  Range,
  SourceEvent,
  StatusUpdate,
} from "../adapters/types.js";
import {
  applyEdit,
  applyRevoke,
  appStateGet,
  appStateSet,
  clearImportFlags,
  deleteReaction,
  IMPORT_DONE_KEY,
  IMPORT_RANGE_KEY,
  insertEvent,
  resetWhatsappData,
  upsertActor,
  upsertChannel,
  upsertSource,
} from "../db/ingest.js";
import type { MediaMeta } from "../db/ingest.js";
import { enqueueLiveMedia } from "../media/queue.js";

const PAUSED_KEY = "whatsapp.paused";
const SELF_JID_KEY = "whatsapp.self_jid";

/** Live-ingest nudge debounce (Rev 2 §R2.2): coalesce bursts into one frame. */
const NUDGE_DEBOUNCE_MS = 750;
/** Cap the channel-id array in a nudge; presence of the frame is the signal. */
const NUDGE_MAX_CHANNELS = 50;

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

export interface IngestionStats {
  channelsUpserted: number;
  actorsUpserted: number;
  eventsInserted: number;
  eventsDeduped: number;
}

export class Ingestion {
  private readonly adapter: SourceAdapter;
  private lastStatus: AdapterStatus;
  private paused = false;
  private readonly statusSubs = new Set<(s: StatusUpdate) => void>();

  // Persisted import state (Rev 2 §R2.1). Seeded from app_state on start() so a
  // relaunch reports importDone:true immediately. (Field name avoids colliding
  // with the importRange() control method below.)
  private importDone = false;
  private importRangeValue: Range | undefined;

  // Live-ingest nudge debounce (Rev 2 §R2.2). Distinct channel ids touched since
  // the last flushed nudge, plus the pending timer.
  private pendingNudgeChannels = new Set<string>();
  private nudgeTimer: NodeJS.Timeout | null = null;

  readonly stats: IngestionStats = {
    channelsUpserted: 0,
    actorsUpserted: 0,
    eventsInserted: 0,
    eventsDeduped: 0,
  };

  constructor(adapter: SourceAdapter) {
    this.adapter = adapter;
    this.lastStatus = adapter.getStatus();
  }

  /**
   * Register the source row, seed the persisted kill-switch, and subscribe to
   * the adapter's callbacks. Call once before `adapter.connect()`.
   */
  start(): void {
    upsertSource({
      id: this.adapter.sourceId,
      type: this.adapter.sourceType,
      name: "WhatsApp",
    });

    // Restore the kill-switch flag (survives restart).
    this.paused = appStateGet(PAUSED_KEY) === "1";

    // Restore persisted import state (Rev 2 §R2.1) so a relaunch reports
    // importDone:true immediately after boot when it was set previously.
    this.importDone = appStateGet(IMPORT_DONE_KEY) === "true";
    const savedRange = appStateGet(IMPORT_RANGE_KEY);
    this.importRangeValue = isRange(savedRange) ? savedRange : undefined;
    if (
      "setPaused" in this.adapter &&
      typeof (this.adapter as { setPaused?: unknown }).setPaused === "function"
    ) {
      (this.adapter as { setPaused(p: boolean): void }).setPaused(this.paused);
    }

    // Returning user: install the persisted import range in the daemon at
    // connect (set_range) so WhatsApp's automatic post-pairing history is filtered
    // by the chosen window before it lands. A first pair has no persisted range —
    // its pushed history buffers daemon-side until the user picks one in
    // onboarding (then `import` installs it), so we deliberately install nothing.
    if (this.importRangeValue) {
      void this.adapter.setRange?.(this.importRangeValue);
    }

    this.adapter.onChannel((c) => this.onChannel(c));
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
    };
  }

  subscribeStatus(cb: (s: StatusUpdate) => void): () => void {
    this.statusSubs.add(cb);
    return () => this.statusSubs.delete(cb);
  }

  private onStatus(s: StatusUpdate): void {
    // Track the freshest snapshot from the adapter for the /status endpoint.
    this.lastStatus = this.adapter.getStatus();

    // Persist import state on the daemon's backfill_complete (Rev 2 §R2.1). The
    // first completed backfill pins import_done=true + the range so a relaunch
    // skips the range picker.
    if (s.type === "backfill_complete") {
      this.markImportDone(s.range);
    }

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
    appStateSet(IMPORT_DONE_KEY, "true");
    appStateSet(IMPORT_RANGE_KEY, range);
  }

  /**
   * Clear the in-memory import flags after a reset (Rev 2 §R2.3). The persisted
   * app_state rows are cleared inside resetWhatsappData()'s transaction; this
   * keeps the live /status snapshot consistent (importDone:false) without a
   * relaunch.
   */
  clearImportState(): void {
    this.importDone = false;
    this.importRangeValue = undefined;
  }

  // ---- Kill-switch ----------------------------------------------------------

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    appStateSet(PAUSED_KEY, paused ? "1" : "0");
    await this.adapter.pause(paused);
    // Emit a synthetic status frame so subscribers see the change immediately.
    this.onStatus({ type: "status", state: this.getStatus().state });
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ---- Ingestion handlers ---------------------------------------------------

  private onChannel(c: Channel): void {
    upsertChannel({
      sourceId: this.adapter.sourceId,
      sourceExtId: c.source_ext_id,
      name: c.name,
      kind: c.kind,
      isBusiness: c.is_business,
    });
    this.stats.channelsUpserted += 1;
  }

  private onActor(a: Actor): void {
    upsertActor({
      sourceId: this.adapter.sourceId,
      sourceExtId: a.source_ext_id,
      displayName: a.display_name,
      handle: a.handle ?? null,
      isSelf: a.is_self,
    });
    this.stats.actorsUpserted += 1;
    if (a.is_self && a.source_ext_id) {
      appStateSet(SELF_JID_KEY, a.source_ext_id);
    }
  }

  private onEvent(e: SourceEvent): void {
    // Kill-switch: never ingest while paused.
    if (this.paused) return;

    // Resolve (lazy upsert) channel + actor ids per contract §5 mapping.
    const channelId = upsertChannel({
      sourceId: this.adapter.sourceId,
      sourceExtId: e.channel_ext_id,
    });
    const actorId = upsertActor({
      sourceId: this.adapter.sourceId,
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
          sourceId: this.adapter.sourceId,
          targetExternalId: e.edit_of_external_id,
          text: e.text ?? "",
          editedAt: e.ts,
        })
      ) {
        this.nudge(channelId);
        return;
      }
    } else if (e.revoke_of_external_id) {
      if (
        applyRevoke({
          sourceId: this.adapter.sourceId,
          targetExternalId: e.revoke_of_external_id,
          revokedAt: e.ts,
        })
      ) {
        this.nudge(channelId);
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
          sourceId: this.adapter.sourceId,
          targetExternalId: replyToExternalId,
          actorId,
        }) > 0
      ) {
        this.nudge(channelId);
      }
      return;
    }

    const res = insertEvent({
      externalId: e.external_id,
      sourceId: this.adapter.sourceId,
      sourceType: this.adapter.sourceType,
      channelId,
      actorId,
      ts: e.ts,
      kind: e.kind,
      text: e.text ?? "",
      mediaPath: e.media?.path ?? null,
      rawJson: e.raw === undefined ? null : JSON.stringify(e.raw),
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
    });

    if (res.inserted) {
      this.stats.eventsInserted += 1;
      // An attachment that just landed is read now rather than waiting its turn
      // behind the import backlog (media spec §8) — but history sync arrives
      // through this same callback, and an import IS the backlog, not something
      // entitled to jump it.
      if (e.media?.path) enqueueLiveMedia(res.id, e.is_historical === true);
      this.nudge(channelId);
    } else {
      this.stats.eventsDeduped += 1;
    }
  }

  // ---- Live-ingest nudge (Rev 2 §R2.2) -------------------------------------

  /**
   * A channel's stored messages changed — schedule a debounced frame so the UI
   * refetches. Fires for ALL persisted changes, including from_me / self-chat
   * (bug 2) and in-place edits/revokes/reaction removals, which produce no new
   * row but do change what the chat renders.
   */
  private nudge(channelId: string): void {
    if (channelId) this.pendingNudgeChannels.add(channelId);
    this.scheduleNudge();
  }

  /**
   * Schedule (or extend) the debounced ingest nudge. Coalesces a burst of
   * persisted events into a single `{ type:"ingest", ts, channels }` frame fanned
   * out on the same status stream that /api/whatsapp/stream forwards.
   */
  private scheduleNudge(): void {
    if (this.nudgeTimer) return; // a flush is already pending; it will include us
    this.nudgeTimer = setTimeout(() => this.flushNudge(), NUDGE_DEBOUNCE_MS);
    this.nudgeTimer.unref?.();
  }

  private flushNudge(): void {
    this.nudgeTimer = null;
    const channels = [...this.pendingNudgeChannels].slice(0, NUDGE_MAX_CHANNELS);
    this.pendingNudgeChannels.clear();
    this.emitFrame({
      type: "ingest",
      ts: new Date().toISOString(),
      channels,
    });
  }

  // ---- Control passthrough --------------------------------------------------

  async pair(): Promise<void> {
    await this.adapter.startPairing();
  }

  async importRange(range: Range): Promise<void> {
    await this.adapter.backfill(range);
    // Persist import state on a successful import call (Rev 2 §R2.1). The
    // daemon's later backfill_complete re-affirms it via onStatus; doing it here
    // too means a relaunch mid-backfill still remembers the chosen range.
    this.markImportDone(range);
  }

  async extend(range: Range): Promise<void> {
    await this.adapter.extend(range);
  }

  /**
   * Standalone logout (Rev 3 §R3.2): unlink the whatsmeow session AND clear the
   * persisted import flags so onboarding restarts cleanly (range picker) once
   * the daemon re-pairs. Does NOT wipe already-imported data (that is what
   * `relink` adds on top).
   */
  async logout(): Promise<void> {
    clearImportFlags();
    this.clearImportState();
    await this.adapter.logout();
  }

  /**
   * Re-link (Rev 3 §R3.2): a full clean re-sync. WhatsApp only pushes history to
   * a linked device ONCE (right after linking), so a silent reset can't recover
   * wiped history — the user must re-link. Steps:
   *   (1) wipe all ingested whatsapp data (events/channels/actors/orphan people),
   *   (2) clear the persisted import flags (+ in-memory snapshot),
   *   (3) send `logout` to the daemon — it clears its session and exits 0; the
   *       adapter restarts it fresh into pairing (need_pairing → qr on pair).
   * resetWhatsappData() already clears the import flags inside its transaction;
   * we still clear the in-memory snapshot so /status reports importDone:false
   * immediately without a relaunch.
   */
  async relink(): Promise<ReturnType<typeof resetWhatsappData>> {
    const cleared = resetWhatsappData(this.adapter.sourceId);
    this.clearImportState();
    await this.adapter.logout();
    return cleared;
  }
}

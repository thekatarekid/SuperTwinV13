// ===========================================================================
// [CODE] The stateful half of shallow-bootstrap detection + extend accounting.
//
// Two jobs, both of the same shape ("watch, wait for quiet, then report the
// truth"), which is why they share a file:
//
//  1. HISTORY DEPTH. Accumulate the daemon's per-payload `history_sync` frames,
//     re-arm a quiet timer on every historical row that lands, and when nothing
//     has landed for HISTORY_QUIET_MS judge the import (ingest/history-depth.ts)
//     and persist the verdict. The judgement is deliberately NOT tied to the
//     daemon's `backfill_complete`: that frame has been observed firing at
//     connect+0, fifteen seconds BEFORE the first history batch, so it says
//     nothing about what arrived.
//
//  2. EXTEND ACCOUNTING. "Extend history" used to be a button with no visible
//     effect. Snapshot the insert counters when the run starts, re-arm a settle
//     timer on every row it produces, and when it goes quiet report rows that
//     actually PERSISTED and how many streams they landed in.
//
// Nothing here ever triggers a re-link. A shallow verdict is information; the
// recovery action is the user's to take.
// ===========================================================================

import type { ExtendOutcome, HistoryDepth, HistorySyncPayload, Range } from "../adapters/types.js";
import {
  appStateDelete,
  appStateGet,
  appStateSet,
  sourceStateKey,
} from "../db/ingest.js";
import { readHistoryShape, type HistoryShape } from "../db/history-shape.js";
import {
  assessHistoryDepth,
  emptyTally,
  tallyPayload,
  HISTORY_QUIET_MS,
  type PayloadTally,
} from "./history-depth.js";

/**
 * How long an extend run must be quiet before its result is reported. Shorter
 * than the history window because an on-demand page comes back in seconds and a
 * result banner nobody waits a minute for is a result banner nobody sees.
 */
export const EXTEND_SETTLE_MS = 15_000;

/** `source.<id>.history_depth` — the persisted verdict. */
export function historyDepthKey(sourceId: string): string {
  return sourceStateKey(sourceId, "history_depth");
}

/** `source.<id>.last_extend` — the persisted extend outcome. */
export function lastExtendKey(sourceId: string): string {
  return sourceStateKey(sourceId, "last_extend");
}

export interface HistoryHealthOptions {
  sourceId: string;
  /** Fan a status frame out to subscribers. */
  emit(frame: { type: "history_depth"; depth: HistoryDepth } | { type: "extend_result"; outcome: ExtendOutcome }): void;
  /** Injected in tests so a quiet window is microseconds, not a minute. */
  quietMs?: number;
  extendSettleMs?: number;
  /** Injected in tests so no DB is required. */
  readShape?: (sourceId: string) => HistoryShape;
  now?: () => Date;
  log?: (line: string) => void;
}

export class HistoryHealth {
  private readonly sourceId: string;
  private readonly emit: HistoryHealthOptions["emit"];
  private readonly quietMs: number;
  private readonly extendSettleMs: number;
  private readonly readShape: (sourceId: string) => HistoryShape;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  private tally: PayloadTally = emptyTally();
  private quietTimer: NodeJS.Timeout | null = null;
  private depth: HistoryDepth | null = null;

  private extend: ExtendOutcome | null = null;
  private extendTimer: NodeJS.Timeout | null = null;
  /** Streams that gained a row since the running extend started. */
  private extendStreams = new Set<string>();
  private extendInserts = 0;

  constructor(opts: HistoryHealthOptions) {
    this.sourceId = opts.sourceId;
    this.emit = opts.emit;
    this.quietMs = opts.quietMs ?? HISTORY_QUIET_MS;
    this.extendSettleMs = opts.extendSettleMs ?? EXTEND_SETTLE_MS;
    this.readShape = opts.readShape ?? readHistoryShape;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
  }

  // ---- Restore / snapshot --------------------------------------------------

  /** Re-read the persisted verdict + extend outcome. Call once from start(). */
  restore(): void {
    this.depth = readJson<HistoryDepth>(historyDepthKey(this.sourceId));
    const extend = readJson<ExtendOutcome>(lastExtendKey(this.sourceId));
    // A run that was still going when the worker died did not finish, and
    // reporting it as running for ever would be a spinner that never stops.
    this.extend = extend ? { ...extend, running: false } : null;
  }

  getDepth(): HistoryDepth | null {
    return this.depth;
  }

  getExtend(): ExtendOutcome | null {
    return this.extend;
  }

  /** Forget everything (a reset/relink wiped the data the verdict described). */
  clear(): void {
    this.cancelTimers();
    this.tally = emptyTally();
    this.depth = null;
    this.extend = null;
    this.extendStreams.clear();
    this.extendInserts = 0;
    appStateDelete(historyDepthKey(this.sourceId));
    appStateDelete(lastExtendKey(this.sourceId));
  }

  // ---- History depth -------------------------------------------------------

  /** One daemon `history_sync` payload landed. */
  notePayload(p: HistorySyncPayload): void {
    tallyPayload(this.tally, p);
    this.armQuiet();
  }

  /**
   * A historical row persisted, or the daemon said the push is done. Either way
   * the import is still moving, so push the judgement out.
   */
  noteHistoryActivity(): void {
    this.armQuiet();
  }

  private armQuiet(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.judge();
    }, this.quietMs);
    this.quietTimer.unref?.();
  }

  /**
   * Judge the settled import. Public so a test can force the evaluation without
   * waiting out a real quiet window, and so a caller can re-judge on demand.
   */
  judge(): HistoryDepth {
    const depth = assessHistoryDepth({
      shape: this.readShape(this.sourceId),
      tally: this.tally,
      now: this.now(),
    });
    this.depth = depth;
    appStateSet(historyDepthKey(this.sourceId), JSON.stringify(depth));
    this.log(
      `[whatsapp] history depth: ${depth.verdict} (${depth.reason}) ` +
        `chats=${depth.chats} messages=${depth.messages} ` +
        `single=${depth.singleMessageChats} payloads=${depth.payloads} ` +
        `bulk=${depth.bulkPayloads} types=${depth.syncTypes.join(",") || "none"}`,
    );
    this.emit({ type: "history_depth", depth });
    return depth;
  }

  // ---- Extend accounting ---------------------------------------------------

  /** An "Extend history" run was just requested. */
  startExtend(range: Range): void {
    if (this.extendTimer) clearTimeout(this.extendTimer);
    this.extendStreams.clear();
    this.extendInserts = 0;
    this.extend = {
      range,
      startedAt: this.now().toISOString(),
      running: true,
      chatsPaginated: 0,
      streamsWithNewMessages: 0,
      messagesRecovered: 0,
      mayHaveMore: false,
    };
    this.persistExtend();
    this.emit({ type: "extend_result", outcome: this.extend });
    this.armExtendSettle();
  }

  /**
   * A row persisted while an extend was running. Only NEW rows reach here — a
   * page of messages already held dedupes away and must not be counted as
   * recovered.
   */
  noteExtendInsert(streamId: string): void {
    if (!this.extend?.running) return;
    this.extendInserts += 1;
    if (streamId) this.extendStreams.add(streamId);
    this.armExtendSettle();
  }

  /** The daemon reported how many chats its run paginated. */
  noteExtendChats(chats: number): void {
    if (!this.extend?.running) return;
    this.extend = { ...this.extend, chatsPaginated: chats };
    this.armExtendSettle();
  }

  /** Is an extend run in flight? Used to route inserts to the right counter. */
  isExtending(): boolean {
    return this.extend?.running === true;
  }

  private armExtendSettle(): void {
    if (this.extendTimer) clearTimeout(this.extendTimer);
    this.extendTimer = setTimeout(() => {
      this.extendTimer = null;
      this.finishExtend();
    }, this.extendSettleMs);
    this.extendTimer.unref?.();
  }

  /** Close the running extend and report what it actually recovered. */
  finishExtend(): ExtendOutcome | null {
    const running = this.extend;
    if (!running?.running) return this.extend;
    const outcome: ExtendOutcome = {
      ...running,
      running: false,
      finishedAt: this.now().toISOString(),
      streamsWithNewMessages: this.extendStreams.size,
      messagesRecovered: this.extendInserts,
      // WhatsApp caps an on-demand page at 50 messages per request, so anything
      // that came back leaves open the possibility of more behind it. Only an
      // empty run is evidence that there is nothing left to fetch.
      mayHaveMore: this.extendInserts > 0,
    };
    this.extend = outcome;
    this.extendStreams.clear();
    this.extendInserts = 0;
    this.persistExtend();
    this.log(
      `[whatsapp] extend ${outcome.range}: recovered ${outcome.messagesRecovered} ` +
        `messages across ${outcome.streamsWithNewMessages} chats ` +
        `(daemon paginated ${outcome.chatsPaginated})`,
    );
    this.emit({ type: "extend_result", outcome });
    return outcome;
  }

  private persistExtend(): void {
    if (!this.extend) return;
    appStateSet(lastExtendKey(this.sourceId), JSON.stringify(this.extend));
  }

  // ---- Teardown ------------------------------------------------------------

  private cancelTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.extendTimer) clearTimeout(this.extendTimer);
    this.quietTimer = null;
    this.extendTimer = null;
  }

  dispose(): void {
    this.cancelTimers();
  }
}

/** Read a JSON blob out of app_state, tolerating anything that is not one. */
function readJson<T>(key: string): T | null {
  const raw = appStateGet(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

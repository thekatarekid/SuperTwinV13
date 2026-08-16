// ===========================================================================
// Shallow-bootstrap detection + extend accounting, driven through the REAL
// Ingestion against a real (temp) DB — so the quiet windows, the DB shape read,
// the persistence and the status fan-out are all exercised together rather than
// mocked past.
//
// The two shapes written here are the measured ones: 89 chats / 305 messages /
// 61 single-message chats (the sync WhatsApp declined to complete) and the
// ~36-per-chat shape of the two healthy installs.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceAdapter } from "../adapters/source-adapter.js";
import type {
  Actor,
  AdapterStatus,
  HistorySyncPayload,
  Range,
  SourceEvent,
  StatusUpdate,
  Stream,
} from "../adapters/types.js";
import { closeDb } from "../db/connection.js";
import { appStateDelete } from "../db/ingest.js";
import { historyDepthKey } from "./history-health.js";
import { Ingestion } from "./index.js";

const QUIET_MS = 20;
const SETTLE_MS = 20;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-history-health-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Records every control call so a test can prove what was NOT invoked. */
class StubAdapter implements SourceAdapter {
  readonly sourceId = "whatsapp";
  readonly sourceType = "whatsapp";
  readonly calls: string[] = [];
  emitEvent: (e: SourceEvent) => void = () => {};
  emitActor: (a: Actor) => void = () => {};
  emitStream: (s: Stream) => void = () => {};
  emitStatus: (s: StatusUpdate) => void = () => {};

  async connect(): Promise<void> {}
  async startPairing(): Promise<void> {}
  async backfill(range: Range): Promise<void> {
    this.calls.push(`backfill:${range}`);
  }
  async extend(range: Range): Promise<void> {
    this.calls.push(`extend:${range}`);
  }
  async pause(): Promise<void> {}
  async logout(): Promise<void> {
    this.calls.push("logout");
  }
  async disconnect(): Promise<void> {}

  onEvent(cb: (e: SourceEvent) => void): void {
    this.emitEvent = cb;
  }
  onStream(cb: (s: Stream) => void): void {
    this.emitStream = cb;
  }
  onActor(cb: (a: Actor) => void): void {
    this.emitActor = cb;
  }
  onStatus(cb: (s: StatusUpdate) => void): void {
    this.emitStatus = cb;
  }
  getStatus(): AdapterStatus {
    return { state: "online", paired: true, paused: false };
  }
}

interface Harness {
  adapter: StubAdapter;
  ingestion: Ingestion;
  frames: StatusUpdate[];
}

function start(): Harness {
  const adapter = new StubAdapter();
  const ingestion = new Ingestion(adapter, {
    historyQuietMs: QUIET_MS,
    extendSettleMs: SETTLE_MS,
  });
  const frames: StatusUpdate[] = [];
  ingestion.subscribeStatus((f) => frames.push(f));
  ingestion.start();
  return { adapter, ingestion, frames };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough for a quiet window to close with room for a slow CI box. */
const settle = () => sleep(QUIET_MS + SETTLE_MS + 120);

function historical(streamIdx: number, msgIdx: number): SourceEvent {
  return {
    external_id: `chat${streamIdx}@x/M${msgIdx}`,
    stream_ext_id: `chat${streamIdx}@x`,
    actor_ext_id: `chat${streamIdx}@x`,
    ts: new Date(Date.UTC(2026, 6, 1, 0, msgIdx % 60)).toISOString(),
    kind: "message",
    text: `msg ${msgIdx}`,
    from_me: false,
    is_historical: true,
  };
}

/**
 * Write `chats` streams; `single` of them get exactly one message and the rest
 * split the remainder evenly. Reproduces a measured install's shape.
 */
function writeShape(
  h: Harness,
  { chats, messages, single }: { chats: number; messages: number; single: number },
): void {
  const rest = chats - single;
  const perRest = Math.round((messages - single) / rest);
  for (let c = 0; c < chats; c += 1) {
    const n = c < single ? 1 : perRest;
    for (let m = 0; m < n; m += 1) h.adapter.emitEvent(historical(c, m));
  }
}

function payload(over: Partial<HistorySyncPayload> = {}): HistorySyncPayload {
  return {
    syncType: "FULL",
    chats: 10,
    chatsInRange: 10,
    messagesSeen: 3000,
    messagesInRange: 3000,
    messagesEmitted: 3000,
    messagesFiltered: 0,
    onDemand: false,
    ...over,
  };
}

function depthFrames(frames: StatusUpdate[]) {
  return frames.filter((f) => f.type === "history_depth");
}

function extendFrames(frames: StatusUpdate[]) {
  return frames.filter((f) => f.type === "extend_result");
}

describe("shallow-bootstrap detection", () => {
  it("fires on the observed shape: bootstrap only, no chunks after it", async () => {
    const h = start();
    h.adapter.emitStatus({
      type: "history_sync",
      payload: payload({
        syncType: "INITIAL_BOOTSTRAP",
        chats: 89,
        messagesSeen: 486,
        messagesInRange: 292,
        messagesEmitted: 292,
        messagesFiltered: 194,
      }),
    });
    writeShape(h, { chats: 89, messages: 305, single: 61 });
    h.adapter.emitStatus({
      type: "backfill_complete",
      range: "30d",
      chats: 89,
      messages: 305,
    });
    await settle();

    const [frame] = depthFrames(h.frames);
    expect(frame).toBeDefined();
    if (frame?.type !== "history_depth") throw new Error("wrong frame");
    expect(frame.depth.verdict).toBe("shallow");
    expect(frame.depth.reason).toBe("bootstrap_only");
    expect(frame.depth.chats).toBe(89);
    expect(frame.depth.singleMessageChats).toBe(61);
    // The daemon's per-payload counters reached the status snapshot, so the
    // Inbox can state what arrived and not merely that something is missing.
    expect(frame.depth.messagesSeen).toBe(486);
    expect(frame.depth.messagesFiltered).toBe(194);
    expect(h.ingestion.getStatus().historyDepth?.verdict).toBe("shallow");
  });

  it("does NOT fire on a healthy import (small batch, then bulk chunks)", async () => {
    const h = start();
    h.adapter.emitStatus({
      type: "history_sync",
      payload: payload({ syncType: "INITIAL_BOOTSTRAP", messagesSeen: 486 }),
    });
    for (let i = 0; i < 25; i += 1) {
      h.adapter.emitStatus({ type: "history_sync", payload: payload() });
    }
    // V10's measured shape: 98 chats, 3632 messages, 35 holding exactly one.
    writeShape(h, { chats: 98, messages: 3632, single: 35 });
    h.adapter.emitStatus({
      type: "backfill_complete",
      range: "all",
      chats: 98,
      messages: 3632,
    });
    await settle();

    const [frame] = depthFrames(h.frames);
    if (frame?.type !== "history_depth") throw new Error("no verdict");
    expect(frame.depth.verdict).toBe("deep");
    expect(frame.depth.bulkPayloads).toBe(25);
  });

  it("does NOT fire on a healthy shape when the daemon sends no payload frames", async () => {
    // The fallback path — this is what ships whether or not the Go daemon ever
    // learns to emit `history_sync`.
    const h = start();
    writeShape(h, { chats: 100, messages: 3575, single: 37 });
    await settle();
    const [frame] = depthFrames(h.frames);
    if (frame?.type !== "history_depth") throw new Error("no verdict");
    expect(frame.depth.verdict).toBe("deep");
    expect(frame.depth.syncTypesKnown).toBe(false);
  });

  it("does not judge while history is still landing — a late wave re-arms it", async () => {
    const h = start();
    writeShape(h, { chats: 89, messages: 305, single: 61 });
    // Keep the import "alive" across more than a full quiet window, the way a
    // real sync's chunks do. The verdict must wait for actual silence.
    for (let i = 0; i < 4; i += 1) {
      await sleep(QUIET_MS / 2);
      h.adapter.emitEvent(historical(200 + i, 0));
      expect(depthFrames(h.frames)).toHaveLength(0);
    }
    await settle();
    expect(depthFrames(h.frames)).toHaveLength(1);
  });

  it("never triggers a re-link or a re-import of its own accord", async () => {
    const h = start();
    writeShape(h, { chats: 89, messages: 305, single: 61 });
    await settle();
    expect(depthFrames(h.frames)).toHaveLength(1);
    // Detection is information, not an action. WhatsApp grants one full push
    // per link, so spending one automatically would be the worst possible bug
    // to introduce while fixing this one.
    expect(h.adapter.calls).toEqual([]);
  });

  it("remembers the verdict across a worker restart", async () => {
    const h = start();
    writeShape(h, { chats: 89, messages: 305, single: 61 });
    await settle();
    expect(h.ingestion.getStatus().historyDepth?.verdict).toBe("shallow");

    // A second Ingestion over the same DB — the persisted verdict describes
    // rows that are still there, so it must survive.
    const restarted = start();
    expect(restarted.ingestion.getStatus().historyDepth?.verdict).toBe("shallow");
    expect(restarted.ingestion.getStatus().historyDepth?.singleMessageChats).toBe(61);
  });

  it("judges an install whose import finished before this detection existed", async () => {
    // The rows are already on disk and no more history will ever arrive, so
    // nothing would arm the quiet window. Without a judgement at boot such an
    // install would sit for ever in the exact state this work exists to explain.
    const h = start();
    writeShape(h, { chats: 89, messages: 305, single: 61 });
    h.adapter.emitStatus({
      type: "backfill_complete",
      range: "30d",
      chats: 89,
      messages: 305,
    });
    await settle();
    // Drop the persisted verdict, keeping import_done — an upgrade from a build
    // that wrote one flag and not the other.
    appStateDelete(historyDepthKey("whatsapp"));

    const upgraded = start();
    const depth = upgraded.ingestion.getStatus().historyDepth;
    expect(depth?.verdict).toBe("shallow");
    // Shape-only: the daemon frames belonged to a process that is gone.
    expect(depth?.reason).toBe("sparse_chats");
    expect(depth?.syncTypesKnown).toBe(false);
  });

  it("forgets the verdict when the data it described is wiped", async () => {
    const h = start();
    writeShape(h, { chats: 89, messages: 305, single: 61 });
    await settle();
    h.ingestion.clearImportState();
    expect(h.ingestion.getStatus().historyDepth).toBeUndefined();
    expect(start().ingestion.getStatus().historyDepth).toBeUndefined();
  });
});

describe("extend accounting", () => {
  it("reports how many messages persisted and how many chats they landed in", async () => {
    const h = start();
    await h.ingestion.extend("90d");
    expect(h.adapter.calls).toEqual(["extend:90d"]);

    // A running frame goes out immediately so the UI is not silent while the
    // request is in flight.
    const started = extendFrames(h.frames)[0];
    if (started?.type !== "extend_result") throw new Error("no start frame");
    expect(started.outcome.running).toBe(true);

    h.adapter.emitStatus({
      type: "backfill_complete",
      range: "90d",
      chats: 7,
      messages: 40,
    });
    for (let m = 0; m < 12; m += 1) h.adapter.emitEvent(historical(1, m));
    for (let m = 0; m < 5; m += 1) h.adapter.emitEvent(historical(2, m));
    await settle();

    const frames = extendFrames(h.frames);
    const last = frames[frames.length - 1];
    if (last?.type !== "extend_result") throw new Error("no result frame");
    expect(last.outcome.running).toBe(false);
    expect(last.outcome.messagesRecovered).toBe(17);
    expect(last.outcome.streamsWithNewMessages).toBe(2);
    expect(last.outcome.chatsPaginated).toBe(7);
    // On-demand pages cap at 50 messages per request, so one click is never
    // exhaustive and the UI must not pretend otherwise.
    expect(last.outcome.mayHaveMore).toBe(true);
    expect(h.ingestion.getStatus().lastExtend?.messagesRecovered).toBe(17);
  });

  it("counts only rows that actually persisted, not pages already held", async () => {
    const h = start();
    for (let m = 0; m < 6; m += 1) h.adapter.emitEvent(historical(1, m));
    await settle();

    await h.ingestion.extend("all");
    // WhatsApp re-sends the same page; every row dedupes away.
    for (let m = 0; m < 6; m += 1) h.adapter.emitEvent(historical(1, m));
    h.adapter.emitStatus({
      type: "backfill_complete",
      range: "all",
      chats: 1,
      messages: 6,
    });
    await settle();

    const frames = extendFrames(h.frames);
    const last = frames[frames.length - 1];
    if (last?.type !== "extend_result") throw new Error("no result frame");
    expect(last.outcome.messagesRecovered).toBe(0);
    expect(last.outcome.streamsWithNewMessages).toBe(0);
    // Nothing came back, so there is nothing behind the page cap either.
    expect(last.outcome.mayHaveMore).toBe(false);
    expect(last.outcome.chatsPaginated).toBe(1);
  });

  it("does not attribute ordinary live traffic to an extend that already ended", async () => {
    const h = start();
    await h.ingestion.extend("30d");
    h.adapter.emitEvent(historical(1, 0));
    await settle();
    const afterRun = h.ingestion.getStatus().lastExtend?.messagesRecovered;
    expect(afterRun).toBe(1);

    h.adapter.emitEvent({ ...historical(1, 99), is_historical: false });
    await settle();
    expect(h.ingestion.getStatus().lastExtend?.messagesRecovered).toBe(1);
  });

  it("does not report a run that the worker died in the middle of as running", async () => {
    const h = start();
    await h.ingestion.extend("30d");
    expect(h.ingestion.getStatus().lastExtend?.running).toBe(true);
    // Fresh process over the same DB: a spinner that never stops is worse than
    // an inconclusive result.
    expect(start().ingestion.getStatus().lastExtend?.running).toBe(false);
  });
});

// ===========================================================================
// Shallow-bootstrap detection (vitest): the pure verdict.
//
// The three shapes below are MEASURED, not invented — read back on 2026-08-17
// from the three installs' SQLite files with:
//
//   SELECT COUNT(*), SUM(n), SUM(n=1)
//     FROM (SELECT COUNT(*) n FROM events WHERE source_id='whatsapp' GROUP BY <stream>)
//
// so a threshold change that would have missed the real failure, or fired on
// either of the two real healthy imports, fails here.
// ===========================================================================

import { describe, expect, it } from "vitest";

import type { HistorySyncPayload } from "../adapters/types.js";
import type { HistoryShape } from "../db/history-shape.js";
import {
  assessHistoryDepth,
  emptyTally,
  isSparseShape,
  tallyPayload,
  type PayloadTally,
} from "./history-depth.js";

/** V11, 2026-08-17: WhatsApp sent the bootstrap batch and then nothing. */
const DECLINED: HistoryShape = { chats: 89, messages: 305, singleMessageChats: 61 };

/** V10, 2026-08-13: bootstrap + ~25 FULL chunks over ~6 minutes. */
const HEALTHY_V10: HistoryShape = { chats: 98, messages: 3632, singleMessageChats: 35 };

/** V9G, 2026-08-09: same healthy shape on a different machine. */
const HEALTHY_V9G: HistoryShape = { chats: 100, messages: 3575, singleMessageChats: 37 };

function payload(over: Partial<HistorySyncPayload> = {}): HistorySyncPayload {
  return {
    syncType: "FULL",
    chats: 12,
    chatsInRange: 12,
    messagesSeen: 3000,
    messagesInRange: 2800,
    messagesEmitted: 2800,
    messagesFiltered: 200,
    onDemand: false,
    ...over,
  };
}

/** The daemon's frames for a healthy sync: one bootstrap, then bulk chunks. */
function healthyTally(bulkChunks = 25): PayloadTally {
  const tally = emptyTally();
  tallyPayload(
    tally,
    payload({
      syncType: "INITIAL_BOOTSTRAP",
      chats: 98,
      messagesSeen: 486,
      messagesInRange: 486,
      messagesEmitted: 486,
      messagesFiltered: 0,
    }),
  );
  for (let i = 0; i < bulkChunks; i += 1) tallyPayload(tally, payload());
  return tally;
}

/** The daemon's frames for the observed failure: the bootstrap, alone. */
function bootstrapOnlyTally(): PayloadTally {
  const tally = emptyTally();
  tallyPayload(
    tally,
    payload({
      syncType: "INITIAL_BOOTSTRAP",
      chats: 89,
      chatsInRange: 89,
      messagesSeen: 486,
      messagesInRange: 292,
      messagesEmitted: 292,
      messagesFiltered: 194,
    }),
  );
  return tally;
}

describe("isSparseShape — the measured 10x gap", () => {
  it("calls the declined re-upload sparse (3.43 msgs/chat, 68.5% single)", () => {
    expect(isSparseShape(DECLINED)).toBe(true);
  });

  it("does not call either real healthy import sparse (~36 msgs/chat)", () => {
    expect(isSparseShape(HEALTHY_V10)).toBe(false);
    expect(isSparseShape(HEALTHY_V9G)).toBe(false);
  });

  it("refuses to judge an account too small to draw a conclusion from", () => {
    // Four chats holding one message each is a new WhatsApp account, not a
    // failed sync, and accusing it of one would be a lie with a scary banner.
    expect(isSparseShape({ chats: 4, messages: 4, singleMessageChats: 4 })).toBe(
      false,
    );
  });

  it("is not fooled by one enormous chat carrying the average", () => {
    // 90 chats, 89 of them holding a single message, one holding 800. The mean
    // is 9.9 — under the threshold — and the single-message fraction is what
    // makes this still read as sparse.
    expect(
      isSparseShape({ chats: 90, messages: 889, singleMessageChats: 89 }),
    ).toBe(true);
  });
});

describe("assessHistoryDepth", () => {
  it("fires SHALLOW on the observed shape when only a bootstrap payload arrived", () => {
    const depth = assessHistoryDepth({
      shape: DECLINED,
      tally: bootstrapOnlyTally(),
    });
    expect(depth.verdict).toBe("shallow");
    expect(depth.reason).toBe("bootstrap_only");
    expect(depth.bulkPayloads).toBe(0);
    expect(depth.syncTypes).toEqual(["INITIAL_BOOTSTRAP"]);
    // The counters the daemon reported are carried through so the Inbox can
    // say what actually arrived rather than only that something was wrong.
    expect(depth.messagesSeen).toBe(486);
    expect(depth.messagesEmitted).toBe(292);
    expect(depth.messagesFiltered).toBe(194);
  });

  it("fires SHALLOW on the observed shape with NO daemon frames at all", () => {
    // The fallback path: a daemon that never emits `history_sync` still gets a
    // verdict, from the shape alone. This is what ships even if the Go track
    // lands nothing.
    const depth = assessHistoryDepth({ shape: DECLINED, tally: emptyTally() });
    expect(depth.verdict).toBe("shallow");
    expect(depth.reason).toBe("sparse_chats");
    expect(depth.syncTypesKnown).toBe(false);
  });

  it("does NOT fire on either healthy import (bootstrap then 25 bulk chunks)", () => {
    for (const shape of [HEALTHY_V10, HEALTHY_V9G]) {
      const depth = assessHistoryDepth({ shape, tally: healthyTally() });
      expect(depth.verdict).toBe("deep");
      expect(depth.reason).toBe("bulk_received");
      expect(depth.bulkPayloads).toBe(25);
    }
  });

  it("does NOT fire on a healthy shape reported by a daemon with no frames", () => {
    const depth = assessHistoryDepth({
      shape: HEALTHY_V10,
      tally: emptyTally(),
    });
    expect(depth.verdict).toBe("deep");
    expect(depth.reason).toBe("healthy_shape");
  });

  it("stays UNKNOWN when the shape is sparse but bulk payloads did arrive", () => {
    // Then the loss is somewhere after WhatsApp and "WhatsApp declined" would
    // be a confident lie — exactly the kind this investigation already told.
    const depth = assessHistoryDepth({
      shape: DECLINED,
      tally: healthyTally(3),
    });
    expect(depth.verdict).toBe("unknown");
    expect(depth.reason).toBe("sparse_after_bulk");
  });

  it("stays UNKNOWN when nothing landed at all (a different problem)", () => {
    const depth = assessHistoryDepth({
      shape: { chats: 0, messages: 0, singleMessageChats: 0 },
      tally: emptyTally(),
    });
    expect(depth.verdict).toBe("unknown");
    expect(depth.reason).toBe("no_history");
  });

  it("treats a returned ON_DEMAND page as bulk history arriving", () => {
    // "Extend history" answers count: a page that came back is history that
    // arrived, so a user mid-recovery is not told the sync failed again.
    const tally = emptyTally();
    tallyPayload(tally, payload({ syncType: "ON_DEMAND", onDemand: true }));
    expect(assessHistoryDepth({ shape: DECLINED, tally }).reason).toBe(
      "sparse_after_bulk",
    );
  });

  it("keeps an unrecognised sync type out of the bulk count", () => {
    // Forward-compat: a type whatsmeow adds later must not silently register as
    // "WhatsApp sent the archive" and suppress a real shallow verdict.
    const tally = emptyTally();
    tallyPayload(tally, payload({ syncType: "SOME_FUTURE_TYPE" }));
    const depth = assessHistoryDepth({ shape: DECLINED, tally });
    expect(depth.bulkPayloads).toBe(0);
    expect(depth.verdict).toBe("shallow");
    expect(depth.syncTypes).toEqual(["SOME_FUTURE_TYPE"]);
  });
});

describe("tallyPayload", () => {
  it("accumulates counters and keeps sync types distinct and ordered", () => {
    const tally = healthyTally(2);
    expect(tally.count).toBe(3);
    expect(tally.bulk).toBe(2);
    expect(tally.syncTypes).toEqual(["INITIAL_BOOTSTRAP", "FULL"]);
    expect(tally.messagesSeen).toBe(486 + 3000 * 2);
    expect(tally.messagesFiltered).toBe(0 + 200 * 2);
  });
});

// ===========================================================================
// The WhatsApp connect flow end to end on the worker side (V6 P1 S1.5, Build
// §4.2): pair → buffer → counts → windows → confirm, through the REAL adapter
// framing (a scripted FakeChild stands in for the Go daemon) and the REAL
// Ingestion writer with the consent gate ENFORCED (db/consent-gate.ts). Zero
// model calls.
//
//   * no live ingest between pairing and confirm — with no consent row the
//     funnel drops every frame the daemon emits (S1.2), and the daemon holds
//     them anyway (Go: TestLiveHeldUntilRangeConfirmed);
//   * counts — countRange() writes `count_range`, resolves on `range_counts`,
//     times out cleanly on a daemon that never answers;
//   * confirm — decision + consent, then `import <index>` on stdin; from then
//     on in-window rows are admitted, rows before the INDEX floor are dropped,
//     rows between the two floors land as origin='archive' (T4-2).
//
// SRC-09 (reply structure reaches the model — the deterministic half): reply,
// reaction, forward, mention and audience ride on the envelope and are stored
// so the referent of a reply 20 messages back is resolvable by id, with its
// quoted text. The judge half ("the episode resolves the referent") needs the
// packer to render the structure it now has — T6-17, Stage 3.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { setConsentGateMode, type ConsentGateMode } from "../../db/consent-gate.js";
import { appStateGet, eventId, importRangeKey } from "../../db/ingest.js";
import { getConsent } from "../../db/v6core.js";
import { Ingestion } from "../../ingest/index.js";
import type { RangeCounts, StatusUpdate } from "../types.js";
import { WhatsAppAdapter, type ChildLike, type SpawnFn } from "./adapter.js";
import { confirmWhatsAppWindows } from "./connect.js";

// ---- Fake daemon --------------------------------------------------------------

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly writes: string[] = [];
  pid = 4242;
  /** When set, a `count_range` command is answered with this frame. */
  countAnswer: Record<string, unknown> | null = null;
  stdin = {
    write: (chunk: string) => {
      this.writes.push(chunk);
      if (this.countAnswer && chunk.includes('"cmd":"count_range"')) {
        const answer = this.countAnswer;
        setImmediate(() => this.line({ t: "range_counts", ...answer }));
      }
    },
    end: () => {},
  };
  kill(): boolean {
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }
  line(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
  commands(): Array<Record<string, unknown>> {
    return this.writes.map((w) => JSON.parse(w) as Record<string, unknown>);
  }
}

function makeAdapter(tmpDir: string): { adapter: WhatsAppAdapter; child: FakeChild } {
  const child = new FakeChild();
  const spawn: SpawnFn = () => child;
  const adapter = new WhatsAppAdapter({ spawn, mock: true, autoRestart: false, home: tmpDir });
  return { adapter, child };
}

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const CHAT = "120363000000000001@g.us";
const SELF = "15550000001@s.whatsapp.net";
const ROHAN = "15550000002@s.whatsapp.net";
const TANVI = "15550000003@s.whatsapp.net";
const KARAN = "15550000004@s.whatsapp.net";

function msg(
  id: string,
  from: string,
  text: string,
  msAgo: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    t: "event",
    event: {
      external_id: `${CHAT}/${id}`,
      channel_ext_id: CHAT,
      actor_ext_id: from,
      ts: iso(msAgo),
      kind: "message",
      text,
      from_me: from === SELF,
      raw: { id },
      ...extra,
    },
  };
}

function pairedDaemon(child: FakeChild): void {
  child.line({ t: "ready" });
  child.line({ t: "status", state: "online", jid: SELF, push_name: "Me" });
  child.line({ t: "paired", jid: SELF, push_name: "Me" });
  child.line({ t: "actor", actor: { source_ext_id: SELF, display_name: "Me", is_self: true } });
  child.line({ t: "channel", channel: { source_ext_id: CHAT, name: "Goa gang", kind: "group" } });
  for (const [jid, name] of [[ROHAN, "Rohan"], [TANVI, "Tanvi"], [KARAN, "Karan"]]) {
    child.line({ t: "actor", actor: { source_ext_id: jid, display_name: name, is_self: false } });
  }
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function eventRows(): Array<{
  external_id: string;
  kind: string;
  origin: string;
  reply_to_external_id: string | null;
  reply_to_text: string | null;
  is_forwarded: number;
  roles_json: string;
  payload_json: string;
  consent_id: string | null;
  dispatched_at: string | null;
}> {
  return getDb()
    .prepare(
      `SELECT external_id, kind, origin, reply_to_external_id, reply_to_text, is_forwarded,
              roles_json, payload_json, consent_id, dispatched_at
         FROM events WHERE source_id = 'whatsapp' ORDER BY ts`,
    )
    .all() as never;
}

let tmpDir: string;
let prevMode: ConsentGateMode;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wa-connect-flow-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
  prevMode = setConsentGateMode("enforce");
});

afterEach(() => {
  setConsentGateMode(prevMode);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("S1.5 connect flow: pair → buffer → counts → windows → confirm", () => {
  it("nothing is ingested between pairing and confirm; the confirm installs the window and the funnel opens", async () => {
    const { adapter, child } = makeAdapter(tmpDir);
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    const frames: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => frames.push(s));
    await adapter.connect();
    pairedDaemon(child);
    await ingestion.pair();
    expect(child.commands().some((c) => c.cmd === "start_pairing")).toBe(true);
    // A first pair installs NO range: the daemon buffers, the user has not chosen.
    expect(child.commands().some((c) => c.cmd === "set_range" || c.cmd === "import")).toBe(false);

    // A live frame slips out before confirm (an older daemon, say): the funnel
    // has no consent row for 'whatsapp' and drops it. Not stored-and-hidden.
    child.line(msg("PRE1", ROHAN, "villa A or B?", 60_000));
    await settle();
    expect(eventRows()).toHaveLength(0);
    expect(getConsent("whatsapp")).toBeNull();

    // Counts: measured by the daemon, answered on the wire.
    child.countAnswer = {
      counts: {
        "24h": { chats: 1, messages: 2 }, "3d": { chats: 1, messages: 2 }, "7d": { chats: 1, messages: 3 },
        "30d": { chats: 1, messages: 4 }, "90d": { chats: 1, messages: 5 }, "180d": { chats: 1, messages: 5 },
        "1y": { chats: 1, messages: 5 }, "2y": { chats: 1, messages: 5 }, "3y": { chats: 1, messages: 5 },
        "4y": { chats: 1, messages: 5 }, "5y": { chats: 1, messages: 5 }, all: { chats: 1, messages: 5 },
      },
      chats: 1, messages: 5, oldest_ts: iso(80 * DAY), newest_ts: iso(60_000),
      buffered_batches: 1, batches: 1, sync_types: ["INITIAL_BOOTSTRAP"], range_installed: false, pending_live: 1,
    };
    const counts: RangeCounts = await ingestion.countRange();
    expect(child.commands().filter((c) => c.cmd === "count_range")).toHaveLength(1);
    expect(counts.counts["7d"]).toEqual({ chats: 1, messages: 3 });
    expect(counts.messages).toBe(5);
    expect(counts.syncTypes).toEqual(["INITIAL_BOOTSTRAP"]);
    expect(counts.rangeInstalled).toBe(false);
    expect(counts.pendingLive).toBe(1);
    expect(counts.oldestTs).toBe(iso(80 * DAY));
    // …and on the status stream for SSE subscribers.
    expect(frames.some((f) => f.type === "range_counts" && f.counts.messages === 5)).toBe(true);
    // Counting installed nothing.
    expect(child.commands().some((c) => c.cmd === "set_range" || c.cmd === "import")).toBe(false);

    // Confirm: Index 30 d, Understand 7 d. Decision + consent first, then import.
    const confirmed = confirmWhatsAppWindows({
      index: "30d",
      understand: "7d",
      cardText: "Index last 30 days: 4 messages in 1 chat.\nUnderstand last 7 days: 3 messages.",
      counts,
      nowMs: NOW,
    });
    await ingestion.importRange("30d");
    const imports = child.commands().filter((c) => c.cmd === "import");
    expect(imports).toEqual([{ cmd: "import", range: "30d" }]);
    expect(appStateGet(importRangeKey("whatsapp"))).toBe("30d");
    expect(getConsent("whatsapp")!.decisionId).toBe(confirmed.decisionId);

    // The daemon drains its buffer filtered by the window. Rows: in Understand
    // (2 d) → dispatchable; in Index but before Understand (20 d) → archive;
    // before Index (40 d) → dropped at the funnel. The held live message lands.
    child.line(msg("H1", ROHAN, "two days ago", 2 * DAY, { is_historical: true }));
    child.line(msg("H2", TANVI, "twenty days ago", 20 * DAY, { is_historical: true }));
    child.line(msg("H3", KARAN, "forty days ago", 40 * DAY, { is_historical: true }));
    child.line(msg("PRE1", ROHAN, "villa A or B?", 60_000));
    ingestion.flushBackfill();
    await settle();
    const rows = eventRows();
    const byId = new Map(rows.map((r) => [r.external_id, r]));
    expect([...byId.keys()].sort()).toEqual([`${CHAT}/H1`, `${CHAT}/H2`, `${CHAT}/PRE1`].sort());
    expect(byId.get(`${CHAT}/H1`)!.origin).toBe("backfill");
    expect(byId.get(`${CHAT}/H1`)!.dispatched_at).toBeNull();
    expect(byId.get(`${CHAT}/H2`)!.origin).toBe("archive");
    expect(byId.get(`${CHAT}/H2`)!.dispatched_at).not.toBeNull();
    expect(byId.get(`${CHAT}/PRE1`)!.origin).toBe("live");
    for (const r of rows) expect(r.consent_id).toBe(confirmed.consent.id);

    await adapter.disconnect();
  });

  it("countRange rejects cleanly when the daemon never answers or is not running", async () => {
    const { adapter, child } = makeAdapter(tmpDir);
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await expect(ingestion.countRange()).rejects.toThrow(/COUNTS_UNAVAILABLE/);
    await adapter.connect();
    child.line({ t: "ready" });
    await expect(adapter.countRange(20)).rejects.toThrow(/did not answer count_range/);
    // The timed-out waiter is gone: a later answer settles only the new ask.
    child.countAnswer = { counts: {}, chats: 0, messages: 0, batches: 0, buffered_batches: 0, sync_types: [], range_installed: false, pending_live: 0 };
    const c = await adapter.countRange();
    expect(c.counts["24h"]).toEqual({ chats: 0, messages: 0 });
    expect(c.messages).toBe(0);
    await adapter.disconnect();
  });
});

describe("SRC-09 — reply structure reaches the model (deterministic half: the envelope carries it)", () => {
  it("reply 20 back, reaction, forward, mention and audience are on the envelope and stored, referent resolvable", async () => {
    const { adapter, child } = makeAdapter(tmpDir);
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();
    pairedDaemon(child);
    confirmWhatsAppWindows({ index: "all", understand: "30d", cardText: "SRC-09", nowMs: NOW });
    await ingestion.importRange("all");

    // e1..e21: chatter; e2 is Rohan's question; e21 is Karan's reply to e2.
    const speakers = [ROHAN, TANVI, KARAN, SELF];
    for (let i = 1; i <= 20; i++) {
      const from = speakers[i % speakers.length];
      const text = i === 2 ? "villa A or B?" : `chatter ${i}`;
      child.line(msg(`E${i}`, from, text, (60 - i) * 60_000));
    }
    child.line(
      msg("E21", KARAN, "A — the pool one", 39 * 60_000, {
        reply_to: { external_id: `${CHAT}/E2`, text: "villa A or B?", actor_ext_id: ROHAN },
        mentioned_ext_ids: [ROHAN],
      }),
    );
    child.line(msg("E22", TANVI, "https://airbnb.com/rooms/1", 38 * 60_000, { is_forwarded: true }));
    child.line({
      t: "event",
      event: {
        external_id: `${CHAT}/R1`,
        channel_ext_id: CHAT,
        actor_ext_id: SELF,
        ts: iso(37 * 60_000),
        kind: "reaction",
        text: "👍",
        from_me: true,
        reply_to_external_id: `${CHAT}/E21`,
        raw: { id: "R1" },
      },
    });
    await settle();

    const rows = eventRows();
    const byId = new Map(rows.map((r) => [r.external_id, r]));
    expect(rows).toHaveLength(23);

    // The reply: stored ref + quoted text; the referent (20 back) is a real row.
    const reply = byId.get(`${CHAT}/E21`)!;
    expect(reply.reply_to_external_id).toBe(`${CHAT}/E2`);
    expect(reply.reply_to_text).toBe("villa A or B?");
    const referent = getDb()
      .prepare(`SELECT id, text FROM events WHERE id = ?`)
      .get(eventId("whatsapp", `${CHAT}/E2`)) as { id: string; text: string } | undefined;
    expect(referent?.text).toBe("villa A or B?");
    const replyPayload = JSON.parse(reply.payload_json) as {
      reply_to: { external_id: string; text: string; actor: string };
      forwarded?: boolean;
    };
    expect(replyPayload.reply_to).toEqual({ external_id: `${CHAT}/E2`, text: "villa A or B?", actor: ROHAN });
    expect(replyPayload.forwarded).toBeUndefined();

    // Roles: sender, the observed audience (everyone who spoke + self), the
    // structural mention.
    const roles = JSON.parse(reply.roles_json) as {
      sender: string;
      audience: string[];
      receiver: string[];
      mentions: string[];
    };
    expect(roles.sender).toBe(KARAN);
    expect(roles.mentions).toEqual([ROHAN]);
    expect(new Set(roles.audience)).toEqual(new Set(["self", ROHAN, TANVI, KARAN]));
    expect(roles.receiver).toEqual(["*audience"]);
    // Self is "self", never its jid, in every role.
    const own = JSON.parse(byId.get(`${CHAT}/E3`)!.roles_json) as { sender: string };
    expect(own.sender).toBe("self");

    // The forward.
    const fwd = byId.get(`${CHAT}/E22`)!;
    expect(fwd.is_forwarded).toBe(1);
    const fwdPayload = JSON.parse(fwd.payload_json) as { forwarded?: boolean; link?: string };
    expect(fwdPayload.forwarded).toBe(true);

    // The reaction: its own row, targeting the reply, emoji as text.
    const rx = byId.get(`${CHAT}/R1`)!;
    expect(rx.kind).toBe("reaction");
    expect(rx.reply_to_external_id).toBe(`${CHAT}/E21`);
    const rxPayload = JSON.parse(rx.payload_json) as { reaction_to: string; text: string };
    expect(rxPayload.reaction_to).toBe(`${CHAT}/E21`);
    expect(rxPayload.text).toBe("👍");
    expect((JSON.parse(rx.roles_json) as { sender: string }).sender).toBe("self");

    await adapter.disconnect();
  });
});

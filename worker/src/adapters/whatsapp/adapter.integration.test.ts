// ===========================================================================
// WhatsAppAdapter integration test with a FAKE daemon.
//
// The fake `spawn` returns an in-process EventEmitter-based ChildLike whose
// stdout emits a scripted NDJSON stream (ready → qr → paired → channel/actor →
// events → progress → backfill_complete). It runs through the adapter's REAL
// NDJSON framing code (line buffering, JSON-per-line parse) — no framing is
// stubbed. Control commands written to the fake's stdin are captured so we can
// assert graceful shutdown.
//
// Asserts:
//   - qr surfaced via the status callback;
//   - channels/actors/events written to the DB via the Ingestion writer;
//   - dedupe: a re-emitted event does not create a second row;
//   - inbox list + message fetch + FTS search reflect the ingested data;
//   - pause halts ingestion (a post-pause event is dropped);
//   - disconnect() sends `shutdown` on stdin and reaps the child (no orphan).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../../db/connection.js";
import { runMigrations } from "../../db/connection.js";
import {
  appStateGet,
  getStreamMessages,
  importDoneKey,
  importRangeKey,
  listInboxChats,
  searchEvents,
} from "../../db/ingest.js";
import { Ingestion } from "../../ingest/index.js";
import {
  WhatsAppAdapter,
  type ChildLike,
  type SpawnFn,
} from "./adapter.js";
import type { StatusUpdate } from "../types.js";

// ---- Fake child process ---------------------------------------------------

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly writes: string[] = [];
  killed: NodeJS.Signals | number | null = null;
  pid = 4242;

  stdin = {
    write: (chunk: string) => {
      this.writes.push(chunk);
    },
    end: () => {},
  };

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = signal ?? "SIGTERM";
    // A real daemon exits after shutdown/SIGTERM; emulate a prompt exit.
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }

  /** Push a raw chunk to stdout (may contain many lines / partial lines). */
  push(chunk: string): void {
    this.stdout.emit("data", chunk);
  }

  /** Emit one JSON object as an NDJSON line. */
  line(obj: unknown): void {
    this.push(JSON.stringify(obj) + "\n");
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wa-adapter-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build an adapter wired to a fresh FakeChild, plus the child + spawn capture. */
function makeAdapter(): {
  adapter: WhatsAppAdapter;
  child: FakeChild;
  spawnArgs: { bin: string; args: string[] }[];
} {
  const child = new FakeChild();
  const spawnArgs: { bin: string; args: string[] }[] = [];
  const spawn: SpawnFn = (bin, args) => {
    spawnArgs.push({ bin, args });
    return child;
  };
  const adapter = new WhatsAppAdapter({
    spawn,
    mock: true,
    autoRestart: false, // deterministic: no restart during the test
    home: tmpDir,
  });
  return { adapter, child, spawnArgs };
}

describe("WhatsAppAdapter + Ingestion (fake daemon, real NDJSON framing)", () => {
  it("drives the full scripted stream: qr, ingest, dedupe, inbox, search, pause, shutdown", async () => {
    const { adapter, child, spawnArgs } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();

    const statuses: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => statuses.push(s));

    await adapter.connect();

    // The daemon was spawned with --mock + the session/media flags.
    expect(spawnArgs.length).toBe(1);
    expect(spawnArgs[0].args).toContain("--mock");
    expect(spawnArgs[0].args).toContain("--session-db");
    expect(spawnArgs[0].args).toContain("--media-dir");
    // Media dir is rooted under the sandbox home (SUPERTWIN_HOME/media/whatsapp),
    // so daemon-written media lands where the /api/media route serves from.
    const mediaFlagIdx = spawnArgs[0].args.indexOf("--media-dir");
    expect(spawnArgs[0].args[mediaFlagIdx + 1]).toBe(
      join(tmpDir, "media", "whatsapp"),
    );

    // ---- Scripted NDJSON stream (contract §1 ordering).
    child.line({ t: "ready" });
    child.line({ t: "status", state: "need_pairing" });
    child.line({ t: "qr", code: "2@FAKEQR==", timeout_s: 60 });
    child.line({ t: "paired", jid: "me@s.whatsapp.net", push_name: "Me" });
    child.line({ t: "status", state: "online", jid: "me@s.whatsapp.net", push_name: "Me" });

    // Self actor first (so fromMe resolves), then a contact.
    child.line({
      t: "actor",
      actor: { source_ext_id: "me@s.whatsapp.net", display_name: "Me", is_self: true },
    });
    child.line({
      t: "channel",
      channel: { source_ext_id: "mom@s.whatsapp.net", name: "Mom", kind: "dm" },
    });
    child.line({
      t: "actor",
      actor: { source_ext_id: "mom@s.whatsapp.net", display_name: "Mom", handle: "+199", is_self: false },
    });

    // Two events. Emit MSG1 twice to exercise dedupe through the writer.
    const ev1 = {
      external_id: "mom@s.whatsapp.net/MSG1",
      channel_ext_id: "mom@s.whatsapp.net",
      actor_ext_id: "mom@s.whatsapp.net",
      ts: "2026-07-02T10:00:00.000Z",
      kind: "message",
      text: "coffee tomorrow?",
      from_me: false,
      raw: { id: "MSG1" },
    };
    const ev2 = {
      external_id: "mom@s.whatsapp.net/MSG2",
      channel_ext_id: "mom@s.whatsapp.net",
      actor_ext_id: "me@s.whatsapp.net",
      ts: "2026-07-02T10:05:00.000Z",
      kind: "message",
      text: "sure, sounds good",
      from_me: true,
      raw: { id: "MSG2" },
    };
    child.line({ t: "event", event: ev1 });
    child.line({ t: "event", event: ev1 }); // duplicate re-emit
    child.line({ t: "event", event: ev2 });

    child.line({
      t: "progress",
      phase: "backfill",
      chats_done: 1,
      chats_total: 1,
      messages: 2,
      done: true,
      range: "7d",
    });
    child.line({ t: "backfill_complete", range: "7d", chats: 1, messages: 2 });

    // ---- Assertions on status callbacks.
    const qr = statuses.find((s) => s.type === "qr");
    expect(qr).toBeTruthy();
    expect(qr!.type === "qr" && qr!.code).toBe("2@FAKEQR==");
    expect(statuses.some((s) => s.type === "paired")).toBe(true);
    expect(statuses.some((s) => s.type === "progress")).toBe(true);
    expect(statuses.some((s) => s.type === "backfill_complete")).toBe(true);

    // Adapter status reflects paired + online.
    const st = ingestion.getStatus();
    expect(st.paired).toBe(true);
    expect(st.state).toBe("online");

    // ---- Ingestion stats: 2 inserted, 1 deduped.
    expect(ingestion.stats.eventsInserted).toBe(2);
    expect(ingestion.stats.eventsDeduped).toBe(1);

    // ---- Inbox reflects the chat.
    const chats = listInboxChats({ limit: 10 });
    expect(chats.length).toBe(1);
    expect(chats[0].name).toBe("Mom");
    expect(chats[0].messageCount).toBe(2);
    expect(chats[0].lastText).toBe("sure, sounds good");

    const msgs = getStreamMessages({ streamId: chats[0].id, limit: 10 });
    expect(msgs.map((m) => m.text)).toEqual(["coffee tomorrow?", "sure, sounds good"]);
    // fromMe resolves via the persisted self JID.
    expect(msgs.map((m) => m.fromMe)).toEqual([false, true]);

    // ---- FTS search finds it.
    const hits = searchEvents({ q: "coffee" });
    expect(hits.length).toBe(1);
    expect(hits[0].text).toBe("coffee tomorrow?");

    // ---- Pause halts ingestion: a post-pause event is dropped.
    await ingestion.setPaused(true);
    expect(child.writes.some((w) => w.includes('"cmd":"pause"'))).toBe(true);
    child.line({
      t: "event",
      event: {
        external_id: "mom@s.whatsapp.net/MSG3",
        channel_ext_id: "mom@s.whatsapp.net",
        actor_ext_id: "mom@s.whatsapp.net",
        ts: "2026-07-02T11:00:00.000Z",
        kind: "message",
        text: "are you there?",
        from_me: false,
        raw: { id: "MSG3" },
      },
    });
    expect(ingestion.stats.eventsInserted).toBe(2); // unchanged
    expect(listInboxChats({ limit: 10 })[0].messageCount).toBe(2);

    // ---- Graceful shutdown: `shutdown` on stdin + child reaped.
    await adapter.disconnect();
    expect(child.writes.some((w) => w.includes('"cmd":"shutdown"'))).toBe(true);
    expect(child.killed).toBe("SIGTERM");
  });

  it("SUPERTWIN_MEDIA_DIR overrides the home-derived --media-dir", async () => {
    const explicitMedia = join(tmpDir, "elsewhere-media");
    process.env.SUPERTWIN_MEDIA_DIR = explicitMedia;
    try {
      const { adapter, spawnArgs } = makeAdapter();
      await adapter.connect();
      const idx = spawnArgs[0].args.indexOf("--media-dir");
      expect(idx).toBeGreaterThan(-1);
      // Explicit override wins over SUPERTWIN_HOME; daemon writes into its
      // `whatsapp` subdir, matching the /api/media route's mediaRoot() guard.
      expect(spawnArgs[0].args[idx + 1]).toBe(join(explicitMedia, "whatsapp"));
      await adapter.disconnect();
    } finally {
      delete process.env.SUPERTWIN_MEDIA_DIR;
    }
  });

  it("D1: keeps a completed backfill pinned in /status after a trailing live progress frame", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();

    child.line({ t: "ready" });
    child.line({ t: "status", state: "online" });
    child.line({
      t: "progress",
      phase: "backfill",
      chats_done: 3,
      chats_total: 3,
      messages: 10,
      done: true,
      range: "all",
    });
    child.line({ t: "backfill_complete", range: "all", chats: 3, messages: 10 });
    // The daemon (mock) then emits a zeroed live-phase frame — it must NOT
    // clobber the completed backfill snapshot, or onboarding would hang.
    child.line({
      t: "progress",
      phase: "live",
      chats_done: 0,
      chats_total: 0,
      messages: 0,
      done: false,
    });

    const st = adapter.getStatus();
    expect(st.progress?.done).toBe(true);
    expect(st.progress?.phase).toBe("backfill");
    expect(st.progress?.messages).toBe(10);

    await adapter.disconnect();
  });

  it("D2: surfaces a child spawn error as state=error", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();

    child.emit("error", new Error("spawn EACCES"));

    const st = adapter.getStatus();
    expect(st.state).toBe("error");
    expect(st.lastError?.code).toBe("CHILD_ERROR");

    await adapter.disconnect();
  });

  it("frames NDJSON split across arbitrary chunk boundaries", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    const statuses: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => statuses.push(s));
    await adapter.connect();

    // Emit a `qr` line byte-by-byte across many chunks (partial-line buffering).
    const raw = JSON.stringify({ t: "qr", code: "SPLIT-QR", timeout_s: 30 }) + "\n";
    for (const ch of raw) child.push(ch);

    const qr = statuses.find((s) => s.type === "qr");
    expect(qr && qr.type === "qr" && qr.code).toBe("SPLIT-QR");

    // Two JSON objects in a single chunk (multi-line buffering).
    child.push(
      JSON.stringify({ t: "status", state: "connected" }) +
        "\n" +
        JSON.stringify({ t: "status", state: "online" }) +
        "\n",
    );
    const states = statuses.filter((s) => s.type === "status").map((s) => (s.type === "status" ? s.state : ""));
    expect(states).toContain("connected");
    expect(states).toContain("online");

    await adapter.disconnect();
  });

  it("ignores unknown `t` values (forward-compat) and non-JSON lines", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();

    // Should not throw or affect state.
    child.push("this is not json\n");
    child.line({ t: "future_message_type", whatever: 1 });
    child.line({ t: "status", state: "online" });

    expect(ingestion.getStatus().state).toBe("online");
    await adapter.disconnect();
  });

  it("renames the daemon's per-payload history_sync counters at the boundary", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    const statuses: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => statuses.push(s));
    await adapter.connect();

    // The frame the shallow-bootstrap verdict is built from: WhatsApp's opening
    // batch, with the counters that say how much of it survived the range filter.
    child.line({
      t: "history_sync",
      sync_type: "INITIAL_BOOTSTRAP",
      progress: 0,
      chats: 89,
      chats_in_range: 89,
      messages_seen: 486,
      messages_in_range: 292,
      messages_emitted: 292,
      messages_filtered: 194,
      on_demand: false,
    });

    const frame = statuses.find((s) => s.type === "history_sync");
    if (frame?.type !== "history_sync") throw new Error("no history_sync frame");
    expect(frame.payload).toEqual({
      syncType: "INITIAL_BOOTSTRAP",
      progress: 0,
      chats: 89,
      chatsInRange: 89,
      messagesSeen: 486,
      messagesInRange: 292,
      messagesEmitted: 292,
      messagesFiltered: 194,
      onDemand: false,
    });

    // A partial frame from an older/newer daemon degrades to zeroes rather than
    // throwing — the frame is an optional enrichment, never a dependency.
    child.line({ t: "history_sync", sync_type: "FULL" });
    const partial = statuses.filter((s) => s.type === "history_sync")[1];
    if (partial?.type !== "history_sync") throw new Error("no second frame");
    expect(partial.payload.syncType).toBe("FULL");
    expect(partial.payload.messagesSeen).toBe(0);
    expect(partial.payload.progress).toBeUndefined();

    await adapter.disconnect();
  });

  it("seeds back-pagination anchors from the DB on every daemon ready and before every extend", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();
    child.line({ t: "ready" });

    // Nothing ingested yet: seeding an empty list would be a wire message that
    // says nothing, so none is sent.
    expect(child.writes.some((w) => w.includes("seed_anchors"))).toBe(false);

    child.line({
      t: "channel",
      channel: { source_ext_id: "mom@s.whatsapp.net", name: "Mom", kind: "dm" },
    });
    child.line({
      t: "actor",
      actor: { source_ext_id: "mom@s.whatsapp.net", display_name: "Mom", is_self: false },
    });
    for (const [id, ts] of [
      ["OLDEST", "2026-05-01T09:00:00.000Z"],
      ["NEWER", "2026-06-01T09:00:00.000Z"],
    ] as const) {
      child.line({
        t: "event",
        event: {
          external_id: `mom@s.whatsapp.net/${id}`,
          channel_ext_id: "mom@s.whatsapp.net",
          actor_ext_id: "mom@s.whatsapp.net",
          ts,
          kind: "message",
          text: id,
          from_me: false,
        },
      });
    }

    // A daemon restart empties its in-memory anchor map, so `ready` re-seeds it.
    child.line({ t: "ready" });
    const seeded = child.writes.filter((w) => w.includes("seed_anchors"));
    expect(seeded).toHaveLength(1);
    expect(JSON.parse(seeded[0])).toEqual({
      cmd: "seed_anchors",
      anchors: [
        {
          // The OLDEST message is the point back-pagination resumes from.
          chat_jid: "mom@s.whatsapp.net",
          // The `<id>` half of external_id, not the whole thing.
          msg_id: "OLDEST",
          from_me: false,
          ts: "2026-05-01T09:00:00.000Z",
        },
      ],
    });

    // An extend has no history push of its own and can only paginate from
    // anchors that already exist, so it re-seeds immediately before asking.
    await ingestion.extend("1y");
    const tail = child.writes.slice(child.writes.indexOf(seeded[0]) + 1);
    const seedIdx = tail.findIndex((w) => w.includes("seed_anchors"));
    const extendIdx = tail.findIndex((w) => w.includes('"cmd":"extend"'));
    expect(seedIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeLessThan(extendIdx);

    await adapter.disconnect();
  });

  // ---- Rev 2 §R2.1: persisted import state --------------------------------

  it("R2.1: sets importDone on backfill_complete, surfaces it via status, and survives a restart", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();

    // Before any backfill, importDone is false.
    expect(ingestion.getStatus().importDone).toBe(false);

    child.line({ t: "ready" });
    child.line({ t: "status", state: "online" });
    child.line({ t: "backfill_complete", range: "30d", chats: 2, messages: 5 });

    // Surfaced immediately in the live status snapshot.
    const st = ingestion.getStatus();
    expect(st.importDone).toBe(true);
    expect(st.importRange).toBe("30d");

    // Persisted to app_state (the durable record).
    expect(appStateGet(importDoneKey("whatsapp"))).toBe("true");
    expect(appStateGet(importRangeKey("whatsapp"))).toBe("30d");

    await adapter.disconnect();

    // ---- Simulated restart: a FRESH adapter + Ingestion over the SAME DB.
    // start() must re-read the persisted flag so status reports importDone:true
    // immediately after boot, without any daemon frames.
    const child2 = new FakeChild();
    const adapter2 = new WhatsAppAdapter({
      spawn: () => child2,
      mock: true,
      autoRestart: false,
      home: tmpDir,
    });
    const ingestion2 = new Ingestion(adapter2);
    ingestion2.start();

    const rebooted = ingestion2.getStatus();
    expect(rebooted.importDone).toBe(true);
    expect(rebooted.importRange).toBe("30d");

    await adapter2.disconnect();
  });

  // ---- set_range at connect: history window matches the chosen range --------

  it("installs the persisted import range via set_range on connect (returning user)", async () => {
    // First session: a completed import persists the chosen range in app_state.
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();
    child.line({ t: "ready" });
    child.line({ t: "status", state: "online" });
    child.line({ t: "backfill_complete", range: "90d", chats: 2, messages: 5 });
    // No set_range is sent when there was no persisted range at start().
    expect(child.writes.some((w) => w.includes('"cmd":"set_range"'))).toBe(false);
    await adapter.disconnect();
    expect(appStateGet(importRangeKey("whatsapp"))).toBe("90d");

    // Restart: a fresh adapter + Ingestion over the SAME DB must install the
    // persisted range via set_range once the daemon is ready — BEFORE it connects
    // and WhatsApp can re-push history — so that history is filtered by 90d.
    const child2 = new FakeChild();
    const adapter2 = new WhatsAppAdapter({
      spawn: () => child2,
      mock: true,
      autoRestart: false,
      home: tmpDir,
    });
    const ingestion2 = new Ingestion(adapter2);
    ingestion2.start();
    await adapter2.connect();
    child2.line({ t: "ready" });

    const setRangeCmd = child2.writes.find((w) => w.includes('"cmd":"set_range"'));
    expect(setRangeCmd).toBeTruthy();
    expect(setRangeCmd).toContain('"range":"90d"');
    await adapter2.disconnect();
  });

  it("sends NO set_range on a first pair with no chosen range (daemon buffers until onboarding)", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();
    child.line({ t: "ready" });
    child.line({ t: "status", state: "need_pairing" });

    // No persisted range -> nothing installed; the daemon holds pushed history
    // until the user picks a range in onboarding (then `import` installs it).
    expect(child.writes.some((w) => w.includes('"cmd":"set_range"'))).toBe(false);
    await adapter.disconnect();
  });

  // ---- Rev 3 §R3.2: intentional post-logout exit → clean restart ----------

  it("R3.2: a post-logout daemon exit restarts into pairing WITHOUT an error/reconnecting flap", async () => {
    // Multiple spawns: each connect/restart gets a FRESH FakeChild so we can
    // drive the second (post-logout) daemon into need_pairing.
    const children: FakeChild[] = [];
    const spawn: SpawnFn = () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    };
    const adapter = new WhatsAppAdapter({
      spawn,
      mock: true,
      autoRestart: true, // supervisor must restart the post-logout exit
      backoffBaseMs: 5, // fast, deterministic restart
      backoffMaxMs: 20,
      home: tmpDir,
    });
    const ingestion = new Ingestion(adapter);
    ingestion.start();

    const statuses: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => statuses.push(s));

    await adapter.connect();
    const first = children[0];
    first.line({ t: "ready" });
    first.line({ t: "status", state: "online", jid: "me@x", push_name: "Me" });
    expect(adapter.getStatus().paired).toBe(true);

    // Relink/logout: worker sends `logout`; the daemon clears its session, emits
    // logged_out, and exits 0 (intentional).
    await adapter.logout();
    expect(first.writes.some((w) => w.includes('"cmd":"logout"'))).toBe(true);

    first.line({ t: "status", state: "logged_out" });
    // paired flips false on logged_out.
    expect(adapter.getStatus().paired).toBe(false);

    // Daemon exits 0 (intentional post-logout exit).
    first.emit("exit", 0, null);

    // The supervisor must NOT flap to a scary error/reconnecting state.
    const flappedScary = statuses.some(
      (s) => s.type === "status" && (s.state === "error" || s.state === "reconnecting"),
    );
    expect(flappedScary).toBe(false);
    expect(adapter.getStatus().state).not.toBe("error");
    expect(adapter.getStatus().state).not.toBe("reconnecting");

    // A fresh daemon is spawned; drive it to need_pairing → qr on pair.
    await waitFor(() => children.length === 2, 1000);
    const second = children[1];
    second.line({ t: "ready" });
    second.line({ t: "status", state: "need_pairing" });
    expect(adapter.getStatus().state).toBe("need_pairing");
    expect(adapter.getStatus().paired).toBe(false);

    await adapter.startPairing();
    second.line({ t: "qr", code: "2@FRESHQR==", timeout_s: 60 });
    expect(statuses.some((s) => s.type === "qr" && s.code === "2@FRESHQR==")).toBe(true);

    await adapter.disconnect();
  });

  // ---- Rev 2 §R2.2: live-ingest nudge -------------------------------------

  it("R2.2: emits a debounced ingest nudge after events persist, including a from_me event", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();

    const frames: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => frames.push(s));

    await adapter.connect();
    child.line({ t: "ready" });
    child.line({ t: "status", state: "online", jid: "me@x", push_name: "Me" });
    child.line({ t: "actor", actor: { source_ext_id: "me@x", display_name: "Me", is_self: true } });
    child.line({ t: "channel", channel: { source_ext_id: "mom@x", name: "Mom", kind: "dm" } });
    child.line({ t: "actor", actor: { source_ext_id: "mom@x", display_name: "Mom", is_self: false } });

    // Incoming message + a from_me self-sent message in quick succession.
    child.line({
      t: "event",
      event: {
        external_id: "mom@x/MSG1",
        channel_ext_id: "mom@x",
        actor_ext_id: "mom@x",
        ts: "2026-07-02T10:00:00.000Z",
        kind: "message",
        text: "coffee?",
        from_me: false,
        raw: { id: "MSG1" },
      },
    });
    child.line({
      t: "event",
      event: {
        external_id: "mom@x/MSG2",
        channel_ext_id: "mom@x",
        actor_ext_id: "me@x",
        ts: "2026-07-02T10:01:00.000Z",
        kind: "message",
        text: "sure!",
        from_me: true,
        raw: { id: "MSG2" },
      },
    });

    // No nudge yet (debounced ~750ms).
    expect(frames.filter((f) => f.type === "ingest")).toHaveLength(0);

    // Wait past the debounce window and assert exactly one coalesced nudge.
    await waitFor(() => frames.some((f) => f.type === "ingest"), 2000);
    const nudges = frames.filter((f) => f.type === "ingest");
    expect(nudges).toHaveLength(1);
    const nudge = nudges[0];
    // Shape: { type:"ingest", ts:<iso>, channels:[<channelId>...] }.
    expect(nudge.type === "ingest" && typeof nudge.ts).toBe("string");
    const touched = nudge.type === "ingest" ? nudge.channels : [];
    // Both events are the same chat -> exactly one distinct channel id.
    expect(touched).toEqual(["whatsapp:st:mom@x"]);

    await adapter.disconnect();
  });

  it("R2.2: a from_me-only burst still nudges (bug 2)", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    const frames: StatusUpdate[] = [];
    ingestion.subscribeStatus((s) => frames.push(s));

    await adapter.connect();
    child.line({ t: "ready" });
    child.line({ t: "status", state: "online", jid: "me@x", push_name: "Me" });
    child.line({ t: "actor", actor: { source_ext_id: "me@x", display_name: "Me", is_self: true } });
    child.line({ t: "channel", channel: { source_ext_id: "me@x", name: "Me", kind: "dm" } });

    // Self-chat message (from_me true, channel == self).
    child.line({
      t: "event",
      event: {
        external_id: "me@x/SELF1",
        channel_ext_id: "me@x",
        actor_ext_id: "me@x",
        ts: "2026-07-02T09:00:00.000Z",
        kind: "message",
        text: "note to self",
        from_me: true,
        raw: { id: "SELF1" },
      },
    });

    await waitFor(() => frames.some((f) => f.type === "ingest"), 2000);
    expect(frames.filter((f) => f.type === "ingest")).toHaveLength(1);

    await adapter.disconnect();
  });

  // ---- Rev 5 §R5.3/§R5.4: reactions + quoted replies end-to-end ------------

  it("R5.3/R5.4: reactions attach to their target (not standalone) and quoted replies persist through the full pipeline", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();

    child.line({ t: "ready" });
    child.line({ t: "status", state: "online", jid: "me@s.whatsapp.net", push_name: "Me" });
    child.line({
      t: "actor",
      actor: { source_ext_id: "me@s.whatsapp.net", display_name: "Me", is_self: true },
    });
    child.line({
      t: "channel",
      channel: { source_ext_id: "alice@s.whatsapp.net", name: "Alice", kind: "dm" },
    });
    child.line({
      t: "actor",
      actor: { source_ext_id: "alice@s.whatsapp.net", display_name: "Alice", is_self: false },
    });

    // 1) Original message from Alice.
    child.line({
      t: "event",
      event: {
        external_id: "alice@s.whatsapp.net/MSG1",
        channel_ext_id: "alice@s.whatsapp.net",
        actor_ext_id: "alice@s.whatsapp.net",
        ts: "2026-07-02T10:00:00.000Z",
        kind: "message",
        text: "dinner at 8?",
        from_me: false,
        raw: { id: "MSG1" },
      },
    });
    // 2) Self quoted-reply to MSG1 (reply_to object per §R5.4).
    child.line({
      t: "event",
      event: {
        external_id: "alice@s.whatsapp.net/MSG2",
        channel_ext_id: "alice@s.whatsapp.net",
        actor_ext_id: "me@s.whatsapp.net",
        ts: "2026-07-02T10:05:00.000Z",
        kind: "message",
        text: "yes!",
        from_me: true,
        reply_to: {
          external_id: "alice@s.whatsapp.net/MSG1",
          text: "dinner at 8?",
          actor_ext_id: "alice@s.whatsapp.net",
        },
        raw: { id: "MSG2" },
      },
    });
    // 3) Self 👍 reaction to MSG1 (kind='reaction', §R5.3).
    child.line({
      t: "event",
      event: {
        external_id: "alice@s.whatsapp.net/REACT1",
        channel_ext_id: "alice@s.whatsapp.net",
        actor_ext_id: "me@s.whatsapp.net",
        ts: "2026-07-02T10:06:00.000Z",
        kind: "reaction",
        text: "👍",
        from_me: true,
        reply_to_external_id: "alice@s.whatsapp.net/MSG1",
        raw: { id: "REACT1" },
      },
    });
    // 4) Alice removes a prior ❤️ she'd placed — first add, then remove.
    child.line({
      t: "event",
      event: {
        external_id: "alice@s.whatsapp.net/REACT2",
        channel_ext_id: "alice@s.whatsapp.net",
        actor_ext_id: "alice@s.whatsapp.net",
        ts: "2026-07-02T10:07:00.000Z",
        kind: "reaction",
        text: "❤️",
        from_me: false,
        reply_to_external_id: "alice@s.whatsapp.net/MSG1",
        raw: { id: "REACT2" },
      },
    });
    child.line({
      t: "event",
      event: {
        external_id: "alice@s.whatsapp.net/REACT3",
        channel_ext_id: "alice@s.whatsapp.net",
        actor_ext_id: "alice@s.whatsapp.net",
        ts: "2026-07-02T10:08:00.000Z",
        kind: "reaction",
        text: "", // removal
        from_me: false,
        reply_to_external_id: "alice@s.whatsapp.net/MSG1",
        raw: { id: "REACT3" },
      },
    });

    // 2 real events (MSG1, MSG2) + 2 reaction rows inserted. REACT3 is a removal
    // (media spec §6): it DELETES Alice's stored ❤️ instead of inserting a row.
    expect(ingestion.stats.eventsInserted).toBe(4);
    expect(
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'reaction'`)
          .get() as { n: number }
      ).n,
    ).toBe(1);

    const chats = listInboxChats({ limit: 10 });
    expect(chats).toHaveLength(1);
    // The 3 reactions do NOT count; last message is the reply, not an emoji.
    expect(chats[0].messageCount).toBe(2);
    expect(chats[0].lastText).toBe("yes!");

    const msgs = getStreamMessages({ streamId: chats[0].id, limit: 10 });
    // Only the two real messages surface — reactions are never standalone bubbles.
    expect(msgs.map((m) => m.text)).toEqual(["dinner at 8?", "yes!"]);
    expect(msgs.every((m) => m.kind !== "reaction")).toBe(true);

    // MSG1 carries self's 👍; Alice's ❤️ was removed (net-current state).
    const original = msgs.find((m) => m.text === "dinner at 8?")!;
    expect(original.reactions).toEqual([
      { emoji: "👍", fromMe: true, actorName: "Me" },
    ]);

    // MSG2 is a quoted reply resolving Alice as the quoted actor.
    const reply = msgs.find((m) => m.text === "yes!")!;
    expect(reply.replyTo).toEqual({
      externalId: "alice@s.whatsapp.net/MSG1",
      text: "dinner at 8?",
      actorName: "Alice",
    });
    expect(original.replyTo).toBeNull();

    // Reactions are excluded from FTS search too (the emoji text won't be a hit,
    // and no reaction row leaks in). The reply IS a hit: its own words are "yes!"
    // and the question it answers reaches it only through the quote (0017).
    const hits = searchEvents({ q: "dinner" }).map((h) => h.eventId);
    expect([...hits].sort()).toEqual([
      "whatsapp:alice@s.whatsapp.net/MSG1",
      "whatsapp:alice@s.whatsapp.net/MSG2",
    ]);

    await adapter.disconnect();
  });
});

/** Poll `pred` until true or `timeoutMs` elapses (for the debounced nudge). */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

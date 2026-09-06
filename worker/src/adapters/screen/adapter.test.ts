// ===========================================================================
// ScreenAdapter tests (build P2.1) — a FAKE sidecar drives the adapter's
// REAL NDJSON framing, exactly the WhatsAppAdapter test pattern. No live
// model calls, no real spawn, no Accessibility permission.
//
// Covers:
//   - snapshot frames land in the sink as v13 `screen.snapshot` envelopes;
//   - multitask keying (SEG-06-equivalent): interleaved streams stay keyed
//     bundleId¦docKey and dedupe independently;
//   - privacy drops, HARD: password-manager / private-window content never
//     reaches the sink even when a (buggy) sidecar emits it; drop frames
//     carry no content; pause and per-app pause block ingestion;
//   - references: links/files ride the payload as plain strings;
//   - lifecycle: queued commands flush on ready, shutdown sent on disconnect,
//     crash schedules a restart.
// ===========================================================================

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../db/eventlog.js";
import {
  SCREEN_PAUSED_APPS_KEY,
  SCREEN_PAUSED_KEY,
  ScreenAdapter,
  type ChildLike,
  type ScreenAdapterOptions,
  type ScreenPauseState,
  type SpawnFn,
} from "./adapter.js";
import { reconstructScreenText, type BlobPut, type ScreenSnapshotPayload } from "./envelope.js";
import type { SnapshotFrame } from "./frames.js";
import { MemoryScreenSink } from "./sink.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly writes: string[] = [];
  killed: NodeJS.Signals | number | null = null;
  pid = 777;

  stdin = {
    write: (chunk: string) => {
      this.writes.push(chunk);
    },
    end: () => {},
  };

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = signal ?? "SIGTERM";
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }

  line(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }

  ready(): void {
    this.line({ t: "ready", mock: "true" });
    this.line({ t: "status", state: "capturing" });
  }
}

function snapshot(over: Partial<SnapshotFrame> = {}): SnapshotFrame {
  const text = over.text ?? "meeting notes";
  const base: SnapshotFrame = {
    t: "snapshot",
    ts: "2026-08-28T10:00:00.000Z",
    bundle_id: "com.apple.TextEdit",
    app_name: "TextEdit",
    window_title: "notes.txt",
    doc_key: "/Users/u/notes.txt",
    stream_key: "com.apple.TextEdit¦/Users/u/notes.txt",
    trigger: "app_switch",
    tree_hash: "th-" + text.length,
    content_hash: "ch-" + text,
    char_count: text.length,
    new_chars: over.new_chars ?? text,
    text,
    links: [],
    files: [],
  };
  return { ...base, ...over };
}

/** In-memory app_state stand-in (V6 S1.6: pause persisted + seeded at boot). */
class MemoryPauseState implements ScreenPauseState {
  readonly rows = new Map<string, string>();
  get(key: string): string | null {
    return this.rows.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.rows.set(key, value);
  }
}

/** In-memory content-addressed blob store standing in for v6core.putBlob. */
class MemoryBlobs {
  readonly blobs = new Map<string, { kind: string; data: string }>();
  put: BlobPut = (data, kind) => {
    const sha256 = createHash("sha256").update(data, "utf8").digest("hex");
    this.blobs.set(sha256, { kind, data });
    return { sha256 };
  };
  text(sha256: string): string | null {
    return this.blobs.get(sha256)?.data ?? null;
  }
}

function harness(over: Partial<ScreenAdapterOptions> = {}): {
  adapter: ScreenAdapter;
  child: FakeChild;
  sink: MemoryScreenSink;
  state: MemoryPauseState;
  blobs: MemoryBlobs;
} {
  const child = new FakeChild();
  const spawn: SpawnFn = () => child;
  const sink = new MemoryScreenSink();
  const state = (over.pauseState as MemoryPauseState | undefined) ?? new MemoryPauseState();
  const blobs = new MemoryBlobs();
  const adapter = new ScreenAdapter({
    spawn,
    sink,
    autoRestart: false,
    mock: true,
    pauseState: state,
    putBlob: blobs.put,
    ...over,
  });
  return { adapter, child, sink, state, blobs };
}

describe("ScreenAdapter", () => {
  it("appends snapshot frames as v13 screen.snapshot envelopes", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.line(snapshot({ links: ["https://docs.example.com/x"], files: ["file:///a"] }));

    expect(sink.events).toHaveLength(1);
    const e = sink.events[0]!;
    expect(e.source).toBe("screen");
    expect(e.kind).toBe("screen.snapshot");
    expect(e.origin).toBe("live");
    // S3.4: a frame whose doc_key is a file path streams as doc:<path>.
    expect(e.streamKey).toBe("doc:/Users/u/notes.txt");
    expect(e.actor).toBe("self");
    expect(e.roles.sender).toBe("self");
    const p = e.payload as ScreenSnapshotPayload;
    expect(p.text).toBe("meeting notes"); // FTS projection = new_chars
    expect(p.trigger).toBe("app_switch");
    // References ride the payload as plain strings (no content_pending — S0.5).
    expect(p.links).toEqual(["https://docs.example.com/x"]);
    expect(p.files).toEqual(["file:///a"]);
    expect(adapter.getStatus().snapshots).toBe(1);
  });

  it("also collects URLs spelled out in new_chars", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.line(snapshot({
      text: "see https://issues.example.com/42 for details",
      new_chars: "see https://issues.example.com/42 for details",
      links: ["https://docs.example.com/x"],
    }));
    const p = sink.events[0]!.payload as ScreenSnapshotPayload;
    expect(p.links).toEqual([
      "https://docs.example.com/x",
      "https://issues.example.com/42",
    ]);
  });

  it("keys multitasking into distinct streams (SEG-06-equivalent)", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    // Interleaved: doc A, doc B, back to doc A (changed), other app w/ same doc.
    child.line(snapshot({ doc_key: "/a.txt", stream_key: "com.apple.TextEdit¦/a.txt", text: "alpha", new_chars: "alpha", content_hash: "c1" }));
    child.line(snapshot({ doc_key: "/b.txt", stream_key: "com.apple.TextEdit¦/b.txt", text: "bravo", new_chars: "bravo", content_hash: "c2" }));
    child.line(snapshot({ doc_key: "/a.txt", stream_key: "com.apple.TextEdit¦/a.txt", text: "alpha beta", new_chars: " beta", content_hash: "c3" }));
    child.line(snapshot({ bundle_id: "com.microsoft.VSCode", doc_key: "/a.txt", stream_key: "com.microsoft.VSCode¦/a.txt", text: "alpha", new_chars: "alpha", content_hash: "c1" }));

    expect(sink.events).toHaveLength(4);
    const keys = sink.events.map((e) => e.streamKey);
    // S3.4: one document is one stream whichever app shows it (doc:<path>).
    expect(keys).toEqual(["doc:/a.txt", "doc:/b.txt", "doc:/a.txt", "doc:/a.txt"]);
    expect(new Set(keys).size).toBe(2);
    // Same content in different apps = different append identity (the
    // sidecar's bundleId¦docKey stays in the hash even though the stream is shared).
    expect(sink.events[0]!.contentHash).not.toBe(sink.events[3]!.contentHash);
  });

  it("dedupes an identical replayed frame by content hash", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.line(snapshot());
    child.line(snapshot()); // sidecar restart replay
    expect(sink.events).toHaveLength(1);
  });

  it("HARD: password-manager content never reaches the sink even if the sidecar emits it", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.line(snapshot({
      bundle_id: "com.1password.1password",
      app_name: "1Password",
      stream_key: "com.1password.1password¦vault",
      doc_key: "vault",
      text: "SECRET-VAULT-PASSWORD",
      new_chars: "SECRET-VAULT-PASSWORD",
      content_hash: "ch-secret",
    }));
    expect(sink.events).toHaveLength(0);
    expect(JSON.stringify(sink.events)).not.toContain("SECRET");
    expect(adapter.getStatus().drops["password_manager"]).toBe(1);
  });

  it("HARD: private-window content never reaches the sink", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.line(snapshot({
      bundle_id: "com.google.Chrome",
      window_title: "bank stuff (Incognito)",
      stream_key: "com.google.Chrome¦https://bank.example.com",
      doc_key: "https://bank.example.com",
      text: "HIDDEN-BALANCE",
      new_chars: "HIDDEN-BALANCE",
      content_hash: "ch-hidden",
    }));
    expect(sink.events).toHaveLength(0);
    expect(JSON.stringify(sink.events)).not.toContain("HIDDEN-BALANCE");
    expect(adapter.getStatus().drops["private_window"]).toBe(1);
  });

  it("drop frames are content-free counters", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.line({ t: "drop", ts: "2026-08-28T10:00:00.000Z", reason: "private_window", bundle_id: "com.apple.Safari" });
    expect(sink.events).toHaveLength(0);
    expect(adapter.getStatus().drops["private_window"]).toBe(1);
  });

  it("pause blocks ingestion client-side and sends the command", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    await adapter.pause(true);
    expect(child.writes.some((w) => w.includes('"pause"'))).toBe(true);
    child.line(snapshot());
    expect(sink.events).toHaveLength(0);
    expect(adapter.getStatus().state).toBe("paused");

    await adapter.pause(false);
    child.line(snapshot({ content_hash: "ch-2", text: "later", new_chars: "later" }));
    expect(sink.events).toHaveLength(1);
  });

  it("per-app pause blocks that app only", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    await adapter.pauseApp("com.apple.Mail", true);
    expect(child.writes.some((w) => w.includes("pause_app") && w.includes("com.apple.Mail"))).toBe(true);
    child.line(snapshot({ bundle_id: "com.apple.Mail", stream_key: "com.apple.Mail¦inbox", doc_key: "inbox", text: "mail text", new_chars: "mail text", content_hash: "m1" }));
    child.line(snapshot()); // TextEdit still flows
    expect(sink.events).toHaveLength(1);
    expect((sink.events[0]!.payload as ScreenSnapshotPayload).bundle_id).toBe("com.apple.TextEdit");
    expect(adapter.getStatus().drops["app_paused"]).toBe(1);
    expect(adapter.getStatus().pausedApps).toEqual(["com.apple.mail"]);
  });

  it("surfaces need_permission for the onboarding screen", async () => {
    const { adapter, child } = harness();
    await adapter.connect();
    child.line({ t: "ready", mock: "false" });
    child.line({ t: "status", state: "need_permission" });
    const s = adapter.getStatus();
    expect(s.state).toBe("need_permission");
    expect(s.permission).toBe(false);
    child.line({ t: "status", state: "capturing" });
    expect(adapter.getStatus().permission).toBe(true);
  });

  it("queues commands before ready and flushes on ready (incl. pause re-install)", async () => {
    const { adapter, child } = harness();
    await adapter.connect();
    await adapter.pause(true); // before ready → queued
    expect(child.writes).toHaveLength(0);
    child.ready();
    expect(child.writes.some((w) => w.includes('"pause"'))).toBe(true);
  });

  it("disconnect sends shutdown and reaps the child", async () => {
    const { adapter, child } = harness();
    await adapter.connect();
    child.ready();
    await adapter.disconnect();
    expect(child.writes.some((w) => w.includes("shutdown"))).toBe(true);
    expect(child.killed).toBe("SIGTERM");
  });

  it("schedules a restart after a crash", async () => {
    const children: FakeChild[] = [];
    const spawn: SpawnFn = () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    };
    const sink = new MemoryScreenSink();
    const adapter = new ScreenAdapter({
      spawn,
      sink,
      autoRestart: true,
      backoffBaseMs: 5,
      backoffMaxMs: 10,
    });
    await adapter.connect();
    children[0]!.ready();
    children[0]!.emit("exit", 1, null);
    expect(adapter.getStatus().state).toBe("reconnecting");
    await new Promise((r) => setTimeout(r, 30));
    expect(children.length).toBe(2);
    children[1]!.ready();
    children[1]!.line(snapshot());
    expect(sink.events).toHaveLength(1);
    await adapter.disconnect();
  });

  it("malformed lines and unknown frame types are ignored", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.stdout.emit("data", "not json\n{\"t\":\"future_frame\",\"x\":1}\n");
    child.line(snapshot());
    expect(sink.events).toHaveLength(1);
    expect(adapter.getStatus().state).toBe("capturing");
  });
});

describe("ScreenAdapter — stream keys (V6 S3.4: screen:<bundleId>:<session> · doc:<path>)", () => {
  const web = (ts: string, over: Partial<SnapshotFrame> = {}) =>
    snapshot({
      ts,
      bundle_id: "com.google.Chrome",
      app_name: "Chrome",
      window_title: "Roadmap",
      doc_key: "https://docs.example.com/roadmap",
      stream_key: "com.google.Chrome¦https://docs.example.com/roadmap",
      text: `page ${ts}`,
      new_chars: `page ${ts}`,
      content_hash: `web-${ts}`,
      ...over,
    });

  it("a web page is an app session keyed by the first frame; frames inside the idle gap share it", async () => {
    const { adapter, child, sink } = harness({ sessionSeed: () => [] });
    await adapter.connect();
    child.ready();
    child.line(web("2026-08-28T10:00:00.000Z"));
    child.line(web("2026-08-28T10:20:00.000Z", { doc_key: "https://issues.example.com/42", stream_key: "com.google.Chrome¦https://issues.example.com/42" }));
    child.line(web("2026-08-28T10:49:00.000Z"));
    // 31 minutes idle → a new session.
    child.line(web("2026-08-28T11:20:00.000Z"));
    const keys = sink.events.map((e) => e.streamKey);
    expect(keys[0]).toBe("screen:com.google.Chrome:20260828T100000Z");
    expect(keys[1]).toBe(keys[0]); // another tab, same app session
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).toBe("screen:com.google.Chrome:20260828T112000Z");
  });

  it("sessions are per app; a file open in the same app is its own doc stream", async () => {
    const { adapter, child, sink } = harness({ sessionSeed: () => [] });
    await adapter.connect();
    child.ready();
    child.line(web("2026-08-28T10:00:00.000Z"));
    child.line(snapshot({ ts: "2026-08-28T10:01:00.000Z", bundle_id: "com.apple.Mail", stream_key: "com.apple.Mail¦inbox", doc_key: "inbox", text: "mail", new_chars: "mail", content_hash: "m1" }));
    child.line(snapshot({ ts: "2026-08-28T10:02:00.000Z", doc_key: "file:///Users/u/Plan%20A.md", stream_key: "com.apple.TextEdit¦file:///Users/u/Plan%20A.md", text: "plan", new_chars: "plan", content_hash: "p1" }));
    expect(sink.events.map((e) => e.streamKey)).toEqual([
      "screen:com.google.Chrome:20260828T100000Z",
      "screen:com.apple.Mail:20260828T100100Z",
      "doc:/Users/u/Plan A.md",
    ]);
  });

  it("a restart resumes the session still open on disk instead of splitting it", async () => {
    const { adapter, child, sink } = harness({
      sessionSeed: () => [{ bundleId: "com.google.Chrome", session: "20260828T093000Z", lastTsMs: Date.parse("2026-08-28T09:50:00.000Z") }],
    });
    await adapter.connect();
    child.ready();
    child.line(web("2026-08-28T10:00:00.000Z")); // 10 min after the last frame on disk
    child.line(web("2026-08-28T10:45:00.000Z")); // 45 min later → closed, new session
    expect(sink.events.map((e) => e.streamKey)).toEqual([
      "screen:com.google.Chrome:20260828T093000Z",
      "screen:com.google.Chrome:20260828T104500Z",
    ]);
  });

  it("a seed that throws (no events table) leaves the adapter running with fresh sessions", async () => {
    const lines: string[] = [];
    const { adapter, child, sink } = harness({
      log: (l) => lines.push(l),
      sessionSeed: () => {
        throw new Error("no such table: events");
      },
    });
    await adapter.connect();
    child.ready();
    child.line(web("2026-08-28T10:00:00.000Z"));
    expect(sink.events[0]!.streamKey).toBe("screen:com.google.Chrome:20260828T100000Z");
    expect(lines.some((l) => l.includes("session seed unavailable"))).toBe(true);
  });
});

describe("EventEnvelope integrity", () => {
  it("payload text is the diff, char_count the full length", async () => {
    const { adapter, child, sink } = harness();
    await adapter.connect();
    child.ready();
    child.line(snapshot({
      text: "meeting notes\nagenda: budget\naction: email finance",
      new_chars: "\naction: email finance",
      char_count: 50,
      content_hash: "ch-diff",
      trigger: "typing_pause",
    }));
    const e: EventEnvelope = sink.events[0]!;
    const p = e.payload as ScreenSnapshotPayload;
    expect(p.text).toBe("\naction: email finance");
    expect(p.char_count).toBe(50);
    expect(p.trigger).toBe("typing_pause");
    expect(e.ageBand).toBeDefined();
  });
});

// ---- V6 S1.6: pause persisted in app_state and seeded at boot (T4-8) --------

describe("ScreenAdapter — persisted pause (V6 S1.6 / T4-8)", () => {
  it("pause() writes app_state before the sidecar command; a fresh adapter seeds from it", async () => {
    const { adapter, child, state } = harness();
    await adapter.connect();
    child.ready();
    await adapter.pause(true);
    expect(state.get(SCREEN_PAUSED_KEY)).toBe("1");
    expect(child.writes.some((w) => w.includes('"cmd":"pause"'))).toBe(true);

    await adapter.pauseApp("com.apple.Mail", true);
    expect(JSON.parse(state.get(SCREEN_PAUSED_APPS_KEY) ?? "[]")).toEqual(["com.apple.mail"]);

    // The worker restarts: a NEW adapter over the same app_state starts paused,
    // before any spawn, and re-installs both switches in the new sidecar.
    const again = harness({ pauseState: state });
    expect(again.adapter.getStatus().paused).toBe(true);
    expect(again.adapter.getStatus().state).toBe("paused");
    expect(again.adapter.getStatus().pausedApps).toEqual(["com.apple.mail"]);
    await again.adapter.connect();
    again.child.ready();
    expect(again.child.writes.some((w) => w.includes('"cmd":"pause"'))).toBe(true);
    expect(again.child.writes.some((w) => w.includes('"cmd":"pause_app"') && w.includes("com.apple.mail"))).toBe(true);

    // And it ingests nothing while seeded-paused, even if the sidecar emits.
    again.child.line(snapshot());
    expect(again.sink.events).toHaveLength(0);
    expect(again.adapter.getStatus().drops.paused).toBe(1);

    // Resume clears the persisted switch; per-app resume clears the list.
    await again.adapter.pause(false);
    await again.adapter.pauseApp("com.apple.Mail", false);
    expect(state.get(SCREEN_PAUSED_KEY)).toBe("0");
    expect(JSON.parse(state.get(SCREEN_PAUSED_APPS_KEY) ?? "[]")).toEqual([]);
    const third = harness({ pauseState: state });
    expect(third.adapter.getStatus().paused).toBe(false);
    expect(third.adapter.getStatus().pausedApps).toEqual([]);
  });

  it("a pause store that throws never blocks the adapter (starts unpaused, logs once)", async () => {
    const lines: string[] = [];
    const broken: ScreenPauseState = {
      get: () => {
        throw new Error("no such table: app_state");
      },
      set: () => {
        throw new Error("no such table: app_state");
      },
    };
    const { adapter, child, sink } = harness({ pauseState: broken, log: (l) => lines.push(l) });
    expect(adapter.getStatus().paused).toBe(false);
    await adapter.connect();
    child.ready();
    await adapter.pause(true);
    await adapter.pause(false);
    child.line(snapshot());
    expect(sink.events).toHaveLength(1);
    expect(lines.filter((l) => l.includes("pause state not persisted"))).toHaveLength(1);
  });
});

// ---- V6 S1.6: full text persisted as anchor + diff (T6-8 / T5-4) ------------

describe("ScreenAdapter — full text into blobs (V6 S1.6)", () => {
  it("first capture of a stream is the anchor; the next is a diff whose anchor ref resolves", async () => {
    const { adapter, child, sink, blobs } = harness();
    await adapter.connect();
    child.ready();
    const full1 = "meeting notes\nagenda: budget";
    const full2 = "meeting notes\nagenda: budget\naction: email finance";
    child.line(snapshot({ text: full1, new_chars: full1 }));
    child.line(
      snapshot({
        ts: "2026-08-28T10:00:40.000Z",
        text: full2,
        new_chars: "\naction: email finance",
        content_hash: "ch-2",
      }),
    );
    expect(sink.events).toHaveLength(2);
    const [a, d] = sink.events as [EventEnvelope, EventEnvelope];
    const pa = a.payload as ScreenSnapshotPayload;
    const pd = d.payload as ScreenSnapshotPayload;
    expect(pa.storage).toBe("anchor");
    expect(a.blobRefs).toEqual([pa.text_ref]);
    expect(blobs.text(pa.text_ref!)).toBe(full1);
    expect(pd.storage).toBe("diff");
    expect(pd.anchor_ref).toBe(pa.text_ref);
    expect(d.blobRefs).toEqual([pd.text_ref, pa.text_ref]);
    // The row still carries only the diff; the blobs give back the whole text.
    expect(pd.text).toBe("\naction: email finance");
    expect(reconstructScreenText(pd, (sha) => blobs.text(sha))).toBe(full2);
    // Identity rides on the envelope (SRC-03 upstream).
    expect(a.identity).toEqual({ app: "TextEdit", windowTitle: "notes.txt", docKey: "/Users/u/notes.txt" });
  });

  it("a blob writer that throws never drops the capture — the event lands without refs", async () => {
    const lines: string[] = [];
    const failing: BlobPut = () => {
      throw new Error("disk full");
    };
    const { adapter, child, sink } = harness({ putBlob: failing, log: (l) => lines.push(l) });
    await adapter.connect();
    child.ready();
    child.line(snapshot());
    expect(sink.events).toHaveLength(1);
    const p = sink.events[0]!.payload as ScreenSnapshotPayload;
    expect(p.storage).toBeUndefined();
    expect(p.text_ref).toBeUndefined();
    expect(sink.events[0]!.blobRefs).toEqual([]);
    expect(p.text).toBe("meeting notes");
    expect(lines.some((l) => l.includes("full-text blob write failed"))).toBe(true);
  });
});

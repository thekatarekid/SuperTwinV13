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

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../db/eventlog.js";
import { ScreenAdapter, type ChildLike, type SpawnFn } from "./adapter.js";
import type { ScreenSnapshotPayload } from "./envelope.js";
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

function harness(): { adapter: ScreenAdapter; child: FakeChild; sink: MemoryScreenSink } {
  const child = new FakeChild();
  const spawn: SpawnFn = () => child;
  const sink = new MemoryScreenSink();
  const adapter = new ScreenAdapter({ spawn, sink, autoRestart: false, mock: true });
  return { adapter, child, sink };
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
    expect(e.streamKey).toBe("com.apple.TextEdit¦/Users/u/notes.txt");
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
    expect(keys).toEqual([
      "com.apple.TextEdit¦/a.txt",
      "com.apple.TextEdit¦/b.txt",
      "com.apple.TextEdit¦/a.txt",
      "com.microsoft.VSCode¦/a.txt",
    ]);
    expect(new Set(keys).size).toBe(3);
    // Same content in different apps = different append identity (stream in hash).
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

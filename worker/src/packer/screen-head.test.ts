// ===========================================================================
// SRC-03 — screen head carries identity (V6 P1 S1.6 / T6-7). Deterministic,
// zero model calls: real appendEvents → real collectTick → real
// packOrientContext, asserting the rendered bundle lines.
//
//   Expected. The packed line contains app, window title and doc key.
//   Wrong.    `identical-heads` — every source renders the same shape.
//
// Also pins the two seams the head depends on: the consumer's envelope now
// carries `source` (it was "" on every envelope — consumer.ts:44), and the
// dispatcher hands each bundle event its `sourceId`.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toScreenEnvelope } from "../adapters/screen/envelope.js";
import type { SnapshotFrame } from "../adapters/screen/frames.js";
import { bundleEventSource } from "../brain/consumer.js";
import { closeDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick, type DeltaBundle } from "../scheduler/dispatch.js";
import { eventIdentityHead, packOrientContext } from "./pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-src03-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T10:00:00.000Z");

function screenFrame(over: Partial<SnapshotFrame> = {}): SnapshotFrame {
  const text = over.text ?? "Roadmap Q3\nship the sidecar";
  return {
    t: "snapshot",
    ts: new Date(T0).toISOString(),
    bundle_id: "com.google.Chrome",
    app_name: "Chrome",
    window_title: "Docs — Roadmap",
    doc_key: "https://docs.example.com/roadmap",
    stream_key: "com.google.Chrome¦https://docs.example.com/roadmap",
    trigger: "tab_switch",
    tree_hash: "th",
    content_hash: "ch-" + text.length,
    char_count: text.length,
    new_chars: text,
    text,
    links: [],
    files: [],
    ...over,
  };
}

function waMessage(i: number, text: string, actor = "contact:rohan"): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "goa-gang@g.us",
    actor,
    roles: { sender: actor, audience: ["self", "ent_rohan"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `x${i}` },
  };
}

function browserVisit(): EventEnvelope {
  return {
    ts: new Date(T0 + 30_000).toISOString(),
    source: "browser",
    kind: "browser.visit",
    origin: "live",
    streamKey: "browser:chrome:default:chain:abc",
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: [], mentions: [] },
    payload: {
      title: "Villa with pool — Airbnb",
      url: "https://www.airbnb.com/rooms/123",
      text: "Villa with pool — Airbnb https://www.airbnb.com/rooms/123",
    },
  };
}

function bundleFor(streamKey: string): DeltaBundle {
  const plan = collectTick(T0 + 3_600_000);
  const bundle = plan.bundles.find((b) => b.streamKey === streamKey);
  if (!bundle) throw new Error(`no bundle for ${streamKey}`);
  return bundle;
}

/** The `[NEW BUNDLE]` block's event lines, without the leading indent. */
function bundleLines(user: string): string[] {
  const i = user.indexOf("[NEW BUNDLE]");
  expect(i).toBeGreaterThanOrEqual(0);
  return user
    .slice(i)
    .split("\n")
    .slice(1)
    .filter((l) => /^\s+e\d+ /.test(l))
    .map((l) => l.trim());
}

describe("SRC-03 — screen head carries identity", () => {
  it("the packed line for a screen snapshot contains app, window title and doc key", async () => {
    appendEvents([toScreenEnvelope(screenFrame(), T0 + 1_000)], T0 + 1_000);
    const bundle = bundleFor("com.google.Chrome¦https://docs.example.com/roadmap");
    expect(bundle.events[0]!.sourceId).toBe("screen");

    const packed = await packOrientContext(bundle, { nowMs: T0 + 3_600_000 });
    const [line] = bundleLines(packed.user);
    expect(line).toBeDefined();
    expect(line).toContain("Chrome");
    expect(line).toContain("Docs — Roadmap");
    expect(line).toContain("https://docs.example.com/roadmap");
    expect(line).toContain("[screen.snapshot]");
    expect(line).toMatch(/^e1 08-28 10:00 self \[screen\.snapshot\] Chrome · Docs — Roadmap · https:\/\/docs\.example\.com\/roadmap: /);
    // The content still follows the head.
    expect(line).toContain("Roadmap Q3");
  });

  it("wrong: identical-heads — a chat message, a browser visit and a screen snapshot render three different head shapes", async () => {
    appendEvents(
      [waMessage(1, "lets lock goa 18-21 dec"), browserVisit(), toScreenEnvelope(screenFrame(), T0 + 1_000)],
      T0 + 1_000,
    );
    const lines = new Map<string, string>();
    for (const key of [
      "goa-gang@g.us",
      "browser:chrome:default:chain:abc",
      "com.google.Chrome¦https://docs.example.com/roadmap",
    ]) {
      const bundle = bundleFor(key);
      const packed = await packOrientContext(bundle, { nowMs: T0 + 3_600_000 });
      const [line] = bundleLines(packed.user);
      lines.set(key, line!);
    }
    const wa = lines.get("goa-gang@g.us")!;
    const br = lines.get("browser:chrome:default:chain:abc")!;
    const sc = lines.get("com.google.Chrome¦https://docs.example.com/roadmap")!;

    // Kind in every head; identity only where the source has one. The chat
    // and screen heads are this task's (S1.6); a browser visit renders
    // through S1.4's visit-run collapse (SRC-10) — asserted by shape, not
    // by exact text, so the two lanes do not pin each other.
    expect(wa.startsWith("e1 08-28 10:01 contact:rohan [wa.message]: ")).toBe(true);
    expect(sc.startsWith("e1 08-28 10:00 self [screen.snapshot] Chrome · Docs — Roadmap · https://docs.example.com/roadmap: ")).toBe(true);
    expect(br).toContain("[browser.visit]");
    expect(br).toContain("Villa with pool — Airbnb");
    expect(br).toContain("https://www.airbnb.com/rooms/123");

    // Three sources, three shapes — strip alias/time/actor and compare what
    // precedes the content.
    const shape = (l: string): string => l.replace(/^e\d+ \S+ \S+ \S+ /, "").split(/: |\n/)[0]!;
    const shapes = new Set([wa, br, sc].map(shape));
    expect(shapes.size).toBe(3);
    expect(shape(wa)).toBe("[wa.message]");
    expect(shape(sc)).toBe("[screen.snapshot] Chrome · Docs — Roadmap · https://docs.example.com/roadmap");
  });

  it("eventIdentityHead: screen → app · title · doc key; browser → title · url; chat → nothing; duplicates said once", () => {
    expect(eventIdentityHead({ app_name: "TextEdit", window_title: "notes.txt", doc_key: "/Users/u/notes.txt" })).toBe(
      "TextEdit · notes.txt · /Users/u/notes.txt",
    );
    expect(eventIdentityHead({ title: "Airbnb", url: "https://a.example/x" })).toBe("Airbnb · https://a.example/x");
    expect(eventIdentityHead({ text: "hi", external_id: "x1" })).toBe("");
    // Untitled window whose doc key fell back to its title: one mention.
    expect(eventIdentityHead({ app_name: "Notes", window_title: "Untitled", doc_key: "Untitled" })).toBe("Notes · Untitled");
    // "" never renders as a stray separator.
    expect(eventIdentityHead({ app_name: "Notes", window_title: "", doc_key: "" })).toBe("Notes");
  });

  it("the consumer's envelope source: the row's sourceId, else the <source>:st:<key> stream id, never \"\" for a real stream", () => {
    const bundle = { streamId: "screen:st:com.google.Chrome¦x", streamKey: "com.google.Chrome¦x" } as DeltaBundle;
    expect(bundleEventSource(bundle, { sourceId: "screen" })).toBe("screen");
    expect(bundleEventSource(bundle, { sourceId: null })).toBe("screen");
    expect(bundleEventSource(bundle, {})).toBe("screen");
    expect(bundleEventSource({ streamId: "wa:st:goa-gang@g.us" } as DeltaBundle, {})).toBe("wa");
    expect(bundleEventSource({ streamId: "legacy-stream-id" } as DeltaBundle, {})).toBe("");
  });
});

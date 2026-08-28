// ===========================================================================
// Mock-fixture e2e (build P2.1): the REAL Swift sidecar in --mock mode,
// driven through the REAL ScreenAdapter into a MemoryScreenSink.
//
// Mirrors whatsapp's mock-e2e pattern: skipped cleanly when the built
// sidecar binary is absent (sources/screenwatch/build.sh produces it; the
// same pipeline coverage runs in the sidecar's own swift tests either way).
//
// Asserts on fixtures/basic.json:
//   - 3 snapshots land (TextEdit ×2 + Chrome), correctly stream-keyed;
//   - the private-window, ax-private, and password-manager captures NEVER
//     land, and their secret strings appear NOWHERE in the sink (hard);
//   - the unchanged heartbeat is suppressed (no fourth event).
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ScreenAdapter } from "./adapter.js";
import type { ScreenSnapshotPayload } from "./envelope.js";
import { MemoryScreenSink } from "./sink.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..", "..", "..");
const BIN = join(REPO, "sources", "screenwatch", "screenwatch");
const FIXTURE = join(REPO, "sources", "screenwatch", "fixtures", "basic.json");

const available = existsSync(BIN) && existsSync(FIXTURE);

let adapter: ScreenAdapter | null = null;

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
});

describe.skipIf(!available)("screenwatch --mock e2e", () => {
  it("replays the fixture through the real sidecar with privacy enforced", async () => {
    const sink = new MemoryScreenSink();
    adapter = new ScreenAdapter({
      binPath: BIN,
      mock: true,
      fixturePath: FIXTURE,
      sink,
      autoRestart: false,
    });

    const done = new Promise<void>((resolveDone, reject) => {
      const t = setTimeout(() => reject(new Error("fixture_done not observed")), 10_000);
      adapter!.onStatus((s) => {
        // fixture_done maps to `capturing`; wait until all 3 snapshots landed.
        if (s.snapshots >= 3) {
          clearTimeout(t);
          resolveDone();
        }
      });
    });

    await adapter.connect();
    await done;

    expect(sink.events).toHaveLength(3);
    const keys = sink.events.map((e) => e.streamKey);
    expect(keys).toEqual([
      "com.apple.TextEdit¦/Users/u/notes.txt",
      "com.google.Chrome¦https://docs.example.com/roadmap",
      "com.apple.TextEdit¦/Users/u/notes.txt",
    ]);

    // Diff on the second TextEdit snapshot, not the full text again.
    const third = sink.events[2]!.payload as ScreenSnapshotPayload;
    expect(third.text).toBe("\naction: email finance");
    expect(third.trigger).toBe("typing_pause");

    // Reference enrichment marked pending.
    const chrome = sink.events[1]!.payload as ScreenSnapshotPayload;
    expect(chrome.links.every((l) => l.content_pending)).toBe(true);
    expect(chrome.links.map((l) => l.ref)).toContain("https://issues.example.com/42");

    // HARD privacy: no fixture secret anywhere in what landed.
    const all = JSON.stringify(sink.events);
    expect(all).not.toContain("SECRET-INCOGNITO-CONTENT");
    expect(all).not.toContain("SECRET-VAULT-PASSWORD");
    expect(all).not.toContain("SECRET-PRIVATE-SAFARI");
    expect(all).not.toContain("com.1password");
  }, 15_000);
});

// Keep vitest happy when the binary is absent (suite must not be empty).
describe("screenwatch mock availability", () => {
  it("declares whether the built sidecar is present", () => {
    expect(typeof available).toBe("boolean");
  });
});

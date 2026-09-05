// ===========================================================================
// The data filter at capture (V6 P1 S1.7, Build §4.2 [D]; Product_V6_Phase1
// §Sources 2–3): never-list → user lists → pause states, enforced at BOTH
// single-writer funnels, deterministic, zero model calls.
//
// A drop is a drop: no events row, no archive row, nothing for FTS. The lists
// are the four Capture & Privacy lists; the pause states are the private
// moment and the panel quick-pause — the latter being the exact key the V13
// tray wrote and only the assist watcher read (`pauses-nudges-only`, CNS-05).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appMatches,
  capturePauseState,
  domainMatches,
  endPrivateMoment,
  filterCapture,
  invalidateCaptureFilterCache,
  neverListVerdict,
  PRIVATE_MOMENT_MINUTES,
  privateMomentUntil,
  readCaptureList,
  readCaptureLists,
  setCaptureList,
  startPrivateMoment,
  userListVerdict,
} from "./capture-filter.js";
import { closeDb, getDb, runMigrations } from "./connection.js";
import { setConsentGateMode, type ConsentGateMode } from "./consent-gate.js";
import { appendEvents, type EventEnvelope } from "./eventlog.js";
import { appStateSet, insertEvent, upsertActor, upsertSource, upsertStream } from "./ingest.js";
import { archiveCount, grantConsent } from "./v6core.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

let tmpDir: string;
let prevMode: ConsentGateMode;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-filter-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  invalidateCaptureFilterCache();
  prevMode = setConsentGateMode("enforce");
  for (const source of ["whatsapp", "browser", "screen"]) {
    grantConsent({ source, indexAll: true, understandFrom: "2026-01-01T00:00:00.000Z" });
  }
});

afterEach(() => {
  setConsentGateMode(prevMode);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const SELF = { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] };

function screenEnv(payload: Record<string, unknown>, over: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    ts: NOW_ISO,
    capturedAt: NOW_ISO,
    source: "screen",
    kind: "screen.snapshot",
    origin: "live",
    streamKey: `screen:${String(payload.bundle_id ?? "app")}`,
    actor: "self",
    roles: SELF,
    payload: { text: "hello", ...payload },
    ...over,
  };
}

function browserEnv(url: string, over: Partial<EventEnvelope> = {}): EventEnvelope {
  const domain = new URL(url).hostname;
  return {
    ts: NOW_ISO,
    capturedAt: NOW_ISO,
    source: "browser",
    kind: "browser.visit",
    origin: "live",
    streamKey: `${domain}:2026-09-01`,
    actor: "self",
    roles: SELF,
    payload: { text: `page ${url}`, url, domain, title: "page", browser: "chrome" },
    ...over,
  };
}

function waEnv(streamKey: string, actor: string, text: string): EventEnvelope {
  return {
    ts: NOW_ISO,
    capturedAt: NOW_ISO,
    source: "whatsapp",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor,
    roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  };
}

function eventCount(source?: string): number {
  const db = getDb();
  const r = source
    ? (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source_id = ?`).get(source) as { n: number })
    : (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number });
  return r.n;
}

// ---- never-list ----------------------------------------------------------------

describe("never-list (fixed, not a setting)", () => {
  it("drops password-manager windows by bundle prefix — the sidecar's list, mirrored", () => {
    expect(
      neverListVerdict({
        source: "screen",
        streamKey: "s",
        actor: "self",
        payload: { bundle_id: "com.1password.1password-launcher", text: "hunter2" },
      }),
    ).toMatchObject({ dropped: true, reason: "never:password-manager" });
    const r = appendEvents([screenEnv({ bundle_id: "com.bitwarden.desktop", text: "vault" })], NOW);
    expect(r.inserted).toBe(0);
    expect(r.ids).toEqual([""]);
    expect(eventCount()).toBe(0);
    expect(archiveCount()).toBe(0); // not in the archive either
  });

  it("drops private / incognito windows — AX flag, or title marker in a browser", () => {
    expect(
      neverListVerdict({
        source: "screen",
        streamKey: "s",
        actor: "self",
        payload: { bundle_id: "com.google.chrome", window_title: "gifts - Google Search (Incognito)" },
      }),
    ).toMatchObject({ reason: "never:private-window" });
    expect(
      neverListVerdict({
        source: "screen",
        streamKey: "s",
        actor: "self",
        payload: { bundle_id: "com.apple.notes", ax_private: true },
      }),
    ).toMatchObject({ reason: "never:private-window" });
    // The title heuristic is browsers-only: a Notes doc that mentions incognito is fine.
    expect(
      neverListVerdict({
        source: "screen",
        streamKey: "s",
        actor: "self",
        payload: { bundle_id: "com.apple.notes", window_title: "how (incognito) works" },
      }),
    ).toBeNull();
  });

  it("drops secure text fields by role and WhatsApp status updates by stream", () => {
    expect(
      neverListVerdict({
        source: "screen",
        streamKey: "s",
        actor: "self",
        payload: { bundle_id: "com.apple.safari", roles: ["AXStaticText", "AXSecureTextField"] },
      }),
    ).toMatchObject({ reason: "never:secure-field" });
    const r = appendEvents([waEnv("status@broadcast", "contact:x", "my status")], NOW);
    expect(r.inserted).toBe(0);
    // Legacy funnel too: stream id carries the source prefix.
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const st = upsertStream({ sourceId: "whatsapp", sourceExtId: "status@broadcast", name: "status", kind: "status" });
    const ac = upsertActor({ sourceId: "whatsapp", sourceExtId: "x@s.whatsapp.net", displayName: "X" });
    const res = insertEvent({
      externalId: "s1",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: st,
      actorId: ac,
      ts: NOW_ISO,
      kind: "message",
      text: "status text",
      mediaPath: null,
      rawJson: null,
    });
    expect(res.inserted).toBe(false);
    expect(eventCount()).toBe(0);
  });
});

// ---- user lists -----------------------------------------------------------------

describe("user lists (apps · sites · chats · senders) at the funnel", () => {
  it("apps: bundle id, app name, or a bundle prefix ending in '.'", () => {
    expect(appMatches("com.apple.notes", "Notes", "notes")).toBe(true);
    expect(appMatches("com.apple.notes", "Notes", "com.apple.notes")).toBe(true);
    expect(appMatches("com.apple.notes", "Notes", "com.apple.")).toBe(true);
    expect(appMatches("com.apple.notes", "Notes", "com.apple")).toBe(false);
    setCaptureList("apps", ["Banking App", "com.hdfc."]);
    expect(readCaptureList("apps")).toEqual(["Banking App", "com.hdfc."]);
    const r = appendEvents(
      [
        screenEnv({ bundle_id: "com.hdfc.netbanking", app_name: "HDFC", text: "balance" }),
        screenEnv({ bundle_id: "in.bank.other", app_name: "banking app", text: "balance" }),
        screenEnv({ bundle_id: "com.apple.notes", app_name: "Notes", text: "todo" }),
      ],
      NOW,
    );
    expect(r.inserted).toBe(1);
    expect(r.ids[0]).toBe("");
    expect(r.ids[1]).toBe("");
    expect(r.ids[2]).not.toBe("");
  });

  it("sites: domain suffix match over payload.domain / url / doc_key", () => {
    expect(domainMatches("a.bank.example.com", "bank.example.com")).toBe(true);
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("notexample.com", "example.com")).toBe(false);
    expect(domainMatches("www.bank.example.com", "https://bank.example.com/login")).toBe(true);
    setCaptureList("sites", ["bank.example.com"]);
    const r = appendEvents(
      [
        browserEnv("https://online.bank.example.com/accounts"),
        browserEnv("https://news.example.com/story"),
        // A screen capture of the bank tab: doc_key is the URL.
        screenEnv({ bundle_id: "com.apple.safari", doc_key: "https://bank.example.com/x", text: "acct" }),
      ],
      NOW,
    );
    expect(r.ids.map((id) => id !== "")).toEqual([false, true, false]);
    expect(eventCount("browser")).toBe(1);
    expect(eventCount("screen")).toBe(0);
  });

  it("chats and senders: WhatsApp stream keys and actor keys, both funnels", () => {
    setCaptureList("chats", ["family@g.us"]);
    setCaptureList("senders", ["rohan"]);
    const r = appendEvents(
      [
        waEnv("family@g.us", "contact:mum", "dinner?"),
        waEnv("goa@g.us", "contact:rohan", "villa"),
        waEnv("goa@g.us", "contact:sam", "villa yes"),
      ],
      NOW,
    );
    expect(r.ids.map((id) => id !== "")).toEqual([false, false, true]);

    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const fam = upsertStream({ sourceId: "whatsapp", sourceExtId: "family@g.us", name: "Family", kind: "group" });
    const goa = upsertStream({ sourceId: "whatsapp", sourceExtId: "goa@g.us", name: "Goa", kind: "group" });
    const rohan = upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
    const sam = upsertActor({ sourceId: "whatsapp", sourceExtId: "sam", displayName: "Sam" });
    const row = (ext: string, st: string, ac: string) => ({
      externalId: ext,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: st,
      actorId: ac,
      ts: NOW_ISO,
      kind: "message",
      text: ext,
      mediaPath: null,
      rawJson: null,
    });
    expect(insertEvent(row("m1", fam, sam)).inserted).toBe(false); // chat listed
    expect(insertEvent(row("m2", goa, rohan)).inserted).toBe(false); // sender listed
    expect(insertEvent(row("m3", goa, sam)).inserted).toBe(true);
  });

  it("lists round-trip, dedupe and trim; the cache follows the write", () => {
    expect(readCaptureLists()).toEqual({ apps: [], sites: [], chats: [], senders: [] });
    setCaptureList("sites", [" x.com ", "x.com", "", 42 as unknown as string]);
    expect(readCaptureList("sites")).toEqual(["x.com"]);
    // A direct app_state write is seen after an explicit invalidation.
    appStateSet("capture.domain_blocklist", JSON.stringify(["y.com"]));
    expect(readCaptureList("sites")).toEqual(["x.com"]);
    invalidateCaptureFilterCache();
    expect(readCaptureList("sites")).toEqual(["y.com"]);
    expect(
      userListVerdict(
        { source: "browser", streamKey: "s", actor: "self", payload: { url: "https://a.y.com/" } },
        readCaptureLists(),
      ),
    ).toMatchObject({ reason: "list:site", match: "y.com" });
  });
});

// ---- pause states -----------------------------------------------------------------

describe("pause states: private moment and the quick-pause key", () => {
  it("a private moment is fifteen minutes and drops every source at the funnel", () => {
    expect(PRIVATE_MOMENT_MINUTES).toBe(15);
    const until = startPrivateMoment(undefined, NOW);
    expect(until).toBe(new Date(NOW + 15 * 60_000).toISOString());
    expect(privateMomentUntil(NOW)).toBe(until);
    const during = appendEvents(
      [waEnv("goa@g.us", "contact:sam", "x"), browserEnv("https://news.example.com/"), screenEnv({ bundle_id: "com.apple.notes" })],
      NOW + 60_000,
    );
    expect(during.inserted).toBe(0);
    expect(during.ids).toEqual(["", "", ""]);
    expect(eventCount()).toBe(0);
    // The deadline passes on its own; nothing to clear.
    expect(privateMomentUntil(NOW + 16 * 60_000)).toBeNull();
    const after = appendEvents([waEnv("goa@g.us", "contact:sam", "y")], NOW + 16 * 60_000);
    expect(after.inserted).toBe(1);
    // …and can be ended early.
    startPrivateMoment(15, NOW);
    endPrivateMoment();
    expect(capturePauseState(NOW)).toEqual({ paused: false, privateUntil: null, quickPauseUntil: null });
  });

  it("the panel quick-pause key (capture.paused_until) now stops CAPTURE, not just nudges", () => {
    // The V13 defect: assist/settings wrote this key and only the assist
    // watcher read it. The funnel reads it too now. (Wall clock here: the
    // legacy funnel has no injectable clock.)
    const wall = Date.now();
    appStateSet("capture.paused_until", new Date(wall + 30 * 60_000).toISOString());
    expect(capturePauseState(wall)).toMatchObject({ paused: true, privateUntil: null });
    expect(
      filterCapture({ source: "browser", streamKey: "s", actor: "self", payload: { url: "https://x.com/" } }, wall),
    ).toEqual({ dropped: true, reason: "pause:quick-pause" });
    const r = appendEvents([browserEnv("https://x.com/")], wall);
    expect(r.inserted).toBe(0);
    // Legacy funnel too.
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const st = upsertStream({ sourceId: "whatsapp", sourceExtId: "goa@g.us", name: "Goa", kind: "group" });
    expect(
      insertEvent({
        externalId: "m9",
        sourceId: "whatsapp",
        sourceType: "whatsapp",
        streamId: st,
        actorId: null,
        ts: NOW_ISO,
        kind: "message",
        text: "hi",
        mediaPath: null,
        rawJson: null,
      }).inserted,
    ).toBe(false);
    expect(eventCount()).toBe(0);
  });

  it("order is never-list → lists → pause: the reason names the first rule that fired", () => {
    setCaptureList("apps", ["Notes"]);
    startPrivateMoment(15, NOW);
    expect(
      filterCapture(
        { source: "screen", streamKey: "s", actor: "self", payload: { bundle_id: "com.1password.app", app_name: "Notes" } },
        NOW,
      ),
    ).toMatchObject({ reason: "never:password-manager" });
    expect(
      filterCapture({ source: "screen", streamKey: "s", actor: "self", payload: { bundle_id: "com.apple.notes", app_name: "Notes" } }, NOW),
    ).toMatchObject({ reason: "list:app" });
    expect(
      filterCapture({ source: "screen", streamKey: "s", actor: "self", payload: { bundle_id: "com.apple.mail", app_name: "Mail" } }, NOW),
    ).toMatchObject({ reason: "pause:private-moment" });
    endPrivateMoment();
    expect(
      filterCapture({ source: "screen", streamKey: "s", actor: "self", payload: { bundle_id: "com.apple.mail", app_name: "Mail" } }, NOW),
    ).toBeNull();
  });
});

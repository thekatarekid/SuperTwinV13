// Stream keys (V6 P1 S3.4): the four shapes, their parsers, and the screen
// session tracker. Pure code — no DB, no model.
import { describe, expect, it } from "vitest";

import {
  browserStreamKey,
  docPathOf,
  docStreamKey,
  normaliseProfile,
  parseStreamKey,
  SCREEN_SESSION_GAP_MS,
  ScreenSessionTracker,
  screenStreamKey,
  sessionIdOf,
  sessionStartMs,
  utcDayOf,
  waStreamKey,
} from "./stream-keys.js";

const T0 = Date.parse("2026-09-06T12:00:00Z");
const MIN = 60_000;

describe("stream key builders", () => {
  it("wa:<jid>", () => {
    expect(waStreamKey("9198xx-1602@g.us")).toBe("wa:9198xx-1602@g.us");
    expect(waStreamKey("rohan@s.whatsapp.net")).toBe("wa:rohan@s.whatsapp.net");
  });

  it("browser:<browser>:<profile>:<domain>:<day>", () => {
    expect(browserStreamKey("chrome", "Default", "goibibo.com", "2026-09-06")).toBe(
      "browser:chrome:default:goibibo.com:2026-09-06",
    );
    expect(browserStreamKey("safari", undefined, "airbnb.com", "2026-09-06")).toBe(
      "browser:safari:default:airbnb.com:2026-09-06",
    );
    expect(browserStreamKey("brave", "Profile 2", "", "2026-09-06")).toBe("browser:brave:profile-2:unknown:2026-09-06");
  });

  it("screen:<bundleId>:<session> and doc:<path>", () => {
    expect(screenStreamKey("com.google.Chrome", "20260906T120000Z")).toBe("screen:com.google.Chrome:20260906T120000Z");
    expect(docStreamKey("/Users/u/notes.txt")).toBe("doc:/Users/u/notes.txt");
  });

  it("profile normalisation: case, whitespace, colons, empty", () => {
    expect(normaliseProfile("Default")).toBe("default");
    expect(normaliseProfile("Profile 1")).toBe("profile-1");
    expect(normaliseProfile("Work: Personal")).toBe("work--personal");
    expect(normaliseProfile("")).toBe("default");
    expect(normaliseProfile(undefined)).toBe("default");
  });

  it("utcDayOf is the ISO date (same convention as the day-bundler)", () => {
    expect(utcDayOf(Date.parse("2026-09-06T23:59:59Z"))).toBe("2026-09-06");
    expect(utcDayOf(Date.parse("2026-09-07T00:00:00Z"))).toBe("2026-09-07");
  });

  it("session ids are compact UTC timestamps that round-trip", () => {
    expect(sessionIdOf(T0)).toBe("20260906T120000Z");
    expect(sessionStartMs("20260906T120000Z")).toBe(T0);
    expect(sessionStartMs("nope")).toBeNaN();
  });
});

describe("docPathOf — which screen frames are documents", () => {
  it("absolute paths and file URLs are documents", () => {
    expect(docPathOf("/Users/u/notes.txt")).toBe("/Users/u/notes.txt");
    expect(docPathOf("file:///Users/u/My%20Doc.md")).toBe("/Users/u/My Doc.md");
  });
  it("web URLs, titles and empty keys are not", () => {
    expect(docPathOf("https://docs.example.com/roadmap")).toBeNull();
    expect(docPathOf("inbox")).toBeNull();
    expect(docPathOf("Untitled 3")).toBeNull();
    expect(docPathOf("")).toBeNull();
    expect(docPathOf("/")).toBeNull();
    expect(docPathOf(undefined)).toBeNull();
  });
});

describe("parseStreamKey", () => {
  it("round-trips every builder", () => {
    expect(parseStreamKey(waStreamKey("g@g.us"))).toEqual({ kind: "wa", jid: "g@g.us" });
    expect(parseStreamKey(browserStreamKey("chrome", "Default", "a.example", "2026-09-06"))).toEqual({
      kind: "browser",
      browser: "chrome",
      profile: "default",
      domain: "a.example",
      day: "2026-09-06",
    });
    expect(parseStreamKey(screenStreamKey("com.apple.Mail", "20260906T120000Z"))).toEqual({
      kind: "screen",
      bundleId: "com.apple.Mail",
      session: "20260906T120000Z",
    });
    // A doc path may itself contain colons.
    expect(parseStreamKey(docStreamKey("/Volumes/x:y/a.txt"))).toEqual({ kind: "doc", path: "/Volumes/x:y/a.txt" });
  });
  it("rejects legacy and malformed keys", () => {
    expect(parseStreamKey("bar:thread-1")).toBeNull();
    expect(parseStreamKey("browser:chrome:bookmarks")).toBeNull();
    expect(parseStreamKey("browser:chrome:chain:abcd")).toBeNull();
    expect(parseStreamKey("com.apple.TextEdit¦/a.txt")).toBeNull();
    expect(parseStreamKey("screen:com.apple.Mail")).toBeNull();
    expect(parseStreamKey("screen:com.apple.Mail:")).toBeNull();
    expect(parseStreamKey("wa:")).toBeNull();
    expect(parseStreamKey("doc:")).toBeNull();
  });
});

describe("ScreenSessionTracker — bundleId + 30-min idle gap", () => {
  it("frames inside the gap share a session; the gap opens a new one", () => {
    const t = new ScreenSessionTracker();
    const s1 = t.sessionFor("com.apple.Mail", T0);
    expect(s1).toBe("20260906T120000Z");
    expect(t.sessionFor("com.apple.Mail", T0 + 29 * MIN)).toBe(s1);
    expect(t.sessionFor("com.apple.Mail", T0 + 29 * MIN + SCREEN_SESSION_GAP_MS)).toBe(s1); // exactly the gap from the last frame
    const s2 = t.sessionFor("com.apple.Mail", T0 + 29 * MIN + 2 * SCREEN_SESSION_GAP_MS + 1);
    expect(s2).not.toBe(s1);
    expect(s2).toBe(sessionIdOf(T0 + 29 * MIN + 2 * SCREEN_SESSION_GAP_MS + 1));
  });

  it("sessions are per app", () => {
    const t = new ScreenSessionTracker();
    const mail = t.sessionFor("com.apple.Mail", T0);
    const chrome = t.sessionFor("com.google.Chrome", T0 + MIN);
    expect(mail).not.toBe(chrome);
    expect(t.sessionFor("com.apple.Mail", T0 + 2 * MIN)).toBe(mail);
    expect(t.openSessions().map((s) => s.bundleId).sort()).toEqual(["com.apple.Mail", "com.google.Chrome"]);
  });

  it("a slightly out-of-order older frame stays in the open session", () => {
    const t = new ScreenSessionTracker();
    const s = t.sessionFor("app", T0 + 5 * MIN);
    expect(t.sessionFor("app", T0 + 4 * MIN)).toBe(s);
  });

  it("seeding resumes the on-disk session across a restart; a newer seed wins", () => {
    const before = new ScreenSessionTracker();
    const s = before.sessionFor("app", T0);
    before.sessionFor("app", T0 + 10 * MIN);

    const after = new ScreenSessionTracker();
    after.seed({ bundleId: "app", session: "20260906T090000Z", lastTsMs: T0 - 3 * 60 * MIN }); // stale
    for (const open of before.openSessions()) after.seed(open);
    expect(after.sessionFor("app", T0 + 20 * MIN)).toBe(s);
    // Past the gap even the resumed session closes.
    expect(after.sessionFor("app", T0 + 20 * MIN + SCREEN_SESSION_GAP_MS + 1)).not.toBe(s);
  });

  it("forget drops the open session", () => {
    const t = new ScreenSessionTracker();
    const s = t.sessionFor("app", T0);
    t.forget("app");
    expect(t.sessionFor("app", T0 + MIN)).not.toBe(s);
  });
});

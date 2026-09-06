// ===========================================================================
// The browser scoped-import contract and the deferred first poll (V6 P1 S6d
// L5; user issue 5). Real Chromium/Safari history fixtures, an in-memory sink,
// zero model calls, no worker boot.
//
//   * only the profiles the consent row names are read — the pick the connect
//     card collects is the whole of what is imported;
//   * only the chosen INDEX window is read — a 30-day pick never reaches a
//     year-old visit;
//   * the first poll is a macrotask, so the caller that started the watcher
//     (POST …/connect) answers BEFORE the history import runs. That await
//     ordering is the whole reason "Connect" looked dead;
//   * the import ledger the panel polls reports per profile: pending →
//     reading → done, with what was read and what was expected.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  MemorySink,
  getBrowserImportProgress,
  profilesForConsent,
  resetBrowserImportProgress,
  startBrowserWatcher,
} from "./index.js";
import { discoverProfiles } from "./watcher.js";
import { setHistoryScratchDir } from "./history-db.js";
import { makeChromeHistory, makeSafariHistory, tmpDir } from "./test-fixtures.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 86_400_000;

let home: string;
let chromePath: string;
let bravePath: string;

/** One turn of the macrotask queue — where the deferred first poll lives. */
const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  home = tmpDir();
  setHistoryScratchDir(tmpDir());
  const chrome = join(home, "Library/Application Support/Google/Chrome/Default");
  const brave = join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default");
  for (const d of [chrome, brave]) mkdirSync(d, { recursive: true });
  chromePath = makeChromeHistory(chrome, [
    { url: "https://recent.example/", title: "recent", tsMs: NOW - 2 * DAY },
    { url: "https://old.example/", title: "old", tsMs: NOW - 200 * DAY },
  ]);
  bravePath = makeChromeHistory(brave, [{ url: "https://brave.example/", title: "brave", tsMs: NOW - DAY }]);
  resetBrowserImportProgress();
});

afterEach(() => {
  resetBrowserImportProgress();
  setHistoryScratchDir(null);
  rmSync(home, { recursive: true, force: true });
});

describe("profilesForConsent — the pick IS the scope", () => {
  it("reads only the profiles the consent row names; an empty scope means every profile", () => {
    const all = discoverProfiles(home);
    expect(all.map((p) => p.historyPath).sort()).toEqual([bravePath, chromePath].sort());

    const one = profilesForConsent({ scope: { profiles: [chromePath] } }, () => all);
    expect(one.map((p) => p.historyPath)).toEqual([chromePath]);

    // A legacy row (granted before the card offered a choice) still means all.
    expect(profilesForConsent({ scope: { profiles: [] } }, () => all)).toHaveLength(2);
    expect(profilesForConsent(null, () => all)).toHaveLength(2);

    // A path that is not on this Mac scopes to nothing rather than to everything.
    expect(profilesForConsent({ scope: { profiles: ["/gone/History"] } }, () => all)).toHaveLength(0);
  });

  it("a scoped watcher writes ONLY the chosen profile's visits", async () => {
    const sink = new MemorySink();
    const chosen = profilesForConsent({ scope: { profiles: [chromePath] } }, () => discoverProfiles(home));
    const w = startBrowserWatcher({ sink, profiles: chosen, sinceMs: 0, now: () => NOW });
    await macrotask();
    w.stop();
    const urls = sink.events.map((e) => (e.payload as { url: string }).url).sort();
    expect(urls).toEqual(["https://old.example/", "https://recent.example/"]);
    expect(urls).not.toContain("https://brave.example/");
  });

  it("a scoped INDEX window is a real floor — older visits are never read", async () => {
    const sink = new MemorySink();
    const profiles = discoverProfiles(home).filter((p) => p.historyPath === chromePath);
    const w = startBrowserWatcher({ sink, profiles, sinceMs: NOW - 30 * DAY, now: () => NOW });
    await macrotask();
    w.stop();
    expect(sink.events.map((e) => (e.payload as { url: string }).url)).toEqual(["https://recent.example/"]);
  });
});

describe("the first poll is deferred past the microtask queue", () => {
  it("start() returns before a single event is written — the connect response goes out first", async () => {
    const sink = new MemorySink();
    const profiles = discoverProfiles(home);
    const w = startBrowserWatcher({ sink, profiles, sinceMs: 0, now: () => NOW });

    // This is exactly what `await supervisor.start('browser')` does inside the
    // route: drain the microtask queue. With the old `queueMicrotask` first
    // poll the whole import had already run by here, and the HTTP response
    // could not be written until it finished.
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.events).toHaveLength(0);
    // …and the panel can already name the profiles, all still `pending`.
    const armed = getBrowserImportProgress();
    expect(armed.known).toBe(true);
    expect(armed.first_pass_done).toBe(false);
    expect(armed.profiles.map((p) => p.state)).toEqual(["pending", "pending"]);

    await macrotask();
    expect(sink.events.length).toBeGreaterThan(0);
    w.stop();
  });

  it("stop() before the first poll cancels the import outright", async () => {
    const sink = new MemorySink();
    const w = startBrowserWatcher({ sink, profiles: discoverProfiles(home), sinceMs: 0, now: () => NOW });
    w.stop();
    await macrotask();
    expect(sink.events).toHaveLength(0);
    // A stopped watcher leaves no story behind.
    expect(getBrowserImportProgress().known).toBe(false);
  });
});

describe("the import ledger the panel polls", () => {
  it("reports each profile pending → done with what it read and what was expected", async () => {
    const sink = new MemorySink();
    const profiles = discoverProfiles(home);
    const w = startBrowserWatcher({ sink, profiles, sinceMs: 0, now: () => NOW });
    await macrotask();

    const expected = { [chromePath]: 2, [bravePath]: 1 };
    const p = getBrowserImportProgress(expected);
    expect(p.known).toBe(true);
    expect(p.first_pass_done).toBe(true);
    expect(p.reading).toBe(false);
    expect(p.visits_read).toBe(3);
    expect(p.events_written).toBe(3);
    expect(p.expected_visits).toBe(3);
    const chrome = p.profiles.find((x) => x.history_path === chromePath)!;
    expect(chrome.state).toBe("done");
    expect(chrome.visits_read).toBe(2);
    expect(chrome.expected_visits).toBe(2);
    expect(chrome.browser_name).toBe("Chrome");
    // A profile with no expectation says so rather than inventing a percentage.
    expect(getBrowserImportProgress().profiles.every((x) => x.expected_visits === null)).toBe(true);
    w.stop();
  });

  it("an unreadable profile lands as failed, and the readable ones still finish", async () => {
    const safariDir = join(home, "Library/Safari");
    mkdirSync(safariDir, { recursive: true });
    const safari = makeSafariHistory(safariDir, [{ url: "https://s.example/", tsMs: NOW - DAY }]);
    rmSync(safari, { force: true }); // discovered a moment ago, gone by the read
    const sink = new MemorySink();
    const w = startBrowserWatcher({
      sink,
      profiles: [
        ...discoverProfiles(home).filter((p) => p.browser !== "safari"),
        { browser: "safari" as const, profile: "Safari", label: null, historyPath: safari, bookmarksPath: null },
      ],
      sinceMs: 0,
      now: () => NOW,
    });
    await macrotask();
    const p = getBrowserImportProgress();
    expect(p.profiles.find((x) => x.browser === "safari")!.state).toBe("failed");
    expect(p.profiles.filter((x) => x.state === "done")).toHaveLength(2);
    expect(sink.events.length).toBeGreaterThan(0);
    w.stop();
  });
});

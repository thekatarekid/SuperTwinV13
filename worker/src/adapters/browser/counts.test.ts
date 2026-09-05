// ===========================================================================
// Browser connect counts (V6 P1 S1.4): copy-then-read per window, plateau,
// Full Disk Access message, local-path disclosure. Real SQLite fixtures in the
// Chromium and Safari shapes; zero model calls; nothing written to the log.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  COUNT_WINDOWS,
  FULL_DISK_ACCESS_SETTINGS_URL,
  countProfile,
  disclosureText,
  discoverAndCount,
  plateauWindow,
  retentionNote,
} from "./counts.js";
import { historyScratchDir, setHistoryScratchDir } from "./history-db.js";
import { makeChromeBookmarks, makeChromeHistory, makeSafariHistory, tmpDir } from "./test-fixtures.js";
import type { BrowserProfile } from "./watcher.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const DAY = 24 * 60 * 60_000;

let scratch: string;
beforeAll(() => {
  scratch = tmpDir();
  setHistoryScratchDir(scratch);
});
afterAll(() => setHistoryScratchDir(null));

function chrome(dir: string, extra: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    browser: "chrome",
    profile: "Default",
    label: "Aditya",
    historyPath: join(dir, "History"),
    bookmarksPath: existsSync(join(dir, "Bookmarks")) ? join(dir, "Bookmarks") : null,
    ...extra,
  };
}

describe("countProfile — real numbers per window (Product §3.3)", () => {
  it("counts visits and bookmarks per window from ONE copy, and the copy is gone afterwards", () => {
    const dir = tmpDir();
    makeChromeHistory(dir, [
      { url: "https://a.example/", tsMs: NOW - 1 * DAY },
      { url: "https://b.example/", tsMs: NOW - 10 * DAY },
      { url: "https://c.example/", tsMs: NOW - 40 * DAY },
      { url: "https://d.example/", tsMs: NOW - 85 * DAY },
    ]);
    makeChromeBookmarks(dir, [
      { url: "https://a.example/", name: "A", addedMs: NOW - 2 * DAY },
      { url: "https://z.example/", name: "Z", addedMs: NOW - 200 * DAY },
      { url: "https://u.example/", name: "undated" }, // counts in every window
    ]);
    const c = countProfile(chrome(dir), NOW);
    expect(c.readable).toBe(true);
    expect(c.error).toBeNull();
    expect(c.windows["3d"]).toEqual({ visits: 1, bookmarks: 2 });
    expect(c.windows["30d"]).toEqual({ visits: 2, bookmarks: 2 });
    expect(c.windows["90d"]).toEqual({ visits: 4, bookmarks: 2 });
    expect(c.windows["1y"]).toEqual({ visits: 4, bookmarks: 3 });
    expect(c.windows.all).toEqual({ visits: 4, bookmarks: 3 });
    expect(c.total_visits).toBe(4);
    expect(c.total_bookmarks).toBe(3);
    expect(c.oldest_visit_ts).toBe(new Date(NOW - 85 * DAY).toISOString());
    expect(c.newest_visit_ts).toBe(new Date(NOW - 1 * DAY).toISOString());
    expect(Object.keys(c.windows)).toEqual([...COUNT_WINDOWS]);
    // Copy-then-read leaves nothing behind.
    expect(readdirSync(scratch).filter((f) => f.startsWith("h-"))).toEqual([]);
  });

  it("plateau: the first window that already equals all-time; 'Chrome keeps 90 days' when the oldest visit sits at the edge", () => {
    const dir = tmpDir();
    makeChromeHistory(dir, [
      { url: "https://a.example/", tsMs: NOW - 2 * DAY },
      { url: "https://b.example/", tsMs: NOW - 60 * DAY },
      { url: "https://c.example/", tsMs: NOW - 89 * DAY },
    ]);
    const c = countProfile(chrome(dir, { bookmarksPath: null }), NOW);
    expect(c.plateau_window).toBe("90d");
    expect(c.retention_note).toBe("Chrome keeps 90 days of history — anything older is already gone, so longer windows can't grow.");
    // The same numbers, no note, when history simply does not go back far.
    expect(retentionNote("chrome", NOW - 20 * DAY, NOW)).toBeNull();
    expect(retentionNote("brave", NOW - 92 * DAY, NOW)).toContain("Brave keeps 90 days");
    expect(retentionNote("safari", NOW - 360 * DAY, NOW)).toContain("Safari keeps a year");
    expect(retentionNote("safari", NOW - 800 * DAY, NOW)).toBeNull(); // retention off
    expect(plateauWindow({ "3d": { visits: 0, bookmarks: 0 }, "7d": { visits: 5, bookmarks: 0 } }, 5)).toBe("7d");
    expect(plateauWindow({}, 0)).toBeNull();
  });

  it("Safari: counts through History.db; when macOS refuses the copy the card gets the Full Disk Access message", () => {
    const dir = tmpDir();
    const path = makeSafariHistory(dir, [
      { url: "https://news.ycombinator.com/", tsMs: NOW - 3 * DAY },
      { url: "https://news.ycombinator.com/item?id=1", tsMs: NOW - 100 * DAY },
    ]);
    const profile: BrowserProfile = { browser: "safari", profile: "Safari", label: null, historyPath: path, bookmarksPath: null };
    const ok = countProfile(profile, NOW);
    expect(ok.readable).toBe(true);
    expect(ok.windows["7d"]!.visits).toBe(1);
    expect(ok.windows.all!.visits).toBe(2);
    expect(ok.browser_name).toBe("Safari");

    // Simulate the missing grant: the file is there but the copy is refused.
    chmodSync(path, 0o000);
    try {
      const denied = countProfile(profile, NOW);
      expect(denied.readable).toBe(false);
      expect(denied.error?.code).toBe("full-disk-access");
      expect(denied.error?.message).toContain("Full Disk Access");
      expect(denied.error?.message).toContain("Safari");
      expect(denied.error?.settings_url).toBe(FULL_DISK_ACCESS_SETTINGS_URL);
      expect(denied.windows.all).toEqual({ visits: 0, bookmarks: 0 });
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("a corrupt or missing file is reported, never thrown", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "History"), "not sqlite");
    const bad = countProfile(chrome(dir, { bookmarksPath: null }), NOW);
    expect(bad.readable).toBe(false);
    expect(bad.error?.code).toBe("unreadable");
    const gone = countProfile(chrome(join(dir, "nope"), { bookmarksPath: null }), NOW);
    expect(gone.readable).toBe(false);
    expect(gone.error?.code).toBe("missing");
  });
});

describe("discoverAndCount — the card's one call", () => {
  it("totals readable profiles, flags FDA, and discloses the local paths + scratch dir", () => {
    const a = tmpDir();
    const b = tmpDir();
    makeChromeHistory(a, [{ url: "https://a.example/", tsMs: NOW - DAY }]);
    makeChromeHistory(b, [{ url: "https://b.example/", tsMs: NOW - DAY }, { url: "https://c.example/", tsMs: NOW - 2 * DAY }]);
    const safariDir = tmpDir();
    mkdirSync(safariDir, { recursive: true });
    const safari = makeSafariHistory(safariDir, [{ url: "https://s.example/", tsMs: NOW - DAY }]);
    chmodSync(safari, 0o000);
    try {
      const profiles: BrowserProfile[] = [
        chrome(a, { bookmarksPath: null }),
        chrome(b, { browser: "brave", label: "Person 1", bookmarksPath: null }),
        { browser: "safari", profile: "Safari", label: null, historyPath: safari, bookmarksPath: null },
      ];
      const d = discoverAndCount(profiles, NOW);
      expect(d.profiles).toHaveLength(3);
      expect(d.totals["7d"]).toEqual({ visits: 3, bookmarks: 0 });
      expect(d.needs_full_disk_access).toBe(true);
      expect(d.full_disk_access_settings_url).toBe(FULL_DISK_ACCESS_SETTINGS_URL);
      expect(d.disclosure.scratch_dir).toBe(historyScratchDir());
      expect(d.disclosure.text).toContain("3 history files");
      expect(d.disclosure.text).toContain(historyScratchDir());
      expect(d.disclosure.text).toContain("never opened");
      expect(d.profiles.map((p) => p.history_path)).toEqual(profiles.map((p) => p.historyPath));
      expect(d.now).toBe(new Date(NOW).toISOString());
    } finally {
      chmodSync(safari, 0o644);
    }
  });

  it("disclosure copes with zero profiles", () => {
    expect(disclosureText([], "/tmp/x")).toContain("no history files found");
    const d = discoverAndCount([], NOW);
    expect(d.profiles).toEqual([]);
    expect(d.needs_full_disk_access).toBe(false);
  });
});

import Database from "better-sqlite3";
import { describe, expect, it, beforeAll } from "vitest";

import {
  chromeTimeToUnixMs,
  decodeChromeTransition,
  readChromiumHistory,
  readSafariHistory,
  safariTimeToUnixMs,
  setHistoryScratchDir,
  unixMsToChromeTime,
  unixMsToSafariTime,
} from "./history-db.js";
import { makeChromeHistory, makeSafariHistory, tmpDir, T_TYPED, T_LINK, Q_SERVER_REDIRECT } from "./test-fixtures.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const MIN = 60_000;

beforeAll(() => {
  setHistoryScratchDir(tmpDir());
});

describe("epoch conversions", () => {
  it("chrome time round-trips", () => {
    expect(chromeTimeToUnixMs(unixMsToChromeTime(NOW))).toBe(NOW);
  });
  it("safari time round-trips", () => {
    expect(safariTimeToUnixMs(unixMsToSafariTime(NOW))).toBe(NOW);
  });
  it("chrome epoch anchor: 1601-01-01 is -11644473600000 unix ms", () => {
    expect(chromeTimeToUnixMs(0)).toBe(-11644473600000);
  });
});

describe("decodeChromeTransition", () => {
  it("reads core types", () => {
    expect(decodeChromeTransition(T_TYPED)).toEqual({ transition: "typed", typed: true, redirect: false });
    expect(decodeChromeTransition(T_LINK).transition).toBe("link");
  });
  it("redirect qualifier wins the label and keeps typed flag semantics", () => {
    const d = decodeChromeTransition((T_LINK | Q_SERVER_REDIRECT) | 0);
    expect(d.transition).toBe("redirect");
    expect(d.redirect).toBe(true);
  });
});

describe("readChromiumHistory (copy-then-read)", () => {
  it("normalises visits, referrers, dwell, counts", () => {
    const dir = tmpDir();
    const path = makeChromeHistory(dir, [
      { url: "https://goibibo.com/", title: "Goibibo", tsMs: NOW - 60 * MIN, transition: T_TYPED, dwellMs: 360_000 },
      { url: "https://goibibo.com/flights", title: "Flights", tsMs: NOW - 54 * MIN, transition: T_LINK, fromVisit: 1, dwellMs: 90_000 },
    ]);
    const visits = readChromiumHistory(path, 0, "chrome");
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({
      url: "https://goibibo.com/",
      title: "Goibibo",
      transition: "typed",
      typed: true,
      dwellMs: 360_000,
      browser: "chrome",
    });
    expect(visits[1]!.referrerVisitId).toBe(visits[0]!.visitId);
    expect(visits[1]!.tsMs).toBe(NOW - 54 * MIN);
  });

  it("respects the since cursor", () => {
    const dir = tmpDir();
    const path = makeChromeHistory(dir, [
      { url: "https://old.example/", tsMs: NOW - 100 * MIN },
      { url: "https://new.example/", tsMs: NOW - 5 * MIN },
    ]);
    const visits = readChromiumHistory(path, NOW - 10 * MIN, "chrome");
    expect(visits.map((v) => v.url)).toEqual(["https://new.example/"]);
  });

  it("reads while another connection holds the live file open (lock dodge)", () => {
    const dir = tmpDir();
    const path = makeChromeHistory(dir, [{ url: "https://locked.example/", tsMs: NOW - MIN }]);
    const holder = new Database(path);
    holder.exec("BEGIN EXCLUSIVE"); // browser holding the DB
    try {
      const visits = readChromiumHistory(path, 0, "arc");
      expect(visits).toHaveLength(1);
      expect(visits[0]!.browser).toBe("arc");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});

describe("readSafariHistory", () => {
  it("normalises visits and marks redirect hops", () => {
    const dir = tmpDir();
    const path = makeSafariHistory(dir, [
      { url: "https://news.ycombinator.com/", title: "HN", tsMs: NOW - 30 * MIN },
      { url: "https://example.com/land", title: "Land", tsMs: NOW - 29 * MIN, redirectSource: 1 },
    ]);
    const visits = readSafariHistory(path, 0);
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({ url: "https://news.ycombinator.com/", transition: "link", redirect: false });
    expect(visits[1]).toMatchObject({ transition: "redirect", redirect: true, referrerVisitId: 1 });
    expect(visits[0]!.tsMs).toBe(NOW - 30 * MIN);
  });
});

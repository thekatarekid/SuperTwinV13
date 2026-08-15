// ===========================================================================
// Date resolution (docs/v6-spec.md §1, "date and day resolution").
//
// The timezone is pinned rather than inherited: the bug this guards against is
// invisible in UTC and wrong for five and a half hours a day in the timezone
// the corpus was written in.
// ===========================================================================

process.env.TZ = "Asia/Kolkata";

import { describe, it, expect } from "vitest";

import {
  dateMatchPhrases,
  isoDate,
  localToday,
  resolveDates,
  tsWithinRange,
  weekdayName,
  MAX_RESOLVED_DATES,
} from "./dates.js";

/** Friday 31 Jul 2026, 14:30 local. The Sunday after it is 02 Aug 2026. */
const FRIDAY = new Date("2026-07-31T09:00:00Z");

function isos(query: string, now: Date = FRIDAY): string[] {
  return resolveDates(query, now).dates.map((d) => d.iso);
}

describe("local dates", () => {
  it("reads the user's calendar day, not UTC's", () => {
    // 19:30Z is already the 1st in Asia/Kolkata. Slicing an ISO string here
    // gives 2026-07-31 and every weekday after it is one day out.
    const nearMidnight = new Date("2026-07-31T19:30:00Z");
    expect(isoDate(localToday(nearMidnight))).toBe("2026-08-01");
    expect(nearMidnight.toISOString().slice(0, 10)).toBe("2026-07-31");

    expect(resolveDates("sunday", nearMidnight).todayIso).toBe("2026-08-01");
    expect(resolveDates("sunday", nearMidnight).todayWeekday).toBe("saturday");
  });

  it("names the weekday of a date", () => {
    expect(weekdayName({ year: 2026, month: 8, day: 2 })).toBe("sunday");
    expect(weekdayName({ year: 2026, month: 7, day: 31 })).toBe("friday");
  });

  it("a range test converts the instant before comparing days", () => {
    const range = { fromIso: "2026-08-01", toIso: "2026-08-01" };
    // 2026-07-31T19:30Z is the 1st here — the day the user would call it.
    expect(tsWithinRange("2026-07-31T19:30:00.000Z", range)).toBe(true);
    expect(tsWithinRange("2026-07-31T09:00:00.000Z", range)).toBe(false);
    expect(tsWithinRange(null, range)).toBe(false);
    expect(tsWithinRange("not a date", range)).toBe(false);
  });
});

describe("weekdays", () => {
  it("resolves the repro: 'sunday' asked on a Friday", () => {
    const resolution = resolveDates("Do i have anything planned on sunday", FRIDAY);
    expect(resolution.todayIso).toBe("2026-07-31");
    expect(resolution.todayWeekday).toBe("friday");
    // The booking says 02 Aug 2026 and the question never does.
    expect(resolution.dates[0]).toMatchObject({
      iso: "2026-08-02",
      weekday: "sunday",
      relation: "future",
      offsetDays: 2,
    });
    // The past one too: the question's tense is not knowable from its words.
    expect(resolution.dates[1]).toMatchObject({ iso: "2026-07-26", relation: "past" });
  });

  it("today counts as its own weekday", () => {
    expect(isos("friday")).toEqual(["2026-07-31"]);
    expect(resolveDates("friday", FRIDAY).dates[0].relation).toBe("today");
  });

  it("qualifiers move it a week either way", () => {
    expect(isos("this sunday")).toEqual(["2026-08-02"]);
    expect(isos("coming sunday")).toEqual(["2026-08-02"]);
    expect(isos("next sunday")).toEqual(["2026-08-09"]);
    expect(isos("last sunday")).toEqual(["2026-07-26"]);
    expect(isos("previous sunday")).toEqual(["2026-07-26"]);
  });

  it("reads the short forms a chat actually uses", () => {
    expect(isos("sat plans?")).toContain("2026-08-01");
    expect(isos("free on wed?")).toContain("2026-08-05");
  });
});

describe("relative expressions", () => {
  it("today, tonight, tomorrow, yesterday", () => {
    expect(isos("what is on today")).toEqual(["2026-07-31"]);
    expect(isos("anything tonight")).toEqual(["2026-07-31"]);
    expect(isos("free tomorrow?")).toEqual(["2026-08-01"]);
    expect(isos("what did i do yesterday")).toEqual(["2026-07-30"]);
  });

  it("a weekend is its Saturday and its Sunday", () => {
    expect(isos("plans this weekend")).toEqual(["2026-08-01", "2026-08-02"]);
    expect(isos("next weekend")).toEqual(["2026-08-08", "2026-08-09"]);
    expect(isos("last weekend")).toEqual(["2026-07-25", "2026-07-26"]);
  });

  it("a week is its endpoints, and a range covering all seven days", () => {
    const resolution = resolveDates("what happened this week", FRIDAY);
    // Monday-first: the week Friday 31 Jul sits in runs 27 Jul - 2 Aug.
    expect(resolution.dates.map((d) => d.iso)).toEqual(["2026-07-27", "2026-08-02"]);
    expect(resolution.ranges).toContainEqual({
      fromIso: "2026-07-27",
      toIso: "2026-08-02",
    });
    // The days between the endpoints are covered by the range, not by phrases.
    expect(tsWithinRange("2026-07-29T10:00:00.000Z", resolution.ranges[0])).toBe(true);

    expect(isos("next week")).toEqual(["2026-08-03", "2026-08-09"]);
    expect(isos("last week")).toEqual(["2026-07-20", "2026-07-26"]);
  });

  it("a question with no date words resolves nothing", () => {
    const resolution = resolveDates("what did we decide about the flat", FRIDAY);
    expect(resolution.dates).toEqual([]);
    expect(resolution.ranges).toEqual([]);
    expect(resolution.todayIso).toBe("2026-07-31");
  });

  it("caps how many dates one question can mean", () => {
    const many = resolveDates(
      "monday tuesday wednesday thursday friday saturday sunday next week",
      FRIDAY,
    );
    expect(many.dates.length).toBe(MAX_RESOLVED_DATES);
  });
});

describe("how a date is written in a message", () => {
  it("covers the spellings the corpus actually contains", () => {
    const phrases = dateMatchPhrases("2026-08-02");
    // "booking on 02 Aug 2026, 01:00 PM" — the one the repro turns on.
    expect(phrases).toContain("02 aug 2026");
    // FTS5 splits "2026-08-02" into three tokens; the phrase matches any
    // separator, and "02" is a different token from "2".
    expect(phrases).toContain("2026 08 02");
    expect(phrases).toContain("2 aug 2026");
    expect(phrases).toContain("2 august 2026");
    expect(phrases).toContain("aug 2");
    expect(phrases).toContain("02 aug");
    expect(phrases).toContain("02 08 2026");
  });

  it("is day-first only — month-first would match a different day", () => {
    // 08/02/2026 in this corpus is the 8th of February.
    expect(dateMatchPhrases("2026-08-02")).not.toContain("08 02 2026");
    expect(dateMatchPhrases("2026-08-02")).not.toContain("8 2 2026");
  });

  it("does not repeat itself when the day needs no leading zero", () => {
    const phrases = dateMatchPhrases("2026-08-12");
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(phrases).toContain("12 aug 2026");
  });
});

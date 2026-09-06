// ===========================================================================
// The three clocks (V6 P1 S5.3) — pure, zero model calls, no DB.
//   MESSAGE time resolves phrases (TIM-01, TIM-03, CAL-03's anchor)
//   PROCESSING time decides past/future (CAL-03)
//   VIEW time renders relatives (TIM-02) and zones (TIM-04)
//   recurring phrases → rules, never dates (CAL-04)
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  addDays,
  classifyAtProcessing,
  dayDiff,
  describeRule,
  instantInZone,
  localDate,
  nextOccurrences,
  parseRecurrence,
  parseTimeOfDay,
  renderInstant,
  renderRelative,
  resolvePhrase,
  shiftInZone,
  tzOffsetMinutes,
  zonedToUtcMs,
} from "./clocks.js";

const IST = "Asia/Kolkata";
const NOW = new Date("2026-08-29T03:30:00.000Z"); // Sat 09:00 IST

describe("zone math", () => {
  it("IST is +330 all year; Los Angeles flips with DST", () => {
    expect(tzOffsetMinutes(Date.parse("2026-01-15T00:00:00Z"), IST)).toBe(330);
    expect(tzOffsetMinutes(Date.parse("2026-07-15T00:00:00Z"), "America/Los_Angeles")).toBe(-420);
    expect(tzOffsetMinutes(Date.parse("2026-01-15T00:00:00Z"), "America/Los_Angeles")).toBe(-480);
  });
  it("wall clock → instant round-trips", () => {
    const ms = zonedToUtcMs({ year: 2026, month: 8, day: 29, hour: 20, minute: 0 }, IST);
    expect(new Date(ms).toISOString()).toBe("2026-08-29T14:30:00.000Z");
    expect(localDate(ms, IST)).toBe("2026-08-29");
    expect(localDate(ms, "America/Los_Angeles")).toBe("2026-08-29");
    expect(localDate(Date.parse("2026-08-29T20:00:00Z"), IST)).toBe("2026-08-30");
  });
  it("calendar-day arithmetic", () => {
    expect(addDays("2026-08-29", 3)).toBe("2026-09-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayDiff("2026-09-06", "2026-09-20")).toBe(14);
  });
});

describe("MESSAGE time — resolvePhrase", () => {
  it("TIM-01: 'day after' said Tue 21:40 IST → Thu, the phrase and anchor kept", () => {
    const r = resolvePhrase("pay maintenance by day after", { ts: "2026-08-25T16:10:00.000Z", tz: IST })!;
    expect(r.date).toBe("2026-08-27");
    expect(r.time).toBeNull();
    expect(r.phrase).toBe("pay maintenance by day after");
    expect(r.anchor).toBe("2026-08-25T16:10:00.000Z");
    expect(r.tz).toBe(IST);
    expect(r.iso).toBe("2026-08-26T18:30:00.000Z"); // 00:00 IST on the 27th
  });
  it("TIM-03: 'by friday' said on a Tuesday is that week's Friday, never ten days out", () => {
    const r = resolvePhrase("send the deck by friday", { ts: "2026-05-12T04:30:00.000Z", tz: IST })!;
    expect(r.date).toBe("2026-05-15");
  });
  it("CAL-01: 'dinner sat 8pm' said Thu 19:00 IST → Sat 20:00 IST as an absolute instant", () => {
    const r = resolvePhrase("dinner sat 8pm", { ts: "2026-08-27T13:30:00.000Z", tz: IST })!;
    expect(r.date).toBe("2026-08-29");
    expect(r.time).toBe("20:00");
    expect(r.iso).toBe("2026-08-29T14:30:00.000Z");
  });
  it("the weekday itself: 'sat' said on a Saturday is today; 'next sat' is a week out", () => {
    const sat = "2026-08-29T05:00:00.000Z";
    expect(resolvePhrase("lunch sat", { ts: sat, tz: IST })!.date).toBe("2026-08-29");
    expect(resolvePhrase("lunch next sat", { ts: sat, tz: IST })!.date).toBe("2026-09-05");
  });
  it("late-night IST message anchors on the IST day, not the UTC day", () => {
    // 2026-08-27T20:30Z = 02:00 IST on the 28th; "tomorrow" is the 29th.
    const r = resolvePhrase("tomorrow", { ts: "2026-08-27T20:30:00.000Z", tz: IST })!;
    expect(r.date).toBe("2026-08-29");
  });
  it("explicit forms: ISO, '3 sep', 'sep 3', dd/mm, 'in 2 weeks', a bare time", () => {
    const m = { ts: "2026-08-28T04:30:00.000Z", tz: IST };
    expect(resolvePhrase("on 2026-12-18", m)!.date).toBe("2026-12-18");
    expect(resolvePhrase("3 sep", m)!.date).toBe("2026-09-03");
    expect(resolvePhrase("sept 3rd, 2027", m)!.date).toBe("2027-09-03");
    expect(resolvePhrase("18/12", m)!.date).toBe("2026-12-18");
    expect(resolvePhrase("in 2 weeks", m)!.date).toBe("2026-09-11");
    expect(resolvePhrase("call at 4:30pm", m)).toMatchObject({ date: "2026-08-28", time: "16:30" });
  });
  it("names no date → null (never invented)", () => {
    expect(resolvePhrase("send the villa photos", { ts: "2026-08-28T04:30:00.000Z", tz: IST })).toBeNull();
    expect(resolvePhrase("tomorrow", { ts: "not a date", tz: IST })).toBeNull();
  });
  it("an unknown zone falls back to the default rather than throwing", () => {
    expect(resolvePhrase("tomorrow", { ts: "2026-08-28T04:30:00.000Z", tz: "Mars/Olympus" })!.tz).toBe(IST);
  });
  it("parseTimeOfDay covers 12-hour edges and 24-hour forms", () => {
    expect(parseTimeOfDay("12am")).toMatchObject({ hour: 0, minute: 0 });
    expect(parseTimeOfDay("12 pm")).toMatchObject({ hour: 12, minute: 0 });
    expect(parseTimeOfDay("20:15")).toMatchObject({ hour: 20, minute: 15 });
    expect(parseTimeOfDay("8:30 pm")).toMatchObject({ hour: 20, minute: 30 });
    expect(parseTimeOfDay("25:00")).toBeNull();
  });
});

describe("PROCESSING time — classifyAtProcessing", () => {
  it("CAL-03: a March 'tomorrow' read in August is past → closure check, never due", () => {
    const r = resolvePhrase("book by tomorrow", { ts: "2026-03-14T09:00:00.000Z", tz: IST })!;
    expect(r.date).toBe("2026-03-15");
    const v = classifyAtProcessing(r, NOW);
    expect(v).toMatchObject({ relation: "past", disposition: "closure_check" });
    expect(v.offsetDays).toBeLessThan(0);
  });
  it("a future date is due; the processing day itself is still due (today)", () => {
    const r = resolvePhrase("dinner sat 8pm", { ts: "2026-08-27T13:30:00.000Z", tz: IST })!;
    expect(classifyAtProcessing(r, NOW)).toMatchObject({ relation: "future", disposition: "due", offsetDays: 0 });
    const later = resolvePhrase("next week", { ts: "2026-08-27T13:30:00.000Z", tz: IST })!;
    expect(classifyAtProcessing(later, NOW).offsetDays).toBe(5);
  });
});

describe("VIEW time — renderRelative / renderInstant", () => {
  it("TIM-02: the same stored day renders 'tomorrow' then '1 day overdue'", () => {
    const stored = "2026-08-27";
    expect(renderRelative(stored, new Date("2026-08-26T04:30:00.000Z"), IST)).toBe("tomorrow");
    expect(renderRelative(stored, new Date("2026-08-28T04:30:00.000Z"), IST)).toBe("1 day overdue");
    expect(renderRelative(stored, new Date("2026-08-27T04:30:00.000Z"), IST)).toBe("today");
    expect(renderRelative(stored, new Date("2026-08-24T04:30:00.000Z"), IST)).toBe("in 3 days");
    expect(renderRelative(stored, new Date("2026-08-30T04:30:00.000Z"), IST)).toBe("3 days overdue");
  });
  it("TIM-04: 'departs SFO 11:30 PDT' is stored absolute with its zone; check-in is on the flight's clock; the user sees IST with PDT noted", () => {
    const dep = instantInZone({ year: 2026, month: 9, day: 2, hour: 11, minute: 30 }, "America/Los_Angeles");
    expect(dep).toEqual({ iso: "2026-09-02T18:30:00.000Z", tz: "America/Los_Angeles" });
    expect(shiftInZone(dep.iso, dep.tz, -48)).toBe("2026-08-31T18:30:00.000Z");
    const rendered = renderInstant(dep.iso, IST, dep.tz);
    expect(rendered).toContain("2026-09-03 00:00");
    expect(rendered).toMatch(/IST/);
    expect(rendered).toMatch(/11:30 PDT/);
    // Not 11:30 IST:
    expect(dep.iso).not.toBe("2026-09-02T06:00:00.000Z");
  });
  it("same zone → no parenthetical", () => {
    expect(renderInstant("2026-08-29T14:30:00.000Z", IST, IST)).toBe("2026-08-29 20:00 IST");
    expect(renderInstant("2026-08-29T14:30:00.000Z", IST, null)).toBe("2026-08-29 20:00 IST");
  });
});

describe("recurrence — rules, not dates", () => {
  it("CAL-04: 'rent every 1st' is monthly on the 1st", () => {
    expect(parseRecurrence("rent every 1st")).toMatchObject({ freq: "monthly", interval: 1, byMonthDay: 1, phrase: "rent every 1st" });
    expect(nextOccurrences(parseRecurrence("rent every 1st")!, "2026-08-29", 3)).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(describeRule(parseRecurrence("rent every 1st")!)).toBe("every month on the 1st");
  });
  it("weekly, daily, yearly, every-N and month-end clamping", () => {
    expect(parseRecurrence("standup every friday 9am")).toMatchObject({ freq: "weekly", byWeekday: 5, time: "09:00" });
    expect(nextOccurrences(parseRecurrence("every friday")!, "2026-08-29", 2)).toEqual(["2026-09-04", "2026-09-11"]);
    expect(parseRecurrence("water the plants daily")).toMatchObject({ freq: "daily", interval: 1 });
    expect(parseRecurrence("every 2 weeks")).toMatchObject({ freq: "weekly", interval: 2 });
    expect(parseRecurrence("anniversary every year")).toMatchObject({ freq: "yearly" });
    expect(parseRecurrence("salary on the 31st of every month")).toMatchObject({ freq: "monthly", byMonthDay: 31 });
    expect(nextOccurrences(parseRecurrence("31st of every month")!, "2026-09-01", 2)).toEqual(["2026-09-30", "2026-10-31"]);
    expect(describeRule(parseRecurrence("every friday 9am")!)).toBe("every Friday at 09:00");
  });
  it("a one-off phrase is not a rule", () => {
    expect(parseRecurrence("dinner sat 8pm")).toBeNull();
    expect(parseRecurrence("book by tomorrow")).toBeNull();
  });
});

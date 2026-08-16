// ===========================================================================
// ICS reader unit tests (build item 5.1). The parser is adapter-local; these
// pin the exact RFC 5545 subset the fixture format relies on: line unfolding,
// property params (CN/ROLE/VALUE, quoted values), UTC + date-only timestamps,
// TEXT unescaping, mailto normalisation, and the skip rule for records with
// nothing stable to dedupe or order on.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { icsDateToIso, parseIcs, unfoldIcsLines } from "./ics.js";

describe("unfoldIcsLines", () => {
  it("joins continuation lines (leading space or tab) per RFC 5545 §3.1", () => {
    const lines = unfoldIcsLines("SUMMARY:Dinner at\r\n  the new place\r\nUID:u1\n\tx");
    expect(lines).toEqual(["SUMMARY:Dinner at the new place", "UID:u1x"]);
  });
});

describe("icsDateToIso", () => {
  it("reads UTC, naive and date-only forms", () => {
    expect(icsDateToIso("20260801T130000Z")).toBe("2026-08-01T13:00:00.000Z");
    expect(icsDateToIso("20260801T130000")).toBe("2026-08-01T13:00:00.000Z");
    expect(icsDateToIso("20260801")).toBe("2026-08-01T00:00:00.000Z");
    expect(icsDateToIso("not-a-date")).toBeNull();
  });
});

describe("parseIcs", () => {
  const FIXTURE = [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:Team Calendar",
    "BEGIN:VEVENT",
    "UID:evt-1",
    "DTSTART:20260810T090000Z",
    "DTEND:20260810T093000Z",
    "SUMMARY:Standup\\, daily",
    "DESCRIPTION:Line one\\nLine two",
    "LOCATION:Room 4",
    "URL:https://meet.example.com/standup",
    "STATUS:CONFIRMED",
    'ORGANIZER;CN="Gargi Rawat":mailto:GARGI@x.com',
    "ATTENDEE;CN=Mansi;ROLE=REQ-PARTICIPANT:mailto:mansi@x.com",
    "ATTENDEE:mailto:me@example.com",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-allday",
    "DTSTART;VALUE=DATE:20260815",
    "SUMMARY:Offsite",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20260816T090000Z",
    "SUMMARY:no uid — skipped",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("parses events, params, escapes and mailto values", () => {
    const cal = parseIcs(FIXTURE);
    expect(cal.name).toBe("Team Calendar");
    expect(cal.events).toHaveLength(2); // the UID-less block is skipped

    const [e1, e2] = cal.events;
    expect(e1.uid).toBe("evt-1");
    expect(e1.start).toBe("2026-08-10T09:00:00.000Z");
    expect(e1.end).toBe("2026-08-10T09:30:00.000Z");
    expect(e1.all_day).toBe(false);
    expect(e1.summary).toBe("Standup, daily");
    expect(e1.description).toBe("Line one\nLine two");
    expect(e1.location).toBe("Room 4");
    expect(e1.url).toBe("https://meet.example.com/standup");
    expect(e1.status).toBe("confirmed");
    // Organizer email lowercased, CN kept (quoted param value unwrapped).
    expect(e1.organizer).toEqual({ email: "gargi@x.com", name: "Gargi Rawat", role: "organizer" });
    expect(e1.attendees).toEqual([
      { email: "mansi@x.com", name: "Mansi", role: "req-participant" },
      { email: "me@example.com", role: "req-participant" },
    ]);

    expect(e2.uid).toBe("evt-allday");
    expect(e2.all_day).toBe(true);
    expect(e2.start).toBe("2026-08-15T00:00:00.000Z");
    expect(e2.attendees).toEqual([]);
  });
});

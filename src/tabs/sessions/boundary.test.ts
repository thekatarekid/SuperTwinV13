// The acceptance criterion for build item 1.11, as a test file: EVERY session
// boundary is explainable in one line. Every reason the segmenter can record
// (worker/src/sessions/policies.ts BOUNDARY_REASONS) gets a case here, and the
// last test proves that a reason this module has never seen still explains
// itself rather than degrading to a bare label.

import { describe, expect, it } from "vitest";

import { boundaryLine, explainBoundary, formatDuration } from "./boundary";
import { BOUNDARY_REASONS, type BoundaryView } from "../../lib/surfaces-client";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("formatDuration", () => {
  it("reads at a glance at every scale", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(45 * MINUTE)).toBe("45m");
    expect(formatDuration(6 * HOUR)).toBe("6h");
    expect(formatDuration(7 * HOUR + 20 * MINUTE)).toBe("7h20m");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("∞");
  });
});

describe("explainBoundary", () => {
  const cases: [string, BoundaryView, RegExp][] = [
    [
      "gap",
      { reason: "gap", measured: { gap_ms: 7 * HOUR + 20 * MINUTE, threshold_ms: 6 * HOUR } },
      /^gap 7h20m > 6h$/,
    ],
    [
      "ceiling",
      { reason: "ceiling", measured: { span_ms: 25 * HOUR, ceiling_ms: 24 * HOUR } },
      /ceiling 24h reached — span 25h/,
    ],
    [
      "debounce",
      { reason: "debounce", measured: { idle_ms: 45 * MINUTE, debounce_ms: 45 * MINUTE } },
      /debounce 45m idle ≥ 45m/,
    ],
    [
      "reply_break",
      {
        reason: "reply_break",
        measured: { reply_age_ms: 9 * HOUR, threshold_ms: 6 * HOUR, target: "wa_991" },
        },
      /reply chain break — target 9h old > 6h \(wa_991\)/,
    ],
    [
      "participant_shift",
      {
        reason: "participant_shift",
        measured: {
          gap_ms: 2 * HOUR,
          shift_min_gap_ms: 1 * HOUR,
          initiator: "me",
          actor: "Pranjali",
        },
      },
      /participant shift me → Pranjali after 2h \(≥ 1h\)/,
    ],
    [
      "author_shift",
      {
        reason: "author_shift",
        measured: { gap_ms: 30 * MINUTE, previous_author: "me", author: "Rohan" },
      },
      /author shift me → Rohan after 30m/,
    ],
    [
      "context_shift by silence",
      { reason: "context_shift", measured: { silence_ms: 20 * MINUTE, threshold_ms: 10 * MINUTE } },
      /context shift — silence 20m > 10m/,
    ],
    [
      "context_shift by app",
      { reason: "context_shift", measured: { previous_context: "figma", context: "slack" } },
      /context shift figma → slack/,
    ],
    [
      "day_boundary",
      {
        reason: "day_boundary",
        measured: { tz: "Asia/Kolkata", from_day: "2025-08-14", to_day: "2025-08-15" },
      },
      /local midnight 2025-08-14 → 2025-08-15 \(Asia\/Kolkata\)/,
    ],
    [
      "size_cap by events",
      { reason: "size_cap", measured: { events: 40, cap_events: 40 } },
      /size cap — 40 events at cap 40/,
    ],
    [
      "size_cap by tokens",
      { reason: "size_cap", measured: { chars: 24_000, cap_chars: 24_000, tokens: 6_000, cap_tokens: 6_000 } },
      /size cap — 6000 tokens at cap 6000/,
    ],
    [
      "size_cap by active span",
      { reason: "size_cap", measured: { active_ms: 40 * MINUTE, cap_active_ms: 40 * MINUTE } },
      /size cap — active 40m at cap 40m/,
    ],
    [
      "record_bounded",
      { reason: "record_bounded", measured: { rule: "record_bounded", record: "cal_evt_88" } },
      /record cal_evt_88 is the session — no cap applies/,
    ],
    [
      "record_bounded by transaction",
      { reason: "record_bounded", measured: { rule: "transaction", kind: "payment" } },
      /transaction — a payment is always its own session/,
    ],
    [
      "stream_start",
      { reason: "stream_start", measured: { rule: "stream_start" } },
      /stream start — the first event on this stream/,
    ],
    [
      "late_arrival",
      {
        reason: "late_arrival",
        measured: { rule: "late_arrival", overlap_of: "ses_77", overlap_started_at: "09:12" },
      },
      /late arrival inside sealed session ses_77/,
    ],
  ];

  for (const [name, boundary, expected] of cases) {
    it(`explains ${name} in one line`, () => {
      const line = explainBoundary(boundary);
      expect(line).toMatch(expected);
      expect(line).not.toContain("\n");
    });
  }

  it("explains EVERY reason the segmenter can record, never as a bare label", () => {
    for (const reason of BOUNDARY_REASONS) {
      const line = explainBoundary({ reason, measured: { gap_ms: 1000, threshold_ms: 500 } });
      expect(line.length).toBeGreaterThan(reason.length);
    }
  });

  it("falls back to naming every measured value rather than to a bare label", () => {
    // A thirteenth rule this module has never heard of.
    const line = explainBoundary({
      reason: "quorum_lost" as never,
      measured: { present: 2, quorum: 3 },
    });
    expect(line).toBe("quorum_lost · present=2 · quorum=3");
  });

  it("never returns an empty string, even with nothing measured", () => {
    const line = explainBoundary({ reason: "gap", measured: {} });
    expect(line).toBe("gap");
  });
});

describe("boundaryLine", () => {
  it("prefixes the end with its rule when the session is sealed", () => {
    expect(
      boundaryLine("END", { reason: "debounce", measured: { idle_ms: 45 * MINUTE, debounce_ms: 45 * MINUTE } }, "sealed"),
    ).toBe("END: debounce 45m idle ≥ 45m");
  });

  it("says WHY an open session has no end rule, rather than leaving a blank", () => {
    expect(boundaryLine("END", null, "open")).toBe("END: open — no end rule has fired yet");
  });

  it("marks a missing start boundary as missing rather than inventing one", () => {
    expect(boundaryLine("START", null, "sealed")).toBe("START: not recorded");
  });
});

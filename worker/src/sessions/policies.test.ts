import { describe, expect, it } from "vitest";

import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import {
  BOUNDARY_REASONS,
  CHARS_PER_TOKEN,
  crossesDayBoundary,
  isBoundaryReason,
  KIND_DEFAULTS,
  localDayKey,
  parseOverride,
  registrableDomain,
  resolvePolicy,
  SEAL_MODES,
  tokensOfChars,
} from "./policies.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("the five stream-kind policies (§2.1, §10.4)", () => {
  it("has a default for every kind and nothing else", () => {
    expect(Object.keys(KIND_DEFAULTS).sort()).toEqual([
      "activity",
      "ambient",
      "bounded",
      "conversation",
      "document",
    ]);
  });

  it("states §10.4's numbers for CONVERSATION", () => {
    const p = KIND_DEFAULTS.conversation;
    expect(p.gap_ms).toBe(6 * HOUR);
    expect(p.shift_min_gap_ms).toBe(1 * HOUR);
    expect(p.size_cap_events).toBe(40);
    expect(tokensOfChars(p.size_cap_chars)).toBe(6_000);
    expect(p.day_boundary).toBe(true);
    expect(p.participant_shift).toBe(true);
    expect(p.ceiling_ms).toBe(24 * HOUR);
    expect(p.debounce_ms).toBe(45 * MINUTE);
  });

  it("states §10.4's numbers for DOCUMENT, ACTIVITY and AMBIENT", () => {
    expect(KIND_DEFAULTS.document.gap_ms).toBe(45 * MINUTE);
    expect(KIND_DEFAULTS.document.size_cap_events).toBe(200);
    expect(KIND_DEFAULTS.document.author_shift).toBe(true);

    expect(KIND_DEFAULTS.activity.gap_ms).toBe(30 * MINUTE);
    expect(KIND_DEFAULTS.activity.size_cap_events).toBe(100);
    expect(KIND_DEFAULTS.activity.transaction_isolates).toBe(true);

    expect(KIND_DEFAULTS.ambient.silence_ms).toBe(90_000);
    expect(KIND_DEFAULTS.ambient.active_cap_ms).toBe(10 * MINUTE);
    expect(KIND_DEFAULTS.ambient.ceiling_ms).toBe(15 * MINUTE);
  });

  it("exempts BOUNDED from every cap — the record IS the session", () => {
    const p = KIND_DEFAULTS.bounded;
    expect(p.caps_apply).toBe(false);
    expect(p.size_cap_events).toBe(Infinity);
    expect(p.size_cap_chars).toBe(Infinity);
    expect(p.ceiling_ms).toBe(Infinity);
  });
});

describe("resolvePolicy — the manifest is the authority, not a constant here", () => {
  const seg = WHATSAPP_MANIFEST.segmentation;

  it("takes its windows from the adapter manifest", () => {
    const p = resolvePolicy({ kind: "conversation", segmentation: seg, lane: "dm" });
    expect(p.gap_ms).toBe(seg.gap_ms);
    expect(p.size_cap_events).toBe(seg.size_cap_events);
    expect(p.size_cap_chars).toBe(seg.size_cap_chars);
    expect(p.debounce_ms).toBe(seg.debounce_ms);
    expect(p.shift_min_gap_ms).toBe(seg.shift_min_gap_ms);
  });

  it("honours the per-lane gap override (dm 6h, group 4h)", () => {
    expect(resolvePolicy({ kind: "conversation", segmentation: seg, lane: "dm" }).gap_ms).toBe(6 * HOUR);
    expect(resolvePolicy({ kind: "conversation", segmentation: seg, lane: "group" }).gap_ms).toBe(4 * HOUR);
  });

  it("lets a source disagree with the kind default", () => {
    const p = resolvePolicy({
      kind: "conversation",
      segmentation: { ...seg, gap_ms: 90 * MINUTE, size_cap_events: 12, day_boundary: false },
      lane: "unknown",
    });
    expect(p.gap_ms).toBe(90 * MINUTE);
    expect(p.size_cap_events).toBe(12);
    expect(p.day_boundary).toBe(false);
  });

  it("never lets a manifest cap reach a BOUNDED lane", () => {
    const p = resolvePolicy({ kind: "bounded", segmentation: seg });
    expect(p.size_cap_events).toBe(Infinity);
    expect(p.size_cap_chars).toBe(Infinity);
    expect(p.caps_apply).toBe(false);
  });

  it("disables participant shift on a single-actor source (§2 fact 3)", () => {
    const p = resolvePolicy({ kind: "conversation", segmentation: seg, actor_model: "single_actor" });
    expect(p.participant_shift).toBe(false);
  });

  it("disables participant shift when there is no minimum gap to conjoin with", () => {
    const p = resolvePolicy({
      kind: "conversation",
      segmentation: seg,
      override: { shift_min_gap_ms: 0 },
    });
    expect(p.participant_shift).toBe(false);
  });

  it("lets the per-stream override win over the manifest", () => {
    const p = resolvePolicy({
      kind: "conversation",
      segmentation: seg,
      lane: "dm",
      override: { gap_ms: 2 * HOUR, participant_shift: false },
    });
    expect(p.gap_ms).toBe(2 * HOUR);
    expect(p.participant_shift).toBe(false);
  });

  it("rejects a kind that is not one of the five", () => {
    expect(() => resolvePolicy({ kind: "chat" as never })).toThrow(/unknown stream kind/);
  });
});

describe("parseOverride", () => {
  it("reads numbers and flags and ignores everything else", () => {
    expect(parseOverride('{"gap_ms":1000,"day_boundary":false,"nonsense":"x","gap_ms_by":1}')).toEqual({
      gap_ms: 1000,
      day_boundary: false,
    });
  });

  it("returns null for missing, empty, malformed and non-object JSON", () => {
    expect(parseOverride(null)).toBeNull();
    expect(parseOverride("  ")).toBeNull();
    expect(parseOverride("{not json")).toBeNull();
    expect(parseOverride("[1,2]")).toBeNull();
    expect(parseOverride("{}")).toBeNull();
  });

  it("ignores a negative window rather than segmenting by it", () => {
    expect(parseOverride('{"gap_ms":-5}')).toBeNull();
  });
});

describe("local midnight is computed in the STREAM's tz (§10.4 note 6)", () => {
  // 18:20Z and 18:31Z are the same UTC day and two different Kolkata days.
  const before = Date.parse("2026-08-10T18:20:00Z");
  const after = Date.parse("2026-08-10T18:31:00Z");

  it("cuts in Asia/Kolkata where UTC would not", () => {
    expect(localDayKey(before, "Asia/Kolkata")).toBe("2026-08-10");
    expect(localDayKey(after, "Asia/Kolkata")).toBe("2026-08-11");
    expect(crossesDayBoundary(before, after, "Asia/Kolkata")).toBe(true);
    expect(crossesDayBoundary(before, after, "UTC")).toBe(false);
  });

  it("answers per zone, so four streams can disagree about the same instant", () => {
    const zones = ["Asia/Kolkata", "America/New_York", "Europe/London", "Asia/Dubai"];
    const days = zones.map((tz) => localDayKey(after, tz));
    expect(new Set(days).size).toBeGreaterThan(1);
  });

  it("falls back to UTC for an unknown zone instead of throwing", () => {
    expect(localDayKey(before, "Mars/Olympus")).toBe(localDayKey(before, "UTC"));
  });
});

describe("registrableDomain — the ACTIVITY context key", () => {
  it("collapses subdomains and paths to one context", () => {
    expect(registrableDomain("https://www.zomato.com/order/12?x=1")).toBe("zomato.com");
    expect(registrableDomain("http://zomato.com")).toBe("zomato.com");
    expect(registrableDomain("https://m.airbnb.com/rooms/9")).toBe("airbnb.com");
  });

  it("keeps a multi-label public suffix whole", () => {
    expect(registrableDomain("https://shop.zomato.co.in/x")).toBe("zomato.co.in");
    expect(registrableDomain("https://bbc.co.uk")).toBe("bbc.co.uk");
  });

  it("returns null when there is no host to read", () => {
    expect(registrableDomain(null)).toBeNull();
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain("   ")).toBeNull();
  });
});

describe("vocabulary", () => {
  it("covers every reason the sessions table documents, plus §10.4's own two", () => {
    for (const reason of [
      "gap",
      "participant_shift",
      "reply_break",
      "size_cap",
      "day_boundary",
      "context_shift",
      "record_bounded",
      "ceiling",
      "debounce",
      "stream_start",
      "author_shift",
      "late_arrival",
    ]) {
      expect(isBoundaryReason(reason)).toBe(true);
    }
    expect(BOUNDARY_REASONS).toHaveLength(12);
    expect(isBoundaryReason("vibes")).toBe(false);
  });

  it("has exactly §10.4's three seal modes", () => {
    expect([...SEAL_MODES]).toEqual(["immediate", "debounce", "ceiling"]);
  });

  it("reports a char cap in the tokens §10.4 states", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(tokensOfChars(24_000)).toBe(6_000);
  });
});

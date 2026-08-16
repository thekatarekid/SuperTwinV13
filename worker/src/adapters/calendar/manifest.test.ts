// ===========================================================================
// Calendar manifest + Phase-5 flag-gated registration (build item 5.1; arch
// §2.1, §2.2; build doc §7 rule 2).
//
// What is under test is the thesis contract:
//   - the manifest passes the SAME generic validation WhatsApp passes,
//   - every lane is BOUNDED (§2.1 fam 2cal), declared as data,
//   - the bridge + identity vocabulary the later Phase-5 items join on
//     (email / url / attendee_set) is stated here and nowhere else,
//   - and registration is shut behind SUPERTWIN_PHASE5_CALENDAR=1, so the
//     default boot keeps EXACTLY ONE registered adapter.
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";

import {
  clearRegistry,
  registerSource,
  registeredSourceIds,
  validateManifest,
  type SourceManifest,
} from "../registry.js";
import type { SourceAdapter } from "../source-adapter.js";
import type { AdapterStatus } from "../types.js";
import { WHATSAPP_MANIFEST } from "../whatsapp/manifest.js";
import { CALENDAR_MANIFEST, CALENDAR_SOURCE_ID } from "./manifest.js";
import {
  CALENDAR_PHASE5_ENV,
  calendarPhase5Enabled,
  maybeRegisterCalendarSource,
} from "./register.js";

function stubAdapter(sourceId: string): SourceAdapter {
  return {
    sourceId,
    sourceType: sourceId,
    async connect() {},
    async startPairing() {},
    async backfill() {},
    async extend() {},
    async pause() {},
    async logout() {},
    async disconnect() {},
    onEvent() {},
    onStream() {},
    onActor() {},
    onStatus() {},
    getStatus(): AdapterStatus {
      return { state: "online", paired: true, paused: false };
    },
  };
}

afterEach(() => clearRegistry());

describe("CALENDAR_MANIFEST (arch §2.1, §2.2)", () => {
  it("passes the same generic validation whatsapp passes — no special case", () => {
    expect(validateManifest(CALENDAR_MANIFEST as unknown as SourceManifest<never>)).toEqual([]);
  });

  it("every lane is bounded (§2.1: session = the record, no inference)", () => {
    for (const kind of ["calendar", "dm", "group", "unknown", undefined]) {
      expect(CALENDAR_MANIFEST.stream_kind_of({ external_key: "x", kind })).toBe("bounded");
    }
  });

  it("states the §2.2 contract fields the Phase-5 items read", () => {
    expect(CALENDAR_MANIFEST.source_id).toBe("calendar");
    expect(CALENDAR_MANIFEST.actor_model).toBe("multi_actor");
    // How "me" appears here — an email — and it resolves lazily (null until
    // ingestion has persisted it; frozen-at-boot would be the bug).
    expect(CALENDAR_MANIFEST.self_identity.kind).toBe("email");
    expect(typeof CALENDAR_MANIFEST.self_identity.value_getter).toBe("function");
    // The [CODE]-rung merge surface with WhatsApp-side identities.
    expect(CALENDAR_MANIFEST.identities_emitted).toContain("email");
    // The two joins the thesis gate (5.4) crosses on, plus the identity bridge.
    expect(CALENDAR_MANIFEST.bridge_keys).toEqual(["url", "attendee_set", "email"]);
  });

  it("declares fixture-shaped capabilities: unordered snapshot backfill, no live tail", () => {
    const cap = CALENDAR_MANIFEST.capabilities;
    expect(cap.backfill).toBe(true);
    expect(cap.live).toBe(false);
    expect(cap.media).toBe(false);
    // An .ics file has no delivery order; the generic descending-cohort buffer
    // re-orders it — that is existing core code doing its declared job.
    expect(cap.backfill_order).toBe("unordered");
  });

  it("segmentation is data that cannot merge two records even if misapplied", () => {
    const seg = CALENDAR_MANIFEST.segmentation;
    expect(seg.size_cap_events).toBe(1); // session = the record
    expect(seg.participant_shift).toBe(false);
    expect(seg.day_boundary).toBe(false); // a multi-day event is one record
    expect(CALENDAR_MANIFEST.salience.prefilter).toBe("none"); // 10⁰–10¹/day
  });
});

describe("Phase-5 flag gate (build doc §7 rule 2)", () => {
  it("is OFF by default: no flag, no registration, whatsapp stays the only adapter", () => {
    registerSource({ manifest: WHATSAPP_MANIFEST, adapter: stubAdapter("whatsapp") });
    const res = maybeRegisterCalendarSource({}, {}); // empty env = shipped default
    expect(res).toBeNull();
    expect(registeredSourceIds()).toEqual(["whatsapp"]);
  });

  it('only exactly "1" enables it', () => {
    expect(calendarPhase5Enabled({})).toBe(false);
    expect(calendarPhase5Enabled({ [CALENDAR_PHASE5_ENV]: "true" })).toBe(false);
    expect(calendarPhase5Enabled({ [CALENDAR_PHASE5_ENV]: "0" })).toBe(false);
    expect(calendarPhase5Enabled({ [CALENDAR_PHASE5_ENV]: "1" })).toBe(true);
  });

  it("with the flag set, registers through the generic path alongside whatsapp", () => {
    registerSource({ manifest: WHATSAPP_MANIFEST, adapter: stubAdapter("whatsapp") });
    const res = maybeRegisterCalendarSource({}, { [CALENDAR_PHASE5_ENV]: "1" });
    expect(res).not.toBeNull();
    expect(res!.manifest.source_id).toBe(CALENDAR_SOURCE_ID);
    expect(res!.adapter.sourceId).toBe(CALENDAR_SOURCE_ID);
    expect(registeredSourceIds()).toEqual(["calendar", "whatsapp"]);
  });

  it("is idempotent: a second ask is a no-op, not a boot error", () => {
    const env = { [CALENDAR_PHASE5_ENV]: "1" };
    expect(maybeRegisterCalendarSource({}, env)).not.toBeNull();
    expect(maybeRegisterCalendarSource({}, env)).toBeNull();
    expect(registeredSourceIds()).toEqual(["calendar"]);
  });
});

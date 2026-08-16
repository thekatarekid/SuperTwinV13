// ===========================================================================
// Adapter registry + manifest validation (build item 1.1, arch §2.2).
//
// The registry's job is to fail at BOOT, loudly, on a manifest that would
// otherwise fail thousands of events later and look like a segmenter bug. So
// what is under test is mostly refusal: an unknown stream kind, a missing
// self_identity, an ambient source with no salience prefilter, an adapter whose
// id disagrees with its manifest, a second registration of the same source.
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";

import {
  ManifestError,
  assertManifest,
  clearRegistry,
  gapMsFor,
  getManifest,
  registerSource,
  registeredSourceIds,
  validateManifest,
  type SourceManifest,
  type StreamKind,
} from "./registry.js";
import type { SourceAdapter } from "./source-adapter.js";
import type { AdapterStatus } from "./types.js";
import { GAP_MS_DM, GAP_MS_GROUP, WHATSAPP_MANIFEST } from "./whatsapp/manifest.js";

// ---- Fixtures -------------------------------------------------------------

/** A manifest that passes, so every failing case differs in exactly one way. */
function goodManifest(over: Partial<SourceManifest<never>> = {}): SourceManifest<never> {
  return {
    source_id: "demo",
    display_name: "Demo",
    stream_kind_of: () => "conversation",
    actor_model: "multi_actor",
    self_identity: { kind: "handle", value_getter: () => "me" },
    streams: { key: () => "k", label: () => "l" },
    identities_emitted: ["handle"],
    capabilities: {
      backfill: true,
      live: true,
      media: false,
      revisions: false,
      edits: false,
      deletion: false,
      backfill_order: "desc",
      backfill_paged: true,
      page_hint_events: 100,
    },
    segmentation: {
      gap_ms: 3_600_000,
      size_cap_events: 40,
      size_cap_chars: 24_000,
      day_boundary: true,
      participant_shift: true,
      shift_min_gap_ms: 3_600_000,
      debounce_ms: 60_000,
    },
    enrichment: { kinds: ["link"], expected_latency_ms_p50: { link: 1_000 } },
    salience: { prefilter: "none" },
    bridge_keys: ["url"],
    ...over,
  } as SourceManifest<never>;
}

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

// ---- Refusals -------------------------------------------------------------

describe("validateManifest refuses what would break later", () => {
  it("accepts a well-formed manifest with no problems", () => {
    expect(validateManifest(goodManifest())).toEqual([]);
  });

  it("rejects a stream kind outside the five (§2.1)", () => {
    const bad = goodManifest({
      stream_kind_of: () => "chat" as unknown as StreamKind,
    });
    const problems = validateManifest(bad);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain('returned "chat"');
    expect(problems[0]).toContain("conversation | document | activity | ambient | bounded");
  });

  it("rejects a missing self_identity — the canonical me binds through it", () => {
    const bad = goodManifest({ self_identity: undefined as never });
    expect(validateManifest(bad)).toContain(
      'self_identity is required — the canonical "me" entity binds through it',
    );
  });

  it("rejects a self_identity with no value_getter", () => {
    const bad = goodManifest({
      self_identity: { kind: "jid", value_getter: undefined as never },
    });
    expect(validateManifest(bad)).toContain(
      "self_identity.value_getter must be a function () => string | null",
    );
  });

  it("rejects ambient + prefilter:none (§2.2 note 3)", () => {
    const bad = goodManifest({
      stream_kind_of: () => "ambient",
      salience: { prefilter: "none" },
    });
    const problems = validateManifest(bad);
    expect(problems.some((p) => p.includes('is "ambient" but'))).toBe(true);
    expect(problems.some((p) => p.includes("gated before segmentation"))).toBe(true);
  });

  it("accepts ambient WITH a prefilter", () => {
    const ok = goodManifest({
      stream_kind_of: () => "ambient",
      salience: { prefilter: "vad" },
    });
    expect(validateManifest(ok)).toEqual([]);
  });

  it("rejects an unknown backfill order, identity kind and bridge key", () => {
    const bad = goodManifest({
      capabilities: { ...goodManifest().capabilities, backfill_order: "random" as never },
      identities_emitted: ["fingerprint" as never],
      bridge_keys: ["vibes" as never],
    });
    const problems = validateManifest(bad);
    expect(problems.some((p) => p.startsWith("capabilities.backfill_order"))).toBe(true);
    expect(problems.some((p) => p.includes('unknown identity kind "fingerprint"'))).toBe(true);
    expect(problems.some((p) => p.includes('unknown key "vibes"'))).toBe(true);
  });

  it("rejects a non-positive segmentation window", () => {
    const bad = goodManifest({
      segmentation: { ...goodManifest().segmentation, gap_ms: 0, debounce_ms: -1 },
    });
    const problems = validateManifest(bad);
    expect(problems).toContain("segmentation.gap_ms must be a positive number");
    expect(problems).toContain("segmentation.debounce_ms must be a positive number");
  });

  it("rejects participant_shift on a single-actor source (§2 fact 3)", () => {
    const bad = goodManifest({ actor_model: "single_actor" });
    expect(validateManifest(bad)).toContain(
      "segmentation.participant_shift is meaningless for a single_actor source (§2 fact 3)",
    );
  });

  it("reports a throwing stream_kind_of instead of throwing out of validation", () => {
    const bad = goodManifest({
      stream_kind_of: () => {
        throw new Error("nope");
      },
    });
    expect(validateManifest(bad)[0]).toContain("stream_kind_of threw");
  });

  it("assertManifest throws a ManifestError carrying every problem", () => {
    const bad = goodManifest({ source_id: "", self_identity: undefined as never });
    try {
      assertManifest(bad);
      throw new Error("expected assertManifest to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---- Registration ---------------------------------------------------------

describe("registerSource", () => {
  it("registers a valid pair and hands the manifest back by id", () => {
    registerSource({ manifest: goodManifest(), adapter: stubAdapter("demo") });
    expect(registeredSourceIds()).toEqual(["demo"]);
    expect(getManifest("demo")?.display_name).toBe("Demo");
  });

  it("is a BOOT ERROR when the manifest is invalid — nothing is registered", () => {
    expect(() =>
      registerSource({
        manifest: goodManifest({ self_identity: undefined as never }),
        adapter: stubAdapter("demo"),
      }),
    ).toThrow(ManifestError);
    expect(registeredSourceIds()).toEqual([]);
  });

  it("refuses an adapter whose id disagrees with its manifest", () => {
    expect(() =>
      registerSource({ manifest: goodManifest(), adapter: stubAdapter("other") }),
    ).toThrow(/one source, one id/);
    expect(registeredSourceIds()).toEqual([]);
  });

  it("refuses a second registration of the same source id", () => {
    registerSource({ manifest: goodManifest(), adapter: stubAdapter("demo") });
    expect(() =>
      registerSource({ manifest: goodManifest(), adapter: stubAdapter("demo") }),
    ).toThrow(/already registered/);
    expect(registeredSourceIds()).toEqual(["demo"]);
  });
});

// ---- The one manifest that ships -----------------------------------------

describe("the WhatsApp manifest", () => {
  it("validates, and registers under exactly one id", () => {
    expect(validateManifest(WHATSAPP_MANIFEST as unknown as SourceManifest<never>)).toEqual([]);
    registerSource({ manifest: WHATSAPP_MANIFEST, adapter: stubAdapter("whatsapp") });
    expect(registeredSourceIds()).toEqual(["whatsapp"]);
  });

  it("says every chat is a conversation, whatever the lane looks like", () => {
    for (const kind of ["dm", "group", "broadcast", "unknown"]) {
      expect(WHATSAPP_MANIFEST.stream_kind_of({ external_key: "x", kind })).toBe("conversation");
    }
  });

  it("carries the segmentation defaults item 1.1 specifies", () => {
    const seg = WHATSAPP_MANIFEST.segmentation;
    expect(seg.gap_ms).toBe(6 * 60 * 60 * 1000);
    expect(seg.gap_ms_by_stream).toEqual({ dm: 6 * 60 * 60 * 1000, group: 4 * 60 * 60 * 1000 });
    expect(seg.shift_min_gap_ms).toBe(60 * 60 * 1000);
    expect(seg.size_cap_events).toBe(40);
    expect(seg.size_cap_chars).toBe(24_000);
    expect(seg.day_boundary).toBe(true);
    expect(seg.debounce_ms).toBe(45 * 60 * 1000);
  });

  it("asks for history newest-first, emits jid+phone, and bridges on the five keys", () => {
    expect(WHATSAPP_MANIFEST.capabilities.backfill_order).toBe("desc");
    expect(WHATSAPP_MANIFEST.actor_model).toBe("multi_actor");
    expect(WHATSAPP_MANIFEST.self_identity.kind).toBe("jid");
    expect(WHATSAPP_MANIFEST.identities_emitted).toEqual(["jid", "phone"]);
    expect(WHATSAPP_MANIFEST.salience.prefilter).toBe("none");
    expect(WHATSAPP_MANIFEST.bridge_keys).toEqual([
      "url",
      "phone",
      "email",
      "media_work_id",
      "order_id",
    ]);
  });

  it("gapMsFor picks the lane override, then the source default", () => {
    const m = WHATSAPP_MANIFEST as unknown as SourceManifest<never>;
    expect(gapMsFor(m, "dm")).toBe(GAP_MS_DM);
    expect(gapMsFor(m, "group")).toBe(GAP_MS_GROUP);
    expect(gapMsFor(m, "broadcast")).toBe(GAP_MS_DM);
    expect(gapMsFor(m, null)).toBe(GAP_MS_DM);
  });
});

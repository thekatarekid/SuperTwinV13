// Model discovery: what the picker is allowed to offer (defect 6).
//
// The two things worth pinning are the two that decide whether the feature is
// honest:
//
//   - the projection. A row must carry the VERSIONED id `--model` takes, the
//     per-million price, and only the reasoning levels the model genuinely
//     accepts — a dial offered on a model that has none is the defect this
//     replaced, in a new place.
//   - the FALLBACK. No `claude` on the box, or one whose catalogue this cannot
//     read, must produce the curated list and SAY so. A stale list served as a
//     live one is worse than no list.
//
// Nothing here spawns the CLI or calls a model: discovery reads bytes.

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CATALOG_MARKER,
  fallbackCatalog,
  findCatalogOffset,
  generationOf,
  mapClaudeProviderCatalogue,
  projectCatalog,
  readCatalogFrom,
  thinkingLevelsFor,
} from "./discovery.js";

// A catalogue in exactly the shape the CLI bundles one: a JS object literal,
// bare keys, `!0` for true, `1e6` for a number, a \u escape in the comment.
const CATALOG =
  '{"//":"Hand-maintained baked-in model catalog \\u2014 the source of truth ' +
  'for per-model provider IDs and metadata.",schema_version:1,' +
  "pricing_tiers:{tier_5_25:{input:5,output:25,cache_read:0.5,web_search:0.01}," +
  "haiku_35:{input:0.8,output:4}}," +
  "models:[" +
  '{id:"claude-3-5-haiku",family:"haiku",display_name:"Haiku 3.5",' +
  'provider_ids:{first_party:"claude-3-5-haiku-20241022",bedrock:null},' +
  'max_output_tokens:{default:8192,upper:8192},pricing:"haiku_35",hidden:!0,capabilities:[]},' +
  '{id:"claude-opus-4-5",family:"opus",display_name:"Opus 4.5",' +
  'provider_ids:{first_party:"claude-opus-4-5-20251101",vertex:"claude-opus-4-5@20251101"},' +
  "context:{window:200000,supports_1m_suffix:!0}," +
  'pricing:"tier_5_25",capabilities:["context_management"]},' +
  '{id:"claude-opus-5",family:"opus",display_name:"Opus 5",' +
  'provider_ids:{first_party:"claude-opus-5"},context:{window:1e6,native_1m:!0},' +
  'pricing:"tier_5_25",capabilities:["effort","max_effort","xhigh_effort",' +
  '"adaptive_thinking"],default_effort:"high",' +
  "effort_cost_index:{low:0.67,high:1,max:1.7}}" +
  "]," +
  'aliases:{opus:{default:"claude-opus-5",per_provider:{bedrock:"claude-opus-5"}},' +
  'ghost:{default:"claude-not-here"}},' +
  'defaults:{},best:"opus",latest_per_family:{opus:"claude-opus-5"},alias_migration:{}}';

function fixtureBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "st-discovery-"));
  const path = join(dir, "fake-claude");
  // Padded on both sides the way it sits inside a bundled executable, and long
  // enough that the marker does not begin at byte 0.
  writeFileSync(path, `${" ".repeat(9_000)}var N=${CATALOG};export{N};`);
  return path;
}

describe("finding the catalogue in the binary", () => {
  it("locates the marker past the head of the file and parses from it", () => {
    const path = fixtureBinary();
    try {
      const at = findCatalogOffset(path);
      expect(at).toBeGreaterThan(0);
      const raw = readCatalogFrom(path);
      expect(raw).not.toBeNull();
      expect(raw!.schema_version).toBe(1);
      // The `—` escape survived as one character, so the parser is
      // reading the string rather than counting braces past it.
      expect(String(raw!["//"])).toContain("—");
      expect(CATALOG_MARKER.startsWith('{"//":')).toBe(true);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("answers -1, not a wrong offset, for a file with no catalogue", () => {
    const dir = mkdtempSync(join(tmpdir(), "st-discovery-empty-"));
    const path = join(dir, "not-claude");
    writeFileSync(path, "just some bytes");
    try {
      expect(findCatalogOffset(path)).toBe(-1);
      expect(readCatalogFrom(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what a picker row says", () => {
  const rows = projectCatalog(readCatalogFrom(fixtureBinary())!);
  const byId = new Map(rows.map((r) => [r.id, r]));

  it("offers the VERSIONED id, never the moving family key", () => {
    // The catalogue keys on "claude-opus-4-5"; what `--model` is given is the
    // pinned first-party id, because the key moves and the id does not.
    expect(byId.has("claude-opus-4-5-20251101")).toBe(true);
    expect(byId.has("claude-opus-4-5")).toBe(false);
  });

  it("carries the per-million price both ways", () => {
    const opus = byId.get("claude-opus-4-5-20251101")!;
    expect(opus.inputPerMTok).toBe(5);
    expect(opus.outputPerMTok).toBe(25);
    const haiku = byId.get("claude-3-5-haiku-20241022")!;
    expect(haiku.inputPerMTok).toBe(0.8);
    expect(haiku.outputPerMTok).toBe(4);
  });

  it("carries the catalogue-derived output ceiling", () => {
    expect(byId.get("claude-3-5-haiku-20241022")!.maxOutputTokens).toBe(8192);
    expect(byId.get("claude-opus-4-5-20251101")!.maxOutputTokens).toBeNull();
  });

  it("gives a model with no reasoning dial an EMPTY level list", () => {
    // Haiku 3.5 predates extended thinking. Offering levels for it would be a
    // control that silently does nothing.
    expect(byId.get("claude-3-5-haiku-20241022")!.thinkingLevels).toEqual([]);
  });

  it("uses the effort ladder where the model claims it, the budget ladder otherwise", () => {
    const opus5 = byId.get("claude-opus-5")!;
    expect(opus5.effort).toBe(true);
    expect(opus5.thinkingLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(opus5.defaultThinking).toBe("high");

    const opus45 = byId.get("claude-opus-4-5-20251101")!;
    expect(opus45.effort).toBe(false);
    expect(opus45.thinkingLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps the family aliases, each naming the version it resolves to", () => {
    const alias = byId.get("opus")!;
    expect(alias.alias).toBe(true);
    expect(alias.resolvesTo).toBe("claude-opus-5");
    expect(alias.label).toContain("Opus 5");
    // An alias pointing at a model this catalogue does not carry is dropped
    // rather than offered as a dead option.
    expect(byId.has("ghost")).toBe(false);
  });

  it("refuses a catalogue with no models rather than serving an empty picker", () => {
    expect(() => projectCatalog({ models: [] })).toThrow(/no models/);
  });
});

describe("the reasoning ladder is derived, not listed", () => {
  it("reads xhigh and max as separate claims", () => {
    expect(thinkingLevelsFor("claude-sonnet-4-6", ["effort", "max_effort"])).toEqual({
      levels: ["off", "low", "medium", "high", "max"],
      effort: true,
    });
  });

  it("drops `off` for a model that rejects a disabled budget", () => {
    const { levels } = thinkingLevelsFor("claude-fable-5", [
      "effort",
      "max_effort",
      "xhigh_effort",
      "rejects_disabled_thinking",
    ]);
    expect(levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("reads a generation out of either id shape", () => {
    expect(generationOf("claude-3-5-haiku")).toBeCloseTo(3.5);
    expect(generationOf("claude-3-7-sonnet")).toBeCloseTo(3.7);
    expect(generationOf("claude-haiku-4-5")).toBeCloseTo(4.5);
    expect(generationOf("claude-opus-5")).toBe(5);
  });
});

describe("falling back", () => {
  it("serves the curated list and SAYS it is the curated list", async () => {
    // The production failure this has to survive: a `claude` that is there but
    // whose catalogue this cannot read — a newer build that moved it, a
    // different bundler, a shim on PATH.
    const dir = mkdtempSync(join(tmpdir(), "st-discovery-unreadable-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\nexec something-else\n");
    process.env.SUPERTWIN_CLAUDE_BIN = bin;
    // A fresh module graph, so the CLI-path cache in cli.ts resolves against
    // the override rather than whatever this machine settled on earlier.
    vi.resetModules();
    const mod = await import("./discovery.js");
    const catalog = mod.discoverClaudeModels();
    delete process.env.SUPERTWIN_CLAUDE_BIN;
    rmSync(dir, { recursive: true, force: true });

    expect(catalog.mode).toBe("fallback");
    expect(catalog.error).toBeTruthy();
    expect(catalog.models.length).toBeGreaterThan(0);
    // Every curated row is still a usable row: a version, a price, and a
    // reasoning list that is either real or honestly empty.
    for (const m of catalog.models) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.inputPerMTok).toBeGreaterThan(0);
      expect(m.outputPerMTok).toBeGreaterThan(0);
    }
    // The aliases every pre-fix install has persisted are still valid ids.
    for (const id of ["haiku", "sonnet", "opus"]) {
      expect(catalog.models.some((m) => m.id === id)).toBe(true);
    }
  });

  it("labels the curated catalogue as curated", () => {
    const c = fallbackCatalog("nothing to read");
    expect(c.mode).toBe("fallback");
    expect(c.source).toMatch(/curated/);
    expect(c.error).toBe("nothing to read");
  });
});

describe("provider-neutral Claude mapping", () => {
  const specific = projectCatalog(readCatalogFrom(fixtureBinary())!);
  const legacy = {
    mode: "discovered" as const,
    source: "/fixture/claude",
    error: null,
    discoveredAt: "2026-09-08T00:00:00.000Z",
    defaultModelId: "opus",
    models: specific,
  };

  it("maps identity, defaults, limits, pricing and exact reasoning values", () => {
    const catalogue = mapClaudeProviderCatalogue(legacy);
    const byId = new Map(catalogue.models.map((model) => [model.id, model]));
    const haiku = byId.get("claude-3-5-haiku-20241022")!;
    const opus = byId.get("opus")!;

    expect(catalogue.providerId).toBe("claude-local");
    expect(catalogue.mode).toBe("discovered");
    expect(catalogue.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(opus.isDefault).toBe(true);
    expect(haiku).toMatchObject({
      displayName: "Haiku 3.5",
      hidden: true,
      inputModalities: ["text", "image"],
      reasoningValues: [],
      supportsTools: true,
      supportsHostTools: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: false,
      maxOutputTokens: 8192,
      billingLabel: "$0.8/MTok input · $4/MTok output",
    });
  });

  it("derives a stable revision from model capabilities, not discovery time", () => {
    const first = mapClaudeProviderCatalogue(legacy);
    const later = mapClaudeProviderCatalogue({
      ...legacy,
      source: "/another/claude",
      discoveredAt: "2026-09-09T00:00:00.000Z",
    });
    expect(later.revision).toBe(first.revision);
  });
});

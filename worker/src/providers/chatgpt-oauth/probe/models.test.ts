import { describe, expect, it } from "vitest";

import { buildContractProbeMatrix } from "./matrix.js";
import {
  parseProbeModelCatalogue,
  REQUESTED_PROBE_MODEL_ENV,
  selectRequestedProbeModel,
} from "./models.js";

describe("Phase 0b account model catalogue", () => {
  it("parses likely Codex/Hermes shapes, omits hidden entries, and invents no capabilities", () => {
    const catalogue = parseProbeModelCatalogue({
      models: [
        {
          slug: "gpt-capable",
          display_name: "GPT Capable",
          supported_reasoning_efforts: ["low", "unsupported", "high"],
          max_output_tokens: 8192,
          input_modalities: ["text", "image", "audio"],
          supports_tools: true,
          supports_parallel_tool_calls: false,
          supports_verbosity: true,
          supports_prompt_cache_key: true,
          supports_prompt_cache_options: true,
          supports_structured_output: true,
        },
        { id: "gpt-hidden", hidden: true, supports_tools: true },
        { model: "gpt-minimal" },
      ],
    });
    expect(catalogue.models).toEqual([
      {
        id: "gpt-capable",
        displayName: "GPT Capable",
        capabilities: {
          inputModalities: ["text", "image"],
          reasoningEfforts: ["low", "high"],
          maxOutputTokens: 8192,
          tools: true,
          parallelToolCalls: false,
          verbosity: true,
          promptCacheKey: true,
          promptCacheOptions: true,
          structuredOutput: true,
        },
      },
      { id: "gpt-minimal", capabilities: {} },
    ]);
  });

  it("accepts top-level arrays and data envelopes while deduplicating visible IDs", () => {
    expect(parseProbeModelCatalogue([{ id: "one" }, { id: "one" }]).models).toHaveLength(1);
    expect(parseProbeModelCatalogue({ data: [{ slug: "two", visibility: "visible" }] }).models[0]?.id).toBe("two");
  });

  it("omits unsafe IDs and hostile capability numerics from projected metadata", () => {
    expect(parseProbeModelCatalogue({ models: [
      { slug: "unsafe/model", max_output_tokens: 10 },
      { slug: "safe-model", max_output_tokens: Number.MAX_SAFE_INTEGER },
    ] }).models).toEqual([{ id: "safe-model", capabilities: {} }]);
  });

  it("requires an explicitly requested visible model from argument or environment", () => {
    const catalogue = parseProbeModelCatalogue({ models: [{ slug: "one" }, { slug: "two" }] });
    expect(() => selectRequestedProbeModel(catalogue, undefined, {})).toThrow(
      new RegExp(REQUESTED_PROBE_MODEL_ENV),
    );
    expect(selectRequestedProbeModel(catalogue, "two").id).toBe("two");
    expect(selectRequestedProbeModel(catalogue, undefined, { [REQUESTED_PROBE_MODEL_ENV]: "one" }).id).toBe("one");
    expect(() => selectRequestedProbeModel(catalogue, "hidden-or-missing")).toThrow(/unavailable or hidden/);
  });
});

describe("capability-gated contract matrix", () => {
  it("uses only the explicitly selected model and locally skips unsupported accepted probes", () => {
    const catalogue = parseProbeModelCatalogue({
      models: [
        { slug: "first", supports_tools: true },
        { slug: "requested", input_modalities: ["text"], supports_tools: false, supports_verbosity: false },
      ],
    });
    const matrix = buildContractProbeMatrix(catalogue, "requested");
    expect(matrix.filter((probe) => probe.name !== "allowlist.model.rejected")
      .every((probe) => probe.body.model === "requested")).toBe(true);
    for (const name of ["allowlist.tools.accepted", "focused.tool-call", "focused.image-input"]) {
      const probe = matrix.find((candidate) => candidate.name === name)!;
      expect(probe.disposition).toBe("unsupported-skip");
      expect(probe.body).not.toHaveProperty("tools");
    }
    const text = matrix.find((probe) => probe.name === "allowlist.text.accepted")!;
    expect(text.disposition).toBe("post");
    expect(JSON.stringify(text.body)).not.toContain("verbosity");
  });

  it("emits only catalogue-declared reasoning, image, tool, verbosity, cache, and output capabilities", () => {
    const catalogue = parseProbeModelCatalogue({
      data: [{
        id: "capable",
        capabilities: {
          reasoning_efforts: ["medium"],
          max_output_tokens: 8,
          input_modalities: ["image"],
          tools: true,
          parallel_tool_calls: true,
          verbosity: true,
          prompt_cache_key: true,
          prompt_cache_options: true,
          structured_output: true,
        },
      }],
    });
    const matrix = buildContractProbeMatrix(catalogue, undefined, {
      [REQUESTED_PROBE_MODEL_ENV]: "capable",
    });
    expect(matrix.find((probe) => probe.name === "allowlist.reasoning.accepted")?.body.reasoning).toEqual({ effort: "medium" });
    expect(matrix.find((probe) => probe.name === "allowlist.text.accepted")?.body.text).toEqual({ format: { type: "text" }, verbosity: "low" });
    expect(matrix.find((probe) => probe.name === "focused.image-input")?.disposition).toBe("post");
    expect(matrix.find((probe) => probe.name === "focused.cache-explicit")?.disposition).toBe("post");
    expect(matrix.filter((probe) => probe.expectation !== "rejected").every((probe) => probe.body.max_output_tokens === 8)).toBe(true);
    const ladderBodies = matrix.filter((probe) => probe.category === "ladder").map((probe) => probe.body);
    expect(new Set(ladderBodies.map((body) => JSON.stringify(body)))).toHaveLength(1);
    expect(ladderBodies[0]).toMatchObject({
      prompt_cache_key: "supertwin-phase0b-ladder-v1",
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    });
    const body = (name: string) => matrix.find((probe) => probe.name === name)!.body;
    expect(body("focused.cache-none")).toEqual(body("allowlist.minimum-envelope.accepted"));
    expect(body("focused.cache-implicit")).toEqual(body("allowlist.prompt_cache_key.accepted"));
    expect(body("focused.cache-explicit")).toEqual(body("allowlist.prompt_cache_options.accepted"));
    expect(JSON.stringify(body("focused.cache-none")).length).toBeGreaterThan(12_000);
  });
});

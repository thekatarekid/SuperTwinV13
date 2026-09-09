import { describe, expect, it } from "vitest";

import {
  buildPhase0bAuthorizationPlan,
  PHASE0B_MATRIX_VERSION,
  phase0bAuthorizationPlanFromCases,
} from "./authorization-plan.js";
import { buildContractProbeMatrix, PHASE0B_V4_PREFIX_RESERVATIONS } from "./matrix.js";
import type { ProbeModelCatalogue } from "./models.js";

const catalogue: ProbeModelCatalogue = {
  models: [{
    id: "gpt-probe",
    capabilities: {
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "high"],
      maxOutputTokens: 128,
      tools: true,
      parallelToolCalls: true,
      verbosity: true,
      promptCacheKey: true,
      promptCacheOptions: true,
      structuredOutput: true,
    },
  }],
};
const planEnv = { SUPERTWIN_APP_VERSION: "13.12.2" };

describe("Phase 0b authorization plan fingerprint", () => {
  it("binds the full capable matrix and immutable prefix to one deterministic digest", () => {
    const first = buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", planEnv);
    const second = buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", planEnv);
    expect(first).toEqual(second);
    expect(first).toEqual({
      matrixVersion: PHASE0B_MATRIX_VERSION,
      matrixHash: "900f6a6791cfa023362722a2adfda39aa2223c3b21257867105fde1edb9eda0a",
      caseCount: 70,
      inferencePostCount: 43,
      inferenceRetries: 0,
      prefixCheckpoint: { consumedPosts: 13, lastSequence: 21, predecessorRevision: 3,
        predecessorConsumedPosts: 5, reservations: PHASE0B_V4_PREFIX_RESERVATIONS },
    });
  });

  it("changes when a valid posted request body changes", () => {
    const cases = buildContractProbeMatrix(catalogue, "gpt-probe", {}, true);
    const original = phase0bAuthorizationPlanFromCases(cases, planEnv);
    const changed = cases.map((probe) => probe.sequence === 1
      ? {
        ...probe,
        body: {
          ...probe.body,
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "A different synthetic canary." }],
          }],
        },
      }
      : probe);
    expect(phase0bAuthorizationPlanFromCases(changed, planEnv).matrixHash).not.toBe(original.matrixHash);

    const reordered = cases.map((probe) => probe.sequence === 1
      ? { ...probe, body: Object.fromEntries(Object.entries(probe.body).reverse()) }
      : probe);
    expect(phase0bAuthorizationPlanFromCases(reordered, planEnv).matrixHash).toBe(original.matrixHash);
  });

  it("changes with model capabilities and accounts for unsupported no-fetch cases", () => {
    const sparse: ProbeModelCatalogue = { models: [{ id: "gpt-probe", capabilities: {} }] };
    const full = buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", planEnv);
    const reduced = buildPhase0bAuthorizationPlan(sparse, "gpt-probe", planEnv);
    expect(reduced.matrixHash).not.toBe(full.matrixHash);
    expect(reduced.inferencePostCount).toBeLessThan(full.inferencePostCount);
    expect(reduced.caseCount).toBe(70);
  });

  it("binds the observed gpt-5.6-sol capability shape to the 37-POST v4 resume", () => {
    const liveShape: ProbeModelCatalogue = { models: [{
      id: "gpt-5.6-sol",
      capabilities: { inputModalities: ["text", "image"], parallelToolCalls: true },
    }] };
    expect(buildPhase0bAuthorizationPlan(liveShape, "gpt-5.6-sol", planEnv)).toEqual({
      matrixVersion: PHASE0B_MATRIX_VERSION,
      matrixHash: "5d0620739e82a1c8ea4bc610ed2afd91247c67554b4552a6d26a145172ccaa6b",
      caseCount: 70,
      inferencePostCount: 37,
      inferenceRetries: 0,
      prefixCheckpoint: { consumedPosts: 13, lastSequence: 21, predecessorRevision: 3,
        predecessorConsumedPosts: 5, reservations: PHASE0B_V4_PREFIX_RESERVATIONS },
    });
  });

  it("rejects incomplete matrices instead of fingerprinting a smaller plan", () => {
    const cases = buildContractProbeMatrix(catalogue, "gpt-probe", {}, true);
    expect(() => phase0bAuthorizationPlanFromCases(cases.slice(1), planEnv)).toThrow(/exactly 70/);
    const invalidDisposition = cases.map((probe) => probe.sequence === 1
      ? { ...probe, disposition: "preflight-reject" as const }
      : probe);
    expect(() => phase0bAuthorizationPlanFromCases(invalidDisposition, planEnv))
      .toThrow(/invalid disposition/);
    const skippedLadder = cases.map((probe) => probe.name === "ladder.1.1"
      ? { ...probe, disposition: "unsupported-skip" as const, unsupportedReason: "mutated skip" }
      : probe);
    expect(() => phase0bAuthorizationPlanFromCases(skippedLadder, planEnv))
      .toThrow(/Ladder fixture .* must be posted/);
  });

  it("binds the exact endpoint, identity-header contract, and concrete app version", () => {
    const current = buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", planEnv);
    const otherVersion = buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", {
      SUPERTWIN_APP_VERSION: "13.12.3",
    });
    expect(otherVersion.matrixHash).not.toBe(current.matrixHash);
    expect(() => buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", {}))
      .toThrow(/concrete app version/);
    expect(() => buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", {
      SUPERTWIN_APP_VERSION: "not-semver",
    })).toThrow(/concrete app version/);
  });

  it("ignores irrelevant catalogue order and refuses non-JSON request values", () => {
    const withAnotherModel: ProbeModelCatalogue = {
      models: [{ id: "unused-model", capabilities: {} }, ...catalogue.models],
    };
    expect(buildPhase0bAuthorizationPlan(withAnotherModel, "gpt-probe", planEnv).matrixHash)
      .toBe(buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", planEnv).matrixHash);
    const cases = buildContractProbeMatrix(catalogue, "gpt-probe", {}, true);
    const invalid = cases.map((probe) => probe.sequence === 1
      ? { ...probe, body: { ...probe.body, input: [1n] } }
      : probe);
    expect(() => phase0bAuthorizationPlanFromCases(invalid, planEnv)).toThrow(/non-JSON/);
    const custom = cases.map((probe) => probe.sequence === 1
      ? { ...probe, body: { ...probe.body, input: [new Date(0)] } }
      : probe);
    expect(() => phase0bAuthorizationPlanFromCases(custom, planEnv)).toThrow(/non-plain object/);
  });
});

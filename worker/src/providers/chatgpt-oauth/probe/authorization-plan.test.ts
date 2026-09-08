import { describe, expect, it } from "vitest";

import {
  buildPhase0bAuthorizationPlan,
  PHASE0B_MATRIX_VERSION,
  phase0bAuthorizationPlanFromCases,
} from "./authorization-plan.js";
import { buildContractProbeMatrix } from "./matrix.js";
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
  it("binds the full capable matrix to one deterministic 70-case/55-POST digest", () => {
    const first = buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", planEnv);
    const second = buildPhase0bAuthorizationPlan(catalogue, "gpt-probe", planEnv);
    expect(first).toEqual(second);
    expect(first).toEqual({
      matrixVersion: PHASE0B_MATRIX_VERSION,
      matrixHash: "3c0a8fb94c1e19de6ec991e7c665045403bcf64bd24c3ad633f351bd451769a2",
      caseCount: 70,
      inferencePostCount: 55,
      inferenceRetries: 0,
    });
  });

  it("changes when a valid posted request body changes", () => {
    const cases = buildContractProbeMatrix(catalogue, "gpt-probe", {});
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

  it("binds the observed gpt-5.6-sol capability shape to the revised 45-POST plan", () => {
    const liveShape: ProbeModelCatalogue = { models: [{
      id: "gpt-5.6-sol",
      capabilities: { inputModalities: ["text", "image"], parallelToolCalls: true },
    }] };
    expect(buildPhase0bAuthorizationPlan(liveShape, "gpt-5.6-sol", planEnv)).toEqual({
      matrixVersion: PHASE0B_MATRIX_VERSION,
      matrixHash: "a6c50fd7c7725b65525d35db1e9ad4d3060619be5e7e405ead68cf19d2555b09",
      caseCount: 70,
      inferencePostCount: 45,
      inferenceRetries: 0,
    });
  });

  it("rejects incomplete matrices instead of fingerprinting a smaller plan", () => {
    const cases = buildContractProbeMatrix(catalogue, "gpt-probe", {});
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
    const cases = buildContractProbeMatrix(catalogue, "gpt-probe", {});
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

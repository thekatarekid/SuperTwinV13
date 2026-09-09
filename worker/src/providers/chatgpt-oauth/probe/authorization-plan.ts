import { createHash } from "node:crypto";

import {
  CODEX_RESPONSES_URL,
  CODEX_OAUTH_CLIENT_ID,
  FULL_PROBE_CASE_BUDGET,
  FULL_PROBE_INFERENCE_POST_BUDGET,
  HERMES_REFERENCE_COMMIT,
  superTwinUserAgent,
} from "./constants.js";
import {
  assertContractProbeMatrix,
  buildContractProbeMatrix,
  isPostedProbeCase,
  type ContractProbeCase,
} from "./matrix.js";
import type { ProbeModelCatalogue } from "./models.js";

export const PHASE0B_MATRIX_VERSION = "phase0b-contract-matrix-v3";
export const PHASE0B_INFERENCE_RETRIES = 0;

export interface Phase0bAuthorizationPlan {
  matrixVersion: typeof PHASE0B_MATRIX_VERSION;
  matrixHash: string;
  caseCount: typeof FULL_PROBE_CASE_BUDGET;
  inferencePostCount: number;
  inferenceRetries: typeof PHASE0B_INFERENCE_RETRIES;
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("Phase 0b authorization plan contains an unsafe number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new Error("Phase 0b authorization plan contains a sparse or extended array");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Phase 0b authorization plan contains a non-JSON value");
  }
  const source = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(source);
  const keys = Object.keys(source);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(source).length !== keys.length) {
    throw new Error("Phase 0b authorization plan contains a non-plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const entries = keys.sort().map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Phase 0b authorization plan contains an accessor");
    }
    const candidate = descriptor.value;
    if (candidate === undefined) throw new Error("Phase 0b authorization plan contains undefined");
    return `${JSON.stringify(key)}:${canonicalJson(candidate)}`;
  });
  return `{${entries.join(",")}}`;
}

function authorizedRequestBody(probe: ContractProbeCase): CanonicalJson {
  if (probe.name !== "allowlist.previous_response_id.accepted") return probe.body as CanonicalJson;
  if (probe.body.previous_response_id !== "resp_probe_previous") {
    throw new Error("Phase 0b continuation fixture has an invalid authorization placeholder");
  }
  return {
    ...probe.body,
    previous_response_id: { runtimeReference: "latest-completed-response-id-in-this-run" },
  } as CanonicalJson;
}

function canonicalCase(probe: ContractProbeCase): CanonicalJson {
  return {
    body: authorizedRequestBody(probe),
    category: probe.category,
    concurrency: probe.concurrency,
    disposition: probe.disposition ?? null,
    expectation: probe.expectation,
    name: probe.name,
    sequence: probe.sequence,
    stage: probe.stage,
    unsupportedReason: probe.unsupportedReason ?? null,
  };
}

export function phase0bAuthorizationPlanFromCases(
  cases: readonly ContractProbeCase[],
  env: NodeJS.ProcessEnv = process.env,
): Phase0bAuthorizationPlan {
  assertContractProbeMatrix(cases);
  const userAgent = superTwinUserAgent(env);
  if (!/^SuperTwinV13\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(userAgent)) {
    throw new Error("Phase 0b authorization plan requires a concrete app version");
  }
  const posted = cases.filter(isPostedProbeCase).length;
  if (posted < 1 || posted > FULL_PROBE_INFERENCE_POST_BUDGET) {
    throw new Error("Phase 0b authorization plan has an invalid inference POST count");
  }
  const payload: CanonicalJson = {
    cases: cases.map(canonicalCase),
    caseCount: FULL_PROBE_CASE_BUDGET,
    inferencePostCount: posted,
    inferenceRetries: PHASE0B_INFERENCE_RETRIES,
    matrixVersion: PHASE0B_MATRIX_VERSION,
    transport: {
      clientId: CODEX_OAUTH_CLIENT_ID,
      endpoint: CODEX_RESPONSES_URL,
      hermesReferenceCommit: HERMES_REFERENCE_COMMIT,
      method: "POST",
      redirect: "error",
      headers: [
        "accept:application/json",
        "authorization:bearer",
        "chatgpt-account-id:present",
        "content-type:application/json",
        "originator:supertwinv13",
        `user-agent:${userAgent}`,
        "session_id:fresh-independent-high-entropy-per-physical-request-bounded",
        "x-client-request-id:fresh-independent-high-entropy-per-physical-request-bounded",
      ],
    },
  };
  return Object.freeze({
    matrixVersion: PHASE0B_MATRIX_VERSION,
    matrixHash: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
    caseCount: FULL_PROBE_CASE_BUDGET,
    inferencePostCount: posted,
    inferenceRetries: PHASE0B_INFERENCE_RETRIES,
  });
}

export function buildPhase0bAuthorizationPlan(
  catalogue: ProbeModelCatalogue,
  requestedModel: string,
  env: NodeJS.ProcessEnv = process.env,
): Phase0bAuthorizationPlan {
  return phase0bAuthorizationPlanFromCases(
    buildContractProbeMatrix(catalogue, requestedModel, env),
    env,
  );
}

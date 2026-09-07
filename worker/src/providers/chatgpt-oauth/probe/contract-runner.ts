import { randomUUID } from "node:crypto";

import { accountFingerprint, accountIdFromAccessToken } from "./account.js";
import {
  CODEX_MODELS_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
  FULL_PROBE_CASE_BUDGET,
  FULL_PROBE_INFERENCE_POST_BUDGET,
} from "./constants.js";
import { runDeviceCodeFlow, type DeviceFlowHooks } from "./device-flow.js";
import {
  buildContractProbeMatrix,
  type ContractProbeCase,
  validateProbeRequestBody,
} from "./matrix.js";
import { redactProbeValue } from "./redact.js";
import { buildBackendHeaders } from "./requests.js";
import { consumeBoundedSse, type SseProbeEvidence } from "./sse.js";

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_INFERENCE_REQUEST_MS = 30_000;
const RESTRICTION_RE = /captcha|account.{0,20}flag|suspicious activity|verify.{0,20}(?:human|identity)/i;

export interface ContractProbeHooks extends DeviceFlowHooks {
  requestId?(): string;
}

export interface ContractCaseEvidence {
  sequence: number;
  name: string;
  category: ContractProbeCase["category"];
  expectation: ContractProbeCase["expectation"];
  concurrency: ContractProbeCase["concurrency"];
  status: number | "preflight-rejected";
  matchedExpectation: boolean;
  request: unknown;
  stream?: SseProbeEvidence;
  responseBytes?: number;
  preflightErrors?: string[];
}

export interface FullContractEvidence {
  mode: "contract-scaffold";
  persistedCredentials: false;
  inferenceRetries: 0;
  plannedInferencePosts: number;
  actualInferencePosts: number;
  accountFingerprint: string;
  modelCatalogue: { status: number; ids: string[]; responseBytes: number };
  quota: { status: number; topLevelKeys: string[]; responseBytes: number };
  cases: ContractCaseEvidence[];
}

class ContractRestrictionError extends Error {}

function boundedRequestId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("Probe request identifier must be 1-128 safe ASCII characters");
  }
  return value;
}

async function readBoundedText(response: Response, limit: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error(`Probe response exceeded ${limit} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } finally {
    reader.releaseLock();
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  hooks: ContractProbeHooks,
): Promise<{ status: number; value: unknown; bytes: number }> {
  const response = await hooks.fetch(url, {
    method: "GET",
    headers: { ...headers, Accept: "application/json" },
    signal: hooks.signal
      ? AbortSignal.any([AbortSignal.timeout(30_000), hooks.signal])
      : AbortSignal.timeout(30_000),
  });
  const { text, bytes } = await readBoundedText(response, MAX_JSON_RESPONSE_BYTES);
  if (response.status === 429 || RESTRICTION_RE.test(text)) {
    throw new ContractRestrictionError(`Contract probe stopped on upstream restriction (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`Contract metadata request failed (HTTP ${response.status})`);
  try {
    return { status: response.status, value: JSON.parse(text), bytes };
  } catch {
    throw new Error(`Contract metadata request returned invalid JSON (HTTP ${response.status})`);
  }
}

function modelIds(value: unknown): string[] {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(record?.data)
        ? record.data
        : [];
  const ids = candidates.flatMap((candidate) => {
    if (typeof candidate === "string") return [candidate];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const id = item.slug ?? item.id ?? item.model;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
  return [...new Set(ids)];
}

function topLevelKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

function matchesExpectation(
  probe: ContractProbeCase,
  response: Response,
  stream: SseProbeEvidence | undefined,
): boolean {
  if (probe.expectation === "rejected") return response.status >= 400 && response.status < 500;
  if (probe.expectation === "cancelled") return response.ok && stream?.stoppedEarly === true;
  if (!response.ok || stream?.completed !== true || stream.failed || stream.incomplete || stream.error) {
    return false;
  }
  return probe.category !== "canary" || stream.substantiveDeltaCount > 0;
}

function preflightRejectionEvidence(probe: ContractProbeCase): ContractCaseEvidence {
  const preflightErrors = validateProbeRequestBody(probe.body);
  if (!preflightErrors.length) throw new Error(`Negative fixture ${probe.name} unexpectedly passed preflight`);
  return {
    sequence: probe.sequence,
    name: probe.name,
    category: probe.category,
    expectation: probe.expectation,
    concurrency: probe.concurrency,
    status: "preflight-rejected",
    matchedExpectation: true,
    request: redactProbeValue({ body: probe.body }),
    preflightErrors,
  };
}

async function executeCase(
  probe: ContractProbeCase,
  headers: Record<string, string>,
  hooks: ContractProbeHooks,
  controllers: Set<AbortController>,
  previousResponseId?: string,
): Promise<ContractCaseEvidence> {
  const controller = new AbortController();
  controllers.add(controller);
  const requestBody = probe.name === "allowlist.previous_response_id.accepted"
    ? { ...probe.body, previous_response_id: previousResponseId }
    : probe.body;
  if (probe.name === "allowlist.previous_response_id.accepted" && !previousResponseId) {
    throw new Error("Continuation probe requires a completed response ID from the canary");
  }
  const bodyText = JSON.stringify(requestBody);
  if (Buffer.byteLength(bodyText, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw new Error(`Probe request ${probe.name} exceeded the request-body limit`);
  }
  const requestHeaders = {
    ...headers,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    session_id: boundedRequestId(`phase0b-${probe.sequence}`),
    "x-client-request-id": boundedRequestId(hooks.requestId?.() ?? randomUUID()),
  };
  const requestSignals = [
    controller.signal,
    AbortSignal.timeout(MAX_INFERENCE_REQUEST_MS),
    hooks.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  try {
    const response = await hooks.fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: requestHeaders,
      body: bodyText,
      signal: AbortSignal.any(requestSignals),
    });
    if (response.status === 429) {
      for (const active of controllers) active.abort();
      throw new ContractRestrictionError("Contract probe stopped on HTTP 429");
    }

    const contentType = response.headers.get("content-type") ?? "";
    let stream: SseProbeEvidence | undefined;
    let responseBytes: number | undefined;
    if (contentType.includes("text/event-stream") && response.body) {
      stream = await consumeBoundedSse(response, {
        stopAfterFirstSubstantiveDelta: probe.expectation === "cancelled",
      });
      if (probe.expectation === "cancelled") controller.abort();
    } else {
      const bounded = await readBoundedText(response, MAX_ERROR_RESPONSE_BYTES);
      responseBytes = bounded.bytes;
      if (RESTRICTION_RE.test(bounded.text)) {
        for (const active of controllers) active.abort();
        throw new ContractRestrictionError(`Contract probe stopped on account restriction (HTTP ${response.status})`);
      }
    }

    const evidence: ContractCaseEvidence = {
      sequence: probe.sequence,
      name: probe.name,
      category: probe.category,
      expectation: probe.expectation,
      concurrency: probe.concurrency,
      status: response.status,
      matchedExpectation: matchesExpectation(probe, response, stream),
      request: redactProbeValue({ headers: requestHeaders, body: requestBody }),
      stream,
      responseBytes,
    };
    if (!evidence.matchedExpectation) {
      throw new Error(`Contract case ${probe.name} did not match its declared expectation`);
    }
    return evidence;
  } finally {
    controllers.delete(controller);
  }
}

async function executeMatrix(
  cases: readonly ContractProbeCase[],
  headers: Record<string, string>,
  hooks: ContractProbeHooks,
): Promise<ContractCaseEvidence[]> {
  const evidence: ContractCaseEvidence[] = [];
  const controllers = new Set<AbortController>();
  let previousResponseId: string | undefined;
  const serial = cases.filter((probe) => probe.category !== "ladder");
  for (const probe of serial) {
    const result = probe.expectation === "rejected"
      ? preflightRejectionEvidence(probe)
      : await executeCase(probe, headers, hooks, controllers, previousResponseId);
    evidence.push(result);
    if (result.stream?.eventTypes.includes("response.completed") && result.stream.responseId) {
      previousResponseId = result.stream.responseId;
    }
  }

  for (const concurrency of [1, 4, 8, 16] as const) {
    const stage = cases.filter(
      (probe) => probe.category === "ladder" && probe.concurrency === concurrency,
    );
    const results = await Promise.all(
      stage.map((probe) => executeCase(probe, headers, hooks, controllers)),
    );
    evidence.push(...results);
  }
  return evidence.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Offline-testable Phase 0b runner scaffold. The CLI deliberately does not
 * expose this until the remaining live safety and evidence gates are complete.
 */
export async function runContractProbeScaffold(
  hooks: ContractProbeHooks,
): Promise<FullContractEvidence> {
  const tokens = await runDeviceCodeFlow(hooks);
  const accountId = accountIdFromAccessToken(tokens.accessToken);
  const headers = buildBackendHeaders(tokens.accessToken, accountId, hooks.env ?? process.env);

  const modelsResponse = await fetchJson(CODEX_MODELS_URL, headers, hooks);
  const ids = modelIds(modelsResponse.value);
  if (!ids.length) throw new Error("Authenticated model catalogue contains no usable model IDs");
  const quotaResponse = await fetchJson(CODEX_USAGE_URL, headers, hooks);
  const matrix = buildContractProbeMatrix(ids[0]!);
  const cases = await executeMatrix(matrix, headers, hooks);
  const actualInferencePosts = cases.filter((probe) => probe.status !== "preflight-rejected").length;
  if (cases.length !== FULL_PROBE_CASE_BUDGET ||
      actualInferencePosts !== FULL_PROBE_INFERENCE_POST_BUDGET) {
    throw new Error("Phase 0b runner did not execute its declared cases and POSTs exactly once");
  }

  return {
    mode: "contract-scaffold",
    persistedCredentials: false,
    inferenceRetries: 0,
    plannedInferencePosts: FULL_PROBE_INFERENCE_POST_BUDGET,
    actualInferencePosts,
    accountFingerprint: accountFingerprint(accountId),
    modelCatalogue: { status: modelsResponse.status, ids, responseBytes: modelsResponse.bytes },
    quota: {
      status: quotaResponse.status,
      topLevelKeys: topLevelKeys(quotaResponse.value),
      responseBytes: quotaResponse.bytes,
    },
    cases,
  };
}

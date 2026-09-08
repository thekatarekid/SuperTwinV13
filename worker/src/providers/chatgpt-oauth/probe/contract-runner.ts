import { randomUUID } from "node:crypto";

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
  PROBED_ALLOWLIST_FIELDS,
  type ContractProbeCase,
  validateProbeRequestBody,
} from "./matrix.js";
import { parseProbeModelCatalogue, selectRequestedProbeModel } from "./models.js";
import { redactProbeValue } from "./redact.js";
import { buildBackendHeaders } from "./requests.js";
import { assertLiveContractProbeAccount, assertLiveContractProbePreflight } from "./safety.js";
import { consumeBoundedSse, type SseProbeEvidence } from "./sse.js";
import { EphemeralProbeTokenSession, ProbeAuthError, type SafeSessionEvidence } from "./refresh.js";
import {
  compareProbeQuota,
  parseProbeQuota,
  type ProbeQuotaComparison,
  type ProbeQuotaEvidence,
} from "./quota.js";
import {
  LIVE_CONTRACT_HTTP_LIMITS,
  ProbeHttpAccounting,
  type ProbeHttpCounts,
} from "./accounting.js";
import {
  compareProbeCacheBehavior,
  summarizeProbeConcurrency,
  type ProbeCacheComparison,
  type ProbeConcurrencyMetrics,
  type SanitizedProbeMetric,
} from "./metrics.js";
import { enforceScratchHomeInvariant } from "./scratch.js";
import { hasModelCatalogueRestrictionSignal } from "./restriction.js";

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_INFERENCE_REQUEST_MS = 30_000;
const RESTRICTION_RE = /(?:rate[_ -]?limit(?:ed|.{0,30}(?:exceed|restrict|error))|quota.{0,24}(?:exceed|exhaust|restrict|error)|captcha|cloudflare|account.{0,24}(?:flag|restrict|warn|suspend)|subscription.{0,24}(?:restrict|cancel|suspend|disrupt)|token.{0,24}revok|suspicious activity|verify.{0,20}(?:human|identity))/i;

export interface ContractProbeHooks extends DeviceFlowHooks {
  requestId?(): string;
  measureNow?(): number;
  resourceSnapshot?(): { rssBytes: number; heapUsedBytes: number; activeSockets: number };
  onFinalized?(evidence: {
    httpActuals: ProbeHttpCounts;
    logout: SafeSessionEvidence;
    aborted: boolean;
  }): void;
}

export interface ContractCaseEvidence {
  sequence: number;
  name: string;
  category: ContractProbeCase["category"];
  expectation: ContractProbeCase["expectation"];
  concurrency: ContractProbeCase["concurrency"];
  status: number | "preflight-rejected" | "unsupported-skip";
  matchedExpectation: boolean;
  request: unknown;
  stream?: SseProbeEvidence;
  responseBytes?: number;
  preflightErrors?: string[];
  startedAtMs?: number;
  completedAtMs?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  activeSockets?: number;
}

type DiagnosticErrorTypeCategory =
  "invalid-request" | "authentication" | "permission" | "rate-limit" | "server" | "<unknown>";
type DiagnosticErrorCodeCategory =
  "invalid-value" | "invalid-type" | "unknown-parameter" | "missing-required-parameter" |
  "unsupported-value" | "context-length" | "rate-limit" | "quota" | "<unknown>";

export interface ContractCaseMismatchDiagnostic {
  status: number;
  contentTypeCategory: "event-stream" | "json" | "other" | "absent";
  eventCount: number;
  outputTextBytes: number;
  eventTypes: string[];
  nonSseBodyCategory?: "empty" | "json-error-envelope" | "json-other" | "non-json";
  nonSseResponseBytes?: number;
  nonSseError?: {
    paramRoot?: (typeof PROBED_ALLOWLIST_FIELDS)[number] | "<unknown>";
    typeCategory?: DiagnosticErrorTypeCategory;
    codeCategory?: DiagnosticErrorCodeCategory;
    mentionedRequestFields?: Array<(typeof PROBED_ALLOWLIST_FIELDS)[number]>;
  };
  flags: {
    responseOk: boolean;
    eventStream: boolean;
    bodyPresent: boolean;
    eventTypesTruncated: boolean;
    terminal: boolean;
    completed: boolean;
    incomplete: boolean;
    failed: boolean;
    error: boolean;
    restrictionSignal: boolean;
    substantiveOutput: boolean;
    usagePresent: boolean;
    stoppedEarly: boolean;
  };
}

export interface FullContractEvidence {
  mode: "contract-scaffold";
  persistedCredentials: false;
  scratchHomeProof: "no-residual-artifacts";
  inferenceRetries: 0;
  plannedInferencePosts: number;
  actualInferencePosts: number;
  accountFingerprint: string;
  modelCatalogue: { status: number; ids: string[]; selectedId: string; responseBytes: number };
  quota: ProbeQuotaEvidence & { status: number; responseBytes: number };
  finalQuota: ProbeQuotaEvidence & { status: number; responseBytes: number };
  quotaComparison: ProbeQuotaComparison;
  refresh: SafeSessionEvidence;
  logout: SafeSessionEvidence;
  httpActuals: ProbeHttpCounts;
  concurrency: ProbeConcurrencyMetrics;
  cache: ({
    supported: true;
    pairs: Array<{ mode: "none" | "implicit" | "explicit"; warmSequence: number; measuredSequence: number }>;
  } & ProbeCacheComparison) | { supported: false; reason: string };
  localListeningSocketsCreated: false;
  cases: ContractCaseEvidence[];
}

class ContractRestrictionError extends Error {}

const DIAGNOSTIC_EVENT_TYPES = new Set([
  "error",
  "response.created",
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.reasoning_summary_text.delta",
  "response.text.delta",
  "response.audio.delta",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_text.delta",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);
const MAX_DIAGNOSTIC_EVENT_TYPES = 64;
const DIAGNOSTIC_ERROR_PARAMS = new Set<string>(PROBED_ALLOWLIST_FIELDS);
const DIAGNOSTIC_ERROR_TYPE_CATEGORIES = new Map<string, DiagnosticErrorTypeCategory>([
  ["invalid_request_error", "invalid-request"],
  ["authentication_error", "authentication"],
  ["permission_error", "permission"],
  ["rate_limit_error", "rate-limit"],
  ["server_error", "server"],
  ["api_error", "server"],
]);
const DIAGNOSTIC_ERROR_CODE_CATEGORIES = new Map<string, DiagnosticErrorCodeCategory>([
  ["invalid_value", "invalid-value"],
  ["invalid_type", "invalid-type"],
  ["unknown_parameter", "unknown-parameter"],
  ["missing_required_parameter", "missing-required-parameter"],
  ["unsupported_value", "unsupported-value"],
  ["context_length_exceeded", "context-length"],
  ["rate_limit_exceeded", "rate-limit"],
  ["insufficient_quota", "quota"],
]);

export function classifyDiagnosticContentType(
  contentType: string | null | undefined,
): ContractCaseMismatchDiagnostic["contentTypeCategory"] {
  if (typeof contentType !== "string" || contentType.trim() === "") return "absent";
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "text/event-stream") return "event-stream";
  if (mediaType === "application/json" || (mediaType.includes("/") && mediaType.endsWith("+json"))) {
    return "json";
  }
  return "other";
}

function projectNonSseDiagnostic(raw: unknown, includeErrorProjection: boolean): Pick<
  ContractCaseMismatchDiagnostic,
  "nonSseBodyCategory" | "nonSseResponseBytes" | "nonSseError"
> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const candidate = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(candidate, "text") ||
      !Object.prototype.hasOwnProperty.call(candidate, "bytes") ||
      typeof candidate.text !== "string" || typeof candidate.bytes !== "number" ||
      !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0 ||
      candidate.bytes > MAX_ERROR_RESPONSE_BYTES ||
      Buffer.byteLength(candidate.text, "utf8") !== candidate.bytes) {
    return {};
  }
  const text = candidate.text;
  const nonSseResponseBytes = candidate.bytes;
  if (text.length === 0) return { nonSseBodyCategory: "empty", nonSseResponseBytes };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { nonSseBodyCategory: "non-json", nonSseResponseBytes };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !Object.prototype.hasOwnProperty.call(payload, "error")) {
    return { nonSseBodyCategory: "json-other", nonSseResponseBytes };
  }
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return { nonSseBodyCategory: "json-other", nonSseResponseBytes };
  }
  const source = error as Record<string, unknown>;
  const base = { nonSseBodyCategory: "json-error-envelope" as const, nonSseResponseBytes };
  if (!includeErrorProjection) return base;
  const projection: NonNullable<ContractCaseMismatchDiagnostic["nonSseError"]> = {};
  if (Object.prototype.hasOwnProperty.call(source, "message") && typeof source.message === "string") {
    const messageTokens = new Set(source.message.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    const mentionedRequestFields = [...DIAGNOSTIC_ERROR_PARAMS]
      .filter((field) => messageTokens.has(field))
      .sort();
    if (mentionedRequestFields.length) {
      projection.mentionedRequestFields = mentionedRequestFields as Array<(typeof PROBED_ALLOWLIST_FIELDS)[number]>;
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, "param") && source.param !== null) {
    const root = typeof source.param === "string"
      ? /^([A-Za-z_][A-Za-z0-9_]*)(?:$|[.[])/.exec(source.param)?.[1]
      : undefined;
    projection.paramRoot = root && DIAGNOSTIC_ERROR_PARAMS.has(root)
      ? root as (typeof PROBED_ALLOWLIST_FIELDS)[number]
      : "<unknown>";
  }
  if (Object.prototype.hasOwnProperty.call(source, "type") && source.type !== null) {
    projection.typeCategory = typeof source.type === "string"
      ? DIAGNOSTIC_ERROR_TYPE_CATEGORIES.get(source.type) ?? "<unknown>"
      : "<unknown>";
  }
  if (Object.prototype.hasOwnProperty.call(source, "code") && source.code !== null) {
    projection.codeCategory = typeof source.code === "string"
      ? DIAGNOSTIC_ERROR_CODE_CATEGORIES.get(source.code) ?? "<unknown>"
      : "<unknown>";
  }
  return {
    ...base,
    ...(Object.keys(projection).length ? { nonSseError: projection } : {}),
  };
}

function boundedDiagnosticCount(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

export function buildContractCaseMismatchDiagnostic(
  response: Pick<Response, "status" | "ok" | "body">,
  contentType: string | null | undefined,
  stream?: SseProbeEvidence,
  rawNonSse?: unknown,
): ContractCaseMismatchDiagnostic {
  const eventTypes = stream?.eventTypes ?? [];
  const contentTypeCategory = classifyDiagnosticContentType(contentType);
  const eventStream = contentTypeCategory === "event-stream";
  return {
    status: response.status,
    contentTypeCategory,
    eventCount: boundedDiagnosticCount(stream?.eventCount, 10_000),
    outputTextBytes: boundedDiagnosticCount(stream?.outputTextBytes, 2 * 1024 * 1024),
    eventTypes: eventTypes.slice(0, MAX_DIAGNOSTIC_EVENT_TYPES).map(
      (type) => DIAGNOSTIC_EVENT_TYPES.has(type) ? type : "<unknown>",
    ),
    ...(rawNonSse
      ? projectNonSseDiagnostic(
        rawNonSse,
        response.status === 400 && contentTypeCategory === "json",
      )
      : {}),
    flags: {
      responseOk: response.ok,
      eventStream,
      bodyPresent: response.body !== null,
      eventTypesTruncated: eventTypes.length > MAX_DIAGNOSTIC_EVENT_TYPES,
      terminal: stream?.terminal ?? false,
      completed: stream?.completed ?? false,
      incomplete: stream?.incomplete ?? false,
      failed: stream?.failed ?? false,
      error: stream?.error ?? false,
      restrictionSignal: stream?.restrictionSignal ?? false,
      substantiveOutput: stream?.substantiveOutput ?? false,
      usagePresent: stream?.usagePresent ?? false,
      stoppedEarly: stream?.stoppedEarly ?? false,
    },
  };
}

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

export async function fetchContractMetadataJson(
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
  if (response.status === 429) {
    throw new ContractRestrictionError(`Contract probe stopped on upstream restriction (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`Contract metadata request failed (HTTP ${response.status})`);
  try {
    return { status: response.status, value: JSON.parse(text), bytes };
  } catch {
    throw new Error(`Contract metadata request returned invalid JSON (HTTP ${response.status})`);
  }
}

function matchesExpectation(
  probe: ContractProbeCase,
  response: Response,
  stream: SseProbeEvidence | undefined,
): boolean {
  if (probe.expectation === "rejected") return response.status >= 400 && response.status < 500;
  if (probe.expectation === "cancelled") {
    return response.ok && stream?.stoppedEarly === true && stream.substantiveOutput;
  }
  if (!response.ok || stream?.completed !== true || stream.failed || stream.incomplete || stream.error) {
    return false;
  }
  if (!stream.substantiveOutput) return false;
  if (probe.name === "focused.strict-json") return stream.outputMatchesExactOkBooleanSchema;
  if (probe.name === "focused.tool-call") {
    return stream.invalidFunctionNameCount === 0 && stream.functionCalls.length === 1 && stream.functionCalls.some(
      (call) => call.name === "probe_echo" && call.argumentsMatchProbeEchoSchema,
    );
  }
  if (["focused.cache-none", "focused.cache-implicit", "focused.cache-explicit", "focused.usage-capture"].includes(probe.name)) {
    return stream.usagePresent && stream.usage?.inputTokens !== undefined &&
      stream.usage.outputTokens !== undefined;
  }
  return true;
}

function defaultResourceSnapshot(): { rssBytes: number; heapUsedBytes: number; activeSockets: number } {
  const memory = process.memoryUsage();
  const processWithHandles = process as typeof process & { _getActiveHandles?: () => unknown[] };
  const handles = processWithHandles._getActiveHandles?.() ?? [];
  const activeSockets = handles.filter((handle) =>
    Boolean(handle && typeof handle === "object" &&
      (handle as { constructor?: { name?: string } }).constructor?.name === "Socket"),
  ).length;
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, activeSockets };
}

export function contractListeningSocketCount(): number {
  const processWithHandles = process as typeof process & { _getActiveHandles?: () => unknown[] };
  return (processWithHandles._getActiveHandles?.() ?? []).filter((handle) =>
    Boolean(handle && typeof handle === "object" &&
      (handle as { listening?: boolean }).listening === true),
  ).length;
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

function unsupportedEvidence(probe: ContractProbeCase): ContractCaseEvidence {
  if (probe.disposition !== "unsupported-skip" || !probe.unsupportedReason) {
    throw new Error(`Probe ${probe.name} is missing its unsupported capability reason`);
  }
  return {
    sequence: probe.sequence,
    name: probe.name,
    category: probe.category,
    expectation: probe.expectation,
    concurrency: probe.concurrency,
    status: "unsupported-skip",
    matchedExpectation: true,
    request: { omitted: true },
    preflightErrors: [probe.unsupportedReason],
  };
}

export async function executeContractProbeCase(
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
  const startedAtMs = hooks.measureNow?.() ?? performance.now();
  const takeResourceSnapshot = hooks.resourceSnapshot ?? defaultResourceSnapshot;
  let resourcePeak = takeResourceSnapshot();
  const sampleResources = (): void => {
    const sample = takeResourceSnapshot();
    resourcePeak = {
      rssBytes: Math.max(resourcePeak.rssBytes, sample.rssBytes),
      heapUsedBytes: Math.max(resourcePeak.heapUsedBytes, sample.heapUsedBytes),
      activeSockets: Math.max(resourcePeak.activeSockets, sample.activeSockets),
    };
  };
  const resourceTimer = setInterval(sampleResources, 10);
  resourceTimer.unref();
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

    const contentType = response.headers.get("content-type");
    const contentTypeCategory = classifyDiagnosticContentType(contentType);
    let stream: SseProbeEvidence | undefined;
    let responseBytes: number | undefined;
    let rawNonSse: { text: string; bytes: number } | undefined;
    if (contentTypeCategory === "event-stream" && response.body) {
      stream = await consumeBoundedSse(response, {
        stopAfterFirstSubstantiveDelta: probe.expectation === "cancelled",
        onFirstSubstantiveDelta: probe.expectation === "cancelled"
          ? () => controller.abort(new Error("Phase 0b cancellation probe reached a substantive delta"))
          : undefined,
        isRequestAborted: () => controller.signal.aborted,
      });
      if (stream.restrictionSignal) {
        for (const active of controllers) active.abort();
        throw new ContractRestrictionError("Contract probe stopped on an SSE restriction signal");
      }
    } else {
      const bounded = await readBoundedText(response, MAX_ERROR_RESPONSE_BYTES);
      responseBytes = bounded.bytes;
      if (RESTRICTION_RE.test(bounded.text)) {
        for (const active of controllers) active.abort();
        throw new ContractRestrictionError(`Contract probe stopped on account restriction (HTTP ${response.status})`);
      }
      rawNonSse = bounded;
    }

    const measuredEnd = hooks.measureNow?.() ?? performance.now();
    const completedAtMs = measuredEnd > startedAtMs ? measuredEnd : startedAtMs + 0.001;
    sampleResources();
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
      startedAtMs,
      completedAtMs,
      ...resourcePeak,
    };
    if (!evidence.matchedExpectation) {
      const diagnostic = buildContractCaseMismatchDiagnostic(
        response,
        contentType,
        stream,
        rawNonSse,
      );
      throw new Error(
        `Contract case ${probe.name} did not match its declared expectation; ` +
        `safe_diagnostic=${JSON.stringify(diagnostic)}`,
      );
    }
    return evidence;
  } finally {
    clearInterval(resourceTimer);
    controllers.delete(controller);
  }
}

function sanitizeReturnedCases(cases: readonly ContractCaseEvidence[]): ContractCaseEvidence[] {
  return cases.map((probe) => probe.stream?.responseId
    ? { ...probe, stream: { ...probe.stream, responseId: "<redacted>" } }
    : probe);
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
    const result = probe.disposition === "unsupported-skip"
      ? unsupportedEvidence(probe)
      : probe.expectation === "rejected"
        ? preflightRejectionEvidence(probe)
        : await executeContractProbeCase(probe, headers, hooks, controllers, previousResponseId);
    evidence.push(result);
    if (result.stream?.eventTypes.includes("response.completed") && result.stream.responseId) {
      previousResponseId = result.stream.responseId;
    }
  }

  for (const concurrency of [1, 4, 8, 16] as const) {
    const stage = cases.filter(
      (probe) => probe.category === "ladder" && probe.concurrency === concurrency,
    );
    const pending = stage.map((probe) => executeContractProbeCase(probe, headers, hooks, controllers));
    let results: ContractCaseEvidence[];
    try {
      results = await Promise.all(pending);
    } catch (error) {
      for (const active of controllers) active.abort();
      await Promise.allSettled(pending);
      throw error;
    }
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
  const env = { ...(hooks.env ?? process.env) };
  assertLiveContractProbePreflight(env);
  return enforceScratchHomeInvariant(env, async () => {
  const listeningSocketsBefore = contractListeningSocketCount();
  const accounting = new ProbeHttpAccounting(LIVE_CONTRACT_HTTP_LIMITS);
  const probeAbort = new AbortController();
  const signals = [hooks.signal, probeAbort.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const probeHooks: ContractProbeHooks = {
    ...hooks,
    fetch: accounting.wrap(hooks.fetch, AbortSignal.any(signals)),
    signal: AbortSignal.any(signals),
  };
  let session: EphemeralProbeTokenSession | undefined;
  let primaryFailure: unknown;
  try {
  const tokens = await runDeviceCodeFlow(probeHooks);
  session = new EphemeralProbeTokenSession(tokens);
  const account = assertLiveContractProbeAccount(tokens.accessToken, probeHooks.env ?? process.env);
  const accountId = account.accountId;
  let headers = buildBackendHeaders(session.current().accessToken, accountId, probeHooks.env ?? process.env);

  const modelsResponse = await fetchContractMetadataJson(CODEX_MODELS_URL, headers, probeHooks);
  if (hasModelCatalogueRestrictionSignal(modelsResponse.value)) {
    throw new ContractRestrictionError(
      `Contract probe stopped on upstream restriction (HTTP ${modelsResponse.status})`,
    );
  }
  const catalogue = parseProbeModelCatalogue(modelsResponse.value);
  if (!catalogue.models.length) throw new Error("Authenticated model catalogue contains no usable model IDs");
  const selectedModel = selectRequestedProbeModel(catalogue, undefined, probeHooks.env ?? process.env);
  const quotaResponse = await fetchContractMetadataJson(CODEX_USAGE_URL, headers, probeHooks);
  const quotaEvidence = parseProbeQuota(quotaResponse.value);
  if (!quotaEvidence.healthy) throw new Error("Phase 0b account is quota-limited or restricted at start");
  const refreshed = await session.refresh(probeHooks);
  const refreshedAccount = assertLiveContractProbeAccount(
    refreshed.accessToken,
    probeHooks.env ?? process.env,
  );
  if (refreshedAccount.fingerprint !== account.fingerprint) {
    throw new Error("REFUSED: OAuth refresh changed the dedicated Phase 0b account");
  }
  headers = buildBackendHeaders(refreshed.accessToken, accountId, probeHooks.env ?? process.env);
  const refreshEvidence = session.evidence();
  const matrix = buildContractProbeMatrix(catalogue, selectedModel.id, probeHooks.env ?? process.env);
  const cases = await executeMatrix(matrix, headers, probeHooks);
  const evidenceInferencePosts = cases.filter(
    (probe) => probe.status !== "preflight-rejected" && probe.status !== "unsupported-skip",
  ).length;
  const matrixHttpActuals = accounting.snapshot();
  const actualInferencePosts = matrixHttpActuals.inference;
  if (cases.length !== FULL_PROBE_CASE_BUDGET ||
      actualInferencePosts > FULL_PROBE_INFERENCE_POST_BUDGET ||
      actualInferencePosts !== evidenceInferencePosts || matrixHttpActuals.other !== 0) {
    throw new Error("Phase 0b runner exceeded its declared case or POST ceiling");
  }
  const ladderMetrics: SanitizedProbeMetric[] = cases
    .filter((probe) => probe.category === "ladder")
    .map((probe) => ({
      concurrency: probe.concurrency,
      startedAtMs: probe.startedAtMs!,
      completedAtMs: probe.completedAtMs!,
      succeeded: probe.matchedExpectation,
      rateLimited: probe.status === 429,
      inputTokens: probe.stream?.usage?.inputTokens,
      outputTokens: probe.stream?.usage?.outputTokens,
      cachedInputTokens: probe.stream?.usage?.cachedInputTokens,
      cacheWriteInputTokens: probe.stream?.usage?.cacheWriteInputTokens,
      rssBytes: probe.rssBytes,
      heapUsedBytes: probe.heapUsedBytes,
      activeSockets: probe.activeSockets,
    }));
  const concurrency = summarizeProbeConcurrency(ladderMetrics);
  const cacheCases = ["none", "implicit", "explicit"].map((mode) => ({
    mode: mode as "none" | "implicit" | "explicit",
    evidence: cases.find((probe) => probe.name === `focused.cache-${mode}`),
  }));
  const cacheSupported = cacheCases.every(({ evidence }) => evidence?.status !== "unsupported-skip");
  const cachePairNames = [
    { mode: "none" as const, warm: "allowlist.minimum-envelope.accepted", measured: "focused.cache-none" },
    { mode: "implicit" as const, warm: "allowlist.prompt_cache_key.accepted", measured: "focused.cache-implicit" },
    { mode: "explicit" as const, warm: "allowlist.prompt_cache_options.accepted", measured: "focused.cache-explicit" },
  ];
  const cache = cacheSupported
    ? (() => {
      const pairs = cachePairNames.map(({ mode, warm, measured }) => {
        const warmCase = matrix.find((probe) => probe.name === warm);
        const measuredCase = matrix.find((probe) => probe.name === measured);
        if (!warmCase || !measuredCase || JSON.stringify(warmCase.body) !== JSON.stringify(measuredCase.body)) {
          throw new Error(`Phase 0b ${mode} cache probe is not a byte-identical warm/read pair`);
        }
        return { mode, warmSequence: warmCase.sequence, measuredSequence: measuredCase.sequence };
      });
      return {
        supported: true as const,
        pairs,
        ...compareProbeCacheBehavior(cacheCases.map(({ mode, evidence }) => ({
          mode,
          inputTokens: evidence!.stream!.usage!.inputTokens!,
          cachedInputTokens: evidence!.stream!.usage!.cachedInputTokens!,
          cacheWriteInputTokens: evidence!.stream!.usage!.cacheWriteInputTokens!,
        }))),
      };
    })()
    : { supported: false as const, reason: "selected model does not declare all cache modes" };
  const finalQuotaResponse = await fetchContractMetadataJson(CODEX_USAGE_URL, headers, probeHooks);
  const finalQuotaEvidence = parseProbeQuota(finalQuotaResponse.value);
  const quotaComparison = compareProbeQuota(quotaEvidence, finalQuotaEvidence);
  const finalHttpActuals = accounting.snapshot();
  if (finalHttpActuals.inference !== actualInferencePosts || finalHttpActuals.quota !== 2 ||
      finalHttpActuals.models !== 1 || finalHttpActuals.token !== 2 ||
      finalHttpActuals.deviceCode !== 1 || finalHttpActuals.other !== 0) {
    throw new Error("Phase 0b runner HTTP accounting did not match the declared contract flow");
  }
  session.logout();
  const logoutEvidence = session.evidence();
  try {
    session.current();
    throw new Error("Phase 0b logout failed to clear the in-memory session");
  } catch (error) {
    if (!(error instanceof ProbeAuthError) || error.code !== "AUTH_REQUIRED") throw error;
  }
  const listeningSocketsAfter = contractListeningSocketCount();
  if (listeningSocketsAfter > listeningSocketsBefore) {
    throw new Error("Phase 0b probe unexpectedly created a local listening socket");
  }

  return {
    mode: "contract-scaffold",
    persistedCredentials: false,
    scratchHomeProof: "no-residual-artifacts",
    inferenceRetries: 0,
    plannedInferencePosts: FULL_PROBE_INFERENCE_POST_BUDGET,
    actualInferencePosts,
    accountFingerprint: account.fingerprint,
    modelCatalogue: {
      status: modelsResponse.status,
      ids: catalogue.models.map((model) => model.id),
      selectedId: selectedModel.id,
      responseBytes: modelsResponse.bytes,
    },
    quota: {
      status: quotaResponse.status,
      responseBytes: quotaResponse.bytes,
      ...quotaEvidence,
    },
    finalQuota: {
      status: finalQuotaResponse.status,
      responseBytes: finalQuotaResponse.bytes,
      ...finalQuotaEvidence,
    },
    quotaComparison,
    refresh: refreshEvidence,
    logout: logoutEvidence,
    httpActuals: finalHttpActuals,
    concurrency,
    cache,
    localListeningSocketsCreated: false,
    cases: sanitizeReturnedCases(cases),
  };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    probeAbort.abort(new Error("Phase 0b contract probe finished"));
    session?.logout();
    try {
      hooks.onFinalized?.({
        httpActuals: accounting.snapshot(),
        logout: session?.evidence() ?? {
          authenticated: false,
          hasRefreshToken: false,
          previousRecoveryPairAvailable: false,
        },
        aborted: probeAbort.signal.aborted,
      });
    } catch (finalizationError) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, finalizationError],
          "Phase 0b contract failed and finalization also failed",
          { cause: primaryFailure },
        );
      }
      throw finalizationError;
    }
  }
  });
}

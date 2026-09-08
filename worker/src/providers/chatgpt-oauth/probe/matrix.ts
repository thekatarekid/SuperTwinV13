import {
  FULL_PROBE_CASE_BUDGET,
  FULL_PROBE_CASE_BREAKDOWN,
} from "./constants.js";
import {
  selectRequestedProbeModel,
  type ProbeModel,
  type ProbeModelCatalogue,
} from "./models.js";

export type ProbeExpectation = "accepted" | "rejected" | "completed" | "cancelled";
export type ProbeCategory = "allowlist" | "focused" | "canary" | "cancellation" | "ladder";
export type ProbeConcurrency = 1 | 4 | 8 | 16;

export interface ContractProbeCase {
  sequence: number;
  name: string;
  category: ProbeCategory;
  expectation: ProbeExpectation;
  concurrency: ProbeConcurrency;
  stage: string;
  body: Record<string, unknown>;
  disposition?: "post" | "preflight-reject" | "unsupported-skip";
  unsupportedReason?: string;
}

export function isPostedProbeCase(probe: ContractProbeCase): boolean {
  return probe.disposition === "post";
}

export const PROBED_ALLOWLIST_FIELDS = [
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "max_output_tokens",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_options",
  "store",
  "stream",
] as const;

export const ALLOWED_REQUEST_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "max_output_tokens",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_options",
  "store",
  "stream",
]);

const tool = {
  type: "function",
  name: "probe_echo",
  description: "Return the supplied probe value.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  strict: true,
};

// Deliberately exceeds the usual 1,024-token cache threshold while containing
// no user or account data. Every warm/measured cache request reuses it byte-for-byte.
const CACHE_PROBE_PROMPT = `${"SuperTwin deterministic cache measurement prefix. ".repeat(256)}Reply with OK.`;

function baseline(model: string, prompt = "Reply with the single token OK."): Record<string, unknown> {
  return {
    model,
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    max_output_tokens: 16,
    store: false,
    stream: true,
  };
}

function withFields(
  model: string,
  fields: Record<string, unknown>,
  prompt?: string,
): Record<string, unknown> {
  return { ...baseline(model, prompt), ...fields };
}

function allowlistFixtures(model: string): ContractProbeCase[] {
  const fixtures: Array<{
    field: (typeof PROBED_ALLOWLIST_FIELDS)[number];
    accepted: Record<string, unknown>;
    rejected: Record<string, unknown>;
  }> = [
    { field: "model", accepted: { model }, rejected: { model: "" } },
    { field: "instructions", accepted: { instructions: "" }, rejected: { instructions: 42 } },
    { field: "input", accepted: { input: baseline(model).input }, rejected: { input: [] } },
    { field: "tools", accepted: { tools: [tool] }, rejected: { tools: [{ type: "web_search" }] } },
    {
      field: "tool_choice",
      accepted: { tools: [tool], tool_choice: "required" },
      rejected: { tool_choice: "required" },
    },
    {
      field: "parallel_tool_calls",
      accepted: { tools: [tool], tool_choice: "auto", parallel_tool_calls: false },
      rejected: { parallel_tool_calls: true },
    },
    { field: "reasoning", accepted: { reasoning: { effort: "low" } }, rejected: { reasoning: { summary: "auto" } } },
    { field: "text", accepted: { text: { format: { type: "text" } } }, rejected: { text: 42 } },
    { field: "max_output_tokens", accepted: { max_output_tokens: 16 }, rejected: { max_output_tokens: 0 } },
    {
      field: "previous_response_id",
      accepted: { previous_response_id: "resp_probe_previous" },
      rejected: { previous_response_id: "" },
    },
    {
      field: "prompt_cache_key",
      accepted: { prompt_cache_key: "supertwin-probe-static-v1" },
      rejected: { prompt_cache_key: "x".repeat(65) },
    },
    {
      field: "prompt_cache_options",
      accepted: { prompt_cache_options: { mode: "implicit", ttl: "30m" } },
      rejected: { prompt_cache_options: { mode: "invalid" } },
    },
    { field: "store", accepted: { store: false }, rejected: { store: true } },
    { field: "stream", accepted: { stream: true }, rejected: { stream: false } },
  ];

  return fixtures.flatMap(({ field, accepted, rejected }) => [
    {
      sequence: 0,
      name: `allowlist.${field}.accepted`,
      category: "allowlist",
      expectation: "accepted",
      concurrency: 1,
      stage: "allowlist-serial",
      body: withFields(model, accepted, `Accepted fixture for ${field}. Reply OK.`),
    },
    {
      sequence: 0,
      name: `allowlist.${field}.rejected`,
      category: "allowlist",
      expectation: "rejected",
      concurrency: 1,
      stage: "allowlist-serial",
      body: withFields(model, rejected, `Rejected fixture for ${field}.`),
    },
  ]);
}

function focusedFixtures(model: string): ContractProbeCase[] {
  const transparentPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const fixtures: Array<[string, Record<string, unknown>]> = [
    ["blank-instructions", { instructions: "" }],
    ["omitted-tools", {}],
    ["cache-none", {}],
    ["cache-implicit", { prompt_cache_key: "supertwin-probe-implicit", prompt_cache_options: { mode: "implicit", ttl: "30m" } }],
    ["cache-explicit", { prompt_cache_key: "supertwin-probe-explicit", prompt_cache_options: { mode: "explicit", ttl: "30m" } }],
    [
      "strict-json",
      {
        text: {
          format: {
            type: "json_schema",
            name: "supertwin_probe",
            strict: true,
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
          },
        },
      },
    ],
    [
      "image-input",
      {
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Describe this synthetic one-pixel image." },
              { type: "input_image", image_url: transparentPng },
            ],
          },
        ],
      },
    ],
    ["tool-call", { tools: [tool], tool_choice: "required", parallel_tool_calls: false }],
    ["usage-capture", {}],
  ];
  return fixtures.map(([name, fields]) => ({
    sequence: 0,
    name: `focused.${name}`,
    category: "focused",
    expectation: "completed",
    concurrency: 1,
    stage: "focused-serial",
    body: withFields(
      model,
      fields,
      name.startsWith("cache-") ? CACHE_PROBE_PROMPT : `Focused ${name} probe. Keep the response minimal.`,
    ),
  }));
}

function ladderFixtures(model: string): ContractProbeCase[] {
  return ([1, 4, 8, 16] as const).flatMap((concurrency) =>
    Array.from({ length: concurrency }, (_, index) => ({
      sequence: 0,
      name: `ladder.${concurrency}.${index + 1}`,
      category: "ladder" as const,
      expectation: "completed" as const,
      concurrency,
      stage: `ladder-${concurrency}`,
      body: baseline(model),
    })),
  );
}

function capabilityRequirement(probe: ContractProbeCase, model: ProbeModel): string | undefined {
  const capabilities = model.capabilities;
  if (["allowlist.tools.accepted", "allowlist.tool_choice.accepted", "focused.tool-call"].includes(probe.name) && capabilities.tools !== true) {
    return "model catalogue does not declare tool support";
  }
  if (probe.name === "allowlist.parallel_tool_calls.accepted" && capabilities.parallelToolCalls !== true) {
    return "model catalogue does not declare parallel tool-call support";
  }
  if (probe.name === "allowlist.reasoning.accepted" && !capabilities.reasoningEfforts?.length) {
    return "model catalogue does not declare reasoning efforts";
  }
  if (probe.name === "allowlist.max_output_tokens.accepted" && capabilities.maxOutputTokens === undefined) {
    return "model catalogue does not declare max-output-token support";
  }
  if (["allowlist.prompt_cache_key.accepted", "allowlist.prompt_cache_options.accepted", "focused.cache-implicit", "focused.cache-explicit"].includes(probe.name) &&
      (capabilities.promptCacheKey !== true || capabilities.promptCacheOptions !== true)) {
    return "model catalogue does not declare prompt-cache option support";
  }
  if (probe.name === "focused.image-input" && !capabilities.inputModalities?.includes("image")) {
    return "model catalogue does not declare image input support";
  }
  if (probe.name === "focused.strict-json" && capabilities.structuredOutput !== true) {
    return "model catalogue does not declare structured-output support";
  }
  return undefined;
}

function applyDeclaredOutputLimit(
  body: Record<string, unknown>,
  model: ProbeModel,
): Record<string, unknown> {
  if (model.capabilities.maxOutputTokens !== undefined) {
    return {
      ...body,
      max_output_tokens: Math.min(16, model.capabilities.maxOutputTokens),
    };
  }
  const { max_output_tokens: _omitted, ...withoutOutputLimit } = body;
  return withoutOutputLimit;
}

function applyModelCapabilities(probe: ContractProbeCase, model: ProbeModel): ContractProbeCase {
  if (probe.expectation === "rejected") return { ...probe, disposition: "preflight-reject" };
  const unsupportedReason = capabilityRequirement(probe, model);
  if (unsupportedReason) {
    return {
      ...probe,
      disposition: "unsupported-skip",
      unsupportedReason,
      body: applyDeclaredOutputLimit(
        baseline(model.id, `Skipped unsupported fixture ${probe.name}.`),
        model,
      ),
    };
  }
  let body = probe.body;
  if (probe.name === "allowlist.prompt_cache_key.accepted") {
    body = withFields(model.id, {
      prompt_cache_key: "supertwin-probe-implicit",
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    }, CACHE_PROBE_PROMPT);
  }
  if (probe.name === "allowlist.prompt_cache_options.accepted") {
    body = withFields(model.id, {
      prompt_cache_key: "supertwin-probe-explicit",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
    }, CACHE_PROBE_PROMPT);
  }
  if (probe.name === "allowlist.reasoning.accepted") {
    body = { ...body, reasoning: { effort: model.capabilities.reasoningEfforts![0] } };
  }
  if (probe.name === "allowlist.text.accepted" && model.capabilities.verbosity === true) {
    body = { ...body, text: { format: { type: "text" }, verbosity: "low" } };
  }
  body = applyDeclaredOutputLimit(body, model);
  if (probe.category === "ladder" && model.capabilities.promptCacheKey === true) {
    body = {
      ...body,
      prompt_cache_key: "supertwin-phase0b-ladder-v1",
      ...(model.capabilities.promptCacheOptions === true
        ? { prompt_cache_options: { mode: "implicit", ttl: "30m" } }
        : {}),
    };
  }
  return { ...probe, disposition: "post", body };
}

export function buildContractProbeMatrix(
  source: string | ProbeModelCatalogue,
  requestedModel?: string,
  env: NodeJS.ProcessEnv = process.env,
): ContractProbeCase[] {
  const selected = typeof source === "string"
    ? { id: source.trim(), capabilities: {} }
    : selectRequestedProbeModel(source, requestedModel, env);
  const model = selected.id;
  if (!model) throw new Error("A discovered model is required to build the Phase 0b matrix");
  const unordered: ContractProbeCase[] = [
    {
      sequence: 0,
      name: "canary.blank-context",
      category: "canary",
      expectation: "completed",
      concurrency: 1,
      stage: "canary",
      body: baseline(model, CACHE_PROBE_PROMPT),
    },
    {
      sequence: 0,
      name: "cancellation.first-event",
      category: "cancellation",
      expectation: "cancelled",
      concurrency: 1,
      stage: "cancellation",
      body: baseline(model, "Begin a short numbered list so cancellation can stop the stream."),
    },
    ...allowlistFixtures(model),
    {
      sequence: 0,
      name: "allowlist.minimum-envelope.accepted",
      category: "allowlist",
      expectation: "accepted",
      concurrency: 1,
      stage: "allowlist-serial",
      body: baseline(model, CACHE_PROBE_PROMPT),
    },
    {
      sequence: 0,
      name: "allowlist.unknown-field.rejected",
      category: "allowlist",
      expectation: "rejected",
      concurrency: 1,
      stage: "allowlist-serial",
      body: withFields(model, { metadata: { probe: true } }),
    },
    ...focusedFixtures(model),
    ...ladderFixtures(model),
  ];
  const cases = unordered.map((probe, index) =>
    applyModelCapabilities({ ...probe, sequence: index + 1 }, selected));
  assertContractProbeMatrix(cases);
  return cases;
}

export function assertContractProbeMatrix(cases: readonly ContractProbeCase[]): void {
  if (cases.length !== FULL_PROBE_CASE_BUDGET) {
    throw new Error(`Phase 0b matrix must contain exactly ${FULL_PROBE_CASE_BUDGET} cases`);
  }
  const expectedCategoryCounts: Record<ProbeCategory, number> = {
    allowlist: FULL_PROBE_CASE_BREAKDOWN.allowlistAcceptedAndRejected,
    focused: FULL_PROBE_CASE_BREAKDOWN.focusedBehavior,
    ladder: FULL_PROBE_CASE_BREAKDOWN.concurrencyLadder,
    canary: FULL_PROBE_CASE_BREAKDOWN.canary,
    cancellation: FULL_PROBE_CASE_BREAKDOWN.cancellation,
  };
  for (const [category, expected] of Object.entries(expectedCategoryCounts)) {
    if (cases.filter((probe) => probe.category === category).length !== expected) {
      throw new Error(`Phase 0b matrix has the wrong ${category} count`);
    }
  }
  const ladder = cases.filter((probe) => probe.category === "ladder");
  const ladderValues = [...new Set(ladder.map((probe) => probe.concurrency))];
  if (ladderValues.join(",") !== "1,4,8,16") {
    throw new Error("Phase 0b concurrency ladder must be exactly 1,4,8,16");
  }
  for (const field of PROBED_ALLOWLIST_FIELDS) {
    for (const expectation of ["accepted", "rejected"] as const) {
      const name = `allowlist.${field}.${expectation}`;
      if (cases.filter((probe) => probe.name === name).length !== 1) {
        throw new Error(`Phase 0b matrix is missing strict fixture ${name}`);
      }
    }
  }
  for (const control of ["allowlist.minimum-envelope.accepted", "allowlist.unknown-field.rejected"]) {
    if (cases.filter((probe) => probe.name === control).length !== 1) {
      throw new Error(`Phase 0b matrix is missing control ${control}`);
    }
  }
  const names = new Set<string>();
  for (const [index, probe] of cases.entries()) {
    if (probe.sequence !== index + 1) throw new Error("Phase 0b matrix sequence is not exact");
    if (names.has(probe.name)) throw new Error(`Phase 0b matrix contains duplicate case ${probe.name}`);
    names.add(probe.name);
    if (probe.category === "ladder" && !isPostedProbeCase(probe)) {
      throw new Error(`Ladder fixture ${probe.name} must be posted`);
    }
    if (probe.expectation === "rejected") {
      if (probe.disposition !== "preflight-reject") {
        throw new Error(`Rejected fixture ${probe.name} has an invalid disposition`);
      }
    } else if (probe.disposition === "unsupported-skip") {
      if (!probe.unsupportedReason) throw new Error(`Unsupported fixture ${probe.name} has no reason`);
    } else if (!isPostedProbeCase(probe) || probe.unsupportedReason !== undefined) {
      throw new Error(`Posted fixture ${probe.name} has an invalid disposition`);
    }
    const errors = validateProbeRequestBody(probe.body);
    if (probe.expectation === "rejected" && errors.length === 0) {
      throw new Error(`Rejected fixture ${probe.name} passed preflight validation`);
    }
    if (probe.expectation !== "rejected" && errors.length) {
      throw new Error(`Accepted fixture ${probe.name} failed preflight: ${errors.join(",")}`);
    }
  }
}

export function validateProbeRequestBody(body: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const unknown = Object.keys(body).filter((field) => !ALLOWED_REQUEST_FIELDS.has(field));
  if (unknown.length) errors.push(`unknown:${unknown.join(",")}`);
  if (typeof body.model !== "string" || !body.model.trim()) errors.push("model");
  if (typeof body.instructions !== "string") errors.push("instructions");
  if (!Array.isArray(body.input) || body.input.length === 0) errors.push("input");
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
      const item = candidate as Record<string, unknown>;
      return item.type !== "function" || item.strict !== true || typeof item.name !== "string";
    })) errors.push("tools");
  }
  if (body.tool_choice !== undefined &&
      (!Array.isArray(body.tools) || !["none", "auto", "required"].includes(String(body.tool_choice)))) {
    errors.push("tool_choice");
  }
  if (body.parallel_tool_calls !== undefined &&
      (!Array.isArray(body.tools) || typeof body.parallel_tool_calls !== "boolean")) {
    errors.push("parallel_tool_calls");
  }
  if (body.reasoning !== undefined) {
    const reasoning = body.reasoning;
    const valid = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) &&
      Object.keys(reasoning).length === 1 &&
      ["none", "minimal", "low", "medium", "high", "xhigh"].includes(
        String((reasoning as Record<string, unknown>).effort),
      );
    if (!valid) errors.push("reasoning");
  }
  if (body.text !== undefined && (!body.text || typeof body.text !== "object" || Array.isArray(body.text))) {
    errors.push("text");
  }
  if (body.max_output_tokens !== undefined &&
      (!Number.isInteger(body.max_output_tokens) || Number(body.max_output_tokens) <= 0)) {
    errors.push("max_output_tokens");
  }
  if (body.previous_response_id !== undefined &&
      (typeof body.previous_response_id !== "string" || !body.previous_response_id)) errors.push("previous_response_id");
  if (body.prompt_cache_key !== undefined &&
      (typeof body.prompt_cache_key !== "string" || body.prompt_cache_key.length < 1 || body.prompt_cache_key.length > 64)) {
    errors.push("prompt_cache_key");
  }
  if (body.prompt_cache_options !== undefined) {
    const options = body.prompt_cache_options;
    const valid = options && typeof options === "object" && !Array.isArray(options) &&
      ["implicit", "explicit"].includes(String((options as Record<string, unknown>).mode)) &&
      (options as Record<string, unknown>).ttl === "30m";
    if (!valid) errors.push("prompt_cache_options");
  }
  if (body.store !== false) errors.push("store");
  if (body.stream !== true) errors.push("stream");
  return errors;
}

// ===========================================================================
// Executor result schemas (build P3.3, spec §11.4 item 4 / §14.5).
//
// Results emit as {result_type, data} and are VALIDATED ON EMIT — a result
// that does not match its schema never reaches the task row or the generative
// UI. Validation is structural and dependency-free (no zod): each schema is a
// field table checked by one walker, so the seven types stay uniform and a new
// type is one entry, not new code.
// ===========================================================================

export const RESULT_TYPES = [
  "comparison_table",
  "itinerary",
  "draft_preview",
  "approval_card",
  "research_brief",
  "checklist",
  "receipt",
] as const;

export type ResultType = (typeof RESULT_TYPES)[number];

export interface ExecutorResult {
  result_type: ResultType;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Field specs
// ---------------------------------------------------------------------------

type FieldKind =
  | "string"
  | "number"
  | "string[]"
  | "object[]" // array of plain objects
  | "row[]"; // array of arrays (table rows)

interface FieldSpec {
  kind: FieldKind;
  required: boolean;
  /** For object[]: keys every element must carry (as strings). */
  itemStringKeys?: string[];
  /** Arrays that must not be empty. */
  nonEmpty?: boolean;
}

type Schema = Record<string, FieldSpec>;

const req = (kind: FieldKind, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  kind,
  required: true,
  ...extra,
});
const opt = (kind: FieldKind, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  kind,
  required: false,
  ...extra,
});

/**
 * The seven result schemas (spec §11.4 item 4). Deliberately shallow: the
 * generative renderer (P4.2) composes from these fields; the model fills
 * data, never styles.
 */
export const RESULT_SCHEMAS: Record<ResultType, Schema> = {
  comparison_table: {
    title: req("string"),
    columns: req("string[]", { nonEmpty: true }),
    rows: req("row[]", { nonEmpty: true }),
    recommendation: opt("string"),
  },
  itinerary: {
    title: req("string"),
    legs: req("object[]", {
      nonEmpty: true,
      itemStringKeys: ["when", "what"],
    }),
    notes: opt("string"),
  },
  draft_preview: {
    to: req("string"),
    channel: req("string"), // whatsapp|email|...
    body: req("string"),
    subject: opt("string"),
  },
  approval_card: {
    action: req("string"), // the gated action name, e.g. "whatsapp.send"
    summary: req("string"), // exactly what will happen on approval
    details: opt("object[]", { itemStringKeys: ["label", "value"] }),
    amount: opt("string"),
    cancellation_policy: opt("string"),
  },
  research_brief: {
    title: req("string"),
    summary: req("string"),
    findings: req("object[]", {
      nonEmpty: true,
      itemStringKeys: ["point"],
    }),
    sources: opt("string[]"),
  },
  checklist: {
    title: req("string"),
    items: req("object[]", {
      nonEmpty: true,
      itemStringKeys: ["label", "state"], // state: done|open|blocked
    }),
  },
  receipt: {
    action: req("string"), // what was performed (post-approval record)
    summary: req("string"),
    performed_at: req("string"),
    reference: opt("string"),
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isResultType(v: unknown): v is ResultType {
  return typeof v === "string" && (RESULT_TYPES as readonly string[]).includes(v);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkField(name: string, spec: FieldSpec, value: unknown, errors: string[]): void {
  if (value === undefined || value === null) {
    if (spec.required) errors.push(`${name}: required`);
    return;
  }
  switch (spec.kind) {
    case "string":
      if (typeof value !== "string" || value.trim() === "")
        errors.push(`${name}: must be a non-empty string`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        errors.push(`${name}: must be a finite number`);
      return;
    case "string[]":
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
        errors.push(`${name}: must be an array of strings`);
        return;
      }
      if (spec.nonEmpty && value.length === 0) errors.push(`${name}: must not be empty`);
      return;
    case "row[]":
      if (!Array.isArray(value) || value.some((x) => !Array.isArray(x))) {
        errors.push(`${name}: must be an array of arrays`);
        return;
      }
      if (spec.nonEmpty && value.length === 0) errors.push(`${name}: must not be empty`);
      return;
    case "object[]": {
      if (!Array.isArray(value) || value.some((x) => !isPlainObject(x))) {
        errors.push(`${name}: must be an array of objects`);
        return;
      }
      if (spec.nonEmpty && value.length === 0) errors.push(`${name}: must not be empty`);
      for (const key of spec.itemStringKeys ?? []) {
        value.forEach((item, i) => {
          const got = (item as Record<string, unknown>)[key];
          if (typeof got !== "string" || got.trim() === "")
            errors.push(`${name}[${i}].${key}: must be a non-empty string`);
        });
      }
      return;
    }
  }
}

/** Validate {result_type, data}. Empty array = valid. */
export function validateResult(candidate: unknown): string[] {
  if (!isPlainObject(candidate)) return ["result: must be an object"];
  const type = candidate.result_type;
  if (!isResultType(type)) {
    return [`result_type: must be one of ${RESULT_TYPES.join("|")}`];
  }
  const data = candidate.data;
  if (!isPlainObject(data)) return ["data: must be an object"];
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(RESULT_SCHEMAS[type])) {
    checkField(name, spec, data[name], errors);
  }
  return errors;
}

/** Thrown when an executor tries to emit a result its schema rejects. */
export class ResultSchemaError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`executor result failed schema validation: ${errors.join("; ")}`);
    this.name = "ResultSchemaError";
    this.errors = errors;
  }
}

/** The emit gate: returns the typed result or throws ResultSchemaError. */
export function emitResult(candidate: unknown): ExecutorResult {
  const errors = validateResult(candidate);
  if (errors.length > 0) throw new ResultSchemaError(errors);
  return candidate as ExecutorResult;
}

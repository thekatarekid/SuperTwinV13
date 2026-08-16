// ===========================================================================
// [CODE] STW-2 codec — arch §5.1 (grammar), §5.3 (the 23 tags), §5.6 (shapes).
//
//   record ::= tag "|" field ( "|" field )* "\n"
//
// PROSE IS ALWAYS THE LAST FIELD AND MAY CONTAIN "|" — the tail is re-joined,
// never split. There is no escaping mechanism and none is needed.
//
// The claim kind IS the tag: eight claim kinds for one character, no `kind`
// field to misspell. An unknown tag is a violation, never a guess.
//
// Compress structure, never language. Ids, enums, dates and repetition are
// abbreviated here; claim text, loop titles and quotes pass through verbatim.
// ===========================================================================

import { fromBase36, toBase36 } from "./aliases.js";
import {
  DATE_VALUE_RE,
  isKnownTag,
  proseLast,
  requiredCount,
  TAG_SPECS,
  type FieldSpec,
  type TagSpec,
} from "./tags.js";
import {
  DEFAULT_CONFIDENCE,
  ENUMS,
  isAbsent,
  unwrapToken,
  type EnumName,
  type WireViolation,
} from "./tolerance.js";

// The tag table is part of the codec's public surface; it simply lives in its
// own file so neither this module nor that one runs past readable length.
export * from "./tags.js";

// ---- event lists (§5.1, §5.2.3) -------------------------------------------

/** A single range may not expand past this — protection against `zzz-zzzzz`. */
const MAX_RANGE_SPAN = 4096;
/** Nor may a whole list. A malformed line can never take down a batch. */
const MAX_LIST_LENGTH = 10_000;

const RANGE_ITEM_RE = /^([0-9a-z]+)(?:\s*[-–—―]\s*([0-9a-z]+))?$/;

/**
 * `7,8,12-15` → `[7, 8, 38, 39, 40, 41]`. Base-36 and INCLUSIVE: `c-f` is
 * 12–15, `12-15` is 38–41. Returns `null` for anything malformed — never a
 * partial list, never a throw.
 */
export function decodeEventList(raw: string): number[] | null {
  if (typeof raw !== "string") return null;
  const out = new Set<number>();
  for (const item of raw.split(",")) {
    const t = item.trim().toLowerCase();
    if (t === "") continue;
    const m = RANGE_ITEM_RE.exec(t);
    if (!m) return null;
    const lo = fromBase36(m[1]);
    if (lo === null) return null;
    if (m[2] === undefined) {
      out.add(lo);
    } else {
      const hi = fromBase36(m[2]);
      if (hi === null || hi < lo || hi - lo > MAX_RANGE_SPAN) return null;
      for (let n = lo; n <= hi; n += 1) out.add(n);
    }
    if (out.size > MAX_LIST_LENGTH) return null;
  }
  return [...out].sort((a, b) => a - b);
}

/** Runs of ≥3 compress to `lo-hi`; a run of 2 stays comma-separated (§5.2.3). */
export function encodeEventList(nums: readonly number[]): string {
  const sorted = [...new Set(nums.filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    const run = j - i + 1;
    if (run >= 3) {
      parts.push(`${toBase36(sorted[i])}-${toBase36(sorted[j])}`);
    } else {
      for (let k = i; k <= j; k += 1) parts.push(toBase36(sorted[k]));
    }
    i = j + 1;
  }
  return parts.join(",");
}

// ---- field splitting -------------------------------------------------------

export interface FieldsResult {
  ok: boolean;
  tag: string;
  fields: string[];
  count: number;
  reason?: "too_few" | "too_many";
}

/**
 * Split one record into its fields.
 *
 * `raw` is a whole line, tag included. Every field is trimmed, so `F | a1 | …`
 * and `F|a1|…` parse identically. When `proseLast`, everything from field
 * `max` onward is RE-JOINED into the final field — a claim that contains a
 * pipe keeps its pipe, and a surplus field is impossible by construction. When
 * the tag ends in machine fields, surplus is a `field_count` violation: there
 * is no safe place to put it.
 */
export function fields(raw: string, min: number, max: number, proseLast: boolean): FieldsResult {
  const parts = typeof raw === "string" ? raw.split("|") : [""];
  const tag = (parts.shift() ?? "").trim();
  let out: string[];
  if (proseLast && max > 0 && parts.length > max) {
    out = parts.slice(0, max - 1).map((s) => s.trim());
    out.push(parts.slice(max - 1).join("|").trim());
  } else {
    out = parts.map((s) => s.trim());
  }
  const count = out.length;
  if (count < min) return { ok: false, tag, fields: out, count, reason: "too_few" };
  if (count > max) return { ok: false, tag, fields: out, count, reason: "too_many" };
  return { ok: true, tag, fields: out, count };
}

// ---- records ---------------------------------------------------------------

export type WireValue = string | number | number[] | null;

export interface WireRecord {
  tag: string;
  variant: string;
  label: string;
  /** 1-based source line; 0 for a record built in code. */
  line: number;
  /** The model's ORIGINAL text for this line. */
  raw: string;
  /** Canonical field strings — the serialisation source of truth. */
  fields: string[];
  /** Decoded values: enums as the STORED long form, events as numbers. */
  values: Record<string, WireValue>;
}

export type ParseLineOutcome = { record: WireRecord } | { violation: WireViolation };

const ALIAS_VALUE_RE = /^(?:self|\+.+|[acnket][0-9]+|[0-9a-z]+)$/i;
const REF_VALUE_RE = /^[^\s|]{1,80}$/;

interface DecodedField {
  ok: boolean;
  canonical: string;
  value: WireValue;
  rule?: string;
  detail?: string;
}

function decodeField(spec: FieldSpec, raw: string): DecodedField {
  switch (spec.type) {
    case "events": {
      if (isAbsent(raw)) return { ok: true, canonical: "-", value: null };
      const nums = decodeEventList(raw);
      if (nums === null) return { ok: false, canonical: raw, value: null, rule: "bad_events", detail: spec.name };
      return { ok: true, canonical: encodeEventList(nums), value: nums };
    }
    case "alias": {
      if (isAbsent(raw)) return { ok: true, canonical: "-", value: null };
      if (!ALIAS_VALUE_RE.test(raw)) {
        return { ok: false, canonical: raw, value: null, rule: "bad_alias", detail: spec.name };
      }
      return { ok: true, canonical: raw, value: raw };
    }
    case "ref": {
      if (isAbsent(raw)) return { ok: true, canonical: "-", value: null };
      if (!REF_VALUE_RE.test(raw)) {
        return { ok: false, canonical: raw, value: null, rule: "bad_ref", detail: spec.name };
      }
      return { ok: true, canonical: raw, value: raw };
    }
    case "enum": {
      if (isAbsent(raw)) return { ok: true, canonical: "-", value: null };
      const table = ENUMS[spec.enum as EnumName];
      const hit = table.decode(raw);
      // A blank is the model being honest; a wrong word is the model being wrong.
      if (!hit) {
        return { ok: false, canonical: raw, value: null, rule: "bad_enum", detail: `${spec.name}=${raw}` };
      }
      return { ok: true, canonical: hit.code, value: hit.stored };
    }
    case "conf": {
      const un = unwrapToken(raw, ["conf", "confidence", spec.name]);
      if (!un.ok) {
        return {
          ok: false,
          canonical: raw,
          value: null,
          rule: "token_key_mismatch",
          detail: `${spec.name} got {${un.key}:…}`,
        };
      }
      if (isAbsent(un.value)) return { ok: true, canonical: String(DEFAULT_CONFIDENCE), value: DEFAULT_CONFIDENCE };
      const n = Number(un.value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { ok: false, canonical: raw, value: null, rule: "bad_confidence", detail: `${spec.name}=${raw}` };
      }
      return { ok: true, canonical: String(n), value: n };
    }
    case "date": {
      const un = unwrapToken(raw, ["due", spec.name]);
      if (!un.ok) {
        return {
          ok: false,
          canonical: raw,
          value: null,
          rule: "token_key_mismatch",
          detail: `${spec.name} got {${un.key}:…}`,
        };
      }
      // A bare `{due}` is "not stated". Inventing a date is forbidden.
      if (isAbsent(un.value)) return { ok: true, canonical: "-", value: null };
      if (!DATE_VALUE_RE.test(un.value)) {
        return { ok: false, canonical: raw, value: null, rule: "bad_date", detail: `${spec.name}=${raw}` };
      }
      return { ok: true, canonical: un.value, value: un.value };
    }
    case "token":
    case "prose":
    default: {
      if (isAbsent(raw)) return { ok: true, canonical: "-", value: null };
      return { ok: true, canonical: raw, value: raw };
    }
  }
}

function chooseSpec(tag: string, parts: readonly string[]): TagSpec {
  const specs = TAG_SPECS[tag];
  for (const spec of specs) {
    if (spec.discriminate?.(parts)) return spec;
  }
  if (specs.length === 1) return specs[0];
  // No discriminator matched: fall back to the variant whose arity is closest,
  // so the field decoders produce a precise violation instead of a vague one.
  let best = specs[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const spec of specs) {
    const gap = Math.abs(spec.fields.length - parts.length);
    if (gap < bestGap) {
      best = spec;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Parse one candidate line into a record, or into exactly one violation. Never
 * throws, for any input, ever.
 *
 * `text` is post-tolerance (fence/emphasis/bullet already handled); `raw` is
 * what the model actually wrote and is what the violation quotes (§5.8.1).
 */
export function parseRecordLine(text: string, lineNo: number, raw: string): ParseLineOutcome {
  const src = typeof text === "string" ? text : "";
  const original = typeof raw === "string" ? raw : src;
  const pipe = src.indexOf("|");
  const tag = pipe < 0 ? src.trim() : src.slice(0, pipe).trim();
  if (pipe < 0 || !isKnownTag(tag)) {
    return {
      violation: {
        line: lineNo,
        tag: tag === "" ? null : tag.slice(0, 8),
        rule: "unknown_tag",
        detail: `no tag in the closed vocabulary: ${JSON.stringify(tag.slice(0, 16))}`,
        raw: original,
        scope: "line",
      },
    };
  }

  let body = src;
  let trailingValue: string | null = null;
  const probe = body.split("|").slice(1).map((s) => s.trim());
  const spec = chooseSpec(tag, probe);

  // An optional machine tail that sits after the prose field is recovered only
  // when it is present AND it looks like a ref list — otherwise the tail is
  // just more prose and is left where the model put it.
  if (spec.trailing && probe.length === spec.fields.length + 1) {
    const last = probe[probe.length - 1];
    if (spec.trailing.pattern.test(last)) {
      trailingValue = last;
      body = body.slice(0, body.lastIndexOf("|"));
    }
  }

  const min = requiredCount(spec);
  const max = spec.fields.length;
  const split = fields(body, min, max, proseLast(spec));
  if (!split.ok) {
    return {
      violation: {
        line: lineNo,
        tag,
        rule: "field_count",
        detail: `${spec.variant} expects ${min === max ? min : `${min}–${max}`} fields, got ${split.count}`,
        raw: original,
        scope: "line",
      },
    };
  }

  const canonical: string[] = [];
  const values: Record<string, WireValue> = {};
  for (let i = 0; i < spec.fields.length; i += 1) {
    const fieldSpec = spec.fields[i];
    const decoded = decodeField(fieldSpec, split.fields[i] ?? "");
    if (!decoded.ok) {
      return {
        violation: {
          line: lineNo,
          tag,
          rule: decoded.rule ?? "bad_field",
          detail: decoded.detail ?? fieldSpec.name,
          raw: original,
          scope: "line",
        },
      };
    }
    canonical.push(decoded.canonical);
    values[fieldSpec.name] = decoded.value;
  }

  // Drop trailing droppable fields the model left blank, so the canonical form
  // of "not stated" is "absent" and round trips are stable.
  while (canonical.length > min && spec.fields[canonical.length - 1].optional && canonical[canonical.length - 1] === "-") {
    canonical.pop();
  }

  if (spec.trailing) {
    values[spec.trailing.name] = trailingValue;
    if (trailingValue !== null) canonical.push(trailingValue);
  }

  return {
    record: { tag, variant: spec.variant, label: spec.label, line: lineNo, raw: original, fields: canonical, values },
  };
}

/** Canonical form of one record. */
export function serializeRecord(record: WireRecord): string {
  return [record.tag, ...record.fields].join("|");
}

/** Canonical form of a record set — `\n` separated, no trailing newline. */
export function serialize(records: readonly WireRecord[]): string {
  return records.map(serializeRecord).join("\n");
}

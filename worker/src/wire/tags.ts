// ===========================================================================
// [CODE] STW-2 tag table — arch §5.3 (the 23 tags) and §5.6 (one shape per call).
//
// Split out of codec.ts because it is a data table, not logic: 23 tags, a few
// with two shapes, each a list of typed fields. The codec reads it, the
// tolerance layer asks it only "is this a tag I know".
//
// THE CLAIM KIND IS THE TAG. No `kind` field, no enum to misspell, eight claim
// kinds for one character. An unknown tag is a violation, never a guess.
// ===========================================================================

import { ENUMS, isAbsent, unwrapToken, type EnumName } from "./tolerance.js";

/** ISO date, or ISO datetime. A date field holds a date or it holds nothing. */
export const DATE_VALUE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export type FieldType = "events" | "alias" | "ref" | "enum" | "conf" | "date" | "token" | "prose";

export interface FieldSpec {
  name: string;
  type: FieldType;
  enum?: EnumName;
  /** Droppable tail (a hint, an `ends_at`, an evidence ref) — §5.7.4. */
  optional?: boolean;
}

export interface TagSpec {
  tag: string;
  /** `tag` for single-shape tags, `tag.variant` where §5.6 defines two. */
  variant: string;
  label: string;
  fields: readonly FieldSpec[];
  /** Optional machine tail that sits AFTER the prose field. */
  trailing?: { name: string; pattern: RegExp };
  /** Picks between variants of the same tag. */
  discriminate?: (parts: readonly string[]) => boolean;
}

const CLAIM_FIELDS: readonly FieldSpec[] = [
  { name: "events", type: "events" },
  { name: "subject", type: "alias" },
  { name: "attribution", type: "enum", enum: "attribution" },
  { name: "confidence", type: "conf" },
  { name: "valid_from", type: "date" },
  { name: "text", type: "prose" },
];

const CLAIM_TAGS: Record<string, string> = {
  F: "fact",
  P: "preference",
  B: "belief",
  O: "opinion",
  I: "interest",
  R: "recommendation",
  H: "habit",
  W: "workflow",
};

function claimSpec(tag: string, kind: string): TagSpec {
  return { tag, variant: tag, label: `claim.${kind}`, fields: CLAIM_FIELDS };
}

const EVIDENCE_TAIL = /^[a-z]?[0-9a-z]+(?:,[a-z]?[0-9a-z]+)*$/i;

/** Discriminator helper: is this field a date, a wrapped date, or blank? */
function looksLikeDateField(raw: string): boolean {
  const un = unwrapToken(raw ?? "", ["due", "valid_to", "ends_at"]);
  return un.ok && (isAbsent(un.value) || DATE_VALUE_RE.test(un.value));
}

/** Every tag in the closed vocabulary, keyed by tag, most-specific variant first. */
export const TAG_SPECS: Record<string, readonly TagSpec[]> = {
  M: [
    {
      tag: "M",
      variant: "M",
      label: "mention",
      fields: [
        { name: "events", type: "events" },
        { name: "surface", type: "prose" },
        { name: "entity", type: "alias" },
        { name: "confidence", type: "conf" },
        { name: "hint", type: "prose", optional: true },
      ],
    },
  ],
  N: [
    {
      tag: "N",
      variant: "N",
      label: "new_entity",
      fields: [
        { name: "entity", type: "alias" },
        { name: "name", type: "prose" },
        { name: "type", type: "enum", enum: "entity_type" },
        { name: "subtype", type: "token", optional: true },
      ],
    },
  ],
  L: [
    {
      tag: "L",
      variant: "L",
      label: "link",
      fields: [
        { name: "events", type: "events" },
        { name: "src", type: "alias" },
        { name: "kind", type: "enum", enum: "edge_kind" },
        { name: "subtype", type: "token" },
        { name: "dst", type: "alias" },
        { name: "confidence", type: "conf" },
        { name: "quote", type: "prose" },
      ],
    },
  ],
  ...Object.fromEntries(Object.entries(CLAIM_TAGS).map(([tag, kind]) => [tag, [claimSpec(tag, kind)]])),
  T: [
    {
      tag: "T",
      variant: "T",
      label: "loop",
      fields: [
        { name: "events", type: "events" },
        { name: "owner", type: "alias" },
        { name: "counterparty", type: "alias" },
        { name: "origin", type: "enum", enum: "origin" },
        { name: "direction", type: "enum", enum: "direction" },
        { name: "stake", type: "enum", enum: "stake" },
        { name: "horizon", type: "enum", enum: "horizon" },
        { name: "due", type: "date" },
        { name: "recurrence", type: "token" },
        { name: "confidence", type: "conf" },
        { name: "intent", type: "prose" },
      ],
    },
  ],
  Y: [
    {
      tag: "Y",
      variant: "Y",
      label: "episode_summary",
      fields: [
        { name: "episode", type: "alias" },
        { name: "summary", type: "prose" },
      ],
    },
  ],
  Z: [
    {
      tag: "Z",
      variant: "Z",
      label: "delta",
      fields: [
        { name: "ref", type: "ref" },
        { name: "change", type: "enum", enum: "change" },
        { name: "events", type: "events" },
        { name: "note", type: "prose" },
      ],
    },
  ],
  G: [
    {
      tag: "G",
      variant: "G",
      label: "segment",
      fields: [
        { name: "session", type: "ref" },
        { name: "events", type: "events" },
        { name: "decision", type: "enum", enum: "segment" },
        { name: "episode", type: "alias" },
        { name: "confidence", type: "conf" },
        { name: "topic", type: "prose" },
      ],
    },
  ],
  V: [
    {
      tag: "V",
      variant: "V.arc",
      label: "verdict.arc",
      discriminate: (p) => p.length >= 5 && ENUMS.arc_verdict.decode(p[1]) !== null,
      fields: [
        { name: "episode", type: "alias" },
        { name: "verdict", type: "enum", enum: "arc_verdict" },
        { name: "arc", type: "alias" },
        { name: "confidence", type: "conf" },
        { name: "reason", type: "prose" },
      ],
    },
    {
      tag: "V",
      variant: "V.claim",
      label: "verdict.claim",
      // `un` belongs to two verdict tables, so arity alone cannot separate a
      // claim verdict from an entity verdict whose reason contains pipes. The
      // two machine fields that only the claim shape has settle it.
      discriminate: (p) =>
        p.length >= 7 &&
        ENUMS.claim_verdict.decode(p[2]) !== null &&
        (/^[ab]$/i.test(p[3].trim()) || isAbsent(p[3])) &&
        looksLikeDateField(p[4]),
      fields: [
        { name: "claim_a", type: "ref" },
        { name: "claim_b", type: "ref" },
        { name: "verdict", type: "enum", enum: "claim_verdict" },
        { name: "later", type: "token" },
        { name: "valid_to", type: "date" },
        { name: "confidence", type: "conf" },
        { name: "reason", type: "prose" },
      ],
    },
    {
      tag: "V",
      variant: "V.entity",
      label: "verdict.entity",
      discriminate: (p) => p.length >= 5 && ENUMS.entity_verdict.decode(p[2]) !== null,
      trailing: { name: "evidence", pattern: EVIDENCE_TAIL },
      fields: [
        { name: "left", type: "alias" },
        { name: "right", type: "alias" },
        { name: "verdict", type: "enum", enum: "entity_verdict" },
        { name: "confidence", type: "conf" },
        { name: "reason", type: "prose" },
      ],
    },
  ],
  S: [
    {
      tag: "S",
      variant: "S",
      label: "done_state",
      fields: [
        { name: "loop", type: "alias" },
        { name: "state", type: "enum", enum: "done_state" },
        { name: "event", type: "alias" },
        { name: "confidence", type: "conf" },
        { name: "quote", type: "prose" },
      ],
    },
  ],
  J: [
    {
      tag: "J",
      variant: "J.triage",
      label: "judgment.triage",
      discriminate: (p) => p.length >= 2 && ENUMS.triage.decode(p[1]) !== null,
      fields: [
        { name: "loop", type: "alias" },
        { name: "class", type: "enum", enum: "triage" },
        { name: "urgency", type: "enum", enum: "stake" },
        { name: "reason", type: "prose" },
      ],
    },
    {
      tag: "J",
      variant: "J.channel",
      label: "judgment.channel",
      discriminate: (p) => p.length >= 2 && ENUMS.channel_class.decode(p[1]) !== null,
      fields: [
        { name: "stream", type: "alias" },
        { name: "class", type: "enum", enum: "channel_class" },
        { name: "confidence", type: "conf" },
        { name: "reason", type: "prose" },
      ],
    },
  ],
  D: [
    {
      tag: "D",
      variant: "D",
      label: "derive",
      fields: [
        { name: "arc", type: "alias" },
        { name: "archetype", type: "enum", enum: "archetype" },
        { name: "cadence", type: "enum", enum: "cadence" },
        { name: "ends_at", type: "date" },
        { name: "confidence", type: "conf" },
        { name: "label", type: "prose" },
      ],
    },
  ],
  C: [
    {
      tag: "C",
      variant: "C",
      label: "caption",
      fields: [
        { name: "media", type: "ref" },
        { name: "caption", type: "prose" },
      ],
    },
  ],
  Q: [
    {
      tag: "Q",
      variant: "Q",
      label: "question",
      fields: [
        { name: "about", type: "ref" },
        { name: "question", type: "prose" },
      ],
    },
  ],
  X: [
    {
      tag: "X",
      variant: "X",
      label: "noise",
      fields: [
        { name: "events", type: "events" },
        { name: "note", type: "prose", optional: true },
      ],
    },
  ],
  "?": [
    {
      tag: "?",
      variant: "?",
      label: "needs_lookup",
      fields: [
        { name: "ref", type: "ref" },
        { name: "note", type: "prose", optional: true },
      ],
    },
  ],
};

export const WIRE_TAGS: readonly string[] = Object.keys(TAG_SPECS);

export function isKnownTag(tag: string): boolean {
  return Object.prototype.hasOwnProperty.call(TAG_SPECS, tag);
}

/** The gate the tolerance pipeline uses: a known tag, then a bare pipe. */
export function looksLikeWireLine(text: string): boolean {
  if (typeof text !== "string") return false;
  const i = text.indexOf("|");
  if (i < 1) return false;
  return isKnownTag(text.slice(0, i).trim());
}

export function requiredCount(spec: TagSpec): number {
  let n = spec.fields.length;
  while (n > 0 && spec.fields[n - 1].optional) n -= 1;
  return n;
}

export function proseLast(spec: TagSpec): boolean {
  return spec.fields[spec.fields.length - 1].type === "prose";
}

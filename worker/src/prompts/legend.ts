// ===========================================================================
// [CODE] The shared legend block — arch §5.1–§5.4, §5.9.4, §4.4.3.
//
// Every one of the 12 prompts opens with the same instruction half: the STW-2
// grammar, the alias namespaces, the output templates for the tags THAT call
// may emit, and the enum tables those tags reference. §5.9.4: "the instruction
// half of every prompt is a stable prefix — the grammar and enum legend never
// vary within a call type, which is what makes them a cache candidate at all."
//
// Two properties this file exists to guarantee:
//
//   DERIVED    the legend is rendered FROM `wire/tags.ts` and `wire/tolerance.ts`,
//              never hand-copied. A legend that says `1p|ao|rs|q3` while the
//              decoder accepts something else is how a model gets blamed for a
//              parser's drift. There is one table and the prompt reads it.
//
//   STABLE     `legendFor()` memoises per call type and THROWS if a second
//              caller would render a different block for the same call type.
//              A prefix that changes byte-for-byte between calls is a cache
//              miss plus a 1.25x write premium (§4.4.3.2) — silently, with no
//              error anywhere. So the invariant is enforced loudly instead.
//
// Nothing here touches model output; it is prompt construction only.
// ===========================================================================

import { ALIAS_NAMESPACES, ALIAS_PREFIX, SELF_ALIAS, type AliasNamespace } from "../wire/aliases.js";
import { ENUMS, type EnumName } from "../wire/tolerance.js";
import { TAG_SPECS, type TagSpec } from "../wire/tags.js";

// ---------------------------------------------------------------------------
// Fixed blocks (§5.1, §5.2) — identical in every prompt in the system.
// ---------------------------------------------------------------------------

/** §5.1, transcribed. The one rule that governs the format leads it. */
export const GRAMMAR_BLOCK = `WIRE FORMAT — STW-2. Answer in wire lines only. No JSON, no prose.
Compress structure, never language: ids, enums and dates are abbreviated,
but claim text, titles and quotes are written VERBATIM as you would say them.

  record  ::= tag "|" field ( "|" field )*        one record per line
  tag     ::= a single character, the first character of the line
  fields  ::= separated by a bare "|", each trimmed of surrounding space
  PROSE IS ALWAYS THE LAST FIELD AND MAY CONTAIN "|" — the tail is re-joined,
    never split. There is no escaping mechanism and none is needed.
  events  ::= item ( "," item )*   item ::= n | n "-" n   base-36, INCLUSIVE
  absent  ::= "" or "-"   meaning "not stated" — never a guess
  conf    ::= a decimal in [0,1]; AN EMPTY FIELD MEANS 0.9

A field you cannot fill is left blank. A blank is you being honest; a wrong
word is you being wrong. Never invent a date, an id or an alias.
[<field>] marks a droppable tail — emit it when you have it, omit it when not.`;

const NAMESPACE_GLOSS: Record<AliasNamespace, string> = {
  entity: "person / entity on the roster",
  stream: "chat / stream",
  arc: "thread (arc) that already exists",
  proposed: "thread you are proposing in THIS answer",
  episode: "episode, existing or open",
  loop: "loop, existing or open",
};

function aliasBlock(namespaces: readonly AliasNamespace[]): string {
  const rows = namespaces.map(
    (ns) => `  ${ALIAS_PREFIX[ns]}1..${ALIAS_PREFIX[ns]}n   ${NAMESPACE_GLOSS[ns]}`,
  );
  return [
    "ALIASES — prompt-local, base-36 above 35 (a=10 .. z=35, 10=36).",
    `  <n>        event, a bare base-36 number`,
    `  ${SELF_ALIAS}       the person this memory belongs to; never numbered`,
    ...rows,
    "  +Name      an entity that is NOT on the roster: write the name verbatim",
    "Use an alias only if it appears above or in the roster. An alias you cannot",
    "find has no answer — say nothing rather than pick the nearest one.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tag templates, rendered from the tag table
// ---------------------------------------------------------------------------

/** `F | <events> | <subject> | ... | <text>` — the shape §5.6 asks the model for. */
export function renderTemplate(spec: TagSpec, tagToken = spec.tag): string {
  const fields = spec.fields.map((f) => (f.optional ? `[<${f.name}>]` : `<${f.name}>`));
  if (spec.trailing) fields.push(`[<${spec.trailing.name}>]`);
  return [tagToken, ...fields].join(" | ");
}

/**
 * Resolve the caller's tag list to specs. An entry is either a bare tag (`"V"`,
 * every variant of it) or an explicit variant id (`"V.arc"`). An unknown entry
 * throws: a prompt that asks for a tag the codec cannot parse is a defect at
 * build time, not a violation to discover at runtime.
 */
export function specsFor(tags: readonly string[]): TagSpec[] {
  const out: TagSpec[] = [];
  for (const entry of tags) {
    const tag = entry.includes(".") ? entry.slice(0, entry.indexOf(".")) : entry;
    const variants = TAG_SPECS[tag];
    if (!variants) throw new Error(`legend: "${entry}" is not a tag in the STW-2 vocabulary`);
    const picked = entry.includes(".") ? variants.filter((v) => v.variant === entry) : [...variants];
    if (picked.length === 0) throw new Error(`legend: "${entry}" is not a variant of tag ${tag}`);
    for (const spec of picked) if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

/** Every enum the selected tags reference, first-seen order. */
export function enumsFor(specs: readonly TagSpec[]): EnumName[] {
  const seen: EnumName[] = [];
  for (const spec of specs) {
    for (const f of spec.fields) {
      if (f.type === "enum" && f.enum && !seen.includes(f.enum)) seen.push(f.enum);
    }
  }
  return seen;
}

/**
 * Tags that share a field shape share a template line. The eight claim kinds
 * are one shape, so they print once as `F=claim.fact  P=claim.preference ...`
 * rather than eight identical rows — which is also the point §5.3 makes: the
 * claim kind IS the tag.
 */
function templateGroups(specs: readonly TagSpec[]): string[] {
  const order: string[] = [];
  const groups = new Map<string, TagSpec[]>();
  for (const spec of specs) {
    const key = renderTemplate(spec, "<tag>");
    const bucket = groups.get(key);
    if (bucket) bucket.push(spec);
    else {
      groups.set(key, [spec]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const bucket = groups.get(key) ?? [];
    if (bucket.length === 1) return `  ${renderTemplate(bucket[0])}\n      ${bucket[0].label}`;
    const names = bucket.map((s) => `${s.tag}=${s.label}`).join("  ");
    return `  ${key}\n      ${names}`;
  });
}

function enumBlock(names: readonly EnumName[]): string {
  const rows = names.map((name) => {
    const pairs = ENUMS[name].entries.map((e) => `${e.code}=${e.stored}`).join("  ");
    return `  ${name}\n      ${pairs}`;
  });
  return ["ENUMS — write the code or the long form; both decode.", ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// The legend
// ---------------------------------------------------------------------------

export interface LegendSpec {
  /** Prompt id — `P-CL1`. The cache key, and the unit of the stability check. */
  callType: string;
  /** Tags this call may emit, in the order the legend should present them. */
  tags: readonly string[];
  /** Alias namespaces in play. Default: all of them. */
  aliases?: readonly AliasNamespace[];
  /** Enums to print even though no selected tag references one. */
  enums?: readonly EnumName[];
}

/** Render the block. Pure: same spec in, byte-identical string out, always. */
export function buildLegend(spec: LegendSpec): string {
  const specs = specsFor(spec.tags);
  const namespaces = spec.aliases ?? ALIAS_NAMESPACES;
  const names = enumsFor(specs);
  for (const extra of spec.enums ?? []) if (!names.includes(extra)) names.push(extra);
  const blocks = [
    GRAMMAR_BLOCK,
    aliasBlock(namespaces),
    ["OUTPUT — emit only these tags. Any other tag is a violation.", ...templateGroups(specs)].join(
      "\n",
    ),
  ];
  if (names.length > 0) blocks.push(enumBlock(names));
  return blocks.join("\n\n");
}

const cache = new Map<string, string>();

/**
 * The memoised legend for a call type (§5.9.4). Byte-identical on every call —
 * and if a caller ever renders a DIFFERENT block under the same call type this
 * throws rather than quietly shipping two prefixes that each miss the cache.
 */
export function legendFor(spec: LegendSpec): string {
  const built = buildLegend(spec);
  const held = cache.get(spec.callType);
  if (held === undefined) {
    cache.set(spec.callType, built);
    return built;
  }
  if (held !== built) {
    throw new Error(
      `legend for ${spec.callType} is not stable: the block changed between calls, ` +
        `which silently costs a cache write premium on every call (§4.4.3)`,
    );
  }
  return held;
}

/** Test hook — the cache is process-wide by design. */
export function resetLegendCache(): void {
  cache.clear();
}

/** Call types that have rendered a legend so far, for the runner's reporting. */
export function legendCallTypes(): string[] {
  return [...cache.keys()].sort();
}

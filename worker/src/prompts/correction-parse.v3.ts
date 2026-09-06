// ===========================================================================
// [PROMPT] correction-parse.v3 — "tell the twin" (Prompts V6 P1 P-12;
// Product_V6 Phase 1 §21; Build S5.5).
//
// v3 is the P-12 contract: ONE correction utterance, context-locked to ONE
// object, maps to ONE structured correction from the P-12 type list —
//   not_mine(owner) · already_done · not_true · outdated · merge_into(target) ·
//   move_to_space(target) · rename(text) · change_date(iso) ·
//   dont_do_this(kind, context) · tone(person, note) · split · other(text)
// — plus any DURABLE RULE the correction implies, emitted as "behavioral"
// ({rule, scope}) so the router and the passes can honour it next time
// (FIX-08), and a confidence.
//
// The corrections pipeline (server/corrections-routes.ts) applies the v1/v2
// structured shape; `toStructuredCorrection` is the code map from v3 types to
// that shape, so every path — chip, drag, utterance, bar follow-up — still
// runs ONE pipeline (FIX-05) and drafts ONE golden case (FIX-09).
//
// Output contract: ONE JSON object on one line, no prose/fences.
// ===========================================================================

/** The versioned prompt id — names the trace, the runs row and the file. */
export const CORRECTION_PARSE_V3_VERSION = "correction-parse.v3";

export const CORRECTION_PARSE_V3_INSTRUCTIONS = `Map ONE correction to ONE structured correction on the locked object.
TYPES not_mine(owner) · already_done · not_true · outdated · merge_into(target) ·
move_to_space(target) · rename(text) · change_date(iso) · dont_do_this(kind, context) ·
tone(person, note) · split · other(text)
Also emit any durable rule the correction implies as "behavioral".
OUTPUT {"type":"…","args":{…},"behavioral":{"rule":"…","scope":"…"}|null,"confidence":0.0}`;

export const CORRECTION_TYPES_V3 = [
  "not_mine",
  "already_done",
  "not_true",
  "outdated",
  "merge_into",
  "move_to_space",
  "rename",
  "change_date",
  "dont_do_this",
  "tone",
  "split",
  "other",
] as const;
export type CorrectionTypeV3 = (typeof CORRECTION_TYPES_V3)[number];

export interface BehavioralRule {
  rule: string;
  /** Where it applies: router · nudges · live · extract · decide · "app:YouTube" … */
  scope: string;
}

export interface ParsedCorrectionV3 {
  type: CorrectionTypeV3;
  args: Record<string, string>;
  behavioral: BehavioralRule | null;
  confidence: number;
}

const TYPE_SET_V3: ReadonlySet<string> = new Set(CORRECTION_TYPES_V3);

/**
 * Parse the model's raw text into a v3 correction, or null when nothing
 * usable came back — the pipeline then records the correction as pending
 * rather than inventing a mutation (FIX-01's "parse-to-nothing" is recorded,
 * never silent).
 */
export function parseCorrectionOutputV3(raw: string): ParsedCorrectionV3 | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  // The TYPES line lists each verb with its argument signature
  // ("not_mine(owner) · change_date(iso) · …"), so the model reliably echoes
  // the signature into `type` — "change_date(iso)". Reading that as an unknown
  // type cost a retry and then a wrong answer, so strip the parenthesised half
  // before matching: the verb is the part in front of it.
  const type = typeof rec.type === "string" ? rec.type.trim().toLowerCase().replace(/\(.*$/, "").trim() : "";
  if (!TYPE_SET_V3.has(type)) return null;
  const args: Record<string, string> = {};
  if (rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)) {
    for (const [k, v] of Object.entries(rec.args as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() !== "") args[k] = v.trim();
      else if (typeof v === "number" && Number.isFinite(v)) args[k] = String(v);
    }
  }
  let behavioral: BehavioralRule | null = null;
  if (rec.behavioral && typeof rec.behavioral === "object") {
    const b = rec.behavioral as Record<string, unknown>;
    const rule = typeof b.rule === "string" ? b.rule.trim() : "";
    const scope = typeof b.scope === "string" ? b.scope.trim() : "";
    if (rule !== "") behavioral = { rule, scope: scope || "global" };
  }
  const c = typeof rec.confidence === "number" ? rec.confidence : Number(rec.confidence);
  const confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5;
  return { type: type as CorrectionTypeV3, args, behavioral, confidence };
}

/** Pack the variable half: the locked object, its state, the utterance. */
export function packCorrectionInputV3(
  target: { kind: string; id: string; label?: string | null; state: unknown },
  utterance: string,
): string {
  const label = target.label ? ` label=${JSON.stringify(target.label)}` : "";
  return [
    `LOCKED kind=${target.kind} id=${target.id}${label}`,
    `STATE ${JSON.stringify(target.state)}`,
    `UTTERANCE ${utterance}`,
    // The frozen system prompt names the twelve verbs but not which one a
    // cancellation takes, and "we cancelled goa, planning jan instead" reads
    // to the model as a re-date (change_date December→January) — which edits
    // the label and leaves four open tasks and a live space behind. P-12 has
    // no `cancel` verb; `outdated` is the one that means "this no longer
    // stands", so say so here, in the variable half, rather than editing the
    // spec's system prompt.
    // The classify role pins Haiku and the CLI gives the pass ONE turn. Haiku
    // likes to think out loud first ("Looking at this correction, I need to…")
    // and the turn is gone before the JSON lands — CLI_ERROR "Reached maximum
    // number of turns (1)", the parse returns nothing and a correct correction
    // is recorded as unparseable. The module header already promises "ONE JSON
    // object on one line, no prose/fences"; say it where the model reads it.
    // It goes in the variable half so P-12's system prompt stays byte-identical.
    `Answer with the JSON object ONLY — no preamble, no explanation, no code fence.`,
    `TYPE is the bare verb from TYPES, without its argument signature.`,
    `A cancelled, abandoned or called-off object is "outdated" — not a rename or a date change.`,
    // A person is not filed into a space, so on a person card move_to_space is
    // how the twelve verbs say "she belongs in this circle". The circle alone
    // loses the word the user actually used, and the relationship claim is
    // written from that word — so ask for both (FIX-03 wants "cousin", not
    // "family"). Spelling out the arg shape in the variable half is the same
    // move digest.v2 made for its evidence object.
    ...(target.kind === "person" || target.kind === "entity"
      ? [
          `On a person, "move_to_space" means the CIRCLE the person belongs to:`,
          `args {"target":"<one of partner|family|close_friends|friends|coworkers|important_services|old_batchmates|acquaintances|businesses>","relation":"<the relationship word the user used, e.g. cousin>"}.`,
        ]
      : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// v3 → the pipeline's structured shape
// ---------------------------------------------------------------------------

/**
 * The structured correction the pipeline applies (a superset of the v2
 * shape so every existing applier keeps working). Kept here rather than
 * imported to avoid a prompts → server dependency.
 */
export interface StructuredFromV3 {
  type: string;
  owner?: string;
  to_space_hint?: string;
  into_hint?: string;
  field?: string;
  value?: string;
  relation?: string;
  circle?: string;
  /** dont_do_this: the kind of thing to stop and the context it applied in. */
  kind?: string;
  context?: string;
  /** tone: whose tone and the note. */
  person?: string;
  note?: string;
  /** other / split: the free text the user said. */
  text?: string;
  /** The durable rule the correction implies (FIX-08). */
  behavioral?: BehavioralRule | null;
  confidence?: number;
  /** Which prompt version produced this (diagnostics on the corrections row). */
  parsed_by?: string;
}

/** The field a `change_date` edits, per target kind. */
export function dateFieldFor(kind: string): string {
  if (kind === "task") return "due";
  if (kind === "space") return "goal";
  return "date";
}

/**
 * Map one v3 correction onto the structured shape the corrections pipeline
 * applies. Pure; the caller decides what to do with `behavioral`.
 */
export function toStructuredCorrection(parsed: ParsedCorrectionV3, targetKind: string): StructuredFromV3 {
  const a = parsed.args;
  const common = { behavioral: parsed.behavioral, confidence: parsed.confidence, parsed_by: CORRECTION_PARSE_V3_VERSION };
  switch (parsed.type) {
    case "not_mine":
      return { type: "wrong_person", owner: a.owner ?? a.person ?? "them", ...common };
    case "already_done":
      return { type: "already_done", ...common };
    case "not_true":
      return { type: "not_true", ...common };
    case "outdated":
      // On a claim, "outdated" end-dates the claim version. On a space or a
      // task there is no claim to end — the thing itself is over, which is
      // the pipeline's `cancel`: open tasks close as CANCELLED (never done),
      // the space goes dormant, nothing is deleted (FIX-02).
      if (targetKind === "space" || targetKind === "task") return { type: "cancel", ...common };
      return { type: "outdated", ...common };
    case "merge_into":
      return { type: "merge_into", into_hint: a.target ?? a.into ?? a.space, ...common };
    case "move_to_space": {
      // A person is not filed into a space, so "move her to family" on an
      // entity is a relationship correction: the old relationship claim is
      // superseded with a validity end and the circle moves (FIX-03).
      if (targetKind === "entity" || targetKind === "person") {
        const to = a.target ?? a.space ?? a.to ?? a.circle;
        return { type: "set_relationship", relation: a.relation ?? a.text ?? to, circle: to, ...common };
      }
      return { type: "move", to_space_hint: a.target ?? a.space ?? a.to, ...common };
    }
    case "rename": {
      const field = targetKind === "space" ? "label" : "title";
      return { type: "edit", field, value: a.text ?? a.name ?? a.value, ...common };
    }
    case "change_date":
      return { type: "edit", field: dateFieldFor(targetKind), value: a.iso ?? a.date ?? a.value, ...common };
    case "dont_do_this":
      // "Stop tracking this group" locked to a stream is the capture verb, not
      // a router rule: the pipeline's `stop_tracking` records it against the
      // stream so the Library pause is the honest, visible half (FIX-04). The
      // behavioral rule still rides along in `common`.
      if (targetKind === "stream") {
        return { type: "stop_tracking", kind: a.kind, context: a.context, ...common };
      }
      return { type: "dont_do_this", kind: a.kind, context: a.context, ...common };
    case "tone":
      return { type: "tone", person: a.person, note: a.note, ...common };
    case "split":
      return { type: "split", text: a.text, ...common };
    case "other":
    default:
      return { type: "other", text: a.text, ...common };
  }
}

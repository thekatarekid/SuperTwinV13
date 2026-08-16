// ===========================================================================
// [CODE] STW-2 tolerance layer — arch §5.4 (enum tables) and §5.7 (repair).
//
// "Repair only where it is lossless." Four failure classes were observed in
// production and are repaired silently; everything else is a loud violation:
//
//   1. markdown wrappers  — fences, headings, bullets, EMPHASIS
//   2. enum drift         — casing, spacing, underscores, the stored long form
//   3. token wrappers     — {due:…} / {conf:…}, the KEY MUST MATCH THE FIELD
//   4. field-count slack  — only where a tail is genuinely droppable
//
// A blank is the model being honest; a wrong word is the model being wrong.
// Nothing here ever invents a value: every repair is a re-reading of bytes the
// model actually wrote, never a substitution for bytes it did not.
// ===========================================================================

// ---- absence, confidence ---------------------------------------------------

/**
 * Every character that means "not stated" (§5.1 `absent`). ASCII hyphen plus
 * en/em/horizontal dash, because models type all four.
 */
export const WIRE_DASHES: readonly string[] = ["-", "–", "—", "―"];

/** An empty confidence field means 0.9 — §5.1. Never 0, never 1. */
export const DEFAULT_CONFIDENCE = 0.9;

/** `""` and any of {@link WIRE_DASHES} both read as "the model did not say". */
export function isAbsent(raw: string): boolean {
  const t = raw.trim();
  return t === "" || WIRE_DASHES.includes(t);
}

// ---- token canonicalisation ------------------------------------------------

/**
 * Lowercase, trim, and collapse every run of whitespace / underscore / hyphen
 * into a single `_`. `FIRST_PERSON`, `First Person` and `first--person` all
 * land on `first_person`.
 *
 * Collapsing (rather than deleting) is deliberate: the separator-free spelling
 * `firstperson` is a *listed* tolerated spelling, not something derived by
 * accident, so a genuinely different word can never collide into a valid code.
 */
export function canonicalWireToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_‐‑‒–—―-]+/g, "_");
}

/** The separator-free form, used as a second-chance lookup only. */
function strippedWireToken(raw: string): string {
  return canonicalWireToken(raw).replace(/_/g, "");
}

// ---- enum tables (§5.4) ----------------------------------------------------

export interface EnumEntry {
  /** The wire code — what the packer emits. */
  code: string;
  /** The stored long form — what lands in SQLite. */
  stored: string;
  /** Tolerated alternative *spellings*. Never reinterpretations. */
  alts?: string[];
}

export interface EnumDecoded {
  code: string;
  stored: string;
}

export interface WireEnum {
  name: string;
  entries: readonly EnumEntry[];
  /** Wire token → {code, stored}; `null` when the word is genuinely wrong. */
  decode(raw: string): EnumDecoded | null;
  /** Stored long form (or code) → wire code, for emit. */
  encode(stored: string): string | null;
  codes(): string[];
}

function defineEnum(name: string, entries: readonly EnumEntry[]): WireEnum {
  const byToken = new Map<string, EnumDecoded>();
  const byStripped = new Map<string, EnumDecoded>();
  for (const e of entries) {
    const decoded: EnumDecoded = { code: e.code, stored: e.stored };
    for (const spelling of [e.code, e.stored, ...(e.alts ?? [])]) {
      const c = canonicalWireToken(spelling);
      if (!byToken.has(c)) byToken.set(c, decoded);
      const s = strippedWireToken(spelling);
      if (!byStripped.has(s)) byStripped.set(s, decoded);
    }
  }
  return {
    name,
    entries,
    decode(raw: string): EnumDecoded | null {
      if (typeof raw !== "string") return null;
      return byToken.get(canonicalWireToken(raw)) ?? byStripped.get(strippedWireToken(raw)) ?? null;
    },
    encode(stored: string): string | null {
      return this.decode(stored)?.code ?? null;
    },
    codes(): string[] {
      return entries.map((e) => e.code);
    },
  };
}

/** Every enum on the wire. Decoding is per-table, so `un`/`grp`/`rec` may repeat. */
export const ENUMS = {
  attribution: defineEnum("attribution", [
    { code: "1p", stored: "first_person", alts: ["firstperson", "self", "1st_person"] },
    { code: "ao", stored: "about_other", alts: ["aboutother", "other"] },
    { code: "rs", stored: "reported_speech", alts: ["reported", "relayed", "reportedspeech"] },
    { code: "q3", stored: "quoted_third_party", alts: ["quoted", "forwarded", "quotedthirdparty"] },
  ]),
  origin: defineEnum("origin", [
    { code: "ex", stored: "explicit", alts: ["stated", "said"] },
    { code: "im", stored: "implicit", alts: ["inferred"] },
  ]),
  direction: defineEnum("direction", [
    { code: "i2t", stored: "i_owe_them", alts: ["u2o", "user_to_other", "iowethem"] },
    { code: "t2i", stored: "they_owe_me", alts: ["o2u", "other_to_user", "theyoweme"] },
    { code: "shr", stored: "shared", alts: ["both", "mutual"] },
    { code: "slf", stored: "self", alts: ["own"] },
  ]),
  stake: defineEnum("stake", [
    { code: "h", stored: "high" },
    { code: "m", stored: "medium" },
    { code: "l", stored: "low" },
  ]),
  horizon: defineEnum("horizon", [
    { code: "d", stored: "today" },
    { code: "w", stored: "week" },
    { code: "mo", stored: "month" },
    { code: "q", stored: "quarter" },
    { code: "y", stored: "year" },
    { code: "n", stored: "none" },
  ]),
  loop_state: defineEnum("loop_state", [
    { code: "op", stored: "open" },
    { code: "lt", stored: "latent" },
    { code: "dn", stored: "done" },
    { code: "lp", stored: "lapsed" },
    { code: "dr", stored: "dropped" },
  ]),
  triage: defineEnum("triage", [
    { code: "au", stored: "auto" },
    { code: "ap", stored: "approval" },
    { code: "cx", stored: "context" },
  ]),
  entity_type: defineEnum("entity_type", [
    { code: "per", stored: "person" },
    { code: "grp", stored: "group" },
    { code: "org", stored: "org", alts: ["organisation", "organization"] },
    { code: "plc", stored: "place" },
    { code: "thg", stored: "thing" },
    { code: "med", stored: "media_work", alts: ["mediawork", "media"] },
    { code: "doc", stored: "document" },
    { code: "occ", stored: "occasion" },
    { code: "top", stored: "topic" },
  ]),
  edge_kind: defineEnum("edge_kind", [
    { code: "rel", stored: "related_to", alts: ["relatedto"] },
    { code: "aff", stored: "affiliated_with", alts: ["affiliatedwith"] },
    { code: "has", stored: "has" },
    { code: "loc", stored: "located_at", alts: ["locatedat"] },
    { code: "prt", stored: "part_of", alts: ["partof"] },
    { code: "par", stored: "participates_in", alts: ["participatesin"] },
    { code: "abt", stored: "about" },
  ]),
  archetype: defineEnum("archetype", [
    { code: "prj", stored: "project" },
    { code: "evt", stored: "event" },
    { code: "rhy", stored: "rhythm" },
    { code: "adm", stored: "admin" },
    { code: "hld", stored: "holding" },
    { code: "mat", stored: "matter" },
    { code: "pur", stored: "pursuit" },
    { code: "wch", stored: "watch" },
  ]),
  promotion: defineEnum("promotion", [
    { code: "cmt", stored: "commitment" },
    { code: "ref", stored: "reference" },
    { code: "rec", stored: "recurrence" },
    { code: "usr", stored: "user" },
  ]),
  segment: defineEnum("segment", [
    { code: "att", stored: "attach" },
    { code: "new", stored: "new" },
  ]),
  arc_verdict: defineEnum("arc_verdict", [
    { code: "jn", stored: "join" },
    { code: "nw", stored: "new" },
    { code: "un", stored: "unsure" },
  ]),
  claim_verdict: defineEnum("claim_verdict", [
    { code: "dup", stored: "duplicate" },
    { code: "rfn", stored: "refinement" },
    { code: "ctr", stored: "contradiction" },
    { code: "dst", stored: "distinct" },
    { code: "un", stored: "unsure" },
  ]),
  entity_verdict: defineEnum("entity_verdict", [
    { code: "same", stored: "same", alts: ["match"] },
    { code: "diff", stored: "different" },
    { code: "un", stored: "unsure", alts: ["unclear"] },
  ]),
  done_state: defineEnum("done_state", [
    { code: "dn", stored: "done" },
    { code: "ps", stored: "possibly" },
    { code: "dr", stored: "dropped" },
    { code: "op", stored: "still_open", alts: ["stillopen", "open"] },
  ]),
  chat_kind: defineEnum("chat_kind", [
    { code: "grp", stored: "group" },
    { code: "dm", stored: "dm", alts: ["direct", "direct_message"] },
    { code: "biz", stored: "business" },
  ]),
  cadence: defineEnum("cadence", [
    // `deadline` is a tolerated *spelling* of a one-off cadence, not a new value.
    { code: "one", stored: "one_off", alts: ["oneoff", "once", "single", "one_time", "deadline"] },
    { code: "rec", stored: "recurrence", alts: ["recurring", "repeat", "repeating"] },
  ]),
  channel_class: defineEnum("channel_class", [
    { code: "tx", stored: "transactional" },
    { code: "pm", stored: "promotional" },
  ]),
  change: defineEnum("change", [
    { code: "ctr", stored: "contradicted", alts: ["contradiction", "contradicts"] },
    { code: "dat", stored: "dated", alts: ["date", "dates", "date_change"] },
    { code: "cmp", stored: "completed", alts: ["completes", "completion", "complete"] },
    { code: "cnl", stored: "cancelled", alts: ["cancels", "canceled", "cancellation", "cancel"] },
    { code: "rfn", stored: "refined", alts: ["refines", "refinement", "refine"] },
  ]),
} as const;

export type EnumName = keyof typeof ENUMS;

// ---- token wrappers (§5.7.3) ----------------------------------------------

export interface UnwrapResult {
  /** false only when a wrapper was present and its key did not match the field. */
  ok: boolean;
  /** The payload; `""` for a bare `{due}` — "not stated", never an invented date. */
  value: string;
  /** The key the model wrote, when the field was wrapped at all. */
  key: string | null;
  unwrapped: boolean;
}

const WRAPPER_RE = /^\{\s*([A-Za-z_][A-Za-z0-9_ -]*?)\s*(?::\s*([\s\S]*?))?\s*\}$/;

/**
 * `{due:2026-08-08}` in a date field unwraps to the date. `{conf:0.8}` in a
 * date field does NOT — the key must match the field, or the model has told us
 * something we cannot honour and that is a violation.
 */
export function unwrapToken(raw: string, acceptedKeys: readonly string[]): UnwrapResult {
  const t = typeof raw === "string" ? raw.trim() : "";
  const m = WRAPPER_RE.exec(t);
  if (!m) return { ok: true, value: t, key: null, unwrapped: false };
  const key = canonicalWireToken(m[1] ?? "");
  const accepted = acceptedKeys.map((k) => canonicalWireToken(k));
  if (!accepted.includes(key)) return { ok: false, value: t, key, unwrapped: false };
  return { ok: true, value: (m[2] ?? "").trim(), key, unwrapped: true };
}

// ---- line classes ----------------------------------------------------------

export type SkipClass = "fence" | "heading" | "marker" | "bullet" | "prose";

export interface WireSkip {
  /** 1-based, so a repair prompt can name the line. */
  line: number;
  class: SkipClass;
  /** The model's ORIGINAL text. Skipped is not deleted. */
  raw: string;
}

export interface WireViolation {
  line: number;
  tag: string | null;
  rule: string;
  detail: string;
  /** The model's ORIGINAL text (§5.8.1) so repair re-asks only failing lines. */
  raw: string;
  /** `response` is the single `no_wire_lines` verdict; everything else is `line`. */
  scope: "line" | "response";
}

export interface LineCandidate {
  kind: "candidate";
  line: number;
  /** Original bytes, kept for violations. */
  raw: string;
  /** Post-repair text handed to the codec. */
  text: string;
  emphasisStripped: boolean;
  bulletStripped: boolean;
}

export type ClassifiedLine =
  | LineCandidate
  | { kind: "skip"; skip: WireSkip }
  | { kind: "blank"; line: number };

export interface ToleranceState {
  inFence: boolean;
  emphasisStripped: number;
  bulletsStripped: number;
  fences: number;
  headings: number;
  markers: number;
  bullets: number;
  prose: number;
}

export function createToleranceState(): ToleranceState {
  return {
    inFence: false,
    emphasisStripped: 0,
    bulletsStripped: 0,
    fences: 0,
    headings: 0,
    markers: 0,
    bullets: 0,
    prose: 0,
  };
}

const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const INPUT_MARKER_RE = /^\s*#(?:R|C|E|T|D|COV)\b/;
const BULLET_RE = /^\s*(?:[-*+•‣·]|\d{1,3}[.)])\s+/;
const EMPHASIS_LEAD_RE = /^([*_`]+)/;
const EMPHASIS_TAIL_RE = /([*_`]+)$/;

/**
 * §5.7.1 — emphasis is stripped when the leading and trailing runs mirror, or
 * when an opener has no partner. A single unstripped `**T|` once produced 212
 * `unknown_tag` violations and zero claims in one run.
 *
 * The strip is gated on `accept`: it is attempted only when the line does not
 * already read as a wire line, and the result is kept only when it does. That
 * is what keeps it lossless — trailing `**bold**` inside a prose field is never
 * eaten off a line that already parses.
 */
export function stripEmphasis(text: string, accept: (s: string) => boolean): { text: string; stripped: boolean } {
  const t = text.trim();
  if (accept(t)) return { text: t, stripped: false };
  const lead = EMPHASIS_LEAD_RE.exec(t);
  const tail = EMPHASIS_TAIL_RE.exec(t);
  const candidates: string[] = [];
  if (lead && tail && lead[1][0] === tail[1][0] && lead[1].length + tail[1].length < t.length) {
    const n = Math.min(lead[1].length, tail[1].length);
    candidates.push(t.slice(n, t.length - n).trim());
  }
  if (lead && lead[1].length < t.length) candidates.push(t.slice(lead[1].length).trim());
  if (tail && tail[1].length < t.length) candidates.push(t.slice(0, t.length - tail[1].length).trim());
  for (const c of candidates) {
    if (accept(c)) return { text: c, stripped: true };
  }
  return { text: t, stripped: false };
}

/**
 * The ordered pipeline (§5.7): fence → heading → emphasis strip → bullet →
 * pipe test → prose test. Order is load-bearing: emphasis runs before the
 * bullet test so `**- …**` is seen, and the pipe test runs last so a line that
 * survived every wrapper is judged on its tag, not on its decoration.
 *
 * `isWireLine` is injected rather than imported so this module never depends on
 * the codec's tag table.
 */
export function classifyLine(
  rawLine: string,
  lineNo: number,
  state: ToleranceState,
  isWireLine: (s: string) => boolean,
): ClassifiedLine {
  const raw = rawLine.replace(/\r$/, "");
  if (raw.trim() === "") return { kind: "blank", line: lineNo };

  // 1. fences — the marker line is skipped, the content inside is still parsed.
  if (FENCE_RE.test(raw)) {
    state.inFence = !state.inFence;
    state.fences += 1;
    return { kind: "skip", skip: { line: lineNo, class: "fence", raw } };
  }

  // 2. input markers, then headings.
  if (INPUT_MARKER_RE.test(raw)) {
    state.markers += 1;
    return { kind: "skip", skip: { line: lineNo, class: "marker", raw } };
  }
  if (HEADING_RE.test(raw)) {
    state.headings += 1;
    return { kind: "skip", skip: { line: lineNo, class: "heading", raw } };
  }

  // 3. emphasis strip.
  const em = stripEmphasis(raw, isWireLine);
  if (em.stripped) {
    state.emphasisStripped += 1;
    return { kind: "candidate", line: lineNo, raw, text: em.text, emphasisStripped: true, bulletStripped: false };
  }

  // 4. bullets. A bullet is a skip class — unless the marker was hiding a real
  //    wire line, in which case dropping it would silently lose model output.
  const bullet = BULLET_RE.exec(raw);
  if (bullet) {
    const rest = raw.slice(bullet[0].length);
    const inner = stripEmphasis(rest, isWireLine);
    if (isWireLine(inner.text)) {
      state.bulletsStripped += 1;
      if (inner.stripped) state.emphasisStripped += 1;
      return {
        kind: "candidate",
        line: lineNo,
        raw,
        text: inner.text,
        emphasisStripped: inner.stripped,
        bulletStripped: true,
      };
    }
    state.bullets += 1;
    return { kind: "skip", skip: { line: lineNo, class: "bullet", raw } };
  }

  // 5. pipe test — a line with a `|` is a wire candidate, right or wrong.
  const trimmed = raw.trim();
  if (trimmed.includes("|")) {
    return { kind: "candidate", line: lineNo, raw, text: trimmed, emphasisStripped: false, bulletStripped: false };
  }

  // 6. prose test — no pipe, so it is language. Skipped, never repaired.
  state.prose += 1;
  return { kind: "skip", skip: { line: lineNo, class: "prose", raw } };
}

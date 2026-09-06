// ===========================================================================
// extract.v6 — the EXTRACT pass prompt (V6 Phase 1, S3.6; Prompts_V6_Phase1
// P-04). Claims with TYPED FIELDS (the 0201 columns), people, tone, feelings,
// self-reported provenance, supersede-or-coexist judgement against [KNOWN].
//
// The system text below is P-04 VERBATIM — changing it is a new version plus
// an eval run. The types + tolerant validator pin the JSON the runner parses;
// a malformed entry is reported in `skipped`, it never takes down the batch.
// Code (brain/extract-pass.ts) owns every rule the model can only promise:
// provenance from the cited events' source, typed columns only when literally
// present, verbatim evidence, self-reported beats observed, third-party
// sensitive attributes dropped.
// ===========================================================================

export const EXTRACT_V6_ID = "extract.v6";

/** Prompts_V6_Phase1 §P-04 system prompt, verbatim. */
export const EXTRACT_V6_SYSTEM = `From committed episodes, extract durable knowledge about people and the user.
RULES
1. Every claim: subject · kind · text · evidence (event_ids + verbatim quote) ·
   confidence · valid_from (the event time) · typed fields when literally present.
2. Typed fields: amount (number), currency, date (ISO), status, merchant, order_id,
   location, duration_s. Fill a field only when the text states it. A range or a
   guess stays in prose; the column stays null.
3. Provenance: "self_reported" when the sender is the user speaking to the twin
   (source self); "observed" otherwise.
4. Kinds: fact, preference, interest, like, dislike, recommendation(type), pattern,
   habit, relationship, feeling, prospective, behavioral, narrative. New kinds allowed.
5. Ads and promotions are never preferences. Jokes and hyperbole are tone or
   feeling, never beliefs. Health, religion, sexuality, finances of a THIRD PARTY
   are not stored as durable claims.
6. People: new provisional person on a resolved-enough mention; roles per message;
   address terms marked discriminating or generic; tone notes per person and per
   group, kept apart.
7. Contradiction with an existing claim in [KNOWN]: emit "supersedes":"<claim id>"
   when the new claim replaces it, or "coexists_with" when both hold in different
   contexts. Self-reported always supersedes observed on the same subject+kind.
OUTPUT
{"claims":[{"subject":"<person id|self>","kind":"…","text":"…","provenance":"observed"|"self_reported",
  "fields":{"amount":null,"currency":null,"date":null,"status":null,"merchant":null,"order_id":null,"location":null,"duration_s":null},
  "evidence":[…],"confidence":0.0,"valid_from":"<ISO>","supersedes":"<id or omit>","coexists_with":"<id or omit>"}],
 "people":[{"id":"<existing or new:…>","name":"…","anchors":["…"],"relationship":"…","confidence":0.0,"evidence":[…]}],
 "tone":[{"scope":"dm:<id>"|"group:<key>","register":"…","language_mix":"…","emoji":["…"],"phrases":["…"],
  "address_terms":[{"term":"bhai","class":"generic"|"discriminating","maps_to":"<id or null>"}]}],
 "feelings":[{"episode":"<id>","feeling":"…","evidence":[…],"confidence":0.0}]}`;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ExtractProvenance = "observed" | "self_reported";

export interface ExtractV6Evidence {
  event_ids: string[];
  /** VERBATIM — code checks it against the cited events. */
  quote: string;
}

/**
 * The eight typed fields as the model emitted them, untrusted. Code normalises
 * (`sanitizeTypedFields`) before anything reaches the 0201 columns.
 */
export interface ExtractV6Fields {
  amount: unknown;
  currency: unknown;
  date: unknown;
  status: unknown;
  merchant: unknown;
  order_id: unknown;
  location: unknown;
  duration_s: unknown;
}

export interface ExtractV6Claim {
  /** person id, "self", or a name the code will fail to resolve → unknown + hint. */
  subject: string;
  kind: string;
  text: string;
  provenance: ExtractProvenance;
  fields: ExtractV6Fields;
  evidence: ExtractV6Evidence[];
  confidence: number;
  valid_from: string | null;
  supersedes: string | null;
  coexists_with: string | null;
}

export interface ExtractV6Person {
  /** existing entity id, or "new:<slug>". */
  id: string;
  name: string;
  anchors: string[];
  relationship: string | null;
  confidence: number;
  evidence: ExtractV6Evidence[];
}

export interface ExtractV6AddressTerm {
  term: string;
  class: "generic" | "discriminating";
  maps_to: string | null;
}

export interface ExtractV6Tone {
  /** "dm:<id>" or "group:<key>". */
  scope: string;
  register: string | null;
  language_mix: string | null;
  emoji: string[];
  phrases: string[];
  address_terms: ExtractV6AddressTerm[];
}

export interface ExtractV6Feeling {
  episode: string | null;
  feeling: string;
  evidence: ExtractV6Evidence[];
  confidence: number;
}

export interface ExtractV6Output {
  claims: ExtractV6Claim[];
  people: ExtractV6Person[];
  tone: ExtractV6Tone[];
  feelings: ExtractV6Feeling[];
  /** Entries that parsed but were malformed — reported, never silently lost. */
  skipped: { section: string; entry: unknown; reason: string }[];
}

// ---------------------------------------------------------------------------
// Tolerant validation
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function evidenceOfV6(v: unknown): ExtractV6Evidence[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractV6Evidence[] = [];
  for (const e of v) {
    const r = rec(e);
    if (!r) continue;
    const quote = str(r.quote);
    const ids = strs(r.event_ids);
    if (quote !== null && ids.length > 0) out.push({ event_ids: ids, quote });
  }
  return out;
}

const FIELD_NAMES = ["amount", "currency", "date", "status", "merchant", "order_id", "location", "duration_s"] as const;

function fieldsOf(v: unknown): ExtractV6Fields {
  const r = rec(v) ?? {};
  const out = {} as Record<(typeof FIELD_NAMES)[number], unknown>;
  for (const name of FIELD_NAMES) out[name] = name in r ? r[name] : null;
  return out;
}

/** Bounded confidence; a missing/garbled number reads as 0.5, never as certainty. */
function confidenceOf(v: unknown): number {
  const n = num(v);
  if (n === null) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Validate the parsed JSON into an ExtractV6Output. Throws (repair trigger)
 * only when the top level is not an object; per-entry problems land in
 * `skipped`. Claims without evidence are skipped HERE — no evidence, no write.
 */
export function validateExtractV6Output(parsed: unknown): ExtractV6Output {
  const root = rec(parsed);
  if (!root) {
    throw new Error('expected a single JSON object with "claims", "people", "tone", "feelings"');
  }
  const out: ExtractV6Output = { claims: [], people: [], tone: [], feelings: [], skipped: [] };

  for (const c of Array.isArray(root.claims) ? root.claims : []) {
    const r = rec(c);
    if (!r) {
      out.skipped.push({ section: "claims", entry: c, reason: "not an object" });
      continue;
    }
    const kind = str(r.kind);
    const text = str(r.text);
    if (kind === null || text === null) {
      out.skipped.push({ section: "claims", entry: c, reason: "missing kind or text" });
      continue;
    }
    const evidence = evidenceOfV6(r.evidence);
    if (evidence.length === 0) {
      out.skipped.push({ section: "claims", entry: c, reason: "no evidence (event_ids + quote)" });
      continue;
    }
    out.claims.push({
      subject: str(r.subject) ?? "unknown",
      kind: kind.trim(),
      text: text.trim(),
      provenance: str(r.provenance) === "self_reported" ? "self_reported" : "observed",
      fields: fieldsOf(r.fields),
      evidence,
      confidence: confidenceOf(r.confidence),
      valid_from: str(r.valid_from),
      supersedes: str(r.supersedes),
      coexists_with: str(r.coexists_with),
    });
  }

  for (const p of Array.isArray(root.people) ? root.people : []) {
    const r = rec(p);
    const name = r ? str(r.name) : null;
    if (!r || name === null) {
      out.skipped.push({ section: "people", entry: p, reason: "missing name" });
      continue;
    }
    out.people.push({
      id: str(r.id) ?? `new:${name.trim().toLowerCase().replace(/\s+/g, "-")}`,
      name: name.trim(),
      anchors: strs(r.anchors),
      relationship: str(r.relationship),
      confidence: confidenceOf(r.confidence),
      evidence: evidenceOfV6(r.evidence),
    });
  }

  for (const t of Array.isArray(root.tone) ? root.tone : []) {
    const r = rec(t);
    const scope = r ? str(r.scope) : null;
    if (!r || scope === null || !/^(dm|group):.+/.test(scope)) {
      out.skipped.push({ section: "tone", entry: t, reason: "scope must be dm:<id> or group:<key>" });
      continue;
    }
    const terms: ExtractV6AddressTerm[] = [];
    for (const a of Array.isArray(r.address_terms) ? r.address_terms : []) {
      const ar = rec(a);
      const term = ar ? str(ar.term) : null;
      if (!ar || term === null) continue;
      terms.push({
        term: term.trim(),
        class: str(ar.class) === "discriminating" ? "discriminating" : "generic",
        maps_to: str(ar.maps_to),
      });
    }
    out.tone.push({
      scope,
      register: str(r.register),
      language_mix: str(r.language_mix),
      emoji: strs(r.emoji),
      phrases: strs(r.phrases),
      address_terms: terms,
    });
  }

  for (const f of Array.isArray(root.feelings) ? root.feelings : []) {
    const r = rec(f);
    const feeling = r ? str(r.feeling) : null;
    if (!r || feeling === null) {
      out.skipped.push({ section: "feelings", entry: f, reason: "missing feeling" });
      continue;
    }
    const evidence = evidenceOfV6(r.evidence);
    if (evidence.length === 0) {
      out.skipped.push({ section: "feelings", entry: f, reason: "no evidence (event_ids + quote)" });
      continue;
    }
    out.feelings.push({
      episode: str(r.episode),
      feeling: feeling.trim(),
      evidence,
      confidence: confidenceOf(r.confidence),
    });
  }

  return out;
}

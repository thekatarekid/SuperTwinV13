// ===========================================================================
// EXTRACT v1 (build P1.4, spec §8.3) — claims about people from committed
// episodes. Sonnet-class recommended, Haiku by default (build convention 7).
//
// The SYSTEM core below is the spec §8.3 text VERBATIM (v1 — changing it is a
// new version + an eval run). The OUTPUT SHAPE block pins the JSON the runner
// parses; validation is tolerant per entry — a malformed claim is skipped and
// reported, it never takes down the batch.
// ===========================================================================

export const EXTRACT_V1_ID = "extract.v1";

/** Spec §8.3 "System (core)" — verbatim. */
export const EXTRACT_V1_CORE = `Extract claims about people from committed episodes.
Kinds: fact, preference, belief, opinion, interest, habit,
recommendation, workflow, relationship.
- Subject = resolved roster id or "unknown"+hint. UNKNOWN BEATS WRONG.
- Resolved third person, never aliases. Every claim: evidence quote,
  confidence, valid_from.
- Against existing claims emit: new | reinforces(id) | contradicts(id)
  — contradictions never overwrite; a judge resolves supersede vs
  coexist; old claims get validity ends, never deletion.
- Habits/preferences need repetition or explicit statement — one
  purchase is not a preference; an ad is NEVER a preference
  (tier policy). Jokes/sarcasm are tone, not beliefs.
- Mentions of non-roster people → provisional person records.
- Also maintain tone profiles: how the user addresses each
  person/group (register, language mix, emoji) — generic address
  terms ("bro","boss") feed tone, never identity or relationship.
JSON only.`;

/** v1 output contract, appended after the core. */
export const EXTRACT_V1_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
{"claims":[{"kind":"preference","subject":"ent_x9 or unknown",
  "subject_hint":"only when subject is unknown","text":"…",
  "relation":"new","related_claim":null,
  "evidence":[{"event_ids":["e1"],"quote":"verbatim quote"}],
  "confidence":0.8,"valid_from":"2026-08-01"}],
 "provisional_people":[{"name":"Sameer","hint":"Rohan's cousin, mentioned once"}],
 "tone":[{"person":"ent_x9 or null","stream":"stream id or null",
  "register":"casual","language_mix":"Hinglish","emoji_habits":"heavy 😂",
  "address_terms":[{"term":"bro","class":"generic"}]}]}
relation is "new", "reinforces" or "contradicts"; related_claim carries the
claim id it reinforces/contradicts, else null. Omit sections you have nothing
for by emitting empty arrays.`;

/** The byte-stable system prompt for the extract.v1 pass. */
export const EXTRACT_V1_SYSTEM = `${EXTRACT_V1_CORE}\n\n${EXTRACT_V1_OUTPUT}`;

// ---------------------------------------------------------------------------
// Output types + tolerant validation
// ---------------------------------------------------------------------------

export interface ExtractEvidence {
  event_ids: string[];
  quote: string;
}

export interface ExtractedClaim {
  kind: string;
  subject: string; // roster id or "unknown"
  subject_hint?: string | null;
  text: string;
  relation: "new" | "reinforces" | "contradicts";
  related_claim?: string | null;
  /** extract.v2: the date the contradicted old claim stopped holding. */
  old_valid_until?: string | null;
  evidence: ExtractEvidence[];
  confidence: number;
  valid_from?: string | null;
}

export interface ProvisionalPerson {
  name: string;
  hint?: string | null;
}

export interface ToneUpdate {
  person?: string | null;
  stream?: string | null;
  register?: string | null;
  language_mix?: string | null;
  emoji_habits?: string | null;
  address_terms?: { term: string; class: "discriminating" | "generic" }[];
}

export interface ExtractOutput {
  claims: ExtractedClaim[];
  provisional_people: ProvisionalPerson[];
  tone: ToneUpdate[];
  /** Entries that parsed but were malformed — reported, never silently lost. */
  skipped: { section: string; entry: unknown; reason: string }[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function evidenceOf(v: unknown): ExtractEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractEvidence[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const quote = str(r.quote);
    const ids = Array.isArray(r.event_ids)
      ? r.event_ids.filter((x): x is string => typeof x === "string")
      : [];
    if (quote !== null) out.push({ event_ids: ids, quote });
  }
  return out;
}

/**
 * Validate the parsed JSON into an ExtractOutput. Throws (repair trigger) only
 * when the top level is not an object; per-entry problems land in `skipped`.
 */
export function validateExtractOutput(parsed: unknown): ExtractOutput {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a single JSON object with "claims", "provisional_people", "tone"');
  }
  const root = parsed as Record<string, unknown>;
  const out: ExtractOutput = { claims: [], provisional_people: [], tone: [], skipped: [] };

  const claims = Array.isArray(root.claims) ? root.claims : [];
  for (const c of claims) {
    if (typeof c !== "object" || c === null) {
      out.skipped.push({ section: "claims", entry: c, reason: "not an object" });
      continue;
    }
    const r = c as Record<string, unknown>;
    const kind = str(r.kind);
    const text = str(r.text);
    const subject = str(r.subject) ?? "unknown";
    const evidence = evidenceOf(r.evidence);
    const confidence = num(r.confidence);
    const relationRaw = str(r.relation) ?? "new";
    const relation =
      relationRaw === "reinforces" || relationRaw === "contradicts" ? relationRaw : "new";
    if (kind === null || text === null) {
      out.skipped.push({ section: "claims", entry: c, reason: "missing kind or text" });
      continue;
    }
    if (evidence.length === 0) {
      // No evidence, no write (claims store rule) — skipped loudly here.
      out.skipped.push({ section: "claims", entry: c, reason: "no evidence quote" });
      continue;
    }
    out.claims.push({
      kind,
      subject,
      subject_hint: str(r.subject_hint),
      text,
      relation,
      related_claim: str(r.related_claim),
      old_valid_until: str(r.old_valid_until),
      evidence,
      confidence: confidence ?? 0.5,
      valid_from: str(r.valid_from),
    });
  }

  const people = Array.isArray(root.provisional_people) ? root.provisional_people : [];
  for (const p of people) {
    const r = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
    const name = str(r.name);
    if (name === null) {
      out.skipped.push({ section: "provisional_people", entry: p, reason: "missing name" });
      continue;
    }
    out.provisional_people.push({ name, hint: str(r.hint) });
  }

  const tone = Array.isArray(root.tone) ? root.tone : [];
  for (const t of tone) {
    if (typeof t !== "object" || t === null) {
      out.skipped.push({ section: "tone", entry: t, reason: "not an object" });
      continue;
    }
    const r = t as Record<string, unknown>;
    const terms = Array.isArray(r.address_terms)
      ? r.address_terms
          .map((a) => {
            const ar = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
            const term = str(ar.term);
            if (term === null) return null;
            return {
              term,
              class: (str(ar.class) === "discriminating" ? "discriminating" : "generic") as
                | "discriminating"
                | "generic",
            };
          })
          .filter((x): x is { term: string; class: "discriminating" | "generic" } => x !== null)
      : [];
    const person = str(r.person);
    const stream = str(r.stream);
    if (person === null && stream === null) {
      out.skipped.push({ section: "tone", entry: t, reason: "no person or stream scope" });
      continue;
    }
    out.tone.push({
      person,
      stream,
      register: str(r.register),
      language_mix: str(r.language_mix),
      emoji_habits: str(r.emoji_habits),
      address_terms: terms,
    });
  }

  return out;
}

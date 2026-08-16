// ===========================================================================
// [CODE] The party model — arch §4.5, build item 1.6.
//
// Three roles relative to ONE session, and nine ordered pairs made of them:
//
//   s  SELF    the "me" entity
//   o  OTHER   a participant of THIS session (present in the conversation)
//   t  THIRD   mentioned but NOT a participant (absent from the conversation)
//
//   claim.party_pair = role(speaker_id) ‖ role(subject_id)
//   loop.party_pair  = role(owner_id)   ‖ role(counterparty_id)
//
// Everything in this file is `[CODE]`. The pair is DERIVED, never asked of a
// model and never carried on the wire: the participant set is already known
// from the session and `speaker_id` is already written from the event actor,
// so the pair falls out for free. `rejectModelParty` is the enforcement — any
// model output that names a party field is a violation, quoted verbatim.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO
//
//   1. It never looks at an addressee. `o` means "participant of this
//      session", NOT "the person spoken to". In a five-person group everyone
//      present is `o`; who was being spoken *to* is `addressee_id` and lives
//      entirely outside the pair. The separation is that no function here
//      accepts one.
//   2. It never guesses. An id that is missing yields no pair at all
//      (`null`) rather than a plausible-looking one, because a wrong `os` is
//      far worse than an absent pair.
//
// `party_pair` is orthogonal to `attribution`: the pair answers *who,
// structurally*, attribution answers *what kind of speech act*. A `ts` pair
// with `reported_speech` is "you told me what Rahul said about me" — both
// dimensions are needed and neither substitutes for the other.
// ===========================================================================

// ---- roles and pairs -------------------------------------------------------

/** §4.5 — self, participant of this session, absent from it. */
export const PARTY_ROLES = ["s", "o", "t"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/** The nine ordered pairs, source ‖ target. There is no tenth. */
export const PARTY_PAIRS = ["ss", "so", "st", "os", "oo", "ot", "ts", "to", "tt"] as const;
export type PartyPair = (typeof PARTY_PAIRS)[number];

const ROLE_SET: ReadonlySet<string> = new Set(PARTY_ROLES);
const PAIR_SET: ReadonlySet<string> = new Set(PARTY_PAIRS);

export function isPartyRole(value: unknown): value is PartyRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

export function isPartyPair(value: unknown): value is PartyPair {
  return typeof value === "string" && PAIR_SET.has(value);
}

/** §4.5's table, kept next to the code so a reading is never re-invented in a UI. */
export const PAIR_READING: Readonly<Record<PartyPair, { claim: string; loop: string }>> = {
  ss: { claim: "I state something about myself", loop: "I owe myself" },
  so: { claim: "I state something about you", loop: "I owe you" },
  st: { claim: "I state something about an absent person", loop: "I owe an absent person" },
  os: { claim: "You state something about me", loop: "You owe me" },
  oo: { claim: "You state something about yourself", loop: "You owe yourself" },
  ot: { claim: "You state something about an absent person", loop: "You owe an absent person" },
  ts: { claim: "An absent person's words, about me", loop: "An absent person owes me" },
  to: { claim: "An absent person's words, about you", loop: "An absent person owes you" },
  tt: { claim: "An absent person's words, about another absent person", loop: "Neither party is present" },
};

/** The source half — who spoke, who owes. */
export function sourceRole(pair: PartyPair): PartyRole {
  return pair[0] as PartyRole;
}

/** The target half — who it is about, who is owed. */
export function targetRole(pair: PartyPair): PartyRole {
  return pair[1] as PartyRole;
}

/** True when `s` sits in either position — the whole "is this mine" question. */
export function pairInvolvesSelf(pair: string | null | undefined): boolean {
  return isPartyPair(pair) && (pair[0] === "s" || pair[1] === "s");
}

/** The five pairs that carry an `s`. Derived, never typed out twice. */
export const SELF_PAIRS: readonly PartyPair[] = PARTY_PAIRS.filter((p) => pairInvolvesSelf(p));

/** The four that do not. `oo` is the one §4.5 names; the rest are no more yours. */
export const NON_SELF_PAIRS: readonly PartyPair[] = PARTY_PAIRS.filter((p) => !pairInvolvesSelf(p));

// ---- role(entity, session) -------------------------------------------------

/**
 * One session's view of the world: who "me" is, and who was in the room.
 * Participants are entity ids — a name string is never an id (§4.2).
 */
export interface PartySession {
  selfEntityId?: string | null;
  participantEntityIds?: readonly (string | null | undefined)[] | null;
}

function normId(id: string | null | undefined): string | null {
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

function participantSet(session: PartySession): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of session.participantEntityIds ?? []) {
    const id = normId(raw);
    if (id !== null) out.add(id);
  }
  return out;
}

/**
 * `role(entity, session)`. An id that is neither `me` nor a participant of
 * THIS session is `t` — including one that resolved to nothing at all, which
 * is structurally the same statement: not me, not in the room.
 */
export function roleOf(entityId: string | null | undefined, session: PartySession): PartyRole {
  const id = normId(entityId);
  if (id === null) return "t";
  if (id === normId(session.selfEntityId)) return "s";
  return participantSet(session).has(id) ? "o" : "t";
}

/**
 * Every role in one pass, for a whole roster. The five-person-group case:
 * every participant reads `o` no matter which one was being spoken to.
 */
export function rolesOf(
  entityIds: readonly (string | null | undefined)[],
  session: PartySession,
): Record<string, PartyRole> {
  const self = normId(session.selfEntityId);
  const participants = participantSet(session);
  const out: Record<string, PartyRole> = {};
  for (const raw of entityIds) {
    const id = normId(raw);
    if (id === null) continue;
    out[id] = id === self ? "s" : participants.has(id) ? "o" : "t";
  }
  return out;
}

/**
 * `role(source) ‖ role(target)`, or `null` when either id is missing. A pair
 * is only ever written when both ends are known — a subject that is still a
 * `subject_hint` string has no role, and inventing `t` for it would file real
 * gossip and unresolved text in the same bucket.
 */
export function pairOf(
  sourceId: string | null | undefined,
  targetId: string | null | undefined,
  session: PartySession,
): PartyPair | null {
  if (normId(sourceId) === null || normId(targetId) === null) return null;
  return `${roleOf(sourceId, session)}${roleOf(targetId, session)}` as PartyPair;
}

// ---- claims and loops ------------------------------------------------------

/** camelCase in code; the `_id` spellings are what a `claim_versions` row hands you. */
export interface ClaimParties {
  speakerId?: string | null;
  subjectId?: string | null;
  speaker_id?: string | null;
  subject_id?: string | null;
}

export interface LoopParties {
  ownerId?: string | null;
  counterpartyId?: string | null;
  owner_id?: string | null;
  counterparty_id?: string | null;
}

/** `claim.party_pair = role(speaker) ‖ role(subject)` [CODE]. */
export function claimPartyPair(claim: ClaimParties, session: PartySession): PartyPair | null {
  return pairOf(claim.speakerId ?? claim.speaker_id, claim.subjectId ?? claim.subject_id, session);
}

/** `loop.party_pair = role(owner) ‖ role(counterparty)` [CODE]. */
export function loopPartyPair(loop: LoopParties, session: PartySession): PartyPair | null {
  return pairOf(loop.ownerId ?? loop.owner_id, loop.counterpartyId ?? loop.counterparty_id, session);
}

// ---- "not your space" ------------------------------------------------------

/** A loop as this module needs to see it: a stored pair, or the ids to derive one. */
export interface PartyLoopLike extends LoopParties {
  partyPair?: string | null;
  party_pair?: string | null;
}

export interface PartyThread {
  loops?: readonly PartyLoopLike[] | null;
}

/** The stored pair if there is one, otherwise derived from the ids. */
export function resolveLoopPair(loop: PartyLoopLike, session: PartySession = {}): PartyPair | null {
  const stored = loop.partyPair ?? loop.party_pair;
  if (isPartyPair(stored)) return stored;
  return loopPartyPair(loop, session);
}

/**
 * §4.5.3 — **a thread whose loops carry no `s` in either position is not your
 * space.** It is context on the person it is about, and it belongs on their
 * People record. This is the code rule that kills "8 spaces that were really
 * other people's lives", so it is deliberately a hard boolean and not a score.
 *
 * A thread with no loops at all involves no self: nothing has been claimed.
 */
export function threadInvolvesSelf(arc: PartyThread, session: PartySession = {}): boolean {
  for (const loop of arc.loops ?? []) {
    if (pairInvolvesSelf(resolveLoopPair(loop, session))) return true;
  }
  return false;
}

export interface ThreadPartyVerdict {
  /** Every loop's pair, in order; `null` for a loop whose ends are unresolved. */
  pairs: (PartyPair | null)[];
  involvesSelf: boolean;
  /** Promotion to a space requires self-involvement. Nothing else here decides it. */
  promotionEligible: boolean;
  reason: "self_involved" | "no_self_in_any_loop";
}

/** `threadInvolvesSelf` with its working shown — what the promotion item records. */
export function threadPartyVerdict(arc: PartyThread, session: PartySession = {}): ThreadPartyVerdict {
  const pairs = (arc.loops ?? []).map((loop) => resolveLoopPair(loop, session));
  const involvesSelf = pairs.some((pair) => pairInvolvesSelf(pair));
  return {
    pairs,
    involvesSelf,
    promotionEligible: involvesSelf,
    reason: involvesSelf ? "self_involved" : "no_self_in_any_loop",
  };
}

/**
 * §4.5.3 — `oo` loops are someone else's business entirely and must never
 * reach your task list. Neither may `ot`, `to` or `tt`: the rule is the `s`,
 * and `oo` is simply the case the doc names because it is the one that keeps
 * happening. A loop with no derivable pair is not admitted either — an
 * unplaced loop is not evidence that it is yours.
 */
export function loopIsTaskEligible(pair: string | null | undefined): boolean {
  return pairInvolvesSelf(pair);
}

/** The pairs that may never appear in the task list. */
export const TASK_EXCLUDED_PAIRS: readonly PartyPair[] = NON_SELF_PAIRS;

// ---- never on the wire, never asked of a model -----------------------------

/**
 * Field names that would mean a model was carrying the pair. Compared with
 * separators stripped, so `party-pair`, `party_pair` and `partyPair` are one
 * name and none of them can slip through on spelling.
 */
const PARTY_FIELD_NAMES: ReadonlySet<string> = new Set([
  "party",
  "parties",
  "partypair",
  "partypairs",
  "partyrole",
  "partyroles",
  "pair",
  "pairs",
  "rolepair",
]);

function foldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

/** Is this the name of a party field? Used on wire tag specs and on model keys. */
export function isPartyFieldName(name: string): boolean {
  return typeof name === "string" && PARTY_FIELD_NAMES.has(foldName(name));
}

export interface PartyEmission {
  /** `line 3`, or a JSON path like `claims[0].party_pair`. */
  path: string;
  /** The key exactly as the model wrote it. */
  field: string;
  /** The value exactly as the model wrote it. */
  value: string;
  /** The model's original line or leaf — quoted, never edited (§5.8.1). */
  raw: string;
  rule: "party_never_emitted";
}

/**
 * `party_pair=os`, `party: "ss"`, `pair='tt'`. The key must be a party field
 * name AND the value must be a role or a pair, which is what keeps ordinary
 * prose ("the pair of them", "at the party") out of the violation list.
 */
const EMISSION_RE = /([A-Za-z][A-Za-z_-]*)\s*["']?\s*[:=]\s*["']?([A-Za-z]{1,2})\b/g;

/** Every party emission in a block of model text, one per occurrence. */
export function partyEmissionsInText(text: unknown): PartyEmission[] {
  if (typeof text !== "string" || text === "") return [];
  const out: PartyEmission[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    EMISSION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMISSION_RE.exec(line)) !== null) {
      const field = m[1]!;
      const value = m[2]!;
      if (!isPartyFieldName(field)) continue;
      const folded = value.toLowerCase();
      if (!PAIR_SET.has(folded) && !ROLE_SET.has(folded)) continue;
      out.push({ path: `line ${i + 1}`, field, value, raw: line, rule: "party_never_emitted" });
    }
  });
  return out;
}

/** Every party-named key in a structured model answer, at any depth. */
export function partyFieldsInValue(value: unknown, path = "$"): PartyEmission[] {
  const out: PartyEmission[] = [];
  const walk = (node: unknown, at: string, depth: number): void => {
    if (depth > 32 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const here = `${at}.${key}`;
      if (isPartyFieldName(key)) {
        out.push({
          path: here,
          field: key,
          value: typeof child === "string" ? child : JSON.stringify(child) ?? "",
          raw: JSON.stringify({ [key]: child }),
          rule: "party_never_emitted",
        });
      }
      walk(child, here, depth + 1);
    }
  };
  walk(value, path, 0);
  return out;
}

export interface PartyRejection {
  /** True when the model kept its hands off the pair — the only accepted case. */
  ok: boolean;
  emissions: PartyEmission[];
}

/**
 * **Reject any model output containing a party field.** Text or parsed value,
 * either way: the pair is derived here and nowhere else, so a model that sends
 * one is answering a question it was never asked.
 *
 * Rejection is a verdict, not an edit. Nothing is stripped, rewritten or
 * quietly dropped — every emission is returned with the model's own bytes so a
 * repair round can re-ask exactly the offending lines.
 */
export function rejectModelParty(input: unknown): PartyRejection {
  const emissions =
    typeof input === "string" ? partyEmissionsInText(input) : partyFieldsInValue(input);
  return { ok: emissions.length === 0, emissions };
}

// ---- the pair is queryable -------------------------------------------------

export interface PartyClaimQuery {
  /** One pair, or several. `ot` + speaker + subject is "what Rahul said about Ana". */
  pair?: string | null;
  pairs?: readonly string[] | null;
  speakerId?: string | null;
  subjectId?: string | null;
  /** Restricts to the five pairs carrying an `s`. */
  involvesSelf?: boolean;
}

export interface PartyClaimFilter {
  where: string;
  params: unknown[];
  sql: string;
}

/**
 * The SQL half of "party_pair is queryable and load-bearing" (§4.5.3). Reads
 * `claims_active`, whose precedence is `stated_at` — `ingested_at` is never
 * compared, here or anywhere.
 */
export function partyClaimFilter(query: PartyClaimQuery = {}): PartyClaimFilter {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const wanted = new Set<string>();
  if (isPartyPair(query.pair)) wanted.add(query.pair);
  for (const p of query.pairs ?? []) if (isPartyPair(p)) wanted.add(p);
  if (query.involvesSelf === true) {
    const self = new Set<string>(SELF_PAIRS);
    if (wanted.size === 0) for (const p of self) wanted.add(p);
    else for (const p of [...wanted]) if (!self.has(p)) wanted.delete(p);
  }
  if (wanted.size > 0) {
    const ordered = PARTY_PAIRS.filter((p) => wanted.has(p));
    clauses.push(`party_pair IN (${ordered.map(() => "?").join(", ")})`);
    params.push(...ordered);
  }

  const speaker = normId(query.speakerId);
  if (speaker !== null) {
    clauses.push("speaker_id = ?");
    params.push(speaker);
  }
  const subject = normId(query.subjectId);
  if (subject !== null) {
    clauses.push("subject_id = ?");
    params.push(subject);
  }

  const where = clauses.length > 0 ? clauses.join(" AND ") : "1 = 1";
  return {
    where,
    params,
    sql: `SELECT * FROM claims_active WHERE ${where} ORDER BY stated_at DESC, id DESC`,
  };
}

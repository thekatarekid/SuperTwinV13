// ===========================================================================
// [CODE] The role resolution ladder — V6 P1 S5.4 (Product_V6 §11.5,
// Product_V6_Phase1 §11.1–11.2).
//
//   sender ─► audience (who can see) ⊇ receiver (who it is addressed to)
//                        ⊇ mentioned receiver (named, in audience)
//             mentioned third party (named, NOT in audience)
//
// The ladder, top rung first. A higher rung that decides ENDS the walk:
//
//   1. structural   code, 1.0 — DM (receiver = the other party), platform
//                   @mentions, the reply / quote chain (an assent binds to the
//                   message it replies to, never to the nearest question).
//   2. roster       names in the text matched against the resolved roster
//                   (canonical + aliases). A roster name IN the audience is an
//                   addressee ("aditya tu ho gaya na?", "tanvi ask dev …").
//   3. roster+retrieval  a name that is not on the roster pulls candidates
//                   from the entity store (candidatesForName) — a provisional
//                   person is minted when nobody matches (provisional.ts).
//   4. address-term memory  "boss" in the Falcon group has only ever meant
//                   Sameer → discriminating → receiver. "bro" is said to three
//                   people → generic → ZERO addressee evidence, tone only.
//   5. context      the open item the message is about has an owner in the
//                   audience ("bro send the payment link" — Rohan owns the
//                   villa booking) → receiver with a stated basis.
//   6. model        an injected candidate list with confidence. Accepted at or
//                   above MODEL_FLOOR and only for ids inside the audience.
//   7. code again   mentioned receiver vs third party is a SET-MEMBERSHIP test
//                   against the structural audience. Never the model's job.
//   8. unknown beats wrong  a directed message nobody above could place is
//                   `unknown` plus a question. A broadcast ("guys, carry
//                   jackets") is addressed to the whole audience — that is a
//                   resolution, not a guess.
//
// Every verdict is a `role_resolutions` row (0206). A later confirmation
// writes a NEW row with `revised_from` — yesterday's 0.65 is kept, not edited
// (ROL-10). Pronouns resolve by antecedent search over the episode's prior
// messages: one candidate → resolved; two → unknown + hint (ROL-05).
//
// This module reads no model. The model rung is a function the caller
// injects; production passes it from the live/orient path, unit tests and
// the ROL executor pass none.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { classifyAddressTerm, leadingAddressTerm, type AddressClass } from "./address-terms.js";

export const MODEL_FLOOR = 0.7;
/** A discriminating term must have been seen this many times in one scope. */
export const DISCRIMINATING_MIN_OBSERVATIONS = 3;

export interface RosterPerson {
  id: string;
  name: string;
  aliases?: string[];
  /** Optional pronoun hint the roster carries ("she" | "he"). Never inferred here. */
  pronoun?: "she" | "he" | null;
}

export interface RoleStream {
  key: string;
  /** Structural audience — every id that can see the message. */
  audience: string[];
  isGroup: boolean;
}

export interface RoleMessage {
  id: string;
  sender: string;
  text: string;
  ts?: string;
  /** Platform @mention ids (structural, 1.0). */
  mentions?: string[];
  /** Id of the message this one replies to / quotes (structural, 1.0). */
  replyTo?: string;
}

export interface ModelCandidate {
  id: string;
  confidence: number;
  reason?: string;
}

export interface ContextOwner {
  /** Lower-case keywords that identify the open item ("villa", "payment link"). */
  keywords: string[];
  /** Roster id of the item's owner. */
  owner: string;
  /** Where the ownership came from ("ep_412: Rohan owns the villa booking"). */
  source: string;
}

export interface ResolveContext {
  roster: RosterPerson[];
  stream: RoleStream;
  /** Earlier messages of the episode, oldest first (reply chain + pronouns). */
  prior?: RoleMessage[];
  /** Open items with owners — rung 5. */
  contextOwners?: ContextOwner[];
  /** Rung 6 — never called when a higher rung decided. */
  model?: (msg: RoleMessage, ctx: ResolveContext) => ModelCandidate[] | null;
  /** The user's id in the roster. Defaults to "self". */
  selfId?: string;
  /**
   * Address-term memory for THIS stream scope: term → {addressee → count}.
   * When absent the DB-backed classifier (address-terms.ts) is consulted.
   */
  addressMemory?: Record<string, Record<string, number>>;
  /** Address-term usage in OTHER scopes (for the generic test). */
  addressMemoryElsewhere?: Record<string, Record<string, number>>;
}

export type Rung = "structural" | "reply" | "named" | "address_term" | "context" | "model" | "broadcast" | "unknown";

export interface RoleResolution {
  messageId: string;
  sender: string;
  audience: string[];
  /** Empty when unknown. */
  receiver: string[];
  /** Named, in audience (⊆ receiver when the name decided it). */
  mentionedReceivers: string[];
  /** Named, NOT in audience — never a task owner in our system. */
  thirdParties: string[];
  status: "resolved" | "unknown";
  rung: Rung;
  basis: string;
  confidence: number;
  /** The message an assent/answer binds to (reply chain), when structural. */
  boundTo?: string;
  question?: string;
  /** Address terms seen, with their class — generic ones contribute nothing. */
  addressTerms: { term: string; class: AddressClass; mapsTo: string | null }[];
}

// ---- helpers ---------------------------------------------------------------

const BROADCAST_WORDS = /\b(guys|everyone|everybody|all|sab|sabko|sab log|team|folks|people|friends|dosto)\b/i;
/** "booked", "done", "paid", "ho gaya", "✅" — the words a completion carries. */
export const COMPLETION_MARKER = /(\b(booked|book kar diya|done|paid|sent|bhej diya|confirmed|sorted|ho gaya|kar diya|kar diya hai)\b|✅)/i;
const IMPERATIVE_START =
  /^(send|book|pay|call|check|share|bhej|kar|karo|forward|confirm|reply|tell|ask|bring|get|drop|pick|transfer|update|push|move|please|pls|plz|can you|could you|will you)\b/i;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s@'-]/gu, " ").replace(/\s+/g, " ").trim();
}

function wordIn(text: string, word: string): boolean {
  const t = ` ${norm(text)} `;
  return t.includes(` ${norm(word)} `);
}

/** Roster ids whose name or alias appears in the text (word-boundary, case-insensitive). */
export function namesInText(text: string, roster: readonly RosterPerson[]): string[] {
  const out: string[] = [];
  for (const p of roster) {
    const names = [p.name, ...(p.aliases ?? [])].filter((n) => n.trim() !== "");
    if (names.some((n) => wordIn(text, n) || wordIn(text, `@${n}`))) out.push(p.id);
  }
  return out;
}

/** "@Karan" tokens resolved against the roster — structural when the platform did not pass ids. */
export function atMentionsInText(text: string, roster: readonly RosterPerson[]): string[] {
  const out: string[] = [];
  const re = /@([\p{L}][\p{L}\p{N}_.-]*)/gu;
  for (const m of text.matchAll(re)) {
    const tok = m[1]!.toLowerCase();
    for (const p of roster) {
      const names = [p.name, ...(p.aliases ?? [])].map((n) => n.toLowerCase());
      if (names.some((n) => n === tok || n.split(/\s+/)[0] === tok)) out.push(p.id);
    }
  }
  return [...new Set(out)];
}

/**
 * Rung 7 — set membership against the structural audience. Pure.
 * Names in the audience are mentioned receivers; the rest are third parties.
 */
export function splitByAudience(named: readonly string[], audience: readonly string[]): { inAudience: string[]; thirdParties: string[] } {
  const aud = new Set(audience);
  const inAudience: string[] = [];
  const thirdParties: string[] = [];
  for (const id of new Set(named)) (aud.has(id) ? inAudience : thirdParties).push(id);
  return { inAudience, thirdParties };
}

function isBroadcast(text: string): boolean {
  return BROADCAST_WORDS.test(text);
}

function isDirected(text: string, hadAddressTerm: boolean): boolean {
  if (hadAddressTerm) return true;
  const t = text.trim();
  return IMPERATIVE_START.test(t) || /\?\s*$/.test(t) && !isBroadcast(t);
}

function classifyFromMemory(
  here: Record<string, number> | undefined,
  elsewhere: Record<string, number> | undefined,
): { class: AddressClass; mapsTo: string | null } {
  const hereIds = Object.keys(here ?? {});
  const elsewhereIds = Object.keys(elsewhere ?? {});
  const distinct = new Set([...hereIds, ...elsewhereIds]);
  if (distinct.size >= 2) return { class: "generic", mapsTo: null };
  if (hereIds.length === 1 && (here![hereIds[0]!] ?? 0) >= DISCRIMINATING_MIN_OBSERVATIONS) {
    return { class: "discriminating", mapsTo: hereIds[0]! };
  }
  return { class: "generic", mapsTo: null };
}

// ---- the ladder ------------------------------------------------------------

export function resolveRoles(msg: RoleMessage, ctx: ResolveContext): RoleResolution {
  const selfId = ctx.selfId ?? "self";
  const audience = [...new Set(ctx.stream.audience)];
  const others = audience.filter((id) => id !== msg.sender);
  const rosterById = new Map(ctx.roster.map((p) => [p.id, p]));

  // Names in the text, by roster — and the set test that classifies them.
  const named = namesInText(msg.text, ctx.roster).filter((id) => id !== msg.sender);
  const { inAudience: mentionedReceivers, thirdParties } = splitByAudience(named, audience);

  // Address terms: leading vocative, classified before anything else so the
  // record shows a generic term carried nothing.
  const addressTerms: RoleResolution["addressTerms"] = [];
  const lead = leadingAddressTerm(msg.text);
  let discriminatingTarget: string | null = null;
  if (lead) {
    let cls: { class: AddressClass; mapsTo: string | null };
    if (ctx.addressMemory || ctx.addressMemoryElsewhere) {
      cls = classifyFromMemory(ctx.addressMemory?.[lead], ctx.addressMemoryElsewhere?.[lead]);
    } else {
      const c = classifyAddressTerm(lead, ctx.stream.key);
      cls = { class: c.class, mapsTo: c.mapsTo };
    }
    addressTerms.push({ term: lead, class: cls.class, mapsTo: cls.mapsTo });
    if (cls.class === "discriminating" && cls.mapsTo && audience.includes(cls.mapsTo) && cls.mapsTo !== msg.sender) {
      discriminatingTarget = cls.mapsTo;
    }
  }

  const base = {
    messageId: msg.id,
    sender: msg.sender,
    audience,
    mentionedReceivers,
    thirdParties,
    addressTerms,
  };

  const done = (
    receiver: string[],
    rung: Rung,
    basis: string,
    confidence: number,
    extra: Partial<RoleResolution> = {},
  ): RoleResolution => ({
    ...base,
    receiver: receiver.filter((id) => audience.includes(id)),
    status: "resolved",
    rung,
    basis,
    confidence,
    ...extra,
  });

  // 1. structural — DM
  if (!ctx.stream.isGroup) {
    const other = others.length > 0 ? others : audience.filter((id) => id !== selfId);
    return done(other, "structural", "DM: receiver = audience = one person", 1);
  }
  // 1. structural — platform @mentions (ids), or @Name tokens resolved on the roster
  const structuralMentions = [...new Set([...(msg.mentions ?? []), ...atMentionsInText(msg.text, ctx.roster)])].filter(
    (id) => id !== msg.sender,
  );
  const split = splitByAudience(structuralMentions, audience);
  if (split.inAudience.length > 0) {
    return done(split.inAudience, "structural", "@mention (structural)", 1, {
      mentionedReceivers: [...new Set([...mentionedReceivers, ...split.inAudience])],
      thirdParties: [...new Set([...thirdParties, ...split.thirdParties])],
    });
  }
  // 1. structural — reply chain
  if (msg.replyTo) {
    const target = (ctx.prior ?? []).find((p) => p.id === msg.replyTo);
    if (target && target.sender !== msg.sender && audience.includes(target.sender)) {
      return done([target.sender], "reply", `reply marker (structural) → answers ${target.id}`, 1, { boundTo: target.id });
    }
  }
  // 2. roster — a named addressee inside the audience
  if (mentionedReceivers.length > 0) {
    const names = mentionedReceivers.map((id) => rosterById.get(id)?.name ?? id).join(", ");
    const tp = thirdParties.length > 0 ? `; ${thirdParties.map((id) => rosterById.get(id)?.name ?? id).join(", ")} named but not in audience → third party (code set test)` : "";
    return done(mentionedReceivers, "named", `named address: ${names}${tp}`, 0.9);
  }
  // 4. address-term memory — discriminating only
  if (discriminatingTarget) {
    return done(
      [discriminatingTarget],
      "address_term",
      `address-style memory: "${lead}" is discriminating in this group → ${rosterById.get(discriminatingTarget)?.name ?? discriminatingTarget}`,
      0.85,
    );
  }
  // 5. context — the open item's owner
  const lower = norm(msg.text);
  for (const c of ctx.contextOwners ?? []) {
    if (c.owner === msg.sender || !audience.includes(c.owner)) continue;
    if (c.keywords.some((k) => lower.includes(norm(k)))) {
      const genericNote = lead ? `"${lead}" is generic — zero addressee evidence; ` : "";
      return done([c.owner], "context", `${genericNote}context: ${c.source}`, 0.75);
    }
  }
  // 8a. broadcast — an unaddressed group message is for everyone
  const directed = isDirected(msg.text, lead !== null && addressTerms.length > 0);
  if (!directed || isBroadcast(msg.text)) {
    return done(others, "broadcast", "unaddressed group message → receiver = whole audience", 0.8);
  }
  // 6. model
  if (ctx.model) {
    const cands = (ctx.model(msg, ctx) ?? [])
      .filter((c) => audience.includes(c.id) && c.id !== msg.sender)
      .sort((a, b) => b.confidence - a.confidence);
    const top = cands[0];
    if (top && top.confidence >= MODEL_FLOOR && (!cands[1] || cands[1].confidence < MODEL_FLOOR)) {
      return done([top.id], "model", `model: ${top.reason ?? "inferred receiver"}`, Math.min(top.confidence, 0.89));
    }
  }
  // 8b. unknown beats wrong
  const hint = others.map((id) => rosterById.get(id)?.name ?? id).join(" | ");
  return {
    ...base,
    receiver: [],
    status: "unknown",
    rung: "unknown",
    basis: lead ? `"${lead}" is generic — zero addressee evidence; no structural, roster or context signal` : "directed message with no addressee signal",
    confidence: 0,
    question: `Who was "${msg.text.slice(0, 60)}" addressed to? (${hint})`,
  };
}

// ---- pronouns --------------------------------------------------------------

const PRONOUNS: Record<string, "she" | "he" | "they"> = {
  she: "she",
  her: "she",
  hers: "she",
  he: "he",
  him: "he",
  his: "he",
  they: "they",
  them: "they",
};

export interface PronounResolution {
  pronoun: string;
  subject: string | null;
  status: "resolved" | "unknown";
  confidence: number;
  basis: string;
  /** Candidate ids when unknown. */
  hint: string[];
  question?: string;
}

/**
 * Antecedent search: people NAMED in the prior messages (most recent first),
 * then other recent speakers. Exactly one candidate resolves; two or more is
 * unknown plus a hint — a coin flip is the failure this exists to prevent.
 * A roster pronoun hint, when present, filters candidates; it is never
 * inferred from a name.
 */
export function resolvePronoun(
  msg: RoleMessage,
  ctx: ResolveContext,
  extraPeople: readonly RosterPerson[] = [],
): PronounResolution | null {
  // "he's", "she'll", "they're" carry the pronoun — split contractions too.
  const tokens = norm(msg.text).split(/[\s']+/);
  const pronoun = tokens.find((t) => t in PRONOUNS);
  if (!pronoun) return null;
  const gender = PRONOUNS[pronoun]!;
  const roster = [...ctx.roster, ...extraPeople];
  const byId = new Map(roster.map((p) => [p.id, p]));
  const selfId = ctx.selfId ?? "self";
  const fits = (id: string): boolean => {
    const p = byId.get(id);
    if (!p?.pronoun || gender === "they") return true;
    return p.pronoun === gender;
  };
  const prior = [...(ctx.prior ?? [])].reverse();

  // Candidates named in prior messages (excluding speakers of those messages).
  const mentioned: string[] = [];
  for (const p of prior) {
    for (const id of namesInText(p.text, roster)) {
      if (id !== p.sender && id !== msg.sender && id !== selfId && !mentioned.includes(id) && fits(id)) mentioned.push(id);
    }
  }
  // Also names in the message itself before the pronoun ("Isha ka … she").
  for (const id of namesInText(msg.text, roster)) {
    if (id !== msg.sender && !mentioned.includes(id) && fits(id)) mentioned.unshift(id);
  }
  let candidates = mentioned;
  let basis = "antecedent: named in the preceding messages";
  if (candidates.length === 0) {
    candidates = [];
    for (const p of prior) {
      if (p.sender !== msg.sender && p.sender !== selfId && !candidates.includes(p.sender) && fits(p.sender)) candidates.push(p.sender);
    }
    basis = "antecedent: recent speakers";
  }
  if (candidates.length === 1) {
    return { pronoun, subject: candidates[0]!, status: "resolved", confidence: mentioned.length === 1 ? 0.85 : 0.7, basis, hint: candidates };
  }
  const names = candidates.map((id) => byId.get(id)?.name ?? id);
  return {
    pronoun,
    subject: null,
    status: "unknown",
    confidence: 0,
    basis: candidates.length === 0 ? "no antecedent in the episode" : `${candidates.length} candidates — unknown beats wrong`,
    hint: candidates,
    question: candidates.length > 0 ? `Who is "${pronoun}" in "${msg.text.slice(0, 50)}"? (${names.join(" | ")})` : `Who is "${pronoun}" in "${msg.text.slice(0, 50)}"?`,
  };
}

// ---- persistence -----------------------------------------------------------

export interface ResolutionRow {
  id: string;
  eventId: string;
  streamKey: string | null;
  sender: string | null;
  receiver: string[];
  thirdParties: string[];
  status: "resolved" | "unknown" | "revised";
  rung: string;
  basis: string | null;
  confidence: number;
  questionId: string | null;
  revisedFrom: string | null;
  evidence: { event_ids: string[]; quote: string }[];
  decidedBy: string | null;
  createdAt: string;
}

function hydrate(r: Record<string, unknown>): ResolutionRow {
  const arr = (v: unknown): string[] => {
    if (typeof v !== "string") return [];
    try {
      const p: unknown = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  };
  let evidence: ResolutionRow["evidence"] = [];
  if (typeof r.evidence_json === "string") {
    try {
      const p: unknown = JSON.parse(r.evidence_json);
      if (Array.isArray(p)) evidence = p as ResolutionRow["evidence"];
    } catch {
      /* tolerated */
    }
  }
  return {
    id: String(r.id),
    eventId: String(r.event_id),
    streamKey: (r.stream_key as string | null) ?? null,
    sender: (r.sender as string | null) ?? null,
    receiver: arr(r.receiver_json),
    thirdParties: arr(r.third_party_json),
    status: r.status as ResolutionRow["status"],
    rung: String(r.rung),
    basis: (r.basis as string | null) ?? null,
    confidence: Number(r.confidence),
    questionId: (r.question_id as string | null) ?? null,
    revisedFrom: (r.revised_from as string | null) ?? null,
    evidence,
    decidedBy: (r.decided_by as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export interface RecordParams {
  resolution: RoleResolution;
  streamKey?: string | null;
  eventId?: string;
  evidence?: { event_ids: string[]; quote: string }[];
  decidedBy?: string;
}

/**
 * Persist a verdict. An `unknown` opens a questions row (kind 'roles') so the
 * People / review surfaces can ask; the row links to it.
 */
export function recordResolution(p: RecordParams): ResolutionRow {
  const db = getDb();
  const r = p.resolution;
  const id = `rol_${randomBytes(9).toString("hex")}`;
  let questionId: string | null = null;
  if (r.status === "unknown" && r.question) {
    questionId = `qst_${randomBytes(9).toString("hex")}`;
    db.prepare(
      `INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES (?, 'roles', 'event', ?, ?, ?, 'open')`,
    ).run(questionId, p.eventId ?? r.messageId, r.question, JSON.stringify(r.audience.filter((a) => a !== r.sender)));
  }
  db.prepare(
    `INSERT INTO role_resolutions (id, event_id, stream_key, sender, receiver_json, third_party_json, status, rung, basis,
                                   confidence, question_id, evidence_json, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    p.eventId ?? r.messageId,
    p.streamKey ?? null,
    r.sender,
    JSON.stringify(r.receiver),
    JSON.stringify(r.thirdParties),
    r.status,
    r.rung,
    r.basis,
    r.confidence,
    questionId,
    JSON.stringify(p.evidence ?? []),
    p.decidedBy ?? `code:roles:${r.rung}`,
  );
  return readResolution(id)!;
}

export function readResolution(id: string): ResolutionRow | null {
  const row = getDb().prepare(`SELECT * FROM role_resolutions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : null;
}

/** The current (latest, non-revised) verdict for an event. */
export function currentResolution(eventId: string): ResolutionRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM role_resolutions WHERE event_id = ? AND status <> 'revised' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(eventId) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : null;
}

export function resolutionHistory(eventId: string): ResolutionRow[] {
  // ORDER BY rowid, not id: two rows written in the same millisecond share a
  // created_at, and a random hex id would then decide which verdict came
  // first. Insertion order is the only honest tiebreak for a history.
  return (getDb().prepare(`SELECT * FROM role_resolutions WHERE event_id = ? ORDER BY created_at, rowid`).all(eventId) as Record<string, unknown>[]).map(hydrate);
}

export interface ReviseParams {
  /** The row being confirmed or corrected. */
  resolutionId: string;
  receiver: string[];
  confidence: number;
  basis: string;
  evidence: { event_ids: string[]; quote: string }[];
  decidedBy?: string;
}

/**
 * ROL-10: later evidence confirms (or corrects) an earlier verdict. The old
 * row is marked `revised` and KEPT; a new row carries the upgraded confidence
 * with the appended evidence and points back via `revised_from`. An open
 * question on the old row is answered.
 */
export function reviseResolution(p: ReviseParams): ResolutionRow {
  const db = getDb();
  const old = readResolution(p.resolutionId);
  if (!old) throw new Error(`reviseResolution: no resolution ${p.resolutionId}`);
  const id = `rol_${randomBytes(9).toString("hex")}`;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE role_resolutions SET status = 'revised' WHERE id = ?`).run(old.id);
    if (old.questionId) {
      db.prepare(
        `UPDATE questions SET status = 'answered', answer_json = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'open'`,
      ).run(JSON.stringify({ receiver: p.receiver, by: p.decidedBy ?? "code:roles:revision" }), old.questionId);
    }
    db.prepare(
      `INSERT INTO role_resolutions (id, event_id, stream_key, sender, receiver_json, third_party_json, status, rung, basis,
                                     confidence, question_id, revised_from, evidence_json, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      id,
      old.eventId,
      old.streamKey,
      old.sender,
      JSON.stringify(p.receiver),
      JSON.stringify(old.thirdParties),
      old.rung === "unknown" ? "context" : old.rung,
      `${p.basis} (revises ${old.id}: was ${old.receiver.join(",") || "unknown"} @ ${old.confidence})`,
      p.confidence,
      old.id,
      JSON.stringify([...old.evidence, ...p.evidence]),
      p.decidedBy ?? "code:roles:revision",
    );
  });
  tx();
  return readResolution(id)!;
}

/**
 * ROL-01's closure half. A question the ladder placed on ONE person, answered
 * by that person with a completion marker, is two-sided evidence: the asker
 * asked and the owner answered. Code, not the model — the whole judgement is
 * "did the addressee answer, and does the answer say done".
 */
export function answersWithCompletion(
  question: { resolution: RoleResolution },
  answer: RoleMessage,
): { closes: boolean; why: string } {
  const asked = question.resolution;
  if (asked.status !== "resolved" || asked.receiver.length !== 1) {
    return { closes: false, why: "the question was not placed on exactly one person" };
  }
  if (answer.sender !== asked.receiver[0]) return { closes: false, why: "the answer is not from the person asked" };
  if (!COMPLETION_MARKER.test(answer.text)) return { closes: false, why: "no completion marker in the answer" };
  return { closes: true, why: `${answer.sender} answered the question addressed to them with a completion marker` };
}

/**
 * ROL-05: an ambiguous pronoun is a QUESTION, never a coin flip. The row is
 * the same `questions` table every other open loop uses, kind `pronoun`, with
 * the candidates as options so the People / review surfaces can offer them.
 */
export function recordPronounQuestion(eventId: string, r: PronounResolution): string | null {
  if (r.status !== "unknown" || !r.question) return null;
  const id = `qst_${randomBytes(9).toString("hex")}`;
  getDb()
    .prepare(
      `INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES (?, 'pronoun', 'event', ?, ?, ?, 'open')`,
    )
    .run(id, eventId, r.question, JSON.stringify(r.hint));
  return id;
}

/**
 * Does a later message CONFIRM an earlier low-confidence receiver? Code
 * rule: the inferred receiver themself reports the thing done ("court booked
 * ✅") — two-sided evidence. Returns the confidence the revision should carry.
 */
export function confirmsReceiver(earlier: { receiver: string[]; subjectKeywords: string[] }, later: RoleMessage): { confirms: boolean; why: string } {
  if (earlier.receiver.length !== 1) return { confirms: false, why: "earlier verdict was not a single receiver" };
  if (later.sender !== earlier.receiver[0]) return { confirms: false, why: "later message is not from the inferred receiver" };
  const lower = norm(later.text);
  const onSubject = earlier.subjectKeywords.some((k) => lower.includes(norm(k)));
  if (!onSubject) return { confirms: false, why: "later message is off-subject" };
  const doneMarker = COMPLETION_MARKER.test(later.text);
  return doneMarker
    ? { confirms: true, why: `${later.sender} reports the item done on the same subject — two-sided evidence` }
    : { confirms: false, why: "no completion marker" };
}

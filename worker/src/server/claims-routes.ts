// ===========================================================================
// [CODE] Claims surface routes — arch §14.5, build item 3.10.
//
// Two reads and five writes, all thin: the version set comes out of
// `claims/store.ts`, which version of a key is live comes out of
// `claims/supersede.ts`, and every gesture leaves a `mutations(actor:user)`
// row the surface renders as a receipt (§6).
//
//   GET  /api/claims                 the grouped page: counts, groups, subjects
//   GET  /api/claims/conflicts       the unresolved pairs, oldest first
//   POST /api/claims/conflicts/:id   { answer } — accept | both_true | neither
//   POST /api/claims/:id/pin         { pinned }
//   POST /api/claims/:id/reject      { reason }   — TEACHES, never deletes
//   POST /api/claims/:id/correct     { text }
//   POST /api/claims/:id/split       { texts }
//
// THREE THINGS THIS MODULE REFUSES TO DO.
//
//   IT NEVER DECIDES WHAT IS ACTIVE.  `activeVersion()` from supersede.ts
//   answers that, which is the same algebra the `claims_active` VIEW is
//   written in (migration 0020), so the surface and the database can never
//   disagree about which version of a key is the live one.
//
//   IT NEVER DELETES.  reject / correct / split all CLOSE a window
//   (`closed_by` + `closed_reason` + `valid_to`) and, where the human offered
//   words of their own, insert a NEW version alongside. Every row every
//   gesture ever touched stays in `claim_versions` and stays readable as
//   `superseded` (§11.6 rule 3).
//
//   IT NEVER SUMMARISES THE ADJUDICATOR.  A conflict ships the question's own
//   sentence verbatim (build rule 9) — no truncation happens on this side of
//   the wire either.
//
// An empty database is an ordinary answer, not an error: every read below
// composes its page out of whatever rows exist, so a fresh install renders
// `{ counts: {}, conflictCount: 0, groups: [], subjects: [] }` rather than a
// 500 the surface has to spell as "broken".
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { claimKey, claimVersionId } from "../claims/keys.js";
import {
  activeClaims,
  readClaimVersion,
  versionsOfKey,
  type ClaimVersionRow,
} from "../claims/store.js";
import { planSupersession } from "../claims/supersede.js";
import { getDb } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";
import { getEntity } from "../entities/registry.js";
import { answerQuestion } from "./ops-routes.js";

// ---------------------------------------------------------------------------
// Vocabulary — the closed sets, mirrored from src/lib/claims-client.ts (§5.3)
// ---------------------------------------------------------------------------

/** The kind IS the wire tag (§5.3). Eight, and there is no ninth. */
export const CLAIM_KINDS = [
  "fact",
  "preference",
  "belief",
  "interest",
  "opinion",
  "recommendation",
  "habit",
  "workflow",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_ATTRIBUTIONS = [
  "first_person",
  "about_other",
  "reported_speech",
  "quoted_third_party",
] as const;
export type ClaimAttribution = (typeof CLAIM_ATTRIBUTIONS)[number];

export const CLAIM_STATUSES = ["active", "superseded"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CONFLICT_ANSWERS = ["accept", "both_true", "neither"] as const;
export type ConflictAnswer = (typeof CONFLICT_ANSWERS)[number];

/** The one actor a surface gesture may ever write under (§6). */
export const USER_ACTOR = "user";

/** `askUser()` in claims/write.ts files every unresolved pair under this kind. */
const CONFLICT_QUESTION_KIND = "claim_relation";

function isClaimKind(v: unknown): v is ClaimKind {
  return typeof v === "string" && (CLAIM_KINDS as readonly string[]).includes(v);
}

function isClaimAttribution(v: unknown): v is ClaimAttribution {
  return typeof v === "string" && (CLAIM_ATTRIBUTIONS as readonly string[]).includes(v);
}

function isClaimStatus(v: unknown): v is ClaimStatus {
  return typeof v === "string" && (CLAIM_STATUSES as readonly string[]).includes(v);
}

function isConflictAnswer(v: unknown): v is ConflictAnswer {
  return typeof v === "string" && (CONFLICT_ANSWERS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// The view shapes — the contract src/lib/claims-client.ts compiles against
// ---------------------------------------------------------------------------

export interface ClaimEvidenceView {
  eventId: string;
  quote: string;
  episodeId: string | null;
  at: string | null;
}

export interface ClaimVersionView {
  id: string;
  /** 1-based, oldest first. The worker numbers it; the surface never counts. */
  version: number;
  text: string;
  status: ClaimStatus;
  statedAt: string;
  reason: string | null;
  decidedBy: string | null;
  confidence: number | null;
}

export interface ClaimView {
  id: string;
  claimKey: string;
  kind: ClaimKind;
  text: string;
  subjectId: string | null;
  subjectLabel: string;
  subjectIsHint: boolean;
  status: ClaimStatus;
  confidence: number | null;
  attribution: ClaimAttribution | null;
  decidedBy: string | null;
  statedAt: string;
  validFrom: string | null;
  validTo: string | null;
  pinned: boolean;
  provisional: boolean;
  evidence: ClaimEvidenceView[];
  versions: ClaimVersionView[];
}

export interface ClaimGroupView {
  subjectId: string | null;
  subjectLabel: string;
  claims: ClaimView[];
}

export interface ClaimConflictView {
  id: string;
  subjectLabel: string;
  incoming: ClaimView;
  stored: ClaimView;
  verdict: string | null;
  confidence: number | null;
  reasoning: string;
  raisedAt: string | null;
}

export interface ClaimsPage {
  counts: Partial<Record<ClaimKind, number>>;
  conflictCount: number;
  groups: ClaimGroupView[];
  subjects: { id: string | null; label: string }[];
}

export interface ClaimQuery {
  kind?: ClaimKind | null;
  subjectId?: string | null;
  attribution?: ClaimAttribution | null;
  status?: ClaimStatus | null;
  minConfidence?: number | null;
  q?: string;
}

/** What `POST`ing a gesture hands back: the `mutations` row it wrote. */
export interface MutationReceipt {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field?: string | null;
}

// ---------------------------------------------------------------------------
// http helpers — file-local, as every sub-router's are
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The `claim_key` list.
 *
 * store.ts reads one key at a time (`versionsOfKey`) because the write path
 * only ever holds one; the surface needs the whole set, and asking for the
 * distinct keys is the smallest query that gets there. Everything downstream
 * of this line is store.ts and supersede.ts — no second copy of the column
 * list, no second definition of "active".
 */
function allClaimKeys(): string[] {
  return (
    getDb()
      .prepare(`SELECT DISTINCT claim_key AS k FROM claim_versions ORDER BY claim_key`)
      .all() as { k: string }[]
  ).map((r) => r.k);
}

/**
 * Evidence with its quote and its click-through.
 *
 * `evidenceOf()` in store.ts returns event ids only, which the write path is
 * content with; §14.5 requires the VERBATIM quote and the episode to land on,
 * so the join lives here rather than being re-derived id-by-id.
 */
function evidenceFor(claimId: string): ClaimEvidenceView[] {
  const rows = getDb()
    .prepare(
      `SELECT ev.event_id AS event_id, ev.quote AS quote, ev.episode_id AS episode_id, e.ts AS ts
         FROM evidence ev
         LEFT JOIN events e ON e.id = ev.event_id
        WHERE ev.subject_kind = 'claim' AND ev.subject_id = ?
        ORDER BY ev.event_id`,
    )
    .all(claimId) as { event_id: string; quote: string; episode_id: string | null; ts: string | null }[];
  return rows.map((r) => ({
    eventId: r.event_id,
    quote: r.quote,
    episodeId: r.episode_id,
    at: r.ts,
  }));
}

/**
 * Which claims a human has pinned.
 *
 * `claim_versions` has no `pinned` column and deliberately gets none: a pin is
 * a human's act, and every human act already lives in `mutations` with
 * `actor = 'user'`. Reading the ledger keeps the pin undoable-by-inspection
 * and keeps the derived tables free of a flag re-derivation would erase.
 * Last write wins, which is what a toggle means.
 */
function pinnedClaimIds(): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT target_id, new_json FROM mutations
        WHERE target_kind = 'claim_version' AND field = 'pin'
        ORDER BY ts, rowid`,
    )
    .all() as { target_id: string; new_json: string | null }[];
  const pinned = new Set<string>();
  for (const row of rows) {
    let on = false;
    try {
      const parsed = row.new_json === null ? null : (JSON.parse(row.new_json) as { pinned?: unknown });
      on = parsed?.pinned === true;
    } catch {
      on = false;
    }
    if (on) pinned.add(row.target_id);
    else pinned.delete(row.target_id);
  }
  return pinned;
}

/**
 * Claims standing on a session that is still being written (§14.0b).
 *
 * The same "open is the whole filter" the live trigger uses
 * (`liveCandidates` in scheduler/live.ts): a claim whose evidence sits inside
 * an unsealed session may still change, so it is MARKED — never withheld.
 */
function provisionalClaimIds(): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT ev.subject_id AS id
         FROM evidence ev
         JOIN sessions s ON s.status = 'open'
         JOIN json_each(COALESCE(s.event_ids, '[]')) je ON je.value = ev.event_id
        WHERE ev.subject_kind = 'claim'`,
    )
    .all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** The subject as the surface prints it. A name string is never an id (§4.2). */
function subjectOf(row: ClaimVersionRow): { label: string; isHint: boolean } {
  if (row.subjectId !== null) {
    const entity = getEntity(row.subjectId);
    if (entity?.canonical) return { label: entity.canonical, isHint: false };
  }
  const hint = (row.subjectHint ?? "").trim();
  return { label: hint === "" ? "unattributed" : hint, isHint: true };
}

/** The HISTORY panel's rungs: every version of the key, oldest first. */
function versionViews(versions: readonly ClaimVersionRow[], activeId: string | null): ClaimVersionView[] {
  // `versionsOfKey` hands them back latest-said first; §14.5 numbers them the
  // way they happened, so the panel reads as a chain and not as a stack.
  const oldestFirst = [...versions].reverse();
  return oldestFirst.map((v, index) => ({
    id: v.id,
    version: index + 1,
    text: v.text ?? "",
    status: v.id === activeId ? "active" : "superseded",
    statedAt: v.statedAt,
    // The stated reason, verbatim. The first rung has none to state, and
    // saying so beats a blank where a reason should be.
    reason: v.closedReason ?? (index === 0 ? "original" : null),
    decidedBy: v.decidedBy,
    confidence: v.confidence,
  }));
}

interface ViewContext {
  pinned: ReadonlySet<string>;
  provisional: ReadonlySet<string>;
  /**
   * Every live version id, read off `claims_active` — the VIEW, which is the
   * database's own answer to "which version of this key is current". The
   * surface asks it once per request instead of re-deriving precedence in JS,
   * so a row can never render as active on the page and superseded in a query.
   */
  active: ReadonlySet<string>;
}

function viewContext(): ViewContext {
  return {
    pinned: pinnedClaimIds(),
    provisional: provisionalClaimIds(),
    active: new Set(activeClaims().map((r) => r.id)),
  };
}

/** The live version of a key, or null when every version's window has closed. */
function activeIdOf(versions: readonly ClaimVersionRow[], ctx: ViewContext): string | null {
  return versions.find((v) => ctx.active.has(v.id))?.id ?? null;
}

function toView(
  row: ClaimVersionRow,
  versions: readonly ClaimVersionRow[],
  activeId: string | null,
  ctx: ViewContext,
): ClaimView | null {
  // The kind IS the wire tag and the wire enum is closed (§5.3), so a row
  // outside the eight is a write-path bug. The surface declines to guess which
  // of the eight it meant rather than filing it under a kind nobody chose.
  if (!isClaimKind(row.kind)) return null;
  const subject = subjectOf(row);
  return {
    id: row.id,
    claimKey: row.claimKey,
    kind: row.kind,
    text: row.text ?? "",
    subjectId: row.subjectId,
    subjectLabel: subject.label,
    subjectIsHint: subject.isHint,
    status: row.id === activeId ? "active" : "superseded",
    confidence: row.confidence,
    attribution: isClaimAttribution(row.attribution) ? row.attribution : null,
    decidedBy: row.decidedBy,
    statedAt: row.statedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    pinned: ctx.pinned.has(row.id),
    provisional: ctx.provisional.has(row.id),
    evidence: evidenceFor(row.id),
    versions: versionViews(versions, activeId),
  };
}

/** The number the ⚠ chip shows. Never filtered — see the note in ClaimsTab. */
export function conflictCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM questions WHERE kind = ? AND status = 'open'`)
    .get(CONFLICT_QUESTION_KIND) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * The Claims page.
 *
 * `status` chooses the CORPUS — absent means active and superseded together,
 * which is what the surface's empty status option says. Every other filter
 * narrows the page within that corpus, which is why `counts` is computed
 * before them: the chips report the corpus, not the page.
 */
export function claimsPage(query: ClaimQuery): ClaimsPage {
  const ctx = viewContext();

  const scope: ClaimView[] = [];
  for (const key of allClaimKeys()) {
    const versions = versionsOfKey(key);
    if (versions.length === 0) continue;
    const activeId = activeIdOf(versions, ctx);
    const wanted =
      query.status === "active"
        ? versions.filter((v) => v.id === activeId)
        : query.status === "superseded"
          ? versions.filter((v) => v.id !== activeId)
          : versions;
    for (const row of wanted) {
      const view = toView(row, versions, activeId, ctx);
      if (view) scope.push(view);
    }
  }
  scope.sort((a, b) => (a.statedAt === b.statedAt ? (a.id < b.id ? 1 : -1) : a.statedAt < b.statedAt ? 1 : -1));

  const counts: Partial<Record<ClaimKind, number>> = {};
  for (const claim of scope) counts[claim.kind] = (counts[claim.kind] ?? 0) + 1;

  // Only a resolved subject is offered as an option: the dropdown filters by
  // entity id, and a hint has none. Hint-subject claims still group and render.
  const subjects = new Map<string, string>();
  for (const claim of scope) {
    if (claim.subjectId !== null && !claim.subjectIsHint) subjects.set(claim.subjectId, claim.subjectLabel);
  }

  const needle = (query.q ?? "").trim().toLowerCase();
  const floor = typeof query.minConfidence === "number" && Number.isFinite(query.minConfidence)
    ? query.minConfidence
    : 0;
  const page = scope.filter((claim) => {
    if (query.kind && claim.kind !== query.kind) return false;
    if (query.subjectId && claim.subjectId !== query.subjectId) return false;
    if (query.attribution && claim.attribution !== query.attribution) return false;
    if (floor > 0 && (claim.confidence ?? 0) < floor) return false;
    if (needle !== "") {
      const haystack = `${claim.text} ${claim.subjectLabel}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  // §14.5 groups by subject entity, and the WORKER owns the grouping.
  const groups = new Map<string, ClaimGroupView>();
  for (const claim of page) {
    const key = claim.subjectId ?? `hint:${claim.subjectLabel}`;
    let group = groups.get(key);
    if (!group) {
      group = { subjectId: claim.subjectId, subjectLabel: claim.subjectLabel, claims: [] };
      groups.set(key, group);
    }
    group.claims.push(claim);
  }

  return {
    counts,
    conflictCount: conflictCount(),
    groups: [...groups.values()],
    subjects: [...subjects.entries()]
      .map(([id, label]) => ({ id: id as string | null, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

interface ConflictRow {
  id: string;
  target_id: string | null;
  question: string;
  options_json: string | null;
  asked_at: string | null;
}

function conflictRows(): ConflictRow[] {
  return getDb()
    .prepare(
      `SELECT id, target_id, question, options_json, asked_at FROM questions
        WHERE kind = ? AND status = 'open' ORDER BY asked_at, id`,
    )
    .all(CONFLICT_QUESTION_KIND) as ConflictRow[];
}

/** `askUser()` stores `[incomingId, storedId]`; anything else is unreadable. */
function conflictPair(row: ConflictRow): { incoming: string; stored: string } | null {
  try {
    const parsed: unknown = row.options_json ? JSON.parse(row.options_json) : [];
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    return { incoming: String(parsed[0]), stored: String(parsed[1]) };
  } catch {
    return null;
  }
}

function claimViewById(id: string, ctx: ViewContext): ClaimView | null {
  const row = readClaimVersion(id);
  if (!row) return null;
  const versions = versionsOfKey(row.claimKey);
  return toView(row, versions, activeIdOf(versions, ctx), ctx);
}

/**
 * The conflict queue.
 *
 * A pair only reaches it on an `unsure` verdict (§11.6, evals R-020), so the
 * verdict is stated rather than re-derived, and the adjudicator's own sentence
 * is the question text — carried through untouched. P-AG3's confidence is not
 * persisted on the question row, and `null` says so instead of inventing one.
 *
 * A pair whose claims are gone (a run was undone under it) is skipped, not
 * rendered half-empty: the question row survives its subject, the view cannot.
 */
export function listConflicts(): ClaimConflictView[] {
  const ctx = viewContext();
  const out: ClaimConflictView[] = [];
  for (const row of conflictRows()) {
    const pair = conflictPair(row);
    if (!pair) continue;
    const incoming = claimViewById(pair.incoming, ctx);
    const stored = claimViewById(pair.stored, ctx);
    if (!incoming || !stored) continue;
    out.push({
      id: row.id,
      subjectLabel: incoming.subjectLabel,
      incoming,
      stored,
      verdict: "unsure",
      confidence: null,
      reasoning: row.question,
      raisedAt: row.asked_at,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes — every one of them leaves a `mutations(actor:user)` row
// ---------------------------------------------------------------------------

function receiptFor(mutationId: string, targetKind: string, targetId: string, field: string): MutationReceipt {
  return { mutationId, actor: USER_ACTOR, targetKind, targetId, field };
}

/**
 * End one version's window.
 *
 * `write.ts` applies the identical three-column UPDATE but keeps its
 * `closeVersion` private to the write path, so the gesture path spells it once
 * here. The three columns are exactly `undo.ts`'s `UNDOABLE_COLUMNS`, which is
 * what keeps a close written by a human the same shape as one written by a run
 * — and nothing here deletes a row (§11.6 rule 3).
 */
function closeVersion(id: string, closedBy: string, reason: string, validTo: string): void {
  getDb()
    .prepare(`UPDATE claim_versions SET closed_by = ?, closed_reason = ?, valid_to = ? WHERE id = ?`)
    .run(closedBy, reason, validTo, id);
}

/**
 * The human's own words, as a claim.
 *
 * `writeClaim()` cannot be used for this: its exact-key branch REINFORCES,
 * folding the new text into the stored row, which is precisely wrong for a
 * correction — the user's sentence has to land as a NEW version so the chain
 * shows what was said before and what is said now. `stated_at` is now because
 * the user is saying it now, which is also what makes their version the live
 * one under §11.6 rule 5 without anybody special-casing the actor.
 *
 * Evidence is copied across: the quotes did not stop existing because the
 * reading of them changed, and a claim with no evidence is a claim no reader
 * can check (§6).
 */
function insertUserVersion(base: ClaimVersionRow, key: string, text: string, statedAt: string): string {
  const db = getDb();
  const id = claimVersionId(key, statedAt, text);
  db.prepare(
    `INSERT OR IGNORE INTO claim_versions
       (id, claim_key, kind, subject_id, subject_hint, predicate, object, text,
        speaker_id, addressee_id, attribution, party_pair, confidence, stated_at,
        ingested_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
  ).run(
    id,
    key,
    base.kind,
    base.subjectId,
    base.subjectHint,
    text,
    base.object,
    text,
    base.speakerId,
    base.addresseeId,
    base.attribution,
    base.partyPair,
    1,
    statedAt,
    statedAt,
  );
  db.prepare(
    `INSERT OR IGNORE INTO evidence (subject_kind, subject_id, event_id, episode_id, quote)
     SELECT 'claim', ?, event_id, episode_id, quote
       FROM evidence WHERE subject_kind = 'claim' AND subject_id = ?`,
  ).run(id, base.id);
  return id;
}

/** A pin is a ledger entry and nothing else — see `pinnedClaimIds`. */
export function pinClaim(id: string, pinned: boolean): MutationReceipt | null {
  const row = readClaimVersion(id);
  if (!row) return null;
  const mutationId = logMutation({
    actor: USER_ACTOR,
    targetKind: "claim_version",
    targetId: id,
    field: "pin",
    oldValue: { pinned: pinnedClaimIds().has(id) },
    newValue: { pinned },
    reason: pinned ? "pinned on the Claims surface" : "unpinned on the Claims surface",
  });
  return receiptFor(mutationId, "claim_version", id, "pin");
}

/**
 * Rejection TEACHES.
 *
 * The window closes with the human named as the closer and their reason stored
 * verbatim on the ledger row — which is the record re-derivation reads, and
 * which `undoRun` will never reverse because its actor is `user` (R-039). The
 * claim itself stays exactly where it was filed, readable as `superseded`.
 */
export function rejectClaim(id: string, reason: string): MutationReceipt | null {
  const row = readClaimVersion(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const before = { closedBy: row.closedBy, closedReason: row.closedReason, validTo: row.validTo };
  const after = { closedBy: USER_ACTOR, closedReason: "user_rejected", validTo: now };
  const apply = getDb().transaction(() => {
    closeVersion(id, USER_ACTOR, "user_rejected", now);
    return logMutation({
      actor: USER_ACTOR,
      targetKind: "claim_version",
      targetId: id,
      field: "reject",
      oldValue: before,
      newValue: after,
      reason,
    });
  });
  return receiptFor(apply(), "claim_version", id, "reject");
}

/**
 * A correction is a supersession the human performed: the corrected sentence
 * lands as a new version of the SAME key, and the old one is closed by it. The
 * chain in the HISTORY panel is the whole point — v1 stays legible.
 */
export function correctClaim(id: string, text: string): MutationReceipt | null {
  const row = readClaimVersion(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const apply = getDb().transaction(() => {
    const correctedId = insertUserVersion(row, row.claimKey, text, now);
    closeVersion(row.id, correctedId, "user_corrected", now);
    return logMutation({
      actor: USER_ACTOR,
      targetKind: "claim_version",
      targetId: row.id,
      field: "correct",
      oldValue: { id: row.id, text: row.text },
      newValue: { id: correctedId, text },
      reason: "corrected on the Claims surface",
    });
  });
  return receiptFor(apply(), "claim_version", id, "correct");
}

/**
 * A split says "that was two claims". Each half is its own claim — its own key
 * — because they now supersede, reinforce and expire independently; the
 * original is closed by the first half so the chain still leads somewhere.
 */
export function splitClaim(id: string, texts: readonly string[]): MutationReceipt | null {
  const row = readClaimVersion(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const apply = getDb().transaction(() => {
    const ids = texts.map((text) =>
      insertUserVersion(
        row,
        claimKey({
          kind: row.kind ?? "",
          subjectId: row.subjectId,
          subjectHint: row.subjectHint,
          predicate: text,
        }),
        text,
        now,
      ),
    );
    closeVersion(row.id, ids[0]!, "user_split", now);
    return logMutation({
      actor: USER_ACTOR,
      targetKind: "claim_version",
      targetId: row.id,
      field: "split",
      oldValue: { id: row.id, text: row.text },
      newValue: { ids, texts },
      reason: "split on the Claims surface",
    });
  });
  return receiptFor(apply(), "claim_version", id, "split");
}

/**
 * Answer one conflict.
 *
 *   accept    → the pair is a refinement; the EARLIER-SAID claim's window
 *               closes. Which one that is comes from `planSupersession`, never
 *               from which side the queue happened to print first (§11.6 r5).
 *   both_true → distinct. Nothing closes, and the question stops being open.
 *   neither   → both windows close, filed under the human who said so.
 *
 * `answerQuestion` from the ops surface does the `questions` UPDATE: the table
 * has one answering path, and a second spelling of it here is a second thing
 * to keep in step.
 */
export function answerConflict(id: string, answer: ConflictAnswer): MutationReceipt | null {
  const row = conflictRows().find((r) => r.id === id);
  if (!row) return null;
  const pair = conflictPair(row);
  const incoming = pair ? readClaimVersion(pair.incoming) : null;
  const stored = pair ? readClaimVersion(pair.stored) : null;
  if (!incoming || !stored) return null;

  const now = new Date().toISOString();
  const apply = getDb().transaction(() => {
    if (answer === "accept") {
      const plan = planSupersession({ stored, incoming, relation: "refinement" });
      if (plan.close) {
        closeVersion(plan.close.id, plan.close.closedBy, "user_accepted", plan.close.validTo);
      }
    } else if (answer === "neither") {
      closeVersion(incoming.id, USER_ACTOR, "user_rejected", now);
      closeVersion(stored.id, USER_ACTOR, "user_rejected", now);
    }
    // `both_true` closes nothing: two claims the human says are both true are
    // two claims, and §11.6's `dst` is exactly that.
    answerQuestion(id, answer);
    return logMutation({
      actor: USER_ACTOR,
      targetKind: "question",
      targetId: id,
      field: "answer",
      oldValue: { incoming: incoming.id, stored: stored.id },
      newValue: { answer },
      reason: "conflict answered on the Claims surface",
    });
  });
  return receiptFor(apply(), "question", id, "answer");
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** Handle a claims request. Returns true when this module owns the path. */
export async function handleClaimsRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path !== "/api/claims" && !path.startsWith("/api/claims/")) return false;

  // ---- GET /api/claims ----------------------------------------------------
  if (method === "GET" && path === "/api/claims") {
    const kind = url.searchParams.get("kind");
    const attribution = url.searchParams.get("attribution");
    const status = url.searchParams.get("status");
    const minConfidence = Number(url.searchParams.get("minConfidence") ?? "0");
    sendJson(res, 200, claimsPage({
      kind: isClaimKind(kind) ? kind : null,
      subjectId: url.searchParams.get("subject"),
      attribution: isClaimAttribution(attribution) ? attribution : null,
      status: isClaimStatus(status) ? status : null,
      minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0,
      q: url.searchParams.get("q") ?? "",
    }));
    return true;
  }

  // ---- GET /api/claims/conflicts ------------------------------------------
  if (method === "GET" && path === "/api/claims/conflicts") {
    sendJson(res, 200, listConflicts());
    return true;
  }

  // ---- POST /api/claims/conflicts/:id { answer } ---------------------------
  const conflict = path.match(/^\/api\/claims\/conflicts\/([^/]+)$/);
  if (method === "POST" && conflict) {
    const id = decodeURIComponent(conflict[1]!);
    const body = await readJsonBody(req);
    if (!isConflictAnswer(body?.answer)) {
      sendJson(res, 400, { error: `answer must be one of ${CONFLICT_ANSWERS.join(", ")}` });
      return true;
    }
    const receipt = answerConflict(id, body.answer);
    if (!receipt) {
      sendJson(res, 404, { error: "no open conflict with that id" });
      return true;
    }
    sendJson(res, 200, receipt);
    return true;
  }

  // ---- POST /api/claims/:id/<gesture> --------------------------------------
  const gesture = path.match(/^\/api\/claims\/([^/]+)\/(pin|reject|correct|split)$/);
  if (method === "POST" && gesture) {
    const id = decodeURIComponent(gesture[1]!);
    const kind = gesture[2]!;
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }

    let receipt: MutationReceipt | null = null;
    if (kind === "pin") {
      if (typeof body.pinned !== "boolean") {
        sendJson(res, 400, { error: "pinned (boolean) required" });
        return true;
      }
      receipt = pinClaim(id, body.pinned);
    } else if (kind === "reject") {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason === "") {
        sendJson(res, 400, { error: "reason (string) required" });
        return true;
      }
      receipt = rejectClaim(id, reason);
    } else if (kind === "correct") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text === "") {
        sendJson(res, 400, { error: "text (string) required" });
        return true;
      }
      receipt = correctClaim(id, text);
    } else {
      const raw = Array.isArray(body.texts) ? body.texts : null;
      const texts = (raw ?? []).map((t) => String(t).trim()).filter((t) => t !== "");
      // One text is not a split, it is a correction — and saying so beats
      // silently writing a "split" that leaves the graph exactly as it was.
      if (texts.length < 2) {
        sendJson(res, 400, { error: "texts must be an array of two or more non-empty strings" });
        return true;
      }
      receipt = splitClaim(id, texts);
    }

    if (!receipt) {
      sendJson(res, 404, { error: "no claim with that id" });
      return true;
    }
    sendJson(res, 200, receipt);
    return true;
  }

  sendJson(res, 404, { error: "unknown claims route" });
  return true;
}

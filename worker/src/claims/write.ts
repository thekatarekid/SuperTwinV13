// ===========================================================================
// [CODE] The claim write path — arch §11.6, build item 3.3.
//
//     incoming CLAIM
//       ├── exact claim_key hit ──► REINFORCE (union evidence, max confidence)
//       ├── near hit ────────────► P-AG3 → dup|rfn|ctr|dst|un      [LLM-M]
//       └── else ────────────────► INSERT
//
// FIVE INVARIANTS, ALL TESTED
//
//   NOTHING IS DELETED.  Every version of a `claim_key` stays in
//        `claim_versions` with its window (§11.6 rule 3). A supersession is a
//        `closed_by` + `valid_to` on the EARLIER-SAID row, never an UPDATE
//        over its text and never a DELETE.
//
//   `claims_active` IS A VIEW, NOT A TABLE.  Migration 0020 owns it. Nothing
//        here writes an "is_active" flag, because there is none: active-ness
//        is recomputed from the version set on every read, which is what lets
//        a late-arriving older claim change nothing at all.
//
//   PRECEDENCE IS `stated_at`, ONLY.  This file never reads `ingested_at` and
//        never asks which row was written first. `supersede.ts` decides, from
//        the two `stated_at` values, and the incoming claim loses whenever it
//        was SAID earlier — landing as a predecessor with a closed window
//        (evals R-021..027).
//
//   NO MIN_EVIDENCE CONSTANT.  A habit seen a fifth time is the same
//        reinforcement as a fact seen a second time: union the evidence, take
//        the max confidence, add no row. Graduation is the evidence count a
//        reader can see, not a threshold code applies (R-006..009).
//
//   ZERO MODEL OUTPUT DISCARDED.  A P-AG3 answer is parsed into buckets that
//        sum to what the parser saw (`ag3Accounts`), the verdict is stored on
//        the row it decided (`decided_by`, `closed_reason`) and the model's
//        own line rides on the `mutations` row. An answer this call may not
//        emit is COUNTED and returned, never dropped (R-040).
//
// Every write emits a `mutations` row carrying the run id, so `undoRun` is a
// reverse replay and a user's own edits — `actor = 'user'` — are never touched
// by it (R-036..039).
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";
import { buildAg3Prompt, parseAg3Response, type Ag3Answer, type Ag3Input } from "../prompts/p-ag3.js";
import { USE_CASE_BARS } from "../retrieval/calibration.js";
import { claimKey, claimVersionId } from "./keys.js";
import {
  nearHitCandidates,
  readClaimVersion,
  versionsOfKey,
  type ClaimVersionRow,
} from "./store.js";
import {
  activeVersion,
  planSupersession,
  plainInsertPlan,
  type SupersessionPlan,
} from "./supersede.js";
import type {
  ClaimEvidenceInput,
  ClaimWriteInput,
  NearCandidate,
  WriteOptions,
} from "./types.js";

// The write path is the one import site callers need: the row reader, the
// vocabulary and the reverse replay are separate FILES (rule 3, none over ~600
// lines), not separate modules to hunt for.
export * from "./types.js";
export * from "./store.js";
export * from "./undo.js";

/** The actor every automatic write is filed under. `user` is never automatic. */
export const WRITE_ACTOR = "code:claim_write";

/**
 * The floor a stored claim has to clear to be worth a P-AG3 call: the MEASURED
 * `claim_text` band from §7, not a number invented here. Below it the two
 * claims are not near each other and an adjudication would be spend with no
 * question attached (evals R-010..015 pose 0.88–0.98, all far above it).
 */
export const CLAIM_NEAR_HIT_MIN = USE_CASE_BARS.claim_text.band;

// ---- the result ------------------------------------------------------------

export type WriteRoute = "reinforce" | "adjudicated" | "insert";

export interface ClaimWriteResult {
  route: WriteRoute;
  claimKey: string;
  /** The row this write landed on — the new version, or the reinforced one. */
  claimId: string;
  created: boolean;
  reinforced: boolean;
  /** The version whose window this write closed, if any. */
  closedId: string | null;
  questionId: string | null;
  plan: SupersessionPlan | null;
  /** The whole P-AG3 answer, buckets and violations included. Never trimmed. */
  adjudication: Ag3Answer | null;
  /** A near hit was found but no adjudicator was wired: insert and say so. */
  adjudicationDeferred: boolean;
  /** Evidence event ids newly attached by this write. */
  evidenceAdded: string[];
  /** Cited events that are not in `events` — reported, never invented. */
  evidenceMissing: string[];
  mutationIds: string[];
}

function nowIso(options: WriteOptions): string {
  return options.now ?? new Date().toISOString();
}

function maxConfidence(a: number | null | undefined, b: number | null | undefined): number | null {
  const left = typeof a === "number" && Number.isFinite(a) ? a : null;
  const right = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

// ---- evidence --------------------------------------------------------------

function attachEvidence(
  claimId: string,
  evidence: readonly ClaimEvidenceInput[],
  options: WriteOptions,
  mutationIds: string[],
): { added: string[]; missing: string[] } {
  const db = getDb();
  const known = db.prepare(`SELECT 1 AS ok FROM events WHERE id = ?`);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO evidence (subject_kind, subject_id, event_id, episode_id, quote)
     VALUES ('claim', ?, ?, ?, ?)`,
  );
  const added: string[] = [];
  const missing: string[] = [];
  for (const item of evidence) {
    const eventId = String(item?.eventId ?? "");
    if (eventId === "") continue;
    if (!known.get(eventId)) {
      missing.push(eventId);
      continue;
    }
    const result = insert.run(claimId, eventId, item.episodeId ?? null, String(item.quote ?? ""));
    if (result.changes > 0) {
      added.push(eventId);
      mutationIds.push(
        logMutation({
          actor: options.actor ?? WRITE_ACTOR,
          runId: options.runId ?? null,
          targetKind: "evidence",
          targetId: `claim|${claimId}|${eventId}`,
          field: "insert",
          newValue: { subjectKind: "claim", subjectId: claimId, eventId, quote: item.quote },
          reason: "evidence",
        }),
      );
    }
  }
  return { added, missing };
}

// ---- insert / reinforce / close --------------------------------------------

function insertVersion(
  key: string,
  input: ClaimWriteInput,
  options: WriteOptions,
  mutationIds: string[],
): ClaimVersionRow {
  const id = claimVersionId(key, input.statedAt, input.text);
  const row = {
    id,
    claim_key: key,
    kind: input.kind,
    subject_id: input.subjectId ?? null,
    subject_hint: input.subjectHint ?? null,
    predicate: input.predicate ?? null,
    object: input.object ?? null,
    text: input.text,
    speaker_id: input.speakerId ?? null,
    addressee_id: input.addresseeId ?? null,
    attribution: input.attribution ?? null,
    party_pair: input.partyPair ?? null,
    confidence: input.confidence ?? null,
    stated_at: input.statedAt,
    valid_from: input.validFrom ?? null,
    valid_to: input.validTo ?? null,
    ingested_at: nowIso(options),
    decided_by: options.decidedBy ?? null,
  };
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO claim_versions
         (id, claim_key, kind, subject_id, subject_hint, predicate, object, text,
          speaker_id, addressee_id, attribution, party_pair, confidence, stated_at,
          valid_from, valid_to, ingested_at, decided_by)
       VALUES
         (@id, @claim_key, @kind, @subject_id, @subject_hint, @predicate, @object, @text,
          @speaker_id, @addressee_id, @attribution, @party_pair, @confidence, @stated_at,
          @valid_from, @valid_to, @ingested_at, @decided_by)`,
    )
    .run(row);
  mutationIds.push(
    logMutation({
      actor: options.actor ?? WRITE_ACTOR,
      runId: options.runId ?? null,
      targetKind: "claim_version",
      targetId: id,
      field: "insert",
      newValue: { id, claimKey: key, statedAt: input.statedAt, text: input.text },
      reason: "insert",
    }),
  );
  return readClaimVersion(id) as ClaimVersionRow;
}

/**
 * REINFORCE — union the evidence, take the max confidence, add NO row.
 *
 * `stated_at` folds to the maximum: a claim restated later WAS said later, and
 * a maximum is order-independent, which is what keeps the graph confluent
 * across ingest orders. A row that has already been closed is left at its own
 * `stated_at`: reopening a superseded window is a supersession decision, and
 * that belongs to P-AG3, not to a fold.
 */
function reinforce(
  target: ClaimVersionRow,
  input: ClaimWriteInput,
  options: WriteOptions,
  mutationIds: string[],
): ClaimVersionRow {
  const closed = typeof target.closedBy === "string" && target.closedBy !== "";
  const statedAt = closed || input.statedAt <= target.statedAt ? target.statedAt : input.statedAt;
  const confidence = maxConfidence(target.confidence, input.confidence);
  const changed = statedAt !== target.statedAt || confidence !== target.confidence;
  if (changed) {
    getDb()
      .prepare(
        `UPDATE claim_versions
            SET stated_at = ?, confidence = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
      )
      .run(statedAt, confidence, target.id);
  }
  mutationIds.push(
    logMutation({
      actor: options.actor ?? WRITE_ACTOR,
      runId: options.runId ?? null,
      targetKind: "claim_version",
      targetId: target.id,
      field: "reinforce",
      oldValue: { statedAt: target.statedAt, confidence: target.confidence },
      newValue: { statedAt, confidence },
      reason: "exact claim_key hit",
    }),
  );
  return readClaimVersion(target.id) as ClaimVersionRow;
}

function closeVersion(plan: SupersessionPlan, options: WriteOptions, mutationIds: string[]): string | null {
  const close = plan.close;
  if (!close) return null;
  const before = readClaimVersion(close.id);
  if (!before) return null;
  getDb()
    .prepare(
      `UPDATE claim_versions
          SET closed_by = ?, closed_reason = ?, valid_to = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(close.closedBy, close.closedReason, close.validTo, close.id);
  mutationIds.push(
    logMutation({
      actor: options.actor ?? WRITE_ACTOR,
      runId: options.runId ?? null,
      targetKind: "claim_version",
      targetId: close.id,
      field: "close",
      oldValue: { closedBy: before.closedBy, closedReason: before.closedReason, validTo: before.validTo },
      newValue: { closedBy: close.closedBy, closedReason: close.closedReason, validTo: close.validTo },
      reason: plan.verdict?.raw ?? close.closedReason,
    }),
  );
  return close.id;
}

function askUser(
  claim: ClaimVersionRow,
  other: ClaimVersionRow,
  options: WriteOptions,
  mutationIds: string[],
): string {
  const id = `q_${randomBytes(8).toString("hex")}`;
  const question =
    `Are these the same thing, or two different ones? ` +
    `"${claim.text ?? ""}" and "${other.text ?? ""}"`;
  getDb()
    .prepare(
      `INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES (?, 'claim_relation', 'claim_version', ?, ?, ?, 'open')`,
    )
    .run(id, claim.id, question, JSON.stringify([claim.id, other.id]));
  mutationIds.push(
    logMutation({
      actor: options.actor ?? WRITE_ACTOR,
      runId: options.runId ?? null,
      targetKind: "question",
      targetId: id,
      field: "insert",
      newValue: { id, targetId: claim.id, question },
      reason: "P-AG3 unsure",
    }),
  );
  return id;
}

// ---- near hits -------------------------------------------------------------

/** The best candidate at or above the measured band, or null. */
export function pickNearHit(
  candidates: readonly ClaimVersionRow[],
  scores: readonly NearCandidate[] | undefined,
): { row: ClaimVersionRow; similarity: number } | null {
  const byId = new Map((scores ?? []).map((c) => [c.claimId, c.similarity]));
  let best: { row: ClaimVersionRow; similarity: number } | null = null;
  for (const row of candidates) {
    const score = byId.get(row.id);
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (score < CLAIM_NEAR_HIT_MIN) continue;
    if (best === null || score > best.similarity) best = { row, similarity: score };
  }
  return best;
}

function ag3InputFor(
  stored: ClaimVersionRow,
  incoming: ClaimWriteInput,
  incomingId: string,
  similarity: number,
): Ag3Input {
  return {
    subject: { entityId: stored.subjectId, name: stored.subjectHint ?? incoming.subjectHint ?? null },
    stored: {
      id: stored.id,
      tag: incoming.tag ?? "",
      text: stored.text ?? "",
      statedAt: stored.statedAt,
      validFrom: stored.validFrom,
      validTo: stored.validTo,
    },
    incoming: {
      id: incomingId,
      tag: incoming.tag ?? "",
      text: incoming.text,
      statedAt: incoming.statedAt,
      validFrom: incoming.validFrom ?? null,
      validTo: incoming.validTo ?? null,
    },
    similarity,
  };
}

// ---- the write -------------------------------------------------------------

/**
 * Write one claim. The three branches of §11.6, and nothing else.
 *
 * The order of the checks is the architecture's: an exact key hit is settled
 * by code and never costs a model call, a near hit is the ONLY case that asks
 * P-AG3, and everything else is a new claim. No branch deletes a row, and
 * every branch leaves `mutations` behind.
 */
export function writeClaim(input: ClaimWriteInput, options: WriteOptions = {}): ClaimWriteResult {
  const key = claimKey(input);
  const mutationIds: string[] = [];
  const now = nowIso(options);
  const evidence = input.evidence ?? [];

  // ── exact hit ───────────────────────────────────────────────────────────
  const versions = versionsOfKey(key);
  if (versions.length > 0) {
    const live = activeVersion(versions, now);
    const newest = versions[0];
    const reopens = live === null && input.statedAt > newest.statedAt;
    const target = reopens
      ? insertVersion(key, input, options, mutationIds)
      : reinforce(live ?? newest, input, options, mutationIds);
    const attached = attachEvidence(target.id, evidence, options, mutationIds);
    return {
      route: reopens ? "insert" : "reinforce",
      claimKey: key,
      claimId: target.id,
      created: reopens,
      reinforced: !reopens,
      closedId: null,
      questionId: null,
      plan: null,
      adjudication: null,
      adjudicationDeferred: false,
      evidenceAdded: attached.added,
      evidenceMissing: attached.missing,
      mutationIds,
    };
  }

  // ── near hit ────────────────────────────────────────────────────────────
  const near = pickNearHit(nearHitCandidates(input, key), options.candidates);
  const incomingId = claimVersionId(key, input.statedAt, input.text);

  if (near && options.adjudicator) {
    const ag3 = ag3InputFor(near.row, input, incomingId, near.similarity);
    const prompt = buildAg3Prompt(ag3);
    const answered = options.adjudicator({
      prompt,
      input: ag3,
      storedId: near.row.id,
      incomingId,
    });
    const adjudication = answered
      ? parseAg3Response(answered.response, prompt.claimIds)
      : null;
    const verdict = adjudication?.verdict ?? null;

    if (verdict && verdict.relation === "duplicate") {
      // A duplicate becomes EVIDENCE (§11.6 rule 4), never a discarded line.
      const target = reinforce(near.row, input, options, mutationIds);
      const attached = attachEvidence(target.id, evidence, options, mutationIds);
      return {
        route: "adjudicated",
        claimKey: key,
        claimId: target.id,
        created: false,
        reinforced: true,
        closedId: null,
        questionId: null,
        plan: planSupersession({
          stored: near.row,
          incoming: { id: incomingId, claimKey: key, statedAt: input.statedAt },
          relation: "duplicate",
          verdict,
        }),
        adjudication,
        adjudicationDeferred: false,
        evidenceAdded: attached.added,
        evidenceMissing: attached.missing,
        mutationIds,
      };
    }

    const inserted = insertVersion(key, input, options, mutationIds);
    const attached = attachEvidence(inserted.id, evidence, options, mutationIds);
    const plan = verdict
      ? planSupersession({
          stored: near.row,
          incoming: inserted,
          relation: verdict.relation,
          validTo: verdict.validTo,
          later: verdict.later,
          verdict,
        })
      : plainInsertPlan(inserted);
    const closedId = closeVersion(plan, options, mutationIds);
    const questionId = plan.asksUser ? askUser(inserted, near.row, options, mutationIds) : null;
    return {
      route: "adjudicated",
      claimKey: key,
      claimId: inserted.id,
      created: true,
      reinforced: false,
      closedId,
      questionId,
      plan,
      adjudication,
      adjudicationDeferred: false,
      evidenceAdded: attached.added,
      evidenceMissing: attached.missing,
      mutationIds,
    };
  }

  // ── else ────────────────────────────────────────────────────────────────
  const inserted = insertVersion(key, input, options, mutationIds);
  const attached = attachEvidence(inserted.id, evidence, options, mutationIds);
  return {
    route: "insert",
    claimKey: key,
    claimId: inserted.id,
    created: true,
    reinforced: false,
    closedId: null,
    questionId: null,
    plan: plainInsertPlan(inserted),
    adjudication: null,
    /** A near hit with no adjudicator wired defers (§9.5.1), it never guesses. */
    adjudicationDeferred: near !== null,
    evidenceAdded: attached.added,
    evidenceMissing: attached.missing,
    mutationIds,
  };
}

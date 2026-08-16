// ===========================================================================
// [CODE] Category M executor — claims extraction + write, end to end.
//
// M is the P-CL1 half of the claims pipeline (arch §11.3, §12.4; build items
// 3.1 + 3.3). `frozen_response` is a FROZEN P-CL1 ANSWER — the model's own wire
// lines — and everything after that byte is real product code:
//
//   given.roster/events ─► prompt-local AliasTable (wire/aliases.ts)
//   frozen_response ─────► parseCl1Response (claims/extract.ts)
//   every parsed claim ──► writeClaim (claims/write.ts) over a real temp
//                          SQLite DB with the real migrations
//
// Nothing here re-implements a rule the product owns. Attribution decoding
// (1p → first_person) is the wire enum table's; "unknown beats wrong" is the
// alias range check's; "empty conf means 0.9" is the codec's; "no evidence, no
// write" is the parser's unsupported bucket (evals M-088..091); and the stored
// row read back out of `claim_versions` is what proves the write path kept
// `valid_from` and `confidence` bitemporal and untouched.
//
// The run feeds the §14.2 claims gates it can actually measure:
//   * claims_third_person — one observation per extracted claim (stray = []).
//   * claims_not_age_filtered — one observation per claim whose evidence is
//     over a year old: passed iff it was WRITTEN. Claims are never age-gated.
//   * claims_duplicates — the measured duplicate rate over the active view.
//   * all_model_output_discarded — `extractionAccounts` over the whole answer.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractionAccounts,
  parseCl1Response,
  type ExtractedClaim,
} from "../../claims/extract.js";
import { normalizeKeyText } from "../../claims/keys.js";
import { activeClaims, readClaimVersion, writeClaim, type ClaimVersionRow } from "../../claims/write.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { createAliasTable, toBase36, type AliasTable } from "../../wire/aliases.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, GateObservation, Produced } from "../runner.js";

/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = "2026-08-15T12:00:00.000Z";

/** Evidence older than this is "old history" for `claims_not_age_filtered`. */
const OLD_EVIDENCE_BEFORE = "2025-08-15T00:00:00.000Z";

/** One synthetic episode per fixture, so a frozen `Y|e1|…` line resolves. */
const EPISODE_ID = "ep1";

// ---- the world the fixture describes ---------------------------------------

interface World {
  table: AliasTable;
  /** roster alias (`a1`) → the entity id seeded for it. */
  entityIdByAlias: Map<string, string>;
  /** event id (`ev1`) → its `events.ts`. */
  tsByEventId: Map<string, string>;
  /** event id → the fixture's `who` token (`self`, `a1`). */
  whoByEventId: Map<string, string>;
}

/**
 * Build the prompt-local table exactly as `buildCl1Prompt` would have: roster
 * entities minted in roster order, events minted in event-number order. The
 * minted tokens must be the tokens the fixture's frozen answer speaks in — a
 * mismatch is an authoring bug and throws rather than mis-reading the answer.
 */
function buildWorld(fixture: Fixture): World {
  const table = createAliasTable();
  const entityIdByAlias = new Map<string, string>();
  for (const entry of fixture.given.roster) {
    const eq = entry.indexOf("=");
    const alias = entry.slice(0, eq).trim();
    const label = entry.slice(eq + 1).trim();
    if (alias === "self") continue; // reserved, never numbered (§5.2)
    const id = `en_${alias}`;
    const minted = table.mint("entity", id, label);
    if (minted !== alias) {
      throw new Error(`claims fixture: roster entry ${alias} minted as ${minted} — roster is out of order`);
    }
    entityIdByAlias.set(alias, id);
  }

  const tsByEventId = new Map<string, string>();
  const whoByEventId = new Map<string, string>();
  const events = [...fixture.given.events].sort((a, b) => a.n - b.n);
  for (const event of events) {
    const id = `ev${event.n}`;
    const minted = table.mintEvent(id);
    if (minted !== toBase36(event.n)) {
      throw new Error(`claims fixture: event ${event.n} minted token ${minted} — events must number 1..n`);
    }
    tsByEventId.set(id, event.ts);
    whoByEventId.set(id, event.who);
  }

  table.mint("episode", EPISODE_ID);
  return { table, entityIdByAlias, tsByEventId, whoByEventId };
}

/** Runs `body` against a private, empty database and tears it down after. */
function inFreshDb<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-claims-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return body();
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedWorld(fixture: Fixture, world: World): void {
  runMigrations();
  const db = getDb();
  const insertEntity = db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical) VALUES (?, 'person', ?)`);
  insertEntity.run("self", "Me");
  for (const entry of fixture.given.roster) {
    const eq = entry.indexOf("=");
    const alias = entry.slice(0, eq).trim();
    if (alias === "self") continue;
    insertEntity.run(world.entityIdByAlias.get(alias), entry.slice(eq + 1).trim());
  }
  const insertEvent = db.prepare(`INSERT OR IGNORE INTO events (id, ts, kind, text) VALUES (?, ?, 'message', ?)`);
  const events = [...fixture.given.events].sort((a, b) => a.n - b.n);
  for (const event of events) insertEvent.run(`ev${event.n}`, event.ts, event.text);
}

// ---- reading a claim back out ----------------------------------------------

/** `self` | the roster token (`a1`) | null. Hints are not subjects. */
function subjectToken(claim: ExtractedClaim): string | null {
  if (claim.subject.kind === "self") return "self";
  if (claim.subject.kind === "entity") return claim.subject.token;
  return null;
}

/** Active claims whose normalised text is another active claim's. */
function duplicateRate(): number {
  const texts = activeClaims().map((c) => normalizeKeyText(c.text));
  if (texts.length === 0) return 0;
  const seen = new Set<string>();
  let dupes = 0;
  for (const t of texts) {
    if (seen.has(t)) dupes += 1;
    else seen.add(t);
  }
  return dupes / texts.length;
}

// ---- the executor ----------------------------------------------------------

export const claimsExecutor: Executor = ({ fixture, response }) => {
  const world = buildWorld(fixture);
  const answer = parseCl1Response(response, world.table);
  const accounts = extractionAccounts(answer);

  interface WrittenClaim {
    claim: ExtractedClaim;
    row: ClaimVersionRow | null;
    oldEvidence: boolean;
  }

  const result = inFreshDb((): { written: WrittenClaim[]; duplicates: number } => {
    seedWorld(fixture, world);
    const written: WrittenClaim[] = [];
    for (const claim of answer.claims) {
      // `stated_at` is the EVENT's ts — the only basis of precedence (§11.3.7).
      const firstEvent = claim.eventIds[0];
      const statedAt = world.tsByEventId.get(firstEvent) ?? NOW;
      // `speaker_id` is written by CODE from the event actor (§11.3.4).
      const who = world.whoByEventId.get(firstEvent) ?? "";
      const speakerId = who === "self" ? "self" : (world.entityIdByAlias.get(who) ?? null);
      const outcome = writeClaim(
        {
          kind: claim.kind,
          tag: claim.tag,
          subjectId: claim.subjectId,
          subjectHint: claim.subjectHint,
          predicate: claim.text,
          text: claim.text,
          speakerId,
          attribution: claim.attribution,
          confidence: claim.confidence,
          statedAt,
          validFrom: claim.validFrom,
          evidence: claim.eventIds.map((eventId) => ({ eventId, quote: claim.text })),
        },
        { now: NOW, runId: "run_eval_m" },
      );
      const oldEvidence = claim.eventIds.some((id) => {
        const ts = world.tsByEventId.get(id);
        return typeof ts === "string" && ts < OLD_EVIDENCE_BEFORE;
      });
      written.push({ claim, row: readClaimVersion(outcome.claimId), oldEvidence });
    }
    return { written, duplicates: duplicateRate() };
  });

  const gates: GateObservation[] = [
    {
      gate: "all_model_output_discarded",
      passed: accounts,
      note: accounts ? "every P-CL1 line accounted for" : "an answer line was not accounted for",
    },
    { gate: "claims_duplicates", passed: result.duplicates === 0, value: result.duplicates },
  ];
  for (const { claim } of result.written) {
    gates.push({
      gate: "claims_third_person",
      passed: claim.stray.length === 0,
      note: claim.stray.length === 0 ? undefined : `stray pronoun(s): ${claim.stray.join(", ")}`,
    });
  }
  for (const { row, oldEvidence } of result.written) {
    if (!oldEvidence) continue;
    gates.push({
      gate: "claims_not_age_filtered",
      passed: row !== null,
      note: row !== null ? "old-history claim written in full" : "old-history claim was not written",
    });
  }

  const oldEvidenceWritten = result.written.filter((w) => w.oldEvidence && w.row !== null).length;
  const produced: Produced = {
    output: {
      claims: result.written.map(({ claim, row }) => ({
        tag: claim.tag,
        kind: claim.kind,
        subject: subjectToken(claim),
        subject_id: claim.subjectId,
        subject_hint: claim.subjectHint,
        attribution: claim.attribution,
        confidence: claim.confidence,
        valid_from: claim.validFrom,
        text: claim.text,
        stray: claim.stray,
        stored_confidence: row?.confidence ?? null,
        stored_valid_from: row?.validFrom ?? null,
        stored_stated_at: row?.statedAt ?? null,
        speaker: row?.speakerId ?? null,
      })),
      unsupported: answer.unsupported.map((u) => ({ tag: u.tag, reason: u.reason })),
    },
    state: {
      claims_extracted: answer.claims.length,
      claims_written: result.written.filter((w) => w.row !== null).length,
      unsupported: answer.unsupported.length,
      loops: answer.loops.length,
      summaries: answer.summaries.length,
      stray_pronoun_claims: result.written.filter((w) => w.claim.stray.length > 0).length,
      old_evidence_claims: result.written.filter((w) => w.oldEvidence).length,
      old_evidence_written: oldEvidenceWritten,
      duplicate_rate: result.duplicates,
      model_output_discarded: accounts ? 0 : 1,
    },
    metrics: {
      duplicate_rate: result.duplicates,
      model_calls: 0,
    },
    gates,
  };
  return produced;
};

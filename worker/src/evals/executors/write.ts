// ===========================================================================
// [CODE] Category R executor — the real claim write path (build item 3.3).
//
// R is `[CODE]` everywhere except the P-AG3 answer, so `frozen_response`
// carries a SCENARIO — one `tag|key=value|…` record per line — and, beneath an
// `#AG3` header, the frozen model answer for the next adjudication. Every
// number below comes back out of `worker/src/claims/*` over a real temp SQLite
// database with the real migrations: `claims_active` is the VIEW from 0020,
// not a re-implementation of it, and nothing here re-derives a key, a
// precedence rule or a supersession.
//
// Scenario records:
//
//   entity|id=en1|type=person|name=Rahul Arora
//   event|id=ev1|ts=2026-03-02T10:00:00Z
//   claim|kind=fact|tag=F|subject=en1|text=…|said=2026-03-02T10:00:00Z
//         |conf=0.8|event=ev1|quote=…|sim=0.9|run=r1
//   loop|owner=en1|counterparty=en2|intent=send the rent receipt
//   user_mutation|run=r1|field=text        a human's own edit inside a run
//   undo|run=r1                            reverse-replay that run
//   confluence|orders=012,102,210,201      replay the claim lines per order,
//                                          each on a FRESH database, and
//                                          compare the graphs
//
// `sim` is the CALIBRATED similarity the caller measured for the stored
// candidates — a case that states "calibrated 0.92" means it, and a case with
// no `sim` offers no candidate at all, so no adjudication is possible.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeVersion } from "../../claims/supersede.js";
import { loopKey, normalizeKeyText } from "../../claims/keys.js";
import {
  activeClaims,
  undoRun,
  writeClaim,
  type ClaimVersionRow,
  type ClaimWriteInput,
  type ClaimWriteResult,
} from "../../claims/write.js";
import { ag3Accounts } from "../../prompts/p-ag3.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import type { Executor, GateObservation, Produced } from "../runner.js";

/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = "2026-08-15T12:00:00.000Z";

interface Line {
  tag: string;
  fields: Record<string, string>;
}

/** Splits the scenario from the frozen P-AG3 answers, in call order. */
function split(text: string): { scenario: Line[]; answers: string[] } {
  const scenario: Line[] = [];
  const answers: string[] = [];
  let current: number | null = null;
  for (const raw of (typeof text === "string" ? text : "").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#AG3")) {
      answers.push("");
      current = answers.length - 1;
      continue;
    }
    if (current !== null) {
      answers[current] = answers[current] === "" ? line : `${answers[current]}\n${line}`;
      continue;
    }
    if (line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`write scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    scenario.push({ tag, fields });
  }
  return { scenario, answers };
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Runs `body` against a private, empty database and tears it down after. */
function inFreshDb<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-write-"));
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

// ---- one run ---------------------------------------------------------------

interface RunTally {
  routes: string[];
  results: ClaimWriteResult[];
  modelCalls: number;
  /** True while every P-AG3 answer balanced: nothing the model said was lost. */
  balanced: boolean;
  loopKeys: string[];
  loopKeyIgnoresSpaceArc: boolean;
  reversed: number;
  userMutationsKept: number;
}

function claimInputOf(line: Line): ClaimWriteInput {
  const f = line.fields;
  const text = f.text ?? "";
  return {
    kind: f.kind ?? "fact",
    tag: f.tag ?? "F",
    subjectId: f.subject ?? null,
    subjectHint: f.hint ?? null,
    predicate: f.predicate ?? text,
    text,
    confidence: num(f.conf),
    statedAt: f.said ?? NOW,
    validFrom: f.valid_from ?? null,
    evidence: f.event ? [{ eventId: f.event, quote: f.quote ?? text }] : [],
  };
}

function seedWorld(scenario: readonly Line[]): void {
  runMigrations();
  const db = getDb();
  for (const line of scenario) {
    if (line.tag === "entity") {
      db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical) VALUES (?, ?, ?)`).run(
        line.fields.id,
        line.fields.type ?? "person",
        line.fields.name ?? null,
      );
    } else if (line.tag === "event") {
      db.prepare(`INSERT OR IGNORE INTO events (id, ts, kind, text) VALUES (?, ?, 'message', ?)`).run(
        line.fields.id,
        line.fields.ts ?? NOW,
        line.fields.text ?? "x",
      );
    }
  }
}

/** Applies one scenario, in the order given, over the current database. */
function applyScenario(scenario: readonly Line[], answers: readonly string[], order?: readonly number[]): RunTally {
  seedWorld(scenario);
  const tally: RunTally = {
    routes: [],
    results: [],
    modelCalls: 0,
    balanced: true,
    loopKeys: [],
    loopKeyIgnoresSpaceArc: true,
    reversed: 0,
    userMutationsKept: 0,
  };

  let answerIndex = 0;
  const claimLines = scenario.filter((l) => l.tag === "claim");
  const sequence = order
    ? order.map((i) => claimLines[i]).filter((l): l is Line => l !== undefined)
    : null;

  const writeOne = (line: Line): void => {
    const input = claimInputOf(line);
    const similarity = num(line.fields.sim);
    const candidates =
      similarity === null
        ? []
        : activeClaims()
            .filter((row) => row.kind === input.kind && row.subjectId === (input.subjectId ?? null))
            .map((row) => ({ claimId: row.id, similarity }));
    const result = writeClaim(input, {
      now: NOW,
      runId: line.fields.run ?? "run_eval",
      candidates,
      adjudicator:
        answers.length === 0
          ? null
          : () => {
              tally.modelCalls += 1;
              const response = answers[Math.min(answerIndex, answers.length - 1)];
              answerIndex += 1;
              return { response };
            },
    });
    if (result.adjudication && !ag3Accounts(result.adjudication).balanced) tally.balanced = false;
    tally.routes.push(result.route);
    tally.results.push(result);
  };

  if (sequence) {
    for (const line of sequence) writeOne(line);
    return tally;
  }

  for (const line of scenario) {
    switch (line.tag) {
      case "claim":
        writeOne(line);
        break;
      case "loop": {
        const base = {
          ownerId: line.fields.owner ?? null,
          counterpartyId: line.fields.counterparty ?? null,
          intent: line.fields.intent ?? "",
        };
        const key = loopKey(base);
        // The same call with the two banned fields bolted on must not move it.
        const withCircular = { ...base, space_id: "n9", arc_id: "n9" } as unknown as typeof base;
        if (loopKey(withCircular) !== key) tally.loopKeyIgnoresSpaceArc = false;
        tally.loopKeys.push(key);
        break;
      }
      case "user_mutation": {
        getDb()
          .prepare(
            `INSERT INTO mutations (id, actor, run_id, target_kind, target_id, field, new_json)
             VALUES (?, 'user', ?, 'claim_version', ?, ?, '"a human said so"')`,
          )
          .run(
            `mut_user_${tally.results.length}`,
            line.fields.run ?? "run_eval",
            line.fields.target ?? (tally.results[0]?.claimId ?? "unknown"),
            line.fields.field ?? "text",
          );
        break;
      }
      case "undo": {
        const undone = undoRun(line.fields.run ?? "run_eval");
        tally.reversed += undone.reversed.length;
        tally.userMutationsKept += undone.skippedUserMutations.length;
        break;
      }
      default:
        break;
    }
  }
  return tally;
}

// ---- reading the graph back ------------------------------------------------

interface Graph {
  claims: number;
  active: string[];
  closed: { text: string; reason: string | null; valid_to: string | null }[];
  questions: number;
  evidence: number;
  mutations: number;
  /** Rows, key-ordered, for the confluence comparison. */
  rows: unknown[];
}

function allVersions(): ClaimVersionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, claim_key, kind, subject_id, subject_hint, predicate, object, text,
              speaker_id, addressee_id, attribution, party_pair, confidence, stated_at,
              valid_from, valid_to, closed_by, closed_reason, decided_by
         FROM claim_versions ORDER BY id`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    claimKey: r.claim_key as string,
    kind: (r.kind as string) ?? null,
    subjectId: (r.subject_id as string) ?? null,
    subjectHint: (r.subject_hint as string) ?? null,
    predicate: (r.predicate as string) ?? null,
    object: (r.object as string) ?? null,
    text: (r.text as string) ?? null,
    speakerId: (r.speaker_id as string) ?? null,
    addresseeId: (r.addressee_id as string) ?? null,
    attribution: (r.attribution as string) ?? null,
    partyPair: (r.party_pair as string) ?? null,
    confidence: (r.confidence as number) ?? null,
    statedAt: r.stated_at as string,
    validFrom: (r.valid_from as string) ?? null,
    validTo: (r.valid_to as string) ?? null,
    closedBy: (r.closed_by as string) ?? null,
    closedReason: (r.closed_reason as string) ?? null,
    decidedBy: (r.decided_by as string) ?? null,
  }));
}

function count(sql: string): number {
  return (getDb().prepare(sql).get() as { n: number }).n;
}

function readGraph(): Graph {
  const versions = allVersions();
  return {
    claims: versions.length,
    active: activeClaims()
      .map((c) => c.text ?? "")
      .sort(),
    closed: versions
      .filter((v) => v.closedBy !== null)
      .map((v) => ({ text: v.text ?? "", reason: v.closedReason, valid_to: v.validTo }))
      .sort((a, b) => (a.text < b.text ? -1 : 1)),
    questions: count(`SELECT COUNT(*) AS n FROM questions`),
    evidence: count(`SELECT COUNT(*) AS n FROM evidence`),
    mutations: count(`SELECT COUNT(*) AS n FROM mutations`),
    rows: versions.map((v) => ({
      claim_key: v.claimKey,
      text: v.text,
      stated_at: v.statedAt,
      valid_to: v.validTo,
      closed_reason: v.closedReason,
      confidence: v.confidence,
    })),
  };
}

/**
 * Does the VIEW agree with `stated_at` alone?
 *
 * Recomputed here from the rows, by `supersede.ts`, with no reference to
 * `ingested_at` or to insertion order. A disagreement means precedence came
 * from somewhere it may not (R-027).
 */
function statedAtPrecedenceHolds(): boolean {
  const byKey = new Map<string, ClaimVersionRow[]>();
  for (const v of allVersions()) {
    const bucket = byKey.get(v.claimKey);
    if (bucket) bucket.push(v);
    else byKey.set(v.claimKey, [v]);
  }
  const expected = [...byKey.values()]
    .map((set) => activeVersion(set, NOW)?.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
  const actual = activeClaims()
    .map((c) => c.id)
    .sort();
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** An older claim may never close a newer one. Measured, not assumed. */
function lateDislodges(): number {
  const byId = new Map(allVersions().map((v) => [v.id, v]));
  let bad = 0;
  for (const v of byId.values()) {
    if (v.closedBy === null) continue;
    const closer = byId.get(v.closedBy);
    if (closer && closer.statedAt < v.statedAt) bad += 1;
  }
  return bad;
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

export const writeExecutor: Executor = ({ response }) => {
  const { scenario, answers } = split(response);
  const confluenceLine = scenario.find((l) => l.tag === "confluence");

  const main = inFreshDb((): { tally: RunTally; graph: Graph; precedence: boolean; dislodges: number; duplicates: number } => {
    const tally = applyScenario(scenario, answers);
    return {
      tally,
      graph: readGraph(),
      precedence: statedAtPrecedenceHolds(),
      dislodges: lateDislodges(),
      duplicates: duplicateRate(),
    };
  });

  let confluent: boolean | null = null;
  if (confluenceLine) {
    const orders = (confluenceLine.fields.orders ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== "")
      .map((o) => [...o].map((c) => Number.parseInt(c, 36)));
    const graphs = orders.map((order) =>
      inFreshDb(() => {
        applyScenario(scenario, answers, order);
        return JSON.stringify(readGraph().rows);
      }),
    );
    confluent = graphs.length > 0 && graphs.every((g) => g === graphs[0]);
  }

  const gates: GateObservation[] = [
    {
      gate: "confluence_stated_at_precedence",
      passed: main.precedence,
      note: main.precedence ? "active set = greatest stated_at, recomputed" : "the view disagreed with stated_at",
    },
    {
      gate: "confluence_no_late_dislodge",
      passed: main.dislodges === 0,
      note: `${main.dislodges} older-closes-newer supersession(s)`,
    },
    {
      gate: "all_model_output_discarded",
      passed: main.tally.balanced,
      note: main.tally.balanced ? "every P-AG3 line accounted for" : "an answer line was not accounted for",
    },
    {
      gate: "claims_duplicates",
      passed: main.duplicates === 0,
      value: main.duplicates,
    },
  ];
  if (confluent !== null) {
    gates.push({
      gate: "confluence_order_independence",
      passed: confluent,
      note: confluent ? "every ingest order produced one graph" : "the orders diverged",
    });
  }

  const produced: Produced = {
    output: {
      claims: main.graph.active.map((text) => ({ text })),
      closed: main.graph.closed,
    },
    state: {
      routes: main.tally.routes,
      claims: main.graph.claims,
      active: main.graph.active,
      closed: main.graph.closed,
      questions: main.graph.questions,
      evidence: main.graph.evidence,
      mutations: main.graph.mutations,
      model_calls: main.tally.modelCalls,
      model_output_discarded: main.tally.balanced ? 0 : 1,
      stated_at_precedence: main.precedence,
      late_dislodges: main.dislodges,
      duplicate_rate: main.duplicates,
      loop_keys: main.tally.loopKeys,
      loop_key_ignores_space_arc: main.tally.loopKeyIgnoresSpaceArc,
      reversed: main.tally.reversed,
      user_mutations_kept: main.tally.userMutationsKept,
      confluent,
    },
    metrics: {
      model_calls: main.tally.modelCalls,
      duplicate_rate: main.duplicates,
    },
    gates,
  };
  return produced;
};

// ===========================================================================
// [CODE] purge-eval-data — the cleanup path for the eval leak (defect fix,
// shipped 13.4.1). Run it with `npm run purge:eval-data`.
//
// Shipped 13.4.1 ran the golden harness against the user's real home, so
// fixture world-state ended up in real Timelines: "Rohan: villa advance by 5pm
// TODAY", https://villas.example/…, stream keys like ast-04-mtdcsww3-chat.
// evals/home.ts stops any NEW leak. This module removes the rows already
// there, and everything derived from them.
//
// IDENTIFICATION IS CONSERVATIVE AND NAMED. A row is fixture-origin only when
// it trips one of the signatures below, each of which is impossible for real
// captured data — not a heuristic about content:
//
//   example-tld-url     the event carries a URL whose HOST sits under the
//                       .example TLD, which RFC 2606 reserves and no resolver
//                       will ever answer. Every browser/screen fixture seed in
//                       executors/assist.ts uses it.
//   example-tld-stream  the stream KEY is itself such a host
//                       (villas.example, news.example-ast-02-…).
//   assist-fixture-key  a stream key shaped ast-<digit>… — the AST fixture
//                       nonce keys minted in executors/assist.ts.
//   eval-marked-key     a stream key that literally says eval:
//                       sunrise-402-eval-<ms>@g.us (executors/passes.ts),
//                       eval-p4@g.us / browser:eval-p4 / bar:eval-usr05
//                       (executors/p4.ts).
//
// DELETION IS THE HONEST CASCADE. It hands the matched ids to
// library/delete-cascade.ts — the same single-writer path the Library's
// "delete a span" uses — so episodes, claim versions, tasks, bundles,
// digests, escalations, decisions and the FTS rows go with them. Nothing here
// re-implements a delete. The one extra step is stream shells left with zero
// events, which are removed only when the shell's own key trips a signature.
// ===========================================================================

import type BetterSqlite3 from "better-sqlite3";

import { getDb } from "../db/connection.js";
import { hardDeleteEvents, type CascadeReport } from "../library/delete-cascade.js";

export interface EvalSignature {
  /** Stable id printed in the dry-run breakdown. */
  id: string;
  /** One line a human can check the rule against. */
  why: string;
  /** Cheap SQL prefilter over `events`. */
  sql: string;
  /** Optional exact confirmation the prefilter cannot express. */
  confirm?: (row: CandidateRow) => boolean;
}

interface CandidateRow {
  id: string;
  source_type: string | null;
  kind: string | null;
  stream_key: string | null;
  ts: string | null;
  text: string | null;
  link_url: string | null;
  payload_json: string | null;
}

/** Stream keys that are themselves a reserved-TLD host. */
const EXAMPLE_STREAM_SQL = `(
  stream_key LIKE '%.example'
  OR stream_key LIKE '%.example-%'
  OR stream_key LIKE '%.example/%'
  OR stream_key LIKE '%.example:%'
)`;

/** Stream keys that name the harness outright. */
const EVAL_MARKED_STREAM_SQL = `(
  stream_key LIKE 'eval-%'
  OR stream_key LIKE '%-eval-%'
  OR stream_key LIKE '%:eval-%'
  OR stream_key LIKE '%eval-p4%'
  OR stream_key LIKE '%eval-usr%'
)`;

/** AST fixture nonce keys: ast-04-…, ast-09c-…. GLOB so the digit is required. */
const ASSIST_STREAM_SQL = `(stream_key GLOB 'ast-[0-9]*')`;

const URL_RE = /\bhttps?:\/\/([A-Za-z0-9._~%-]+)/gi;

/**
 * True when the text carries a URL whose host is under the reserved .example
 * TLD. Host-scoped on purpose: a real page that merely contains the word
 * "example" (or the path /example/) is left alone.
 */
export function hasExampleTldUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  URL_RE.lastIndex = 0;
  for (const match of value.matchAll(URL_RE)) {
    const host = match[1]!.toLowerCase().replace(/\.$/, "");
    if (host === "example" || host.endsWith(".example")) return true;
  }
  return false;
}

export const EVAL_SIGNATURES: readonly EvalSignature[] = [
  {
    id: "example-tld-url",
    why: "carries a URL under the RFC 2606 reserved .example TLD (never a real page)",
    sql: `(link_url LIKE '%.example%' OR text LIKE '%.example%' OR payload_json LIKE '%.example%')`,
    confirm: (r) =>
      hasExampleTldUrl(r.link_url) || hasExampleTldUrl(r.text) || hasExampleTldUrl(r.payload_json),
  },
  {
    id: "example-tld-stream",
    why: "stream key is a reserved .example host (villas.example, news.example-ast-02-…)",
    sql: EXAMPLE_STREAM_SQL,
  },
  {
    id: "assist-fixture-key",
    why: "stream key is an AST fixture nonce (ast-<digit>…-chat, evals/executors/assist.ts)",
    sql: ASSIST_STREAM_SQL,
  },
  {
    id: "eval-marked-key",
    why: "stream key names the harness (…-eval-…@g.us, browser:eval-p4, bar:eval-usr05)",
    sql: EVAL_MARKED_STREAM_SQL,
  },
];

export interface PurgeMatch {
  id: string;
  /** Every signature the row tripped, in table order. */
  signatures: string[];
  source_type: string | null;
  kind: string | null;
  stream_key: string | null;
  ts: string | null;
  /** First 90 chars of the event text — so a human can eyeball the sample. */
  preview: string;
}

export interface PurgeSurvey {
  db_path: string;
  total_events: number;
  matches: PurgeMatch[];
  by_signature: { id: string; why: string; events: number }[];
  by_stream: { stream_key: string | null; source_type: string | null; events: number }[];
  /** What the cascade will take with them (re-checked at delete time). */
  derived_preview: {
    episodes: number;
    tasks: number;
    claim_versions: number;
    decisions: number;
    enrichment_bundles: number;
    escalations: number;
    stream_shells: number;
  };
}

function preview(text: string | null): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

/**
 * COUNT(...) over an id list, chunked under SQLite's parameter ceiling.
 * `$IDS` may appear more than once; the chunk is bound once per occurrence.
 * The result is a chunk SUM, so only use it for counts that cannot
 * double-count across chunks (a DISTINCT over chunks would).
 */
function countIn(db: BetterSqlite3.Database, sql: string, ids: string[]): number {
  let n = 0;
  const slots = sql.split("$IDS").length - 1;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    const params: string[] = [];
    for (let s = 0; s < slots; s += 1) params.push(...chunk);
    n += (db.prepare(sql.split("$IDS").join(marks)).get(...params) as { n: number }).n;
  }
  return n;
}

/** DISTINCT ids collected across chunks — safe where countIn would over-count. */
function distinctIn(db: BetterSqlite3.Database, sql: string, ids: string[]): number {
  const seen = new Set<string>();
  const slots = sql.split("$IDS").length - 1;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    const params: string[] = [];
    for (let s = 0; s < slots; s += 1) params.push(...chunk);
    for (const row of db.prepare(sql.split("$IDS").join(marks)).all(...params) as { id: string }[]) {
      seen.add(row.id);
    }
  }
  return seen.size;
}

/** How many rows of `table` mention any of `ids` in a JSON column. */
function countJsonMentions(
  db: BetterSqlite3.Database,
  table: string,
  column: string,
  ids: Set<string>,
): number {
  try {
    const rows = db.prepare(`SELECT ${column} AS j FROM ${table} WHERE ${column} IS NOT NULL`).all() as {
      j: string;
    }[];
    let n = 0;
    for (const row of rows) {
      for (const id of ids) {
        if (row.j.includes(id)) {
          n += 1;
          break;
        }
      }
    }
    return n;
  } catch {
    return 0; // table not migrated in this DB
  }
}

/** Stream shells whose own key trips a signature (cleaned when left empty). */
const EVAL_STREAM_SHELL_SQL = `(
  ${EXAMPLE_STREAM_SQL.replace(/stream_key/g, "external_key")}
  OR ${ASSIST_STREAM_SQL.replace(/stream_key/g, "external_key")}
  OR ${EVAL_MARKED_STREAM_SQL.replace(/stream_key/g, "external_key")}
)`;

/** Read-only: find every fixture-origin event and what hangs off it. */
export function surveyEvalData(dbPath?: string): PurgeSurvey {
  const db = getDb();
  const where = EVAL_SIGNATURES.map((s) => s.sql).join(" OR ");
  const rows = db
    .prepare(
      `SELECT id, source_type, kind, stream_key, ts, text, link_url, payload_json
         FROM events WHERE ${where} ORDER BY ts`,
    )
    .all() as CandidateRow[];

  const matches: PurgeMatch[] = [];
  const perSignature = new Map<string, number>();
  const perStream = new Map<string, { stream_key: string | null; source_type: string | null; events: number }>();

  // Re-check each prefiltered row against the signature that claimed it: the
  // SQL LIKE for .example is deliberately loose, the confirm is not.
  const bySignatureStmt = EVAL_SIGNATURES.map((sig) => ({
    sig,
    hit: db.prepare(`SELECT 1 AS y FROM events WHERE id = ? AND ${sig.sql}`),
  }));

  for (const row of rows) {
    const hits: string[] = [];
    for (const { sig, hit } of bySignatureStmt) {
      if (!hit.get(row.id)) continue;
      if (sig.confirm && !sig.confirm(row)) continue;
      hits.push(sig.id);
    }
    if (hits.length === 0) continue;
    for (const h of hits) perSignature.set(h, (perSignature.get(h) ?? 0) + 1);
    const key = `${row.source_type ?? ""} ${row.stream_key ?? ""}`;
    const bucket = perStream.get(key) ?? {
      stream_key: row.stream_key,
      source_type: row.source_type,
      events: 0,
    };
    bucket.events += 1;
    perStream.set(key, bucket);
    matches.push({
      id: row.id,
      signatures: hits,
      source_type: row.source_type,
      kind: row.kind,
      stream_key: row.stream_key,
      ts: row.ts,
      preview: preview(row.text),
    });
  }

  const ids = matches.map((m) => m.id);
  const idSet = new Set(ids);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;

  const derived_preview = {
    episodes:
      ids.length === 0
        ? 0
        : distinctIn(
            db,
            `SELECT DISTINCT episode_id AS id FROM episode_events
              WHERE start_event_id IN ($IDS) OR end_event_id IN ($IDS)`,
            ids,
          ),
    tasks: countJsonMentions(db, "tasks", "evidence_json", idSet),
    claim_versions: countJsonMentions(db, "claim_versions", "evidence_json", idSet),
    decisions:
      ids.length === 0
        ? 0
        : countIn(
            db,
            `SELECT COUNT(*) AS n FROM decisions WHERE target_kind = 'event' AND target_id IN ($IDS)`,
            ids,
          ),
    enrichment_bundles: countJsonMentions(db, "enrichment_bundles", "event_ids_json", idSet),
    escalations:
      ids.length === 0
        ? 0
        : countIn(db, `SELECT COUNT(*) AS n FROM context_escalations WHERE event_id IN ($IDS)`, ids),
    stream_shells: (
      db
        .prepare(`SELECT COUNT(*) AS n FROM streams WHERE ${EVAL_STREAM_SHELL_SQL}`)
        .get() as { n: number }
    ).n,
  };

  return {
    db_path: dbPath ?? db.name,
    total_events: total,
    matches,
    by_signature: EVAL_SIGNATURES.map((s) => ({
      id: s.id,
      why: s.why,
      events: perSignature.get(s.id) ?? 0,
    })).filter((s) => s.events > 0),
    by_stream: [...perStream.values()].sort((a, b) => b.events - a.events),
    derived_preview,
  };
}

export interface PurgeResult {
  survey: PurgeSurvey;
  cascade: CascadeReport;
  /** Empty stream shells removed after the cascade. */
  stream_shells_deleted: number;
}

/**
 * Delete every fixture-origin event and its whole derivation. Destructive and
 * deliberately not reversible — the cascade writes one counts-only tombstone
 * decision, exactly as a privacy delete does.
 */
export function purgeEvalData(opts: { reason?: string } = {}): PurgeResult {
  const survey = surveyEvalData();
  const ids = survey.matches.map((m) => m.id);
  if (ids.length === 0) {
    return {
      survey,
      cascade: {
        events_deleted: 0,
        episodes_deleted: 0,
        claim_versions_deleted: 0,
        claim_versions_stripped: 0,
        claims_deleted: 0,
        tasks_deleted: 0,
        tasks_stripped: 0,
        bundles_deleted: 0,
        bundles_stripped: 0,
        digests_deleted: 0,
        escalations_deleted: 0,
        decisions_deleted: 0,
        decision_id: null,
      },
      stream_shells_deleted: 0,
    };
  }

  const cascade = hardDeleteEvents(ids, {
    reason: opts.reason ?? "purge eval/fixture-origin data leaked by the golden harness",
    by: "purge-eval-data",
    targetKind: "source",
    targetId: "eval_fixture_purge",
  });

  // Stream shells: only ones whose OWN key is a fixture key, and only once no
  // event references them any more.
  const db = getDb();
  const stream_shells_deleted = db
    .prepare(
      `DELETE FROM streams
        WHERE ${EVAL_STREAM_SHELL_SQL}
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.stream_id = streams.id)`,
    )
    .run().changes;

  return { survey, cascade, stream_shells_deleted };
}

// ---- rendering -------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(6);
}

/** The dry-run summary. Pure string work so it is unit-testable. */
export function renderSurvey(
  survey: PurgeSurvey,
  sampleLimit = 8,
  heading = "DRY RUN (nothing has been deleted)",
): string {
  const dryRun = heading.startsWith("DRY RUN");
  const lines: string[] = [];
  lines.push(`purge-eval-data — ${heading}`);
  lines.push(`  database          ${survey.db_path}`);
  lines.push(`  events scanned    ${survey.total_events}`);
  lines.push(`  fixture-origin    ${survey.matches.length}`);
  if (survey.matches.length === 0) {
    lines.push("");
    lines.push("  No eval/fixture-origin events found. This database is clean.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("  matched by signature");
  for (const s of survey.by_signature) lines.push(`   ${pad(s.events)}  ${s.id} — ${s.why}`);

  lines.push("");
  lines.push("  matched streams");
  for (const s of survey.by_stream.slice(0, 20)) {
    lines.push(`   ${pad(s.events)}  ${s.source_type ?? "?"} · ${s.stream_key ?? "(no stream key)"}`);
  }
  if (survey.by_stream.length > 20) {
    lines.push(`           … and ${survey.by_stream.length - 20} more streams`);
  }

  lines.push("");
  lines.push("  sample events");
  for (const m of survey.matches.slice(0, sampleLimit)) {
    lines.push(`    ${m.ts ?? "?"}  ${m.kind ?? "?"}  ${m.preview || "(no text)"}`);
  }
  if (survey.matches.length > sampleLimit) {
    lines.push(`    … and ${survey.matches.length - sampleLimit} more events`);
  }

  const d = survey.derived_preview;
  lines.push("");
  lines.push("  derived rows that go with them (the cascade re-checks at delete time)");
  lines.push(
    `    episodes ${d.episodes} · tasks ${d.tasks} · claim versions ${d.claim_versions} · ` +
      `decisions ${d.decisions} · bundles ${d.enrichment_bundles} · escalations ${d.escalations} · ` +
      `empty stream shells ${d.stream_shells}`,
  );
  if (dryRun) {
    lines.push("");
    lines.push("  Nothing was deleted. Re-run with --confirm to remove these rows and");
    lines.push("  everything derived from them. The delete is permanent by design.");
  }
  return lines.join("\n");
}

/** The post-delete summary. */
export function renderPurge(result: PurgeResult): string {
  const c = result.cascade;
  return [
    "purge-eval-data — DELETED",
    `  database             ${result.survey.db_path}`,
    `  events               ${c.events_deleted}`,
    `  episodes             ${c.episodes_deleted}`,
    `  claim versions       ${c.claim_versions_deleted} deleted, ${c.claim_versions_stripped} stripped`,
    `  claims               ${c.claims_deleted}`,
    `  tasks                ${c.tasks_deleted} deleted, ${c.tasks_stripped} stripped`,
    `  bundles              ${c.bundles_deleted} deleted, ${c.bundles_stripped} stripped`,
    `  digests              ${c.digests_deleted}`,
    `  escalations          ${c.escalations_deleted}`,
    `  decisions            ${c.decisions_deleted}`,
    `  empty stream shells  ${result.stream_shells_deleted}`,
    `  tombstone decision   ${c.decision_id ?? "(none)"}`,
  ].join("\n");
}

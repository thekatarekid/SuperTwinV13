// ===========================================================================
// [CODE] FACT / TYP — the claims executor (GoldenEvals V6 P1 §5.16; V6 P1 S3.6).
//
// Deterministic, zero model calls. Each case seeds the fixture's people and
// [KNOWN] claims, appends its events (source per event — `self` is the bar),
// wraps them in one committed episode and runs the REAL extract pass
// (brain/extract-pass.ts) with a stub provider that answers with the
// fixture's RECORDED extract.v6 output (aliases e1.., c_x, ep_1 substituted
// for the seeded ids). The database is then read back and asserted:
//
//   FACT-01 supersede on job change        old ended (valid_to), new linked
//   FACT-02 contextual coexistence         both active, coexist decision
//   FACT-03 self-reported beats inferred   the hedged coexist becomes a supersede
//   FACT-04 ads are not preferences        promo copy dropped by code
//   FACT-05 jokes are tone                 feeling written, no belief claim
//   FACT-06 third-party sensitive          health claim about Priya dropped
//   TYP-01  a receipt yields columns       amount · currency · merchant · date
//   TYP-02  a booking yields status and id order_id · status · amount
//   TYP-03  no invented columns            range stays prose, amount null
//
// `overwrite = 0` is asserted on every case: each seeded claim keeps its row
// and its text. The case's rows are removed afterwards.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";
import { addEpisodeEvents } from "../../db/v6core.js";
import { claimTypedFields, SELF_ENTITY_ID, setClaimTypedFields, type TypedFields } from "../../db/v6graph.js";
import { writeClaimVersion, type ClaimKind } from "../../claims/store.js";
import { runExtractPass, type ExtractPassResult } from "../../brain/extract-pass.js";
import type { Provider, Usage } from "../../providers/types.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

const T0 = "2026-09-05T10:00:00+05:30";
const USAGE: Usage = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Answers the one extract call with the recorded output; a second call is a loud failure. */
function recordedProvider(text: string): Provider & { calls: number } {
  const p = {
    id: "fact-recorded",
    calls: 0,
    cancel: () => false,
    async send(opts) {
      p.calls += 1;
      if (p.calls > 1) throw new Error("FACT/TYP: the extract pass called the model twice");
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", sessionId: "s", usage: USAGE });
      return { sessionId: "s", usage: USAGE, freshFallback: false, status: "ok" as const };
    },
  } as Provider & { calls: number };
  return p;
}

export interface ClaimsRun {
  result: ExtractPassResult;
  /** alias → entity id (`self` included). */
  entityOf: Map<string, string>;
  /** known-claim alias → { claimKey, versionId, text }. */
  knownOf: Map<string, { claimKey: string; versionId: string; text: string }>;
  eventIdOf: Map<string, string>;
  episodeId: string;
  modelCalls: number;
  cleanup: () => void;
}

function subjectIdFor(ref: string | null | undefined, run: Pick<ClaimsRun, "entityOf">): string | null {
  if (ref === null || ref === undefined || ref === "unknown") return null;
  if (ref === "self") return SELF_ENTITY_ID;
  return run.entityOf.get(ref) ?? null;
}

/** Seed, stub, run the real pass, read back. Exported so the vitest suite drives the CLI's path. */
export async function runClaimsCase(id: string, setup: unknown, input: unknown[]): Promise<ClaimsRun> {
  const db = getDb();
  const s = rec(setup);
  const prefix = `fact_${id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_`;
  const now = str(s.now) ?? T0;

  // ---- people --------------------------------------------------------------
  const entityOf = new Map<string, string>([["self", SELF_ENTITY_ID]]);
  const entityIds: string[] = [];
  for (const raw of Array.isArray(s.people) ? s.people : []) {
    const p = rec(raw);
    const ref = str(p.ref);
    const name = str(p.name);
    if (!ref || !name) continue;
    const eid = `${prefix}ent_${ref.replace(/[^a-z0-9]+/gi, "_")}`;
    db.prepare(`INSERT INTO entities (id, type, canonical, provisional, circle) VALUES (?, 'person', ?, 0, ?)`).run(
      eid,
      name,
      str(p.circle) ?? "friends",
    );
    db.prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES (?, ?, 'wa', 'handle', ?)`).run(
      `${eid}_h`,
      eid,
      ref,
    );
    entityOf.set(ref, eid);
    entityIds.push(eid);
  }

  // ---- known claims ----------------------------------------------------------
  const knownOf = new Map<string, { claimKey: string; versionId: string; text: string }>();
  for (const raw of Array.isArray(s.known_claims) ? s.known_claims : []) {
    const k = rec(raw);
    const alias = str(k.id);
    const text = str(k.text);
    const kind = str(k.kind) ?? "fact";
    if (!alias || !text) continue;
    const claimKey = `${prefix}${alias}`;
    const provenance = str(k.provenance) ?? "observed";
    const version = writeClaimVersion({
      claimKey,
      kind: kind as ClaimKind,
      subjectId: subjectIdFor(str(k.subject), { entityOf }),
      subjectHint: subjectIdFor(str(k.subject), { entityOf }) === null ? str(k.subject) : null,
      text,
      speakerId: provenance === "self_reported" ? SELF_ENTITY_ID : null,
      attribution: provenance,
      confidence: typeof k.confidence === "number" ? k.confidence : 0.7,
      statedAt: str(k.stated_at) ?? "2026-01-01T00:00:00Z",
      validFrom: str(k.valid_from) ?? null,
      evidence: [{ event_ids: [`${prefix}seed`], quote: str(k.quote) ?? text }],
      decidedBy: "eval:seed",
      relation: "new",
    });
    if (k.fields) setClaimTypedFields(claimKey, rec(k.fields) as Partial<TypedFields>);
    knownOf.set(alias, { claimKey, versionId: version.id, text });
  }

  // ---- events → one committed episode ---------------------------------------
  const envelopes: EventEnvelope[] = [];
  const aliases: string[] = [];
  input.forEach((raw, i) => {
    const e = rec(raw);
    const alias = str(e.id) ?? `e${i + 1}`;
    const source = str(e.source) ?? "wa";
    const actor = str(e.actor) ?? (source === "self" ? "self" : "contact:rohan");
    const stream = str(e.stream) ?? (source === "self" ? "self:bar" : "wa:goa-gang@g.us");
    aliases.push(alias);
    envelopes.push({
      ts: str(e.ts) ?? new Date(Date.parse(now) - (input.length - i) * 60_000).toISOString(),
      source,
      kind: source === "self" ? "self.bar" : source === "wa" ? "wa.message" : `${source}.text`,
      origin: "live",
      streamKey: `${prefix}${stream}`,
      actor,
      roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text: str(e.text) ?? "", external_id: `${id}:${alias}` },
    });
  });
  const appended = appendEvents(envelopes, Date.parse(now));
  const eventIdOf = new Map<string, string>();
  aliases.forEach((a, i) => {
    const real = appended.ids[i] ?? "";
    if (real === "") throw new Error(`${id}: event ${a} was not written`);
    eventIdOf.set(a, real);
  });
  const firstStream = db.prepare(`SELECT stream_id FROM events WHERE id = ?`).get(eventIdOf.get(aliases[0]!)!) as { stream_id: string | null };
  const episodeId = `${prefix}ep_1`;
  db.prepare(`INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts) VALUES (?, ?, 'open', ?, ?, ?)`).run(
    episodeId,
    firstStream.stream_id,
    str(s.summary) ?? "fixture episode",
    envelopes[0]!.ts,
    envelopes[envelopes.length - 1]!.ts,
  );
  addEpisodeEvents(episodeId, [...eventIdOf.values()]);

  // ---- the recorded output, aliases substituted -------------------------------
  let text = JSON.stringify(s.recorded_output ?? { claims: [], people: [], tone: [], feelings: [] });
  const swap = (from: string, to: string): void => {
    text = text.split(JSON.stringify(from)).join(JSON.stringify(to));
  };
  for (const [a, real] of eventIdOf) swap(a, real);
  for (const [a, k] of knownOf) swap(a, k.claimKey);
  swap("ep_1", episodeId);
  // group scopes name the stream key the fixture wrote; the seeded key is prefixed
  text = text.split(`"group:`).join(`"group:${prefix}`);
  const provider = recordedProvider(text);

  const result = await runExtractPass([episodeId], { provider, now: () => new Date(now) });

  const cleanup = (): void => {
    const tx = db.transaction(() => {
      const keys = db
        .prepare(`SELECT DISTINCT claim_key FROM claim_versions WHERE claim_key LIKE ? OR episode_id = ?`)
        .all(`${prefix}%`, episodeId) as { claim_key: string }[];
      for (const { claim_key } of keys) {
        db.prepare(`DELETE FROM decisions WHERE target_kind = 'claim' AND target_id = ?`).run(claim_key);
        db.prepare(`DELETE FROM claim_versions WHERE claim_key = ?`).run(claim_key);
        db.prepare(`DELETE FROM claims WHERE claim_key = ?`).run(claim_key);
      }
      db.prepare(`DELETE FROM episode_events WHERE episode_id = ?`).run(episodeId);
      db.prepare(`DELETE FROM episodes WHERE id = ?`).run(episodeId);
      const eph = [...eventIdOf.values()].map(() => "?").join(",");
      if (eph) db.prepare(`DELETE FROM events WHERE id IN (${eph})`).run(...eventIdOf.values());
      db.prepare(`DELETE FROM tone_profiles WHERE stream_id IN (SELECT id FROM streams WHERE external_key LIKE ?)`).run(`${prefix}%`);
      db.prepare(`DELETE FROM streams WHERE external_key LIKE ?`).run(`${prefix}%`);
      for (const eid of entityIds) {
        db.prepare(`DELETE FROM tone_profiles WHERE person_entity_id = ?`).run(eid);
        db.prepare(`DELETE FROM entity_identities WHERE entity_id = ?`).run(eid);
        db.prepare(`DELETE FROM entities WHERE id = ?`).run(eid);
      }
      db.prepare(`DELETE FROM entities WHERE provisional = 1 AND id IN (SELECT target_id FROM decisions WHERE pass = 'extract' AND target_kind = 'entity')`).run();
      db.prepare(`DELETE FROM decisions WHERE pass = 'extract' AND target_kind = 'entity'`).run();
    });
    try {
      tx();
    } catch {
      /* a leftover row never fails the case */
    }
  };

  return { result, entityOf, knownOf, eventIdOf, episodeId, modelCalls: 0, cleanup };
}

const FIELD_NAMES = ["amount", "currency", "date", "status", "merchant", "order_id", "location", "duration_s"] as const;

/** Generic + per-case assertions over a finished run. */
export function assessClaims(run: ClaimsRun, expected: unknown): ExecutorResult {
  const db = getDb();
  const violations: Violation[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  const fail = (m: string): void => {
    failures.push(m);
  };
  const exp = rec(rec(expected).extract ?? expected);
  const written = run.result.written;
  const durable = written.filter((w) => w.kind !== "feeling");

  // ---- Generic: overwrite = 0 — every seeded claim keeps its row and text ----
  let overwrite = 0;
  for (const [alias, k] of run.knownOf) {
    const row = db.prepare(`SELECT text FROM claim_versions WHERE id = ?`).get(k.versionId) as { text: string } | undefined;
    if (!row || row.text !== k.text) {
      overwrite += 1;
      violations.push({ label: "overwrite", note: `${alias}: ${row ? "text changed" : "row gone"}` });
    }
  }

  // ---- Generic: every written claim's evidence resolves (the pass enforces) -
  const isActive = (versionId: string): boolean =>
    db.prepare(`SELECT 1 FROM claims_active WHERE id = ?`).get(versionId) !== undefined;

  // ---- expected.claims -------------------------------------------------------
  const wantClaims = Array.isArray(exp.claims) ? exp.claims.map(rec) : [];
  for (const w of wantClaims) {
    const subject = subjectIdFor(str(w.subject), run);
    const kind = str(w.kind);
    const contains = str(w.text_contains);
    const matches = durable.filter(
      (c) =>
        (kind === null || c.kind === kind) &&
        (w.subject === undefined || c.subjectId === subject) &&
        (contains === null || c.text.toLowerCase().includes(contains.toLowerCase())),
    );
    const label = `claim ${kind ?? "*"}/${str(w.subject) ?? "*"}/${contains ?? "*"}`;
    if (matches.length !== 1) {
      fail(`${label}: ${matches.length} written claims match`);
      if (matches.length === 0 && w.fields !== undefined) violations.push({ label: "prose-only", note: label });
      continue;
    }
    const c = matches[0]!;
    if (w.provenance !== undefined && c.provenance !== w.provenance) fail(`${label}: provenance ${c.provenance} ≠ ${String(w.provenance)}`);
    if (w.supersedes !== undefined) {
      const wantKey = w.supersedes === null ? null : run.knownOf.get(String(w.supersedes))?.claimKey ?? "?";
      if (c.supersedes !== wantKey) {
        fail(`${label}: supersedes ${c.supersedes} ≠ ${wantKey}`);
        if (wantKey !== null && c.coexistsWith === wantKey) violations.push({ label: "coexist", note: label });
        if (wantKey !== null && c.supersedes === null && c.coexistsWith === null) violations.push({ label: "tie", note: label });
      }
    }
    if (w.coexists_with !== undefined) {
      const wantKey = w.coexists_with === null ? null : run.knownOf.get(String(w.coexists_with))?.claimKey ?? "?";
      if (c.coexistsWith !== wantKey) fail(`${label}: coexists_with ${c.coexistsWith} ≠ ${wantKey}`);
    }
    if (typeof w.valid_from === "string" && !(c.validFrom ?? "").startsWith(w.valid_from)) fail(`${label}: valid_from ${c.validFrom} ≠ ${w.valid_from}`);
    if (w.fields !== undefined) {
      const want = rec(w.fields);
      const got = claimTypedFields(c.claimKey);
      if (!got) fail(`${label}: no claims header`);
      else {
        for (const name of FIELD_NAMES) {
          const wantV = name in want ? want[name] : null;
          const gotV = got[name];
          if (wantV !== gotV) {
            fail(`${label}: ${name} ${JSON.stringify(gotV)} ≠ ${JSON.stringify(wantV)}`);
            if (wantV !== null && gotV === null) violations.push({ label: "prose-only", note: `${label} ${name}` });
            if (wantV === null && gotV !== null && name === "amount") violations.push({ label: "midpoint-fill", note: label });
          }
        }
      }
    }
    if (w.active === true && !isActive(c.versionId)) fail(`${label}: not active`);
  }

  // ---- expected.ended / expected.active ----------------------------------------
  for (const raw of Array.isArray(exp.ended) ? exp.ended : []) {
    const e = rec(raw);
    const alias = str(e.id) ?? "";
    const k = run.knownOf.get(alias);
    if (!k) {
      fail(`ended ${alias}: no such seeded claim`);
      continue;
    }
    const row = db.prepare(`SELECT valid_to, closed_by, closed_reason FROM claim_versions WHERE id = ?`).get(k.versionId) as
      | { valid_to: string | null; closed_by: string | null; closed_reason: string | null }
      | undefined;
    if (!row) continue;
    if (row.closed_by === null) {
      fail(`ended ${alias}: still open`);
      violations.push({ label: "tie", note: alias });
    }
    if (typeof e.valid_to === "string" && !(row.valid_to ?? "").startsWith(e.valid_to)) fail(`ended ${alias}: valid_to ${row.valid_to} ≠ ${e.valid_to}`);
    if (e.linked === true && !(row.closed_reason ?? "").startsWith("superseded_by:")) fail(`ended ${alias}: not linked to its successor`);
    if (e.linked === true) {
      const successor = (row.closed_reason ?? "").slice("superseded_by:".length);
      const succ = db.prepare(`SELECT claim_key FROM claim_versions WHERE id = ?`).get(successor) as { claim_key: string } | undefined;
      if (!succ || succ.claim_key !== k.claimKey) fail(`ended ${alias}: successor is not on the same thread`);
    }
  }
  for (const [alias, want] of Object.entries(rec(exp.active))) {
    const k = run.knownOf.get(alias);
    if (!k) {
      fail(`active ${alias}: no such seeded claim`);
      continue;
    }
    if (isActive(k.versionId) !== Boolean(want)) fail(`active ${alias}: ${isActive(k.versionId)} ≠ ${String(want)}`);
  }

  // ---- expected.no_claims / no_claim_kinds / counts --------------------------------
  for (const raw of Array.isArray(exp.no_claims) ? exp.no_claims : []) {
    const n = rec(raw);
    const subject = n.subject === undefined ? undefined : subjectIdFor(str(n.subject), run);
    const kinds = Array.isArray(n.kinds) ? n.kinds.filter((x): x is string => typeof x === "string") : str(n.kind) ? [str(n.kind)!] : [];
    const re = str(n.text_matches) ? new RegExp(str(n.text_matches)!, "i") : null;
    const hits = written.filter(
      (c) => (subject === undefined || c.subjectId === subject) && (kinds.length === 0 || kinds.includes(c.kind)) && (re === null || re.test(c.text)),
    );
    if (hits.length > 0) {
      fail(`no_claims ${str(n.label) ?? ""}: ${hits.map((h) => h.text).join(" | ")}`);
      violations.push({ label: str(n.label) ?? "forbidden-claim", note: hits.map((h) => h.text).join(" | ") });
    }
  }
  const counts: Array<[string, number | undefined, number]> = [
    ["claims_total", typeof exp.claims_total === "number" ? exp.claims_total : undefined, durable.length],
    ["feelings_total", typeof exp.feelings_total === "number" ? exp.feelings_total : undefined, run.result.applied.feelings],
    ["tone_total", typeof exp.tone_total === "number" ? exp.tone_total : undefined, run.result.applied.toneProfiles],
    ["people_total", typeof exp.people_total === "number" ? exp.people_total : undefined, run.result.applied.provisionalPeople],
    ["superseded", typeof exp.superseded === "number" ? exp.superseded : undefined, run.result.applied.superseded],
    ["coexisting", typeof exp.coexisting === "number" ? exp.coexisting : undefined, run.result.applied.coexisting],
  ];
  for (const [name, want, got] of counts) if (want !== undefined && got !== want) fail(`${name} ${got} ≠ ${want}`);
  for (const sub of Array.isArray(exp.skipped_reasons_contain) ? exp.skipped_reasons_contain : []) {
    if (typeof sub === "string" && !run.result.skipped.some((s) => s.reason.toLowerCase().includes(sub.toLowerCase()))) {
      fail(`no skip reason contains "${sub}" (got ${run.result.skipped.map((s) => s.reason).join(" | ") || "none"})`);
    }
  }
  if (run.result.status !== "ok" && run.result.status !== "repaired") fail(`pass status ${run.result.status}: ${run.result.error?.message ?? ""}`);

  notes.push(
    `${durable.length} claims · ${run.result.applied.superseded} superseded · ${run.result.applied.coexisting} coexisting · ` +
      `${run.result.applied.feelings} feelings · ${run.result.applied.toneProfiles} tone · dropped fields ${run.result.applied.typedFieldsDropped} · ` +
      `skipped ${run.result.skipped.length} · known ${run.result.known.length}`,
  );
  if (failures.length > 0) notes.push(...failures.map((f) => `FAIL ${f}`));
  return {
    ok: failures.length === 0 && violations.length === 0,
    output: {
      status: run.result.status,
      known: run.result.known.length,
      written: written.map((w) => ({
        kind: w.kind,
        subject: w.subjectId === SELF_ENTITY_ID ? "self" : w.subjectId ?? `unknown(${w.subjectHint ?? "?"})`,
        text: w.text,
        provenance: w.provenance,
        supersedes: w.supersedes,
        coexists_with: w.coexistsWith,
        valid_from: w.validFrom,
        fields: w.fields,
      })),
      skipped: run.result.skipped.map((s) => ({ section: s.section, reason: s.reason })),
      applied: run.result.applied,
    },
    violations,
    metrics: {
      overwrite,
      typed_fields_dropped: run.result.applied.typedFieldsDropped,
      evidence_rejected: run.result.applied.evidenceRejected,
      model_calls: run.modelCalls,
    },
    notes,
  };
}

/** The executor registered for pass `claims` (FACT-01..06, TYP-01..03). */
export const claimsExecutor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const run = await runClaimsCase(fixture.id, fixture.setup, fixture.input_events);
  try {
    return assessClaims(run, fixture.expected);
  } finally {
    run.cleanup();
  }
};

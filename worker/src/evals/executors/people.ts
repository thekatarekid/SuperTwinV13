// ===========================================================================
// [CODE] ROL · CIR · CRM — people, circles and the personal CRM (S5.4).
//
// Zero model calls. Every case drives the REAL people code on the sandboxed
// eval DB and reads the result back:
//
//   ROL (pass `orient+extract`)  the resolution ladder, rung by rung —
//        01 @mention receiver, no task theft, closure from roles
//        02 an unaddressed group message reaches the whole audience
//        03 mentioned receiver vs third party, decided by a code set test
//        04 a pronoun chain across speakers resolves to one antecedent
//        05 two candidates → unknown + a queued question, never a coin flip
//        06 a generic address term carries ZERO addressee evidence
//        07 a discriminating one, learned from the record, decides
//        08 the reply marker beats recency
//        09 a mention mints a provisional person, hint ≠ claim
//        10 a later confirmation writes a NEW row; the 0.65 is kept
//
//   CIR (pass `circles`)  inference from content · tone · claims · metadata,
//        with reply volume worth at most a tenth of a circle; applicability;
//        and the user's drag, which code never overwrites.
//
//   CRM (pass `crm`)  the follow-up radar, provisional merge-forward, address
//        terms, and the priority order a quiet family group wins.
//
// The baseline had no executor for `orient+extract` at all — ROL read
// `pending` for ten cases. This is that executor.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { putIdentity } from "../../entities/identities.js";
import { createEntity, circleOf, listEntities, mergedAliasIds, resolveEntityId, setCircle } from "../../entities/registry.js";
import {
  addressTermsForScope,
  answersWithCompletion,
  applicability,
  buildPersonCard,
  candidatesForName,
  classifyAddressTerm,
  circlePriority,
  computeRadar,
  confirmsReceiver,
  DATE_DEFAULTS,
  inferCircle,
  inferCirclesForUnassigned,
  mergeForwardOnIdentifier,
  mintProvisionalPerson,
  observeAddressTerm,
  rankByPriority,
  recordPronounQuestion,
  recordResolution,
  resolutionHistory,
  resolvePronoun,
  resolveRoles,
  reviseResolution,
  serviceRecurrenceHint,
  unknownNameMentions,
  type ContextOwner,
  type ResolveContext,
  type RoleMessage,
  type RoleResolution,
  type RosterPerson,
} from "../../people/index.js";
import { applyCorrectionRequest, type CorrectionParser } from "../../server/corrections-routes.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

// ---- fixture readers -------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)) : [];
}
function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
}

function roster(setup: Record<string, unknown>): RosterPerson[] {
  return list(setup.roster).map((p) => ({
    id: str(p.id),
    name: str(p.name),
    aliases: strings(p.aliases),
    pronoun: p.pronoun === "she" || p.pronoun === "he" ? p.pronoun : null,
  }));
}

function ctxOf(setup: Record<string, unknown>, over: Partial<ResolveContext> = {}): ResolveContext {
  const s = rec(setup.stream);
  return {
    roster: roster(setup),
    stream: { key: str(s.key, "stream@g.us"), audience: strings(s.audience), isGroup: bool(s.is_group, true) },
    ...over,
  };
}

function messages(fixture: Fixture): RoleMessage[] {
  return list(fixture.input_events).map((e) => ({
    id: str(e.id),
    sender: str(e.sender),
    text: str(e.text),
    ts: typeof e.ts === "string" ? e.ts : undefined,
    ...(typeof e.reply_to === "string" ? { replyTo: e.reply_to } : {}),
    ...(Array.isArray(e.mentions) ? { mentions: strings(e.mentions) } : {}),
  }));
}

function contextOwners(setup: Record<string, unknown>): ContextOwner[] {
  return list(setup.context_owners).map((c) => ({
    keywords: strings(c.keywords),
    owner: str(c.owner),
    source: str(c.source),
  }));
}

/** The shape the report shows for one verdict — small enough to read at a glance. */
function view(r: RoleResolution): Record<string, unknown> {
  return {
    message: r.messageId,
    receiver: r.receiver,
    mentioned_receivers: r.mentionedReceivers,
    third_parties: r.thirdParties,
    status: r.status,
    rung: r.rung,
    basis: r.basis,
    confidence: r.confidence,
    bound_to: r.boundTo ?? null,
    address_terms: r.addressTerms,
    question: r.question ?? null,
  };
}

// ---- the case world --------------------------------------------------------

const EVAL_SOURCE = "src_eval_people";

/**
 * Rows a case writes, removed afterwards. Streams and entities are minted
 * with case-scoped ids so two cases never collide.
 */
class PeopleWorld {
  readonly entities: string[] = [];
  readonly streams: string[] = [];
  readonly startedAt = new Date(Date.now() - 1_000).toISOString();
  private sourceMade = false;

  constructor(readonly caseId: string) {}

  private ensureSource(): void {
    if (this.sourceMade) return;
    getDb()
      .prepare(`INSERT OR IGNORE INTO sources (id, type, display_name) VALUES (?, 'whatsapp', 'eval')`)
      .run(EVAL_SOURCE);
    this.sourceMade = true;
  }

  stream(key: string, label: string, kind = "group"): string {
    this.ensureSource();
    const id = `str_${this.caseId.toLowerCase().replace(/-/g, "")}_${key.replace(/[^a-z0-9]/gi, "")}`;
    getDb()
      .prepare(`INSERT OR IGNORE INTO streams (id, source_id, external_key, label, stream_kind) VALUES (?, ?, ?, ?, ?)`)
      .run(id, EVAL_SOURCE, key, label, kind);
    this.streams.push(id);
    return id;
  }

  person(name: string, opts: { circle?: string | null; provisional?: boolean; id?: string } = {}): string {
    const row = createEntity({
      type: "person",
      canonical: name,
      provisional: opts.provisional ?? false,
      ...(opts.id ? { id: opts.id } : {}),
    });
    this.entities.push(row.id);
    if (opts.circle) setCircle(row.id, opts.circle as never, { decidedBy: "code:circles", reason: "eval setup" });
    return row.id;
  }

  event(row: { id: string; streamId: string; streamKey: string; ts: string; text: string; actor: string; actorEntityId?: string | null; audience?: number }): void {
    this.ensureSource();
    getDb()
      .prepare(
        `INSERT INTO events (id, source_id, stream_id, ts, tz, kind, text, is_self, enrichment_state,
                             actor_entity_id, ingested_at, stream_key, actor, roles_json, origin)
         VALUES (?, ?, ?, ?, 'Asia/Kolkata', 'wa.message', ?, ?, 'none', ?, ?, ?, ?, ?, 'live')`,
      )
      .run(
        `${this.caseId}_${row.id}`,
        EVAL_SOURCE,
        row.streamId,
        row.ts,
        row.text,
        row.actor === "self" ? 1 : 0,
        row.actorEntityId ?? null,
        this.startedAt,
        row.streamKey,
        row.actor,
        row.audience ? JSON.stringify({ audience: Array.from({ length: row.audience }, (_, i) => `m${i}`) }) : null,
      );
  }

  /** Seed address-term memory the way the record would have accumulated it. */
  observe(o: { term: string; streamKey: string; addressee: string; times: number }): void {
    for (let i = 0; i < o.times; i += 1) {
      observeAddressTerm({ term: o.term, streamKey: o.streamKey, addresseeId: o.addressee, decidedBy: "eval" });
    }
  }

  cleanup(): void {
    const db = getDb();
    db.prepare(`DELETE FROM events WHERE id LIKE ?`).run(`${this.caseId}\\_%`.replace("\\", ""));
    db.prepare(`DELETE FROM events WHERE source_id = ? AND ingested_at >= ?`).run(EVAL_SOURCE, this.startedAt);
    for (const s of this.streams) {
      db.prepare(`DELETE FROM tone_profiles WHERE stream_id = ?`).run(s);
      db.prepare(`DELETE FROM streams WHERE id = ?`).run(s);
    }
    for (const e of this.entities) {
      db.prepare(`DELETE FROM tone_profiles WHERE person_entity_id = ?`).run(e);
      db.prepare(`DELETE FROM person_prefs WHERE person_entity_id = ?`).run(e);
      db.prepare(`DELETE FROM claim_versions WHERE claim_key IN (SELECT claim_key FROM claims WHERE subject_id = ?)`).run(e);
      db.prepare(`DELETE FROM claims WHERE subject_id = ?`).run(e);
      db.prepare(`DELETE FROM entity_identities WHERE entity_id = ?`).run(e);
      db.prepare(`DELETE FROM entities WHERE id = ? OR merged_into = ?`).run(e, e);
    }
    db.prepare(`DELETE FROM entities WHERE provisional = 1 AND created_at >= ?`).run(this.startedAt);
    db.prepare(`DELETE FROM role_resolutions WHERE created_at >= ?`).run(this.startedAt);
    db.prepare(`DELETE FROM questions WHERE asked_at >= ? AND kind IN ('roles','pronoun','identity')`).run(this.startedAt);
    db.prepare(`DELETE FROM corrections WHERE id IN (SELECT id FROM corrections WHERE target_kind = 'person')`).run();
    db.prepare(`DELETE FROM resolution_decisions WHERE id IN (SELECT id FROM resolution_decisions)`).run();
    db.prepare(`DELETE FROM mutations WHERE ts >= ?`).run(this.startedAt);
    db.prepare(`DELETE FROM decisions WHERE created_at >= ? AND target_kind IN ('entity','person','tone_profile')`).run(this.startedAt);
    db.prepare(`DELETE FROM sources WHERE id = ?`).run(EVAL_SOURCE);
  }
}

function ok(output: Record<string, unknown>, violations: Violation[], metrics: Record<string, number> = {}): ExecutorResult {
  return { ok: violations.length === 0, output, violations, metrics: { model_calls: 0, ...metrics } };
}

// ---- ROL -------------------------------------------------------------------

function rol01(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const ctx = ctxOf(setup);
  const msgs = messages(fixture);
  const violations: Violation[] = [];
  const byId = new Map<string, RoleResolution>();
  const prior: RoleMessage[] = [];
  for (const m of msgs) {
    byId.set(m.id, resolveRoles(m, { ...ctx, prior: [...prior] }));
    prior.push(m);
  }
  const expected = rec(rec(fixture.expected).roles);
  for (const [id, want] of Object.entries(expected)) {
    const got = byId.get(id);
    const wantRec = rec(want);
    if (!got) {
      violations.push({ label: "receiver-blur", note: `no verdict for ${id}` });
      continue;
    }
    if (!sameSet(got.receiver, strings(wantRec.receiver))) {
      violations.push({ label: "receiver-blur", note: `${id} receiver ${got.receiver.join(",")} — expected ${strings(wantRec.receiver).join(",")}` });
    }
    if (wantRec.rung && got.rung !== str(wantRec.rung)) {
      violations.push({ label: "receiver-blur", note: `${id} decided on rung ${got.rung}, expected ${str(wantRec.rung)}` });
    }
    if (wantRec.basis_contains && !got.basis.includes(str(wantRec.basis_contains))) {
      violations.push({ label: "receiver-blur", note: `${id} basis "${got.basis}" does not state ${str(wantRec.basis_contains)}` });
    }
  }
  // Task theft: the imperative in e1 was addressed to Karan. Self must not own it.
  const e1 = byId.get("e1")!;
  if (e1.receiver.includes("self")) violations.push({ label: "task-theft", note: "e1's receiver includes self" });
  if (e1.receiver.length > 1) violations.push({ label: "receiver-blur", note: "e1 addressed to more than one person" });

  // Closure from roles: e3 was asked of self; e4 is self answering "done".
  const closureSpec = rec(rec(fixture.expected).closure);
  const q = byId.get(str(closureSpec.question, "e3"))!;
  const a = msgs.find((m) => m.id === str(closureSpec.answer, "e4"))!;
  const closure = answersWithCompletion({ resolution: q }, a);
  if (closure.closes !== bool(closureSpec.closes, true)) {
    violations.push({ label: "task-theft", note: `closure verdict ${closure.closes}: ${closure.why}` });
  }
  return ok(
    { roles: [...byId.values()].map(view), closure },
    violations,
    { resolutions: byId.size, model_rungs_used: [...byId.values()].filter((r) => r.rung === "model").length },
  );
}

function rol02(fixture: Fixture): ExecutorResult {
  const ctx = ctxOf(rec(fixture.setup));
  const m = messages(fixture)[0]!;
  const r = resolveRoles(m, ctx);
  const want = rec(rec(rec(fixture.expected).roles).e1);
  const violations: Violation[] = [];
  if (r.receiver.length <= 1) violations.push({ label: "phantom-addressee", note: `receiver ${r.receiver.join(",") || "(none)"} on a broadcast` });
  if (!sameSet(r.receiver, strings(want.receiver))) {
    violations.push({ label: "phantom-addressee", note: `receiver ${r.receiver.join(",")}, expected the whole audience` });
  }
  if (r.rung !== str(want.rung, "broadcast") || r.status !== "resolved") {
    violations.push({ label: "phantom-addressee", note: `rung ${r.rung}, status ${r.status}` });
  }
  return ok({ roles: [view(r)] }, violations);
}

function rol03(fixture: Fixture): ExecutorResult {
  const ctx = ctxOf(rec(fixture.setup));
  const m = messages(fixture)[0]!;
  const r = resolveRoles(m, ctx);
  const want = rec(rec(rec(fixture.expected).roles).e1);
  const violations: Violation[] = [];
  if (!sameSet(r.receiver, strings(want.receiver))) violations.push({ label: "membership-guess", note: `receiver ${r.receiver.join(",")}` });
  if (!sameSet(r.thirdParties, strings(want.third_parties))) {
    violations.push({ label: "third-party-task", note: `third parties ${r.thirdParties.join(",") || "(none)"}` });
  }
  for (const tp of r.thirdParties) {
    if (r.receiver.includes(tp)) violations.push({ label: "third-party-task", note: `${tp} is both a third party and a receiver` });
    if (ctx.stream.audience.includes(tp)) violations.push({ label: "membership-guess", note: `${tp} is in the audience yet filed as a third party` });
  }
  if (r.rung === "model") violations.push({ label: "membership-guess", note: "the model decided membership" });
  return ok({ roles: [view(r)], decided_by: "code set-membership" }, violations, { model_rungs_used: r.rung === "model" ? 1 : 0 });
}

function rol04(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const ctx = ctxOf(setup);
  const msgs = messages(fixture);
  const violations: Violation[] = [];
  const out: Record<string, unknown> = {};
  const expected = rec(rec(fixture.expected).pronouns);
  for (const [id, want] of Object.entries(expected)) {
    const idx = msgs.findIndex((m) => m.id === id);
    const r = resolvePronoun(msgs[idx]!, { ...ctx, prior: msgs.slice(0, idx) });
    out[id] = r;
    const wantRec = rec(want);
    if (!r) {
      violations.push({ label: "unknown-overuse", note: `${id} carried no pronoun` });
      continue;
    }
    if (r.status !== str(wantRec.status, "resolved")) violations.push({ label: "unknown-overuse", note: `${id} status ${r.status}` });
    if (r.subject !== str(wantRec.subject)) violations.push({ label: "pronoun-drift", note: `${id} → ${r.subject ?? "unknown"}, expected ${str(wantRec.subject)}` });
    if (wantRec.min_confidence !== undefined && r.confidence < num(wantRec.min_confidence, 0.8)) {
      violations.push({ label: "unknown-overuse", note: `${id} confidence ${r.confidence}` });
    }
  }
  return ok({ pronouns: out, claim_subject: str(rec(fixture.expected).claim_subject) }, violations);
}

function rol05(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const ctx = ctxOf(setup);
  const msgs = messages(fixture);
  const last = msgs[msgs.length - 1]!;
  const r = resolvePronoun(last, { ...ctx, prior: msgs.slice(0, -1) });
  const violations: Violation[] = [];
  const want = rec(rec(rec(fixture.expected).pronouns).e3);
  if (!r || r.status !== "unknown" || r.subject !== null) {
    violations.push({ label: "coin-flip-pronoun", note: `subject ${r?.subject ?? "(no pronoun found)"}` });
  }
  if (r && !sameSet(r.hint, strings(want.hint))) {
    violations.push({ label: "coin-flip-pronoun", note: `hint ${r.hint.join("|")}, expected ${strings(want.hint).join("|")}` });
  }
  const questionId = r ? recordPronounQuestion(last.id, r) : null;
  if (!questionId) violations.push({ label: "coin-flip-pronoun", note: "no question queued for the ambiguity" });
  const claims = count(`SELECT COUNT(*) AS n FROM claims WHERE created_at >= ?`, world.startedAt);
  if (claims !== 0) violations.push({ label: "coin-flip-pronoun", note: `${claims} claim(s) attributed on an unknown subject` });
  const row = questionId
    ? (getDb().prepare(`SELECT kind, status, question, options_json FROM questions WHERE id = ?`).get(questionId) as Record<string, unknown>)
    : null;
  return ok({ pronoun: r, question: row, claims_written: claims }, violations, { questions: questionId ? 1 : 0 });
}

function rol06(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const streamKey = str(rec(setup.stream).key);
  world.stream(streamKey, str(rec(setup.stream).label, "group"));
  for (const s of list(setup.other_streams)) world.stream(str(s.key), str(s.label, "group"));
  for (const o of list(setup.address_memory)) {
    world.observe({ term: str(o.term), streamKey: str(o.stream_key), addressee: str(o.addressee), times: num(o.times, 1) });
  }
  const violations: Violation[] = [];
  const cls = classifyAddressTerm("bro", streamKey);
  const wantTerm = rec(rec(fixture.expected).address_term);
  if (cls.class !== str(wantTerm.class, "generic") || cls.mapsTo !== null) {
    violations.push({ label: "nickname-lock", note: `"bro" classified ${cls.class} → ${cls.mapsTo ?? "nobody"}` });
  }

  const m = messages(fixture)[0]!;
  const withContext = resolveRoles(m, ctxOf(setup, { contextOwners: contextOwners(setup) }));
  const wantWith = rec(rec(fixture.expected).with_context);
  if (!sameSet(withContext.receiver, strings(wantWith.receiver)) || withContext.rung !== str(wantWith.rung, "context")) {
    violations.push({ label: "nickname-lock", note: `with context: ${withContext.rung} → ${withContext.receiver.join(",") || "unknown"}` });
  }
  if (!withContext.basis.includes(str(wantWith.basis_contains, "ep_"))) {
    violations.push({ label: "nickname-lock", note: `basis does not cite the open item: ${withContext.basis}` });
  }
  const withoutContext = resolveRoles(m, ctxOf(setup));
  if (withoutContext.status !== "unknown" || !withoutContext.question) {
    violations.push({ label: "nickname-lock", note: `with no context the ladder still answered: ${withoutContext.receiver.join(",")}` });
  }
  const kinship = count(
    `SELECT COUNT(*) AS n FROM claim_versions v JOIN claims c ON c.claim_key = v.claim_key
      WHERE c.kind = 'relationship' AND c.created_at >= ? AND LOWER(COALESCE(v.text,'')) LIKE '%brother%'`,
    world.startedAt,
  );
  if (kinship !== 0) violations.push({ label: "literal-kinship", note: `${kinship} "brother" relationship claim(s)` });
  return ok(
    {
      address_term: cls,
      with_context: view(withContext),
      without_context: view(withoutContext),
      relationship_claims_written: count(`SELECT COUNT(*) AS n FROM claims WHERE kind = 'relationship' AND created_at >= ?`, world.startedAt),
    },
    violations,
  );
}

function rol07(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const s = rec(setup.stream);
  world.stream(str(s.key), str(s.label, "group"));
  for (const o of list(setup.address_memory)) {
    world.observe({ term: str(o.term), streamKey: str(o.stream_key), addressee: str(o.addressee), times: num(o.times, 1) });
  }
  const violations: Violation[] = [];
  const cls = classifyAddressTerm("boss", str(s.key));
  const wantTerm = rec(rec(fixture.expected).address_term);
  if (cls.class !== str(wantTerm.class, "discriminating") || cls.mapsTo !== str(wantTerm.maps_to)) {
    violations.push({ label: "style-amnesia", note: `"boss" classified ${cls.class} → ${cls.mapsTo ?? "nobody"} after ${cls.observationsHere} observations` });
  }
  // No injected memory: the ladder must read the record itself.
  const r = resolveRoles(messages(fixture)[0]!, ctxOf(setup));
  const want = rec(rec(rec(fixture.expected).roles).e1);
  if (!sameSet(r.receiver, strings(want.receiver)) || r.rung !== str(want.rung, "address_term")) {
    violations.push({ label: "style-amnesia", note: `${r.rung} → ${r.receiver.join(",") || "unknown"}` });
  }
  if (!r.basis.includes(str(want.basis_contains, "address-style memory"))) {
    violations.push({ label: "style-amnesia", note: `basis does not name the memory: ${r.basis}` });
  }
  return ok({ address_term: cls, roles: [view(r)], scope_terms: addressTermsForScope({ streamKey: str(s.key) }) }, violations);
}

function rol08(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const msgs = messages(fixture);
  const last = msgs[msgs.length - 1]!;
  const r = resolveRoles(last, ctxOf(setup, { prior: msgs.slice(0, -1) }));
  const want = rec(rec(rec(fixture.expected).roles).e12);
  const violations: Violation[] = [];
  if (r.boundTo !== str(want.bound_to, "e11")) violations.push({ label: "nearest-question", note: `bound to ${r.boundTo ?? "nothing"}` });
  if (!sameSet(r.receiver, strings(want.receiver))) violations.push({ label: "nearest-question", note: `receiver ${r.receiver.join(",")}` });
  if (r.rung !== str(want.rung, "reply")) violations.push({ label: "nearest-question", note: `rung ${r.rung}` });
  return ok({ roles: [view(r)] }, violations);
}

function rol09(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const ctx = ctxOf(setup);
  const msgs = messages(fixture);
  const mention = msgs[0]!;
  const violations: Violation[] = [];
  const found = unknownNameMentions(mention.text, ctx.roster);
  if (found.length === 0) {
    return ok({ mentions: [] }, [{ label: "mention-drop", note: "the name was never seen as a person mention" }]);
  }
  const minted = mintProvisionalPerson({
    name: found[0]!.name,
    mentionedBy: mention.sender,
    streamKey: ctx.stream.key,
    phrases: [found[0]!.phrase],
    eventIds: [mention.id],
    relationshipHint: { relation: "child_of", of: mention.sender, confidence: 0.6 },
  });
  world.entities.push(minted.entity.id);
  const want = rec(rec(fixture.expected).provisional_person);
  if (!minted.created || !minted.entity.provisional) violations.push({ label: "mention-drop", note: "no provisional person created" });
  const identifiers = (getDb().prepare(`SELECT kind FROM entity_identities WHERE entity_id = ?`).all(minted.entity.id) as { kind: string }[]).filter(
    (i) => i.kind !== "alias",
  );
  if (identifiers.length !== num(want.identifiers, 0)) {
    violations.push({ label: "relationship-overclaim", note: `${identifiers.length} identifier(s) invented` });
  }
  const decision = getDb()
    .prepare(`SELECT reason, confidence FROM decisions WHERE target_id = ? AND action = 'create' ORDER BY created_at DESC LIMIT 1`)
    .get(minted.entity.id) as { reason: string | null; confidence: number | null } | undefined;
  if ((decision?.confidence ?? 1) >= 1) {
    violations.push({ label: "relationship-overclaim", note: `the relationship hint is stated at confidence ${decision?.confidence}` });
  }
  const claims = count(`SELECT COUNT(*) AS n FROM claims WHERE subject_id = ? AND kind = 'relationship'`, minted.entity.id);
  if (claims !== 0) violations.push({ label: "relationship-overclaim", note: `${claims} relationship claim(s) written by the mention alone` });

  // "he" → the provisional person: the antecedent search sees them as a person.
  const pronoun = resolvePronoun(msgs[1]!, { ...ctx, prior: [mention] }, [{ id: minted.entity.id, name: minted.entity.canonical ?? "" }]);
  if (!pronoun || pronoun.subject !== minted.entity.id) {
    violations.push({ label: "mention-drop", note: `"he" resolved to ${pronoun?.subject ?? "nobody"}` });
  }
  const visible = listEntities({ type: "person" }).some((e) => e.id === minted.entity.id);
  if (!visible && bool(rec(fixture.expected).visible_in_people, true)) {
    violations.push({ label: "mention-drop", note: "the person is not on the People list" });
  }
  const card = buildPersonCard(minted.entity.id, new Date("2026-09-06T05:30:00.000Z"));
  const anchors = JSON.stringify(card?.howIKnow ?? []);
  for (const needle of strings(want.anchors_contain)) {
    if (!anchors.includes(needle)) violations.push({ label: "mention-drop", note: `anchors do not record ${needle}` });
  }
  return ok(
    {
      mention: found[0],
      person: { id: minted.entity.id, name: minted.entity.canonical, provisional: minted.entity.provisional },
      hint_reason: decision?.reason ?? null,
      hint_confidence: decision?.confidence ?? null,
      pronoun,
      visible_in_people: visible,
      how_i_know: card?.howIKnow ?? [],
      relationship_claims_written: claims,
    },
    violations,
  );
}

function rol10(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const prior = rec(setup.prior_resolution);
  const s = rec(setup.stream);
  const violations: Violation[] = [];
  const eventId = str(prior.event_id, "e_court");
  const first = recordResolution({
    resolution: {
      messageId: eventId,
      sender: "self",
      audience: strings(s.audience),
      receiver: strings(prior.receiver),
      mentionedReceivers: [],
      thirdParties: [],
      status: "resolved",
      rung: "context",
      basis: str(prior.basis),
      confidence: num(prior.confidence, 0.65),
      addressTerms: [],
    },
    streamKey: str(s.key),
    evidence: [{ event_ids: [eventId], quote: "book the court" }],
  });

  const later = messages(fixture)[0]!;
  const verdict = confirmsReceiver({ receiver: strings(prior.receiver), subjectKeywords: strings(prior.subject_keywords) }, later);
  const wantRev = rec(rec(fixture.expected).revision);
  if (!verdict.confirms) {
    violations.push({ label: "frozen-decision", note: `the later message was not read as confirmation: ${verdict.why}` });
  }
  const revised = verdict.confirms
    ? reviseResolution({
        resolutionId: first.id,
        receiver: strings(prior.receiver),
        confidence: 0.95,
        basis: verdict.why,
        evidence: [{ event_ids: [later.id], quote: later.text }],
      })
    : null;
  const history = resolutionHistory(eventId);
  if (history.length !== num(wantRev.history_length, 2)) {
    violations.push({ label: "frozen-decision", note: `${history.length} row(s) in the history` });
  }
  const old = history[0];
  if (!old || old.confidence !== num(prior.confidence, 0.65) || old.status !== "revised") {
    violations.push({ label: "frozen-decision", note: `the 0.65 row is now ${old?.confidence} / ${old?.status}` });
  }
  if (!revised || revised.confidence < num(rec(wantRev.new).min_confidence, 0.9) || revised.revisedFrom !== first.id) {
    violations.push({ label: "frozen-decision", note: `revision ${revised?.confidence ?? "none"} from ${revised?.revisedFrom ?? "nothing"}` });
  }
  if (revised && revised.evidence.length < 2) violations.push({ label: "frozen-decision", note: "evidence was replaced, not appended" });
  return ok(
    {
      history: history.map((h) => ({ id: h.id, confidence: h.confidence, status: h.status, revised_from: h.revisedFrom, evidence: h.evidence.length })),
      closure: verdict,
    },
    violations,
    { resolutions: history.length },
  );
}

export const rolesExecutor: Executor = async (ctx) => {
  const world = new PeopleWorld(ctx.fixture.id);
  try {
    switch (ctx.fixture.id) {
      case "ROL-01":
        return rol01(ctx.fixture);
      case "ROL-02":
        return rol02(ctx.fixture);
      case "ROL-03":
        return rol03(ctx.fixture);
      case "ROL-04":
        return rol04(ctx.fixture);
      case "ROL-05":
        return rol05(ctx.fixture, world);
      case "ROL-06":
        return rol06(ctx.fixture, world);
      case "ROL-07":
        return rol07(ctx.fixture, world);
      case "ROL-08":
        return rol08(ctx.fixture);
      case "ROL-09":
        return rol09(ctx.fixture, world);
      case "ROL-10":
        return rol10(ctx.fixture);
      default:
        return { ok: false, output: { error: `no role case for ${ctx.fixture.id}` }, violations: [], metrics: { model_calls: 0 } };
    }
  } finally {
    world.cleanup();
  }
};

// ---- CIR -------------------------------------------------------------------

function cir01(fixture: Fixture): ExecutorResult {
  const streams = list(rec(fixture.setup).streams);
  const violations: Violation[] = [];
  const inferred = streams.map((s) => ({
    id: str(s.id),
    inference: inferCircle({
      groupLabel: str(s.label),
      contactName: typeof s.contact_name === "string" ? s.contact_name : null,
      isGroup: bool(s.is_group, true),
      memberCount: num(s.member_count, 0),
      userReplyCount: num(s.user_reply_count, 0),
      sampleTexts: strings(s.sample_texts),
    }),
    replies: num(s.user_reply_count, 0),
    urgency: num(s.content_urgency, 0),
  }));
  const want = rec(rec(fixture.expected).circles);
  for (const row of inferred) {
    const expect = want[row.id];
    const allowed = Array.isArray(expect) ? strings(expect) : [str(expect)];
    if (!row.inference.circle || !allowed.includes(row.inference.circle)) {
      violations.push({ label: "volume-equals-value", note: `${row.id} → ${row.inference.circle ?? "none"}, expected ${allowed.join("|")}` });
    }
  }
  const ranked = rankByPriority(inferred.map((r) => ({ id: r.id, circle: r.inference.circle, userReplyCount: r.replies, contentUrgency: r.urgency })));
  const order = ranked.map((r) => r.id);
  if (!strings(rec(fixture.expected).priority_order).every((id, i) => order[i] === id)) {
    violations.push({ label: "volume-equals-value", note: `priority order ${order.join(" > ")}` });
  }
  const families = rec(rec(fixture.expected).reason_families);
  for (const [id, want2] of Object.entries(families)) {
    const row = inferred.find((r) => r.id === id);
    for (const fam of strings(want2)) {
      if (!row?.inference.signals.includes(fam)) violations.push({ label: "volume-equals-value", note: `${id} never used the ${fam} signal` });
    }
  }
  return ok(
    {
      circles: inferred.map((r) => ({ id: r.id, circle: r.inference.circle, confidence: r.inference.confidence, signals: r.inference.signals, reasons: r.inference.reasons })),
      priority: ranked.map((r) => ({ id: r.id, score: r.score, explanation: r.explanation })),
    },
    violations,
  );
}

function cir02(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const texts = strings(setup.messages);
  const violations: Violation[] = [];
  const inference = inferCircle({
    contactName: null,
    isGroup: false,
    spanDays: num(setup.span_days, 180),
    theirMessageCount: texts.length,
    userReplyCount: 2,
    sampleTexts: texts,
  });
  if (inference.circle !== str(rec(fixture.expected).circle, "important_services")) {
    violations.push({ label: "sparse-equals-spam", note: `→ ${inference.circle ?? "none"}` });
  }
  if (!inference.reasons.join(" ").toLowerCase().includes(str(rec(fixture.expected).reason_contains, "service role"))) {
    violations.push({ label: "sparse-equals-spam", note: "the verdict does not state the service signal" });
  }
  const hint = serviceRecurrenceHint(texts);
  const wantHint = rec(rec(fixture.expected).recurrence_candidate);
  if (hint.candidate !== bool(wantHint.candidate, true) || hint.cadence !== str(wantHint.cadence, "monthly")) {
    violations.push({ label: "sparse-equals-spam", note: `recurrence hint ${hint.candidate} / ${hint.cadence ?? "none"}` });
  }
  return ok({ inference, recurrence_candidate: hint }, violations);
}

function cir03(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const people = roster(setup);
  const violations: Violation[] = [];
  const out: Record<string, unknown> = {};
  const want = rec(rec(fixture.expected).applicability);
  for (const s of list(setup.streams)) {
    const id = str(s.id);
    const audience = bool(s.is_group, true) ? [...people.map((p) => p.id)] : ["self", str(s.sender)];
    const resolution = resolveRoles(
      { id: `${id}_msg`, sender: str(s.sender), text: str(s.text) },
      { roster: people, stream: { key: str(s.key), audience, isGroup: bool(s.is_group, true) } },
    );
    const directAddress = resolution.rung === "named" || resolution.rung === "structural" || resolution.rung === "reply";
    const verdict = applicability({
      circle: str(s.circle) as never,
      isGroup: bool(s.is_group, true),
      memberCount: num(s.member_count, 0),
      userReplied: bool(s.user_replied, false),
      directAddress: directAddress && resolution.receiver.includes("self"),
    });
    out[id] = { roles: view(resolution), direct_address: directAddress && resolution.receiver.includes("self"), verdict: verdict.verdict, reason: verdict.reason };
    if (verdict.verdict !== str(want[id])) {
      violations.push({ label: "broadcast-task-spam", note: `${id} → ${verdict.verdict}, expected ${str(want[id])}` });
    }
    if (verdict.reason.trim() === "") violations.push({ label: "broadcast-task-spam", note: `${id} gave no reason` });
  }
  return ok({ streams: out }, violations);
}

/** A parser that never runs — the drag arrives structured, so no model is asked. */
const noParser: CorrectionParser = async () => {
  throw new Error("CIR-04 drives a structured correction; no parse should be attempted");
};

async function cir04(fixture: Fixture, world: PeopleWorld): Promise<ExecutorResult> {
  const setup = rec(fixture.setup);
  const person = rec(setup.person);
  const violations: Violation[] = [];
  const id = world.person(str(person.name, "Priya"));
  setCircle(id, str(person.inferred_circle, "friends") as never, { decidedBy: str(person.inferred_by, "code:circles"), reason: "inferred" });
  const before = circlePriority({ id, circle: circleOf(id), userReplyCount: 12, contentUrgency: num(rec(setup.next_day).content_urgency, 0.9) });

  const result = await applyCorrectionRequest(
    { target: { kind: "person", id }, structured: { type: "set_circle", circle: str(rec(setup.drag).to, "close_friends") } },
    noParser,
  );
  const body = rec(result.body);
  const wantCorrection = rec(rec(fixture.expected).correction);
  if (result.status !== 200 || str(body.status) !== str(wantCorrection.status, "applied")) {
    violations.push({ label: "edit-ignored", note: `correction status ${result.status} / ${str(body.status)}` });
  }
  if (bool(wantCorrection.logged, true) && !body.decision_id) violations.push({ label: "edit-ignored", note: "no decisions row" });
  if (bool(wantCorrection.eval_draft, true) && !body.eval_draft) violations.push({ label: "edit-ignored", note: "no eval case drafted" });

  const after = circleOf(id);
  if (after !== str(rec(fixture.expected).circle_after, "close_friends")) {
    violations.push({ label: "edit-ignored", note: `circle is ${after ?? "none"} after the drag` });
  }
  const downstream = rec(rec(fixture.expected).downstream);
  const afterPriority = circlePriority({ id, circle: after, userReplyCount: 12, contentUrgency: num(rec(setup.next_day).content_urgency, 0.9) });
  if (bool(downstream.priority_rises, true) && !(afterPriority.score > before.score)) {
    violations.push({ label: "edit-ignored", note: `priority ${before.score} → ${afterPriority.score}` });
  }
  const applies = applicability({ circle: after, isGroup: false, userReplied: true, directAddress: false });
  if (applies.verdict !== str(downstream.applicability, "task")) {
    violations.push({ label: "edit-ignored", note: `applicability ${applies.verdict}` });
  }
  const dates = after ? DATE_DEFAULTS[after] : null;
  if (!dates || dates.mode !== str(downstream.date_mode, "plan") || dates.leadDays !== num(downstream.date_lead_days, 7)) {
    violations.push({ label: "edit-ignored", note: `date policy ${dates?.mode ?? "none"} / ${dates?.leadDays ?? "-"}` });
  }
  // Code must not undo the user's drag on the next inference pass.
  setCircle(id, null, { decidedBy: "code:circles", reason: "force re-inference for the test" });
  const report = inferCirclesForUnassigned();
  const skipped = report.skipped.find((s) => s.id === id);
  if (bool(rec(fixture.expected).code_never_overwrites, true) && skipped?.why !== "user-set") {
    violations.push({ label: "edit-ignored", note: `re-inference did not respect the user's verdict (${skipped?.why ?? "assigned"})` });
  }
  return ok(
    {
      correction: { status: str(body.status), decision_id: body.decision_id ?? null, eval_draft: body.eval_draft ?? null, summary: str(body.summary) },
      circle_after: after,
      priority: { before: before.score, after: afterPriority.score, explanation: afterPriority.explanation },
      applicability: applies,
      dates,
      re_inference: skipped ?? null,
    },
    violations,
  );
}

export const circlesExecutor: Executor = async (ctx) => {
  const world = new PeopleWorld(ctx.fixture.id);
  try {
    switch (ctx.fixture.id) {
      case "CIR-01":
        return cir01(ctx.fixture);
      case "CIR-02":
        return cir02(ctx.fixture);
      case "CIR-03":
        return cir03(ctx.fixture);
      case "CIR-04":
        return await cir04(ctx.fixture, world);
      default:
        return { ok: false, output: { error: `no circle case for ${ctx.fixture.id}` }, violations: [], metrics: { model_calls: 0 } };
    }
  } finally {
    world.cleanup();
  }
};

// ---- CRM -------------------------------------------------------------------

function crm01(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const s = rec(setup.stream);
  const p = rec(setup.person);
  const violations: Violation[] = [];
  const streamId = world.stream(str(s.key), str(s.label, "DM"), "dm");
  const person = world.person(str(p.name, "Sameer"), { circle: str(p.circle, "coworkers") });
  const e = list(fixture.input_events)[0]!;
  world.event({ id: str(e.id), streamId, streamKey: str(s.key), ts: str(e.ts), text: str(e.text), actor: `contact:${str(e.sender)}`, actorEntityId: person });

  const now = new Date(str(setup.now, "2026-09-06T05:30:00.000Z"));
  const radar = computeRadar(now, { streamKeys: [str(s.key)] });
  const want = list(rec(fixture.expected).radar)[0]!;
  const entry = radar[0];
  if (!entry) {
    violations.push({ label: "radar-blind", note: "no owed-reply entry for an unanswered question" });
  } else {
    if (entry.direction !== str(want.direction, "i_owe")) violations.push({ label: "radar-blind", note: `direction ${entry.direction}` });
    if (entry.leadDays !== num(want.lead_days, 3)) violations.push({ label: "lead-time-ignored", note: `lead ${entry.leadDays} days` });
    if (entry.followUpAt.slice(0, 10) !== str(want.follow_up_on)) {
      violations.push({ label: "lead-time-ignored", note: `follow-up on ${entry.followUpAt.slice(0, 10)}, expected ${str(want.follow_up_on)}` });
    }
    if (entry.overdue !== bool(want.overdue, true)) violations.push({ label: "lead-time-ignored", note: `overdue ${entry.overdue}` });
  }
  const card = buildPersonCard(person, now);
  return ok(
    {
      radar: radar.map((r) => ({ direction: r.direction, person: r.personName, circle: r.circle, lead_days: r.leadDays, follow_up_at: r.followUpAt, overdue: r.overdue, age_days: r.ageDays })),
      card_radar: card?.radar.length ?? 0,
      lead_source: card?.radarLeadDays.source ?? null,
    },
    violations,
    { radar_entries: radar.length },
  );
}

function crm02(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const s = rec(setup.stream);
  const violations: Violation[] = [];
  const streamId = world.stream(str(s.key), str(s.label, "group"));
  const e = list(fixture.input_events)[0]!;
  world.event({
    id: str(e.id),
    streamId,
    streamKey: str(s.key),
    ts: str(e.ts),
    text: str(e.text),
    actor: `contact:${str(e.sender)}`,
    audience: num(s.member_count, 180),
  });
  const radar = computeRadar(new Date(str(setup.now, "2026-09-06T05:30:00.000Z")), { streamKeys: [str(s.key)] });
  if (radar.length !== 0) violations.push({ label: "broadcast-debt", note: `${radar.length} entry from a ${num(s.member_count, 180)}-member broadcast` });
  return ok({ radar, why: str(rec(fixture.expected).why) }, violations, { radar_entries: radar.length });
}

function crm03(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const idn = rec(setup.identifier);
  const violations: Violation[] = [];
  const mention = list(fixture.input_events)[0]!;
  const found = unknownNameMentions(str(mention.text), roster(setup));
  if (found.length === 0) {
    return ok({}, [{ label: "mention-drop", note: "the name was never seen as a person mention" }]);
  }
  const name = found[0]!.name;
  const provisional = mintProvisionalPerson({
    name,
    mentionedBy: str(mention.sender),
    streamKey: str(rec(setup.stream).key),
    phrases: [str(mention.text)],
    eventIds: [str(mention.id)],
  });
  world.entities.push(provisional.entity.id);
  const before = rec(rec(fixture.expected).before_identifier);
  if (candidatesForName(name, { provisionalOnly: true }).length !== num(before.people_named_vivaan, 1)) {
    violations.push({ label: "duplicate-person", note: "the record already holds more than one person by that name" });
  }

  // The identifier arrives: ingest files a person carrying the phone number.
  const identified = world.person(name, { provisional: true });
  putIdentity({ entityId: identified, sourceId: null, kind: str(idn.kind, "phone") as never, value: str(idn.value), decidedBy: "code:ingest" });
  const result = mergeForwardOnIdentifier({ identifiedEntityId: identified, name, kind: str(idn.kind, "phone") as never, value: str(idn.value) });
  const after = rec(rec(fixture.expected).after_identifier);
  if (result.outcome !== str(after.outcome, "merged")) violations.push({ label: "duplicate-person", note: `merge-forward outcome ${result.outcome}` });
  if (resolveEntityId(provisional.entity.id) !== identified) {
    violations.push({ label: "duplicate-person", note: "the mention-born person does not redirect to the identified one" });
  }
  const survivors = listEntities({ type: "person" }).filter((e) => (e.canonical ?? "").toLowerCase() === name.toLowerCase());
  if (survivors.length !== num(after.people_named_vivaan, 1)) {
    violations.push({ label: "duplicate-person", note: `${survivors.length} live people named ${name} after the merge` });
  }

  // Two candidates must ask, never merge.
  const a = world.person(name, { provisional: true });
  const b = world.person(name, { provisional: true });
  const other = world.person(name, { provisional: true });
  putIdentity({ entityId: other, sourceId: null, kind: "phone", value: "+919800000001", decidedBy: "code:ingest" });
  const ambiguous = mergeForwardOnIdentifier({ identifiedEntityId: other, name, kind: "phone", value: "+919800000001" });
  const wantAmb = rec(rec(fixture.expected).ambiguous_variant);
  if (ambiguous.outcome !== str(wantAmb.two_candidates, "queued")) {
    violations.push({ label: "duplicate-person", note: `ambiguous merge-forward ${ambiguous.outcome}, expected a question` });
  }
  if (resolveEntityId(a) !== a || resolveEntityId(b) !== b) {
    violations.push({ label: "duplicate-person", note: "an ambiguous identifier merged anyway" });
  }
  return ok(
    {
      provisional: { id: provisional.entity.id, name: provisional.entity.canonical, provisional: provisional.entity.provisional },
      merge_forward: { outcome: result.outcome, survivor: identified, aliases: mergedAliasIds(identified) },
      ambiguous: { outcome: ambiguous.outcome, candidates: ambiguous.candidates.length, question: ambiguous.questionId ?? null },
    },
    violations,
  );
}

function crm04(fixture: Fixture, world: PeopleWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const violations: Violation[] = [];
  for (const s of list(setup.streams)) world.stream(str(s.key), str(s.label, "group"));
  for (const o of list(setup.observations)) {
    world.observe({ term: str(o.term), streamKey: str(o.stream_key), addressee: str(o.addressee), times: num(o.times, 1) });
  }
  const wantTerms = rec(rec(fixture.expected).terms);
  const classes: Record<string, unknown> = {};
  const scopeOf: Record<string, string> = { bro: "goa-gang@g.us", chotu: "home@g.us" };
  for (const [term, want] of Object.entries(wantTerms)) {
    const cls = classifyAddressTerm(term, scopeOf[term] ?? null);
    classes[term] = cls;
    const wr = rec(want);
    if (cls.class !== str(wr.class)) {
      violations.push({ label: cls.class === "discriminating" ? "nickname-lock" : "generic-carries-evidence", note: `"${term}" classified ${cls.class}` });
    }
    const wantMaps = typeof wr.maps_to === "string" ? wr.maps_to : null;
    if (cls.mapsTo !== wantMaps) {
      violations.push({ label: "nickname-lock", note: `"${term}" maps to ${cls.mapsTo ?? "nobody"}, expected ${wantMaps ?? "nobody"}` });
    }
    if (wr.distinct_addressees !== undefined && cls.distinctAddressees !== num(wr.distinct_addressees, 1)) {
      violations.push({ label: "generic-carries-evidence", note: `"${term}" seen by ${cls.distinctAddressees} addressee(s)` });
    }
  }

  const generic = resolveRoles(
    { id: "m_generic", sender: "self", text: "bro send the payment link" },
    { roster: [{ id: "self", name: "Aditya" }, { id: "rohan", name: "Rohan" }, { id: "sameer", name: "Sameer" }], stream: { key: "goa-gang@g.us", audience: ["self", "rohan", "sameer"], isGroup: true } },
  );
  if (generic.status !== "unknown") {
    violations.push({ label: "generic-carries-evidence", note: `a generic term placed the message on ${generic.receiver.join(",")}` });
  }
  const discriminating = resolveRoles(
    { id: "m_disc", sender: "self", text: "chotu khana kha liya?" },
    { roster: [{ id: "self", name: "Aditya" }, { id: "vivaan", name: "Vivaan" }, { id: "isha", name: "Isha" }], stream: { key: "home@g.us", audience: ["self", "vivaan", "isha"], isGroup: true } },
  );
  const wantDisc = rec(rec(rec(fixture.expected).roles).discriminating_message);
  if (!sameSet(discriminating.receiver, strings(wantDisc.receiver)) || discriminating.rung !== str(wantDisc.rung, "address_term")) {
    violations.push({ label: "nickname-lock", note: `"chotu" → ${discriminating.rung} / ${discriminating.receiver.join(",") || "unknown"}` });
  }
  return ok({ terms: classes, generic_message: view(generic), discriminating_message: view(discriminating) }, violations);
}

function crm05(fixture: Fixture): ExecutorResult {
  const groups = list(rec(fixture.setup).groups);
  const violations: Violation[] = [];
  const ranked = rankByPriority(groups.map((g) => ({ id: str(g.id), circle: str(g.circle) as never, userReplyCount: num(g.user_reply_count, 0) })));
  const order = ranked.map((r) => r.id);
  const want = strings(rec(fixture.expected).priority_order);
  if (!want.every((id, i) => order[i] === id)) {
    violations.push({ label: "volume-equals-value", note: `priority order ${order.join(" > ")}, expected ${want.join(" > ")}` });
  }
  const maxVolume = num(rec(fixture.expected).volume_weight_max, 0.1);
  for (const r of ranked) {
    const base = r.circle ? num((rec(rec(fixture.expected).weights))[r.circle], 0) : 0;
    if (base > 0 && r.score - base > maxVolume + 1e-9) {
      violations.push({ label: "volume-equals-value", note: `${r.id} took ${(r.score - base).toFixed(3)} from volume` });
    }
  }
  return ok({ priority: ranked.map((r) => ({ id: r.id, circle: r.circle, score: r.score, explanation: r.explanation })) }, violations);
}

export const crmExecutor: Executor = async (ctx) => {
  const world = new PeopleWorld(ctx.fixture.id);
  try {
    switch (ctx.fixture.id) {
      case "CRM-01":
        return crm01(ctx.fixture, world);
      case "CRM-02":
        return crm02(ctx.fixture, world);
      case "CRM-03":
        return crm03(ctx.fixture, world);
      case "CRM-04":
        return crm04(ctx.fixture, world);
      case "CRM-05":
        return crm05(ctx.fixture);
      default:
        return { ok: false, output: { error: `no CRM case for ${ctx.fixture.id}` }, violations: [], metrics: { model_calls: 0 } };
    }
  } finally {
    world.cleanup();
  }
};

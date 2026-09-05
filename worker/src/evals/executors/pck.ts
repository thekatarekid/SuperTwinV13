// ===========================================================================
// [CODE] PCK — the pack executor (GoldenEvals V6 P1 §5.7; V6 P1 S3.2).
//
// Deterministic, zero model calls. Every case seeds its own world on
// case-prefixed ids (streams, spaces, episodes, tasks, entities), collects the
// real bundle (scheduler/dispatch.collectTick), packs it through the REAL
// packer (packer/pack.ts) and asserts the rendered pack plus PackedContext
// by code. The fixture's `setup` carries the parameters (space count,
// episode length, run-up, quoted age, bundle sizes) so the JSON is the
// source of truth; the executor is the seeding and the assertions.
//
//   PCK-01 blocks present, one <untrusted> block with every captured line
//   PCK-02 cap 5 chosen by retrieval; the 104-space pack < 16,000 (hard)
//   PCK-03 episode-bounded history (31 + 6 = 37; varies with the episode)
//   PCK-04 quoted messages always (a 40-day-old reply target)
//   PCK-05 budgeted truncation (4,000 for one event; the 400 floor for 150)
//   PCK-06 thin context (flag · held one flush · then the instruction)
//   PCK-07 T0 only: 0 model calls, under 200 ms (hard)
//
// The case's rows are removed afterwards so the harness DB stays clean.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";
import { addEpisodeEvents } from "../../db/v6core.js";
import { collectTick, type DeltaBundle } from "../../scheduler/v6/bundle.js";
import { runOrient } from "../../brain/orient.js";
import type { Provider } from "../../providers/types.js";
import {
  packOrientContext,
  EVENT_TEXT_CEILING,
  EVENT_TEXT_FLOOR,
  MAX_CANDIDATE_SPACES,
  PACK_BUDGET_CHARS,
  THIN_CONTEXT_INSTRUCTION,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  type PackedContext,
} from "../../packer/index.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

const T0 = Date.parse("2026-08-28T10:00:00.000Z");
const NOW = T0 + 3_600_000;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function str(v: unknown, dflt: string): string {
  return typeof v === "string" && v.length > 0 ? v : dflt;
}

/** The model is never reached from this executor; a call is a loud failure, not a spend. */
const forbiddenProvider = {
  id: "pck-forbidden",
  send: () => {
    throw new Error("PCK: the packer path reached the model");
  },
} as unknown as Provider;

// ---- Seeding on case-prefixed ids ------------------------------------------

class World {
  readonly prefix: string;
  readonly streamKeys = new Set<string>();
  constructor(readonly caseId: string) {
    this.prefix = `pck_${caseId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_`;
  }
  key(tag = "goa"): string {
    const k = `${this.prefix}${tag}@g.us`;
    this.streamKeys.add(k);
    return k;
  }
  message(i: number, text: string, actor = "contact:rohan", tag = "goa", extra: Record<string, unknown> = {}, ts?: string): EventEnvelope {
    const key = this.key(tag);
    return {
      ts: ts ?? new Date(T0 + i * 60_000).toISOString(),
      source: "wa",
      kind: "wa.message",
      origin: "live",
      streamKey: key,
      actor,
      roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text, external_id: `${key}:${i}`, ...extra },
    };
  }
  streamId(tag = "goa"): string {
    const row = getDb().prepare(`SELECT id FROM streams WHERE external_key = ?`).get(this.key(tag)) as { id: string } | undefined;
    if (!row) throw new Error(`${this.caseId}: stream ${tag} not seeded`);
    return row.id;
  }
  space(n: string, label: string, extras: { goal?: string; exemplars?: string[]; updatedAt?: string } = {}): string {
    const id = `${this.prefix}sp_${n}`;
    getDb()
      .prepare(`INSERT INTO spaces (id, label, life_area, goal, status, exemplars_json, updated_at) VALUES (?, ?, 'Travel', ?, 'active', ?, ?)`)
      .run(id, label, extras.goal ?? null, JSON.stringify(extras.exemplars ?? []), extras.updatedAt ?? new Date(T0).toISOString());
    return id;
  }
  episode(n: string, tag: string | null, eventIds: string[], extras: { spaceId?: string; summary?: string; state?: string; lastTs?: string } = {}): string {
    const id = `${this.prefix}ep_${n}`;
    getDb()
      .prepare(`INSERT INTO episodes (id, stream_id, space_id, state, summary, last_ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, tag ? this.streamId(tag) : null, extras.spaceId ?? null, extras.state ?? "open", extras.summary ?? "villa shortlist", extras.lastTs ?? new Date(T0).toISOString());
    if (eventIds.length > 0) addEpisodeEvents(id, eventIds);
    return id;
  }
  task(n: string, spaceId: string | null, title: string, extras: { due?: string; status?: string } = {}): string {
    const id = `${this.prefix}t_${n}`;
    getDb()
      .prepare(`INSERT INTO tasks (id, space_id, title, type, status, due, owner) VALUES (?, ?, ?, 'explicit', ?, ?, 'self')`)
      .run(id, spaceId, title, extras.status ?? "open", extras.due ?? null);
    return id;
  }
  person(n: string, name: string, actor: string, circle = "close_friends"): string {
    const id = `${this.prefix}ent_${n}`;
    const db = getDb();
    db.prepare(`INSERT INTO entities (id, type, canonical, provisional, circle) VALUES (?, 'person', ?, 0, ?)`).run(id, name, circle);
    db.prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES (?, ?, 'wa', 'handle', ?)`).run(`${id}_h`, id, actor);
    return id;
  }
  markDispatched(ids: readonly string[]): void {
    if (ids.length === 0) return;
    getDb()
      .prepare(`UPDATE events SET dispatched_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
      .run(new Date(T0).toISOString(), ...ids);
  }
  bundle(tag = "goa", nowMs = NOW): DeltaBundle {
    const key = this.key(tag);
    const b = collectTick(nowMs).bundles.find((x) => x.streamKey === key);
    if (!b) throw new Error(`${this.caseId}: no bundle for ${key}`);
    return b;
  }
  /** The §10 fixture: `n` spaces (a third about Goa), each with an exemplar episode and an open task. */
  seedSpaces(n: number): void {
    const areas = ["villa", "flights", "dinner", "diwali", "gifts", "trek", "budget", "photos"];
    for (let i = 0; i < n; i++) {
      const topic = areas[i % areas.length]!;
      const nn = String(i).padStart(3, "0");
      const sp = this.space(nn, i % 3 === 0 ? `Goa ${topic} plan ${i}` : `Family ${topic} thread ${i}`, {
        goal: `Sort out the ${topic} for the group, item ${i}`,
        exemplars: [`${topic} options compared ${i}`, `${topic} decision pending ${i}`],
        updatedAt: new Date(T0 - i * 3_600_000).toISOString(),
      });
      this.episode(nn, null, [], { spaceId: sp, state: "closed", summary: `${topic} chapter closed for space ${i}`, lastTs: new Date(T0 - i * 3_600_000).toISOString() });
      this.task(nn, sp, `Task ${i} for ${topic}`);
    }
  }
  goaBundle(): DeltaBundle {
    appendEvents([
      this.message(1, "guys lets lock goa 18-21 dec, villa hunt continues"),
      this.message(2, "flights from blr are 4k return, book tonight?", "contact:tanvi"),
      this.message(3, "villa with pool near anjuna https://www.airbnb.com/rooms/123"),
      this.message(4, "budget per head 15k incl villa and flights", "contact:tanvi"),
      this.message(5, "diwali is the week before, keep the 19th free"),
      this.message(6, "ok booking the villa advance now"),
    ]);
    return this.bundle();
  }
  cleanup(): void {
    const db = getDb();
    const like = `${this.prefix}%`;
    db.transaction(() => {
      db.prepare(`DELETE FROM episode_events WHERE episode_id LIKE ?`).run(like);
      db.prepare(`DELETE FROM episodes WHERE id LIKE ?`).run(like);
      db.prepare(`DELETE FROM tasks WHERE id LIKE ?`).run(like);
      db.prepare(`DELETE FROM chapters WHERE id LIKE ?`).run(like);
      db.prepare(`DELETE FROM spaces WHERE id LIKE ?`).run(like);
      db.prepare(`DELETE FROM entity_identities WHERE entity_id LIKE ?`).run(like);
      db.prepare(`DELETE FROM entities WHERE id LIKE ?`).run(like);
      for (const key of this.streamKeys) {
        const row = db.prepare(`SELECT id FROM streams WHERE external_key = ?`).get(key) as { id: string } | undefined;
        if (!row) continue;
        db.prepare(`DELETE FROM events WHERE stream_id = ?`).run(row.id);
        db.prepare(`DELETE FROM bundle_attempts WHERE stream_id = ?`).run(row.id);
        db.prepare(`DELETE FROM app_state WHERE key LIKE ?`).run(`packer.thin_held:${row.id}:%`);
        db.prepare(`DELETE FROM streams WHERE id = ?`).run(row.id);
      }
    })();
  }
}

function lines(user: string, header: string): string[] {
  const i = user.indexOf(header);
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of user.slice(i).split("\n").slice(1)) {
    if (/^\[[A-Z ]+/.test(l) || l === UNTRUSTED_OPEN || l === UNTRUSTED_CLOSE) break;
    out.push(l);
  }
  return out;
}

function baseMetrics(p: PackedContext): Record<string, number> {
  return {
    pack_chars: p.user.length,
    candidates: p.candidateSpaceIds.length,
    event_allowance: p.stats.eventAllowance,
    history_events: p.stats.historyEvents,
    model_calls: 0,
    packer_escalation: 0,
    pack_ms: Math.round(p.stats.tookMs * 10) / 10,
  };
}

function runsCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
}

// ---- Cases -------------------------------------------------------------------

async function pck01(w: World, setup: Record<string, unknown>): Promise<ExecutorResult> {
  const violations: Violation[] = [];
  const first = appendEvents([w.message(1, "guys lets lock goa 18-21 dec"), w.message(2, "villa hunt continues, sharing https://www.goibibo.com/hotels/goa-listing")]);
  w.markDispatched(first.ids);
  appendEvents([w.message(3, "did anyone pay the diwali pool??", "contact:tanvi"), w.message(4, "rohan can you book the villa by friday")]);
  const sp = w.space("goa", "Goa trip with Rohan in December", { goal: "18-21 Dec trip", exemplars: ["dates locked", "flight compare"] });
  w.space("diwali", "Diwali gifts for family");
  const ep = w.episode("412", "goa", first.ids, { spaceId: sp, summary: "villa shortlist" });
  const ent = w.person("rohan", "Rohan Mehta", "contact:rohan");
  getDb().prepare(`UPDATE streams SET label = 'Goa gang', stream_kind = 'group', participant_entity_ids = ? WHERE external_key = ?`).run(JSON.stringify([ent]), w.key());
  w.task("villa", sp, "Book the villa", { due: new Date(NOW + 2 * 86_400_000).toISOString() });

  const bundle = w.bundle();
  const packed = await packOrientContext(bundle, { nowMs: NOW });
  const u = packed.user;
  const order = ["[NOW]", "[ROSTER]", "[OPEN TASKS]", "[CALENDAR]", "[CANDIDATE SPACES]", UNTRUSTED_OPEN, "[BRIDGED]", "[THREAD S1", "[EPISODES]", "[BUNDLE]", UNTRUSTED_CLOSE];
  let cursor = -1;
  const missing: string[] = [];
  for (const m of order) {
    const at = u.indexOf(m);
    if (at <= cursor) missing.push(m);
    else cursor = at;
  }
  if (missing.length > 0) violations.push({ label: "block-missing", note: `missing or out of order: ${missing.join(", ")}` });
  if (u.split(UNTRUSTED_OPEN).length !== 2 || u.split(UNTRUSTED_CLOSE).length !== 2 || !u.endsWith(UNTRUSTED_CLOSE)) {
    violations.push({ label: "untrusted-split", note: "captured text must sit inside exactly one <untrusted> block" });
  }
  const open = u.indexOf(UNTRUSTED_OPEN);
  const close = u.indexOf(UNTRUSTED_CLOSE);
  const captured = ["lets lock goa 18-21 dec", "villa hunt continues", "diwali pool", "book the villa by friday"];
  for (const t of captured) {
    const at = u.indexOf(t);
    if (at < 0 || at < open || at > close) violations.push({ label: "untrusted-split", note: `"${t}" outside the untrusted block` });
  }
  if (packed.candidateSpaceIds.length > MAX_CANDIDATE_SPACES) violations.push({ label: "enumeration", note: `${packed.candidateSpaceIds.length} candidates` });
  if (packed.candidateSpaceIds[0] !== sp) violations.push({ label: "candidate-miss", note: `first candidate ${packed.candidateSpaceIds[0] ?? "none"}` });
  if (!u.includes('exemplars: "dates locked", "flight compare"')) violations.push({ label: "candidate-miss", note: "exemplars absent" });
  if (!/\[THREAD S1 [^\]]*\] 2 events \(open episode 2\)/.test(u)) violations.push({ label: "history-not-episode-bounded", note: lines(u, "[THREAD S1").length + " history lines" });
  if (!packed.episodeIds.includes(ep)) violations.push({ label: "block-missing", note: "[EPISODES] lacks the open episode" });
  if (!new RegExp(`e1 2026-08-28 10:03:00 · wa · contact:tanvi \\[wa\\.message\\]`).test(u)) violations.push({ label: "head-shape", note: "bundle head lacks time·source·actor·kind with seconds" });
  if (!u.includes(`${ent}=Rohan Mehta`)) violations.push({ label: "block-missing", note: "[ROSTER] lacks the resolved person" });
  if (!u.includes("Book the villa")) violations.push({ label: "block-missing", note: "[OPEN TASKS] lacks the task" });
  const minBlocks = num(setup.min_blocks, 9);
  const present = order.filter((m) => m.startsWith("[")).filter((m) => u.includes(m)).length;
  return {
    ok: violations.length === 0,
    output: { blocks_present: present, candidates: packed.candidateSpaceIds, episodes: packed.episodeIds, stream_aliases: [...packed.streamAliases.keys()], pack: u },
    violations,
    metrics: { ...baseMetrics(packed), blocks_present: present, untrusted_blocks: u.split(UNTRUSTED_OPEN).length - 1 },
    notes: [`${present}/${minBlocks} blocks · ${u.length} chars · ${packed.candidateSpaceIds.length} candidates`],
  };
}

async function pck02(w: World, setup: Record<string, unknown>): Promise<ExecutorResult> {
  const violations: Violation[] = [];
  const n = num(setup.spaces, 104);
  const small = num(setup.compare_with, 24);
  w.seedSpaces(n);
  const bundle = w.goaBundle();
  const packed = await packOrientContext(bundle, { nowMs: NOW });
  const named = new Set([...packed.user.matchAll(new RegExp(`${w.prefix}sp_\\d{3}`, "g"))].map((m) => m[0]));
  const outside = [...named].filter((id) => !packed.candidateSpaceIds.includes(id));
  if (packed.candidateSpaceIds.length !== MAX_CANDIDATE_SPACES) violations.push({ label: "enumeration", note: `${packed.candidateSpaceIds.length} candidates, expected exactly ${MAX_CANDIDATE_SPACES}` });
  if (outside.length > 0) violations.push({ label: "enumeration", note: `${outside.length} non-candidate spaces named in the pack` });
  if (packed.user.length >= PACK_BUDGET_CHARS) violations.push({ label: "pack-oversize", note: `${packed.user.length} chars` });
  const goa = packed.candidateSpaceIds.filter((id) => {
    const row = getDb().prepare(`SELECT label FROM spaces WHERE id = ?`).get(id) as { label: string } | undefined;
    return row?.label.startsWith("Goa ") ?? false;
  });
  if (goa.length !== packed.candidateSpaceIds.length) violations.push({ label: "enumeration", note: "a candidate was not chosen by retrieval (non-Goa space among the five)" });

  // Flatness: the same bundle over `small` spaces packs to (about) the same size.
  const w2 = new World(`${w.caseId}-small`);
  let smallChars = -1;
  try {
    w2.seedSpaces(small);
    const p2 = await packOrientContext(w2.goaBundle(), { nowMs: NOW });
    smallChars = p2.user.length;
  } finally {
    w2.cleanup();
  }
  const drift = Math.abs(packed.user.length - smallChars);
  if (drift >= 300) violations.push({ label: "grows-with-spaces", note: `${small} spaces → ${smallChars} chars; ${n} spaces → ${packed.user.length} chars` });
  return {
    ok: violations.length === 0,
    output: { candidates: packed.candidateSpaceIds, pack_chars: packed.user.length, pack_chars_small: smallChars, named_outside: outside },
    violations,
    metrics: { ...baseMetrics(packed), packer_enumeration: outside.length, pack_size_ok: packed.user.length < PACK_BUDGET_CHARS ? 1 : 0, pack_chars_small: smallChars, spaces: n },
    notes: [`${n} spaces → ${packed.user.length} chars (budget ${PACK_BUDGET_CHARS}); ${small} spaces → ${smallChars} chars`],
  };
}

async function pck03(w: World, setup: Record<string, unknown>): Promise<ExecutorResult> {
  const violations: Violation[] = [];
  const episodeLen = num(setup.episode_events, 31);
  const runUp = num(setup.run_up, 6);
  const newEvents = num(setup.bundle_events, 2);
  const envs: EventEnvelope[] = [];
  for (let i = 0; i < runUp + episodeLen + newEvents; i++) envs.push(w.message(i, `msg number ${i} about the villa`));
  const { ids } = appendEvents(envs);
  const members = ids.slice(runUp, runUp + episodeLen);
  w.episode("open", "goa", members, { summary: "villa hunt" });
  w.markDispatched(ids.slice(0, runUp + episodeLen));
  const bundle = w.bundle();
  const packed = await packOrientContext(bundle, { nowMs: NOW });
  const history = lines(packed.user, "[THREAD S1");
  const expected = runUp + episodeLen;
  if (packed.stats.historyEvents !== expected || history.length !== expected) {
    violations.push({ label: history.length === 20 ? "last-20-fixed" : "history-not-episode-bounded", note: `${history.length} history lines, expected ${expected}` });
  }
  // Variation: a shorter episode gives a shorter history.
  const w2 = new World(`${w.caseId}-short`);
  let shortCount = -1;
  try {
    const shortLen = Math.max(1, Math.floor(episodeLen / 3));
    const e2: EventEnvelope[] = [];
    for (let i = 0; i < runUp + shortLen + newEvents; i++) e2.push(w2.message(i, `short ${i}`));
    const r2 = appendEvents(e2);
    w2.episode("open", "goa", r2.ids.slice(runUp, runUp + shortLen), { summary: "short" });
    w2.markDispatched(r2.ids.slice(0, runUp + shortLen));
    const p2 = await packOrientContext(w2.bundle(), { nowMs: NOW });
    shortCount = p2.stats.historyEvents;
    if (shortCount !== runUp + shortLen) violations.push({ label: "last-20-fixed", note: `short episode gave ${shortCount} history lines, expected ${runUp + shortLen}` });
  } finally {
    w2.cleanup();
  }
  return {
    ok: violations.length === 0,
    output: { history_lines: history.length, expected, short_episode_history: shortCount, bundle_events: bundle.events.length },
    violations,
    metrics: { ...baseMetrics(packed), history_expected: expected },
    notes: [`${history.length} history lines for a ${episodeLen}-event open episode + ${runUp} run-up; ${shortCount} for the short one`],
  };
}

async function pck04(w: World, setup: Record<string, unknown>): Promise<ExecutorResult> {
  const violations: Violation[] = [];
  const ageDays = num(setup.quoted_age_days, 40);
  const quotedText = str(setup.quoted_text, "the villa with the blue pool, remember?");
  const old = appendEvents([w.message(0, quotedText, "contact:rohan", "goa", {}, new Date(T0 - ageDays * 86_400_000).toISOString())]);
  const filler = appendEvents(Array.from({ length: 12 }, (_, i) => w.message(i + 1, `filler ${i}`)));
  w.markDispatched([...old.ids, ...filler.ids]);
  appendEvents([w.message(20, "yes that one ^^ lets book it", "contact:tanvi", "goa", { quote_id: old.ids[0] })]);
  const bundle = w.bundle();
  const packed = await packOrientContext(bundle, { nowMs: NOW });
  const thread = lines(packed.user, "[THREAD S1").join("\n");
  if (!thread.includes(quotedText)) violations.push({ label: "quoted-dropped", note: "the replied-to message is not in the thread block" });
  if (!thread.includes("(quoted)")) violations.push({ label: "quoted-dropped", note: "no (quoted) flag" });
  if (!new RegExp(`e1 [^\\n]* ↩ ${old.ids[0]}`).test(packed.user)) violations.push({ label: "reply-structure-lost", note: "the reply head does not point at the quoted event" });
  return {
    ok: violations.length === 0,
    output: { quoted_id: old.ids[0], thread },
    violations,
    metrics: { ...baseMetrics(packed), quoted_present: thread.includes(quotedText) ? 1 : 0, quoted_age_days: ageDays },
    notes: [`quoted message ${ageDays} days old present: ${thread.includes(quotedText)}`],
  };
}

async function pck05(w: World, setup: Record<string, unknown>): Promise<ExecutorResult> {
  const violations: Violation[] = [];
  const sizes = Array.isArray(setup.bundles) ? setup.bundles.filter((x): x is number => typeof x === "number") : [1, 150];
  const results: Array<{ events: number; allowance: number; max_line: number }> = [];
  let counter = 1;
  for (const size of sizes) {
    w.markDispatched((getDb().prepare(`SELECT e.id FROM events e JOIN streams s ON s.id = e.stream_id WHERE s.external_key = ?`).all(w.key()) as { id: string }[]).map((r) => r.id));
    appendEvents(Array.from({ length: size }, (_, i) => w.message(counter++, `event ${i} ${"y".repeat(size === 1 ? 6_000 : 700)}`)));
    const packed = await packOrientContext(w.bundle(), { nowMs: NOW });
    const eventLines = lines(packed.user, "[BUNDLE]").filter((l) => /^\s*e\d+ /.test(l));
    const maxLine = eventLines.reduce((m, l) => Math.max(m, l.length), 0);
    results.push({ events: size, allowance: packed.stats.eventAllowance, max_line: maxLine });
    if (eventLines.length !== size) violations.push({ label: "bundle-trimmed", note: `${eventLines.length} of ${size} events rendered` });
    if (size === 1 && packed.stats.eventAllowance !== EVENT_TEXT_CEILING) violations.push({ label: "fixed-1200", note: `1-event allowance ${packed.stats.eventAllowance}, expected ${EVENT_TEXT_CEILING}` });
    if (size >= 100 && packed.stats.eventAllowance !== EVENT_TEXT_FLOOR) violations.push({ label: "fixed-1200", note: `${size}-event allowance ${packed.stats.eventAllowance}, expected ${EVENT_TEXT_FLOOR}` });
    if (packed.stats.eventAllowance === 1_200) violations.push({ label: "fixed-1200", note: "allowance is the old fixed 1,200" });
  }
  return {
    ok: violations.length === 0,
    output: { bundles: results },
    violations,
    metrics: Object.fromEntries(results.map((r) => [`allowance_${r.events}`, r.allowance])),
    notes: results.map((r) => `${r.events} event(s) → allowance ${r.allowance}, longest line ${r.max_line}`),
  };
}

async function pck06(w: World, setup: Record<string, unknown>): Promise<ExecutorResult> {
  const violations: Violation[] = [];
  const actor = str(setup.sender, "contact:unknown-9198");
  appendEvents([w.message(1, str(setup.text, "hey, is this the right number for the plumber?"), actor, "unknown")]);
  const bundle = w.bundle("unknown");
  const runsBefore = runsCount();
  // First sight through runOrient exactly as the consumer does it.
  const run = await runOrient(bundle, { provider: forbiddenProvider }, { nowMs: NOW });
  const first = run.packed;
  if (!first.thin) violations.push({ label: "guess-anyway", note: "thin=false on a stream with no history, no candidates, unresolved sender" });
  if (!first.held) violations.push({ label: "guess-anyway", note: "first sight was not held" });
  if (run.output !== undefined || run.result.runIds.length > 0) violations.push({ label: "guess-anyway", note: "the held bundle produced output or a run" });
  if (runsCount() !== runsBefore) violations.push({ label: "guess-anyway", note: "a model run was recorded for the held bundle" });
  const stillUnmarked = (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE id = ? AND dispatched_at IS NULL`).get(bundle.events[0]!.id) as { n: number }).n;
  if (stillUnmarked !== 1) violations.push({ label: "guess-anyway", note: "the held event was marked dispatched" });
  // Second sight: sent with the instruction.
  const second = await packOrientContext(bundle, { nowMs: NOW + 60_000 });
  if (!second.thin || second.held) violations.push({ label: "guess-anyway", note: `second sight thin=${second.thin} held=${second.held}` });
  if (!second.user.includes(THIN_CONTEXT_INSTRUCTION)) violations.push({ label: "guess-anyway", note: "no insufficient-context instruction on the second sight" });
  if (!second.user.includes("Permitted output: `unsorted`")) violations.push({ label: "guess-anyway", note: "the instruction does not restrict output to unsorted + a question" });
  return {
    ok: violations.length === 0,
    output: { first: { thin: first.thin, held: first.held, reasons: first.thinReasons }, second: { thin: second.thin, held: second.held, instructed: second.user.includes(THIN_CONTEXT_INSTRUCTION) } },
    violations,
    metrics: { ...baseMetrics(second), thin: first.thin ? 1 : 0, held_once: first.held ? 1 : 0 },
    notes: [`reasons: ${first.thinReasons.join("; ")}`],
  };
}

async function pck07(w: World, setup: Record<string, unknown>): Promise<ExecutorResult> {
  const violations: Violation[] = [];
  const n = num(setup.spaces, 104);
  const budgetMs = num(setup.budget_ms, 200);
  w.seedSpaces(n);
  const bundle = w.goaBundle();
  const runsBefore = runsCount();
  await packOrientContext(bundle, { nowMs: NOW }); // warm the prepared statements
  const started = performance.now();
  const packed = await packOrientContext(bundle, { nowMs: NOW });
  const took = performance.now() - started;
  const escalation = runsCount() - runsBefore;
  if (escalation !== 0) violations.push({ label: "escalation", note: `${escalation} model run(s) recorded during packing` });
  if (took >= budgetMs) violations.push({ label: "slow-pack", note: `${took.toFixed(1)} ms ≥ ${budgetMs} ms` });
  return {
    ok: violations.length === 0,
    output: { took_ms: took, spaces: n, candidates: packed.candidateSpaceIds },
    violations,
    metrics: { ...baseMetrics(packed), packer_escalation: escalation, pack_ms: Math.round(took * 10) / 10 },
    notes: [`${n} spaces packed in ${took.toFixed(1)} ms with ${escalation} model calls`],
  };
}

const CASES: Record<string, (w: World, setup: Record<string, unknown>) => Promise<ExecutorResult>> = {
  "PCK-01": pck01,
  "PCK-02": pck02,
  "PCK-03": pck03,
  "PCK-04": pck04,
  "PCK-05": pck05,
  "PCK-06": pck06,
  "PCK-07": pck07,
};

/** The executor registered for pass `pack` (PCK-01..07). */
export const packExecutor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const run = CASES[fixture.id];
  if (!run) {
    return { ok: false, output: null, notes: [`${fixture.id}: no pack case implemented`] };
  }
  const w = new World(fixture.id);
  const prevSemantic = process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
  // The pack must be deterministic in the harness: lexical lanes only.
  process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "0";
  try {
    return await run(w, rec(fixture.setup));
  } finally {
    if (prevSemantic === undefined) delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
    else process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = prevSemantic;
    w.cleanup();
  }
};

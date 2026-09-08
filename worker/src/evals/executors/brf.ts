// ===========================================================================
// [CODE] BRF — the brief (GoldenEvals V6 P1 §5.21; V6 P1 S4.6). Against the
// REAL brief lane: brief/delta.ts, brief/ledger.ts and brief/run.ts, with the
// brief.v2 call injected at the PROVIDER layer (never by prompt matching).
//
//   BRF-01  brief only on a delta          nothing written since the last
//           brief → status "skipped", ZERO provider calls, no row, no card;
//           then ONE world-model write wakes the very next brief, so the skip
//           is a lookup and not a mute. (`clock_only_call`)
//   BRF-02  brief composition              needs-you · today · moved, every
//           line carrying the row it came from, ONE call over a ledger CODE
//           composed, and no figure in the prose that is not in the ledger.
//
// THE ERA IS `now`. The window a brief measures is "since the last brief", so
// a fixture that pinned its clock to August would count every row the harness
// database already holds as news. The last brief is therefore seeded at
// `Date.now() + 1s` and the case's own writes are stamped after it — the same
// device CON-01 uses for the hourly roll. Every seeded row is removed again.
// ===========================================================================

import { runBrief, type BriefReport } from "../../brief/run.js";
import { BRIEF_PARTS, type BriefLedger } from "../../brief/ledger.js";
import { DEFAULT_TZ, localDate } from "../../calendar/clocks.js";
import { getDb } from "../../db/connection.js";
import { figuresNotInLedger } from "../../prompts/brief.v2.js";
import type { ProviderV2, Usage } from "../../providers/types.js";
import { providerRequestText, providerV2TestDouble } from "../../providers/test-support.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

const USAGE: Usage = { inputTokens: 12, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 6 };

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// The provider-layer stub — prose FROM the ledger, never beside it
// ---------------------------------------------------------------------------

/**
 * A brief.v2 stand-in that reads the packed ledger it was handed and writes it
 * back as the P-13 shape. Two things follow, and both are the point of a code
 * case: the call COUNT is the assertion, and a stub that can only echo the
 * ledger can never invent a figure — so `brief_inflation > 0` in a BRF run
 * means the code that packs or checks the ledger is wrong, not the model.
 */
export function cannedBriefProvider(): ProviderV2 & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(providerV2TestDouble(async (opts) => {
      const message = providerRequestText(opts);
      calls.push(message);
      opts.onEvent({ type: "delta", text: JSON.stringify({ text: proseFromLedger(message) }) });
      opts.onEvent({ type: "done", continuation: null, usage: USAGE });
      return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" };
  }), { calls });
}

/** Turn the packed ledger block back into P-13's markdown. */
export function proseFromLedger(packed: string): string {
  const out: string[] = [];
  let heading: string | null = null;
  let items: string[] = [];
  const flush = (): void => {
    if (heading && items.length > 0) out.push(`**${heading}** · ${items.join(" · ")}`);
    items = [];
  };
  for (const line of packed.split("\n")) {
    const head = /^(NEEDS YOU|TODAY|MOVED)$/.exec(line.trim());
    if (head) {
      flush();
      heading = head[1] === "NEEDS YOU" ? "Needs you" : head[1] === "TODAY" ? "Today" : "Moved";
      continue;
    }
    const item = /^- \[([^\]]+)\] (.+)$/.exec(line.trim());
    if (item && heading) items.push(item[2]!);
  }
  flush();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The case world
// ---------------------------------------------------------------------------

/** Rows one case owns, removed afterwards so the harness DB stays clean. */
class BrfWorld {
  readonly prefix: string;
  private readonly briefs: string[] = [];
  private readonly tasks: string[] = [];
  private readonly spaces: string[] = [];
  private readonly questions: string[] = [];
  private readonly events: string[] = [];
  private readonly artifacts: string[] = [];

  constructor(caseId: string) {
    this.prefix = `${caseId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_`;
  }

  key(k: string): string {
    return `${this.prefix}${k}`;
  }

  /** The previous brief — the instant every "moved" window in this case starts at. */
  priorBrief(atIso: string): string {
    const id = this.key("prior");
    getDb()
      .prepare(
        `INSERT INTO briefs (id, slot, tz, composed_at, since, delta_rows, ledger_json, text, model_calls, created_at)
         VALUES (?, ?, ?, ?, NULL, 0, '{}', 'the previous brief', 0, ?)`,
      )
      .run(id, this.key("prior-slot"), DEFAULT_TZ, atIso, atIso);
    this.briefs.push(id);
    return id;
  }

  space(id: string, label: string, latest?: { line: string; at: string }): string {
    const sid = this.key(id);
    getDb()
      .prepare(
        `INSERT INTO spaces (id, label, status, goal, latest, latest_ts) VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .run(sid, label, `${label} goal`, latest?.line ?? null, latest?.at ?? null);
    this.spaces.push(sid);
    return sid;
  }

  task(
    id: string,
    title: string,
    o: { status?: string; due?: string | null; spaceId?: string | null; updatedAt?: string | null; closedAt?: string | null } = {},
  ): string {
    const tid = this.key(id);
    getDb()
      .prepare(
        `INSERT INTO tasks (id, space_id, title, type, status, due, owner, created_by, updated_at, closed_at)
         VALUES (?, ?, ?, 'explicit', ?, ?, 'self', 'eval', ?, ?)`,
      )
      .run(tid, o.spaceId ?? null, title, o.status ?? "open", o.due ?? null, o.updatedAt ?? null, o.closedAt ?? null);
    this.tasks.push(tid);
    return tid;
  }

  question(id: string, text: string, askedAt: string): string {
    const qid = this.key(id);
    getDb()
      .prepare(`INSERT INTO questions (id, kind, question, status, asked_at) VALUES (?, 'choice', ?, 'open', ?)`)
      .run(qid, text, askedAt);
    this.questions.push(qid);
    return qid;
  }

  calendarEvent(id: string, title: string, startsAt: string, o: { status?: string; confirmedAt?: string | null } = {}): string {
    const eid = this.key(id);
    getDb()
      .prepare(
        `INSERT INTO calendar_events (id, title, starts_at, tz, all_day, status, origin, created_by, confirmed_at)
         VALUES (?, ?, ?, ?, 0, ?, 'chat', 'eval', ?)`,
      )
      .run(eid, title, startsAt, DEFAULT_TZ, o.status ?? "confirmed", o.confirmedAt ?? null);
    this.events.push(eid);
    return eid;
  }

  artifact(id: string, title: string, summary: string, createdAt: string): string {
    const aid = this.key(id);
    getDb()
      .prepare(
        `INSERT INTO artifacts (id, kind, title, summary, producer, status, created_at)
         VALUES (?, 'comparison', ?, ?, 'executor', 'new', ?)`,
      )
      .run(aid, title, summary, createdAt);
    this.artifacts.push(aid);
    return aid;
  }

  briefCount(): number {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM briefs`).get() as { n: number }).n;
  }

  cleanup(): void {
    const db = getDb();
    const like = `${this.prefix}%`;
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM decisions WHERE target_kind = 'brief'`).run();
      db.prepare(`DELETE FROM briefs WHERE id LIKE ? OR slot LIKE ?`).run(like, like);
      // The briefs this case COMPOSED carry a minted id; the slot is the
      // fixture's minute, so the case takes every row it could have written.
      db.prepare(`DELETE FROM briefs WHERE text LIKE ? OR ledger_json LIKE ?`).run(`%${this.prefix}%`, `%${this.prefix}%`);
      for (const id of this.artifacts) db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
      for (const id of this.events) db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
      for (const id of this.questions) db.prepare(`DELETE FROM questions WHERE id = ?`).run(id);
      for (const id of this.tasks) db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      for (const id of this.spaces) db.prepare(`DELETE FROM spaces WHERE id = ?`).run(id);
    });
    tx();
  }
}

/** Every brief this run composed, so a case can drop exactly what it wrote. */
function forgetBrief(report: BriefReport): void {
  if (report.brief) getDb().prepare(`DELETE FROM briefs WHERE id = ?`).run(report.brief.id);
}

// ---------------------------------------------------------------------------
// BRF-01 · brief only on a delta
// ---------------------------------------------------------------------------

type CaseFn = (fixture: Fixture, w: BrfWorld) => Promise<ExecutorResult>;

const brf01: CaseFn = async (_fixture, w) => {
  const base = Date.now();
  const sinceIso = new Date(base + 1_000).toISOString();
  w.priorBrief(sinceIso);
  const provider = cannedBriefProvider();
  const briefsBefore = w.briefCount();

  // (a) Nothing changed since that brief.
  const quiet = await runBrief({
    now: new Date(base + 2_000),
    tz: DEFAULT_TZ,
    slot: w.key("quiet"),
    deps: { provider },
  });
  const callsAfterQuiet = provider.calls.length;
  const briefsAfterQuiet = w.briefCount();

  // (b) ONE world-model write, and the very next brief is composed. The skip
  //     was a lookup, not a mute.
  w.task("t_wake", "Pay the villa advance", {
    status: "needs_approval",
    updatedAt: new Date(base + 3_000).toISOString(),
  });
  const woken = await runBrief({
    now: new Date(base + 4_000),
    tz: DEFAULT_TZ,
    slot: w.key("woken"),
    deps: { provider },
  });
  forgetBrief(woken);

  const violations: Violation[] = [];
  if (callsAfterQuiet > 0) {
    violations.push({ label: "call-on-no-delta", note: `${callsAfterQuiet} provider call(s) with an unchanged world model` });
  }
  if (briefsAfterQuiet !== briefsBefore) {
    violations.push({ label: "card-on-no-delta", note: "a brief row was written with nothing to say" });
  }
  if (woken.status !== "composed") {
    violations.push({ label: "mute", note: `one write did not wake the brief (${woken.reason ?? "?"})` });
  }

  const ok =
    violations.length === 0 &&
    quiet.status === "skipped" &&
    quiet.reason === "no_delta" &&
    quiet.modelCalls === 0 &&
    woken.modelCalls === 1;
  return {
    ok,
    output: {
      unchanged: {
        status: quiet.status,
        reason: quiet.reason ?? null,
        delta_rows: quiet.delta.rows,
        model_calls: quiet.modelCalls,
        provider_calls: callsAfterQuiet,
        brief_rows_written: briefsAfterQuiet - briefsBefore,
      },
      after_one_write: {
        status: woken.status,
        delta_rows: woken.delta.rows,
        model_calls: woken.modelCalls,
        provider_calls: provider.calls.length - callsAfterQuiet,
      },
    },
    violations,
    metrics: {
      model_calls: quiet.modelCalls + woken.modelCalls,
      clock_only_call: callsAfterQuiet,
      brief_cards: briefsAfterQuiet - briefsBefore,
    },
    gateObservations: [{ gateId: "clock_only_call", passed: callsAfterQuiet === 0, counted: true }],
    notes: ["the delta is a handful of indexed COUNTs; nothing is packed until it answers non-zero"],
  };
};

// ---------------------------------------------------------------------------
// BRF-02 · brief composition
// ---------------------------------------------------------------------------

const brf02: CaseFn = async (fixture, w) => {
  const base = Date.now();
  const sinceIso = new Date(base + 1_000).toISOString();
  const nowMs = base + 5_000;
  const now = new Date(nowMs);
  const day = localDate(nowMs, DEFAULT_TZ);
  const after = (ms: number): string => new Date(base + ms).toISOString();

  // Standing world (before the window): what needs the user, what is today.
  const space = w.space("sp_goa", "Goa trip in December", {
    line: "Rohan's twin confirmed Saturday",
    at: after(2_000),
  });
  w.priorBrief(sinceIso);
  const approval = w.task("t_insurance", "Pay insurance renewal", {
    status: "needs_approval",
    spaceId: space,
  });
  const todayTask = w.task("t_cab", "Book the cab", { status: "open", due: `${day}T13:45:00.000Z`, spaceId: space });
  const question = w.question("q_ticket", "Ma's ticket: AC or sleeper?", after(2_500));
  const event = w.calendarEvent("cal_dinner", "Dinner with Rohan", `${day}T14:30:00.000Z`, { status: "confirmed" });

  // Inside the window: what moved.
  const closed = w.task("t_visa", "Send the visa photos", {
    status: "done",
    closedAt: after(3_000),
    updatedAt: after(3_000),
    spaceId: space,
  });
  const artifact = w.artifact("art_villas", "Villa comparison", "three villas, one fits the budget", after(3_500));

  const provider = cannedBriefProvider();
  const report = await runBrief({ now, tz: DEFAULT_TZ, slot: w.key("slot"), deps: { provider } });
  const ledger = report.ledger;
  const sources = ledger ? partSources(ledger) : { needs_you: [], today: [], moved: [] };

  const violations: Violation[] = [];
  if (provider.calls.length !== 1) {
    violations.push({ label: "extra-call", note: `${provider.calls.length} calls for one brief` });
  }
  const missing: string[] = [];
  const want: [string, string[], string][] = [
    ["needs_you", sources.needs_you, approval],
    ["needs_you", sources.needs_you, question],
    ["today", sources.today, event],
    ["today", sources.today, todayTask],
    ["moved", sources.moved, space],
    ["moved", sources.moved, closed],
    ["moved", sources.moved, artifact],
  ];
  for (const [part, got, id] of want) if (!got.includes(id)) missing.push(`${part}:${id}`);
  if (missing.length > 0) {
    violations.push({ label: "missing-part", note: `the ledger dropped ${missing.join(", ")}` });
  }
  const empty = BRIEF_PARTS.filter((p) => (ledger?.[p].length ?? 0) === 0);
  if (empty.length > 0) violations.push({ label: "empty-part", note: `${empty.join(", ")} came back empty` });
  const uncited = (ledger ? [...ledger.needs_you, ...ledger.today, ...ledger.moved] : []).filter(
    (i) => !i.source || !i.text,
  );
  if (uncited.length > 0) {
    violations.push({ label: "uncited-item", note: `${uncited.length} ledger item(s) without a source chip` });
  }
  const inflation = report.violations.filter((v) => v.startsWith("brief-inflation:"));
  if (inflation.length > 0) violations.push({ label: "invented-figure", note: inflation.join(", ") });

  const text = report.brief?.text ?? "";
  const headings = ["Needs you", "Today", "Moved"].filter((h) => text.includes(h));
  if (headings.length !== 3) {
    violations.push({ label: "missing-heading", note: `prose carries ${headings.join(", ") || "no part"}` });
  }
  forgetBrief(report);

  const ok = violations.length === 0 && report.status === "composed" && report.modelCalls === 1;
  return {
    ok,
    output: {
      status: report.status,
      model_calls: report.modelCalls,
      delta_rows: report.delta.rows,
      delta_by_table: report.delta.byTable,
      ledger: ledger
        ? {
            needs_you: ledger.needs_you,
            today: ledger.today,
            moved: ledger.moved,
            truncated: ledger.truncated,
          }
        : null,
      text,
      packed: provider.calls[0] ?? null,
    },
    seededContext: [
      `needs you   ${approval} "Pay insurance renewal" (approval) · ${question} "Ma's ticket: AC or sleeper?"`,
      `today       ${event} "Dinner with Rohan" · ${todayTask} "Book the cab"`,
      `moved       ${space} "Rohan's twin confirmed Saturday" · ${closed} closed · ${artifact} finished`,
    ].join("\n"),
    violations,
    metrics: {
      model_calls: report.modelCalls,
      brief_inflation: inflation.length,
      ledger_items: ledger ? ledger.needs_you.length + ledger.today.length + ledger.moved.length : 0,
      uncited_item: uncited.length,
      figures_invented: figuresNotInLedger(text, provider.calls[0] ?? "").length,
    },
    gateObservations: [{ gateId: "clock_only_call", passed: true, counted: true }],
    notes: [
      String(rec(fixture.expected).note ?? "code composes the ledger; one call writes the prose"),
    ],
  };
};

function partSources(ledger: BriefLedger): Record<"needs_you" | "today" | "moved", string[]> {
  return {
    needs_you: ledger.needs_you.map((i) => i.source),
    today: ledger.today.map((i) => i.source),
    moved: ledger.moved.map((i) => i.source),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const CASES: Record<string, CaseFn> = {
  "BRF-01": brf01,
  "BRF-02": brf02,
};

export async function runBrfCase(fixture: Fixture): Promise<ExecutorResult> {
  const run = CASES[fixture.id];
  if (!run) throw new Error(`BRF executor: no case for ${fixture.id}`);
  const w = new BrfWorld(fixture.id);
  try {
    return await run(fixture, w);
  } finally {
    w.cleanup();
  }
}

export const isBrfFixture = (fixture: Fixture): boolean => fixture.category === "BRF";

/** Registered under pass `brief`. Zero live model calls: the provider is canned. */
export const brfExecutor: Executor = async (ctx) => runBrfCase(ctx.fixture);

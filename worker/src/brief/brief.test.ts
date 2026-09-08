// ===========================================================================
// The brief lane (V6 P1 S4.6) on a temp DB — ZERO live model calls. The one
// brief.v2 call every composed brief makes is a canned provider handed in
// through JsonPassDeps.
//
// What is asserted here: the set times (pure arithmetic), the delta (the
// lookup that makes a clock-driven surface honest), the ledger code composes,
// the pass around them, and the job's tick.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateSet } from "../db/ingest.js";
import { decisionsFor } from "../db/decisions.js";
import { PROCESS_ENABLED_PREFIX } from "../settings/steps.js";
import { BRIEF_TIMES_KEY as ROUTE_BRIEF_TIMES_KEY, DEFAULT_BRIEF_TIMES as ROUTE_DEFAULTS } from "../server/settings-routes.js";
import { figuresNotInLedger, parseBriefV2 } from "../prompts/brief.v2.js";
import type { ProviderV2, Usage } from "../providers/types.js";
import { providerRequestText, providerV2TestDouble } from "../providers/test-support.js";
import {
  BRIEF_LAST_SLOT_KEY,
  BRIEF_TIMES_KEY,
  DEFAULT_BRIEF_TIMES,
  briefDeltaSince,
  briefTick,
  briefTimes,
  composeLedger,
  dueSlot,
  lastBriefAt,
  latestBrief,
  listBriefs,
  markBriefSeen,
  normaliseTime,
  packBriefV2User,
  renderLedgerFallback,
  runBrief,
  slotKey,
  startBriefJob,
} from "./index.js";

const IST = "Asia/Kolkata";
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-brief-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- the canned brief.v2 call ----------------------------------------------

const USAGE: Usage = { inputTokens: 8, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 4 };

function cannedProvider(text = "**Needs you** · one thing"): ProviderV2 & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(providerV2TestDouble(async (opts) => {
      calls.push(providerRequestText(opts));
      opts.onEvent({ type: "delta", text: JSON.stringify({ text }) });
      opts.onEvent({ type: "done", continuation: null, usage: USAGE });
      return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" };
  }), { calls });
}

// ---- seeds ------------------------------------------------------------------

function seedPriorBrief(atIso: string): void {
  getDb()
    .prepare(
      `INSERT INTO briefs (id, slot, tz, composed_at, since, delta_rows, ledger_json, text, model_calls, created_at)
       VALUES ('brf_prior', 'prior', ?, ?, NULL, 0, '{}', 'prior', 0, ?)`,
    )
    .run(IST, atIso, atIso);
}

function seedTask(
  id: string,
  title: string,
  o: { status?: string; due?: string | null; updatedAt?: string | null; closedAt?: string | null } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, type, status, due, owner, created_by, updated_at, closed_at)
       VALUES (?, ?, 'explicit', ?, ?, 'self', 'test', ?, ?)`,
    )
    .run(id, title, o.status ?? "open", o.due ?? null, o.updatedAt ?? null, o.closedAt ?? null);
}

// ===========================================================================
describe("the set times", () => {
  it("normalises and defaults the way Settings writes them", () => {
    expect(normaliseTime("8:30")).toBe("08:30");
    expect(normaliseTime("18:30")).toBe("18:30");
    expect(normaliseTime("25:00")).toBeNull();
    expect(normaliseTime("nope")).toBeNull();
    expect(briefTimes(["18:30", "8:30", "8:30", "oops"])).toEqual(["08:30", "18:30"]);
    expect(briefTimes([])).toEqual([...DEFAULT_BRIEF_TIMES]);
  });

  it("keys off the very app_state row Settings › General writes", () => {
    // Two modules name this key; a drift would make the user's set times
    // invisible to the lane that fires on them.
    expect(BRIEF_TIMES_KEY).toBe(ROUTE_BRIEF_TIMES_KEY);
    expect([...DEFAULT_BRIEF_TIMES]).toEqual([...ROUTE_DEFAULTS]);
  });

  it("offers the newest due slot, once, and never a backlog", () => {
    const times = ["08:30", "18:30"];
    const at = (iso: string): number => Date.parse(iso);
    // 08:29 IST — nothing due yet today, and yesterday's 18:30 is stale.
    const early = dueSlot(at("2026-09-06T02:59:00.000Z"), times, "2026-09-05 18:30", IST);
    expect(early).toBeNull();
    // 08:35 IST — today's 08:30, five minutes late.
    const morning = dueSlot(at("2026-09-06T03:05:00.000Z"), times, "2026-09-05 18:30", IST);
    expect(morning?.slot).toBe("2026-09-06 08:30");
    expect(morning?.stale).toBe(false);
    // Already served: nothing until 18:30.
    expect(dueSlot(at("2026-09-06T03:05:00.000Z"), times, "2026-09-06 08:30", IST)).toBeNull();
    // 19:00 IST with the morning never served: the EVENING slot, not a backlog.
    const evening = dueSlot(at("2026-09-06T13:30:00.000Z"), times, "2026-09-05 18:30", IST);
    expect(evening?.slot).toBe("2026-09-06 18:30");
  });

  it("marks a slot older than the grace window stale", () => {
    const late = dueSlot(Date.parse("2026-09-06T09:30:00.000Z"), ["08:30"], null, IST);
    expect(late?.slot).toBe("2026-09-06 08:30");
    expect(late?.stale).toBe(true); // 15:00 IST is not the morning brief
  });

  it("carries a late-night slot into the next day", () => {
    // 00:20 IST on the 7th: yesterday's 23:30 is the slot that is due.
    const slot = dueSlot(Date.parse("2026-09-06T18:50:00.000Z"), ["23:30"], null, IST);
    expect(slot?.slot).toBe("2026-09-06 23:30");
  });
});

// ===========================================================================
describe("the delta", () => {
  it("counts world-model rows, never raw capture", () => {
    const since = "2026-09-06T00:00:00.000Z";
    expect(briefDeltaSince(since).rows).toBe(0);
    seedTask("t1", "Pay the villa advance", { updatedAt: "2026-09-06T04:00:00.000Z" });
    const after = briefDeltaSince(since);
    expect(after.rows).toBe(1);
    expect(after.byTable.tasks).toBe(1);
    // A row before the window is not news.
    expect(briefDeltaSince("2026-09-06T05:00:00.000Z").rows).toBe(0);
  });

  it("counts everything on the first brief (no window yet)", () => {
    seedTask("t1", "Pay the villa advance");
    expect(briefDeltaSince(null).rows).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("the ledger", () => {
  it("puts a gate in needs-you, a due-today task in today, and a close in moved", () => {
    const now = new Date("2026-09-06T03:00:00.000Z"); // 08:30 IST
    const since = "2026-09-05T13:00:00.000Z";
    seedTask("t_appr", "Pay insurance renewal", { status: "needs_approval" });
    seedTask("t_cab", "Book the cab", { due: "2026-09-06T13:45:00.000Z" });
    seedTask("t_visa", "Send the visa photos", {
      status: "done",
      closedAt: "2026-09-05T18:00:00.000Z",
      updatedAt: "2026-09-05T18:00:00.000Z",
    });
    getDb()
      .prepare(`INSERT INTO questions (id, kind, question, status, asked_at) VALUES ('q1','choice',?, 'open', ?)`)
      .run("Ma's ticket: AC or sleeper?", "2026-09-05T19:00:00.000Z");
    getDb()
      .prepare(
        `INSERT INTO spaces (id, label, status, goal, latest, latest_ts)
         VALUES ('sp_goa', 'Goa trip in December', 'active', 'go to Goa', ?, ?)`,
      )
      .run("Rohan's twin confirmed Saturday", "2026-09-05T20:00:00.000Z");

    const ledger = composeLedger({ now, tz: IST, since });
    expect(ledger.needs_you.map((i) => i.source)).toEqual(expect.arrayContaining(["t_appr", "q1"]));
    expect(ledger.today.map((i) => i.source)).toContain("t_cab");
    expect(ledger.moved.map((i) => i.source)).toEqual(expect.arrayContaining(["sp_goa", "t_visa"]));
    // Every line carries the row it came from.
    for (const item of [...ledger.needs_you, ...ledger.today, ...ledger.moved]) {
      expect(item.source).toBeTruthy();
      expect(item.text.trim()).not.toBe("");
    }
  });

  it("packs three named parts and a fallback that reads without the model", () => {
    const now = new Date("2026-09-06T03:00:00.000Z");
    seedTask("t_appr", "Pay insurance renewal", { status: "needs_approval" });
    const ledger = composeLedger({ now, tz: IST, since: "2026-09-05T13:00:00.000Z" });
    const packed = packBriefV2User(ledger);
    expect(packed).toContain("NEEDS YOU");
    expect(packed).toContain("TODAY");
    expect(packed).toContain("MOVED");
    expect(packed).toContain("[t_appr] Pay insurance renewal");
    expect(renderLedgerFallback(ledger)).toContain("Pay insurance renewal");
  });
});

// ===========================================================================
describe("brief.v2's contract", () => {
  it("takes {text} and nothing else", () => {
    expect(parseBriefV2({ text: " hello " })).toEqual({ text: "hello" });
    expect(() => parseBriefV2({ text: "" })).toThrow(/non-empty/);
    expect(() => parseBriefV2([{ text: "x" }])).toThrow(/one JSON object/);
    expect(() => parseBriefV2("**Needs you**")).toThrow(/one JSON object/);
  });

  it("names a figure the ledger never held, and forgives formatting", () => {
    const ledger = "- [t1] Pay insurance renewal Rs.8,400\n- [c1] Dinner 20:00";
    expect(figuresNotInLedger("Pay Rs.8400 · dinner at 20:00", ledger)).toEqual([]);
    expect(figuresNotInLedger("Pay Rs.9,900 tonight", ledger)).toEqual(["9900"]);
  });
});

// ===========================================================================
describe("runBrief", () => {
  it("BRF-01: nothing changed → no call, no card, and the window stays open", async () => {
    seedPriorBrief("2026-09-06T02:00:00.000Z");
    const provider = cannedProvider();
    const report = await runBrief({
      now: new Date("2026-09-06T13:00:00.000Z"),
      tz: IST,
      slot: "2026-09-06 18:30",
      deps: { provider },
    });
    expect(report.status).toBe("skipped");
    expect(report.reason).toBe("no_delta");
    expect(report.modelCalls).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(listBriefs()).toHaveLength(1); // only the prior one
    expect(lastBriefAt()).toBe("2026-09-06T02:00:00.000Z"); // untouched
  });

  it("BRF-01: one world-model write wakes the very next brief", async () => {
    seedPriorBrief("2026-09-06T02:00:00.000Z");
    seedTask("t_appr", "Pay insurance renewal", {
      status: "needs_approval",
      updatedAt: "2026-09-06T09:00:00.000Z",
    });
    const provider = cannedProvider();
    const report = await runBrief({
      now: new Date("2026-09-06T13:00:00.000Z"),
      tz: IST,
      slot: "2026-09-06 18:30",
      deps: { provider },
    });
    expect(report.status).toBe("composed");
    expect(report.modelCalls).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(report.brief?.slot).toBe("2026-09-06 18:30");
    expect(report.brief?.since).toBe("2026-09-06T02:00:00.000Z");
    expect(decisionsFor("brief", report.brief!.id).map((d) => d.action)).toContain("compose");
  });

  it("BRF-02: one call over a ledger code composed, with the prose kept", async () => {
    seedPriorBrief("2026-09-05T13:00:00.000Z");
    seedTask("t_appr", "Pay insurance renewal", {
      status: "needs_approval",
      updatedAt: "2026-09-05T19:00:00.000Z",
    });
    seedTask("t_cab", "Book the cab", { due: "2026-09-06T13:45:00.000Z", updatedAt: "2026-09-05T19:00:00.000Z" });
    getDb()
      .prepare(
        `INSERT INTO spaces (id, label, status, goal, latest, latest_ts)
         VALUES ('sp_goa', 'Goa trip in December', 'active', 'go to Goa', ?, ?)`,
      )
      .run("Rohan's twin confirmed Saturday", "2026-09-05T20:00:00.000Z");
    const provider = cannedProvider("**Needs you** · Pay insurance renewal\n**Today** · Book the cab\n**Moved** · Goa trip");
    const report = await runBrief({
      now: new Date("2026-09-06T03:00:00.000Z"),
      tz: IST,
      slot: "2026-09-06 08:30",
      deps: { provider },
    });
    expect(report.status).toBe("composed");
    expect(report.modelCalls).toBe(1);
    expect(report.violations).toEqual([]);
    expect(report.ledger?.needs_you.map((i) => i.source)).toContain("t_appr");
    expect(report.ledger?.today.map((i) => i.source)).toContain("t_cab");
    expect(report.ledger?.moved.map((i) => i.source)).toContain("sp_goa");
    expect(report.brief?.text).toContain("Needs you");
    // The packed half is the ledger, so the prose can be checked against rows.
    expect(provider.calls[0]).toContain("[t_appr]");
  });

  it("skips a quiet day with a delta but no ledger — no filler", async () => {
    seedPriorBrief("2026-09-05T13:00:00.000Z");
    // An episode moved, but nothing is due, open, asked or finished.
    getDb()
      .prepare(`INSERT INTO episodes (id, state, summary, updated_at) VALUES ('ep1','closed','a chat', ?)`)
      .run("2026-09-05T19:00:00.000Z");
    const provider = cannedProvider();
    const report = await runBrief({
      now: new Date("2026-09-06T03:00:00.000Z"),
      tz: IST,
      slot: "2026-09-06 08:30",
      deps: { provider },
    });
    expect(report.status).toBe("skipped");
    expect(report.reason).toBe("empty_ledger");
    expect(provider.calls).toHaveLength(0);
  });

  it("still puts a card up when the call fails — the ledger renders itself", async () => {
    seedPriorBrief("2026-09-05T13:00:00.000Z");
    seedTask("t_appr", "Pay insurance renewal", {
      status: "needs_approval",
      updatedAt: "2026-09-05T19:00:00.000Z",
    });
    const broken = providerV2TestDouble(async (opts) => {
        opts.onEvent({ type: "delta", text: "not json at all" });
        opts.onEvent({ type: "done", continuation: null, usage: USAGE });
        return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" };
    });
    const report = await runBrief({
      now: new Date("2026-09-06T03:00:00.000Z"),
      tz: IST,
      slot: "2026-09-06 08:30",
      deps: { provider: broken, sleep: async () => {} },
    });
    expect(report.status).toBe("composed");
    expect(report.violations.some((v) => v.startsWith("brief-call-failed:"))).toBe(true);
    expect(report.brief?.text).toContain("Pay insurance renewal");
  });

  it("keeps one row per set time and clears its own dot", async () => {
    seedPriorBrief("2026-09-05T13:00:00.000Z");
    seedTask("t_appr", "Pay insurance renewal", {
      status: "needs_approval",
      updatedAt: "2026-09-05T19:00:00.000Z",
    });
    const provider = cannedProvider();
    const slot = slotKey("2026-09-06", "08:30");
    await runBrief({ now: new Date("2026-09-06T03:00:00.000Z"), tz: IST, slot, deps: { provider } });
    await runBrief({ now: new Date("2026-09-06T03:01:00.000Z"), tz: IST, slot, deps: { provider, sleep: async () => {} } });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM briefs WHERE slot = ?`).get(slot)).toEqual({ n: 1 });
    const standing = latestBrief()!;
    expect(standing.seenAt).toBeNull();
    expect(markBriefSeen(standing.id)?.seenAt).not.toBeNull();
  });
});

// ===========================================================================
describe("the tick", () => {
  it("does nothing between set times", async () => {
    appStateSet(BRIEF_LAST_SLOT_KEY, "2026-09-06 08:30");
    const provider = cannedProvider();
    const report = await briefTick({
      now: new Date("2026-09-06T06:00:00.000Z"),
      tz: IST,
      times: ["08:30", "18:30"],
      deps: { provider },
    });
    expect(report.reason).toBe("not_due");
    expect(provider.calls).toHaveLength(0);
  });

  it("consumes a stale slot without composing", async () => {
    appStateSet(BRIEF_LAST_SLOT_KEY, "2026-09-05 18:30");
    const provider = cannedProvider();
    const report = await briefTick({
      now: new Date("2026-09-06T09:30:00.000Z"), // 15:00 IST — the morning is gone
      tz: IST,
      times: ["08:30", "18:30"],
      deps: { provider },
    });
    expect(report.reason).toBe("stale_slot");
    expect(provider.calls).toHaveLength(0);
    // The slot is answered, so the job does not re-consider it every minute.
    const again = await briefTick({
      now: new Date("2026-09-06T09:31:00.000Z"),
      tz: IST,
      times: ["08:30", "18:30"],
      deps: { provider },
    });
    expect(again.reason).toBe("not_due");
  });

  it("composes a due slot once, and reads the set times from app_state", async () => {
    appStateSet(BRIEF_TIMES_KEY, JSON.stringify(["08:30"]));
    seedPriorBrief("2026-09-06T01:00:00.000Z");
    seedTask("t_appr", "Pay insurance renewal", {
      status: "needs_approval",
      updatedAt: "2026-09-06T02:00:00.000Z",
    });
    const provider = cannedProvider();
    const first = await briefTick({ now: new Date("2026-09-06T03:05:00.000Z"), tz: IST, deps: { provider } });
    expect(first.status).toBe("composed");
    expect(first.slot).toBe("2026-09-06 08:30");
    expect(provider.calls).toHaveLength(1);
    const second = await briefTick({ now: new Date("2026-09-06T03:06:00.000Z"), tz: IST, deps: { provider } });
    expect(second.reason).toBe("not_due");
    expect(provider.calls).toHaveLength(1);
  });

  it("holds the slot while the step is off, and serves it when it comes back", async () => {
    appStateSet(`${PROCESS_ENABLED_PREFIX}brief`, "0");
    seedPriorBrief("2026-09-06T01:00:00.000Z");
    seedTask("t_appr", "Pay insurance renewal", {
      status: "needs_approval",
      updatedAt: "2026-09-06T02:00:00.000Z",
    });
    const provider = cannedProvider();
    const held = await briefTick({
      now: new Date("2026-09-06T03:05:00.000Z"),
      tz: IST,
      times: ["08:30"],
      deps: { provider },
    });
    expect(held.reason).toBe("step_off");
    expect(provider.calls).toHaveLength(0);
    appStateSet(`${PROCESS_ENABLED_PREFIX}brief`, "1");
    const served = await briefTick({
      now: new Date("2026-09-06T03:06:00.000Z"),
      tz: IST,
      times: ["08:30"],
      deps: { provider },
    });
    expect(served.status).toBe("composed");
  });

  it("startBriefJob runs one tick on demand and stops clean", async () => {
    const lines: string[] = [];
    const provider = cannedProvider();
    const job = startBriefJob({
      intervalMs: 60_000,
      bootDelayMs: 10 * 60_000, // never inside the test
      log: (l) => lines.push(l),
      deps: { provider },
    });
    try {
      const report = await job.runNow(new Date("2026-09-06T06:00:00.000Z"));
      expect(report.reason).toBeDefined();
    } finally {
      job.stop();
    }
    expect(provider.calls.length).toBeLessThanOrEqual(1);
  });
});

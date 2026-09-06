// ===========================================================================
// The prioritized task list (V6 P1 S5.2, Product_V6 §11.13). Pinned clock,
// temp DB, zero model calls: code decides the section and the score, and every
// row carries the factors that made it.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  DEFAULT_TZ,
  dayKey,
  dueInstant,
  listPrioritizedTasks,
  relativeDueLabel,
  SECTIONS,
} from "./priority.js";

/** Sat 2026-08-29 09:00 IST. */
const NOW = new Date("2026-08-29T03:30:00.000Z");
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-priority-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  getDb()
    .prepare(`INSERT INTO spaces (id, label, status, created_by) VALUES ('sp_1', 'Goa trip', 'active', 'test')`)
    .run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface TaskSeed {
  id: string;
  title: string;
  type?: string;
  category?: string | null;
  risk?: string;
  owner?: string;
  status?: string;
  due?: string | null;
  closedAt?: string | null;
  confidence?: number;
  schedule?: unknown;
  space?: string | null;
}

function task(t: TaskSeed): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, due, status,
                          schedule_json, evidence_json, created_by, confidence, closed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'test', ?, ?, '2026-08-29T02:30:00.000Z')`,
    )
    .run(
      t.id,
      t.space === undefined ? "sp_1" : t.space,
      t.title,
      t.type ?? "explicit",
      t.category ?? null,
      t.risk ?? "advise-only",
      t.owner ?? "self",
      t.due ?? null,
      t.status ?? "open",
      t.schedule === undefined ? null : JSON.stringify(t.schedule),
      t.confidence ?? 0.9,
      t.closedAt ?? null,
    );
}

const sectionOf = (id: string, now = NOW): string | null => {
  const list = listPrioritizedTasks({ now });
  for (const s of list.sections) if (s.tasks.some((t) => t.id === id)) return s.id;
  return null;
};

describe("view-clock helpers", () => {
  it("renders a due relative to now, never stores it that way", () => {
    expect(relativeDueLabel("2026-08-29", NOW, DEFAULT_TZ)).toBe("today");
    expect(relativeDueLabel("2026-08-30", NOW, DEFAULT_TZ)).toBe("tomorrow");
    expect(relativeDueLabel("2026-08-28", NOW, DEFAULT_TZ)).toBe("1 day overdue");
    expect(relativeDueLabel("2026-08-26", NOW, DEFAULT_TZ)).toBe("3 days overdue");
    expect(relativeDueLabel("2026-09-02", NOW, DEFAULT_TZ)).toBe("in 4 days");
    expect(relativeDueLabel(null, NOW, DEFAULT_TZ)).toBeNull();
  });

  it("a date-only due ends at 23:59 local, not at midnight UTC", () => {
    expect(dueInstant("2026-08-29", DEFAULT_TZ)!.toISOString()).toBe("2026-08-29T18:29:59.000Z");
    expect(dayKey(new Date("2026-08-29T18:29:59.000Z"), DEFAULT_TZ)).toBe("2026-08-29");
    // 19:00Z is already the 30th in IST — the view clock, not the store, decides.
    expect(dayKey(new Date("2026-08-29T19:00:00.000Z"), DEFAULT_TZ)).toBe("2026-08-30");
  });
});

describe("sections", () => {
  it("orders the six sections the way the product names them", () => {
    expect(listPrioritizedTasks({ now: NOW }).sections.map((s) => s.label)).toEqual([
      "Needs you",
      "Today",
      "This week",
      "Later",
      "Waiting on others",
      "Done today",
    ]);
    expect(SECTIONS).toHaveLength(6);
  });

  it("a gate or a question is Needs you", () => {
    task({ id: "t_gate", title: "Approve the payment", status: "needs_approval" });
    task({ id: "t_ask", title: "Aisle or window?", status: "needs_input" });
    expect(sectionOf("t_gate")).toBe("needs_you");
    expect(sectionOf("t_ask")).toBe("needs_you");
  });

  it("a standing \"done?\" card is Needs you and its one tap is the answer", () => {
    task({ id: "t_pay", title: "Collect Karan's share" });
    writeDecision({ targetKind: "task", targetId: "t_pay", action: "ask_done", new: { card: "done?" } });
    expect(sectionOf("t_pay")).toBe("needs_you");
    const row = listPrioritizedTasks({ now: NOW }).sections[0]!.tasks[0]!;
    expect(row.action).toBe("done?");
    expect(row.why.map((w) => w.factor)).toContain("gate");
    // Answered — the card is gone and the row goes back to its due-based section.
    writeDecision({ targetKind: "task", targetId: "t_pay", action: "answer_not_yet", new: { status: "open" } });
    expect(sectionOf("t_pay")).toBe("later");
  });

  it("due today or overdue is Today; a step firing today counts too", () => {
    task({ id: "t_today", title: "Collect the share", due: "2026-08-29" });
    task({ id: "t_late", title: "Call the owner", due: "2026-08-28" });
    task({
      id: "t_fire",
      title: "Watch the window",
      status: "scheduled",
      schedule: { fire_at: "2026-08-29T04:25:00.000Z", mode: "auto" },
    });
    expect(sectionOf("t_today")).toBe("today");
    expect(sectionOf("t_late")).toBe("today");
    expect(sectionOf("t_fire")).toBe("today");
  });

  it("inside 7 days is This week; beyond it, and no due at all, is Later", () => {
    task({ id: "t_week", title: "Packing list", due: "2026-09-01" });
    task({ id: "t_far", title: "Renew the passport", due: "2026-11-01" });
    task({ id: "t_none", title: "Read the villa reviews" });
    expect(sectionOf("t_week")).toBe("this_week");
    expect(sectionOf("t_far")).toBe("later");
    expect(sectionOf("t_none")).toBe("later");
  });

  it("another person's task, a monitor and a running task are Waiting on others", () => {
    task({ id: "t_theirs", title: "Karan books the cab", owner: "contact:karan", due: "2026-08-29" });
    task({ id: "t_monitor", title: "Follow up with Karan", category: "monitoring" });
    task({ id: "t_running", title: "Compare villas", status: "executing" });
    expect(sectionOf("t_theirs")).toBe("waiting");
    expect(sectionOf("t_monitor")).toBe("waiting");
    expect(sectionOf("t_running")).toBe("waiting");
    const waiting = listPrioritizedTasks({ now: NOW }).sections.find((s) => s.id === "waiting")!;
    expect(waiting.tasks.find((t) => t.id === "t_theirs")!.why.map((w) => w.factor)).toContain("waiting");
  });

  it("Done today holds today's closures only, and never a cancellation", () => {
    task({ id: "t_done", title: "Reply to Priya", status: "done", closedAt: "2026-08-29T02:00:00.000Z" });
    task({ id: "t_old", title: "Book flights", status: "done", closedAt: "2026-08-20T02:00:00.000Z" });
    task({ id: "t_cancelled", title: "Book the ferry", status: "cancelled", closedAt: "2026-08-29T02:00:00.000Z" });
    task({ id: "t_dormant", title: "Chase the refund", status: "dormant" });
    expect(sectionOf("t_done")).toBe("done_today");
    expect(sectionOf("t_old")).toBeNull();
    expect(sectionOf("t_cancelled")).toBeNull();
    expect(sectionOf("t_dormant")).toBeNull();
  });

  it("a schedule waiting for a confirm is Needs you, not a silent Later", () => {
    task({
      id: "t_proposed",
      title: "Pay the rent monthly",
      schedule: { fire_at: "2026-09-01T03:30:00.000Z", mode: "confirm", proposed: true },
    });
    expect(sectionOf("t_proposed")).toBe("needs_you");
    expect(listPrioritizedTasks({ now: NOW }).sections[0]!.tasks[0]!.action).toBe("confirm");
  });
});

describe("score", () => {
  it("is explained: every row carries the factors that produced it", () => {
    task({ id: "t_1", title: "Approve the payment", status: "needs_approval", category: "transaction", due: "2026-08-31" });
    const row = listPrioritizedTasks({ now: NOW }).sections[0]!.tasks[0]!;
    expect(row.score).toBe(row.why.reduce((s, f) => s + f.delta, 0));
    expect(row.why.map((f) => f.factor)).toEqual(["deadline", "gate", "value", "emotional"]);
    expect(row.why.find((f) => f.factor === "deadline")!.note).toBe("due in 2 days");
  });

  it("a task for the user alone with nobody waiting scores on its own merits", () => {
    task({ id: "t_solo", title: "Draft the packing list", due: "2026-08-29", category: "creation", risk: "auto" });
    const row = listPrioritizedTasks({ now: NOW }).sections.find((s) => s.id === "today")!.tasks[0]!;
    expect(row.why.some((f) => f.factor === "waiting")).toBe(false);
    expect(row.score).toBeGreaterThan(0);
  });

  it("overdue outranks due-today, and a pin outranks everything", () => {
    task({ id: "t_today", title: "A", due: "2026-08-29" });
    task({ id: "t_late", title: "B", due: "2026-08-27" });
    const today = () => listPrioritizedTasks({ now: NOW }).sections.find((s) => s.id === "today")!.tasks;
    expect(today().map((t) => t.id)).toEqual(["t_late", "t_today"]);
    writeDecision({ targetKind: "task", targetId: "t_today", action: "pin", new: { pinned: true } });
    expect(today().map((t) => t.id)).toEqual(["t_today", "t_late"]);
    expect(today()[0]!.why.find((f) => f.factor === "pin")!.delta).toBe(100);
    // Unpinned again — the pin factor is gone, the order returns.
    writeDecision({ targetKind: "task", targetId: "t_today", action: "unpin", new: { pinned: false } });
    expect(today().map((t) => t.id)).toEqual(["t_late", "t_today"]);
  });

  it("explicit beats implicit beats suggested at equal deadlines", () => {
    task({ id: "t_e", title: "A", type: "explicit", due: "2026-08-29", confidence: 0.8 });
    task({ id: "t_i", title: "B", type: "implicit", due: "2026-08-29", confidence: 0.8 });
    task({ id: "t_s", title: "C", type: "suggested", due: "2026-08-29", confidence: 0.8 });
    const today = listPrioritizedTasks({ now: NOW }).sections.find((s) => s.id === "today")!.tasks;
    expect(today.map((t) => t.id)).toEqual(["t_e", "t_i", "t_s"]);
    expect(today.find((t) => t.id === "t_s")!.suggested).toBe(true);
    expect(today.find((t) => t.id === "t_e")!.suggested).toBe(false);
  });
});

describe("scope", () => {
  it("is one list across every space, and narrows to one on request", () => {
    getDb().prepare(`INSERT INTO spaces (id, label, status, created_by) VALUES ('sp_2', 'Rent', 'active', 'test')`).run();
    task({ id: "t_a", title: "A", due: "2026-08-29" });
    task({ id: "t_b", title: "B", due: "2026-08-29", space: "sp_2" });
    task({ id: "t_loose", title: "C", due: "2026-08-29", space: null });
    expect(listPrioritizedTasks({ now: NOW }).total).toBe(3);
    expect(listPrioritizedTasks({ now: NOW, spaceId: "sp_2" }).total).toBe(1);
    const row = listPrioritizedTasks({ now: NOW }).sections.find((s) => s.id === "today")!.tasks.find((t) => t.id === "t_a")!;
    expect(row.space_label).toBe("Goa trip");
  });
});

// ===========================================================================
// T3 deep pass + graduation switch — build P4.3 (spec §15.3, §9.1).
// Stubbed clock, real DB, zero model calls.
//
//   t3:          cross-space linking (shared claim subjects, idempotent),
//                claim compression (evidence preserved in the decision row),
//                ephemeral expiry (reversible decision), summary re-queue,
//                eval hook, and the due/last-run bookkeeping.
//   graduation:  daily metrics from the decisions ledger; 14 consecutive
//                green days + real traffic flips propose→auto with an
//                announcement artifact; user revert is sticky; the commit
//                path's born-status follows the switch.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateGet } from "../db/ingest.js";
import { writeClaimVersion, linkClaimToSpace, claimHistory } from "../claims/store.js";
import { proposedStatus } from "../brain/commit.js";
import {
  runT3,
  t3Due,
  lastT3Report,
  COMPRESS_KEEP,
  EPHEMERAL_EXPIRY_DAYS,
  T3_EVAL_DUE_KEY,
} from "./t3.js";
import {
  checkGraduation,
  consecutiveGreenDays,
  graduationMode,
  recordGraduationMetrics,
  setGraduationMode,
  spaceCreationStatus,
  GRADUATION_MODE_KEY,
  GRADUATION_REQUIRED_DAYS,
} from "./graduation.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-t3-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertSpace(id: string, status = "active", extra: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO spaces (id, label, status, permanence, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `space ${id}`,
      status,
      (extra.permanence as string) ?? null,
      (extra.updated_at as string) ?? new Date().toISOString(),
      (extra.created_at as string) ?? new Date().toISOString(),
    );
}

function writeClaim(claimKey: string, subjectId: string, statedAt: string, text = "t"): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO entities (id, type, canonical) VALUES (?, 'person', ?)`)
    .run(subjectId, subjectId);
  writeClaimVersion({
    claimKey,
    kind: "fact",
    subjectId,
    text,
    confidence: 0.9,
    statedAt,
    evidence: [{ event_ids: [`ev_${claimKey}`], quote: text }],
    decidedBy: "test",
  });
}

// ---------------------------------------------------------------------------
// T3
// ---------------------------------------------------------------------------

describe("T3 deep pass", () => {
  it("links active spaces sharing enough claim subjects — once", async () => {
    insertSpace("sp_a");
    insertSpace("sp_b");
    // Two shared subjects between the spaces' claims.
    writeClaim("ck_a1", "ent_x", "2026-08-01T00:00:00Z");
    writeClaim("ck_a2", "ent_y", "2026-08-01T00:00:00Z");
    writeClaim("ck_b1", "ent_x", "2026-08-02T00:00:00Z");
    writeClaim("ck_b2", "ent_y", "2026-08-02T00:00:00Z");
    linkClaimToSpace("sp_a", "ck_a1");
    linkClaimToSpace("sp_a", "ck_a2");
    linkClaimToSpace("sp_b", "ck_b1");
    linkClaimToSpace("sp_b", "ck_b2");

    const first = await runT3({ evalHook: () => {} });
    expect(first.crossLinks).toBe(1);
    const links = getDb().prepare(`SELECT * FROM space_links`).all() as {
      a_space_id: string;
      b_space_id: string;
    }[];
    expect(links).toHaveLength(1);
    expect([links[0]!.a_space_id, links[0]!.b_space_id].sort()).toEqual(["sp_a", "sp_b"]);
    // A link decision was written.
    const dec = getDb()
      .prepare(`SELECT * FROM decisions WHERE target_kind = 'space_link' AND action = 'link'`)
      .all();
    expect(dec).toHaveLength(1);

    // Idempotent: the second run links nothing new.
    const second = await runT3({ evalHook: () => {} });
    expect(second.crossLinks).toBe(0);
    expect(getDb().prepare(`SELECT COUNT(*) n FROM space_links`).get()).toEqual({ n: 1 });
  });

  it("compresses old claim versions and preserves their evidence", async () => {
    // 6 versions of one claim: active + 5 non-active; keep 3, compress 2.
    for (let i = 1; i <= 6; i++) {
      writeClaim("ck_many", "ent_z", `2026-08-0${i}T00:00:00Z`, `version ${i}`);
    }
    expect(claimHistory("ck_many")).toHaveLength(6);

    const report = await runT3({ evalHook: () => {} });
    expect(report.claimVersionsCompressed).toBe(6 - 1 - COMPRESS_KEEP);

    const left = claimHistory("ck_many");
    expect(left).toHaveLength(1 + COMPRESS_KEEP);
    // The newest (active) version survived.
    expect(left.map((v) => v.text)).toContain("version 6");

    // Evidence preserved: the compress decision's old_json carries the full
    // deleted rows, evidence included.
    const dec = getDb()
      .prepare(
        `SELECT old_json FROM decisions WHERE target_kind = 'claim' AND action = 'compress'
          AND target_id = 'ck_many'`,
      )
      .get() as { old_json: string };
    const archived = JSON.parse(dec.old_json) as { versions: { evidence_json: string }[] };
    expect(archived.versions).toHaveLength(2);
    for (const v of archived.versions) {
      expect(String(v.evidence_json)).toContain("ev_ck_many");
    }

    // Idempotent: nothing more to compress on a second run.
    const again = await runT3({ evalHook: () => {} });
    expect(again.claimVersionsCompressed).toBe(0);
  });

  it("archives idle ephemeral spaces reversibly and leaves the rest", async () => {
    const old = new Date(Date.now() - (EPHEMERAL_EXPIRY_DAYS + 5) * 86_400_000).toISOString();
    insertSpace("sp_eph", "active", { permanence: "ephemeral", updated_at: old, created_at: old });
    insertSpace("sp_perm", "active", { permanence: "permanent", updated_at: old, created_at: old });
    insertSpace("sp_fresh", "active", { permanence: "ephemeral" });

    const report = await runT3({ evalHook: () => {} });
    expect(report.ephemeralArchived).toBe(1);
    const rows = getDb().prepare(`SELECT id, status FROM spaces ORDER BY id`).all() as {
      id: string;
      status: string;
    }[];
    expect(rows.find((r) => r.id === "sp_eph")!.status).toBe("archived");
    expect(rows.find((r) => r.id === "sp_perm")!.status).toBe("active");
    expect(rows.find((r) => r.id === "sp_fresh")!.status).toBe("active");
    // Reversible: the decision's old_json holds the pre-archive row.
    const dec = getDb()
      .prepare(
        `SELECT old_json FROM decisions WHERE target_kind = 'space' AND action = 'archive'
          AND target_id = 'sp_eph'`,
      )
      .get() as { old_json: string };
    expect((JSON.parse(dec.old_json) as { status: string }).status).toBe("active");
  });

  it("re-queues stale summaries, fires the eval hook, and tracks due-ness", async () => {
    const now = new Date("2026-08-28T12:00:00Z");
    insertSpace("sp_stale", "active", { updated_at: "2026-08-01T00:00:00Z" });
    getDb()
      .prepare(
        `INSERT INTO episodes (id, space_id, state, summary, created_at)
         VALUES ('ep_new', 'sp_stale', 'open', 's', '2026-08-20T00:00:00Z')`,
      )
      .run();

    let hooked = 0;
    expect(t3Due(now)).toBe(true);
    const report = await runT3({ now, evalHook: () => void hooked++ });
    expect(report.summariesQueued).toBe(1);
    expect(getDb().prepare(`SELECT COUNT(*) n FROM decide_queue`).get()).toEqual({ n: 1 });
    expect(hooked).toBe(1);
    expect(report.evalHookFired).toBe(true);

    // Bookkeeping: not due again inside the window; report stored.
    expect(t3Due(new Date(now.getTime() + 3_600_000))).toBe(false);
    expect(t3Due(new Date(now.getTime() + 25 * 3_600_000))).toBe(true);
    expect(lastT3Report()?.ranAt).toBe(now.toISOString());

    // Without a hook the run marks the golden set due instead.
    const later = new Date(now.getTime() + 26 * 3_600_000);
    await runT3({ now: later });
    expect(appStateGet(T3_EVAL_DUE_KEY)).toBe(later.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Graduation
// ---------------------------------------------------------------------------

/** Seed one day's ledger: n proposals, r user rejections, m reversed merges. */
function seedDay(day: string, n: number, r = 0, m = 0): void {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO decisions (id, pass, target_kind, target_id, action, reversed_at, created_at)
     VALUES (?, ?, 'space', ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++)
    ins.run(`d_${day}_p${i}`, "orient", `sp_${day}_${i}`, "propose", null, `${day}T10:00:00.000Z`);
  for (let i = 0; i < r; i++)
    ins.run(`d_${day}_r${i}`, "user", `sp_${day}_${i}`, "reject", null, `${day}T11:00:00.000Z`);
  for (let i = 0; i < m; i++)
    ins.run(`d_${day}_m${i}`, "code:t2", `sp_${day}_${i}`, "merge", `${day}T12:00:00.000Z`, `${day}T09:00:00.000Z`);
}

function dayStr(base: Date, back: number): string {
  return new Date(base.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

describe("graduation switch", () => {
  const now = new Date("2026-08-28T09:00:00Z");

  it("measures a day's gates from the decisions ledger", () => {
    const day = dayStr(now, 1);
    seedDay(day, 10, 3); // 30% over-creation — gate fails
    const row = recordGraduationMetrics(day);
    expect(row.proposals).toBe(10);
    expect(row.userRejections).toBe(3);
    expect(row.overCreationPct).toBeCloseTo(30);
    expect(row.gatesOk).toBe(false);

    const day2 = dayStr(now, 2);
    seedDay(day2, 10, 0, 1); // a reversed auto-merge — hard gate fails
    expect(recordGraduationMetrics(day2).gatesOk).toBe(false);

    const day3 = dayStr(now, 3);
    seedDay(day3, 20, 1); // 5% — green
    expect(recordGraduationMetrics(day3).gatesOk).toBe(true);
  });

  it("flips to auto-create after 14 consecutive green days, with announcement", () => {
    // Clock-mocked integration: 14 green days ending yesterday.
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      const day = dayStr(now, back);
      seedDay(day, 3, 0);
      recordGraduationMetrics(day);
    }
    expect(consecutiveGreenDays(now)).toBe(GRADUATION_REQUIRED_DAYS);
    expect(spaceCreationStatus()).toBe("proposed");

    const check = checkGraduation(now);
    expect(check.flipped).toBe(true);
    expect(graduationMode()).toBe("auto");
    expect(spaceCreationStatus()).toBe("active");
    expect(proposedStatus()).toBe("active"); // the commit path follows

    // The flip is a decision row and an announcement artifact.
    const dec = getDb()
      .prepare(
        `SELECT * FROM decisions WHERE target_kind = 'setting' AND target_id = ?`,
      )
      .all(GRADUATION_MODE_KEY);
    expect(dec).toHaveLength(1);
    const art = getDb()
      .prepare(`SELECT * FROM artifacts WHERE kind = 'announcement'`)
      .all() as { title: string }[];
    expect(art).toHaveLength(1);
    expect(art[0]!.title).toMatch(/auto-create/i);

    // Idempotent: a second check neither re-flips nor re-announces.
    expect(checkGraduation(now).flipped).toBe(false);
    expect(getDb().prepare(`SELECT COUNT(*) n FROM artifacts`).get()).toEqual({ n: 1 });
  });

  it("does NOT flip on a streak broken by a red or missing day, or without traffic", () => {
    // 13 green days + one red day inside the window.
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      const day = dayStr(now, back);
      seedDay(day, 3, back === 7 ? 2 : 0); // day-7: 66% over-creation
      recordGraduationMetrics(day);
    }
    expect(checkGraduation(now).flipped).toBe(false);
    expect(graduationMode()).toBe("propose");

    // Green streak but near-zero traffic: vacuous truth must not graduate.
    getDb().prepare(`DELETE FROM graduation_metrics`).run();
    getDb().prepare(`DELETE FROM decisions`).run();
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      recordGraduationMetrics(dayStr(now, back)); // 0 proposals — green, empty
    }
    const check = checkGraduation(now);
    expect(check.consecutiveGreen).toBeGreaterThanOrEqual(GRADUATION_REQUIRED_DAYS);
    expect(check.flipped).toBe(false);
  });

  it("user revert is sticky: the auto-flip never re-fires on its own", () => {
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      const day = dayStr(now, back);
      seedDay(day, 3, 0);
      recordGraduationMetrics(day);
    }
    expect(checkGraduation(now).flipped).toBe(true);

    // The user reverts in Settings.
    setGraduationMode("propose", "user");
    expect(graduationMode()).toBe("propose");
    expect(spaceCreationStatus()).toBe("proposed");

    // Gates still green — but the override holds.
    expect(checkGraduation(now).flipped).toBe(false);
    expect(graduationMode()).toBe("propose");

    // The user can still opt back in by hand.
    setGraduationMode("auto", "user");
    expect(spaceCreationStatus()).toBe("active");
  });
});

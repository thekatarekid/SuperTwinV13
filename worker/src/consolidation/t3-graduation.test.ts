// ===========================================================================
// T3 deep pass + graduation switch — build P4.3 (spec §15.3, §9.1).
// Stubbed clock, real DB, zero model calls.
//
//   t3:          cross-space linking (shared claim subjects, idempotent),
//                claim compression (evidence preserved in the decision row),
//                ephemeral expiry (reversible decision), summary re-queue,
//                eval hook, and the due/last-run bookkeeping.
//   spaces:      a fresh install is PROPOSE-ONLY (V6 P1 S5.1), two clean
//                weeks on the gates graduate it to auto-create, a false
//                auto-merge resets the clock, the user's hand-set choice is
//                sticky both ways, and the commit path's born-status follows.
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
  T3_CLOSED_BY,
  T3_EVAL_DUE_KEY,
} from "./t3.js";
import {
  checkGraduation,
  consecutiveGreenDays,
  graduationMode,
  graduationUserReverted,
  recordGraduationMetrics,
  setGraduationMode,
  spaceCreationStatus,
  DEFAULT_GRADUATION_MODE,
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

  it("compresses old claim versions by giving them an END DATE — nothing deleted (CON-03)", async () => {
    // 6 versions of one claim: active + 5 non-active; keep 3 open-ended, end 2.
    for (let i = 1; i <= 6; i++) {
      writeClaim("ck_many", "ent_z", `2026-08-0${i}T00:00:00Z`, `version ${i}`);
    }
    expect(claimHistory("ck_many")).toHaveLength(6);

    const report = await runT3({ evalHook: () => {} });
    expect(report.claimVersionsCompressed).toBe(6 - 1 - COMPRESS_KEEP);

    // Every row is still there: the history is the same length.
    const left = claimHistory("ck_many");
    expect(left).toHaveLength(6);
    expect(left.map((v) => v.text)).toContain("version 6");
    // The two oldest non-active versions carry an end date and name the pass;
    // the active version and the newest COMPRESS_KEEP non-active are untouched.
    const rows = getDb()
      .prepare(`SELECT text, valid_to, closed_by FROM claim_versions WHERE claim_key = 'ck_many' ORDER BY stated_at`)
      .all() as { text: string; valid_to: string | null; closed_by: string | null }[];
    expect(rows.filter((r) => r.closed_by === T3_CLOSED_BY).map((r) => r.text)).toEqual(["version 1", "version 2"]);
    expect(rows[0]!.valid_to).toBe("2026-08-02T00:00:00Z"); // the successor's stated_at
    expect(rows[1]!.valid_to).toBe("2026-08-03T00:00:00Z");
    for (const r of rows.slice(2)) {
      expect(r.closed_by).toBeNull();
      expect(r.valid_to).toBeNull();
    }
    // Evidence preserved on the rows themselves — nothing had to be copied out.
    for (const v of left) expect(String(v.evidence[0]?.event_ids?.[0] ?? "")).toContain("ev_ck_many");

    // ONE decision per claim_key names the ended versions (the undo unit).
    const dec = getDb()
      .prepare(
        `SELECT old_json, new_json FROM decisions WHERE target_kind = 'claim' AND action = 'compress'
          AND target_id = 'ck_many'`,
      )
      .all() as { old_json: string; new_json: string }[];
    expect(dec).toHaveLength(1);
    const ended = JSON.parse(dec[0]!.new_json) as { endedVersions: { id: string; valid_to: string }[] };
    expect(ended.endedVersions).toHaveLength(2);

    // Idempotent: nothing more to end on a second run.
    const again = await runT3({ evalHook: () => {} });
    expect(again.claimVersionsCompressed).toBe(0);
    expect(claimHistory("ck_many")).toHaveLength(6);
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

describe("space-creation mode (V6 P1 S5.1: propose-only → graduation → reset)", () => {
  const now = new Date("2026-08-28T09:00:00Z");

  it("a FRESH INSTALL is PROPOSE-ONLY: no app_state row, inferred spaces born proposed", () => {
    expect(appStateGet(GRADUATION_MODE_KEY)).toBeNull();
    expect(DEFAULT_GRADUATION_MODE).toBe("propose");
    expect(graduationMode()).toBe("propose");
    expect(spaceCreationStatus()).toBe("proposed");
    expect(proposedStatus()).toBe("proposed"); // the commit path follows

    // Zero measured days: nothing graduates, nothing flips.
    expect(consecutiveGreenDays(now)).toBe(0);
    const check = checkGraduation(now);
    expect(check.mode).toBe("propose");
    expect(check.flipped).toBeNull();
  });

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

  it("two clean weeks graduate propose-only to auto-create — one decision row (SPC-06)", () => {
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      const day = dayStr(now, back);
      seedDay(day, 3, 0);
      recordGraduationMetrics(day);
    }
    expect(consecutiveGreenDays(now)).toBe(GRADUATION_REQUIRED_DAYS);

    const check = checkGraduation(now);
    expect(check.consecutiveGreen).toBe(GRADUATION_REQUIRED_DAYS);
    expect(check.windowProposals).toBe(3 * GRADUATION_REQUIRED_DAYS);
    expect(check.flipped).toBe("graduated");
    expect(check.mode).toBe("auto");
    expect(graduationMode()).toBe("auto");
    expect(spaceCreationStatus()).toBe("active");
    const dec = getDb()
      .prepare(`SELECT pass, new_json FROM decisions WHERE target_kind = 'setting' AND target_id = ?`)
      .all(GRADUATION_MODE_KEY) as { pass: string; new_json: string }[];
    expect(dec).toHaveLength(1);
    expect(dec[0]!.pass).toBe("code:graduation");
    expect(JSON.parse(dec[0]!.new_json)).toEqual({ mode: "auto" });

    // Idempotent: a second tick on the same window flips nothing.
    expect(checkGraduation(now).flipped).toBeNull();
  });

  it("a red day inside the window does not graduate (over-creation gate)", () => {
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      const day = dayStr(now, back);
      seedDay(day, 3, back === 7 ? 2 : 0); // day-7: 66% over-creation
      recordGraduationMetrics(day);
    }
    const check = checkGraduation(now);
    expect(check.consecutiveGreen).toBeLessThan(GRADUATION_REQUIRED_DAYS);
    expect(check.mode).toBe("propose");
    expect(check.flipped).toBeNull();
    expect(spaceCreationStatus()).toBe("proposed");
  });

  it("fourteen silent days prove nothing: no proposals, no graduation", () => {
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) recordGraduationMetrics(dayStr(now, back));
    expect(consecutiveGreenDays(now)).toBe(GRADUATION_REQUIRED_DAYS);
    const check = checkGraduation(now);
    expect(check.windowProposals).toBe(0);
    expect(check.mode).toBe("propose");
    expect(check.flipped).toBeNull();
  });

  it("a false auto-merge after graduation resets the clock — back to propose-only (SPC-06)", () => {
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      seedDay(dayStr(now, back), 3, 0);
      recordGraduationMetrics(dayStr(now, back));
    }
    expect(checkGraduation(now).mode).toBe("auto");

    // Two days later a reversed auto-merge lands on "yesterday".
    const later = new Date(now.getTime() + 2 * 86_400_000);
    seedDay(dayStr(later, 1), 4, 0, 1);
    const check = checkGraduation(later);
    expect(check.flipped).toBe("reset");
    expect(check.mode).toBe("propose");
    expect(spaceCreationStatus()).toBe("proposed");
    expect(check.consecutiveGreen).toBe(0); // the streak restarts
    const flips = getDb()
      .prepare(`SELECT new_json FROM decisions WHERE target_kind = 'setting' AND target_id = ? ORDER BY rowid`)
      .all(GRADUATION_MODE_KEY) as { new_json: string }[];
    expect(flips.map((f) => JSON.parse(f.new_json).mode)).toEqual(["auto", "propose"]);
  });

  it("the user's choice is sticky both ways — code never overrides it", () => {
    // Propose-only by hand: a perfect window does NOT graduate behind their back.
    setGraduationMode("propose", "user");
    expect(graduationUserReverted()).toBe(true);
    for (let back = 1; back <= GRADUATION_REQUIRED_DAYS; back++) {
      seedDay(dayStr(now, back), 3, 0);
      recordGraduationMetrics(dayStr(now, back));
    }
    expect(checkGraduation(now).mode).toBe("propose");
    expect(checkGraduation(now).flipped).toBeNull();

    // Auto by hand: a false merge is shown red but does not flip them back.
    setGraduationMode("auto", "user");
    expect(graduationUserReverted()).toBe(false);
    expect(spaceCreationStatus()).toBe("active");
    const later = new Date(now.getTime() + 2 * 86_400_000);
    seedDay(dayStr(later, 1), 4, 0, 1);
    const check = checkGraduation(later);
    expect(check.flipped).toBeNull();
    expect(check.mode).toBe("auto");
  });
});

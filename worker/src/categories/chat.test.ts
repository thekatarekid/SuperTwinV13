// ===========================================================================
// CAT-01 · Chat category by user-reply (pure code) — deterministic layer.
//
// 40 streams; 12 replied; HDFC + Zepto transactional; Airtel promotional;
// the rest never-replied groups. Expected: 12 replied + HDFC + Zepto -> Cat 1;
// Airtel + never-replied groups -> Cat 2. Assignment is CODE-ONLY — the
// wrong[] here is `model-where-code-works`, asserted by the whole path being
// synchronous with no provider registered and no resolver seam at all.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { backfillChatCategories, chatCategoryFor } from "./chat.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cat01-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedStream(opts: {
  id: string;
  kind?: string;
  isBusiness?: boolean;
  tier?: string | null;
  replyCount?: number;
}): void {
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type, name) VALUES ('wa','wa','wa') ON CONFLICT(id) DO NOTHING`).run();
  db.prepare(
    `INSERT INTO streams (id, source_id, external_key, stream_kind, is_business, tier, reply_count)
     VALUES (?, 'wa', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.id,
    opts.kind ?? "group",
    opts.isBusiness ? 1 : 0,
    opts.tier ?? null,
    opts.replyCount ?? 0,
  );
}

describe("CAT-01 · chat category, pure code", () => {
  it("the §5.1 table as a pure function", () => {
    const base = { streamId: "s", isGroup: true, isBusiness: false, tier: null, userMessageCount: 0 };
    expect(chatCategoryFor({ ...base, userMessageCount: 3 })).toEqual({ category: "cat1", rule: "user-reply" });
    expect(chatCategoryFor({ ...base, isGroup: false })).toEqual({ category: "cat1", rule: "dm" });
    expect(chatCategoryFor({ ...base, isBusiness: true, tier: "T2" })).toEqual({ category: "cat1", rule: "business-transactional" });
    expect(chatCategoryFor({ ...base, isBusiness: true, tier: "T4" })).toEqual({ category: "cat2", rule: "business-promotional" });
    expect(chatCategoryFor(base)).toEqual({ category: "cat2", rule: "group-never-replied" });
  });

  it("40 streams: replied + transactional -> Cat 1; promo + never-replied -> Cat 2; zero model calls", () => {
    // 12 replied groups.
    for (let i = 0; i < 12; i++) seedStream({ id: `wa:st:replied-${i}@g.us`, replyCount: 1 + i });
    // 3 business streams: HDFC + Zepto transactional (T2), Airtel promo (T4).
    seedStream({ id: "wa:st:hdfc@s", kind: "dm", isBusiness: true, tier: "T2" });
    seedStream({ id: "wa:st:zepto@s", kind: "dm", isBusiness: true, tier: "T2" });
    seedStream({ id: "wa:st:airtel@s", kind: "dm", isBusiness: true, tier: "T4" });
    // 25 never-replied groups.
    for (let i = 0; i < 25; i++) seedStream({ id: `wa:st:passive-${i}@g.us` });

    // Code-only by construction: no provider is registered in this test, no
    // resolver is injected, and the call is synchronous — a model call has
    // nowhere to hide (`model-where-code-works`).
    const report = backfillChatCategories();
    expect(report.streams).toBe(40);
    expect(report.byCategory.cat1).toBe(14); // 12 replied + HDFC + Zepto
    expect(report.byCategory.cat2).toBe(26); // Airtel + 25 never-replied

    const cat = (id: string): string | null =>
      (getDb().prepare(`SELECT category FROM streams WHERE id = ?`).get(id) as { category: string | null }).category;
    expect(cat("wa:st:hdfc@s")).toBe("cat1");
    expect(cat("wa:st:zepto@s")).toBe("cat1");
    expect(cat("wa:st:airtel@s")).toBe("cat2"); // promo-in-cat1 is the wrong[]
    expect(cat("wa:st:replied-0@g.us")).toBe("cat1");
    expect(cat("wa:st:passive-0@g.us")).toBe("cat2");
  });

  it("every assignment writes a decisions row and is idempotent on re-run", () => {
    seedStream({ id: "wa:st:one@g.us", replyCount: 2 });
    const first = backfillChatCategories();
    expect(first.changes).toHaveLength(1);
    const rows = getDb()
      .prepare(`SELECT action, target_id FROM decisions WHERE target_kind = 'stream'`)
      .all() as { action: string; target_id: string }[];
    expect(rows).toEqual([{ action: "categorize", target_id: "wa:st:one@g.us" }]);
    // Second run: nothing changes, nothing is re-logged.
    const second = backfillChatCategories();
    expect(second.changes).toHaveLength(0);
  });

  it("an engagement-promoted cat1 stream is never demoted by re-derive (one-way)", () => {
    seedStream({ id: "wa:st:promoted@g.us" }); // never replied -> would derive cat2
    getDb().prepare(`UPDATE streams SET category = 'cat1' WHERE id = 'wa:st:promoted@g.us'`).run();
    backfillChatCategories();
    const cat = (getDb().prepare(`SELECT category FROM streams WHERE id = 'wa:st:promoted@g.us'`).get() as { category: string }).category;
    expect(cat).toBe("cat1");
  });
});

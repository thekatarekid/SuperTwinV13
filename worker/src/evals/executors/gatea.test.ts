// ===========================================================================
// GATE-A executor (V6 P1 S4.5): the three code cases run against the real
// fixtures in evals/v13 through the real approvals/ modules — sandboxed home
// (its own approval key), sandboxed DB, pinned clock, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetApprovalKeyCache } from "../../approvals/key.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { sendGateExecutor } from "./gatea.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-gatea-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  delete process.env.SUPERTWIN_APPROVAL_KEY;
  resetApprovalKeyCache();
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  resetApprovalKeyCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  return await sendGateExecutor({ fixture });
}

describe("GATE-A — the send gate", () => {
  it("GATE-A-01 — no token, no send", async () => {
    const r = await run("GATE-A-01");
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toEqual([]);
    expect(r.metrics?.sends).toBe(0);
    expect(r.metrics?.risky_without_token).toBe(0);
    expect(r.metrics?.model_calls).toBe(0);
    const out = r.output as { refusals: string[]; untapped_card_state: string };
    expect(out.refusals.every((x) => x !== "")).toBe(true);
    expect(out.untapped_card_state).toBe("pending");
    expect(r.gateObservations).toEqual([
      { gateId: "risky_without_token", passed: true, counted: true },
    ]);
  });

  it("GATE-A-02 — the token is single-use and bound", async () => {
    const r = await run("GATE-A-02");
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toEqual([]);
    const out = r.output as {
      re_aimed: string;
      re_worded: string;
      replay: string;
      sent: Array<{ to: string; text: string }>;
    };
    expect(out.re_aimed).toContain("different recipient");
    expect(out.re_worded).toContain("different recipient");
    expect(out.replay).toContain("already used");
    // Exactly the approved payload, exactly once.
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0].to).toBe("919812345678@s.whatsapp.net");
    expect(r.metrics?.risky_without_token).toBe(0);
  });

  it("GATE-A-03 — the card shows exactly what, and editing invalidates", async () => {
    const r = await run("GATE-A-03");
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toEqual([]);
    const out = r.output as {
      card_words: string[];
      after_edit_state: string;
      stale_token_usable: boolean;
      daemon_refused_stale: string;
      sent: Array<{ to: string; text: string }>;
      final_state: string;
    };
    expect(out.card_words.join("\n")).toContain("Rohan");
    expect(out.after_edit_state).toBe("pending");
    expect(out.stale_token_usable).toBe(false);
    expect(out.daemon_refused_stale).not.toBe("");
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0].text).toContain("leaving at 6");
    expect(out.final_state).toBe("sent");
  });

  it("leaves no rows behind — every case cleans its own world", async () => {
    await run("GATE-A-01");
    await run("GATE-A-02");
    await run("GATE-A-03");
    const cards = getDb().prepare(`SELECT COUNT(*) n FROM send_approvals`).get() as { n: number };
    const tokens = getDb().prepare(`SELECT COUNT(*) n FROM approval_tokens`).get() as { n: number };
    expect(cards.n).toBe(0);
    expect(tokens.n).toBe(0);
  });

  it("an id outside the family is PENDING, never a fake pass", async () => {
    const fixture = { ...loadFixture(join(FIX, "GATE-A-01.json")), id: "GATE-A-09" };
    const r = await sendGateExecutor({ fixture });
    expect(r.pending).toContain("GATE-A-09");
  });
});

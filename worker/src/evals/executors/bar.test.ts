// ===========================================================================
// BAR + FIX-07..09 executors (V6 P1 S5.5): the thirteen code cases run
// against the real fixtures in evals/v13 through the real bar, retrieval,
// sufficiency, route and corrections code — every model seam injected, so
// ZERO model calls. Each case sandboxes its own DB and its own drafts dir.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { barExecutor, fixExecutor } from "./bar.js";
import { registerProductExecutors } from "./index.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-bar-eval-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_EVAL_DRAFTS_DIR = join(tmpDir, "eval-drafts");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_EVAL_DRAFTS_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runBar(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("bar");
  return barExecutor({ fixture });
}

async function runFix(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("feedback");
  return fixExecutor({ fixture });
}

describe("registration", () => {
  it("registers `bar`, and `feedback` still answers for the V2 cases", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("bar");
    expect(registeredPasses()).toContain("feedback");
  });
});

describe("BAR — the ten grounded-bar cases", () => {
  const ids = ["BAR-01", "BAR-02", "BAR-03", "BAR-04", "BAR-05", "BAR-06", "BAR-07", "BAR-08", "BAR-09", "BAR-10"];

  for (const id of ids) {
    it(`${id} passes with no violations and no model calls`, async () => {
      const result = await runBar(id);
      expect(result.pending).toBeUndefined();
      expect(result.violations ?? []).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.metrics?.model_calls ?? 0).toBe(0);
    }, 30_000);
  }
});

describe("BAR — what the cases actually measured", () => {
  it("BAR-01 stays inside the 150 ms type-ahead budget with zero calls", async () => {
    const out = (await runBar("BAR-01")).output as { took_ms: number; model_calls: number; spaces: string[] };
    expect(out.model_calls).toBe(0);
    expect(out.took_ms).toBeLessThanOrEqual(150);
    expect(out.spaces.some((s) => s.includes("Goa"))).toBe(true);
  }, 30_000);

  it("BAR-02 classes every one of the six shapes", async () => {
    const out = (await runBar("BAR-02")).output as { classes: Record<string, string>; accuracy: number };
    expect(out.accuracy).toBe(1);
    expect(out.classes["how much on cabs last month"]).toBe("aggregate");
    expect(out.classes["gst on hotel rooms"]).toBe("general");
  });

  it("BAR-04 answers ₹1,020 through the structured method and never asks the judge", async () => {
    const out = (await runBar("BAR-04")).output as { method: string; value: number; judge_calls: number };
    expect(out).toMatchObject({ method: "structured", value: 1020, judge_calls: 0 });
  });

  it("BAR-05 scans the thread whole and carries the coverage caveat", async () => {
    const out = (await runBar("BAR-05")).output as { scanned: number; caveat: string; answer: string };
    expect(out.scanned).toBe(9);
    expect(out.caveat).toBe("I only have WhatsApp back to Jul 2026");
    expect(out.answer).toContain("wa:goa-gang");
  });

  it("BAR-08 puts the utterance on the bar's hot stream and writes no claims itself", async () => {
    const out = (await runBar("BAR-08")).output as {
      claims_written_by_bar: number;
      bar_messages: { origin: string | null; source: string | null; stream: string | null }[];
      lock: { kind: string };
    };
    expect(out.claims_written_by_bar).toBe(0);
    expect(out.bar_messages.every((m) => m.origin === "live" && m.source === "twin")).toBe(true);
    expect(out.lock.kind).toBe("space");
  });

  it("BAR-09 leaves exactly one space, renamed", async () => {
    const out = (await runBar("BAR-09")).output as { spaces: { label: string }[]; corrections: number };
    expect(out.spaces).toHaveLength(1);
    expect(out.spaces[0]!.label).toBe("Hampi trek Nov");
    expect(out.corrections).toBe(1);
  });

  it("BAR-10 asks once, is answered for free, and searches a bare line for free", async () => {
    const out = (await runBar("BAR-10")).output as {
      instruction: { status: string; options: unknown[]; tasks_written: number };
      answer: { status: string; space: string; model_calls: number };
      bare_question: { intent: string; model_calls: number };
    };
    expect(out.instruction).toMatchObject({ status: "needs_input", tasks_written: 0 });
    expect(out.instruction.options).toHaveLength(2);
    expect(out.answer).toMatchObject({ status: "done", space: "sp_a", model_calls: 0 });
    expect(out.bare_question).toMatchObject({ intent: "search", model_calls: 0 });
  });
});

describe("FIX-07..09 — the V6 correction cases", () => {
  for (const id of ["FIX-07", "FIX-08", "FIX-09"]) {
    it(`${id} passes with no violations and no model calls`, async () => {
      const result = await runFix(id);
      expect(result.pending).toBeUndefined();
      expect(result.violations ?? []).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.metrics?.model_calls ?? 0).toBe(0);
    }, 30_000);
  }

  it("FIX-07 reassigns, follows up, and undoes both halves", async () => {
    const out = (await runFix("FIX-07")).output as {
      owner_after: string;
      follow_up: { category: string; owner: string } | null;
      undo: { owner: string; follow_up_status: string | null };
    };
    expect(out.owner_after).toBe("karan");
    expect(out.follow_up).toMatchObject({ category: "monitoring", owner: "self" });
    expect(out.undo).toMatchObject({ owner: "self", follow_up_status: "dismissed" });
  });

  it("FIX-08 writes one scoped rule that fires in its context and nowhere else", async () => {
    const out = (await runFix("FIX-08")).output as {
      rules: { rule: string; scope: string }[];
      suppresses_next: number;
      leaves_alone: number;
      settings_list: number;
    };
    expect(out.rules).toHaveLength(1);
    expect(out.rules[0]).toMatchObject({ rule: "no cards while YouTube is frontmost", scope: "router" });
    expect(out.suppresses_next).toBe(1);
    expect(out.leaves_alone).toBe(0);
    expect(out.settings_list).toBe(1);
  });

  it("FIX-09 drafts a golden case for the correction that failed to parse too", async () => {
    const out = (await runFix("FIX-09")).output as {
      corrections: { status: string }[];
      on_disk: number;
    };
    expect(out.corrections.map((c) => c.status).sort()).toEqual(["applied", "pending"]);
    expect(out.on_disk).toBe(2);
  });
});

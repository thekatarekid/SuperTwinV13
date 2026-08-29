// ===========================================================================
// Intelligence › model + reasoning level, over the wire (defect 6).
//
// The picker used to be three strings and one dropdown. What is checked here
// is the part only the route can get wrong now that it is neither:
//
//   - the served list is the models this build can REACH, each with a version
//     and a price, and it says whether it was discovered or curated;
//   - a reasoning level ROUND-TRIPS, and is refused when the selected model
//     does not offer it — a stored level the runner would silently drop is
//     the same defect wearing a second dropdown;
//   - a model change that invalidates the level clears it rather than leaving
//     the pair (model, level) impossible;
//   - both changes are eval-gated, like every other model change (§18).
//
// Nothing here calls a model: the provider is a stub and discovery reads bytes.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "st-settings-thinking-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = join(tmpDir, "home");
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { runMigrations } = await import("../db/index.js");
const { getDb } = await import("../db/connection.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const { reasoningForPass, storedThinkingForPass } = await import("../brain/reasoning.js");

type ServerHandle = { port: number; close(): Promise<void> };

interface ModelRow {
  id: string;
  label: string;
  alias: boolean;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  thinking_levels: string[];
  effort: boolean;
}

interface StepRow {
  key: string;
  selected: string;
  thinking: string;
  thinking_levels: string[];
}

interface Intelligence {
  default_model: string;
  default_thinking: string;
  discovery: { mode: string; source: string; error: string | null };
  models: ModelRow[];
  steps: StepRow[];
}

let server: ServerHandle;
let base: string;

async function intelligence(): Promise<Intelligence> {
  const res = await fetch(`${base}/api/settings/intelligence`);
  return (await res.json()) as Intelligence;
}

async function post(body: unknown): Promise<{ status: number; body: { error?: string } }> {
  const res = await fetch(`${base}/api/settings/intelligence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

function step(s: Intelligence, key: string): StepRow {
  return s.steps.find((x) => x.key === key)!;
}

beforeAll(async () => {
  runMigrations();
  register({
    id: "claude-local",
    send: async () => ({
      sessionId: "",
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      freshFallback: false,
      status: "ok" as const,
    }),
    cancel: () => false,
  });
  server = await startServer({ port: 0, media: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("the list the picker is served", () => {
  it("is versioned, priced, and says where it came from", async () => {
    const s = await intelligence();
    expect(["discovered", "fallback"]).toContain(s.discovery.mode);
    expect(s.models.length).toBeGreaterThan(3); // never again just haiku/sonnet/opus
    const versioned = s.models.filter((m) => !m.alias);
    expect(versioned.length).toBeGreaterThan(0);
    for (const m of versioned) {
      // A version identifier, not a bare family name.
      expect(m.id).toMatch(/^claude-/);
      expect(m.input_per_mtok).not.toBeNull();
      expect(m.output_per_mtok).not.toBeNull();
    }
    // At least one model in the list has a real reasoning ladder, and at least
    // the possibility of one with none is representable.
    expect(s.models.some((m) => m.thinking_levels.length > 0)).toBe(true);
  });

  it("still accepts the aliases every pre-fix install has persisted", async () => {
    const s = await intelligence();
    for (const id of ["haiku", "sonnet", "opus"]) {
      expect(s.models.some((m) => m.id === id)).toBe(true);
    }
    expect(s.default_model).toBe("haiku");
    expect(s.default_thinking).toBe("off");
  });
});

describe("the reasoning level round-trips", () => {
  it("persists, is served back, and reaches the runner", async () => {
    const before = await intelligence();
    expect(step(before, "decide").thinking).toBe("off");
    // "off" costs nothing and sends nothing — the pre-fix behaviour exactly.
    expect(reasoningForPass("decide", "haiku")).toEqual({});

    const levels = step(before, "decide").thinking_levels;
    expect(levels).toContain("high");
    expect((await post({ step: "decide", thinking: "high" })).status).toBe(200);

    const after = await intelligence();
    expect(step(after, "decide").thinking).toBe("high");
    expect(storedThinkingForPass("decide")).toBe("high");
    // And the runner actually sends it. "haiku" resolves to a model with the
    // token-budget ladder, so it is a budget rather than an --effort level.
    expect(reasoningForPass("decide", "haiku")).toEqual({ thinkingBudget: "high" });
  });

  it("sends --effort for a model whose levels are effort levels", async () => {
    const s = await intelligence();
    const effortModel = s.models.find((m) => m.effort && m.thinking_levels.includes("high"));
    expect(effortModel).toBeTruthy();
    expect((await post({ step: "extract", model: effortModel!.id })).status).toBe(200);
    expect((await post({ step: "extract", thinking: "high" })).status).toBe(200);
    expect(reasoningForPass("extract", effortModel!.id)).toEqual({
      thinkingBudget: "high",
      effort: "high",
    });
  });

  it("refuses a level the selected model does not offer", async () => {
    const s = await intelligence();
    const noDial = s.models.find((m) => m.thinking_levels.length === 0);
    if (noDial) {
      expect((await post({ step: "digest", model: noDial.id })).status).toBe(200);
      const refused = await post({ step: "digest", thinking: "high" });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/no reasoning levels/);
    }
    // A level that is not a level at all is refused whatever the model is.
    const bogus = await post({ step: "digest", thinking: "turbo" });
    expect(bogus.status).toBe(400);
  });

  it("clears a level the NEW model cannot honour when the model changes", async () => {
    await post({ step: "critic.v4", model: "sonnet" });
    await post({ step: "critic.v4", thinking: "xhigh" });
    expect(storedThinkingForPass("critic.v4")).toBe("xhigh");

    const s = await intelligence();
    const noDial = s.models.find((m) => m.thinking_levels.length === 0);
    if (!noDial) return; // a catalogue where every model reasons: nothing to clear
    expect((await post({ step: "critic.v4", model: noDial.id })).status).toBe(200);
    // The stored pair must always be one the runner can send.
    expect(storedThinkingForPass("critic.v4")).toBe("off");
    expect(step(await intelligence(), "critic.v4").thinking).toBe("off");
  });
});

describe("the eval gate covers both dials", () => {
  it("writes a decision row and marks the golden set due for a level change", async () => {
    getDb().prepare(`DELETE FROM decisions WHERE target_id = ?`).run("selected_thinking_digest");
    await post({ step: "digest", model: "sonnet" });
    await post({ step: "digest", thinking: "medium" });
    const rows = getDb()
      .prepare(`SELECT * FROM decisions WHERE target_id = 'selected_thinking_digest'`)
      .all() as { action: string; new_json: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("update");
    expect(JSON.parse(rows[0]!.new_json)).toEqual({ thinking: "medium" });
    const due = getDb()
      .prepare(`SELECT value FROM app_state WHERE key = 'consolidation.t3_eval_regression_due'`)
      .get() as { value: string } | undefined;
    expect(due?.value).toBeTruthy();
  });

  it("refuses a model this build cannot reach", async () => {
    const bad = await post({ step: "digest", model: "gpt-4" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/reach/);
  });
});

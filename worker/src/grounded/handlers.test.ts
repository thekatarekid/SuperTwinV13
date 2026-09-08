// ===========================================================================
// Grounded-bar handlers (build P4.1, spec §14.8, USR-01…05). No live model
// calls: the answer/action calls are injected stubs. The load-bearing suite
// is the USR-04 hard gate — enforceCitations is a CODE assertion: an answer
// with claims but no resolvable citations is refused, an invented event id
// resolves to nothing and is refused, and the honest no-answer passes clean.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent } from "../db/eventlog.js";
import {
  setActiveProvider,
  setProviderModelSelection,
} from "../db/settings.js";
import { BAR_ANSWER_INSTRUCTIONS, BAR_ANSWER_VERSION } from "../prompts/bar-answer.v1.js";
import {
  registerV2,
  resetProviderRegistryForTests,
} from "../providers/registry.js";
import {
  CHATGPT_DEFAULT_OUTPUT_TOKEN_TARGET,
  ProviderSelectionError,
} from "../providers/selection.js";
import type {
  NeutralProviderResult,
  ProviderAuthState,
  ProviderCapabilities,
  ProviderModel,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderId,
  ProviderV2,
} from "../providers/types.js";
import { emptyUsage } from "../providers/usage.js";
import { ProviderGateError } from "../providers/gate.js";
import {
  answerViaModel,
  applyAction,
  enforceCitations,
  handleQuestion,
  handleSearch,
  NOTHING_TEXT,
} from "./handlers.js";
import type { Citation } from "../server/chat-grounding.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-grounded-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  resetProviderRegistryForTests();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureModel(
  overrides: Partial<ProviderModel> = {},
): ProviderModel {
  return {
    id: "gpt-grounded",
    displayName: "Grounded fixture",
    isDefault: true,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues: ["none", "low", "medium", "high", "xhigh"],
    defaultReasoning: "none",
    supportsTools: false,
    supportsHostTools: false,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    billingLabel: null,
    ...overrides,
  };
}

class GroundedProviderFixture implements ProviderV2 {
  readonly displayName = "Grounded fixture";
  readonly capabilities: ProviderCapabilities = {
    functionTools: false,
    hostTools: false,
    continuation: false,
    requiresAuthentication: false,
  };
  readonly requests: ProviderRequest[] = [];

  constructor(
    private readonly selectedModel = fixtureModel(),
    readonly id: ProviderId = "chatgpt-oauth",
  ) {}

  authState(): ProviderAuthState {
    return { status: "ready", error: null };
  }

  catalogue(): ProviderModelCatalogue {
    return {
      providerId: this.id,
      mode: "discovered",
      source: "grounded-test",
      discoveredAt: "2026-09-08T00:00:00.000Z",
      revision: "grounded-test-r1",
      error: null,
      models: [this.selectedModel],
    };
  }

  async send(request: ProviderRequest): Promise<NeutralProviderResult> {
    this.requests.push(request);
    request.onEvent({ type: "continuation", token: "provider-secret-continuation" });
    request.onEvent({ type: "delta", text: "grounded answer" });
    return {
      continuation: "provider-secret-continuation",
      usage: { ...emptyUsage(), inputTokens: 11, outputTokens: 3 },
      freshFallback: false,
      status: "ok",
    };
  }

  cancel(): boolean {
    return false;
  }

  killAll(): void {}
}

function seedEvent(text: string, streamKey = "911234@g.us"): string {
  const { id } = appendEvent({
    ts: new Date().toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  });
  return id;
}

describe("enforceCitations — the USR-04 hard gate (code assertion)", () => {
  const cite = (id: string, n = 1): Citation => ({ n, kind: "event", id, label: "rohan · villa" });

  it("passes an answer whose citations resolve to real events", () => {
    const out = enforceCitations("₹6k/night max [1]", [cite("evt_real")], (id) => id === "evt_real");
    expect(out.grounded).toBe(true);
    expect(out.answer).toBe("₹6k/night max [1]");
    expect(out.citations).toHaveLength(1);
    expect(out.refused_uncited).toBe(false);
  });

  it("REFUSES an uncited answer — claims with zero citations never ship", () => {
    const out = enforceCitations("₹6k/night max, Rohan confirmed", [], () => true);
    expect(out.grounded).toBe(false);
    expect(out.refused_uncited).toBe(true);
    expect(out.answer).toBe(NOTHING_TEXT);
    expect(out.citations).toEqual([]);
  });

  it("REFUSES hallucinated-recall: an invented event id resolves to nothing", () => {
    const out = enforceCitations("they said 8k [1]", [cite("evt_invented")], () => false);
    expect(out.grounded).toBe(false);
    expect(out.refused_uncited).toBe(true);
    expect(out.answer).toBe(NOTHING_TEXT);
  });

  it("drops the invalid citation but keeps the answer when one resolves", () => {
    const out = enforceCitations(
      "6k max [1], 20k total [2]",
      [cite("evt_real", 1), cite("evt_fake", 2)],
      (id) => id === "evt_real",
    );
    expect(out.grounded).toBe(true);
    expect(out.citations.map((c) => c.id)).toEqual(["evt_real"]);
  });

  it("lets the honest no-answer through with no citations", () => {
    const out = enforceCitations(NOTHING_TEXT, [], () => true);
    expect(out.grounded).toBe(false);
    expect(out.refused_uncited).toBe(false);
    expect(out.answer).toBe(NOTHING_TEXT);
  });
});

describe("handleQuestion", () => {
  it("declines without a model call when retrieval finds nothing", async () => {
    const call = vi.fn(async () => "never");
    const out = await handleQuestion("what did rohan say about the villa budget?", [], call);
    expect(out.grounded).toBe(false);
    expect(out.answer).toBe(NOTHING_TEXT);
    expect(call).not.toHaveBeenCalled();
  });

  it("answers with citations when the stubbed model cites a real event", async () => {
    const id = seedEvent("max 6k a night yaar for the villa budget");
    const seen: string[] = [];
    const call = vi.fn(async (user: string) => {
      seen.push(user);
      return `₹6k/night max [1]\nCITATIONS: [{"n":1,"kind":"event","id":"${id}","label":"rohan · villa"}]`;
    });
    const out = await handleQuestion("what did rohan say about the villa budget?", [], call);
    expect(call).toHaveBeenCalledOnce();
    // The packed input carries the retrieved context block.
    expect(seen[0]).toContain("supertwin-context");
    expect(out.grounded).toBe(true);
    expect(out.citations[0]!.id).toBe(id);
  });

  it("refuses in code when the stubbed model answers without citations", async () => {
    seedEvent("max 6k a night yaar for the villa budget");
    const call = vi.fn(async () => "I recall it being about ₹8k per night.");
    const out = await handleQuestion("what did rohan say about the villa budget?", [], call);
    expect(out.grounded).toBe(false);
    expect(out.refused_uncited).toBe(true);
    expect(out.answer).toBe(NOTHING_TEXT);
  });
});

describe("answerViaModel — provider-neutral grounded request", () => {
  it("dispatches through the resolved provider with exact prompt and closed capabilities", async () => {
    const provider = new GroundedProviderFixture();
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-grounded");

    const packed = "<supertwin-context>exact bytes</supertwin-context>\n\nQUESTION where?";
    await expect(answerViaModel(packed)).resolves.toBe("grounded answer");

    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request).toMatchObject({
      model: "gpt-grounded",
      instructions: BAR_ANSWER_INSTRUCTIONS,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: packed }],
      }],
      hostTools: [],
      toolChoice: "none",
      persistContinuation: false,
      plainCompletion: true,
      skipHostSettings: true,
      maxOutputTokens: 4_096,
      maxAgentTurns: 1,
      timeoutMs: 120_000,
      reasoning: { budget: "off" },
    });
    expect(Object.hasOwn(request, "continuation")).toBe(false);
    expect(Object.hasOwn(request, "tools")).toBe(false);
    expect(Object.hasOwn(request, "cache")).toBe(false);

    const run = getDb().prepare(
      `SELECT role, model, kind, pass, status FROM runs WHERE kind = ?`,
    ).get(BAR_ANSWER_VERSION);
    expect(run).toMatchObject({
      role: "chat",
      model: "gpt-grounded",
      kind: BAR_ANSWER_VERSION,
      pass: BAR_ANSWER_VERSION,
      status: "ok",
    });
    const log = getDb().prepare(
      `SELECT provider, model, role, kind, prompt_chars, status
         FROM extraction_runs WHERE kind = ?`,
    ).get(BAR_ANSWER_VERSION);
    expect(log).toMatchObject({
      provider: provider.id,
      model: "gpt-grounded",
      role: "chat",
      kind: BAR_ANSWER_VERSION,
      prompt_chars: packed.length + BAR_ANSWER_INSTRUCTIONS.length,
      status: "ok",
    });
    expect(JSON.stringify({ run, log })).not.toContain("provider-secret-continuation");
  });

  it("requests ChatGPT cache only when the resolved model advertises both cache fields", async () => {
    const provider = new GroundedProviderFixture(fixtureModel({
      supportsPromptCacheKey: true,
      supportsPromptCacheOptions: true,
    }));
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-grounded");

    await answerViaModel("exact grounded input");
    expect(provider.requests[0]?.cache).toEqual({ mode: "implicit" });
  });

  it.each([
    { supportsPromptCacheKey: true },
    { supportsPromptCacheOptions: true },
  ])("omits ChatGPT cache when support is only partial", async (capabilities) => {
    const provider = new GroundedProviderFixture(fixtureModel(capabilities));
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-grounded");

    await answerViaModel("exact grounded input");
    expect(Object.hasOwn(provider.requests[0]!, "cache")).toBe(false);
  });

  it("keeps Claude's plain-completion two-turn transport allowance", async () => {
    const provider = new GroundedProviderFixture(
      fixtureModel({ id: "haiku" }),
      "claude-local",
    );
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "haiku");

    await expect(answerViaModel("exact grounded input")).resolves.toBe("grounded answer");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      model: "haiku",
      cache: { mode: "implicit" },
      maxAgentTurns: 2,
      plainCompletion: true,
      hostTools: [],
      toolChoice: "none",
      persistContinuation: false,
    });
  });

  it("fails closed before send when the selected model cannot accept text", async () => {
    const provider = new GroundedProviderFixture(fixtureModel({
      inputModalities: ["image"],
    }));
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-grounded");

    const error = await answerViaModel("exact grounded input").catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderSelectionError);
    expect(error).toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
      providerId: provider.id,
      model: "gpt-grounded",
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("preserves typed unavailable-model failures without dispatch or fallback", async () => {
    const provider = new GroundedProviderFixture();
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-not-in-catalogue");

    await expect(answerViaModel("exact grounded input")).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      providerId: provider.id,
      model: "gpt-not-in-catalogue",
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("preserves typed unavailable-provider selection failures", async () => {
    setActiveProvider("chatgpt-oauth");

    await expect(answerViaModel("exact grounded input")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      providerId: "chatgpt-oauth",
      model: null,
    });
  });

  it("propagates typed auth admission failures unchanged", async () => {
    const provider = new GroundedProviderFixture();
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-grounded");
    const authError = new ProviderGateError("AUTH_REQUIRED");
    vi.spyOn(provider, "send").mockRejectedValue(authError);

    await expect(answerViaModel("exact grounded input")).rejects.toBe(authError);
  });

  it.each(["AUTH_REQUIRED", "AUTH_EXPIRED"] as const)(
    "keeps returned %s failures typed",
    async (errorCode) => {
      const provider = new GroundedProviderFixture();
      registerV2(provider);
      setActiveProvider(provider.id);
      setProviderModelSelection(provider.id, "chat", "gpt-grounded");
      vi.spyOn(provider, "send").mockResolvedValue({
        continuation: "provider-secret-continuation",
        usage: emptyUsage(),
        freshFallback: false,
        status: "error",
        errorCode,
      });

      await expect(answerViaModel("exact grounded input")).rejects.toMatchObject({
        name: "ProviderGateError",
        code: errorCode,
      });
    },
  );

  it("keeps a returned unavailable-model failure typed", async () => {
    const provider = new GroundedProviderFixture();
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-grounded");
    vi.spyOn(provider, "send").mockResolvedValue({
      continuation: null,
      usage: emptyUsage(),
      freshFallback: false,
      status: "error",
      errorCode: "MODEL_UNAVAILABLE",
    });

    await expect(answerViaModel("exact grounded input")).rejects.toMatchObject({
      name: "ProviderSelectionError",
      code: "MODEL_UNAVAILABLE",
      providerId: provider.id,
      model: "gpt-grounded",
    });
  });

  it("uses the neutral ChatGPT request target when the catalogue has no wire output bound", async () => {
    const provider = new GroundedProviderFixture(fixtureModel({
      maxOutputTokens: null,
    }));
    registerV2(provider);
    setActiveProvider(provider.id);
    setProviderModelSelection(provider.id, "chat", "gpt-grounded");

    await expect(answerViaModel("exact grounded input")).resolves.toBe("grounded answer");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.maxOutputTokens).toBe(CHATGPT_DEFAULT_OUTPUT_TOKEN_TARGET);
  });
});

describe("handleSearch", () => {
  it("returns event hits and matching spaces", () => {
    seedEvent("pool villa in anjuna looks great");
    getDb()
      .prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa', 'Goa trip with Rohan', 'active')`)
      .run();
    const out = handleSearch("goa villa");
    expect(out.events.length).toBeGreaterThan(0);
    expect(out.spaces.map((s) => s.id)).toContain("sp_goa");
  });
});

describe("applyAction — actions through the normal object paths", () => {
  it("USR-01: create_space goes ACTIVE immediately with sweep + plan, created_by user", () => {
    const evId = seedEvent("hampi trek in october maybe?");
    const out = applyAction(
      {
        verb: "create_space",
        title: "Hampi trek Oct",
        risky: false,
        goal: "trek hampi with the goa gang",
        chapters: ["Travel", "Stay"],
        first_tasks: ["shortlist trains"],
      },
      [{ id: evId, ts: null, actor: null, chat: null, snippet: "hampi trek in october maybe?" }],
    );
    expect(out.status).toBe("done");
    const db = getDb();
    const space = db.prepare(`SELECT * FROM spaces WHERE id = ?`).get(out.space_id) as any;
    expect(space.status).toBe("active"); // never queued for approval
    expect(space.created_by).toBe("user");
    expect(JSON.parse(space.exemplars_json)[0].event_ids).toEqual([evId]); // the sweep
    const chapters = db.prepare(`SELECT label FROM chapters WHERE space_id = ?`).all(out.space_id);
    expect(chapters).toHaveLength(2);
    const task = db.prepare(`SELECT * FROM tasks WHERE space_id = ?`).get(out.space_id) as any;
    expect(task.title).toBe("shortlist trains");
    // Every mutation is a decision row (reversible convention).
    const decisions = db
      .prepare(`SELECT * FROM decisions WHERE target_id = ?`)
      .all(out.space_id);
    expect(decisions.length).toBeGreaterThan(0);
  });

  it("USR-02: create_task files into the matching existing space, not a new one", () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_money', 'Money & renewals', 'active')`).run();
    const out = applyAction(
      { verb: "remind", title: "renew car insurance", space_hint: "sp_money", due: "2026-09-04", risky: false },
      [],
    );
    expect(out.status).toBe("done");
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(out.task_id) as any;
    expect(task.space_id).toBe("sp_money");
    expect(task.due).toBe("2026-09-04");
    expect(task.created_by).toBe("user");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM spaces`).get()).toEqual({ n: 1 }); // no bar-space-spam
  });

  it("USR-03: ambiguous filing asks ONCE with one-tap options, task held", () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa_dec', 'Goa trip Dec', 'active')`).run();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa_wed', 'Goa wedding', 'active')`).run();
    const out = applyAction(
      {
        verb: "create_task",
        title: "buy sunscreen for goa",
        space_candidates: ["sp_goa_dec", "sp_goa_wed"],
        risky: false,
      },
      [],
    );
    expect(out.status).toBe("needs_input");
    expect(out.options?.map((o) => o.id).sort()).toEqual(["sp_goa_dec", "sp_goa_wed"]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 0 }); // held, not misfiled
  });

  it("USR-05: an execute ask becomes a gated task, never a direct execution", () => {
    const db = getDb();
    const out = applyAction(
      { verb: "execute", title: "book the 2nd villa option 18-21 dec", risky: true },
      [],
    );
    expect(out.status).toBe("done");
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(out.task_id) as any;
    expect(task.risk_class).toBe("approve-final"); // approval gate, not a side door
    expect(task.status).toBe("open");
  });
});

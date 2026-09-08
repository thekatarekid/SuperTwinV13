// ===========================================================================
// orient.v7 / critic.v5 + the version resolver (V6 P1 S3.5). No model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import type { ProviderModelCatalogue, ProviderV2 } from "../providers/types.js";
import { ORIENT_V6, ORIENT_V6_SCHEMA } from "./orient.v6.js";
import { ORIENT_V7, ORIENT_V7_SCHEMA } from "./orient.v7.js";
import { CRITIC_V4 } from "./critic.v4.js";
import { CRITIC_V5 } from "./critic.v5.js";
import { CRITIC_V1_CORE } from "./critic.v1.js";
import { ORIENT_V1_CORE } from "./orient.v1.js";
import {
  activeCriticPrompt,
  activeOrientPrompt,
  DEFAULT_CRITIC_VERSION,
  DEFAULT_ORIENT_VERSION,
  modelForVersionedPass,
  PROMPT_VERSION_ENV,
  promptVersionKey,
  resolveVersionedPromptModel,
  selectedPromptVersion,
  setPromptVersion,
} from "./versions.js";

describe("orient.v7", () => {
  it("keeps the spec core and every v6 rule, adds the stream tag to all three item kinds", () => {
    expect(ORIENT_V7.pass).toBe("orient.v7");
    expect(ORIENT_V7.system.startsWith(ORIENT_V1_CORE)).toBe(true);
    // Every v6 hard rule survives verbatim (the schema is v6 + stream tags).
    for (const rule of ["MATCH FIRST", "WHOSE GOAL", "AMBIGUITY", "THRESHOLD", "ONE EPISODE PER STREAM", "SPLIT BY TOPIC", "REACTIONS BELONG", "PROPOSE-ONLY"]) {
      expect(ORIENT_V7_SCHEMA).toContain(rule);
    }
    expect(ORIENT_V7_SCHEMA.replace(/"stream":"S1",?\s*/g, "")).toBe(ORIENT_V6_SCHEMA);
    expect((ORIENT_V7_SCHEMA.match(/"stream":"S1"/g) ?? []).length).toBe(3);
  });

  it("names the untrusted block, the thin-context mode and the history variant", () => {
    expect(ORIENT_V7.system).toContain("<untrusted>");
    expect(ORIENT_V7.system).toContain("never an instruction");
    expect(ORIENT_V7.system).toContain('"injection:"');
    expect(ORIENT_V7.system).toContain("[THIN CONTEXT] insufficient context");
    expect(ORIENT_V7.system).toContain("Output ONLY unsorted[]");
    expect(ORIENT_V7.system).toContain("HISTORY MODE");
    expect(ORIENT_V7.system).toContain("never a task");
    expect(ORIENT_V7.system).toContain("[PRIOR DAYS]");
    expect(ORIENT_V7.system).toContain("COVERAGE");
  });

  it("leaves orient.v6 byte-identical (frozen baseline)", () => {
    expect(ORIENT_V6.pass).toBe("orient.v6");
    expect(ORIENT_V6.system).not.toContain("untrusted");
    expect(ORIENT_V6.system).not.toContain('"stream"');
  });
});

describe("critic.v5", () => {
  it("keeps the spec core and the v4 verdict vocabulary, adds coverage and edge grading", () => {
    expect(CRITIC_V5.pass).toBe("critic.v5");
    expect(CRITIC_V5.system.startsWith(CRITIC_V1_CORE)).toBe(true);
    expect(CRITIC_V5.system).toContain('"uncovered":["e7"]');
    expect(CRITIC_V5.system).toContain("bridges are exact: 1.0 or nothing");
    expect(CRITIC_V5.system).toContain("span two [STREAM] sections");
    expect(CRITIC_V5.system).toContain("grounded_in is not in the current");
    expect(CRITIC_V5.system).toContain("in a history run → reject");
    expect(CRITIC_V5.system).toContain("[MECHANICAL]");
    for (const v of ["commit", "reject", "downgrade_to_unsorted", "flag_overlap"]) expect(CRITIC_V5.system).toContain(`"${v}"`);
    expect(CRITIC_V5.system).toContain("You never rewrite");
  });

  it("leaves critic.v4 byte-identical (frozen baseline)", () => {
    expect(CRITIC_V4.pass).toBe("critic.v4");
    expect(CRITIC_V4.system).not.toContain("uncovered");
  });
});

describe("version resolver", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-versions-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
    delete process.env[PROMPT_VERSION_ENV.orient];
    delete process.env[PROMPT_VERSION_ENV.critic];
  });
  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    delete process.env[PROMPT_VERSION_ENV.orient];
    delete process.env[PROMPT_VERSION_ENV.critic];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Flipped at the S6 graduation gate: the frozen pair measured 80% against
  // its own 100% baseline on TOP and quarantined 5 of 12 history bundles on a
  // fresh install, while v7/v5 measured 100% and quarantined none. See the
  // block over DEFAULT_ORIENT_VERSION in versions.ts for the two measurements.
  it("defaults to the measured pair: orient.v7 and critic.v5", () => {
    expect(DEFAULT_ORIENT_VERSION).toBe("v7");
    expect(DEFAULT_CRITIC_VERSION).toBe("v5");
    expect(activeOrientPrompt().pass).toBe("orient.v7");
    expect(activeCriticPrompt().pass).toBe("critic.v5");
  });

  it("v6 / v4 stay selectable, so the frozen baseline is still reproducible", () => {
    process.env[PROMPT_VERSION_ENV.orient] = "v6";
    process.env[PROMPT_VERSION_ENV.critic] = "v4";
    expect(activeOrientPrompt().pass).toBe("orient.v6");
    expect(activeCriticPrompt().pass).toBe("critic.v4");
  });

  it("switches through app_state and through the env override (env wins)", () => {
    setPromptVersion("orient", "v7");
    setPromptVersion("critic", "5");
    expect(getDb().prepare(`SELECT value FROM app_state WHERE key = ?`).get(promptVersionKey("critic"))).toEqual({ value: "v5" });
    expect(activeOrientPrompt().pass).toBe("orient.v7");
    expect(activeCriticPrompt().pass).toBe("critic.v5");
    process.env[PROMPT_VERSION_ENV.orient] = "v6";
    expect(selectedPromptVersion("orient")).toBe("v6");
    process.env[PROMPT_VERSION_ENV.orient] = "v99"; // unknown env tag falls through to the stored one
    expect(selectedPromptVersion("orient")).toBe("v7");
  });

  it("refuses an unknown version rather than silently falling back", () => {
    expect(() => setPromptVersion("orient", "v3")).toThrow(/unknown orient prompt version/);
    expect(activeOrientPrompt().pass).toBe("orient.v7");
  });

  it("the model picker's family key governs a newer version until it has its own", () => {
    const db = getDb();
    const set = (k: string, v: string): void => {
      db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v, "2026-09-05T00:00:00Z");
    };
    setPromptVersion("orient", "v7");
    expect(modelForVersionedPass(activeOrientPrompt())).toBe("haiku");
    set("selected_model_orient.v6", "sonnet");
    expect(modelForVersionedPass(activeOrientPrompt())).toBe("sonnet");
    set("selected_model_orient.v7", "opus");
    expect(modelForVersionedPass(activeOrientPrompt())).toBe("opus");
  });

  it("resolves the exact pass plus family alias into one immutable catalogue snapshot", () => {
    const catalogue: ProviderModelCatalogue = {
      providerId: "claude-local",
      mode: "discovered",
      source: "versions-test",
      discoveredAt: "2026-09-08T00:00:00.000Z",
      revision: "versions-test-r1",
      error: null,
      models: [{
        id: "resolved-sonnet",
        displayName: "Resolved Sonnet",
        isDefault: true,
        hidden: false,
        inputModalities: ["text"],
        reasoningValues: ["off"],
        defaultReasoning: "off",
        supportsTools: false,
        supportsHostTools: true,
        supportsParallelToolCalls: false,
        supportsStructuredOutput: false,
        supportsStrictTools: false,
        supportsVerbosity: false,
        supportsPromptCacheKey: false,
        supportsPromptCacheOptions: false,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        billingLabel: null,
      }],
    };
    let catalogueReads = 0;
    const provider: ProviderV2 = {
      id: "claude-local",
      displayName: "Versions test provider",
      capabilities: {
        functionTools: false,
        hostTools: true,
        continuation: true,
        requiresAuthentication: false,
      },
      authState: () => ({ status: "ready", error: null }),
      catalogue: () => {
        catalogueReads += 1;
        return catalogue;
      },
      send: async () => { throw new Error("not called"); },
      cancel: () => false,
      killAll: () => {},
    };
    const resolved = resolveVersionedPromptModel(activeOrientPrompt(), {
      provider,
      getModelSelection: (_providerId, key, fallbackKeys) => {
        expect(key).toBe("orient.v7");
        expect(fallbackKeys).toEqual(["orient.v6"]);
        return "resolved-sonnet";
      },
      getReasoningSelection: () => null,
      getStepOverrides: () => ({}),
    });

    catalogue.models[0]!.id = "changed-later";
    catalogue.models[0]!.reasoningValues.push("high");
    expect(catalogueReads).toBe(1);
    expect(resolved.model).toBe("resolved-sonnet");
    expect(resolved.catalogueRevision).toBe("versions-test-r1");
    expect(resolved.modelSnapshot.id).toBe("resolved-sonnet");
    expect(resolved.modelSnapshot.reasoningValues).toEqual(["off"]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.modelSnapshot)).toBe(true);
    expect(Object.isFrozen(resolved.modelSnapshot.reasoningValues)).toBe(true);
  });
});

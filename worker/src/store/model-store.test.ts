// ===========================================================================
// Unit tests for the per-role selected-model store accessors (getSelectedModel /
// setSelectedModel / getAllSelectedModels) over a real temp SQLite DB: a temp
// DB per test, migrations applied fresh.
//
// V8 has two roles — chat and media reading. Chat falls back to "" (the
// subscription default) and inherits the legacy single-model row that existing
// installs carry; media pins Haiku when the user has not chosen anything.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import {
  getSelectedModel,
  setSelectedModel,
  getAllSelectedModels,
  extractionDb,
  MODEL_KEY,
} from "./store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-model-store-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a raw app_state row (used to seed the LEGACY single-model key). */
function setLegacyModel(id: string): void {
  extractionDb()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(MODEL_KEY, id);
}

describe("per-role selected-model store", () => {
  it("defaults the chat role to the empty string when unset", () => {
    expect(getSelectedModel("chat")).toBe("");
  });

  it("round-trips a set value", () => {
    setSelectedModel("chat", "claude-opus-4-8");
    expect(getSelectedModel("chat")).toBe("claude-opus-4-8");
  });

  it("overwrites a prior selection", () => {
    setSelectedModel("chat", "opus");
    setSelectedModel("chat", "haiku");
    expect(getSelectedModel("chat")).toBe("haiku");
  });

  it("storing the empty string represents the default again", () => {
    setSelectedModel("chat", "opus");
    setSelectedModel("chat", "");
    expect(getSelectedModel("chat")).toBe("");
  });

  it("defaults the media role to Haiku when unset", () => {
    expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
  });

  it("round-trips a media selection, and clearing it restores the Haiku default", () => {
    setSelectedModel("media", "sonnet");
    expect(getSelectedModel("media")).toBe("sonnet");
    setSelectedModel("media", "");
    expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
  });

  it("the roles are independent", () => {
    setSelectedModel("chat", "opus");
    expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
    setSelectedModel("media", "haiku");
    expect(getSelectedModel("chat")).toBe("opus");
  });

  it("getAllSelectedModels returns every role", () => {
    setSelectedModel("chat", "opus");
    expect(getAllSelectedModels()).toEqual({
      chat: "opus",
      media: "claude-haiku-4-5-20251001",
    });
  });

  describe("legacy migration fallback", () => {
    it("returns the legacy single-model value for chat when no per-role value is set", () => {
      setLegacyModel("claude-opus-4-8");
      expect(getSelectedModel("chat")).toBe("claude-opus-4-8");
    });

    it("a per-role value takes precedence over the legacy value", () => {
      setLegacyModel("claude-opus-4-8");
      setSelectedModel("chat", "haiku");
      expect(getSelectedModel("chat")).toBe("haiku");
    });

    it("the legacy value belongs to chat alone — media keeps its own default", () => {
      setLegacyModel("claude-opus-4-8");
      expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
    });

    it("getAllSelectedModels reflects the legacy fallback", () => {
      setLegacyModel("opus");
      expect(getAllSelectedModels()).toEqual({
        chat: "opus",
        media: "claude-haiku-4-5-20251001",
      });
    });
  });
});

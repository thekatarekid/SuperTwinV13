// Provider settings namespace upgrade: SQLite-only and zero model/network calls.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../connection.js";
import { MIGRATIONS } from "../schema.js";
import {
  PROVIDER_SETTING_KEYS as SETTINGS_KEYS,
  PROVIDER_SETTING_SOURCES as SETTINGS_SOURCES,
} from "../settings.js";
import {
  PROVIDER_SETTINGS_KEYS,
  PROVIDER_SETTINGS_NAMESPACE,
  PROVIDER_SETTINGS_SOURCE_KEYS,
} from "./0212_provider_settings_namespace.js";

let scratchHome: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "supertwin-0212-"));
  process.env.SUPERTWIN_HOME = scratchHome;
  delete process.env.SUPERTWIN_DB_PATH;
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(scratchHome, { recursive: true, force: true });
});

function setState(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function state(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

describe("0212_provider_settings_namespace", () => {
  it("is registered after the provider decision migration and inventories 21/19 keys", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.indexOf("0212_provider_settings_namespace")).toBe(
      ids.indexOf("0211_chatgpt_provider_decisions") + 1,
    );
    expect(PROVIDER_SETTINGS_SOURCE_KEYS).toHaveLength(21);
    expect(PROVIDER_SETTINGS_KEYS).toHaveLength(19);
    expect(PROVIDER_SETTINGS_SOURCE_KEYS.filter(
      (key, index, all) => all.indexOf(key) !== index,
    )).toEqual(["chat", "extract"]);
    expect(PROVIDER_SETTINGS_SOURCE_KEYS).toEqual(SETTINGS_SOURCES);
    expect(PROVIDER_SETTINGS_KEYS).toEqual(SETTINGS_KEYS);
  });

  it("copies every legacy model and reasoning row into Claude's namespace", () => {
    const db = getDb();
    for (const name of [
      "provider_settings_model_insert",
      "provider_settings_model_update",
      "provider_settings_reasoning_insert",
      "provider_settings_reasoning_update",
    ]) {
      db.exec(`DROP TRIGGER ${name}`);
    }
    db.prepare(
      `DELETE FROM schema_migrations WHERE id = '0212_provider_settings_namespace'`,
    ).run();
    for (const key of PROVIDER_SETTINGS_KEYS) {
      setState(`selected_model_${key}`, `model-${key}`);
      setState(`selected_thinking_${key}`, `thinking-${key}`);
    }

    closeDb();
    runMigrations();

    for (const key of PROVIDER_SETTINGS_KEYS) {
      expect(state(`ai.model.claude-local.${key}`), `model ${key}`).toBe(
        `model-${key}`,
      );
      expect(state(`ai.reasoning.claude-local.${key}`), `reasoning ${key}`).toBe(
        `thinking-${key}`,
      );
    }
    expect(state("selected_model_classify")).toBe("model-classify");
    expect(state("selected_thinking_classify")).toBe("thinking-classify");
  });

  it("is idempotent and migration replay never overwrites a namespaced choice", () => {
    setState("selected_model_chat", "legacy-first");
    setState("selected_thinking_chat", "legacy-high");
    setState("ai.model.claude-local.chat", "namespaced-choice");

    getDb().exec(PROVIDER_SETTINGS_NAMESPACE);
    getDb().exec(PROVIDER_SETTINGS_NAMESPACE);

    expect(state("ai.model.claude-local.chat")).toBe("namespaced-choice");
    expect(state("ai.reasoning.claude-local.chat")).toBe("legacy-high");
    expect(state("selected_model_chat")).toBe("legacy-first");
    expect(state("selected_thinking_chat")).toBe("legacy-high");
  });

  it("mirrors legacy writes made by not-yet-migrated callers during the compatibility release", () => {
    setState("selected_model_classify", "legacy-first");
    setState("selected_thinking_classify", "high");
    expect(state("ai.model.claude-local.classify")).toBe("legacy-first");
    expect(state("ai.reasoning.claude-local.classify")).toBe("high");

    setState("selected_model_classify", "legacy-second");
    setState("selected_thinking_classify", "low");
    expect(state("ai.model.claude-local.classify")).toBe("legacy-second");
    expect(state("ai.reasoning.claude-local.classify")).toBe("low");
  });

  it("migrates the oldest single-model row to chat without beating a per-chat choice", () => {
    setState("selected_model", "oldest-chat-model");
    getDb().exec(PROVIDER_SETTINGS_NAMESPACE);
    expect(state("ai.model.claude-local.chat")).toBe("oldest-chat-model");

    getDb().prepare(`DELETE FROM app_state WHERE key = 'ai.model.claude-local.chat'`).run();
    setState("selected_model_chat", "newer-chat-model");
    getDb().exec(PROVIDER_SETTINGS_NAMESPACE);
    expect(state("ai.model.claude-local.chat")).toBe("newer-chat-model");
  });

  it("does not manufacture ChatGPT choices or copy unrelated versioned keys", () => {
    setState("selected_model_orient.v7", "legacy-version-specific");
    getDb().exec(PROVIDER_SETTINGS_NAMESPACE);
    expect(state("ai.model.claude-local.orient.v7")).toBeNull();
    expect(state("ai.model.chatgpt-oauth.orient")).toBeNull();
    expect(state("ai.provider.active")).toBeNull();
  });
});

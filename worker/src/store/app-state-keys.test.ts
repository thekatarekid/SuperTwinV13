// ===========================================================================
// Guard on the persisted app_state key strings. The `extraction.` prefix no
// longer matches anything in the codebase, so it is the obvious thing for a
// future cleanup to "fix" — and every existing install would lose its
// kill-switch, cursor and last-run state the moment it did.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import {
  EXTRACTION_CURSOR_KEY,
  EXTRACTION_ENABLED_KEY,
  EXTRACTION_LAST_ERROR_KEY,
  EXTRACTION_LAST_RUN_KEY,
  EXTRACTION_LAST_STATUS_KEY,
  extractionDb,
  setExtractionCursor,
  setExtractionEnabled,
} from "./store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-app-state-keys-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function storedKeys(): string[] {
  return (extractionDb().prepare(`SELECT key FROM app_state`).all() as { key: string }[]).map(
    (r) => r.key,
  );
}

describe("persisted app_state keys", () => {
  it("keeps the extraction.* names", () => {
    expect(EXTRACTION_ENABLED_KEY).toBe("extraction.enabled");
    expect(EXTRACTION_CURSOR_KEY).toBe("extraction.cursor");
    expect(EXTRACTION_LAST_RUN_KEY).toBe("extraction.last_run_ts");
    expect(EXTRACTION_LAST_STATUS_KEY).toBe("extraction.last_run_status");
    expect(EXTRACTION_LAST_ERROR_KEY).toBe("extraction.last_error");
  });

  it("writes the switches under those names", () => {
    setExtractionEnabled(false);
    setExtractionCursor(42);
    expect(storedKeys()).toEqual(
      expect.arrayContaining(["extraction.enabled", "extraction.cursor"]),
    );
  });
});

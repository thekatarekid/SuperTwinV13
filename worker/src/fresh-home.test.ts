// ===========================================================================
// Fresh-home invariant (build V6 P1 S0.6, backlog T4-14).
//
// S0.6 removed the 13.4.x data: the production home was backed up once to
// ~/SuperTwinV13-incident-2026-08-29/ and deleted, NOT migrated (plan §1.1
// "No data migration"). From here every install — and every test — starts
// from an empty home. This pins the half of that promise the code owns:
//
//   a brand-new SUPERTWIN_HOME, laid out and migrated, holds ZERO events,
//   sources or streams, and the migrator seeds nothing into the event log.
//
// It touches only a temp dir. It never reads ~/SuperTwinV13 (the home guard's
// job) and makes no model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, resolveDbPath, runMigrations } from "./db/connection.js";
import { DB_FILENAME, ensureHomeLayout } from "./home.js";

const KEYS = ["SUPERTWIN_HOME", "SUPERTWIN_DB_PATH"] as const;
const saved: Record<string, string | undefined> = {};
let scratch: string;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.SUPERTWIN_DB_PATH;
  scratch = mkdtempSync(join(tmpdir(), "supertwinv13-fresh-home-"));
  process.env.SUPERTWIN_HOME = scratch;
  closeDb();
});

afterEach(() => {
  closeDb();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(scratch, { recursive: true, force: true });
});

function count(table: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe("S0.6 — a fresh home has zero events", () => {
  it("lays out the home, migrates, and the event log is empty", () => {
    const home = ensureHomeLayout();
    expect(home).toBe(scratch);
    expect(resolveDbPath()).toBe(join(scratch, DB_FILENAME));

    runMigrations();
    expect(existsSync(join(scratch, DB_FILENAME))).toBe(true);

    expect(count("events")).toBe(0);
    expect(count("sources")).toBe(0);
    expect(count("streams")).toBe(0);
  });

  it("stays empty across a re-open (migrations seed nothing)", () => {
    ensureHomeLayout();
    runMigrations();
    closeDb();
    runMigrations();
    expect(count("events")).toBe(0);
  });
});

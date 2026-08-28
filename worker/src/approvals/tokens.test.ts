// ===========================================================================
// Single-use approval token tests (P0.6; spec §2.13). Real SQLite in a temp
// dir via the shared connection.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import {
  consumeApprovalToken,
  mintApprovalToken,
  readApprovalToken,
} from "./tokens.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "approval-tokens-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("approval tokens (single-use, code-gated)", () => {
  it("mints an unguessable token bound to an action", () => {
    const t = mintApprovalToken("whatsapp.send");
    expect(t.token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.action).toBe("whatsapp.send");
    expect(t.used_at).toBeNull();
    expect(readApprovalToken(t.token)?.action).toBe("whatsapp.send");
  });

  it("consumes exactly once — the second consume fails", () => {
    const t = mintApprovalToken("whatsapp.send");
    expect(consumeApprovalToken(t.token, "whatsapp.send")).toBe(true);
    expect(consumeApprovalToken(t.token, "whatsapp.send")).toBe(false);
    expect(readApprovalToken(t.token)?.used_at).not.toBeNull();
  });

  it("refuses an unknown token and an empty token", () => {
    expect(consumeApprovalToken("deadbeef", "whatsapp.send")).toBe(false);
    expect(consumeApprovalToken("", "whatsapp.send")).toBe(false);
  });

  it("refuses a token minted for a DIFFERENT action", () => {
    const t = mintApprovalToken("browser.payment");
    expect(consumeApprovalToken(t.token, "whatsapp.send")).toBe(false);
    // Still unused — a wrong-action attempt must not burn it.
    expect(readApprovalToken(t.token)?.used_at).toBeNull();
    expect(consumeApprovalToken(t.token, "browser.payment")).toBe(true);
  });

  it("refuses an expired token", () => {
    const minted = Date.now() - 10 * 60 * 1000;
    const t = mintApprovalToken("whatsapp.send", { nowMs: minted, ttlMs: 60_000 });
    expect(consumeApprovalToken(t.token, "whatsapp.send")).toBe(false);
  });

  it("requires a non-empty action to mint", () => {
    expect(() => mintApprovalToken("")).toThrow();
    expect(() => mintApprovalToken("   ")).toThrow();
  });
});

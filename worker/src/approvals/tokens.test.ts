// ===========================================================================
// Single-use SIGNED approval token tests (P0.6 + V6 P1 S4.5; spec §2.13).
// Real SQLite in a temp dir via the shared connection, real HMAC over a real
// key file under a scratch home. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { approvalKey, approvalKeyPath, resetApprovalKeyCache } from "./key.js";
import {
  bindingDigest,
  consumeApprovalToken,
  mintApprovalToken,
  parseApprovalToken,
  readApprovalToken,
  revokeApprovalToken,
  verifyApprovalTokenSignature,
} from "./tokens.js";

let tmpDir: string;

const TO = "15551234567@s.whatsapp.net";
const TEXT = "on my way, 10 minutes";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "approval-tokens-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
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

describe("the approval key", () => {
  it("creates one 0600 key under the home's trust dir and reuses it", () => {
    const k1 = approvalKey();
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    resetApprovalKeyCache();
    expect(approvalKey()).toBe(k1);
    const mode = statSync(approvalKeyPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("approval tokens (single-use, signed, code-gated)", () => {
  it("mints a signed token bound to an action and a payload", () => {
    const t = mintApprovalToken("whatsapp.send", { bind: { to: TO, text: TEXT } });
    const parsed = parseApprovalToken(t.token);
    expect(parsed).not.toBeNull();
    expect(parsed!.action).toBe("whatsapp.send");
    expect(parsed!.bindDigest).toBe(bindingDigest({ to: TO, text: TEXT }));
    expect(verifyApprovalTokenSignature(t.token)).not.toBeNull();
    expect(t.used_at).toBeNull();
    expect(readApprovalToken(t.token)?.action).toBe("whatsapp.send");
  });

  it("consumes exactly once — the second consume fails", () => {
    const bind = { to: TO, text: TEXT };
    const t = mintApprovalToken("whatsapp.send", { bind });
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(true);
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(false);
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
    const t = mintApprovalToken("whatsapp.send", {
      nowMs: minted,
      ttlMs: 60_000,
      bind: { to: TO, text: TEXT },
    });
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind: { to: TO, text: TEXT } })).toBe(
      false,
    );
  });

  it("requires a non-empty, lowercase action to mint", () => {
    expect(() => mintApprovalToken("")).toThrow();
    expect(() => mintApprovalToken("   ")).toThrow();
    expect(() => mintApprovalToken("WhatsApp Send")).toThrow();
  });

  // ---- S4.5: signed --------------------------------------------------------

  it("refuses a FORGED token — one character of the payload digest is enough", () => {
    const bind = { to: TO, text: TEXT };
    const t = mintApprovalToken("whatsapp.send", { bind });
    const parts = t.token.split("~");
    parts[4] = bindingDigest({ to: TO, text: "pay ₹5,000 now" });
    const forged = parts.join("~");
    expect(verifyApprovalTokenSignature(forged)).toBeNull();
    expect(consumeApprovalToken(forged, "whatsapp.send", { bind })).toBe(false);
  });

  it("refuses a token signed under a DIFFERENT key", () => {
    const bind = { to: TO, text: TEXT };
    const t = mintApprovalToken("whatsapp.send", { bind });
    // Same row in the table, different install secret: the signature is the
    // only thing that decides, so the token stops verifying.
    process.env.SUPERTWIN_APPROVAL_KEY = "a".repeat(64);
    resetApprovalKeyCache();
    expect(verifyApprovalTokenSignature(t.token)).toBeNull();
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(false);
  });

  // ---- S4.5: bound (GATE-A-02) --------------------------------------------

  it("GATE-A-02 — Rohan's token cannot send to Karan, or send other words", () => {
    const bind = { to: "rohan@s.whatsapp.net", text: TEXT };
    const t = mintApprovalToken("whatsapp.send", { bind });

    expect(
      consumeApprovalToken(t.token, "whatsapp.send", {
        bind: { to: "karan@s.whatsapp.net", text: TEXT },
      }),
    ).toBe(false);
    expect(
      consumeApprovalToken(t.token, "whatsapp.send", {
        bind: { to: "rohan@s.whatsapp.net", text: `${TEXT} — and send ₹5,000` },
      }),
    ).toBe(false);
    // Neither refusal burned it: the approved payload still goes through once.
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(true);
  });

  it("a bound token cannot be consumed without proving the payload", () => {
    const bind = { to: TO, text: TEXT };
    const t = mintApprovalToken("whatsapp.send", { bind });
    expect(consumeApprovalToken(t.token, "whatsapp.send")).toBe(false);
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(true);
  });

  it("an UNBOUND token cannot authorize a bound payload", () => {
    const t = mintApprovalToken("whatsapp.send");
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind: { to: TO, text: TEXT } })).toBe(
      false,
    );
  });

  it("the binding cannot be re-cut across fields", () => {
    expect(bindingDigest({ to: "ab", text: "cd" })).not.toBe(bindingDigest({ to: "abc", text: "d" }));
  });

  // ---- S4.5: revocation (the edit path) -----------------------------------

  it("a revoked token is dead, and revoking is idempotent", () => {
    const bind = { to: TO, text: TEXT };
    const t = mintApprovalToken("whatsapp.send", { bind });
    expect(revokeApprovalToken(t.token)).toBe(true);
    expect(revokeApprovalToken(t.token)).toBe(false);
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(false);
  });

  it("a spent token cannot be revoked back into life", () => {
    const bind = { to: TO, text: TEXT };
    const t = mintApprovalToken("whatsapp.send", { bind });
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(true);
    expect(revokeApprovalToken(t.token)).toBe(false);
    expect(consumeApprovalToken(t.token, "whatsapp.send", { bind })).toBe(false);
  });
});

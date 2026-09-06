// ===========================================================================
// The send approval card (V6 P1 S4.5; GoldenEvals V6 P1 §5.14 GATE-A-03).
// Real SQLite, real HMAC, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { resetApprovalKeyCache } from "./key.js";
import {
  approveSendApproval,
  cancelSendApproval,
  createSendApproval,
  editSendApproval,
  listOpenSendApprovals,
  liveTokenFor,
  markSendApprovalSent,
  readSendApproval,
} from "./send-approval.js";
import { consumeApprovalToken, readApprovalToken } from "./tokens.js";

let tmpDir: string;

const ROHAN = "919812345678@s.whatsapp.net";
const KARAN = "919800000000@s.whatsapp.net";
const TEXT = "sending the villa advance tonight, sharing the receipt after";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "send-approval-"));
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

function card() {
  return createSendApproval({
    to: ROHAN,
    toLabel: "Rohan",
    text: TEXT,
    spaceId: "sp_goa_dec",
    taskId: "tsk_villa",
  });
}

describe("the approval card (GATE-A-03)", () => {
  it("shows exactly what will be sent and to whom — and mints nothing", () => {
    const c = card();
    expect(c.state).toBe("pending");
    expect(c.token_minted).toBe(false);
    expect(c.to).toBe(ROHAN);
    expect(c.to_label).toBe("Rohan");
    expect(c.text).toBe(TEXT);
    expect(c.channel).toBe("whatsapp");
    expect(c.action).toBe("whatsapp.send");
    // The card's own words carry the recipient (name AND address) and the
    // verbatim text: nothing is summarised, nothing is paraphrased.
    expect(c.what[0]).toContain("Rohan");
    expect(c.what[0]).toContain(ROHAN);
    expect(c.what.join("\n")).toContain(TEXT);
    // Nothing was minted by creating a card — the token store has not even
    // been touched (the table is this module's private storage, created on
    // first mint).
    const tbl = getDb()
      .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='approval_tokens'`)
      .get() as { n: number };
    const minted =
      tbl.n === 0
        ? 0
        : (getDb().prepare(`SELECT COUNT(*) n FROM approval_tokens`).get() as { n: number }).n;
    expect(minted).toBe(0);
  });

  it("the tap mints one token bound to that payload; the send consumes it once", () => {
    const c = card();
    const { card: approved, token } = approveSendApproval(c.id);
    expect(approved.state).toBe("approved");
    expect(approved.token_minted).toBe(true);
    expect(liveTokenFor(c.id)).toBe(token.token);

    // Bound: this token sends THIS text to THIS person, and nothing else.
    expect(
      consumeApprovalToken(token.token, "whatsapp.send", { bind: { to: KARAN, text: TEXT } }),
    ).toBe(false);
    expect(
      consumeApprovalToken(token.token, "whatsapp.send", { bind: { to: ROHAN, text: TEXT } }),
    ).toBe(true);
    expect(
      consumeApprovalToken(token.token, "whatsapp.send", { bind: { to: ROHAN, text: TEXT } }),
    ).toBe(false);

    const sent = markSendApprovalSent(c.id);
    expect(sent.state).toBe("sent");
    expect(sent.sent_at).not.toBeNull();
    expect(liveTokenFor(c.id)).toBeNull();
  });

  it("EDITING INVALIDATES THE TOKEN — revoked, unusable, and the card needs a new tap", () => {
    const c = card();
    const { token } = approveSendApproval(c.id);

    const edited = editSendApproval(c.id, { text: `${TEXT} — leaving at 6` });
    expect(edited.state).toBe("pending");
    expect(edited.token_minted).toBe(false);
    expect(edited.edits).toBe(1);
    expect(edited.payload_digest).not.toBe(c.payload_digest);
    expect(readApprovalToken(token.token)?.revoked_at).not.toBeNull();

    // Dead for the OLD payload (revoked) and dead for the NEW one (bound to
    // what the user no longer approved) — both halves, not just one.
    expect(
      consumeApprovalToken(token.token, "whatsapp.send", { bind: { to: ROHAN, text: TEXT } }),
    ).toBe(false);
    expect(
      consumeApprovalToken(token.token, "whatsapp.send", {
        bind: { to: ROHAN, text: edited.text },
      }),
    ).toBe(false);

    // A fresh tap authorizes what the card now says.
    const again = approveSendApproval(c.id);
    expect(
      consumeApprovalToken(again.token.token, "whatsapp.send", {
        bind: { to: ROHAN, text: edited.text },
      }),
    ).toBe(true);
  });

  it("changing the RECIPIENT invalidates just as hard", () => {
    const c = card();
    const { token } = approveSendApproval(c.id);
    const edited = editSendApproval(c.id, { to: KARAN, toLabel: "Karan" });
    expect(edited.to).toBe(KARAN);
    expect(edited.to_label).toBe("Karan");
    expect(edited.state).toBe("pending");
    expect(
      consumeApprovalToken(token.token, "whatsapp.send", { bind: { to: KARAN, text: TEXT } }),
    ).toBe(false);
  });

  it("a second tap replaces the live token — at most one is ever usable", () => {
    const c = card();
    const first = approveSendApproval(c.id).token;
    const second = approveSendApproval(c.id).token;
    expect(second.token).not.toBe(first.token);
    const bind = { to: ROHAN, text: TEXT };
    expect(consumeApprovalToken(first.token, "whatsapp.send", { bind })).toBe(false);
    expect(consumeApprovalToken(second.token, "whatsapp.send", { bind })).toBe(true);
  });

  it("cancel revokes and closes; a sent card cannot be edited or re-approved", () => {
    const c = card();
    const { token } = approveSendApproval(c.id);
    const cancelled = cancelSendApproval(c.id);
    expect(cancelled.state).toBe("cancelled");
    expect(
      consumeApprovalToken(token.token, "whatsapp.send", { bind: { to: ROHAN, text: TEXT } }),
    ).toBe(false);
    expect(() => editSendApproval(c.id, { text: "x" })).toThrow(/cancelled/);
    expect(() => approveSendApproval(c.id)).toThrow(/cancelled/);

    const d = card();
    approveSendApproval(d.id);
    markSendApprovalSent(d.id);
    expect(() => editSendApproval(d.id, { text: "x" })).toThrow(/already sent/);
    expect(() => approveSendApproval(d.id)).toThrow(/already sent/);
  });

  it("lists what is still open, and refuses a card with no recipient or no text", () => {
    const a = card();
    const b = createSendApproval({ to: KARAN, text: "ok" });
    markSendApprovalSent(b.id);
    const open = listOpenSendApprovals();
    expect(open.map((o) => o.id)).toEqual([a.id]);
    expect(() => createSendApproval({ to: "", text: "hi" })).toThrow(/recipient/);
    expect(() => createSendApproval({ to: ROHAN, text: "   " })).toThrow(/text/);
    expect(readSendApproval("apr_nope")).toBeNull();
  });
});

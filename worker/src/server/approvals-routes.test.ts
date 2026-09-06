// ===========================================================================
// The send-gate endpoints (V6 P1 S4.5; GoldenEvals V6 P1 §5.14 GATE-A).
// Sandboxed database and home, a fake Ingestion, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { resetApprovalKeyCache } from "../approvals/key.js";
import { consumeApprovalToken } from "../approvals/tokens.js";
import { closeDb, runMigrations } from "../db/connection.js";
import type { Ingestion } from "../ingest/index.js";
import { handleApprovalsRoute } from "./approvals-routes.js";

let tmpDir: string;

const ROHAN = "919812345678@s.whatsapp.net";
const KARAN = "919800000000@s.whatsapp.net";
const TEXT = "sending the villa advance tonight";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-approvals-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
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

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

/** A stand-in for the WhatsApp Ingestion: consumes the token, records the send. */
function fakeIngestion(): Ingestion & { sends: Array<{ to: string; text: string }> } {
  const sends: Array<{ to: string; text: string }> = [];
  return {
    sends,
    sourceId: "whatsapp",
    async sendMessage(params: { to: string; text: string; approvalToken: string }) {
      if (
        !consumeApprovalToken(params.approvalToken, "whatsapp.send", {
          bind: { to: params.to, text: params.text },
        })
      ) {
        throw new Error("SEND_REFUSED: approval token invalid, expired, or already used");
      }
      sends.push({ to: params.to, text: params.text });
    },
  } as unknown as Ingestion & { sends: Array<{ to: string; text: string }> };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  ingestion: Ingestion | null = null,
): Promise<Captured | null> {
  const captured: Captured = { status: 0, body: {} };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      captured.body = payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
    },
  } as unknown as ServerResponse;
  const req = Readable.from([
    body === undefined ? "" : JSON.stringify(body),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = path;
  const handled = await handleApprovalsRoute(req, res, ingestion);
  return handled ? captured : null;
}

function approvalOf(c: Captured | null): Record<string, unknown> {
  expect(c).not.toBeNull();
  return c!.body.approval as Record<string, unknown>;
}

async function newCard(): Promise<Record<string, unknown>> {
  return approvalOf(
    await call("POST", "/api/approvals", {
      to: ROHAN,
      to_label: "Rohan",
      text: TEXT,
      space_id: "sp_goa_dec",
    }),
  );
}

describe("handleApprovalsRoute", () => {
  it("declines /api/approvals/mint (the source router owns it) and unknown verbs", async () => {
    expect(await call("POST", "/api/approvals/mint", { action: "whatsapp.send" })).toBeNull();
    expect(await call("GET", "/api/other")).toBeNull();
    const card = await newCard();
    expect((await call("POST", `/api/approvals/${card.id}/detonate`))!.status).toBe(404);
    expect((await call("GET", "/api/approvals/apr_missing"))!.status).toBe(404);
  });

  it("GATE-A-03 — the card shows exactly what will be sent and to whom", async () => {
    const card = await newCard();
    expect(card.state).toBe("pending");
    expect(card.token_minted).toBe(false);
    const fetched = approvalOf(await call("GET", `/api/approvals/${card.id}`));
    expect(fetched.to).toBe(ROHAN);
    expect(fetched.to_label).toBe("Rohan");
    expect(fetched.text).toBe(TEXT);
    expect((fetched.what as string[]).join("\n")).toContain(TEXT);
    expect((fetched.what as string[]).join("\n")).toContain(ROHAN);

    const open = (await call("GET", "/api/approvals"))!.body.approvals as Array<
      Record<string, unknown>
    >;
    expect(open.map((o) => o.id)).toEqual([card.id]);
  });

  it("GATE-A-01 — an unapproved card sends nothing", async () => {
    const ing = fakeIngestion();
    const card = await newCard();
    const r = await call("POST", `/api/approvals/${card.id}/send`, {}, ing);
    expect(r!.status).toBe(403);
    expect(String(r!.body.error)).toMatch(/has not been approved/);
    expect(ing.sends).toHaveLength(0);
  });

  it("the tap mints a bound token, and /send sends the card's own payload once", async () => {
    const ing = fakeIngestion();
    const card = await newCard();
    const tap = (await call("POST", `/api/approvals/${card.id}/approve`))!;
    expect(tap.status).toBe(200);
    expect(String(tap.body.token)).toContain("~whatsapp.send~");
    expect((tap.body.approval as Record<string, unknown>).state).toBe("approved");

    const sent = approvalOf(await call("POST", `/api/approvals/${card.id}/send`, {}, ing));
    expect(sent.state).toBe("sent");
    expect(ing.sends).toEqual([{ to: ROHAN, text: TEXT }]);

    // Single-use, end to end: a second dispatch has no live token to use.
    const again = await call("POST", `/api/approvals/${card.id}/send`, {}, ing);
    expect(again!.status).toBe(403);
    expect(ing.sends).toHaveLength(1);
  });

  it("the dispatcher ignores a recipient or body in the request — the CARD decides", async () => {
    const ing = fakeIngestion();
    const card = await newCard();
    await call("POST", `/api/approvals/${card.id}/approve`);
    await call(
      "POST",
      `/api/approvals/${card.id}/send`,
      { to: KARAN, text: "pay ₹5,000 now", approval_token: "anything" },
      ing,
    );
    expect(ing.sends).toEqual([{ to: ROHAN, text: TEXT }]);
  });

  it("GATE-A-03 — editing invalidates the token; the send is refused until a new tap", async () => {
    const ing = fakeIngestion();
    const card = await newCard();
    const tap = (await call("POST", `/api/approvals/${card.id}/approve`))!;
    const staleToken = String(tap.body.token);

    const edited = approvalOf(
      await call("POST", `/api/approvals/${card.id}/edit`, { text: `${TEXT} — leaving at 6` }),
    );
    expect(edited.state).toBe("pending");
    expect(edited.token_minted).toBe(false);

    // No live token: the dispatcher refuses.
    expect((await call("POST", `/api/approvals/${card.id}/send`, {}, ing))!.status).toBe(403);
    // And the token that WAS minted is dead even if someone kept a copy.
    expect(
      consumeApprovalToken(staleToken, "whatsapp.send", { bind: { to: ROHAN, text: TEXT } }),
    ).toBe(false);
    expect(ing.sends).toHaveLength(0);

    // A fresh tap authorizes the edited card, and that is what goes out.
    await call("POST", `/api/approvals/${card.id}/approve`);
    await call("POST", `/api/approvals/${card.id}/send`, {}, ing);
    expect(ing.sends).toEqual([{ to: ROHAN, text: `${TEXT} — leaving at 6` }]);
  });

  it("cancel closes the card; send answers 503 with no adapter", async () => {
    const card = await newCard();
    await call("POST", `/api/approvals/${card.id}/approve`);
    expect(approvalOf(await call("POST", `/api/approvals/${card.id}/cancel`)).state).toBe(
      "cancelled",
    );
    expect((await call("POST", `/api/approvals/${card.id}/approve`))!.status).toBe(400);

    const other = await newCard();
    await call("POST", `/api/approvals/${other.id}/approve`);
    expect((await call("POST", `/api/approvals/${other.id}/send`, {}, null))!.status).toBe(503);
  });

  it("refuses a card with no recipient or no text", async () => {
    expect((await call("POST", "/api/approvals", { to: "", text: "hi" }))!.status).toBe(400);
    expect((await call("POST", "/api/approvals", { to: ROHAN, text: "   " }))!.status).toBe(400);
  });
});

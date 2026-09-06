// ===========================================================================
// The send approval card (V6 P1 S4.5; Build §7.2, Product_V6 §12.4 "a gate
// produces an approval card with exactly what will happen. One tap mints the
// token", Product_V6_Phase1 §24 rule 2; GoldenEvals V6 P1 §5.14 GATE-A).
//
// A gated send never travels as three loose strings. It is a CARD:
//
//   pending ──approve(tap)──► approved ──send──► sent
//      ▲                         │
//      └──────edit───────────────┘   (the minted token is revoked, not reused)
//
// The card owns the payload — channel, recipient (both the address the daemon
// will use and the name a human recognises), and the exact text — so "shows
// exactly what will be sent and to whom" is a property of the STORED object
// the UI renders, not of one screen's formatting. The token minted on approve
// is bound to that payload's digest (approvals/tokens.ts), which is what makes
// the two halves of GATE-A-03 the same fact:
//
//   * the card shows the payload   — because the payload IS the card;
//   * editing invalidates the token — because an edit revokes the minted token
//     AND changes the digest, so even an un-revoked copy would bind to nothing.
//
// Nothing here sends. The dispatcher (server/approvals-routes.ts → Ingestion →
// the daemon) consumes the token, and both the worker and the daemon check the
// binding independently.
//
// Storage follows this module's P0.6 sibling: a private CREATE TABLE IF NOT
// EXISTS owned end-to-end by this API, not a numbered migration.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  bindingDigest,
  mintApprovalToken,
  revokeApprovalToken,
  type ApprovalToken,
} from "./tokens.js";

export const SEND_APPROVAL_STATES = ["pending", "approved", "sent", "cancelled"] as const;
export type SendApprovalState = (typeof SEND_APPROVAL_STATES)[number];

export interface SendApprovalRow {
  id: string;
  channel: string;
  action: string;
  to_ext_id: string;
  to_label: string;
  text: string;
  space_id: string | null;
  task_id: string | null;
  state: SendApprovalState;
  token: string | null;
  edits: number;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
}

/** What a surface renders. `what` is the card's own words, in order. */
export interface SendApprovalCard {
  id: string;
  channel: string;
  action: string;
  to: string;
  to_label: string;
  text: string;
  space_id: string | null;
  task_id: string | null;
  state: SendApprovalState;
  /** True while a live token exists for this exact payload. */
  token_minted: boolean;
  /** The payload digest the token commits to — the card's identity. */
  payload_digest: string;
  edits: number;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  /** Exactly what will happen, in the words the card shows. */
  what: string[];
}

function nowIso(nowMs?: number): string {
  return new Date(nowMs ?? Date.now()).toISOString();
}

function table(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS send_approvals (
      id          TEXT PRIMARY KEY,
      channel     TEXT NOT NULL,
      action      TEXT NOT NULL,
      to_ext_id   TEXT NOT NULL,
      to_label    TEXT NOT NULL,
      text        TEXT NOT NULL,
      space_id    TEXT,
      task_id     TEXT,
      state       TEXT NOT NULL,
      token       TEXT,
      edits       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      approved_at TEXT,
      sent_at     TEXT
    )
  `);
}

function row(id: string): SendApprovalRow | null {
  table();
  const r = getDb()
    .prepare(`SELECT * FROM send_approvals WHERE id = ?`)
    .get(id) as SendApprovalRow | undefined;
  return r ?? null;
}

/** The card's own sentence: what will be sent, and to whom. */
export function cardLines(r: SendApprovalRow): string[] {
  const who = r.to_label && r.to_label !== r.to_ext_id ? `${r.to_label} (${r.to_ext_id})` : r.to_ext_id;
  return [`Send a ${r.channel} message to ${who}`, `“${r.text}”`, "Nothing else is sent."];
}

export function toCard(r: SendApprovalRow): SendApprovalCard {
  return {
    id: r.id,
    channel: r.channel,
    action: r.action,
    to: r.to_ext_id,
    to_label: r.to_label,
    text: r.text,
    space_id: r.space_id,
    task_id: r.task_id,
    state: r.state,
    token_minted: Boolean(r.token),
    payload_digest: bindingDigest({ to: r.to_ext_id, text: r.text }),
    edits: r.edits,
    created_at: r.created_at,
    updated_at: r.updated_at,
    approved_at: r.approved_at,
    sent_at: r.sent_at,
    what: cardLines(r),
  };
}

export interface CreateSendApprovalInput {
  /** Source/channel the send travels on, e.g. "whatsapp". */
  channel?: string;
  /** The address the daemon will use (a JID for WhatsApp). */
  to: string;
  /** The name a human recognises; defaults to the address. */
  toLabel?: string;
  /** Exactly the text that will be sent. */
  text: string;
  spaceId?: string | null;
  taskId?: string | null;
  nowMs?: number;
}

/**
 * Create the card a tap will act on. Nothing is minted here — a card is a
 * proposal, and an unapproved card can authorize nothing.
 */
export function createSendApproval(input: CreateSendApprovalInput): SendApprovalCard {
  const to = (input.to ?? "").trim();
  const text = input.text ?? "";
  if (!to) throw new Error("send approval needs a recipient");
  if (!text.trim()) throw new Error("send approval needs the text that will be sent");
  const channel = (input.channel ?? "whatsapp").trim() || "whatsapp";
  const ts = nowIso(input.nowMs);
  const r: SendApprovalRow = {
    id: `apr_${randomBytes(8).toString("hex")}`,
    channel,
    action: `${channel}.send`,
    to_ext_id: to,
    to_label: (input.toLabel ?? "").trim() || to,
    text,
    space_id: input.spaceId ?? null,
    task_id: input.taskId ?? null,
    state: "pending",
    token: null,
    edits: 0,
    created_at: ts,
    updated_at: ts,
    approved_at: null,
    sent_at: null,
  };
  table();
  getDb()
    .prepare(
      `INSERT INTO send_approvals
         (id, channel, action, to_ext_id, to_label, text, space_id, task_id,
          state, token, edits, created_at, updated_at, approved_at, sent_at)
       VALUES (@id, @channel, @action, @to_ext_id, @to_label, @text, @space_id, @task_id,
               @state, @token, @edits, @created_at, @updated_at, @approved_at, @sent_at)`,
    )
    .run(r);
  return toCard(r);
}

export function readSendApproval(id: string): SendApprovalCard | null {
  const r = row(id);
  return r ? toCard(r) : null;
}

/** Cards still waiting on a tap (or approved but not yet sent), newest first. */
export function listOpenSendApprovals(): SendApprovalCard[] {
  table();
  const rows = getDb()
    .prepare(
      `SELECT * FROM send_approvals
        WHERE state IN ('pending','approved')
        ORDER BY created_at DESC, id DESC`,
    )
    .all() as SendApprovalRow[];
  return rows.map(toCard);
}

/**
 * THE TAP. Mints one single-use signed token bound to this card's exact
 * payload and hands it back once — the caller carries it straight into the
 * gated call. A second tap on an already-approved card revokes the first
 * token before minting, so at most one live token exists per card.
 */
export function approveSendApproval(
  id: string,
  opts: { nowMs?: number; ttlMs?: number } = {},
): { card: SendApprovalCard; token: ApprovalToken } {
  const r = row(id);
  if (!r) throw new Error(`unknown approval ${JSON.stringify(id)}`);
  if (r.state === "sent") throw new Error("approval already sent");
  if (r.state === "cancelled") throw new Error("approval was cancelled");
  if (r.token) revokeApprovalToken(r.token, { nowMs: opts.nowMs });

  const token = mintApprovalToken(r.action, {
    nowMs: opts.nowMs,
    ttlMs: opts.ttlMs,
    bind: { to: r.to_ext_id, text: r.text },
  });
  const ts = nowIso(opts.nowMs);
  getDb()
    .prepare(
      `UPDATE send_approvals
          SET state = 'approved', token = ?, approved_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(token.token, ts, ts, id);
  writeDecision({
    pass: "user",
    targetKind: "approval",
    targetId: id,
    action: "approve",
    old: { state: r.state },
    new: { state: "approved", to: r.to_ext_id, text: r.text },
    reason: "approval card tapped — single-use token minted for this payload",
  });
  return { card: readSendApproval(id)!, token };
}

/**
 * Edit what will be sent (or to whom). The minted token is REVOKED and the
 * card returns to pending: an edited card has never been approved, and the
 * old token binds to a payload that no longer exists either way.
 */
export function editSendApproval(
  id: string,
  patch: { to?: string; toLabel?: string; text?: string },
  opts: { nowMs?: number } = {},
): SendApprovalCard {
  const r = row(id);
  if (!r) throw new Error(`unknown approval ${JSON.stringify(id)}`);
  if (r.state === "sent") throw new Error("approval already sent — nothing to edit");
  if (r.state === "cancelled") throw new Error("approval was cancelled");

  const to = patch.to !== undefined ? patch.to.trim() : r.to_ext_id;
  const text = patch.text !== undefined ? patch.text : r.text;
  if (!to) throw new Error("send approval needs a recipient");
  if (!text.trim()) throw new Error("send approval needs the text that will be sent");
  const toLabel =
    patch.toLabel !== undefined
      ? patch.toLabel.trim() || to
      : patch.to !== undefined && r.to_label === r.to_ext_id
        ? to
        : r.to_label;

  const revoked = r.token ? revokeApprovalToken(r.token, { nowMs: opts.nowMs }) : false;
  const ts = nowIso(opts.nowMs);
  getDb()
    .prepare(
      `UPDATE send_approvals
          SET to_ext_id = ?, to_label = ?, text = ?, state = 'pending', token = NULL,
              approved_at = NULL, edits = edits + 1, updated_at = ?
        WHERE id = ?`,
    )
    .run(to, toLabel, text, ts, id);
  writeDecision({
    pass: "user",
    targetKind: "approval",
    targetId: id,
    action: "edit",
    old: { to: r.to_ext_id, text: r.text, state: r.state, token_minted: Boolean(r.token) },
    new: { to, text, state: "pending", token_minted: false },
    reason: revoked
      ? "approval edited — the minted token was revoked, the card needs a new tap"
      : "approval edited before any tap",
  });
  return readSendApproval(id)!;
}

/** Walk away. Any live token is revoked. */
export function cancelSendApproval(id: string, opts: { nowMs?: number } = {}): SendApprovalCard {
  const r = row(id);
  if (!r) throw new Error(`unknown approval ${JSON.stringify(id)}`);
  if (r.state === "sent") throw new Error("approval already sent");
  if (r.token) revokeApprovalToken(r.token, { nowMs: opts.nowMs });
  const ts = nowIso(opts.nowMs);
  getDb()
    .prepare(
      `UPDATE send_approvals SET state = 'cancelled', token = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(ts, id);
  return readSendApproval(id)!;
}

/**
 * Record that the approved payload actually left. Called by the dispatcher
 * AFTER the token was consumed and the adapter accepted the send — the token
 * is already spent, so the card simply stops being live.
 */
export function markSendApprovalSent(id: string, opts: { nowMs?: number } = {}): SendApprovalCard {
  const r = row(id);
  if (!r) throw new Error(`unknown approval ${JSON.stringify(id)}`);
  const ts = nowIso(opts.nowMs);
  getDb()
    .prepare(
      `UPDATE send_approvals SET state = 'sent', token = NULL, sent_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(ts, ts, id);
  writeDecision({
    pass: "code:approvals",
    targetKind: "approval",
    targetId: id,
    action: "send",
    old: { state: r.state },
    new: { state: "sent", to: r.to_ext_id, text: r.text },
    reason: "approved payload sent through the gated channel",
  });
  return readSendApproval(id)!;
}

/**
 * The token this card minted, if it still holds one. The dispatcher reads it
 * rather than taking a token from the request body: a caller that can name a
 * card can only ever send that card's approved payload.
 */
export function liveTokenFor(id: string): string | null {
  const r = row(id);
  return r && r.state === "approved" ? r.token : null;
}

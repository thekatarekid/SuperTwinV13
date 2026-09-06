// ===========================================================================
// Single-use SIGNED approval tokens (P0.6, extended by V6 P1 S4.5;
// spec §2.13, §11.3; Product_V6 §23.7 rule 2, Product_V6_Phase1 §24 rule 2).
//
// Risky steps are CODE-gated, not prompt-gated: a gated action (WhatsApp send
// today; browser payment steps later) runs only after consuming a minted,
// unused, unexpired token that a user tap produced. Consumption is a single
// atomic UPDATE, so a token can never authorize two actions even under
// concurrent consumers.
//
// S4.5 adds the two properties the send gate needs:
//
//   SIGNED   the token carries an HMAC over its own fields under the install's
//            approval key (approvals/key.ts). The Go daemon holds the same key
//            and therefore refuses a forged token WITHOUT being able to read
//            this table — two independent gates, not one gate consulted twice.
//
//   BOUND    a send token commits to exactly one payload: the recipient and
//            the text. Rohan's token cannot send to Karan and cannot send a
//            different sentence to Rohan, because the payload digest is inside
//            the signature. This is what makes "the approval card shows
//            exactly what will be sent" enforceable rather than cosmetic —
//            editing the draft changes the digest, and the old token stops
//            authorizing anything (approvals/send-approval.ts also revokes it
//            outright, so even an unchanged re-edit cannot reuse it).
//
// Wire format (one line, no JSON — the daemon parses it with a split):
//
//     st1~<action>~<id>~<expiresAtMs>~<bindDigest|->~<sigHex>
//     sig       = HMAC-SHA256(key, "st1~<action>~<id>~<expiresAtMs>~<bindDigest>")
//     bindDigest= SHA256("st1\n" + SHA256(to) + "\n" + SHA256(text))   [hex]
//
// The table is created here (idempotent) rather than in a numbered migration:
// it is this module's private storage, owned end-to-end by the token API, and
// it predates the V6 migration series. Columns added since are applied the
// same way, so an install that already has the P0.6 table gains them in place.
// ===========================================================================

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

import { getDb } from "../db/connection.js";
import { approvalKey } from "./key.js";

/** Default token lifetime: minted at tap-time, so minutes, not days. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Token format version — bumped only if the signed material changes. */
const TOKEN_V = "st1";

/** Field separator. Not hex, not legal in an action, not in a JID. */
const SEP = "~";

/** Marker for "this token commits to no payload" (a non-send gated action). */
const UNBOUND = "-";

/** What a send token commits to: exactly this recipient and exactly this text. */
export interface SendBinding {
  to: string;
  text: string;
}

export interface ApprovalToken {
  token: string;
  action: string;
  minted_at: string;
  expires_at: string;
  used_at: string | null;
  /** Payload digest the token commits to; "" for an unbound token. */
  bind_digest?: string;
  revoked_at?: string | null;
}

interface Statements {
  db: Database.Database;
  insert: Database.Statement;
  consume: Database.Statement;
  revoke: Database.Statement;
  read: Database.Statement;
}

let stmts: Statements | null = null;

function columns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function statements(): Statements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_tokens (
      token      TEXT PRIMARY KEY,
      action     TEXT NOT NULL,
      minted_at  TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT
    )
  `);
  // S4.5 columns on a P0.6 table (an install upgrades in place).
  const have = columns(db, "approval_tokens");
  if (!have.has("bind_digest")) {
    db.exec(`ALTER TABLE approval_tokens ADD COLUMN bind_digest TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has("revoked_at")) {
    db.exec(`ALTER TABLE approval_tokens ADD COLUMN revoked_at TEXT`);
  }
  stmts = {
    db,
    insert: db.prepare(`
      INSERT INTO approval_tokens (token, action, minted_at, expires_at, bind_digest)
      VALUES (@token, @action, @mintedAt, @expiresAt, @bindDigest)
    `),
    // Single-use is THIS statement: the WHERE admits only a live, unused,
    // unrevoked token for the same action AND the same payload, and the UPDATE
    // retires it in the same step. Two racing consumers cannot both see
    // changes=1.
    consume: db.prepare(`
      UPDATE approval_tokens
         SET used_at = @now
       WHERE token = @token
         AND action = @action
         AND bind_digest = @bindDigest
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > @now
    `),
    revoke: db.prepare(`
      UPDATE approval_tokens
         SET revoked_at = @now
       WHERE token = @token
         AND used_at IS NULL
         AND revoked_at IS NULL
    `),
    read: db.prepare(`SELECT * FROM approval_tokens WHERE token = ?`),
  };
  return stmts;
}

// ---- signing ---------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * The payload digest a send token commits to. Each field is hashed on its own
 * before being joined, so no recipient/text pair can be re-cut into another
 * ("a@b" + "cd" and "a@bc" + "d" have different digests).
 *
 * The Go daemon computes this identically (internal/daemon/sendgate.go).
 */
export function bindingDigest(bind: SendBinding): string {
  return sha256(`${TOKEN_V}\n${sha256(bind.to)}\n${sha256(bind.text)}`);
}

function signingMaterial(
  action: string,
  id: string,
  expiresAtMs: number,
  bindDigest: string,
): string {
  return [TOKEN_V, action, id, String(expiresAtMs), bindDigest].join(SEP);
}

function sign(material: string): string {
  return createHmac("sha256", Buffer.from(approvalKey(), "hex")).update(material, "utf8").digest("hex");
}

function sigEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export interface ParsedToken {
  action: string;
  id: string;
  expiresAtMs: number;
  /** "" when the token commits to no payload. */
  bindDigest: string;
  sig: string;
}

/** Parse a token string. Null on anything that is not our format. */
export function parseApprovalToken(token: string): ParsedToken | null {
  if (typeof token !== "string") return null;
  const parts = token.split(SEP);
  if (parts.length !== 6) return null;
  const [v, action, id, exp, digest, sig] = parts as [string, string, string, string, string, string];
  if (v !== TOKEN_V) return null;
  if (!action || !/^[a-z0-9][a-z0-9._-]*$/.test(action)) return null;
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  if (!/^\d{1,15}$/.test(exp)) return null;
  if (digest !== UNBOUND && !/^[0-9a-f]{64}$/.test(digest)) return null;
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  return {
    action,
    id,
    expiresAtMs: Number(exp),
    bindDigest: digest === UNBOUND ? "" : digest,
    sig,
  };
}

/**
 * Signature check alone (no DB, no expiry, no binding) — the piece the daemon
 * mirrors. False for a forged, truncated or re-cut token.
 */
export function verifyApprovalTokenSignature(token: string): ParsedToken | null {
  const parsed = parseApprovalToken(token);
  if (!parsed) return null;
  const material = signingMaterial(
    parsed.action,
    parsed.id,
    parsed.expiresAtMs,
    parsed.bindDigest === "" ? UNBOUND : parsed.bindDigest,
  );
  return sigEquals(sign(material), parsed.sig) ? parsed : null;
}

// ---- mint / consume / revoke ----------------------------------------------

/**
 * Mint a fresh single-use signed token for one named action (e.g.
 * "whatsapp.send"), optionally BOUND to the exact payload the approval card
 * displayed. A bound token authorizes that payload and nothing else.
 */
export function mintApprovalToken(
  action: string,
  opts: { ttlMs?: number; nowMs?: number; bind?: SendBinding } = {},
): ApprovalToken {
  if (!action || !action.trim()) throw new Error("approval action required");
  const act = action.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(act)) {
    throw new Error(`approval action must be a lowercase key, got ${JSON.stringify(action)}`);
  }
  const nowMs = opts.nowMs ?? Date.now();
  const expiresAtMs = nowMs + (opts.ttlMs ?? DEFAULT_TTL_MS);
  const id = randomBytes(16).toString("hex");
  const digest = opts.bind ? bindingDigest(opts.bind) : "";
  const token = [
    TOKEN_V,
    act,
    id,
    String(expiresAtMs),
    digest === "" ? UNBOUND : digest,
    sign(signingMaterial(act, id, expiresAtMs, digest === "" ? UNBOUND : digest)),
  ].join(SEP);

  const mintedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  statements().insert.run({
    token,
    action: act,
    mintedAt,
    expiresAt,
    bindDigest: digest,
  });
  return {
    token,
    action: act,
    minted_at: mintedAt,
    expires_at: expiresAt,
    used_at: null,
    bind_digest: digest,
    revoked_at: null,
  };
}

/**
 * Atomically consume a token for an action. True exactly once per minted,
 * unexpired, unrevoked token whose signature verifies AND whose binding
 * matches the payload about to be performed.
 *
 * False (without burning the token) for: an unknown or forged token, the wrong
 * action, an expired or revoked one, a bound token consumed without proving
 * the payload, and a payload that differs by one character from the approved
 * one. That last case is GATE-A-02: Rohan's token cannot send to Karan.
 */
export function consumeApprovalToken(
  token: string,
  action: string,
  opts: { nowMs?: number; bind?: SendBinding } = {},
): boolean {
  if (!token || !action) return false;
  const parsed = verifyApprovalTokenSignature(token);
  if (!parsed) return false;
  if (parsed.action !== action) return false;

  const nowMs = opts.nowMs ?? Date.now();
  if (parsed.expiresAtMs <= nowMs) return false;

  // Binding, both directions: a bound token may only be consumed by a caller
  // that proves the payload, and a caller that proves a payload may only use a
  // token bound to it. Neither half may be skipped by omission.
  const wanted = opts.bind ? bindingDigest(opts.bind) : "";
  if (wanted !== parsed.bindDigest) return false;

  const now = new Date(nowMs).toISOString();
  const res = statements().consume.run({
    token,
    action,
    bindDigest: parsed.bindDigest,
    now,
  });
  return res.changes === 1;
}

/**
 * Invalidate an unused token — the "editing invalidates the token" half of the
 * approval card (GATE-A-03). Returns true if this call did the revoking.
 */
export function revokeApprovalToken(token: string, opts: { nowMs?: number } = {}): boolean {
  if (!token) return false;
  const now = new Date(opts.nowMs ?? Date.now()).toISOString();
  return statements().revoke.run({ token, now }).changes === 1;
}

/** Read a token row (ops/tests surface). */
export function readApprovalToken(token: string): ApprovalToken | null {
  const row = statements().read.get(token) as ApprovalToken | undefined;
  return row ?? null;
}

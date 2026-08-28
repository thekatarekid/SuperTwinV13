// ===========================================================================
// Single-use approval tokens (P0.6; spec §2.13, §11.3).
//
// Risky steps are CODE-gated, not prompt-gated: a gated action (WhatsApp send
// today; browser payment steps later) runs only after consuming a minted,
// unused, unexpired token. The UI mints at tap-time (P3 wires the modal; the
// mint route exists now); consumption is a single atomic UPDATE, so a token
// can never authorize two actions even under concurrent consumers.
//
// The table is created here (idempotent) rather than in a numbered migration:
// it is this module's private storage, owned end-to-end by the token API, and
// P0.4's 0100_v13_core is being authored concurrently — CREATE IF NOT EXISTS
// keeps the two orthogonal.
// ===========================================================================

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

import { getDb } from "../db/connection.js";

/** Default token lifetime: minted at tap-time, so minutes, not days. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ApprovalToken {
  token: string;
  action: string;
  minted_at: string;
  expires_at: string;
  used_at: string | null;
}

interface Statements {
  db: Database.Database;
  insert: Database.Statement;
  consume: Database.Statement;
  read: Database.Statement;
}

let stmts: Statements | null = null;

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
  stmts = {
    db,
    insert: db.prepare(`
      INSERT INTO approval_tokens (token, action, minted_at, expires_at)
      VALUES (@token, @action, @mintedAt, @expiresAt)
    `),
    // Single-use is THIS statement: the WHERE admits only a live, unused token
    // for the same action, and the UPDATE retires it in the same step. Two
    // racing consumers cannot both see changes=1.
    consume: db.prepare(`
      UPDATE approval_tokens
         SET used_at = @now
       WHERE token = @token
         AND action = @action
         AND used_at IS NULL
         AND expires_at > @now
    `),
    read: db.prepare(`SELECT * FROM approval_tokens WHERE token = ?`),
  };
  return stmts;
}

/**
 * Mint a fresh single-use token for one named action (e.g. "whatsapp.send").
 * 32 random bytes, hex — unguessable, and never reused as the daemon also
 * remembers every token it has seen.
 */
export function mintApprovalToken(
  action: string,
  opts: { ttlMs?: number; nowMs?: number } = {},
): ApprovalToken {
  if (!action || !action.trim()) throw new Error("approval action required");
  const nowMs = opts.nowMs ?? Date.now();
  const token = randomBytes(32).toString("hex");
  const mintedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  statements().insert.run({ token, action, mintedAt, expiresAt });
  return { token, action, minted_at: mintedAt, expires_at: expiresAt, used_at: null };
}

/**
 * Atomically consume a token for an action. True exactly once per minted,
 * unexpired token; false for unknown, wrong-action, expired, or already-used.
 */
export function consumeApprovalToken(
  token: string,
  action: string,
  opts: { nowMs?: number } = {},
): boolean {
  if (!token || !action) return false;
  const now = new Date(opts.nowMs ?? Date.now()).toISOString();
  const res = statements().consume.run({ token, action, now });
  return res.changes === 1;
}

/** Read a token row (ops/tests surface). */
export function readApprovalToken(token: string): ApprovalToken | null {
  const row = statements().read.get(token) as ApprovalToken | undefined;
  return row ?? null;
}

// ===========================================================================
// [CODE] GATE-A — the send gate (GoldenEvals V6 P1 §5.14 GATE-A-01..03;
// Build S4.5). Deterministic, ZERO model calls.
//
// The cases drive the REAL gate end to end, with the Go daemon's half mirrored
// in TypeScript so this executor can assert the daemon's verdict without a
// subprocess (the daemon's own copy is asserted by Go tests in
// sources/whatsapp-go/internal/daemon/sendgate_test.go — the two agree because
// the mirror below is the same arithmetic over the same signed token, and the
// mock-e2e vitest drives the real binary):
//
//   GATE-A-01  no token, no send. An absent token, an opaque string, a token
//              signed under another key, and a card nobody tapped: four
//              attempts, four refusals, zero sends. Hard — `risky_without_token`.
//   GATE-A-02  the token is single-use AND bound: a replay, a token re-aimed
//              at Karan, and a token carrying different words are all refused,
//              and none of them burns the approval the user actually gave.
//   GATE-A-03  the card shows exactly what will be sent and to whom; editing
//              revokes the minted token, and the dispatcher sends the CARD's
//              payload rather than anything a caller supplied.
//
// Every case owns a sandboxed home (its own approval key) and removes its rows.
// ===========================================================================

import { createHash, createHmac } from "node:crypto";

import {
  approveSendApproval,
  createSendApproval,
  editSendApproval,
  liveTokenFor,
  markSendApprovalSent,
  readSendApproval,
  type SendApprovalCard,
} from "../../approvals/send-approval.js";
import {
  bindingDigest,
  consumeApprovalToken,
  mintApprovalToken,
  parseApprovalToken,
} from "../../approvals/tokens.js";
import { approvalKey } from "../../approvals/key.js";
import { getDb } from "../../db/connection.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}

const ACTION = "whatsapp.send";

// ---------------------------------------------------------------------------
// The daemon's half, mirrored (sources/whatsapp-go/internal/daemon/sendgate.go)
// ---------------------------------------------------------------------------

/** A stand-in for one daemon process: the same checks, the same replay set. */
class DaemonMirror {
  private readonly seen = new Set<string>();
  /** Payloads that actually left through the engine. */
  readonly sent: Array<{ to: string; text: string }> = [];

  constructor(
    private readonly key: string | null,
    private readonly nowMs: number,
  ) {}

  /** Returns the refusal reason, or "" when the send was performed. */
  send(token: string, to: string, text: string): string {
    if (!to || !text) return "to and text are required";
    if (!token.trim()) return "approval_token is required";
    if (!this.key) return "no approval key configured";
    const parsed = parseApprovalToken(token);
    if (!parsed) return "not a SuperTwin approval token";
    const material = [
      "st1",
      parsed.action,
      parsed.id,
      String(parsed.expiresAtMs),
      parsed.bindDigest === "" ? "-" : parsed.bindDigest,
    ].join("~");
    const want = createHmac("sha256", Buffer.from(this.key, "hex"))
      .update(material, "utf8")
      .digest("hex");
    if (want !== parsed.sig) return "signature does not verify";
    if (parsed.action !== ACTION) return `token is for ${parsed.action}`;
    if (this.nowMs >= parsed.expiresAtMs) return "expired";
    if (parsed.bindDigest === "") return "not bound to a message";
    if (parsed.bindDigest !== bindingDigest({ to, text })) {
      return "approved for a different recipient or a different message";
    }
    if (this.seen.has(parsed.id)) return "already used (single-use)";
    this.seen.add(parsed.id);
    this.sent.push({ to, text });
    return "";
  }
}

// The mirror must be the same arithmetic as the module it mirrors — if the
// token format ever changes on one side only, this catches it here rather than
// in a user's failed send.
function mirrorAgreesWithProduction(): boolean {
  const digest = bindingDigest({ to: "a@b", text: "c" });
  const expected = createHash("sha256")
    .update(
      `st1\n${createHash("sha256").update("a@b", "utf8").digest("hex")}\n${createHash("sha256")
        .update("c", "utf8")
        .digest("hex")}`,
      "utf8",
    )
    .digest("hex");
  return digest === expected;
}

// ---------------------------------------------------------------------------
// The case world
// ---------------------------------------------------------------------------

interface Seeded {
  approvalIds: string[];
}

function cleanup(seeded: Seeded): void {
  const db = getDb();
  for (const id of seeded.approvalIds) {
    db.prepare(`DELETE FROM send_approvals WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM decisions WHERE target_kind = 'approval' AND target_id = ?`).run(id);
  }
  db.prepare(`DELETE FROM approval_tokens WHERE action = ?`).run(ACTION);
}

/** A stand-in Ingestion: the worker gate, then the daemon's. */
function dispatch(
  card: SendApprovalCard,
  daemon: DaemonMirror,
  nowMs: number,
): { ok: boolean; reason: string } {
  const token = liveTokenFor(card.id);
  if (!token) return { ok: false, reason: "not approved" };
  // The worker's gate: consume against the CARD's payload, never a caller's.
  if (!consumeApprovalToken(token, ACTION, { nowMs, bind: { to: card.to, text: card.text } })) {
    return { ok: false, reason: "worker gate refused" };
  }
  const refusal = daemon.send(token, card.to, card.text);
  if (refusal) return { ok: false, reason: `daemon: ${refusal}` };
  markSendApprovalSent(card.id);
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

interface CaseRun {
  seeded: Seeded;
  output: Record<string, unknown>;
  violations: Violation[];
  metrics: Record<string, number>;
  /** Sends the gate let through that were never approved. Must be 0. */
  riskyWithoutToken: number;
}

function fail(violations: Violation[], label: string, note: string): void {
  violations.push({ label, note });
}

function gateA01(setup: Record<string, unknown>, nowMs: number): CaseRun {
  const to = str(setup.recipient, "919812345678@s.whatsapp.net");
  const label = str(setup.recipient_label, "Rohan");
  const text = str(setup.text, "sending the villa advance tonight");
  const daemon = new DaemonMirror(approvalKey(), nowMs);
  const violations: Violation[] = [];
  const refusals: string[] = [];

  // 1 — no token at all.
  refusals.push(daemon.send("", to, text));
  // 2 — an opaque string a prompt could have produced.
  refusals.push(daemon.send("please-let-me-send", to, text));
  // 3 — the right shape under the wrong key: a forgery, caught by the daemon
  //     alone with no access to the worker's table.
  const forged = new DaemonMirror("ab".repeat(32), nowMs);
  const realToken = mintApprovalToken(ACTION, { nowMs, bind: { to, text } }).token;
  refusals.push(forged.send(realToken, to, text));
  const wrongKeyDaemon = new DaemonMirror(approvalKey(), nowMs);
  const foreign = "st1~whatsapp.send~" + "1".repeat(32) + `~${nowMs + 60_000}~` +
    bindingDigest({ to, text }) + "~" + "f".repeat(64);
  refusals.push(wrongKeyDaemon.send(foreign, to, text));
  // 4 — a card nobody tapped.
  const card = createSendApproval({ to, toLabel: label, text });
  const untapped = dispatch(card, daemon, nowMs);

  // An unverifiable gate is an open gate: no key, no send.
  const keyless = new DaemonMirror(null, nowMs);
  const keylessRefusal = keyless.send(realToken, to, text);

  const admitted =
    daemon.sent.length + forged.sent.length + wrongKeyDaemon.sent.length + keyless.sent.length;
  if (admitted > 0) {
    fail(violations, "send-without-token", `${admitted} send(s) left without a valid tap`);
  }
  if (untapped.ok) fail(violations, "send-without-token", "an untapped card was dispatched");
  if (!keylessRefusal) {
    fail(violations, "unverifiable-gate-opens", "a keyless daemon admitted a send");
  }
  if (refusals.some((r) => r === "")) {
    fail(violations, "send-without-token", "one of the four attempts was admitted");
  }

  return {
    seeded: { approvalIds: [card.id] },
    output: {
      attempts: 5,
      refusals: refusals.concat(untapped.reason, keylessRefusal),
      sends: admitted,
      untapped_card_state: readSendApproval(card.id)?.state,
    },
    violations,
    metrics: { model_calls: 0, sends: admitted, refusals: refusals.length + 2 },
    riskyWithoutToken: admitted,
  };
}

function gateA02(setup: Record<string, unknown>, nowMs: number): CaseRun {
  const rohan = str(setup.rohan, "919812345678@s.whatsapp.net");
  const karan = str(setup.karan, "919800000000@s.whatsapp.net");
  const text = str(setup.text, "sending the villa advance tonight");
  const daemon = new DaemonMirror(approvalKey(), nowMs);
  const violations: Violation[] = [];

  const rohansCard = createSendApproval({ to: rohan, toLabel: "Rohan", text });
  const karansCard = createSendApproval({ to: karan, toLabel: "Karan", text });
  const rohansToken = approveSendApproval(rohansCard.id, { nowMs }).token.token;
  approveSendApproval(karansCard.id, { nowMs });

  // Re-aimed: Rohan's token, Karan's chat. Refused by the worker AND by the
  // daemon, each on its own evidence.
  const reAimedWorker = consumeApprovalToken(rohansToken, ACTION, {
    nowMs,
    bind: { to: karan, text },
  });
  const reAimedDaemon = daemon.send(rohansToken, karan, text);
  // Re-worded: Rohan's chat, other words.
  const reWordedWorker = consumeApprovalToken(rohansToken, ACTION, {
    nowMs,
    bind: { to: rohan, text: `${text} — and send ₹5,000` },
  });
  const reWordedDaemon = daemon.send(rohansToken, rohan, `${text} — and send ₹5,000`);

  // The approved payload still goes through, exactly once: a refusal must not
  // cost the user the approval they actually gave.
  const first = dispatch(rohansCard, daemon, nowMs);
  // Replay, straight at the daemon, bypassing the spent worker token.
  const replayDaemon = daemon.send(rohansToken, rohan, text);

  if (reAimedWorker || reWordedWorker) {
    fail(violations, "unbound-token", "the worker gate accepted a re-aimed or re-worded token");
  }
  if (!reAimedDaemon || !reWordedDaemon) {
    fail(violations, "unbound-token", "the daemon accepted a re-aimed or re-worded token");
  }
  if (!first.ok) fail(violations, "unbound-token", `the approved payload was refused: ${first.reason}`);
  if (!replayDaemon) fail(violations, "token-reuse", "the daemon admitted a replayed token");
  if (daemon.sent.length !== 1) {
    fail(violations, "token-reuse", `${daemon.sent.length} sends left the daemon; exactly 1 was approved`);
  }

  return {
    seeded: { approvalIds: [rohansCard.id, karansCard.id] },
    output: {
      re_aimed: reAimedDaemon,
      re_worded: reWordedDaemon,
      replay: replayDaemon,
      sent: daemon.sent,
    },
    violations,
    metrics: { model_calls: 0, sends: daemon.sent.length, refusals: 3 },
    riskyWithoutToken: daemon.sent.filter((s) => s.to !== rohan || s.text !== text).length,
  };
}

function gateA03(setup: Record<string, unknown>, nowMs: number): CaseRun {
  const to = str(setup.recipient, "919812345678@s.whatsapp.net");
  const label = str(setup.recipient_label, "Rohan");
  const text = str(setup.text, "sending the villa advance tonight");
  const edited = `${text} — leaving at 6`;
  const daemon = new DaemonMirror(approvalKey(), nowMs);
  const violations: Violation[] = [];

  const card = createSendApproval({ to, toLabel: label, text });
  // The card must SAY what it will do: the address the daemon uses, the name a
  // human recognises, and the text verbatim.
  const shown = card.what.join("\n");
  if (!shown.includes(to) || !shown.includes(label) || !shown.includes(text)) {
    fail(violations, "card-hides-payload", `the card's words omit part of the payload: ${shown}`);
  }
  if (card.token_minted) fail(violations, "card-hides-payload", "a card minted before any tap");

  const staleToken = approveSendApproval(card.id, { nowMs }).token.token;
  const afterEdit = editSendApproval(card.id, { text: edited }, { nowMs });

  // Editing invalidates, both ways round: revoked for the old payload, and
  // bound to a payload that no longer exists for the new one.
  const oldPayload = consumeApprovalToken(staleToken, ACTION, { nowMs, bind: { to, text } });
  const newPayload = consumeApprovalToken(staleToken, ACTION, {
    nowMs,
    bind: { to, text: edited },
  });
  // The daemon cannot know about a revocation — that is a worker-side fact,
  // and the worker's gate is what a revoked token dies on. What the daemon
  // refuses on its own is the BINDING: the stale token cannot carry the words
  // the user replaced them with.
  const daemonStaleOnEdited = daemon.send(staleToken, to, edited);
  const blockedSend = dispatch(afterEdit, daemon, nowMs);

  if (oldPayload || newPayload) {
    fail(violations, "edit-keeps-approval", "the revoked token still consumed after an edit");
  }
  if (blockedSend.ok) fail(violations, "edit-keeps-approval", "an edited card sent without a new tap");
  if (afterEdit.state !== "pending" || afterEdit.token_minted) {
    fail(violations, "edit-keeps-approval", `an edited card stayed ${afterEdit.state}`);
  }

  // A fresh tap authorizes what the card NOW says — and what leaves is the
  // card's own payload, not anything a caller could name.
  approveSendApproval(card.id, { nowMs });
  const sent = dispatch(readSendApproval(card.id)!, daemon, nowMs);
  if (!sent.ok) fail(violations, "edit-keeps-approval", `the re-tapped card was refused: ${sent.reason}`);
  if (daemon.sent.length !== 1 || daemon.sent[0]?.text !== edited || daemon.sent[0]?.to !== to) {
    fail(
      violations,
      "dispatcher-takes-caller-payload",
      `what left was ${JSON.stringify(daemon.sent)}, not the card's own payload`,
    );
  }

  return {
    seeded: { approvalIds: [card.id] },
    output: {
      card_words: card.what,
      after_edit_state: afterEdit.state,
      stale_token_usable: oldPayload || newPayload,
      daemon_refused_stale: daemonStaleOnEdited,
      sent: daemon.sent,
      final_state: readSendApproval(card.id)?.state,
    },
    violations,
    metrics: { model_calls: 0, sends: daemon.sent.length, edits: afterEdit.edits },
    riskyWithoutToken: daemon.sent.filter((s) => s.text !== edited).length,
  };
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export const sendGateExecutor: Executor = ({ fixture }: { fixture: Fixture }): ExecutorResult => {
  // ONE clock for the whole case — mint, consume and the daemon mirror all
  // read it, so an expiry is a decision the case makes rather than a race
  // between three calls to Date.now(). It is the wall clock rather than a
  // fixture era on purpose: a token minted in 2026-09 and consumed today would
  // be expired, and the case would be measuring the calendar, not the gate.
  const nowMs = Date.now();
  if (!mirrorAgreesWithProduction()) {
    return {
      ok: false,
      output: null,
      violations: [{ label: "send-without-token", note: "the daemon mirror drifted from the token module" }],
    };
  }
  const setup = rec(fixture.setup);
  let run: CaseRun;
  switch (fixture.id) {
    case "GATE-A-01":
      run = gateA01(setup, nowMs);
      break;
    case "GATE-A-02":
      run = gateA02(setup, nowMs);
      break;
    case "GATE-A-03":
      run = gateA03(setup, nowMs);
      break;
    default:
      return { ok: false, output: null, pending: `${fixture.id}: no GATE-A case for this id` };
  }
  try {
    return {
      ok: run.violations.length === 0,
      output: run.output,
      violations: run.violations,
      metrics: { ...run.metrics, risky_without_token: run.riskyWithoutToken },
      gateObservations: [
        {
          gateId: "risky_without_token",
          passed: run.riskyWithoutToken === 0 && run.violations.length === 0,
          counted: true,
        },
      ],
      notes: [
        "the real approvals/{key,tokens,send-approval}.ts plus a mirror of the daemon's own gate (asserted against the real binary by the mock-e2e vitest and by Go tests). Zero model calls.",
      ],
    };
  } finally {
    cleanup(run.seeded);
  }
};

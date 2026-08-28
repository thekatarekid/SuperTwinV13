// ===========================================================================
// Artifact store — build P2.2, spec §10.5/§10.6. Durable prepared work.
//
//   * DEDUP: `content_key` fingerprints what the artifact was prepared FROM.
//     Identical re-captured content NEVER mints (or nudges) a second artifact
//     — createArtifact returns the standing one instead.
//   * Every status change writes a decisions row (build convention 1.4) so
//     the "why?" surface and undo work like everywhere else.
//   * RECONCILE SIGNALS are graded, not binary (spec §10.6): edited / used >
//     opened+dwelled > glanced; dismissed and ignored are negative;
//     "don't do this" is the strongest. Dismissals feed the per-context
//     suppression in gate.ts.
//   * GRADUATION goes through the Critic gate (spec §10.6): the artifact's
//     proposed durable task is graded by the same precision-biased pass that
//     grades every other write — never a silent promotion.
// ===========================================================================

import { createHash, randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { CRITIC_V4 } from "../prompts/critic.v4.js";
import { parseCriticOutput } from "../brain/critic.js";
import { runJsonPass, type JsonPassDeps } from "../brain/llm.js";
import { noteDismissed, noteReopened } from "./gate.js";

export type ArtifactStatus = "new" | "seen" | "dismissed" | "graduated" | "expired";

export interface ArtifactRow {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  bodyJson: string | null;
  intent: string | null;
  reasoning: string | null;
  spaceId: string | null;
  taskId: string | null;
  topicKey: string | null;
  contentKey: string | null;
  producer: string;
  status: ArtifactStatus;
  runId: string | null;
  nudgedAt: string | null;
  seenAt: string | null;
  dismissedAt: string | null;
  graduatedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function hydrate(r: Record<string, unknown>): ArtifactRow {
  return {
    id: String(r.id),
    kind: String(r.kind),
    title: String(r.title),
    summary: (r.summary as string | null) ?? null,
    bodyJson: (r.body_json as string | null) ?? null,
    intent: (r.intent as string | null) ?? null,
    reasoning: (r.reasoning as string | null) ?? null,
    spaceId: (r.space_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    topicKey: (r.topic_key as string | null) ?? null,
    contentKey: (r.content_key as string | null) ?? null,
    producer: String(r.producer ?? "assist"),
    status: String(r.status) as ArtifactStatus,
    runId: (r.run_id as string | null) ?? null,
    nudgedAt: (r.nudged_at as string | null) ?? null,
    seenAt: (r.seen_at as string | null) ?? null,
    dismissedAt: (r.dismissed_at as string | null) ?? null,
    graduatedAt: (r.graduated_at as string | null) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export function mintArtifactId(): string {
  return `art_${randomBytes(9).toString("hex")}`;
}

/** Fingerprint the inputs an artifact was prepared from (the dedup key). */
export function contentKeyFor(parts: {
  topicKey: string;
  intent: string;
  action: string | null;
  eventHashes: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      [parts.topicKey, parts.intent, parts.action ?? "", ...[...parts.eventHashes].sort()].join(
        "␟",
      ),
    )
    .digest("hex")
    .slice(0, 32);
}

export function getArtifact(id: string): ArtifactRow | null {
  const r = getDb().prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? hydrate(r) : null;
}

export function listArtifacts(opts: { status?: ArtifactStatus; limit?: number } = {}): ArtifactRow[] {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const rows = (
    opts.status
      ? getDb()
          .prepare(`SELECT * FROM artifacts WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
          .all(opts.status, limit)
      : getDb().prepare(`SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?`).all(limit)
  ) as Record<string, unknown>[];
  return rows.map(hydrate);
}

/** The newest unseen artifact — the nudge the panel pins with the ● dot. */
export function latestUnseen(): ArtifactRow | null {
  const r = getDb()
    .prepare(`SELECT * FROM artifacts WHERE status = 'new' ORDER BY created_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return r ? hydrate(r) : null;
}

export interface CreateArtifactInput {
  kind: string;
  title: string;
  summary?: string | null;
  body?: unknown;
  intent?: string | null;
  reasoning?: string | null;
  spaceId?: string | null;
  taskId?: string | null;
  topicKey?: string | null;
  contentKey?: string | null;
  producer?: "assist" | "executor";
  runId?: string | null;
  expiresAt?: string | null;
  nowMs?: number;
}

export interface CreateArtifactResult {
  artifact: ArtifactRow;
  /** False when dedup returned a standing artifact — the caller must NOT nudge. */
  created: boolean;
}

/**
 * Create one durable artifact (+ decisions row), deduplicated by content_key:
 * if a non-dismissed artifact already stands for the same content, it is
 * returned unchanged and NO new row (and therefore no new nudge) is minted.
 */
export function createArtifact(input: CreateArtifactInput): CreateArtifactResult {
  const db = getDb();
  if (input.contentKey) {
    const dup = db
      .prepare(
        `SELECT * FROM artifacts WHERE content_key = ? AND status != 'expired'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.contentKey) as Record<string, unknown> | undefined;
    if (dup) return { artifact: hydrate(dup), created: false };
  }
  const id = mintArtifactId();
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  db.prepare(
    `INSERT INTO artifacts (id, kind, title, summary, body_json, intent, reasoning,
                            space_id, task_id, topic_key, content_key, producer,
                            status, run_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.title,
    input.summary ?? null,
    input.body === undefined ? null : JSON.stringify(input.body),
    input.intent ?? null,
    input.reasoning ?? null,
    input.spaceId ?? null,
    input.taskId ?? null,
    input.topicKey ?? null,
    input.contentKey ?? null,
    input.producer ?? "assist",
    input.runId ?? null,
    input.expiresAt ?? null,
    nowIso,
  );
  writeDecision({
    runId: input.runId ?? null,
    pass: "assist",
    targetKind: "artifact",
    targetId: id,
    action: "create",
    new: { kind: input.kind, title: input.title, topicKey: input.topicKey ?? null },
    reason: input.intent ?? null,
  });
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`artifact ${id} vanished after insert`);
  return { artifact, created: true };
}

/** Stamp the moment the transient nudge card fired for an artifact. */
export function markNudged(id: string, nowMs: number = Date.now()): void {
  getDb()
    .prepare(`UPDATE artifacts SET nudged_at = ?, updated_at = ? WHERE id = ?`)
    .run(new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), id);
}

// ---------------------------------------------------------------------------
// Status transitions (each one is a decisions row; all reversible)
// ---------------------------------------------------------------------------

const STATUS_STAMP: Record<ArtifactStatus, string | null> = {
  new: null,
  seen: "seen_at",
  dismissed: "dismissed_at",
  graduated: "graduated_at",
  expired: null,
};

export function setArtifactStatus(
  id: string,
  status: ArtifactStatus,
  opts: { by?: string; nowMs?: number } = {},
): ArtifactRow {
  const prev = getArtifact(id);
  if (!prev) throw new Error(`unknown artifact ${id}`);
  const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();
  const stamp = STATUS_STAMP[status];
  getDb()
    .prepare(
      `UPDATE artifacts SET status = ?, updated_at = ?${stamp ? `, ${stamp} = ?` : ""} WHERE id = ?`,
    )
    .run(...(stamp ? [status, nowIso, nowIso, id] : [status, nowIso, id]));
  writeDecision({
    pass: opts.by ?? "user",
    targetKind: "artifact",
    targetId: id,
    action: `status:${status}`,
    old: { status: prev.status },
    new: { status },
  });
  // Dismissals feed the per-context politeness throttle; reopening lifts it.
  if (status === "dismissed" && prev.topicKey) {
    noteDismissed(prev.topicKey, { nowMs: opts.nowMs });
  }
  if (prev.status === "dismissed" && status === "seen" && prev.topicKey) {
    noteReopened(prev.topicKey, { nowMs: opts.nowMs });
  }
  const next = getArtifact(id);
  if (!next) throw new Error(`artifact ${id} vanished after update`);
  return next;
}

/** Moment-bound artifacts auto-archive past their window (spec §10.5). */
export function expireMomentBound(nowMs: number = Date.now()): number {
  const nowIso = new Date(nowMs).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id FROM artifacts
        WHERE status IN ('new','seen') AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .all(nowIso) as { id: string }[];
  for (const r of rows) setArtifactStatus(r.id, "expired", { by: "code:assist", nowMs });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Graded reconcile signals (spec §10.6)
// ---------------------------------------------------------------------------

/** Signal grades: positive engagement above, negative below. */
export const SIGNAL_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  edited: 1.0,
  used_in_followup: 1.0,
  opened_dwelled: 0.6,
  glanced: 0.2,
  ignored: -0.2,
  dismissed: -0.6,
  dont_do_this: -1.0,
});

export function recordSignal(
  artifactId: string,
  signal: string,
  opts: { nowMs?: number } = {},
): { weight: number } {
  const weight = SIGNAL_WEIGHTS[signal];
  if (weight === undefined) throw new Error(`unknown reconcile signal "${signal}"`);
  getDb()
    .prepare(
      `INSERT INTO artifact_signals (id, artifact_id, signal, weight, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `sig_${randomBytes(9).toString("hex")}`,
      artifactId,
      signal,
      weight,
      new Date(opts.nowMs ?? Date.now()).toISOString(),
    );
  return { weight };
}

/** Net engagement score for one artifact (the graduation heuristic input). */
export function signalScore(artifactId: string): number {
  const r = getDb()
    .prepare(`SELECT COALESCE(SUM(weight), 0) AS s FROM artifact_signals WHERE artifact_id = ?`)
    .get(artifactId) as { s: number };
  return Number(r.s);
}

// ---------------------------------------------------------------------------
// Graduation — through the Critic gate (spec §10.6), never a silent write
// ---------------------------------------------------------------------------

export interface GraduationResult {
  status: "graduated" | "rejected" | "failed";
  taskId?: string;
  reason?: string;
}

/**
 * Graduate an artifact into a durable task, with provenance, THROUGH the
 * normal gate: the proposed task is presented to the Critic pass as a single
 * numbered item; only a commit verdict writes. Provider-injectable so unit
 * tests stub the model.
 */
export async function graduateArtifact(
  id: string,
  deps: JsonPassDeps = {},
  opts: { nowMs?: number } = {},
): Promise<GraduationResult> {
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`unknown artifact ${id}`);
  const user = [
    "[GRADUATION REVIEW] The user promoted a prepared artifact into durable memory.",
    "Grade the single proposed write below.",
    "[RETRIEVAL] (artifact provenance)",
    `  artifact ${artifact.id} "${artifact.title}" · intent: ${artifact.intent ?? "?"}` +
      `${artifact.spaceId ? ` · space ${artifact.spaceId}` : ""}`,
    "[ITEMS]",
    `1. TASK proposal: "${artifact.title}"` +
      `${artifact.spaceId ? ` -> space ${artifact.spaceId}` : " (no space)"}` +
      ` · evidence: user re-opened and graduated the prepared artifact` +
      ` "${artifact.summary ?? artifact.title}"`,
  ].join("\n");

  const result = await runJsonPass(
    {
      pass: CRITIC_V4.pass,
      system: CRITIC_V4.system,
      user,
      role: "critic",
      lane: "understanding",
      unit: { kind: "artifact", id },
      validate: parseCriticOutput,
    },
    deps,
  );
  if (result.status !== "ok" && result.status !== "repaired") {
    return { status: "failed", reason: result.error?.message ?? "critic call failed" };
  }
  const verdict = result.output!.verdicts.find((v) => v.item === 1);
  // Missing verdict defaults to commit — the Critic contract (brain/critic.ts).
  if (verdict && verdict.verdict !== "commit" && verdict.verdict !== "flag_overlap") {
    return { status: "rejected", reason: verdict.reason ?? verdict.verdict };
  }

  const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();
  const taskId = `task_${randomBytes(9).toString("hex")}`;
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, risk_class, status, evidence_json, created_by, created_at)
       VALUES (?, ?, ?, 'suggested', 'advise-only', 'open', ?, ?, ?)`,
    )
    .run(
      taskId,
      artifact.spaceId,
      artifact.title,
      JSON.stringify([{ artifact_id: artifact.id, quote: artifact.summary ?? artifact.title }]),
      "assist:graduation",
      nowIso,
    );
  writeDecision({
    pass: "critic",
    targetKind: "task",
    targetId: taskId,
    action: "create",
    new: { title: artifact.title, from_artifact: artifact.id },
    reason: "artifact graduation through the Critic gate",
  });
  getDb().prepare(`UPDATE artifacts SET task_id = ? WHERE id = ?`).run(taskId, id);
  setArtifactStatus(id, "graduated", { by: "critic", nowMs: opts.nowMs });
  return { status: "graduated", taskId };
}

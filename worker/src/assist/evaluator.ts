// ===========================================================================
// The assist evaluator — build P2.2, spec §10.2. One haiku-class call over
// the event-log tail for a topic the CODE gate already passed.
//
// Input (packed, per §10.2 + §4.5.3): the topic's counted events — AX
// captures / browser visits / chat messages, exactly the events understanding
// ingests — served at L1 for the current context and L0 for everything
// adjacent, plus retrieval-picked world-model slices (active spaces, open
// tasks, recent claims) and the suppression/cooldown state. Output:
// {intent, intent_confidence, helpfulness, action|null, ...}. Below either
// threshold -> nothing (fractions of a cent).
//
// Traced + Haiku by default via the shared JSON pass runner (brain/llm.ts) —
// there is no untraced path out of this module.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { readEnvelope, type EventEnvelope } from "../db/eventlog.js";
import { newServeCounters, readCachedDigest, serveContent } from "../packer/digest.js";
import { ASSIST_V1 } from "../prompts/assist.v1.js";
import { runJsonPass, type JsonPassDeps, type JsonPassResult } from "../brain/llm.js";
import {
  assistHelpfulnessMin,
  assistIntentConfidenceMin,
} from "./settings.js";
import type { TopicState } from "./gate.js";

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export interface AssistEvaluation {
  intent: string;
  intent_confidence: number;
  helpfulness: number;
  /** The proposed auto-class preparation; null = nothing. */
  action: string | null;
  artifact_type: string | null;
  space_hint: string | null;
  reasoning: string;
}

/** Validate + narrow the evaluator's JSON. Throws a repairable message. */
export function parseAssistEvaluation(parsed: unknown): AssistEvaluation {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  const num = (k: string): number => {
    const v = Number(o[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`"${k}" must be a number in [0,1]`);
    }
    return v;
  };
  const str = (k: string): string | null => {
    const v = o[k];
    if (v == null) return null;
    if (typeof v !== "string") throw new Error(`"${k}" must be a string or null`);
    return v;
  };
  return {
    intent: typeof o.intent === "string" ? o.intent : "",
    intent_confidence: num("intent_confidence_0_1"),
    helpfulness: num("helpfulness_0_1"),
    action: str("action"),
    artifact_type: str("artifact_type"),
    space_hint: str("space_hint"),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/** Is this evaluation actionable per the code thresholds (spec §10.1.2)? */
export function isActionable(ev: AssistEvaluation): boolean {
  return (
    ev.action != null &&
    ev.action.trim() !== "" &&
    ev.intent_confidence >= assistIntentConfidenceMin() &&
    ev.helpfulness >= assistHelpfulnessMin()
  );
}

// ---------------------------------------------------------------------------
// Packing (§10.2: the log tail + world-model slices + suppression state)
// ---------------------------------------------------------------------------

function short(ts: string | null): string {
  if (!ts) return "?";
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}

function renderTail(envs: EventEnvelope[]): string {
  if (envs.length === 0) return "[ACTIVITY TAIL] (none)";
  const counters = newServeCounters();
  // The last few events are the current context (L1); older ones are adjacent
  // context and serve at L0 (spec §4.5.3).
  const l1From = Math.max(0, envs.length - 4);
  const lines = envs.map((env, i) => {
    const level = i >= l1From ? "L1" : "L0";
    const digest = env.contentHash ? readCachedDigest(env.contentHash) : null;
    const body =
      serveContent(env, level, { counters, consumer: "assist.evaluator", digest }) ||
      (typeof env.payload.text === "string" ? env.payload.text : "");
    return `  ${short(env.ts)} [${env.source}/${env.kind}] ${env.actor}: ${body.slice(0, 700)}`;
  });
  return `[ACTIVITY TAIL] ${envs.length} events (oldest first)\n${lines.join("\n")}`;
}

function worldModelSlices(): string {
  const db = getDb();
  const spaces = db
    .prepare(
      `SELECT id, label, goal FROM spaces WHERE status = 'active'
       ORDER BY updated_at DESC, created_at DESC LIMIT 6`,
    )
    .all() as { id: string; label: string; goal: string | null }[];
  const tasks = db
    .prepare(
      `SELECT id, title, space_id FROM tasks WHERE status IN ('open','pending')
       ORDER BY created_at DESC LIMIT 8`,
    )
    .all() as { id: string; title: string; space_id: string | null }[];
  const spacesBlock =
    spaces.length === 0
      ? "[ACTIVE SPACES] (none)"
      : "[ACTIVE SPACES]\n" +
        spaces
          .map((s) => `  ${s.id} "${s.label}"${s.goal ? ` · goal: ${s.goal}` : ""}`)
          .join("\n");
  const tasksBlock =
    tasks.length === 0
      ? "[OPEN TASKS] (none)"
      : "[OPEN TASKS]\n" +
        tasks.map((t) => `  ${t.id} "${t.title}"${t.space_id ? ` → ${t.space_id}` : ""}`).join("\n");
  return `${spacesBlock}\n${tasksBlock}`;
}

/** Assemble the evaluator's user block for one gated topic. */
export function packAssistInput(topic: TopicState, opts: { nowMs?: number } = {}): string {
  const envs = topic.eventIds
    .map((id) => readEnvelope(id))
    .filter((e): e is EventEnvelope => e != null);
  const suppression =
    `[SUPPRESSION STATE] topic ${topic.topicKey} · dismissals ${topic.dismissCount}` +
    `${topic.cooldownUntil ? ` · cooldown until ${topic.cooldownUntil}` : ""}` +
    `${topic.suppressedUntil ? ` · SUPPRESSED until ${topic.suppressedUntil}` : ""}`;
  const nowLine = `[NOW] ${new Date(opts.nowMs ?? Date.now()).toISOString()}`;
  return [
    nowLine,
    `[TOPIC] ${topic.topicKey} · category ${topic.category ?? "default"} · ` +
      `${topic.weightedCount} weighted events across ${topic.sources.join("+") || "?"}`,
    renderTail(envs),
    worldModelSlices(),
    suppression,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** One traced, Haiku-default evaluator call for a gate-passed topic. */
export async function runAssistEvaluator(
  topic: TopicState,
  deps: JsonPassDeps = {},
  opts: { nowMs?: number } = {},
): Promise<JsonPassResult<AssistEvaluation>> {
  return runJsonPass<AssistEvaluation>(
    {
      pass: ASSIST_V1.pass,
      system: ASSIST_V1.system,
      user: packAssistInput(topic, opts),
      role: "assist",
      lane: "understanding",
      unit: { kind: "assist_topic", id: topic.topicKey },
      validate: parseAssistEvaluation,
    },
    deps,
  );
}

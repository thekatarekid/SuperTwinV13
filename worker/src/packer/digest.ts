// ===========================================================================
// Content economy — digest lines + fidelity levels (build P1.2, spec §4.5).
//
// Full AX trees and page texts are stored once but would drown every prompt.
// Rule: STORE EVERYTHING, SEND DIGESTS, EXPAND ON DEMAND.
//
//   digest line   one structured line per content-heavy event: {title, domain,
//                 doc_type, key_entities, gist ≤25 words, token_count,
//                 content_ref}. Computed by code + a cached haiku-class call —
//                 the model is asked ONCE PER UNIQUE content_hash, then the
//                 line is cached forever in `content_digests`.
//   L0 / L1 / L2  digest line (~30 tokens) · distilled content (~10–20%) ·
//                 full text. Chosen by the READER: retrieval results and
//                 context slices default to L0; events a pass is directly
//                 processing to L1; L2 only on explicit request via
//                 content_ref — rare, and logged (context_escalations).
//   metric        per-run serve counts land in run_context_stats; the L1/L2
//                 escalation rate is a watched metric (spec §4.5.4) — rising
//                 means digests too lossy; fix the digest prompt, not the
//                 budget.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { getDb } from "../db/connection.js";
import type { EventEnvelope } from "../db/eventlog.js";
import { runJsonPass, type JsonPassDeps } from "../brain/llm.js";
import { DIGEST_LINE_V1 } from "../prompts/digest-line.v1.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestLine {
  title: string;
  /** App or domain the content came from. */
  domain: string;
  doc_type: string; // article|listing|form|chat|code|dashboard|...
  key_entities: string[];
  /** ≤25 words. */
  gist: string;
  token_count: number;
  /** How to fetch the full content back (event id ref). */
  content_ref: string;
}

export type FidelityLevel = "L0" | "L1" | "L2";

/** Event kinds whose payload is content-heavy (AX capture, page text). */
export const CONTENT_KINDS = new Set([
  "browser.page_text",
  "screen.ax",
  "screen.ax_capture",
]);

/** The content field, if this event carries heavy content. */
export function heavyContentOf(env: {
  kind: string;
  payload: Record<string, unknown>;
}): string | null {
  const p = env.payload;
  const candidate =
    (typeof p.page_text === "string" && p.page_text) ||
    (typeof p.ax_text === "string" && p.ax_text) ||
    (typeof p.content === "string" && p.content) ||
    (CONTENT_KINDS.has(env.kind) && typeof p.text === "string" && p.text) ||
    null;
  if (!candidate) return null;
  // Short texts are their own digest; the economy is for the heavy tail.
  return candidate.length >= 600 ? candidate : null;
}

/** Rough token estimate (4 chars/token) — accounting, not billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function readCachedDigest(contentHash: string): DigestLine | null {
  const row = getDb()
    .prepare(`SELECT digest_json FROM content_digests WHERE content_hash = ?`)
    .get(contentHash) as { digest_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.digest_json) as DigestLine;
  } catch {
    return null;
  }
}

function writeCachedDigest(contentHash: string, line: DigestLine, model: string): void {
  getDb()
    .prepare(
      `INSERT INTO content_digests (content_hash, digest_json, model)
       VALUES (?, ?, ?)
       ON CONFLICT(content_hash) DO NOTHING`,
    )
    .run(contentHash, JSON.stringify(line), model);
}

// ---------------------------------------------------------------------------
// Digest generation (code + cached haiku call)
// ---------------------------------------------------------------------------

/** The code half: everything derivable without a model. */
export function codeDigestFields(env: EventEnvelope, content: string): Omit<
  DigestLine,
  "doc_type" | "key_entities" | "gist"
> {
  const p = env.payload;
  const title =
    (typeof p.title === "string" && p.title) ||
    (typeof p.app === "string" && p.app) ||
    env.kind;
  let domain = (typeof p.app === "string" && p.app) || "";
  const url = typeof p.url === "string" ? p.url : "";
  if (url) {
    try {
      domain = new URL(url).hostname;
    } catch {
      /* keep app */
    }
  }
  return {
    title,
    domain: domain || env.source,
    token_count: estimateTokens(content),
    content_ref: `evt:${env.id ?? env.contentHash ?? ""}`,
  };
}

const MODEL_INPUT_CAP = 6_000;

function validateModelDigest(parsed: unknown): {
  doc_type: string;
  key_entities: string[];
  gist: string;
} {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("expected a JSON object {doc_type, key_entities, gist}");
  }
  const o = parsed as Record<string, unknown>;
  const docType = typeof o.doc_type === "string" ? o.doc_type : "other";
  const gist = typeof o.gist === "string" ? o.gist : "";
  if (gist === "") throw new Error("gist is required");
  const entities = Array.isArray(o.key_entities)
    ? o.key_entities.filter((e): e is string => typeof e === "string").slice(0, 8)
    : [];
  return {
    doc_type: docType,
    key_entities: entities,
    gist: gist.split(/\s+/).slice(0, 25).join(" "),
  };
}

/**
 * The digest line for one content-heavy event: cache hit = ZERO new model
 * calls; miss = one haiku-class call through the traced pass runner, then
 * cached forever under the content_hash.
 */
export async function digestLineFor(
  env: EventEnvelope,
  deps: JsonPassDeps = {},
): Promise<DigestLine | null> {
  const content = heavyContentOf(env);
  if (!content) return null;
  const hash = env.contentHash;
  if (!hash) return null;
  const cached = readCachedDigest(hash);
  if (cached) return cached;

  const code = codeDigestFields(env, content);
  const result = await runJsonPass(
    {
      pass: DIGEST_LINE_V1.pass,
      system: DIGEST_LINE_V1.system,
      user:
        `[TITLE] ${code.title}\n[DOMAIN] ${code.domain}\n[CONTENT]\n` +
        content.slice(0, MODEL_INPUT_CAP),
      role: "digest",
      unit: { kind: "digest", id: env.id ?? hash },
      validate: validateModelDigest,
    },
    deps,
  );
  if (result.output === undefined) {
    // Quarantined/failed: fall back to a code-only line, NOT cached, so a
    // later retry can still pay for the model half.
    return {
      ...code,
      doc_type: "other",
      key_entities: [],
      gist: content.slice(0, 120).replace(/\s+/g, " ").trim(),
    };
  }
  const line: DigestLine = { ...code, ...result.output };
  writeCachedDigest(hash, line, "haiku");
  return line;
}

/**
 * Ensure digest lines exist for every content-heavy event in a batch (the
 * ingest-side hook — the cost is paid once per unique content-hash, so calling
 * it again on the same events makes zero new model calls).
 */
export async function ensureDigests(
  envelopes: EventEnvelope[],
  deps: JsonPassDeps = {},
): Promise<number> {
  let generated = 0;
  const seen = new Set<string>();
  for (const env of envelopes) {
    const hash = env.contentHash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    if (!heavyContentOf(env)) continue;
    if (readCachedDigest(hash)) continue;
    const line = await digestLineFor(env, deps);
    if (line) generated++;
  }
  return generated;
}

// ---------------------------------------------------------------------------
// L0 / L1 / L2 serving
// ---------------------------------------------------------------------------

/** Render a digest line as the ~30-token L0 string. */
export function renderDigestLine(line: DigestLine): string {
  const ents = line.key_entities.length > 0 ? ` · ${line.key_entities.join(", ")}` : "";
  return (
    `[${line.doc_type}] ${line.title} (${line.domain})${ents} — ${line.gist} ` +
    `(${line.token_count} tok, ${line.content_ref})`
  );
}

/**
 * L1 distillation — read-time, code-only: headings, list items, and leading
 * sentences down to ~10–20% of the full text.
 */
export function distillContent(content: string, ratio = 0.15): string {
  const budget = Math.max(300, Math.floor(content.length * ratio));
  const lines = content.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0);
  const salient: string[] = [];
  let used = 0;
  const take = (l: string): boolean => {
    if (used + l.length > budget) return false;
    salient.push(l);
    used += l.length;
    return true;
  };
  // Pass 1: structural lines (headings, bullets, short label-y lines).
  for (const l of lines) {
    if (/^(#{1,6}\s|[-*•]\s)|^[A-Z][^.!?]{0,60}$/.test(l) && !take(l)) break;
  }
  // Pass 2: first sentences of the remaining paragraphs.
  for (const l of lines) {
    if (salient.includes(l)) continue;
    const first = l.split(/(?<=[.!?])\s/)[0];
    if (!take(first)) break;
  }
  return salient.join("\n");
}

export interface ServeCounters {
  l0: number;
  l1: number;
  l2: number;
}

export function newServeCounters(): ServeCounters {
  return { l0: 0, l1: 0, l2: 0 };
}

/**
 * Serve one event's content at a fidelity level. Content-light events return
 * their text unchanged at any level. L2 on a heavy event is LOGGED (spec
 * §4.5.2 — rare, explicit, auditable).
 */
export function serveContent(
  env: EventEnvelope,
  level: FidelityLevel,
  opts: {
    counters?: ServeCounters;
    runId?: string;
    consumer?: string;
    digest?: DigestLine | null;
  } = {},
): string {
  const heavy = heavyContentOf(env);
  const text = typeof env.payload.text === "string" ? env.payload.text : "";
  if (!heavy) return text;
  const digest =
    opts.digest !== undefined
      ? opts.digest
      : env.contentHash
        ? readCachedDigest(env.contentHash)
        : null;
  if (level === "L0") {
    if (opts.counters) opts.counters.l0++;
    return digest ? renderDigestLine(digest) : heavy.slice(0, 160).replace(/\s+/g, " ");
  }
  if (level === "L1") {
    if (opts.counters) opts.counters.l1++;
    return distillContent(heavy);
  }
  // L2 — full text. Rare, explicit, and LOGGED (spec §4.5.2).
  if (opts.counters) opts.counters.l2++;
  logEscalation("L2", env, opts);
  return heavy;
}

function logEscalation(
  level: "L1" | "L2",
  env: EventEnvelope,
  opts: { runId?: string; consumer?: string },
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO context_escalations (id, run_id, content_hash, event_id, level, consumer)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        opts.runId ?? null,
        env.contentHash ?? null,
        env.id ?? null,
        level,
        opts.consumer ?? "packer",
      );
  } catch {
    // The metric must never fail the pack.
  }
}

/** Per-run level accounting → the run ledger side table (spec §4.5.4). */
export function recordContextStats(runId: string, counters: ServeCounters): void {
  getDb()
    .prepare(
      `INSERT INTO run_context_stats (run_id, l0_count, l1_count, l2_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         l0_count = l0_count + excluded.l0_count,
         l1_count = l1_count + excluded.l1_count,
         l2_count = l2_count + excluded.l2_count`,
    )
    .run(runId, counters.l0, counters.l1, counters.l2);
}

export interface EscalationRate {
  serves: number;
  l1: number;
  l2: number;
  /** (l1 + l2) / serves; 0 when nothing was served. */
  rate: number;
}

/** The watched metric: how often digests were not enough. */
export function escalationRate(sinceIso?: string): EscalationRate {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(l0_count),0) AS l0, COALESCE(SUM(l1_count),0) AS l1,
              COALESCE(SUM(l2_count),0) AS l2
         FROM run_context_stats
        WHERE created_at >= COALESCE(?, '')`,
    )
    .get(sinceIso ?? null) as { l0: number; l1: number; l2: number };
  const serves = row.l0 + row.l1 + row.l2;
  return {
    serves,
    l1: row.l1,
    l2: row.l2,
    rate: serves === 0 ? 0 : (row.l1 + row.l2) / serves,
  };
}

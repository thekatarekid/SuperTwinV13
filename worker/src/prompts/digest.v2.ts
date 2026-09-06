// ===========================================================================
// digest.v2 — P-06, the tier-3 weekly digest (Prompts_V6_Phase1 P-06; V6 P1
// S3.8; evals DIG-01, DIG-02).
//
// One tier-3 stream, one week, one call — and only for weeks that hold new
// events (scheduler/v6/digest.ts decides which weeks; this module only
// speaks). The contract is small and the parser is hostile to inflation:
//
//   OUT   summary · claims (the extract.v6 claim shape) · recurrences
//   NEVER tasks, episodes, spaces, schedules, closures, questions, follow-ups,
//         anything "active" or "needs the user". A tier-3 stream is one the
//         user never replies in; a due date here is at most a recurrence
//         candidate. Every forbidden key is STRIPPED and named as a violation.
//
// Evidence is the S3.1 rule: `event_ids` must resolve to real ids through the
// aliases this call was packed with, and the quote must appear verbatim in one
// of those events. An item whose evidence does not survive is dropped, not
// committed with a hole in it.
//
// Versioned module per build convention 1.3: a changed word means digest.v3.
// ===========================================================================

import type { BundleEvent } from "../scheduler/v6/bundle.js";

export const DIGEST_V2_ID = "digest.v2";

/** P-06 system prompt, verbatim. */
export const DIGEST_V2_SYSTEM = `Summarize one week of a low-engagement stream the user never replies in.
Output a two-line summary, durable claims with evidence, and recurring patterns.
Never output tasks as active. Never mark anything as needing the user. A due
date here is at most a recurrence candidate.
OUTPUT {"summary":"…","claims":[…as extract…],"recurrences":[{"text":"…","rule":"…","evidence":[…],"confidence":0.0}]}`;

// ---- Result types ----------------------------------------------------------

export interface DigestEvidenceV2 {
  /** Real event ids (aliases resolved). */
  event_ids: string[];
  /** Verbatim text found in one of those events. */
  quote: string;
}

/** The extract.v6 typed fields — a column is filled only when the text states it. */
export interface DigestClaimFields {
  amount: number | null;
  currency: string | null;
  date: string | null;
  status: string | null;
  merchant: string | null;
  order_id: string | null;
  location: string | null;
  duration_s: number | null;
}

export const EMPTY_CLAIM_FIELDS: DigestClaimFields = {
  amount: null,
  currency: null,
  date: null,
  status: null,
  merchant: null,
  order_id: null,
  location: null,
  duration_s: null,
};

/** A claim "as extract" (P-04): subject · kind · text · provenance · fields · evidence · confidence · valid_from. */
export interface DigestClaimV2 {
  subject: string;
  kind: string;
  text: string;
  provenance: "observed" | "self_reported";
  fields: DigestClaimFields;
  evidence: DigestEvidenceV2[];
  confidence: number;
  valid_from: string | null;
}

export interface DigestRecurrenceV2 {
  text: string;
  rule: string;
  evidence: DigestEvidenceV2[];
  confidence: number;
}

export interface DigestResultV2 {
  summary: string;
  claims: DigestClaimV2[];
  recurrences: DigestRecurrenceV2[];
}

export interface DigestParseV2 {
  /** null when no usable JSON object came back at all. */
  result: DigestResultV2 | null;
  /**
   * Contract breaches, named. `digest-inflation:<key>` for forbidden keys,
   * `digest-active:<path>` for an item marked active / needing the user,
   * `unresolved-evidence:<path>` for an item dropped because no evidence
   * survived alias + verbatim resolution.
   */
  violations: string[];
}

// ---- Input packing ---------------------------------------------------------

export interface DigestInputV2 {
  streamKey: string;
  streamLabel?: string | null;
  /** ISO Monday of the week (scheduler/v6/digest.ts weekKey). */
  week: string;
  events: Pick<BundleEvent, "id" | "ts" | "actor" | "text">[];
}

export interface PackedDigest {
  text: string;
  /** alias (`e1`) → real event id. */
  aliases: Map<string, string>;
  /** real event id → its packed text (for verbatim checks). */
  textById: Map<string, string>;
}

const LINE_MAX = 600;

/**
 * The variable half — one stream, one week, every event aliased `e<n>` and
 * every captured byte inside ONE <untrusted> block (Prompts appendix).
 */
export function packDigestV2User(input: DigestInputV2): PackedDigest {
  const aliases = new Map<string, string>();
  const textById = new Map<string, string>();
  const lines: string[] = [];
  input.events.forEach((e, i) => {
    const alias = `e${i + 1}`;
    aliases.set(alias, e.id);
    const text = (e.text ?? "").replace(/\s+/g, " ").trim();
    textById.set(e.id, text);
    lines.push(`${alias} ${e.ts ?? "?"} ${e.actor ?? "?"}: ${text.slice(0, LINE_MAX)}`);
  });
  const first = input.events[0]?.ts ?? "?";
  const last = input.events[input.events.length - 1]?.ts ?? "?";
  const head =
    `STREAM ${input.streamLabel ?? input.streamKey} (${input.streamKey}) · week of ${input.week}\n` +
    `${input.events.length} messages · ${first} → ${last}\n` +
    `Refer to events by alias (e1, e2, …) in evidence.event_ids. Every evidence entry is an object ` +
    `{"event_ids":["e3"],"quote":"<text copied verbatim from that event>"} — a bare alias or a paraphrased quote ` +
    `is dropped by code. A claim is the extract shape: {"subject","kind","text","provenance","fields","evidence","confidence","valid_from"}.`;
  return { text: `${head}\n<untrusted>\n${lines.join("\n")}\n</untrusted>`, aliases, textById };
}

// ---- Output parsing (the DIG-02 contract) ----------------------------------

/** Keys a digest must never carry. Present and non-empty → stripped + named. */
export const DIGEST_FORBIDDEN_KEYS = [
  "tasks",
  "episodes",
  "spaces",
  "schedules",
  "closures",
  "questions",
  "follow_ups",
  "milestones",
  "plan",
] as const;

/** Item-level markers that make something "active" or "needing the user". */
const ACTIVE_MARKERS = ["needs_user", "active", "due", "fire_at", "mode", "assignee", "owner"] as const;

export interface EvidenceContext {
  aliases: ReadonlyMap<string, string>;
  textById: ReadonlyMap<string, string>;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function conf(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Resolve one evidence list: aliases → real ids (an id that is already real
 * and packed is accepted too), quote verbatim in one of the resolved events.
 * Anything that fails is dropped; the caller decides what a dropped list means.
 */
export function resolveEvidence(value: unknown, ctx: EvidenceContext): DigestEvidenceV2[] {
  if (!Array.isArray(value)) return [];
  const out: DigestEvidenceV2[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const quote = str(item.quote);
    if (quote === "") continue;
    const rawIds = Array.isArray(item.event_ids) ? item.event_ids : typeof item.event_id === "string" ? [item.event_id] : [];
    const ids: string[] = [];
    for (const raw of rawIds) {
      if (typeof raw !== "string") continue;
      const real = ctx.aliases.get(raw.trim()) ?? (ctx.textById.has(raw.trim()) ? raw.trim() : null);
      if (real && !ids.includes(real)) ids.push(real);
    }
    if (ids.length === 0) continue;
    const q = norm(quote);
    const verbatim = ids.some((id) => (ctx.textById.get(id) ?? "").toLowerCase().includes(q));
    if (!verbatim) continue;
    out.push({ event_ids: ids, quote });
  }
  return out;
}

function fields(v: unknown): DigestClaimFields {
  const f = isRecord(v) ? v : {};
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const s = (x: unknown) => (typeof x === "string" && x.trim() !== "" ? x.trim() : null);
  return {
    amount: num(f.amount),
    currency: s(f.currency),
    date: s(f.date),
    status: s(f.status),
    merchant: s(f.merchant),
    order_id: s(f.order_id),
    location: s(f.location),
    duration_s: num(f.duration_s),
  };
}

/** True when an item is marked active or as needing the user — the thing P-06 forbids. */
function activeMarker(item: Record<string, unknown>): string | null {
  for (const k of ACTIVE_MARKERS) {
    if (!(k in item)) continue;
    const v = item[k];
    if (k === "active" && v === false) continue;
    if (k === "needs_user" && v === false) continue;
    if (v === null || v === undefined || v === "") continue;
    return k;
  }
  const status = str(item.status);
  if (/^(active|open|due|pending|needs[_ -]?user)$/i.test(status)) return "status";
  return null;
}

/**
 * Parse one Digest answer against the P-06 contract. Nothing forbidden ever
 * reaches the result; nothing without resolved, verbatim evidence does either.
 */
export function parseDigestV2(raw: string, ctx: EvidenceContext): DigestParseV2 {
  const violations: string[] = [];
  const obj = extractJsonObject(raw);
  if (!obj) return { result: null, violations: ["unparseable"] };

  for (const key of DIGEST_FORBIDDEN_KEYS) {
    const v = obj[key];
    if (v !== undefined && v !== null && (!Array.isArray(v) || v.length > 0)) {
      violations.push(`digest-inflation:${key}`);
    }
  }
  if (obj.needs_user === true) violations.push("digest-active:needs_user");

  const summary = str(obj.summary);
  if (summary === "") violations.push("missing-summary");

  const claims: DigestClaimV2[] = [];
  if (Array.isArray(obj.claims)) {
    obj.claims.forEach((item, i) => {
      if (!isRecord(item)) return;
      const text = str(item.text);
      if (text === "") return;
      const marker = activeMarker(item);
      if (marker) violations.push(`digest-active:claims[${i}].${marker}`);
      const evidence = resolveEvidence(item.evidence, ctx);
      if (evidence.length === 0) {
        violations.push(`unresolved-evidence:claims[${i}]`);
        return;
      }
      const provenance = item.provenance === "self_reported" ? "self_reported" : "observed";
      claims.push({
        subject: str(item.subject) || "unknown",
        kind: str(item.kind) || "fact",
        text,
        provenance,
        fields: fields(item.fields),
        evidence,
        confidence: conf(item.confidence),
        valid_from: str(item.valid_from) || null,
      });
    });
  }

  const recurrences: DigestRecurrenceV2[] = [];
  if (Array.isArray(obj.recurrences)) {
    obj.recurrences.forEach((item, i) => {
      if (!isRecord(item)) return;
      const text = str(item.text) || str(item.label);
      if (text === "") return;
      const marker = activeMarker(item);
      if (marker) violations.push(`digest-active:recurrences[${i}].${marker}`);
      const evidence = resolveEvidence(item.evidence, ctx);
      if (evidence.length === 0) {
        violations.push(`unresolved-evidence:recurrences[${i}]`);
        return;
      }
      recurrences.push({
        text,
        rule: str(item.rule) || str(item.cadence),
        evidence,
        confidence: conf(item.confidence),
      });
    });
  }

  return { result: { summary, claims, recurrences }, violations };
}

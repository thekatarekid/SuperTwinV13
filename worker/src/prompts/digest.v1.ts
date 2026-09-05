// ===========================================================================
// digest.v1 — the DIGEST pass prompt (build P1.6, spec §8.5; evals CAT-04).
//
// Cat-2 backfill, haiku-class. One stream, one month of history, ONE call.
// The output contract is deliberately small and the parser is deliberately
// hostile to inflation: a digested stream may produce a summary, claims about
// KNOWN people (evidence-quoted), and recurrence candidates — and NOTHING
// else. Episodes, tasks and spaces coming back from a Digest call are the
// CAT-04 `digest-inflation` wrong[]: they are stripped, never committed, and
// each stripped key is surfaced as a violation so the eval layer can grade it.
//
// Versioned module per build convention 1.3: changing a single word of
// DIGEST_V1_CORE means a digest.v2.ts and an eval run, never an edit here.
// ===========================================================================

import type { BundleEvent } from "../scheduler/v6/bundle.js";

export const DIGEST_V1_ID = "digest.v1";

/** Spec §8.5, verbatim — the v1 instruction core. */
export const DIGEST_V1_CORE = `One stream, one month of history. Output ONLY: a 3–5 sentence stream
summary · claims about roster/known people (evidence-quoted) ·
recurrence candidates (billing cycles, annual events). No episodes,
no tasks, no spaces. JSON only.`;

/**
 * The full system half: the verbatim core plus the one JSON shape the parser
 * accepts. The shape block is transport, not policy — policy is the core.
 */
export const DIGEST_V1_SYSTEM = `${DIGEST_V1_CORE}

JSON shape (exactly these top-level keys, nothing else):
{
  "summary": "3–5 sentences about the stream over this month",
  "claims": [
    { "subject": "who the claim is about (roster/known person)",
      "text": "the claim, in your own words",
      "evidence": [ { "quote": "verbatim message text that supports it" } ] }
  ],
  "recurrences": [
    { "label": "what recurs (billing cycle, annual event, …)",
      "cadence": "monthly|yearly|weekly|… as stated by the evidence",
      "evidence": [ { "quote": "verbatim message text" } ] }
  ]
}
A claim without a verbatim quote is dropped. Do not invent people.`;

// ---- Result types ----------------------------------------------------------

export interface DigestEvidence {
  quote: string;
}

export interface DigestClaim {
  subject: string;
  text: string;
  evidence: DigestEvidence[];
}

export interface DigestRecurrence {
  label: string;
  cadence: string;
  evidence: DigestEvidence[];
}

export interface DigestResult {
  summary: string;
  claims: DigestClaim[];
  recurrences: DigestRecurrence[];
}

export interface DigestParse {
  /** null when no usable JSON object came back at all. */
  result: DigestResult | null;
  /**
   * Contract breaches, named. `digest-inflation:<key>` for episodes/tasks/
   * spaces the model tried to smuggle out, `claim-unquoted:<i>` for a claim
   * with no verbatim evidence. Breaching content is STRIPPED, never committed.
   */
  violations: string[];
}

// ---- Input packing ---------------------------------------------------------

export interface DigestInput {
  streamKey: string;
  /** Optional human label for the stream, when known. */
  streamLabel?: string | null;
  events: Pick<BundleEvent, "ts" | "actor" | "text">[];
  /** BND-05: the predecessor part's summary, so a split month stays cumulative. */
  predecessorSummary?: string;
}

/** The variable half — one stream, one month-chunk of history, as plain lines. */
export function packDigestUser(input: DigestInput): string {
  const { events } = input;
  const first = events[0]?.ts ?? "?";
  const last = events[events.length - 1]?.ts ?? "?";
  const head =
    `STREAM ${input.streamLabel ?? input.streamKey} (${input.streamKey})\n` +
    `${events.length} messages · ${first} → ${last}`;
  const pred = input.predecessorSummary
    ? `\nPREVIOUS CHUNK: ${input.predecessorSummary}`
    : "";
  const lines = events
    .map((e) => `${e.ts ?? "?"} ${e.actor ?? "?"}: ${(e.text ?? "").trim()}`)
    .join("\n");
  return `${head}${pred}\n---\n${lines}`;
}

// ---- Output parsing (the CAT-04 contract) ----------------------------------

const FORBIDDEN_KEYS = ["episodes", "tasks", "spaces"] as const;

function asEvidence(value: unknown): DigestEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: DigestEvidence[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") {
      out.push({ quote: item.trim() });
    } else if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { quote?: unknown }).quote === "string" &&
      ((item as { quote: string }).quote.trim() !== "")
    ) {
      out.push({ quote: (item as { quote: string }).quote.trim() });
    }
  }
  return out;
}

/** Extract the first {...} object from a possibly chatty answer. */
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

/**
 * Parse one Digest answer against the §8.5 contract. NOTHING forbidden ever
 * reaches the result: episodes/tasks/spaces are stripped with a named
 * violation, and a claim without a verbatim quote is dropped the same way.
 */
export function parseDigestV1(raw: string): DigestParse {
  const violations: string[] = [];
  const obj = extractJsonObject(raw);
  if (!obj) return { result: null, violations: ["unparseable"] };

  for (const key of FORBIDDEN_KEYS) {
    const v = obj[key];
    if (v !== undefined && (!Array.isArray(v) || v.length > 0)) {
      violations.push(`digest-inflation:${key}`);
    }
  }

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (summary === "") violations.push("missing-summary");

  const claims: DigestClaim[] = [];
  if (Array.isArray(obj.claims)) {
    obj.claims.forEach((item, i) => {
      if (item === null || typeof item !== "object") return;
      const c = item as { subject?: unknown; text?: unknown; evidence?: unknown };
      const text = typeof c.text === "string" ? c.text.trim() : "";
      const subject = typeof c.subject === "string" ? c.subject.trim() : "";
      const evidence = asEvidence(c.evidence);
      if (text === "") return;
      if (evidence.length === 0) {
        // Evidence-quoted or it does not exist (spec §8.5).
        violations.push(`claim-unquoted:${i}`);
        return;
      }
      claims.push({ subject, text, evidence });
    });
  }

  const recurrences: DigestRecurrence[] = [];
  if (Array.isArray(obj.recurrences)) {
    for (const item of obj.recurrences) {
      if (item === null || typeof item !== "object") continue;
      const r = item as { label?: unknown; cadence?: unknown; evidence?: unknown };
      const label = typeof r.label === "string" ? r.label.trim() : "";
      if (label === "") continue;
      recurrences.push({
        label,
        cadence: typeof r.cadence === "string" ? r.cadence.trim() : "",
        evidence: asEvidence(r.evidence),
      });
    }
  }

  return { result: { summary, claims, recurrences }, violations };
}

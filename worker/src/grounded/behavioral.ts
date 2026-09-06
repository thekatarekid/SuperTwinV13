// ===========================================================================
// [CODE] Behavioral memory — durable rules the user's corrections imply
// (Product_V6 Phase 1 §21 "behavioral memory"; GoldenEvals FIX-08; Build S5.5).
//
// "stop nudging me about fares on youtube" is two things: a correction on the
// one nudge (dont_do_this) and a RULE ("no cards while YouTube is frontmost",
// scope router) that has to outlive the nudge. Rules live as claims of kind
// `behavioral`, subject self, decided by the user, with the utterance as the
// verbatim evidence — the same store every other durable fact uses, so they
// are versioned (ended, never deleted), traced through decisions, and visible
// in Settings › Assist through GET /api/behavioral-rules.
//
// `ruleApplies` is the read side the surface router (P-10) consults before a
// card: a rule whose scope names an app / kind / stream that matches the
// decision context suppresses it. Nothing here calls a model.
// ===========================================================================

import { createHash } from "node:crypto";

import { activeClaim, claimsAbout, closeClaimVersion, writeClaimVersion, type ClaimVersionRow } from "../claims/store.js";
import { SELF_ENTITY_ID } from "../db/v6graph.js";
import type { BehavioralRule } from "../prompts/correction-parse.v3.js";

export interface BehavioralRuleRow {
  claim_key: string;
  version_id: string;
  rule: string;
  scope: string;
  /** dont_do_this(kind, context) when the rule came from one. */
  kind: string | null;
  context: string | null;
  stated_at: string | null;
  evidence: string;
  correction_id: string | null;
}

export interface WriteBehavioralRuleInput extends BehavioralRule {
  /** The utterance or chip that implied it — the verbatim evidence. */
  evidence: string;
  kind?: string | null;
  context?: string | null;
  correctionId?: string | null;
  statedAt?: string;
}

/** One key per (rule, scope) so the same rule said twice reinforces, never duplicates. */
export function behavioralClaimKey(rule: string, scope: string): string {
  const h = createHash("sha1").update(`${scope.trim().toLowerCase()}|${rule.trim().toLowerCase()}`).digest("hex").slice(0, 16);
  return `behavioral.${h}`;
}

function encode(input: WriteBehavioralRuleInput): string {
  return JSON.stringify({
    rule: input.rule,
    scope: input.scope,
    kind: input.kind ?? null,
    context: input.context ?? null,
    correction_id: input.correctionId ?? null,
  });
}

function decode(row: ClaimVersionRow): BehavioralRuleRow | null {
  let payload: { rule?: unknown; scope?: unknown; kind?: unknown; context?: unknown; correction_id?: unknown } = {};
  try {
    payload = row.text ? (JSON.parse(row.text) as typeof payload) : {};
  } catch {
    payload = { rule: row.text ?? "" };
  }
  const rule = typeof payload.rule === "string" ? payload.rule : row.text ?? "";
  if (rule.trim() === "") return null;
  return {
    claim_key: row.claimKey,
    version_id: row.id,
    rule,
    scope: typeof payload.scope === "string" && payload.scope ? payload.scope : "global",
    kind: typeof payload.kind === "string" ? payload.kind : null,
    context: typeof payload.context === "string" ? payload.context : null,
    stated_at: row.statedAt ?? null,
    evidence: row.evidence?.[0]?.quote ?? "",
    correction_id: typeof payload.correction_id === "string" ? payload.correction_id : null,
  };
}

/**
 * Write (or reinforce) one rule. The old version of the same key is ended
 * and linked — never overwritten — so the rule's history stays auditable.
 */
export function writeBehavioralRule(input: WriteBehavioralRuleInput): BehavioralRuleRow {
  const rule = input.rule.trim();
  if (rule === "") throw new Error("writeBehavioralRule: an empty rule is not a rule");
  const scope = (input.scope ?? "global").trim() || "global";
  const claimKey = behavioralClaimKey(rule, scope);
  const now = input.statedAt ?? new Date().toISOString();
  const prior = activeClaim(claimKey);
  if (prior) closeClaimVersion(prior.id, { closedBy: "user", reason: "reinforced", validTo: null });
  const row = writeClaimVersion({
    claimKey,
    kind: "behavioral",
    subjectId: SELF_ENTITY_ID,
    predicate: "rule",
    object: scope,
    text: encode({ ...input, rule, scope }),
    confidence: 1,
    statedAt: now,
    validFrom: now,
    evidence: [{ event_ids: [], quote: input.evidence.trim() || rule }],
    decidedBy: "user",
    relation: prior ? "reinforces" : "new",
    relatedVersionId: prior?.id ?? null,
  });
  return decode(row)!;
}

/** Every active rule, newest first — Settings › Assist. */
export function listBehavioralRules(): BehavioralRuleRow[] {
  return claimsAbout(SELF_ENTITY_ID, "behavioral")
    .map(decode)
    .filter((r): r is BehavioralRuleRow => r !== null);
}

/** End one rule (the user removed it in Settings). Kept in history. */
export function retireBehavioralRule(claimKey: string): boolean {
  const active = activeClaim(claimKey);
  if (!active) return false;
  closeClaimVersion(active.id, { closedBy: "user", reason: "retired", validTo: new Date().toISOString() });
  return true;
}

/** What a surface / pass decision looks like to a rule. */
export interface RuleContext {
  /** Frontmost app, e.g. "YouTube". */
  app?: string | null;
  /** The artifact / nudge kind, e.g. "something_moved". */
  kind?: string | null;
  /** The stream the decision is about. */
  stream?: string | null;
  /** The surface deciding: router · nudge · brief · live … */
  surface?: string | null;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Does this rule suppress the decision? A rule matches when its scope or
 * context names the app (`app:YouTube`, "while YouTube is frontmost"), its
 * kind names the artifact kind, or its scope names the surface with no
 * narrower qualifier. Global rules with no qualifier never suppress on their
 * own — they are guidance, not a kill switch.
 */
export function ruleApplies(rule: BehavioralRuleRow, ctx: RuleContext): boolean {
  const app = norm(ctx.app);
  const kind = norm(ctx.kind);
  const stream = norm(ctx.stream);
  const surface = norm(ctx.surface);
  const scope = norm(rule.scope);
  const context = norm(rule.context);
  const text = norm(rule.rule);

  const appMatch = app !== "" && (context === `app:${app}` || scope === `app:${app}` || text.includes(app));
  const kindMatch = kind !== "" && (norm(rule.kind) === kind || text.includes(kind.replace(/_/g, " ")));
  const streamMatch = stream !== "" && (context === `stream:${stream}` || scope === `stream:${stream}`);

  // A qualifier on the rule has to be met by the context.
  const qualified = context !== "" || norm(rule.kind) !== "";
  if (qualified) {
    if (context.startsWith("app:") && !appMatch) return false;
    if (context.startsWith("stream:") && !streamMatch) return false;
    if (norm(rule.kind) !== "" && kind !== "" && !kindMatch) return false;
    return appMatch || kindMatch || streamMatch;
  }
  if (appMatch || streamMatch) return true;
  if (scope !== "" && scope !== "global" && surface !== "" && scope === surface && kindMatch) return true;
  return false;
}

/** The active rules that suppress this decision (empty = nothing stands in the way). */
export function suppressingRules(ctx: RuleContext, rules: readonly BehavioralRuleRow[] = listBehavioralRules()): BehavioralRuleRow[] {
  return rules.filter((r) => ruleApplies(r, ctx));
}

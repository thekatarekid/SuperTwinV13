// ===========================================================================
// brief.v1 — the daily commitments brief prompt (Phase 3 gates, spec §11.2
// "confirmed daily brief" / eval SCH-05).
//
// Composition ONLY: the ledger of today's commitments arrives packed (tasks,
// pending approvals, near dates, schedules about to fire) — the model orders
// and phrases them. It never invents commitments, never pads a quiet day, and
// every item keeps its source chip. Delivery (nudge + Today) is code.
// ===========================================================================

export const BRIEF_V1_ID = "brief.v1";

export const BRIEF_V1_SYSTEM = `Compose the user's daily brief from TODAY'S COMMITMENT LEDGER given
in the input. Rules:
- Use ONLY the ledger. Never invent, never restate stale items, and on a
  genuinely empty ledger return {"skip":true,"items":[]} — a quiet day
  gets NO filler.
- Include EVERY real commitment in the ledger. Order by urgency: money
  due today, then pending approvals, then time-bound fires, then dates
  coming up.
- Each item: one plain sentence + the source chip exactly as the ledger
  names it (task id, claim id, schedule, run).
JSON only.

OUTPUT SHAPE (one JSON object, nothing else):
{"skip":false,"items":[{"text":"Villa pool ₹8k is due today","source":"tsk_pool"}]}`;

export interface BriefItem {
  text: string;
  source: string;
}

export interface BriefOutput {
  skip: boolean;
  items: BriefItem[];
}

/** Validate the composed brief; throws (repair round) on a wrong shape. */
export function validateBriefOutput(parsed: unknown): BriefOutput {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected one JSON object {"skip":boolean,"items":[...]}');
  }
  const root = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items: BriefItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    const source = typeof r.source === "string" ? r.source.trim() : "";
    if (!text) throw new Error("every brief item needs non-empty text");
    if (!source) throw new Error(`brief item "${text.slice(0, 40)}" is missing its source chip`);
    items.push({ text, source });
  }
  const skip = root.skip === true;
  if (skip && items.length > 0) throw new Error("skip:true must carry zero items");
  return { skip, items };
}

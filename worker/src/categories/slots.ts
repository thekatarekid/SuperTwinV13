// ===========================================================================
// [CODE] CLI slot policy for Cat-1 / Cat-2 work (spec §5.2.3; eval CAT-05).
//
// Moved out of the deleted V13 scheduler (scheduler/priority.ts) in V6 P1
// S3.3: the rule is a category rule, not a dispatcher rule, and the CAT-05
// executor still asserts it. Cat-2 work (data OR media) holds a CLI slot ONLY
// when ALL Cat-1 work — data and media both — is done. Live always passes;
// local compute (whisper) never takes a CLI slot at all.
//
// S3.8 replaces Cat 1/2 with tiers; this file goes with it.
// ===========================================================================

import type { StreamCategory } from "./chat.js";

export type SlotWorkKind = "data" | "media";

/** One candidate for a CLI slot — an understanding bundle or an enrichment item. */
export interface SlotWork {
  id: string;
  lane: "live" | "backfill";
  kind: SlotWorkKind;
  category: StreamCategory;
  /** Local compute (whisper) — exempt from the CLI slot policy entirely. */
  local?: boolean;
}

/** What the gate needs to know about the world beyond the candidates. */
export interface SlotState {
  /** Cat-1 data (bundles/events) not yet processed, anywhere. */
  cat1DataPending: number;
  /** Cat-1 media enrichment items not yet resolved, anywhere. */
  cat1MediaPending: number;
}

/** May this work occupy a CLI slot right now? */
export function admitWork(work: SlotWork, state: SlotState): boolean {
  if (work.local) return true;
  if (work.lane === "live") return true;
  if (work.category === "cat1") return true;
  return state.cat1DataPending === 0 && state.cat1MediaPending === 0;
}

/**
 * Fill up to `freeSlots` CLI slots from `candidates`, §5.2 order: live first;
 * then Cat-1 data + media in their given interleaving; then — only when the
 * gate is clear — Cat-2 data (Digest) before Cat-2 media. Local work never
 * consumes a slot and is returned admitted alongside.
 */
export function planCliSlots(
  candidates: readonly SlotWork[],
  state: SlotState,
  freeSlots: number,
): { slots: SlotWork[]; local: SlotWork[] } {
  const local = candidates.filter((c) => c.local);
  const cli = candidates.filter((c) => !c.local && admitWork(c, state));
  const rank = (w: SlotWork): number => {
    if (w.lane === "live") return 0;
    if (w.category === "cat1") return 1;
    return w.kind === "data" ? 2 : 3;
  };
  const ordered = cli
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
    .map((x) => x.w);
  return { slots: ordered.slice(0, Math.max(0, freeSlots)), local };
}

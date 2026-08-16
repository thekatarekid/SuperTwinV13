// [CODE] How a session got into an episode, in one line — arch §14.3.
//
//   ├ Mon 09:12  seed · code:1v1 · conf 1.00
//   ├ Wed 20:40  ATTACHED · agent:p-ep2 · conf 0.93
//   └ Wed 20:40  SPLIT from session ses_7 (2 topics) · agent:p-ep2 · conf 0.88
//
// The item's acceptance criterion is "every membership row shows its signal and
// value", so this function cannot return a line without both. The signal is
// `decided_by` — the rule or the model that made the call — and the value is
// the confidence it carried. Neither is ever silently omitted:
//
//   * an unattributed row says `unattributed`, which is a bug report, not a
//     blank;
//   * an unmeasured confidence says `no confidence measured`, because a
//     missing number is not the number 0.

import type { EpisodeSessionView } from "../../lib/episodes-client";

/** The two halves the acceptance criterion demands, always both present. */
export function signalAndValue(row: EpisodeSessionView): string {
  const signal = row.decidedBy && row.decidedBy.trim() !== "" ? row.decidedBy : "unattributed";
  const value =
    row.confidence === null || row.confidence === undefined
      ? "no confidence measured"
      : `conf ${row.confidence.toFixed(2)}`;
  return `${signal} · ${value}`;
}

/** The provenance half: seed, ATTACHED, or SPLIT with what it was split from. */
export function provenanceLabel(row: EpisodeSessionView): string {
  switch (row.provenance) {
    case "seed":
      return "seed";
    case "attached":
      return "ATTACHED";
    case "split": {
      const from = row.splitFromSessionId ?? "an unrecorded session";
      const topics =
        row.splitTopicCount === null || row.splitTopicCount === undefined
          ? ""
          : ` (${row.splitTopicCount} topics)`;
      return `SPLIT from session ${from}${topics}`;
    }
  }
}

/** The whole row: provenance, then its signal, then its value. */
export function provenanceLine(row: EpisodeSessionView): string {
  return `${provenanceLabel(row)} · ${signalAndValue(row)}`;
}

/** `Mon 09:12` — enough to place a session in a week without a full date. */
export function whenLabel(iso: string | null): string {
  if (!iso) return "undated";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "undated";
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

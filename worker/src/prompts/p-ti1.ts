// ===========================================================================
// [LLM-S] P-TI1 — business channel tier — arch §12.11. Build item 1.2.
//
// Runs ONCE PER BUSINESS CHANNEL, never per message, and only for the channels
// the [CODE] heuristics in ../tiers/classify.ts could not decide. The verdict
// is cached on the stream (`streams.tier`, `tier_source='p-ti1'`) and re-run
// only when the channel's character changes.
//
// Settings, from §12.11: haiku-4-5 · plain · 1 turn · tools none · thinking off
// · 60 s · <= 10 channels per call · 600 max out. It runs as a boot backfill
// over all business channels, then once per newly seen business channel, and
// it is NEVER on the first-paint critical path (§9.5.1).
//
// Wire, both directions (§5). The answer is one `J` line per channel in the
// `J.channel` shape the STW-2 tag table already carries:
//
//   J | <c-alias> | <tx|pm> | <conf> | <reason>
//
// so the response is parsed by the real codec — no JSON, no bespoke splitter,
// and a malformed line becomes a violation rather than taking the batch down.
// Out-of-roster aliases resolve to null and are reported, never guessed
// (§5.8.6): a verdict we cannot attribute to a channel is a verdict we do not
// apply.
// ===========================================================================

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { neutraliseLabel, neutraliseParticipant, collapseNewlines } from "../wire/pack.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import type { WireViolation } from "../wire/tolerance.js";

/** §12.11 "Settings", transcribed. */
export const P_TI1 = {
  id: "P-TI1",
  role: "tier_business_channel",
  model: "haiku-4-5",
  turns: 1,
  tools: "none",
  thinking: "off",
  timeoutSeconds: 60,
  /** Hard cap per call. More channels than this means more calls. */
  maxChannelsPerCall: 10,
  maxOutputTokens: 600,
  /** §9.5.1 — barred from the first-paint path by rule, not by luck. */
  onCriticalPath: false,
} as const;

/** §12.11 SYSTEM, verbatim. */
export const P_TI1_SYSTEM = `You classify a business sender into one of two tiers for a personal-memory
system's processing queue.

  tx TRANSACTIONAL  messages about THIS person's own affairs: order and
                    booking confirmations, delivery updates, bank and card
                    alerts, statements, bills, appointment reminders,
                    tickets, policy and subscription notices, OTPs.
  pm PROMOTIONAL    campaigns aimed at many people: offers, sales, discounts,
                    newsletters, product launches, re-engagement nudges.

RULES
- Judge the CHANNEL by its sample, not any single message.
- The tell is specificity: does the sender reference THIS person's order,
  booking, account, appointment or amount? That is tx. Generic offers with
  no user-specific identifier are pm.
- A sender that does both -> tx. Under-prioritising a real bill is the more
  expensive mistake.
- Tier only changes WHEN a channel is processed, never WHETHER. Both tiers
  are extracted in full. Do not filter, only order.
- Unsure -> tx.

OUTPUT
  J | <c-alias> | <tx|pm> | <conf> | <reason>`;

export interface Ti1Channel {
  /** The real `streams.id`. Never sent to the model — the alias stands in. */
  streamId: string;
  name: string;
  /** Entity ids on the channel; `self` is printed first, as §12.11 shows. */
  participantIds?: readonly string[];
  /** The sampled messages, oldest-first, exactly as they were stored. */
  sample: readonly string[];
  /** How many messages the channel holds in total — the `of N` in the header. */
  totalMessages?: number;
}

export interface Ti1Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** Stream id -> the alias it was minted as, for the caller's own bookkeeping. */
  aliases: Record<string, string>;
  channels: readonly Ti1Channel[];
}

/** §12.11 caps the call at 10 channels; this is where that cap is applied. */
export function chunkChannels(
  channels: readonly Ti1Channel[],
  size: number = P_TI1.maxChannelsPerCall,
): Ti1Channel[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: Ti1Channel[][] = [];
  for (let i = 0; i < channels.length; i += limit) out.push(channels.slice(i, i + limit));
  return out;
}

function participants(ids: readonly string[] | undefined, table: AliasTable): string {
  const list = ids && ids.length > 0 ? [...ids] : ["self"];
  // `self` first, as the doc's example prints it.
  list.sort((a, b) => (a === "self" ? -1 : b === "self" ? 1 : 0));
  return list
    .map((id) => (id === "self" ? "self" : table.mint("entity", id)))
    .map(neutraliseParticipant)
    .join(",");
}

/**
 * Build the USER block, in §12.11's shape:
 *
 *   #C c7 HDFC Bank | biz | self,a20   sample 5 of 214
 *     1 "Rs.3398.23 debited from a/c XX4412 on 11-Aug..."
 *
 * The message text is quoted and newline-collapsed, and nothing else is done
 * to it: it is the last thing on its line, it may contain anything, and
 * language is never compressed (§5.5).
 */
export function buildTi1User(channels: readonly Ti1Channel[], table: AliasTable): string {
  const lines: string[] = [];
  for (const channel of channels) {
    const alias = table.mint("stream", channel.streamId, channel.name);
    const total = channel.totalMessages ?? channel.sample.length;
    lines.push(
      `#C ${alias} ${neutraliseLabel(channel.name)} | biz | ${participants(channel.participantIds, table)}` +
        `   sample ${channel.sample.length} of ${total}`,
    );
    channel.sample.forEach((message, i) => {
      lines.push(`  ${i + 1} "${collapseNewlines(message).replace(/"/g, "'")}"`);
    });
  }
  return lines.join("\n");
}

/** System + user + the alias table the answer has to be read against. */
export function buildTi1Prompt(channels: readonly Ti1Channel[], table?: AliasTable): Ti1Prompt {
  const aliasTable = table ?? createAliasTable();
  const user = buildTi1User(channels, aliasTable);
  const aliases: Record<string, string> = {};
  for (const channel of channels) {
    const token = aliasTable.tokenFor("stream", channel.streamId);
    if (token) aliases[channel.streamId] = token;
  }
  return { system: P_TI1_SYSTEM, user, table: aliasTable, aliases, channels };
}

// ---- the answer ------------------------------------------------------------

export interface Ti1Verdict {
  /** The alias the model wrote, verbatim. */
  alias: string;
  /** The stream it resolves to, or null when the alias is out of roster. */
  streamId: string | null;
  /** `tx` | `pm`, from the STW-2 `channel_class` enum. */
  cls: "tx" | "pm";
  /** The stored long form: `transactional` | `promotional`. */
  label: string;
  confidence: number | null;
  reason: string;
  /** The model's own line, kept so nothing is ever paraphrased downstream. */
  raw: string;
}

export interface Ti1Answer {
  verdicts: Ti1Verdict[];
  /** Verdicts whose alias resolved to nothing. Reported, never guessed. */
  unresolved: Ti1Verdict[];
  violations: WireViolation[];
  parse: WireParseResult;
}

const CLASS_CODE: Record<string, "tx" | "pm"> = {
  transactional: "tx",
  promotional: "pm",
};

/**
 * Parse a P-TI1 answer. Never throws (§5.8): a line the codec rejects comes
 * back as a violation with the model's words intact, ready for a repair round.
 */
export function parseTi1Response(response: unknown, table: AliasTable): Ti1Answer {
  const parse = parseWire(response);
  const verdicts: Ti1Verdict[] = [];
  const unresolved: Ti1Verdict[] = [];

  for (const record of parse.records) {
    if (record.variant !== "J.channel") continue;
    const stored = typeof record.values.class === "string" ? record.values.class : "";
    const cls = CLASS_CODE[stored];
    if (!cls) continue;
    const alias = typeof record.values.stream === "string" ? record.values.stream : "";
    const resolution = table.resolve(alias);
    const streamId =
      resolution.resolved && resolution.resolved.kind === "stream" ? resolution.resolved.id : null;
    const verdict: Ti1Verdict = {
      alias,
      streamId,
      cls,
      label: stored,
      confidence: typeof record.values.confidence === "number" ? record.values.confidence : null,
      reason: typeof record.values.reason === "string" ? record.values.reason : "",
      raw: record.raw,
    };
    if (streamId === null) unresolved.push(verdict);
    else verdicts.push(verdict);
  }

  return { verdicts, unresolved, violations: parse.violations, parse };
}

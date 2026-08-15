// ===========================================================================
// Rendering the <supertwin-context> block, and spending its char budget.
//
// Two things the old renderer got wrong and this one cannot:
//
//   - It printed `snippet(events_fts, 0, …)` — column 0, the message text —
//     for a row that may have matched in any of seven columns. A hit that
//     matched only in `transcript` arrived as a BLANK LINE and spent one of the
//     eight slots saying nothing. Here every part an event carries is rendered,
//     and the snippet from the column that actually matched is the fallback
//     when the message itself is empty, so a line can never be blank.
//   - It had no budget at all, just `LIMIT 8`. Now the budget is chars, and it
//     is spent from the outside in: hits are kept, the messages beside them are
//     kept next, and the far edge of a window is dropped first. Each SECTION
//     spends its own share of it, because comparing "how far from a hit" across
//     two different conversations compares nothing (v7 §6, lever 3).
//
// Times are rendered LOCAL. The whole point of the date work is that "sunday"
// is a local-calendar fact; printing UTC alongside it would put a 21:07 message
// on the wrong day for the model to reason about.
// ===========================================================================

import {
  DEFAULT_WINDOW,
  DEFAULT_WINDOW_MINUTES,
  type ContextEventRow,
} from "../db/retrieval.js";
import { localToday, isoDate } from "./dates.js";
import type { ContextEvent, ContextSection, RetrievalResult } from "./retrieve.js";

/**
 * ~4K tokens. It was 9,000 — deliberately tight, because the block's own
 * measured failure mode was spending the last 3K on the far edge of a window
 * around a weak hit. Raising it is v7 §6 lever 7, and lever 7 says "only after
 * 3 and 4": the headroom is only worth having now that a section can no longer
 * outbid a better one (`fit` below) and a scraped page can no longer buy a
 * window at all (retrieve.ts). It is also what lets a chat that passed the
 * 12,000-rendered-char whole-inclusion test actually arrive whole.
 */
export const DEFAULT_CONTEXT_CHARS = 16_000;

/** Per-field caps, so one scraped page or long transcript cannot eat the block. */
const MAX_TEXT_CHARS = 500;
const MAX_TRANSCRIPT_CHARS = 400;
/** Auto-generated and verbose; 200 chars is enough to know what the picture is. */
const MAX_DESCRIPTION_CHARS = 200;
const MAX_LINK_CHARS = 200;
const MAX_QUOTE_CHARS = 120;

/**
 * Shortest id tail that is worth printing instead of the whole id. Below this
 * it is not distinctive enough for `getEventDetail` to resolve, and a citation
 * that cannot be resolved is worse than a long one.
 */
const MIN_SHORT_ID_CHARS = 8;

/**
 * Relative weight of the n-th section's share of the budget. `fit` used to
 * compare distanceToHit ACROSS sections, so a YouTube line three messages from
 * its own weak hit outbid a Pranjali line eight from the answer — 53% of the
 * measured health query's block went to two chats nobody had asked about
 * (v7 §6, lever 3). Each section now spends its own share and only what the
 * others leave; sections arrive ranked, so 1/(i+1) is a rank weight.
 */
const SECTION_WEIGHT = (index: number): number => 1 / (index + 1);

/**
 * A chat included WHOLE counts double. It was already size-checked before it
 * was read whole, and half of a small chat is a worse block than all of it —
 * which is the §1 rule that used to live in the drop comparator.
 */
const WHOLE_SECTION_WEIGHT = 2;

export interface FormatOptions {
  maxChars?: number;
}

/**
 * Render one turn's retrieval as the block that gets prepended to the user's
 * message. Returns "" when there is nothing to inject, so the caller can skip
 * the wrapper entirely.
 */
export function formatContextBlock(
  result: RetrievalResult,
  opts: FormatOptions = {},
): string {
  const budget = Math.max(500, opts.maxChars ?? DEFAULT_CONTEXT_CHARS);
  const sections = result.sections.filter((s) => s.events.length > 0);
  if (sections.length === 0) return "";

  const lines = renderSections(sections);
  const header = renderHeader(result);
  const fixed = ["<supertwin-context>", ...header, "</supertwin-context>"].join(
    "\n",
  ).length;
  const kept = fit(lines, sections, Math.max(0, budget - fixed));

  const keptPerSection = new Map<number, number>();
  for (const line of kept) {
    keptPerSection.set(line.sectionIndex, (keptPerSection.get(line.sectionIndex) ?? 0) + 1);
  }

  const body: string[] = [];
  let lastSection = -1;
  for (const line of kept) {
    if (line.sectionIndex !== lastSection) {
      body.push(
        "",
        renderSectionHeader(
          sections[line.sectionIndex],
          keptPerSection.get(line.sectionIndex) ?? 0,
        ),
      );
      lastSection = line.sectionIndex;
    }
    body.push(line.text);
  }

  return [
    "<supertwin-context>",
    ...header,
    ...body,
    "</supertwin-context>",
  ].join("\n");
}

// ---- Header ---------------------------------------------------------------

function renderHeader(result: RetrievalResult): string[] {
  const { dates } = result.plan;
  const out = [
    `Retrieved from the user's imported WhatsApp history. Times are the user's local time.`,
    `Today is ${capitalise(dates.todayWeekday)} ${dates.todayIso}.`,
  ];

  if (dates.dates.length > 0) {
    // Grouped by the words that produced them: a bare weekday resolves both
    // ways, and "sunday = X; sunday = Y" reads like two different Sundays.
    const byExpression = new Map<string, string[]>();
    for (const d of dates.dates) {
      const said = `${capitalise(d.weekday)} ${d.iso} (${relativeLabel(d.offsetDays)})`;
      byExpression.set(d.expression, [...(byExpression.get(d.expression) ?? []), said]);
    }
    const parts = [...byExpression].map(
      ([expression, days]) => `"${expression}" = ${days.join(" or ")}`,
    );
    out.push(`Dates the question refers to: ${parts.join("; ")}.`);
  }
  if (result.plan.dropped.length > 0) {
    out.push(
      `Searched for: ${result.plan.terms.join(", ")}` +
        ` (ignored: ${result.plan.dropped.join(", ")}).`,
    );
  }
  out.push(`Lines marked * are the search hits; the rest is the conversation around them.`);
  return out;
}

function relativeLabel(offsetDays: number): string {
  if (offsetDays === 0) return "today";
  if (offsetDays === 1) return "tomorrow";
  if (offsetDays === -1) return "yesterday";
  return offsetDays > 0 ? `in ${offsetDays} days` : `${-offsetDays} days ago`;
}

// ---- Sections and lines ---------------------------------------------------

interface RenderedLine {
  sectionIndex: number;
  text: string;
  isHit: boolean;
  /** Blended score on hits, 0 elsewhere — the order hits are given up in. */
  score: number;
  distanceToHit: number;
  minutesToHit: number | null;
}

function renderSections(sections: readonly ContextSection[]): RenderedLine[] {
  const out: RenderedLine[] = [];
  sections.forEach((section, sectionIndex) => {
    for (const event of section.events) {
      out.push({
        sectionIndex,
        text: renderEvent(event),
        isHit: event.role === "hit",
        score: event.score ?? 0,
        distanceToHit: event.distanceToHit,
        minutesToHit: event.minutesToHit,
      });
    }
  });
  return out;
}

/**
 * `kept` is how many of the section's lines survived the budget, and it is in
 * the header because "the whole chat" stops being true the moment one line is
 * dropped — and a model told it has the whole chat has no reason to ask for
 * the rest.
 */
function renderSectionHeader(section: ContextSection, kept: number): string {
  const name = section.channelName ?? section.channelId ?? "unknown chat";
  const scope =
    section.whole && kept >= section.events.length
      ? `the whole chat, ${section.channelEventCount} messages`
      : `${kept} messages around the hits`;
  return `## ${name} — ${scope}`;
}

/** What a section header costs whichever way it ends up being written. */
function headerCost(section: ContextSection): number {
  return (
    Math.max(
      renderSectionHeader(section, section.events.length).length,
      renderSectionHeader(section, 0).length,
    ) + 2
  );
}

/** An event as a line needs it: the row, plus where a search hit matched. */
export interface RenderableEvent extends ContextEventRow {
  snippet?: string | null;
  matchedColumn?: string | null;
}

/** One line, minus the hit marker. */
export function renderEvent(event: ContextEvent): string {
  return `${event.role === "hit" ? "*" : " "} ${renderEventBody(event)}`;
}

/**
 * One event, one line. Everything the event carries is on it: what was typed,
 * what it quoted, what a model saw in the attachment, what whisper heard, where
 * the link went. Newlines are flattened because the block is read line-wise.
 */
export function renderEventBody(event: RenderableEvent): string {
  const when = event.ts ? formatLocalTs(event.ts) : "?";
  const who = event.fromMe
    ? event.actorName
      ? `${event.actorName} (the user)`
      : "the user"
    : (event.actorName ?? "unknown");

  const parts: string[] = [];
  if (event.replyToText) {
    parts.push(`(replying to "${flatten(event.replyToText, MAX_QUOTE_CHARS)}")`);
  }
  if (event.revokedAt) parts.push("[deleted for everyone]");

  const text = flatten(event.text ?? "", MAX_TEXT_CHARS);
  if (text.length > 0) parts.push(text);

  if (event.mediaDescription) {
    parts.push(
      `[attachment description: ${flatten(event.mediaDescription, MAX_DESCRIPTION_CHARS)}]`,
    );
  }
  if (event.transcript) {
    parts.push(`[audio transcript: ${flatten(event.transcript, MAX_TRANSCRIPT_CHARS)}]`);
  }
  if (event.linkUrl || event.linkTitle) {
    const title = flatten(event.linkTitle ?? "", MAX_LINK_CHARS);
    const blurb = flatten(event.linkDescription ?? "", MAX_LINK_CHARS);
    parts.push(
      `[link ${event.linkUrl ?? ""}${title ? ` — ${title}` : ""}${blurb ? `: ${blurb}` : ""}]`,
    );
  }

  // A hit whose message text is empty matched SOMEWHERE — the snippet says
  // where. This is the blank-line bug's last line of defence.
  if (parts.length === 0 && event.snippet) {
    parts.push(`[${event.matchedColumn ?? "match"}: ${flatten(event.snippet, MAX_TEXT_CHARS)}]`);
  }
  if (parts.length === 0) parts.push(`[${event.kind ?? "message"}, no text]`);

  return `[evt ${shortEventId(event.id)}] ${when} · ${who}: ${parts.join(" ")}`;
}

/**
 * The id as a line prints it. A WhatsApp event id is `wa:<chat jid>/<stanza>`,
 * 51 chars of which the first 31 repeat the chat the section header already
 * names — ~7,900 chars of one measured section, pure overhead (v7 §6, lever 5).
 * The stanza is what stays.
 *
 * Safe to shorten only because it stays resolvable: `getEventDetail` takes a
 * whole id, or a tail that belongs to exactly one event, and refuses to guess
 * between two. An id with no tail worth cutting is printed whole.
 */
export function shortEventId(id: string): string {
  const cut = id.lastIndexOf("/");
  const tail = cut === -1 ? "" : id.slice(cut + 1);
  return tail.length >= MIN_SHORT_ID_CHARS ? tail : id;
}

// ---- Budget ---------------------------------------------------------------

/**
 * Keep as many lines as the budget allows, dropping the least explanatory
 * first. Search hits are never dropped for context — losing the answer to keep
 * the small talk around it is the bug this whole file exists to stop.
 *
 * Each section spends a SHARE of the budget rather than competing for all of it
 * (v7 §6, lever 3). The old rule compared distanceToHit across sections, which
 * reads as "the messages nearest a hit, wherever they are" and behaves as "the
 * densest chat wins": a YouTube short at distance 3 from its own weak hit beat a
 * Pranjali line at distance 8 from the answer, and 53% of the measured health
 * query went to two chats nobody had asked about. Within a section the old rule
 * is exactly right and is what still runs.
 *
 * A share nobody wants goes to whoever is still over — the top section can end
 * up with the whole budget when it is the only section that needs it.
 */
function fit(
  lines: readonly RenderedLine[],
  sections: readonly ContextSection[],
  budget: number,
): RenderedLine[] {
  const cost = (line: RenderedLine): number => line.text.length + 1;
  const present = [...new Set(lines.map((l) => l.sectionIndex))];
  const costs = present.map(
    (index) =>
      headerCost(sections[index]) +
      lines.filter((l) => l.sectionIndex === index).reduce((n, l) => n + cost(l), 0),
  );
  let total = costs.reduce((n, c) => n + c, 0);
  if (total <= budget) return [...lines];

  const weights = present.map(
    (index) => SECTION_WEIGHT(index) * (sections[index].whole ? WHOLE_SECTION_WEIGHT : 1),
  );
  const shares = allocate(costs, weights, budget);

  const dropped = new Set<RenderedLine>();
  present.forEach((index, slot) => {
    let spent = costs[slot];
    for (const line of droppableInOrder(lines, index)) {
      if (spent <= shares[slot]) break;
      dropped.add(line);
      spent -= cost(line);
      total -= cost(line);
    }
  });

  // Still over: the hits themselves are too many. Give up the WEAKEST first —
  // a shorter true answer beats a truncated one, and the strongest hit is the
  // likeliest to be the answer.
  if (total > budget) {
    const hits = lines
      .filter((l) => l.isHit && !dropped.has(l))
      .sort((a, b) => a.score - b.score || b.sectionIndex - a.sectionIndex);
    for (const line of hits) {
      if (total <= budget || dropped.size === lines.length - 1) break;
      dropped.add(line);
      total -= cost(line);
    }
  }

  return lines.filter((l) => !dropped.has(l));
}

/**
 * One section's droppable lines, worst first: furthest out by `proximity`, and
 * at equal distance the EARLIER one, because the message after a hit answers it
 * more often than the one before it does.
 */
function droppableInOrder(
  lines: readonly RenderedLine[],
  sectionIndex: number,
): RenderedLine[] {
  return lines
    .map((line, order) => ({ line, order }))
    .filter(({ line }) => line.sectionIndex === sectionIndex && !line.isHit)
    .sort((a, b) => proximity(b.line) - proximity(a.line) || a.order - b.order)
    .map(({ line }) => line);
}

/**
 * How far out a line is, in the window's own two units. It is close if it is
 * close by EITHER — that is what "±8 messages OR ±45 minutes" means — so what
 * goes first is what is far by both. Ordering on the message count alone would
 * make the time half of the window the first thing the budget throws away,
 * which is the same as not having it: the doctors cluster that ±45 minutes was
 * added to reach sits 46 messages from the hit.
 */
function proximity(line: RenderedLine): number {
  const byCount = line.distanceToHit / DEFAULT_WINDOW;
  if (line.minutesToHit === null) return byCount;
  return Math.min(byCount, line.minutesToHit / DEFAULT_WINDOW_MINUTES);
}

/**
 * Split the budget by weight, giving anything that asks for less than its share
 * exactly what it asks for and re-splitting the remainder among the rest. Two
 * sections of equal rank get equal shares; a section that fits in a tenth of
 * its share hands the other nine tenths to the sections still over.
 */
function allocate(
  costs: readonly number[],
  weights: readonly number[],
  budget: number,
): number[] {
  const shares = costs.map(() => 0);
  const open = new Set(costs.map((_, i) => i));
  let left = budget;

  while (open.size > 0 && left > 0) {
    const totalWeight = [...open].reduce((n, i) => n + weights[i], 0);
    if (!(totalWeight > 0)) break;
    let settled = false;
    for (const i of [...open]) {
      const share = (left * weights[i]) / totalWeight;
      if (costs[i] <= share) {
        shares[i] = costs[i];
        left -= costs[i];
        open.delete(i);
        settled = true;
      }
    }
    // Everyone left wants more than their share: that IS their share.
    if (!settled) {
      for (const i of open) shares[i] = (left * weights[i]) / totalWeight;
      break;
    }
  }
  return shares;
}

// ---- Text helpers ---------------------------------------------------------

function flatten(value: string, max: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** "yyyy-mm-dd hh:mm" in the user's local time. */
export function formatLocalTs(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return ts;
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${isoDate(localToday(at))} ${hh}:${mm}`;
}

function capitalise(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

// ===========================================================================
// [CODE] STW-2 packer — arch §5.5. The prompt half of the wire.
//
// Emits `#R #C #E #T #D`, the event lines with `+m` deltas and `^n` replies,
// and `#COV` so a silently dropped event is detectable.
//
// Separators are neutralised HERE and nowhere else, because the packer is the
// only place that knows which field a string is about to land in:
//   `|` → `/` in labels · `,` → space in participant names · newline runs → " ".
// Event text is left alone apart from newline collapse: it is the last field
// on its line, it may contain anything, and language is never compressed.
// ===========================================================================

import { createAliasTable, type AliasTable } from "./aliases.js";
import { ENUMS } from "./tolerance.js";

export interface PackEntity {
  id: string;
  name: string;
  /** Stored long form or wire code; person is the default and is not printed. */
  type?: string;
}

export interface PackStream {
  id: string;
  name: string;
  /** `group` | `dm` | `business` (or their codes). */
  kind: string;
  /** Entity ids; `self` is hoisted to the front. */
  participantIds: string[];
}

export interface PackEpisode {
  id: string;
  label: string;
  state: string;
  lastActivity?: string;
  entityIds?: string[];
  streamId?: string;
}

export interface PackLoop {
  id: string;
  intent: string;
  /** `self` prints as `me`. */
  ownerId?: string;
  due?: string;
  state: string;
  streamId?: string;
}

export interface PackEvent {
  id: string;
  streamId: string;
  /** ISO-8601 instant. */
  at: string;
  /** Entity id, or `self`. */
  speakerId: string;
  text?: string;
  replyToId?: string;
}

export interface PackInput {
  tz?: string;
  entities?: PackEntity[];
  streams: PackStream[];
  episodes?: PackEpisode[];
  loops?: PackLoop[];
  events?: PackEvent[];
}

export interface PackOptions {
  /** Above this the packer refuses and the call falls back to JSON (§5.9.3). */
  maxRoster?: number;
  table?: AliasTable;
}

export interface PackStats {
  roster: number;
  streams: number;
  events: number;
  dayBlocks: number;
}

export type PackResult =
  | { ok: true; text: string; table: AliasTable; stats: PackStats }
  | { ok: false; reason: "roster_over_cap"; count: number; cap: number; table: AliasTable };

const DEFAULT_MAX_ROSTER = 120;
/** A delta this large stops being a saving and starts being a puzzle (§5.5). */
const MAX_DELTA_MINUTES = 999;

// ---- separator neutralisation ---------------------------------------------

/** All newline runs collapse to a single space. Never a deletion. */
export function collapseNewlines(s: string): string {
  return typeof s === "string" ? s.replace(/\s*[\r\n]+\s*/g, " ") : "";
}

/** Labels sit between bare pipes, so a literal `|` becomes `/`. */
export function neutraliseLabel(s: string): string {
  return collapseNewlines(s).replace(/\|/g, "/").trim();
}

/** Participants are comma-joined, so a literal `,` becomes a space. */
export function neutraliseParticipant(s: string): string {
  return neutraliseLabel(s).replace(/,/g, " ").replace(/ {2,}/g, " ").trim();
}

// ---- local time ------------------------------------------------------------

interface LocalParts {
  date: string;
  dow: string;
  hhmm: string;
  ms: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz });
  } catch {
    fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
  }
  formatters.set(tz, fmt);
  return fmt;
}

function localParts(iso: string, tz: string): LocalParts | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    dow: get("weekday"),
    hhmm: `${hour}:${get("minute")}`,
    ms,
  };
}

// ---- packer ----------------------------------------------------------------

function enumCode(name: keyof typeof ENUMS, value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return ENUMS[name].encode(value) ?? neutraliseLabel(value);
}

/**
 * Build the prompt body. The alias table comes back with it — the response
 * parser needs the same table to resolve what the model wrote, and it is
 * thrown away with both.
 */
export function packPrompt(input: PackInput, options: PackOptions = {}): PackResult {
  const table = options.table ?? createAliasTable();
  const cap = options.maxRoster ?? DEFAULT_MAX_ROSTER;
  const tz = input.tz && input.tz.trim() !== "" ? input.tz : "UTC";
  const entities = (input.entities ?? []).filter((e) => e.id !== "self");

  if (entities.length > cap) {
    return { ok: false, reason: "roster_over_cap", count: entities.length, cap, table };
  }

  const lines: string[] = [];

  // #R — roster. `[type]` only when the entity is not a person.
  if (entities.length > 0) {
    const roster = entities.map((e) => {
      const token = table.mint("entity", e.id, e.name);
      const type = e.type ? enumCode("entity_type", e.type, "per") : "per";
      const suffix = type === "per" ? "" : ` [${type}]`;
      return `${token}=${neutraliseLabel(e.name)}${suffix}`;
    });
    lines.push(`#R ${roster.join(" | ")}`);
  }

  const episodes = input.episodes ?? [];
  const loops = input.loops ?? [];
  const events = input.events ?? [];
  let dayBlocks = 0;
  let packedEvents = 0;

  for (const [streamIndex, stream] of input.streams.entries()) {
    const streamToken = table.mint("stream", stream.id, stream.name);
    const first = streamIndex === 0;

    // #C — stream header. `self` is hoisted first; an off-roster participant is
    // named inline at first mention only.
    const participants: string[] = [];
    if (stream.participantIds.includes("self")) participants.push("self");
    for (const pid of stream.participantIds) {
      if (pid === "self") continue;
      const known = table.tokenFor("entity", pid);
      if (known) {
        participants.push(known);
      } else {
        const entity = entities.find((e) => e.id === pid);
        const token = table.mint("entity", pid, entity?.name);
        participants.push(entity ? `${token}=${neutraliseParticipant(entity.name)}` : token);
      }
    }
    lines.push(
      `#C ${streamToken} ${neutraliseLabel(stream.name)} | ${enumCode("chat_kind", stream.kind, "dm")} | ${participants.join(",")}`,
    );

    // #E — open episodes. Unassigned ones ride along in the first block.
    for (const ep of episodes) {
      if (ep.streamId !== stream.id && !(first && ep.streamId === undefined)) continue;
      const token = table.mint("episode", ep.id, ep.label);
      const members = (ep.entityIds ?? [])
        .map((id) => (id === "self" ? "self" : table.tokenFor("entity", id)))
        .filter((t): t is string => t !== null)
        .join(",");
      lines.push(
        `#E ${token} ${neutraliseLabel(ep.label)} | ${enumCode("loop_state", ep.state, "op")} | ${neutraliseLabel(ep.lastActivity ?? "-")} | ${members === "" ? "-" : members}`,
      );
    }

    // #T — open loops touching these entities.
    for (const loop of loops) {
      if (loop.streamId !== stream.id && !(first && loop.streamId === undefined)) continue;
      const token = table.mint("loop", loop.id, loop.intent);
      const owner =
        loop.ownerId === undefined || loop.ownerId === "self"
          ? "me"
          : (table.tokenFor("entity", loop.ownerId) ?? "-");
      lines.push(
        `#T ${token} ${neutraliseLabel(loop.intent)} | ${owner} | ${neutraliseLabel(loop.due ?? "-")} | ${enumCode("loop_state", loop.state, "op")}`,
      );
    }

    // Events, in day blocks. Deltas reset at every #D and every #C.
    const streamEvents = events.filter((e) => e.streamId === stream.id);
    let currentDate: string | null = null;
    let previousMs: number | null = null;
    for (const event of streamEvents) {
      const at = localParts(event.at, tz);
      if (at === null) continue;
      if (at.date !== currentDate) {
        lines.push(`#D ${at.date} ${at.dow} | ${tz}`);
        currentDate = at.date;
        previousMs = null;
        dayBlocks += 1;
      }
      const token = table.mintEvent(event.id);
      const speaker =
        event.speakerId === "self" ? "self" : (table.tokenFor("entity", event.speakerId) ?? table.mint("entity", event.speakerId));
      const delta = previousMs === null ? null : Math.round((at.ms - previousMs) / 60_000);
      const time = delta !== null && delta >= 0 && delta <= MAX_DELTA_MINUTES ? `+${delta}` : at.hhmm;
      previousMs = at.ms;
      const reply = event.replyToId ? table.eventToken(event.replyToId) : null;
      const body = collapseNewlines(event.text ?? "").trim();
      lines.push(
        [`${token} ${time} ${speaker}`, reply ? `^${reply}` : "", body].filter((s) => s !== "").join(" "),
      );
      packedEvents += 1;
    }

    // #COV — expected event count, so a silent drop is detectable.
    lines.push(`#COV ${streamToken}=${streamEvents.length}`);
  }

  return {
    ok: true,
    text: lines.join("\n"),
    table,
    stats: { roster: entities.length, streams: input.streams.length, events: packedEvents, dayBlocks },
  };
}

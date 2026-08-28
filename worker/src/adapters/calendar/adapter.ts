// ===========================================================================
// [CODE] CalendarAdapter — a local-ICS / fixture-driven SourceAdapter
// (build item 5.1; arch §2.1 "bounded", §2.2).
//
// The Phase-5 point is what this file does NOT contain: no DB writes, no
// segmentation, no identity logic, no scheduling. It reads one .ics file and
// speaks the same SourceAdapter callback surface WhatsApp does; the generic
// Ingestion writer, the descending-cohort buffer, the watermarks and the
// dedupe key all do their work unmodified.
//
// Shape mirrors worker/src/adapters/whatsapp/adapter.ts minus the daemon:
// there is no child process to supervise, so connect() parses the file,
// backfill(range) emits the in-range records as historical events and closes
// with `backfill_complete`, and everything else is honest bookkeeping.
//
// Two adapter-local decisions worth their comment:
//
//   1. **No skew clamp.** WhatsApp runs normalizeSourceEvent() because a
//      future message timestamp is a broken phone clock. A calendar record
//      dated next Tuesday is not a broken clock — the future start IS the
//      record (§2.1 bounded; global acceptance: a future occurrence keeps a
//      loop live). Clamping it to now would destroy the one thing this source
//      exists to say. `ts` is the DTSTART the fixture stated.
//
//   2. **kind is "message"**, the generic content kind. The BOUNDED shape is
//      carried where §2.1 puts it — on the STREAM (`stream.kind:"calendar"` →
//      manifest.stream_kind_of → "bounded") — not smuggled through the event
//      kind. Start/end/attendees/location travel intact in `raw` for the
//      bridge items (5.3/5.4) to read.
// ===========================================================================

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { rangeCutoffMs } from "../source-adapter.js";
import type { SourceAdapter } from "../source-adapter.js";
import type {
  Actor,
  AdapterStatus,
  Range,
  SourceEvent,
  Stream,
  StatusUpdate,
} from "../types.js";
import { parseIcs, type IcsCalendar, type IcsEvent } from "./ics.js";
import { CALENDAR_SOURCE_ID } from "./manifest.js";

export interface CalendarAdapterOptions {
  /** Explicit .ics fixture path (overrides env + default). */
  fixturePath?: string;
  /** Base home dir (default: SUPERTWIN_HOME or ~/SuperTwinV13). */
  home?: string;
  /**
   * How "me" appears in this source — the email the manifest's self_identity
   * binds through once ingestion persists it. Falls back to
   * SUPERTWIN_CALENDAR_SELF_EMAIL; absent means no self actor is emitted (and
   * selfEmail() stays null, which registration explicitly allows).
   */
  selfEmail?: string;
  /** Log sink for adapter diagnostics. */
  log?: (line: string) => void;
}

/** Env override for the fixture path, mirroring SUPERTWIN_WHATSAPP_BIN. */
export const CALENDAR_FIXTURE_ENV = "SUPERTWIN_CALENDAR_FIXTURE";
/** Env fallback for the self email. */
export const CALENDAR_SELF_EMAIL_ENV = "SUPERTWIN_CALENDAR_SELF_EMAIL";

/** Default lane key when the fixture names no calendar. */
export const DEFAULT_CALENDAR_KEY = "primary";

function resolveHome(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.SUPERTWIN_HOME;
  if (env && env.trim().length) return env;
  return join(homedir(), "SuperTwinV13");
}

export function resolveCalendarFixture(explicit?: string, home?: string): string {
  if (explicit) return explicit;
  const env = process.env[CALENDAR_FIXTURE_ENV];
  if (env && env.trim().length) return env;
  return join(resolveHome(home), "calendar", "calendar.ics");
}

/** `<calendarKey>/<uid>` — the stable dedupe key WITHIN the source. */
export function calendarExternalId(calendarKey: string, uid: string): string {
  return `${calendarKey}/${uid}`;
}

export class CalendarAdapter implements SourceAdapter {
  readonly sourceId = CALENDAR_SOURCE_ID;
  readonly sourceType = CALENDAR_SOURCE_ID;

  private readonly fixturePath: string;
  private readonly selfEmail: string | null;
  private readonly log: (line: string) => void;

  private calendar: IcsCalendar | null = null;
  private calendarKey = DEFAULT_CALENDAR_KEY;

  private status: AdapterStatus = {
    state: "starting",
    paired: false,
    paused: false,
  };

  private readonly eventCbs: Array<(e: SourceEvent) => void> = [];
  private readonly streamCbs: Array<(s: Stream) => void> = [];
  private readonly actorCbs: Array<(a: Actor) => void> = [];
  private readonly statusCbs: Array<(s: StatusUpdate) => void> = [];

  constructor(opts: CalendarAdapterOptions = {}) {
    this.fixturePath = resolveCalendarFixture(opts.fixturePath, opts.home);
    this.selfEmail =
      (opts.selfEmail ?? process.env[CALENDAR_SELF_EMAIL_ENV])?.trim().toLowerCase() || null;
    this.log = opts.log ?? (() => {});
  }

  // ---- SourceAdapter callbacks --------------------------------------------

  onEvent(cb: (e: SourceEvent) => void): void {
    this.eventCbs.push(cb);
  }
  onStream(cb: (s: Stream) => void): void {
    this.streamCbs.push(cb);
  }
  onActor(cb: (a: Actor) => void): void {
    this.actorCbs.push(cb);
  }
  onStatus(cb: (s: StatusUpdate) => void): void {
    this.statusCbs.push(cb);
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  /** Seed the paused flag from persisted app_state (kill-switch survives restart). */
  setPaused(paused: boolean): void {
    this.status = { ...this.status, paused };
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Parse the fixture and announce the lane + the people on it. A missing or
   * unreadable file is surfaced as an error status, never a throw — the worker
   * keeps booting and serving, same resilience contract as a missing daemon
   * binary.
   */
  async connect(): Promise<void> {
    let text: string;
    try {
      text = readFileSync(this.fixturePath, "utf8");
    } catch (err) {
      this.status = {
        ...this.status,
        lastError: { code: "FIXTURE_MISSING", message: (err as Error).message },
      };
      this.emitStatus({
        type: "error",
        code: "FIXTURE_MISSING",
        message: `calendar fixture not readable (${this.fixturePath}): ${(err as Error).message}`,
        fatal: false,
      });
      this.setState("error", "fixture missing");
      return;
    }

    this.calendar = parseIcs(text);
    this.calendarKey = this.calendar.name?.trim() || DEFAULT_CALENDAR_KEY;
    this.log(
      `[calendar] loaded ${this.calendar.events.length} events from ${this.fixturePath} (lane ${this.calendarKey})`,
    );

    // A local file needs no pairing: connected = paired.
    this.status = { ...this.status, paired: true };
    this.setState("connected");

    // Lane first (the stream row the events will bind to), then the people.
    this.emitStream();
    this.emitActors();

    this.setState("online");
  }

  /** No pairing ceremony for a local file — already online. */
  async startPairing(): Promise<void> {
    if (this.status.state !== "online" && this.calendar) this.setState("online");
  }

  /**
   * Emit every in-range record as a historical event, then close the run with
   * `backfill_complete` — which is what makes the generic Ingestion flush its
   * re-order buffer and mark the watermarks complete, with no calendar-shaped
   * code on its side.
   */
  async backfill(range: Range): Promise<void> {
    if (!this.calendar) {
      this.emitStatus({
        type: "error",
        code: "NOT_CONNECTED",
        message: "backfill before connect(): no fixture loaded",
        fatal: false,
      });
      return;
    }
    const cutoff = rangeCutoffMs(range, Date.now());
    let emitted = 0;
    for (const ev of this.calendar.events) {
      const startMs = Date.parse(ev.start);
      if (!Number.isFinite(startMs) || startMs < cutoff) continue;
      // Kill-switch: belt + suspenders — the writer also refuses while paused.
      if (this.status.paused) break;
      const source = this.toSourceEvent(ev);
      for (const cb of this.eventCbs) cb(source);
      emitted += 1;
    }
    this.status = {
      ...this.status,
      progress: {
        phase: "backfill",
        chatsDone: 1,
        chatsTotal: 1,
        messages: emitted,
        done: true,
        range,
      },
    };
    this.emitStatus({ type: "backfill_complete", range, chats: 1, messages: emitted });
  }

  /** Widening coverage re-reads the same file; dedupe absorbs the overlap. */
  async extend(range: Range): Promise<void> {
    await this.backfill(range);
  }

  async pause(paused: boolean): Promise<void> {
    this.setPaused(paused);
  }

  /** Nothing to unpair from; drop the loaded fixture so /status is honest. */
  async logout(): Promise<void> {
    this.calendar = null;
    this.status = { ...this.status, paired: false };
    this.setState("logged_out");
  }

  /** No child process, no timers — nothing to reap. */
  async disconnect(): Promise<void> {}

  // ---- Emission -----------------------------------------------------------

  private emitStream(): void {
    const s: Stream = {
      source_ext_id: this.calendarKey,
      name: this.calendar?.name?.trim() || this.calendarKey,
      // The source's own lane word (§2.2 StreamRef.kind) — the manifest's
      // stream_kind_of maps it to the §2.1 kind ("bounded").
      kind: "calendar",
      is_business: false,
    };
    for (const cb of this.streamCbs) cb(s);
  }

  /**
   * Everyone the fixture names, deduped by email: the self user (so ingestion
   * persists the self identity the manifest reads back), each organizer, each
   * attendee.
   */
  private emitActors(): void {
    const seen = new Map<string, Actor>();
    const add = (email: string, name: string | undefined) => {
      const key = email.toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        // A later CN beats an email-as-name placeholder.
        if (name && existing.display_name === existing.source_ext_id) {
          existing.display_name = name;
        }
        return;
      }
      seen.set(key, {
        source_ext_id: key,
        display_name: name ?? key,
        is_self: this.selfEmail !== null && key === this.selfEmail,
      });
    };
    if (this.selfEmail) add(this.selfEmail, undefined);
    for (const ev of this.calendar?.events ?? []) {
      if (ev.organizer) add(ev.organizer.email, ev.organizer.name);
      for (const a of ev.attendees) add(a.email, a.name);
    }
    for (const actor of seen.values()) {
      for (const cb of this.actorCbs) cb(actor);
    }
  }

  /** One VEVENT → one source-neutral event (contract §3). */
  private toSourceEvent(ev: IcsEvent): SourceEvent {
    const organizer = ev.organizer?.email ?? null;
    const fromMe = this.selfEmail !== null && organizer === this.selfEmail;
    // The actor is whoever put the record there: the organizer when the invite
    // names one, else the self user (their own calendar), else the lane itself.
    const actorExtId = organizer ?? this.selfEmail ?? this.calendarKey;
    return {
      external_id: calendarExternalId(this.calendarKey, ev.uid),
      stream_ext_id: this.calendarKey,
      actor_ext_id: actorExtId,
      // DTSTART verbatim — see header note 1: a future start is the record.
      ts: ev.start,
      kind: "message",
      text: ev.summary || "(untitled event)",
      link: ev.url ? { url: ev.url } : null,
      from_me: fromMe,
      // A snapshot file is history by definition; the descending-cohort buffer
      // and the backfill watermark are what "historical" routes into.
      is_historical: true,
      // The bounded record travels whole: start/end, the attendee set (the
      // §2.2 attendee_set bridge material), location, status, all-day flag.
      raw: {
        uid: ev.uid,
        dtstart: ev.start,
        ...(ev.end ? { dtend: ev.end } : {}),
        all_day: ev.all_day,
        ...(ev.description ? { description: ev.description } : {}),
        ...(ev.location ? { location: ev.location } : {}),
        ...(ev.status ? { status: ev.status } : {}),
        ...(organizer ? { organizer } : {}),
        attendees: ev.attendees.map((a) => ({
          email: a.email,
          ...(a.name ? { name: a.name } : {}),
          ...(a.role ? { role: a.role } : {}),
        })),
      },
    };
  }

  // ---- Status helpers -----------------------------------------------------

  private setState(state: AdapterStatus["state"], detail?: string): void {
    if (this.status.state === state) return;
    this.status = { ...this.status, state };
    this.emitStatus({ type: "status", state, detail });
  }

  private emitStatus(s: StatusUpdate): void {
    for (const cb of this.statusCbs) cb(s);
  }
}

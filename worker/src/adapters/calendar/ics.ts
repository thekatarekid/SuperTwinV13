// ===========================================================================
// [CODE] Minimal ICS (RFC 5545) reader for the fixture-driven calendar source
// (build item 5.1).
//
// Deliberately small: this parses exactly the subset a local .ics fixture
// needs — VEVENT blocks with UID / DTSTART / DTEND / SUMMARY / DESCRIPTION /
// LOCATION / URL / STATUS / ORGANIZER / ATTENDEE, line unfolding, property
// parameters (CN=, ROLE=, VALUE=DATE), UTC ("...Z"), date-only and naive
// local timestamps. It is adapter-local by design: nothing in the generic
// layer knows ICS exists.
//
// Honest limits, stated rather than hidden:
//   - TZID parameters are ignored; a naive DTSTART is read as UTC. Fixtures
//     use "Z" timestamps, so nothing in the test corpus depends on this.
//   - RRULE is not expanded; a recurring VEVENT yields its master record only.
// ===========================================================================

/** One attendee (or the organizer) off a VEVENT. */
export interface IcsPerson {
  email: string;
  /** CN= display name, when the property carried one. */
  name?: string;
  /** ROLE= / implicit "organizer". */
  role?: string;
}

/** One parsed VEVENT. */
export interface IcsEvent {
  uid: string;
  /** ISO-8601 UTC. */
  start: string;
  /** ISO-8601 UTC, when DTEND was present. */
  end?: string;
  /** True when DTSTART was VALUE=DATE (all-day). */
  all_day: boolean;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  status?: string;
  organizer?: IcsPerson;
  attendees: IcsPerson[];
}

/** The whole parsed fixture. */
export interface IcsCalendar {
  /** X-WR-CALNAME, when present. */
  name?: string;
  events: IcsEvent[];
}

// ---- Line-level mechanics --------------------------------------------------

/** RFC 5545 §3.1: a line starting with SPACE/HTAB continues the previous one. */
export function unfoldIcsLines(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      out.push(line);
    }
  }
  return out;
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** `ATTENDEE;CN=Gargi;ROLE=REQ-PARTICIPANT:mailto:g@x.com` → parts. */
function parseProp(line: string): IcsProp | null {
  // The ':' separating name+params from the value is the first one outside a
  // quoted param value.
  let inQuotes = false;
  let sep = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      sep = i;
      break;
    }
  }
  if (sep <= 0) return null;
  const head = line.slice(0, sep);
  const value = line.slice(sep + 1);
  const segs = head.split(";");
  const name = (segs[0] ?? "").toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** RFC 5545 §3.3.11 TEXT unescaping: \n \, \; \\ */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/**
 * `20260801T130000Z` / `20260801T130000` / `20260801` → ISO-8601 UTC, or null
 * when unparseable. A date-only value is midnight UTC (all-day).
 */
export function icsDateToIso(v: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h ?? "00"}:${mi ?? "00"}:${s ?? "00"}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** `mailto:g@x.com` (any case) → `g@x.com`, lowercased. */
function mailtoEmail(v: string): string | null {
  const stripped = v.trim().replace(/^mailto:/i, "").trim().toLowerCase();
  return stripped.includes("@") ? stripped : null;
}

function personOf(prop: IcsProp, defaultRole: string): IcsPerson | null {
  const email = mailtoEmail(prop.value);
  if (!email) return null;
  const person: IcsPerson = { email, role: (prop.params["ROLE"] ?? defaultRole).toLowerCase() };
  const cn = prop.params["CN"];
  if (cn) person.name = cn;
  return person;
}

// ---- The parser ------------------------------------------------------------

/**
 * Parse one .ics text into a calendar. A VEVENT with no UID or no parseable
 * DTSTART is skipped (there is nothing stable to dedupe it on, and nothing to
 * order it by) — skips are counted by the caller via the returned totals
 * rather than thrown, because one malformed block must not sink a fixture.
 */
export function parseIcs(text: string): IcsCalendar {
  const lines = unfoldIcsLines(text);
  const events: IcsEvent[] = [];
  let calName: string | undefined;

  let cur: Partial<IcsEvent> & { attendees: IcsPerson[] } | null = null;

  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      cur = { attendees: [] };
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      if (cur && typeof cur.uid === "string" && cur.uid && typeof cur.start === "string") {
        events.push({
          uid: cur.uid,
          start: cur.start,
          end: cur.end,
          all_day: cur.all_day ?? false,
          summary: cur.summary ?? "",
          description: cur.description,
          location: cur.location,
          url: cur.url,
          status: cur.status,
          organizer: cur.organizer,
          attendees: cur.attendees,
        });
      }
      cur = null;
      continue;
    }

    const prop = parseProp(line);
    if (!prop) continue;

    if (!cur) {
      if (prop.name === "X-WR-CALNAME" && prop.value.trim()) calName = unescapeText(prop.value.trim());
      continue;
    }

    switch (prop.name) {
      case "UID":
        cur.uid = prop.value.trim();
        break;
      case "DTSTART": {
        const iso = icsDateToIso(prop.value);
        if (iso) {
          cur.start = iso;
          cur.all_day = prop.params["VALUE"] === "DATE" || !/T/.test(prop.value);
        }
        break;
      }
      case "DTEND": {
        const iso = icsDateToIso(prop.value);
        if (iso) cur.end = iso;
        break;
      }
      case "SUMMARY":
        cur.summary = unescapeText(prop.value);
        break;
      case "DESCRIPTION":
        cur.description = unescapeText(prop.value);
        break;
      case "LOCATION":
        cur.location = unescapeText(prop.value);
        break;
      case "URL":
        cur.url = prop.value.trim();
        break;
      case "STATUS":
        cur.status = prop.value.trim().toLowerCase();
        break;
      case "ORGANIZER": {
        const p = personOf(prop, "organizer");
        if (p) cur.organizer = p;
        break;
      }
      case "ATTENDEE": {
        const p = personOf(prop, "req-participant");
        if (p) cur.attendees.push(p);
        break;
      }
      default:
        break;
    }
  }

  return { name: calName, events };
}

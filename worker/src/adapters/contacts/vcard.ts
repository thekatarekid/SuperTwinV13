// ===========================================================================
// [CODE] A vCard-like parser for the fixture-driven Contacts adapter
// (build item 5.2). Deterministic, model-free, and deliberately small: it
// reads the subset of vCard 3.0/4.0 the adapter needs — UID, FN, TEL, EMAIL,
// REV — and nothing else. Unknown properties are carried through verbatim in
// `raw` and otherwise ignored; a parser that guesses at the rest of the spec
// is a parser that invents identities.
//
// NO NORMALISATION HAPPENS HERE. A TEL value leaves this file exactly as the
// fixture wrote it ("+91 98123 45001", "0091-98…"); the ONE place a phone or
// email is normalised is `entities/identities.ts`, because two normalisers
// that drift apart are a wrong cross-source join waiting to happen.
// ===========================================================================

/** One parsed card. Values are verbatim; normalisation is the graph's job. */
export interface ContactCard {
  /** Stable id within the source. Falls back to `fn` when the card has no UID. */
  uid: string;
  /** Formatted display name ("" when the card has none). */
  fn: string;
  /** TEL values in card order, duplicates (post-trim) dropped. */
  phones: string[];
  /** EMAIL values in card order, duplicates (post-trim, case-folded) dropped. */
  emails: string[];
  /** REV timestamp as ISO-8601 UTC, or null when absent/unparseable. */
  rev: string | null;
  /** The card's verbatim lines, for `SourceEvent.raw`. */
  raw: string[];
}

/**
 * Unfold RFC-6350 folded lines: a line starting with SPACE or TAB continues
 * the previous one. Both LF and CRLF fixtures are accepted.
 */
function unfold(text: string): string[] {
  const lines = String(text ?? "").split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** "TEL;TYPE=CELL:+91 98…" → { name: "TEL", value: "+91 98…" }. */
function splitProperty(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const name = head.split(";")[0].trim().toUpperCase();
  if (name === "") return null;
  return { name, value: line.slice(colon + 1).trim() };
}

/** "20240115T093000Z" or ISO-8601 → ISO-8601 UTC; null when unparseable. */
export function parseRev(value: string): string | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(text);
  const candidate = basic
    ? `${basic[1]}-${basic[2]}-${basic[3]}T${basic[4]}:${basic[5]}:${basic[6]}Z`
    : text;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Parse every BEGIN:VCARD…END:VCARD block in `text`, in file order. A block
 * with neither UID nor FN is dropped — a card with no identity and no name
 * binds nothing and names nobody. Malformed lines are skipped, never guessed.
 */
export function parseVcards(text: string): ContactCard[] {
  const cards: ContactCard[] = [];
  let current: ContactCard | null = null;
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();

  for (const line of unfold(text)) {
    const prop = splitProperty(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VCARD") {
      current = { uid: "", fn: "", phones: [], emails: [], rev: null, raw: [] };
      seenPhones.clear();
      seenEmails.clear();
      continue;
    }
    if (!current) continue;
    if (prop.name === "END" && prop.value.toUpperCase() === "VCARD") {
      if (current.uid === "" && current.fn !== "") current.uid = current.fn;
      if (current.uid !== "") cards.push(current);
      current = null;
      continue;
    }
    current.raw.push(line);
    switch (prop.name) {
      case "UID":
        current.uid = prop.value;
        break;
      case "FN":
        current.fn = prop.value;
        break;
      case "TEL": {
        if (prop.value === "" || seenPhones.has(prop.value)) break;
        seenPhones.add(prop.value);
        current.phones.push(prop.value);
        break;
      }
      case "EMAIL": {
        const key = prop.value.toLowerCase();
        if (prop.value === "" || seenEmails.has(key)) break;
        seenEmails.add(key);
        current.emails.push(prop.value);
        break;
      }
      case "REV":
        current.rev = parseRev(prop.value);
        break;
      default:
        break;
    }
  }
  return cards;
}

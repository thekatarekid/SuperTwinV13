// ===========================================================================
// [CODE] Address-term memory — V6 P1 S5.4 (Product_V6 §11.5 "Address and
// tone memory", CRM-04, ROL-06/07).
//
// An address term ("bro", "boss", "chotu", "yaar") is classified by what the
// record shows, never by what it means in a dictionary:
//
//   discriminating  in ONE scope the term has only ever been used for ONE
//                   person, at least DISCRIMINATING_MIN times → evidence of
//                   who is addressed (ROL-07: "boss" = Sameer in Falcon).
//   generic         used for two or more people anywhere → ZERO addressee
//                   evidence. It still feeds tone (register, habits) and is
//                   never a relationship claim ("bro" ≠ brother, ROL-06).
//
// Observations live on tone_profiles.address_terms_json (0101) — per stream
// for groups, per person for DMs — kept apart. Each term entry carries
// `maps_to` (the addressee, when discriminating) and `by_addressee` counts.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { getToneProfile, upsertToneProfile, type AddressTerm } from "../claims/store.js";

export type AddressClass = "discriminating" | "generic";
export const DISCRIMINATING_MIN = 3;

/** Terms the record treats as generic until proven otherwise — a floor, not a rule. */
export const COMMON_VOCATIVES = [
  "bro",
  "bhai",
  "bhaiya",
  "boss",
  "yaar",
  "yaar",
  "dude",
  "sir",
  "ma'am",
  "maam",
  "beta",
  "buddy",
  "man",
  "guys",
  "chotu",
  "bhau",
  "dada",
  "didi",
  "bhabhi",
  "aunty",
  "uncle",
  "ji",
  "mate",
  "boss",
  "babe",
  "jaan",
  "yo",
  "oye",
  "arre",
  "arey",
];

const VOCATIVE_SET = new Set(COMMON_VOCATIVES);

/** The leading vocative of a message ("bro send the link" → "bro"), lower-case. */
export function leadingAddressTerm(text: string): string | null {
  const tokens = text
    .trim()
    .toLowerCase()
    .replace(/^[@]/, "")
    .split(/[\s,!.?—-]+/)
    .filter((t) => t !== "");
  for (const tok of tokens.slice(0, 3)) {
    if (tok === "oye" || tok === "arre" || tok === "arey" || tok === "yo") continue; // interjection before the term
    if (VOCATIVE_SET.has(tok)) return tok;
    return null;
  }
  return null;
}

interface StoredTerm extends AddressTerm {
  maps_to?: string | null;
  by_addressee?: Record<string, number>;
}

export interface AddressObservation {
  term: string;
  /** Group scope: the stream key. DM scope: null. */
  streamKey?: string | null;
  /** DM scope: the person. Group scope: null. */
  personEntityId?: string | null;
  /** Who the term was addressed to — null when unknown at observation time. */
  addresseeId: string | null;
  decidedBy?: string;
}

function streamIdFor(key: string | null | undefined): string | null {
  if (!key) return null;
  const row = getDb().prepare(`SELECT id FROM streams WHERE id = ? OR external_key = ? ORDER BY rowid LIMIT 1`).get(key, key) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * Every scope's counts for a term, DMs and groups apart. Returns the set of
 * distinct addressees across ALL scopes (the generic test) and the counts in
 * the one scope asked for.
 */
export function termObservations(term: string, scope: { streamKey?: string | null; personEntityId?: string | null }): {
  here: Record<string, number>;
  everywhere: Record<string, number>;
} {
  const db = getDb();
  const rows = db.prepare(`SELECT person_entity_id, stream_id, address_terms_json FROM tone_profiles WHERE address_terms_json IS NOT NULL`).all() as {
    person_entity_id: string | null;
    stream_id: string | null;
    address_terms_json: string;
  }[];
  const hereStream = streamIdFor(scope.streamKey);
  const here: Record<string, number> = {};
  const everywhere: Record<string, number> = {};
  const t = term.toLowerCase();
  for (const r of rows) {
    let terms: StoredTerm[] = [];
    try {
      const p: unknown = JSON.parse(r.address_terms_json);
      if (Array.isArray(p)) terms = p as StoredTerm[];
    } catch {
      continue;
    }
    const entry = terms.find((x) => x.term.toLowerCase() === t);
    if (!entry) continue;
    const by = entry.by_addressee ?? (entry.maps_to ? { [entry.maps_to]: entry.count } : {});
    const isHere =
      (hereStream !== null && r.stream_id === hereStream && r.person_entity_id === null) ||
      (scope.personEntityId != null && r.person_entity_id === scope.personEntityId && r.stream_id === null);
    for (const [id, n] of Object.entries(by)) {
      everywhere[id] = (everywhere[id] ?? 0) + n;
      if (isHere) here[id] = (here[id] ?? 0) + n;
    }
  }
  return { here, everywhere };
}

export interface TermClass {
  term: string;
  class: AddressClass;
  /** The one addressee when discriminating. */
  mapsTo: string | null;
  observationsHere: number;
  distinctAddressees: number;
}

/** Classify a term for a scope from the stored record. Pure over the DB. */
export function classifyAddressTerm(term: string, streamKey: string | null, personEntityId: string | null = null): TermClass {
  const { here, everywhere } = termObservations(term, { streamKey, personEntityId });
  const distinct = Object.keys(everywhere).length;
  const hereIds = Object.keys(here);
  const total = Object.values(here).reduce((a, b) => a + b, 0);
  if (distinct >= 2) return { term, class: "generic", mapsTo: null, observationsHere: total, distinctAddressees: distinct };
  if (hereIds.length === 1 && total >= DISCRIMINATING_MIN) {
    return { term, class: "discriminating", mapsTo: hereIds[0]!, observationsHere: total, distinctAddressees: distinct };
  }
  return { term, class: "generic", mapsTo: null, observationsHere: total, distinctAddressees: distinct };
}

/**
 * Record one use of an address term in a scope and re-classify it. Writes the
 * tone profile for that scope (DM and group kept apart); the class is
 * recomputed from the whole record so a term can move generic ← discriminating
 * when a second addressee appears (upsertToneProfile alone would keep it
 * sticky, so the reclassification is written explicitly).
 */
export function observeAddressTerm(o: AddressObservation): TermClass {
  const db = getDb();
  const term = o.term.toLowerCase();
  const streamId = streamIdFor(o.streamKey);
  const personId = o.personEntityId ?? null;
  if (streamId === null && personId === null) {
    throw new Error(`observeAddressTerm: scope ${o.streamKey ?? "(no stream)"} resolves to no stream and no person`);
  }
  const existing = getToneProfile(personId, streamId);
  const terms = (existing?.addressTerms ?? []) as StoredTerm[];
  const entry = terms.find((t) => t.term.toLowerCase() === term);
  const by: Record<string, number> = { ...(entry?.by_addressee ?? (entry?.maps_to ? { [entry.maps_to]: entry.count } : {})) };
  if (o.addresseeId) by[o.addresseeId] = (by[o.addresseeId] ?? 0) + 1;
  const count = (entry?.count ?? 0) + 1;
  const next: StoredTerm[] = [
    ...terms.filter((t) => t.term.toLowerCase() !== term),
    { term, class: "generic", count, by_addressee: by, maps_to: null },
  ];
  if (!existing) {
    upsertToneProfile({ personEntityId: personId, streamId, addressTerms: [], decidedBy: o.decidedBy ?? "code:address-terms" });
  }
  const cls = (() => {
    // Classify with the new observation included.
    const { everywhere } = termObservations(term, { streamKey: o.streamKey, personEntityId: personId });
    const merged: Record<string, number> = { ...everywhere };
    for (const [id, n] of Object.entries(by)) merged[id] = Math.max(merged[id] ?? 0, n);
    const distinct = Object.keys(merged).length;
    const hereIds = Object.keys(by);
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    if (distinct >= 2) return { class: "generic" as AddressClass, mapsTo: null, total, distinct };
    if (hereIds.length === 1 && total >= DISCRIMINATING_MIN) return { class: "discriminating" as AddressClass, mapsTo: hereIds[0]!, total, distinct };
    return { class: "generic" as AddressClass, mapsTo: null, total, distinct };
  })();
  const finalTerms = next.map((t) => (t.term === term ? { ...t, class: cls.class, maps_to: cls.mapsTo } : t));
  db.prepare(
    `UPDATE tone_profiles SET address_terms_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE COALESCE(person_entity_id, '') = COALESCE(?, '') AND COALESCE(stream_id, '') = COALESCE(?, '')`,
  ).run(JSON.stringify(finalTerms.sort((a, b) => a.term.localeCompare(b.term))), personId, streamId);
  return { term, class: cls.class, mapsTo: cls.mapsTo, observationsHere: cls.total, distinctAddressees: cls.distinct };
}

/** Every term the record holds for a scope, classified — the tone card's list. */
export function addressTermsForScope(scope: { streamKey?: string | null; personEntityId?: string | null }): TermClass[] {
  const profile = getToneProfile(scope.personEntityId ?? null, streamIdFor(scope.streamKey));
  return ((profile?.addressTerms ?? []) as StoredTerm[]).map((t) => classifyAddressTerm(t.term, scope.streamKey ?? null, scope.personEntityId ?? null));
}

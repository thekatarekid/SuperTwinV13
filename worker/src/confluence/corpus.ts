// ===========================================================================
// [CODE] Confluence reference corpus — build item 4.3, arch §11.6 rule 6.
//
// ONE corpus, THREE ingest orders, and the acceptance is an IDENTICAL final
// graph. This file is the corpus: a fixed WhatsApp-shaped world (streams,
// actors, events) plus the FROZEN model extractions for it — every [LLM]
// answer keyed by the EVENT it answers, never by when that event arrived.
// Freezing per content is what frozen eval mode does everywhere else in this
// build; the property under test is that the CODE composes those answers
// order-independently, not that a live model is deterministic (it is not).
//
// Nothing here is random. The three orders are derived, not drawn:
//   - `chronological`  — a full backfill, oldest first;
//   - `reverse`        — live-then-backfill: newest lands first, history
//                        arrives behind it (the descending-cohort shape);
//   - `delayedStream`  — a delayed-sync simulation: one stream's history is
//                        held back entirely and lands after everything else,
//                        the other two interleave.
//
// The corpus deliberately contains the shapes that BREAK a non-confluent
// writer: a claim superseded across a month (arrives before its predecessor
// in two of the three orders), a reinforced claim stated twice in different
// streams, a loop resolved by later evidence, and a recurring loop.
// ===========================================================================

export const SOURCE_ID = "wa_confluence";
export const SOURCE_TYPE = "whatsapp";

/** The frozen instant every run is posed at. After the last event. */
export const CONFLUENCE_NOW = Date.parse("2026-08-15T12:00:00.000Z");

export interface CorpusActor {
  extId: string;
  jid: string;
  name: string;
  isSelf?: boolean;
}

export interface CorpusStream {
  extId: string;
  name: string;
}

export interface CorpusEvent {
  externalId: string;
  streamExtId: string;
  actorExtId: string;
  ts: string;
  text: string;
}

export const ACTORS: readonly CorpusActor[] = [
  { extId: "self", jid: "911111111111@s.whatsapp.net", name: "Aditya", isSelf: true },
  { extId: "rahul", jid: "912222222222@s.whatsapp.net", name: "Rahul Arora" },
  { extId: "priya", jid: "913333333333@s.whatsapp.net", name: "Priya Nair" },
  { extId: "amma", jid: "914444444444@s.whatsapp.net", name: "Amma" },
];

export const STREAMS: readonly CorpusStream[] = [
  { extId: "dm_rahul", name: "Rahul Arora" },
  { extId: "dm_priya", name: "Priya Nair" },
  { extId: "dm_amma", name: "Amma" },
];

/** ev|stream|actor|ts|text — kept compact so the shape stays reviewable. */
const ROWS: readonly [string, string, string, string, string][] = [
  // -- July, dm_rahul: the claim that will be SUPERSEDED in August ----------
  ["e01", "dm_rahul", "rahul", "2026-07-01T09:00:00Z", "moved all my stuff, I live in Koramangala now"],
  ["e02", "dm_rahul", "self", "2026-07-01T09:05:00Z", "nice, closer to the office"],
  ["e03", "dm_rahul", "rahul", "2026-07-01T09:07:00Z", "yeah 15 min walk"],
  // -- July, dm_priya: a preference stated the FIRST time -------------------
  ["e04", "dm_priya", "priya", "2026-07-03T10:00:00Z", "coffee this weekend?"],
  ["e05", "dm_priya", "self", "2026-07-03T10:04:00Z", "sure, you know I prefer filter coffee"],
  ["e06", "dm_priya", "priya", "2026-07-03T10:06:00Z", "third wave it is, they have filter too"],
  // -- July, dm_priya: a loop that later evidence RESOLVES ------------------
  ["e07", "dm_priya", "priya", "2026-07-10T18:00:00Z", "can you return my copy of Pachinko when we meet"],
  ["e08", "dm_priya", "self", "2026-07-10T18:02:00Z", "yes! I will return your book, it is in my bag already"],
  // -- July, dm_amma: a recurring obligation --------------------------------
  ["e09", "dm_amma", "amma", "2026-07-15T07:30:00Z", "beta, the car insurance renewal came again"],
  ["e10", "dm_amma", "self", "2026-07-15T07:45:00Z", "I renew the car insurance every July, will do it"],
  ["e11", "dm_amma", "amma", "2026-07-15T07:50:00Z", "ok. also we are still in the Jayanagar house"],
  // -- August, dm_rahul: an open loop with a future due ---------------------
  ["e12", "dm_rahul", "rahul", "2026-08-02T11:00:00Z", "landlord is asking, send me the rent receipt by the 20th"],
  ["e13", "dm_rahul", "self", "2026-08-02T11:03:00Z", "will send the rent receipt before the 20th"],
  // -- August, dm_priya: the preference REINFORCED --------------------------
  ["e14", "dm_priya", "self", "2026-08-03T09:00:00Z", "found a place near you, filter coffee is still my thing"],
  ["e15", "dm_priya", "priya", "2026-08-03T09:04:00Z", "noted, filter coffee person"],
  // -- August, dm_rahul: the SUPERSEDING claim ------------------------------
  ["e16", "dm_rahul", "rahul", "2026-08-05T19:00:00Z", "update: gave up the Koramangala flat, I live in Indiranagar now"],
  ["e17", "dm_rahul", "self", "2026-08-05T19:04:00Z", "you move a lot"],
  // -- August, dm_priya: the RESOLUTION evidence ----------------------------
  ["e18", "dm_priya", "self", "2026-08-08T17:00:00Z", "gave your book back to you at the cafe, done"],
  ["e19", "dm_priya", "priya", "2026-08-08T17:02:00Z", "got it, thanks!"],
  // -- August, dm_amma: a second session in the same stream -----------------
  ["e20", "dm_amma", "self", "2026-08-10T08:00:00Z", "insurance renewed for the year"],
  ["e21", "dm_amma", "amma", "2026-08-10T08:10:00Z", "good. come for lunch on sunday"],
];

export const EVENTS: readonly CorpusEvent[] = ROWS.map(([externalId, streamExtId, actorExtId, ts, text]) => ({
  externalId,
  streamExtId,
  actorExtId,
  ts,
  text,
}));

// ---------------------------------------------------------------------------
// Frozen extractions — the [LLM] answers, keyed by the event that carries them
// ---------------------------------------------------------------------------

/** `subject`/`owner`/`counterparty` name an actor extId; "self" is me. */
export interface FrozenClaim {
  /** The event this claim was extracted FROM. `stated_at` is its `ts`. */
  event: string;
  kind: "fact" | "preference";
  tag: "F" | "P";
  subject: string;
  predicate: string;
  text: string;
  confidence: number;
}

export interface FrozenLoop {
  event: string;
  streamExtId: string;
  owner: string;
  counterparty: string;
  intent: string;
  origin: "explicit" | "implicit";
  direction: "owe" | "owed";
  dueUtc?: string;
  recurrence?: string;
  /** The event whose existence resolves the loop (§11.4.5). */
  resolutionEvent?: string;
}

export interface FrozenEdge {
  event: string;
  kind: "has" | "located_at";
  subtype: string | null;
  /** The durable anchor the edge points at, found-or-minted by canonical name. */
  dst: { type: string; canonical: string };
  quote: string;
}

export const FROZEN_CLAIMS: readonly FrozenClaim[] = [
  // The residence pair carries DISTINCT predicates (the model's own words), so
  // the two land on different claim keys and their relationship is decided by
  // the frozen P-AG3 answer below — the adjudicated supersession path, which
  // is the one an ingest order can break.
  { event: "e01", kind: "fact", tag: "F", subject: "rahul", predicate: "lives in koramangala", text: "Lives in Koramangala.", confidence: 0.85 },
  { event: "e16", kind: "fact", tag: "F", subject: "rahul", predicate: "lives in indiranagar", text: "Lives in Indiranagar.", confidence: 0.85 },
  { event: "e05", kind: "preference", tag: "P", subject: "self", predicate: "prefers filter coffee", text: "Prefers filter coffee.", confidence: 0.8 },
  { event: "e14", kind: "preference", tag: "P", subject: "self", predicate: "prefers filter coffee", text: "Prefers filter coffee.", confidence: 0.8 },
  { event: "e11", kind: "fact", tag: "F", subject: "amma", predicate: "lives in jayanagar house", text: "Lives in the Jayanagar house.", confidence: 0.8 },
];

export const FROZEN_LOOPS: readonly FrozenLoop[] = [
  {
    event: "e13",
    streamExtId: "dm_rahul",
    owner: "self",
    counterparty: "rahul",
    intent: "send the rent receipt",
    origin: "explicit",
    direction: "owe",
    dueUtc: "2026-08-20T00:00:00Z",
  },
  {
    event: "e08",
    streamExtId: "dm_priya",
    owner: "self",
    counterparty: "priya",
    intent: "return priya's book",
    origin: "explicit",
    direction: "owe",
    resolutionEvent: "e18",
  },
  {
    event: "e10",
    streamExtId: "dm_amma",
    owner: "self",
    counterparty: "amma",
    intent: "renew the car insurance",
    origin: "explicit",
    direction: "owe",
    dueUtc: "2026-07-31T00:00:00Z",
    recurrence: "yearly",
  },
];

/**
 * The CALIBRATED similarity the [ML] rung "measured" for a candidate pair,
 * keyed by the two claim texts in either order. Frozen per content — the same
 * pair scores the same however it arrives, exactly as a real embedder does.
 */
export const FROZEN_SIMILARITY: readonly { pair: [string, string]; similarity: number }[] = [
  { pair: ["Lives in Koramangala.", "Lives in Indiranagar."], similarity: 0.9 },
];

/**
 * The frozen P-AG3 answer per adjudicated pair, keyed by the two texts in
 * either order. `later` is `-` on purpose: the model's `later` is advice, and
 * precedence must come from `stated_at` alone (§12.7) — which is the very
 * invariant the confluence run measures.
 */
export const FROZEN_AG3: readonly { pair: [string, string]; response: string }[] = [
  {
    pair: ["Lives in Koramangala.", "Lives in Indiranagar."],
    response: "V|A|B|ctr|-|2026-08-05T19:00:00Z|0.9|the residence changed between the two statements",
  },
];

function pairKeyOf(a: string, b: string): string {
  return [a, b].sort().join(" || ");
}

/** Similarity for a stored/incoming text pair, or null when never measured. */
export function frozenSimilarity(a: string, b: string): number | null {
  const key = pairKeyOf(a, b);
  const hit = FROZEN_SIMILARITY.find((s) => pairKeyOf(s.pair[0], s.pair[1]) === key);
  return hit === undefined ? null : hit.similarity;
}

/** The frozen adjudicator answer for a pair, or null when none was frozen. */
export function frozenAg3Response(a: string, b: string): string | null {
  const key = pairKeyOf(a, b);
  const hit = FROZEN_AG3.find((s) => pairKeyOf(s.pair[0], s.pair[1]) === key);
  return hit === undefined ? null : hit.response;
}

export const FROZEN_EDGES: readonly FrozenEdge[] = [
  {
    event: "e11",
    kind: "located_at",
    subtype: "current",
    dst: { type: "place", canonical: "Jayanagar house" },
    quote: "we are still in the Jayanagar house",
  },
];

// ---------------------------------------------------------------------------
// The three orders
// ---------------------------------------------------------------------------

function byTs(a: CorpusEvent, b: CorpusEvent): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.externalId < b.externalId ? -1 : 1;
}

/** Full backfill: oldest first. */
export function chronologicalOrder(): CorpusEvent[] {
  return [...EVENTS].sort(byTs);
}

/** Live-then-backfill: the newest event is seen first, history lands behind. */
export function reverseOrder(): CorpusEvent[] {
  return [...EVENTS].sort(byTs).reverse();
}

/**
 * Delayed-sync: `dm_priya`'s whole history syncs LAST; the other two streams
 * interleave strictly (one event each in turn), each internally chronological.
 * This is the "one chat synced a week late" shape §11.6 rule 6 names.
 */
export function delayedStreamOrder(): CorpusEvent[] {
  const of = (stream: string): CorpusEvent[] => EVENTS.filter((e) => e.streamExtId === stream).sort(byTs);
  const a = of("dm_rahul");
  const b = of("dm_amma");
  const interleaved: CorpusEvent[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    if (left !== undefined) interleaved.push(left);
    if (right !== undefined) interleaved.push(right);
  }
  return [...interleaved, ...of("dm_priya")];
}

export const ORDER_NAMES = ["chronological", "reverse", "delayed-stream"] as const;
export type OrderName = (typeof ORDER_NAMES)[number];

export function orderByName(name: OrderName): CorpusEvent[] {
  switch (name) {
    case "chronological":
      return chronologicalOrder();
    case "reverse":
      return reverseOrder();
    case "delayed-stream":
      return delayedStreamOrder();
  }
}

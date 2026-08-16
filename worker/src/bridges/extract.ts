// ===========================================================================
// [CODE] Bridge extractor — arch §11.2, build item 2.4.
//
// Rung ① of the arc binding ladder. A bridge is a shared literal (an order id,
// a URL, a Drive file) that ties two objects together at precision ~1.0, and it
// costs ZERO model calls: everything here is regex, arithmetic and set maths
// over text the ingest path already stored.
//
// WHICH KINDS RUN IS DATA, NOT A CONSTANT. The eight kinds exist in code, but
// which of them a run computes comes off the adapter manifests of the sources
// in that run (`bridge_keys`, arch §2.2) — WhatsApp declares
// `url phone email media_work_id order_id`, so a WhatsApp-only pass never so
// much as looks for a geohash. The live set is the UNION over the sources
// present, which is what makes the cross-source cases work: a Drive link
// pasted into a chat becomes a `file_id` bridge because DRIVE declares
// `file_id`, not because "whatsapp" was special-cased anywhere.
//
// Two firing styles:
//
//   * EXACT kinds (`url order_id file_id phone email media_work_id`) fire on
//     string equality of the normal form — group by `(kind, value_norm)`, emit
//     a bridge for every pair of distinct objects in the group.
//   * MEASURED kinds (`attendee_set`, `geo_time`) fire on a threshold —
//     Jaccard >= 0.6, and <=200 m AND <=45 min. They are pairwise by nature,
//     so they are computed pairwise.
//
// Rows are written BIDIRECTIONALLY (a→b and b→a). `bridges` is indexed on
// `(kind, value_norm)` and its unique key includes the ordered pair, so storing
// the mirror is what lets a reader ask "what does THIS object bridge to?" from
// either end without an OR-scan. Ids are content hashes, so a replay re-writes
// the same rows instead of duplicating them, and bridges never expire.
// ===========================================================================

import { createHash } from "node:crypto";

import { BRIDGE_KEYS, getManifest, type BridgeKey } from "../adapters/registry.js";
import { getDb } from "../db/connection.js";
import {
  ATTENDEE_JACCARD_MIN,
  geoTimeFires,
  geoTimeValue,
  intersection,
  jaccard,
  normaliseAttendeeSet,
  normaliseEmail,
  normaliseFileId,
  normaliseMediaWorkId,
  normaliseOrderId,
  normalisePhone,
  normaliseUrl,
  type PhoneOptions,
  type UrlNormaliseOptions,
} from "./normalise.js";

/** A shared literal is proof; everything else is an inference. */
export const CONFIDENCE_EXACT = 1;
/** Two things in the same place at the same time is strong, not certain. */
export const CONFIDENCE_GEO_TIME = 0.8;
/** Guard against one viral link turning into a quadratic pair explosion. */
export const MAX_PAIRS_PER_VALUE = 500;

/** Anything a bridge can be built from: an event, an episode, a session. */
export interface BridgeItem {
  id: string;
  /** The source that owns it — the manifest whose `bridge_keys` gate it. */
  source_id: string;
  /** `event` | `episode` | … — stored as `left_kind`/`right_kind`. */
  object_kind?: string;
  /** ISO-8601. Required for `geo_time`, ignored otherwise. */
  ts?: string | null;
  text?: string | null;
  /** Structured literals the adapter already parsed out. */
  urls?: readonly string[];
  emails?: readonly string[];
  phones?: readonly string[];
  order_ids?: readonly { vendor?: string | null; value: string }[];
  file_ids?: readonly { provider?: string | null; value: string }[];
  media_work_ids?: readonly string[];
  attendees?: readonly string[];
  geo?: { lat: number; lon: number } | null;
}

export interface BridgeCandidate {
  kind: BridgeKey;
  value_norm: string;
  item_id: string;
  object_kind: string;
}

/** One bridge, canonically ordered (`left_id <= right_id`). */
export interface BridgeEdge {
  /**
   * Content hash of `(kind, value_norm, left_id, right_id)` — see `bridgeId`.
   * Carried on the edge, not just on the stored row, so determinism is
   * observable before anything touches the db (a replay in a fresh process
   * produces the same ids).
   */
  id: string;
  kind: BridgeKey;
  value_norm: string;
  left_kind: string;
  left_id: string;
  right_kind: string;
  right_id: string;
  confidence: number;
  decided_by: string;
}

export interface ExtractOptions extends UrlNormaliseOptions, PhoneOptions {
  /** Force the live kind set, bypassing the manifests. Tests and backfills. */
  keys?: readonly BridgeKey[];
  maxPairsPerValue?: number;
}

// ---- the manifest gate -----------------------------------------------------

/**
 * The kinds this source declares (arch §2.2 `bridge_keys`), or null when the
 * source is not registered. Null means "no manifest to narrow by", NOT "none".
 */
export function bridgeKeysFor(sourceId: string): readonly BridgeKey[] | null {
  const manifest = getManifest(sourceId);
  return manifest ? manifest.bridge_keys : null;
}

/**
 * The kinds a run computes: the union of the declared keys of every source in
 * it. A source with no manifest contributes all eight — the core cannot know
 * what an unregistered source can yield, and guessing "nothing" would silently
 * drop real joins.
 */
export function liveBridgeKeys(
  items: readonly Pick<BridgeItem, "source_id">[],
  override?: readonly BridgeKey[],
): Set<BridgeKey> {
  if (override) return new Set(override);
  const live = new Set<BridgeKey>();
  for (const sourceId of new Set(items.map((i) => i.source_id))) {
    const declared = bridgeKeysFor(sourceId);
    for (const key of declared ?? BRIDGE_KEYS) live.add(key);
  }
  return live;
}

// ---- text scanning ---------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** `+91 98765 43210`, `9876543210`, `+1 (415) 555-0134`. */
const PHONE_RE = /(?<![\w+])(\+?\d[\d\s().-]{7,17}\d)(?![\w])/g;
/** Amazon's own shape, recognisable with no label at all. */
const AMAZON_ORDER_RE = /\b\d{3}-\d{7}-\d{7}\b/g;
const LABELLED_ORDER_RE =
  /\b(?:order|booking|reference|ref|pnr|trip|confirmation|invoice|awb)\s*(?:id|no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/gi;
const DRIVE_FILE_RE =
  /(?:drive|docs)\.google\.com\/(?:file\/d\/|document\/d\/|spreadsheets\/d\/|presentation\/d\/|open\?id=|uc\?id=)([A-Za-z0-9_-]{10,})/g;

/**
 * Vendor keywords, so an order id gets the right prefix. The nearest keyword to
 * the id wins; with none in sight the id is `generic:` and still bridges to
 * another `generic:` copy of the same string.
 */
const VENDOR_KEYWORDS: readonly [string, string][] = [
  ["makemytrip", "makemytrip"],
  ["make my trip", "makemytrip"],
  ["mmt", "makemytrip"],
  ["amazon", "amazon"],
  ["zomato", "zomato"],
  ["swiggy", "swiggy"],
  ["uber", "uber"],
  ["ola", "ola"],
  ["flipkart", "flipkart"],
  ["irctc", "irctc"],
  ["booking.com", "bookingcom"],
  ["airbnb", "airbnb"],
  ["indigo", "indigo"],
  ["bigbasket", "bigbasket"],
  ["blinkit", "blinkit"],
];

function vendorNear(text: string, at: number): string | null {
  const hay = text.toLowerCase();
  let best: { vendor: string; distance: number } | null = null;
  for (const [keyword, vendor] of VENDOR_KEYWORDS) {
    let from = 0;
    for (;;) {
      const found = hay.indexOf(keyword, from);
      if (found === -1) break;
      const distance = found <= at ? at - found : found - at;
      if (best === null || distance < best.distance || (distance === best.distance && vendor < best.vendor)) {
        best = { vendor, distance };
      }
      from = found + keyword.length;
    }
  }
  return best?.vendor ?? null;
}

function matchAll(re: RegExp, text: string): { value: string; index: number; group?: string }[] {
  const out: { value: string; index: number; group?: string }[] = [];
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(text);
    if (m === null) break;
    out.push({ value: m[0], index: m.index, group: m[1] });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// ---- candidates ------------------------------------------------------------

function push(
  out: BridgeCandidate[],
  seen: Set<string>,
  kind: BridgeKey,
  value: string | null,
  item: BridgeItem,
): void {
  if (value === null || value === "") return;
  const key = `${kind} ${value}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ kind, value_norm: value, item_id: item.id, object_kind: item.object_kind ?? "event" });
}

/**
 * Every normalised literal one object offers, restricted to `keys`.
 *
 * `attendee_set` and `geo_time` appear here too — as the object's own normal
 * form — but they do not fire on equality, so `extractBridges` re-reads the raw
 * values for those two.
 */
export function extractCandidates(
  item: BridgeItem,
  keys: ReadonlySet<BridgeKey>,
  opts?: ExtractOptions,
): BridgeCandidate[] {
  const out: BridgeCandidate[] = [];
  const seen = new Set<string>();
  const text = item.text ?? "";

  if (keys.has("url")) {
    for (const url of item.urls ?? []) push(out, seen, "url", normaliseUrl(url, opts), item);
    for (const m of matchAll(URL_RE, text)) push(out, seen, "url", normaliseUrl(m.value, opts), item);
  }

  if (keys.has("email")) {
    for (const email of item.emails ?? []) push(out, seen, "email", normaliseEmail(email), item);
    for (const m of matchAll(EMAIL_RE, text)) push(out, seen, "email", normaliseEmail(m.value), item);
  }

  if (keys.has("phone")) {
    for (const phone of item.phones ?? []) push(out, seen, "phone", normalisePhone(phone, opts), item);
    // Order ids are digit soup too, so the labelled ones are masked out first.
    const masked = text.replace(AMAZON_ORDER_RE, (m) => "#".repeat(m.length));
    for (const m of matchAll(PHONE_RE, masked)) {
      if ((m.value.match(/-/g) ?? []).length >= 2) continue; // 407-1234567-1234567
      push(out, seen, "phone", normalisePhone(m.value, opts), item);
    }
  }

  if (keys.has("order_id")) {
    for (const o of item.order_ids ?? []) push(out, seen, "order_id", normaliseOrderId(o.vendor, o.value), item);
    for (const m of matchAll(AMAZON_ORDER_RE, text)) {
      push(out, seen, "order_id", normaliseOrderId("amazon", m.value), item);
    }
    for (const m of matchAll(LABELLED_ORDER_RE, text)) {
      const id = m.group ?? "";
      // A reference always carries a digit. Without this, "booking reference"
      // hands the label itself back as the id.
      if (id === "" || !/\d/.test(id)) continue;
      push(out, seen, "order_id", normaliseOrderId(vendorNear(text, m.index), id), item);
    }
  }

  if (keys.has("file_id")) {
    for (const f of item.file_ids ?? []) push(out, seen, "file_id", normaliseFileId(f.provider, f.value), item);
    for (const m of matchAll(DRIVE_FILE_RE, text)) {
      push(out, seen, "file_id", normaliseFileId("gdrive", m.group ?? ""), item);
    }
    for (const url of item.urls ?? []) {
      for (const m of matchAll(DRIVE_FILE_RE, url)) {
        push(out, seen, "file_id", normaliseFileId("gdrive", m.group ?? ""), item);
      }
    }
  }

  if (keys.has("media_work_id")) {
    for (const id of item.media_work_ids ?? []) push(out, seen, "media_work_id", normaliseMediaWorkId(id), item);
  }

  if (keys.has("attendee_set") && (item.attendees ?? []).length > 0) {
    push(out, seen, "attendee_set", normaliseAttendeeSet(item.attendees ?? []), item);
  }

  if (keys.has("geo_time") && item.geo) {
    const ms = Date.parse(item.ts ?? "");
    if (Number.isFinite(ms)) push(out, seen, "geo_time", geoTimeValue(item.geo.lat, item.geo.lon, ms), item);
  }

  return out;
}

// ---- pairing ---------------------------------------------------------------

const EXACT_KINDS: readonly BridgeKey[] = ["url", "order_id", "file_id", "phone", "email", "media_work_id"];

function edge(
  kind: BridgeKey,
  valueNorm: string,
  a: { id: string; object_kind: string },
  b: { id: string; object_kind: string },
  confidence: number,
): BridgeEdge {
  const [left, right] = a.id <= b.id ? [a, b] : [b, a];
  return {
    id: bridgeId(kind, valueNorm, left!.id, right!.id),
    kind,
    value_norm: valueNorm,
    left_kind: left.object_kind,
    left_id: left.id,
    right_kind: right.object_kind,
    right_id: right.id,
    confidence,
    decided_by: `code:bridge/${kind}`,
  };
}

function sortEdges(edges: BridgeEdge[]): BridgeEdge[] {
  return edges.sort(
    (x, y) =>
      x.kind.localeCompare(y.kind) ||
      x.value_norm.localeCompare(y.value_norm) ||
      x.left_id.localeCompare(y.left_id) ||
      x.right_id.localeCompare(y.right_id),
  );
}

/** Every bridge among `items`. Deterministic, offline, zero model calls. */
export function extractBridges(items: readonly BridgeItem[], opts?: ExtractOptions): BridgeEdge[] {
  const keys = liveBridgeKeys(items, opts?.keys);
  const maxPairs = opts?.maxPairsPerValue ?? MAX_PAIRS_PER_VALUE;
  const edges: BridgeEdge[] = [];
  const emitted = new Set<string>();

  const emit = (e: BridgeEdge): void => {
    const key = `${e.kind} ${e.value_norm} ${e.left_id} ${e.right_id}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    edges.push(e);
  };

  // ---- exact kinds: group by normal form.
  const groups = new Map<string, { kind: BridgeKey; value: string; members: BridgeCandidate[] }>();
  for (const item of items) {
    for (const cand of extractCandidates(item, keys, opts)) {
      if (!EXACT_KINDS.includes(cand.kind)) continue;
      const key = `${cand.kind} ${cand.value_norm}`;
      const group = groups.get(key) ?? { kind: cand.kind, value: cand.value_norm, members: [] };
      if (!group.members.some((m) => m.item_id === cand.item_id)) group.members.push(cand);
      groups.set(key, group);
    }
  }
  for (const group of [...groups.values()].sort((a, b) => `${a.kind}${a.value}`.localeCompare(`${b.kind}${b.value}`))) {
    const members = [...group.members]
      .sort((a, b) => a.item_id.localeCompare(b.item_id))
      .map((m) => ({ id: m.item_id, object_kind: m.object_kind }));
    let pairs = 0;
    for (let i = 0; i < members.length && pairs < maxPairs; i++) {
      for (let j = i + 1; j < members.length && pairs < maxPairs; j++) {
        emit(edge(group.kind, group.value, members[i]!, members[j]!, CONFIDENCE_EXACT));
        pairs++;
      }
    }
  }

  // ---- measured kinds: pairwise, on the threshold.
  const wantAttendees = keys.has("attendee_set");
  const wantGeo = keys.has("geo_time");
  if (wantAttendees || wantGeo) {
    const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i]!;
        const b = ordered[j]!;
        if (a.id === b.id) continue;
        const aSide = { id: a.id, object_kind: a.object_kind ?? "event" };
        const bSide = { id: b.id, object_kind: b.object_kind ?? "event" };

        if (wantAttendees && (a.attendees ?? []).length > 0 && (b.attendees ?? []).length > 0) {
          const score = jaccard(a.attendees ?? [], b.attendees ?? []);
          if (score >= ATTENDEE_JACCARD_MIN) {
            const shared = normaliseAttendeeSet(intersection(a.attendees ?? [], b.attendees ?? []));
            if (shared !== null) {
              emit(edge("attendee_set", shared, aSide, bSide, Math.round(score * 1000) / 1000));
            }
          }
        }

        if (wantGeo && a.geo && b.geo) {
          const aMs = Date.parse(a.ts ?? "");
          const bMs = Date.parse(b.ts ?? "");
          if (
            Number.isFinite(aMs) &&
            Number.isFinite(bMs) &&
            geoTimeFires({ ...a.geo, tsMs: aMs }, { ...b.geo, tsMs: bMs })
          ) {
            const earlier = aMs <= bMs ? { geo: a.geo, ms: aMs } : { geo: b.geo, ms: bMs };
            const value = geoTimeValue(earlier.geo.lat, earlier.geo.lon, earlier.ms);
            if (value !== null) emit(edge("geo_time", value, aSide, bSide, CONFIDENCE_GEO_TIME));
          }
        }
      }
    }
  }

  return sortEdges(edges);
}

// ---- persistence -----------------------------------------------------------

export interface BridgeRow extends BridgeEdge {
  created_at: string;
}

/** Content-addressed, so a replay re-writes the same row instead of a new one. */
export function bridgeId(kind: string, valueNorm: string, leftId: string, rightId: string): string {
  const digest = createHash("sha1").update(`${kind} ${valueNorm} ${leftId} ${rightId}`).digest("hex");
  return `br_${digest.slice(0, 24)}`;
}

/**
 * Write bridges BOTH ways. Returns the number of rows inserted (0 on a replay
 * of an already-stored bridge — bridges never expire and are never rewritten).
 */
export function persistBridges(edges: readonly BridgeEdge[]): number {
  if (edges.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO bridges
       (id, kind, value_norm, left_kind, left_id, right_kind, right_id, confidence, decided_by)
     VALUES (@id, @kind, @value_norm, @left_kind, @left_id, @right_kind, @right_id, @confidence, @decided_by)`,
  );
  let written = 0;
  const insert = db.transaction((rows: readonly BridgeEdge[]) => {
    for (const e of rows) {
      for (const [left, right] of [
        [{ kind: e.left_kind, id: e.left_id }, { kind: e.right_kind, id: e.right_id }],
        [{ kind: e.right_kind, id: e.right_id }, { kind: e.left_kind, id: e.left_id }],
      ] as const) {
        const info = stmt.run({
          id: bridgeId(e.kind, e.value_norm, left.id, right.id),
          kind: e.kind,
          value_norm: e.value_norm,
          left_kind: left.kind,
          left_id: left.id,
          right_kind: right.kind,
          right_id: right.id,
          confidence: e.confidence,
          decided_by: e.decided_by,
        });
        written += info.changes;
      }
    }
  });
  insert(edges);
  return written;
}

function toRow(r: Record<string, unknown>): BridgeRow {
  return {
    id: String(r.id),
    kind: String(r.kind) as BridgeKey,
    value_norm: String(r.value_norm),
    left_kind: String(r.left_kind ?? ""),
    left_id: String(r.left_id),
    right_kind: String(r.right_kind ?? ""),
    right_id: String(r.right_id),
    confidence: Number(r.confidence ?? 0),
    decided_by: String(r.decided_by ?? ""),
    created_at: String(r.created_at ?? ""),
  };
}

/** What this object bridges to — the read the mirrored row exists for. */
export function bridgePartnersOf(objectId: string): BridgeRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM bridges WHERE left_id = ? ORDER BY kind, value_norm, right_id`)
    .all(objectId) as Record<string, unknown>[];
  return rows.map(toRow);
}

/** Everything sharing one literal — the `(kind, value_norm)` index path. */
export function bridgesByValue(kind: BridgeKey, valueNorm: string): BridgeRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM bridges WHERE kind = ? AND value_norm = ? ORDER BY left_id, right_id`)
    .all(kind, valueNorm) as Record<string, unknown>[];
  return rows.map(toRow);
}

/** Extract, store both directions, and hand back what was found. */
export function runBridgePass(items: readonly BridgeItem[], opts?: ExtractOptions): BridgeEdge[] {
  const edges = extractBridges(items, opts);
  persistBridges(edges);
  return edges;
}

// ===========================================================================
// [CODE] Bridge normalisation — arch §11.2 "Bridge extraction", build item 2.4.
//
// A bridge is a shared LITERAL that ties two objects together without a model
// call. That only works if both sides spell the literal the same way, so every
// bridge kind has exactly one normal form and it is computed here:
//
//   url           strip tracking params, resolve shortlinks, lowercase host
//   order_id      vendor-prefixed exact string
//   file_id       provider file id
//   attendee_set  sorted entity-id set (fires at Jaccard >= 0.6)
//   phone/email   normalised value
//   media_work_id entity id
//   geo_time      geohash6 + time bucket (fires at <=200 m AND <=45 min)
//
// Three rules shape this file:
//
//   1. **It is pure and offline.** "Resolve shortlinks" is a LOOKUP against
//      expansions somebody else already learned (the link enrichment cache, a
//      fixture), never a fetch. A bridge that needed the network would not be
//      deterministic, and replay would stop landing on the same rows.
//   2. **The normal form is a KEY, not a URL.** `value_norm` for a url drops
//      the scheme entirely, so the http and https spellings of one page are one
//      bridge. Nothing renders `value_norm` back to the user.
//   3. **A threshold is a named constant, once.** `attendee_set` and
//      `geo_time` fire on a measurement rather than on string equality, and the
//      three numbers that decide them (0.6, 200 m, 45 min) live here and are
//      read by `./extract.ts` — never retyped.
// ===========================================================================

import type { BridgeKey } from "../adapters/registry.js";

export type { BridgeKey };

// ---- thresholds (arch §11.2) ----------------------------------------------

/** `attendee_set` fires at Jaccard >= this. Below it, two rooms are two rooms. */
export const ATTENDEE_JACCARD_MIN = 0.6;
/** `geo_time` needs BOTH: within this many metres… */
export const GEO_MAX_METERS = 200;
/** …AND within this many milliseconds. */
export const GEO_MAX_MS = 45 * 60_000;
/** The time bucket the `geo_time` normal form is stamped with. */
export const GEO_BUCKET_MS = 45 * 60_000;

// ---- url -------------------------------------------------------------------

/**
 * Query params that carry campaign attribution rather than identity. Two links
 * differing only in these are the same page, which is the whole reason K-009..012
 * exist.
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "ttclid",
  "twclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "_branch_match_id",
  "_bta_c",
  "_bta_tid",
  "spm",
  "scm",
  "ref_src",
  "ref_url",
  "trk",
  "trk_contact",
  "si",
  "share_id",
  "shared_from",
  "campaign_id",
  "cmpid",
  "icid",
  "ncid",
  "sr_share",
  "wt_mc",
  // Netflix watch URLs: row/tracking context, never identity (T6-1, SRC-01).
  "trackid",
  "tctx",
]);

/** Param PREFIXES that are tracking families: `utm_*`, Matomo, Piwik, AT. */
export const TRACKING_PREFIXES: readonly string[] = ["utm_", "mtm_", "pk_", "piwik_", "at_", "hsa_", "vero_"];

/**
 * Hosts whose links are opaque redirects. A shortlink can only be resolved
 * from an expansion somebody already learned — see `UrlNormaliseOptions`.
 */
export const SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "goo.gl",
  "g.co",
  "amzn.to",
  "buff.ly",
  "ow.ly",
  "cutt.ly",
  "rebrand.ly",
  "lnkd.in",
  "fb.me",
  "wa.me",
  "rb.gy",
  "shorturl.at",
  "s.zoma.to",
  "mmt.link",
  "zmto.in",
  "youtu.be",
]);

/** Mobile/AMP aliases that are the same site under another name. */
const HOST_ALIASES: ReadonlyMap<string, string> = new Map([
  ["m.youtube.com", "youtube.com"],
  ["music.youtube.com", "youtube.com"],
  ["mobile.twitter.com", "twitter.com"],
  ["m.facebook.com", "facebook.com"],
  ["mobile.facebook.com", "facebook.com"],
  ["m.imdb.com", "imdb.com"],
]);

export interface UrlNormaliseOptions {
  /**
   * Known shortlink expansions. A map keyed by the shortlink (normalised the
   * same way) or a function. Returning null/undefined means "not known yet" —
   * the shortlink then normalises to itself, so two copies of the SAME
   * shortlink still bridge, and neither invents a target.
   */
  expansions?: ReadonlyMap<string, string> | ((url: string) => string | null | undefined);
  /** Hop limit while chasing expansions. */
  maxHops?: number;
}

function lookupExpansion(url: string, opts: UrlNormaliseOptions | undefined): string | null {
  const table = opts?.expansions;
  if (!table) return null;
  const hit = typeof table === "function" ? table(url) : table.get(url);
  return typeof hit === "string" && hit.trim() !== "" ? hit : null;
}

function stripDefaultPort(protocol: string, port: string): string {
  if (port === "") return "";
  if (protocol === "https:" && port === "443") return "";
  if (protocol === "http:" && port === "80") return "";
  return `:${port}`;
}

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  if (TRACKING_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((p) => key.startsWith(p));
}

function canonicalHost(hostname: string): string {
  let host = hostname.toLowerCase().replace(/\.+$/, "");
  const alias = HOST_ALIASES.get(host);
  if (alias) host = alias;
  if (host.startsWith("www.") && host.length > 4) host = host.slice(4);
  return host;
}

function canonicalPath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed === "/" || collapsed === "") return "";
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/** `youtu.be/<id>` is a shortener with a KNOWN expansion — no network needed. */
function youtuBe(u: URL): string | null {
  const id = u.pathname.replace(/^\//, "").split("/")[0] ?? "";
  if (id === "") return null;
  const t = u.searchParams.get("t");
  return `https://youtube.com/watch?v=${id}${t ? `&t=${t}` : ""}`;
}

/**
 * The `url` normal form: `host/path?sorted-query#route`, no scheme.
 *
 * Returns null for anything that is not an http(s) URL — a bridge is only ever
 * built from a literal we can be sure of.
 */
export function normaliseUrl(raw: string, opts?: UrlNormaliseOptions): string | null {
  const hops = opts?.maxHops ?? 3;
  let candidate = (raw ?? "").trim();
  if (candidate === "") return null;
  // Trailing sentence punctuation a human typed around the link.
  candidate = candidate.replace(/[),.;:!?'"\]]+$/, "");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;

  for (let hop = 0; hop <= hops; hop++) {
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;

    const host = canonicalHost(u.hostname);
    if (host === "") return null;

    if (host === "youtube.com" && u.pathname === "/watch") {
      // Keep only the video id (and a start offset) — everything else on a
      // YouTube watch URL is session noise.
      const v = u.searchParams.get("v");
      if (v) {
        const t = u.searchParams.get("t");
        return `youtube.com/watch?v=${v}${t ? `&t=${t}` : ""}`;
      }
    }

    if (hop < hops && SHORTENER_HOSTS.has(host)) {
      const expanded = host === "youtu.be" ? youtuBe(u) : lookupExpansion(candidate, opts) ?? lookupExpansion(`${host}${canonicalPath(u.pathname)}`, opts);
      if (expanded !== null && expanded !== candidate) {
        candidate = expanded;
        continue;
      }
    }

    const port = stripDefaultPort(u.protocol, u.port);
    const path = canonicalPath(u.pathname);

    const kept: [string, string][] = [];
    for (const [key, value] of u.searchParams.entries()) {
      if (isTrackingParam(key)) continue;
      kept.push([key, value]);
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const query = kept.length === 0 ? "" : `?${kept.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join("&")}`;

    // A hashbang or path-shaped fragment is a route (it selects the page);
    // anything else is an anchor inside one page and is dropped.
    const frag = u.hash.replace(/^#/, "");
    const hash = frag.startsWith("!") || frag.startsWith("/") ? `#${frag}` : "";

    return `${host}${port}${path}${query}${hash}`;
  }
  return null;
}

// ---- url TEXT form (V6 P1 S1.4; backlog T6-1, T6-2, T6-23; SRC-01) ---------
//
// `normaliseUrl` above produces a bridge KEY — no scheme, host aliased, YouTube
// reduced to its id. The browser watcher needs something different for
// `events.text`: a URL a human and the model can still read, with the tracking
// junk gone. Measured on the real log (T6-1): query strings were 62.5% of URL
// bytes, 69.4% of that tracking, 33.1% of ALL `events.text` bytes — and the
// retrieval query builder promoted base64 tracking tokens as "salient" (T6-2).
//
// Order, per T6-1: per-domain content allowlist first (the page's identity IS
// its params — youtube `v`, google `q`, the local editor's `path`) → prefix
// denylist → name denylist → drop non-route fragments → 200-char cap → sort
// survivors. Denylist, not allowlist: an allowlist fails closed and a memory
// system cannot re-derive what it discarded. The function FAILS OPEN — any
// parse trouble returns the raw string, because dropping a URL is worse than
// carrying its junk.
//
// This touches the `text` field ONLY. `payload.url` stays byte-identical to
// the visit (SRC-02); nothing here is ever written back to a payload.

/** Longest URL the text field carries; the tail past this is session noise. */
export const URL_TEXT_MAX_CHARS = 200;

/**
 * Per-domain content allowlists (T6-1 "per-domain override first"). When a
 * rule matches, ONLY the listed params survive — everything else on that page
 * is session state. Rules are checked in order; the first hit wins.
 */
export interface ContentParamRule {
  /** Human label for the report / tests. */
  name: string;
  /** Match on (lowercased host, path, port). */
  match: (host: string, path: string, port: string) => boolean;
  /** Params that are the page's identity — matched case-sensitively as spelled. */
  keep: ReadonlySet<string>;
}

const hostIs = (host: string, ...domains: string[]): boolean =>
  domains.some((d) => host === d || host.endsWith(`.${d}`));

/** `google.com`, `google.co.in`, `google.de`, … — the search host family. */
const isGoogleHost = (host: string): boolean => /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);

/** `amazon.in`, `amazon.com`, `amazon.co.uk`, … */
const isAmazonHost = (host: string): boolean => /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);

export const CONTENT_PARAM_RULES: readonly ContentParamRule[] = [
  {
    name: "youtube/watch",
    match: (host, path) => hostIs(host, "youtube.com") && path === "/watch",
    keep: new Set(["v", "t", "list"]),
  },
  {
    name: "google/search",
    match: (host, path) => isGoogleHost(host) && path === "/search",
    keep: new Set(["q", "udm", "tbm"]),
  },
  {
    name: "hotstar",
    match: (host) => hostIs(host, "hotstar.com"),
    keep: new Set(["search_query", "seasonId", "episodeNumber"]),
  },
  {
    // T6-23: the local writing editor keys documents by `?path=` — stripping
    // it would destroy the identity the writing lens depends on. Whitelisted
    // on every `*.localhost:7373` host.
    name: "localhost:7373/path",
    match: (host, _path, port) => (host === "localhost" || host.endsWith(".localhost")) && port === "7373",
    keep: new Set(["path"]),
  },
  {
    name: "amazon",
    match: (host) => isAmazonHost(host),
    keep: new Set(["k", "node"]),
  },
];

/** The rule that governs this URL's params, or null for the generic denylist. */
export function contentParamRuleFor(host: string, path: string, port: string): ContentParamRule | null {
  const h = host.toLowerCase();
  for (const rule of CONTENT_PARAM_RULES) if (rule.match(h, path, port)) return rule;
  return null;
}

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/**
 * The `text`-field form of a URL: readable, tracking-free, capped, survivors
 * sorted. Fails open (returns the trimmed input) on anything it cannot parse.
 *
 * Query pairs are kept in their ORIGINAL spelling (no re-encoding — `%2F`
 * stays `%2F`, `+` stays `+`) so the text still reads like the address bar;
 * only the SET of survivors and their order change.
 */
export function urlTextForm(raw: string, opts?: { maxChars?: number }): string {
  const input = (raw ?? "").trim();
  if (input === "") return "";
  const cap = opts?.maxChars ?? URL_TEXT_MAX_CHARS;
  try {
    const u = new URL(input);
    if (u.protocol !== "http:" && u.protocol !== "https:") return input.slice(0, cap);
    const host = u.hostname.toLowerCase();
    const rule = contentParamRuleFor(host, u.pathname, u.port);

    // Split the raw query ourselves so survivors keep their bytes.
    const rawQuery = u.search.startsWith("?") ? u.search.slice(1) : u.search;
    const pairs = rawQuery === "" ? [] : rawQuery.split("&").filter((p) => p !== "");
    const kept: { key: string; raw: string }[] = [];
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      const key = decodeKey(eq === -1 ? pair : pair.slice(0, eq));
      if (key === "") continue;
      const keep = rule ? rule.keep.has(key) : !isTrackingParam(key);
      if (keep) kept.push({ key, raw: pair });
    }
    kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
    const query = kept.length === 0 ? "" : `?${kept.map((k) => k.raw).join("&")}`;

    // A hashbang or path-shaped fragment routes; anything else is an in-page anchor.
    const frag = u.hash.replace(/^#/, "");
    const hash = frag.startsWith("!") || frag.startsWith("/") ? `#${frag}` : "";

    const port = u.port === "" ? "" : `:${u.port}`;
    const out = `${u.protocol}//${host}${port}${u.pathname}${query}${hash}`;
    return out.length > cap ? out.slice(0, cap) : out;
  } catch {
    return input.slice(0, cap);
  }
}

/** Query param names that survived — what SRC-01 asserts on. */
export function urlTextParams(raw: string): string[] {
  try {
    const u = new URL(urlTextForm(raw));
    return [...u.searchParams.keys()];
  } catch {
    return [];
  }
}

// ---- email / phone ---------------------------------------------------------

/** Providers where `a.b+tag@` and `ab@` are one mailbox. */
const DOT_INSENSITIVE_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);
const PLUS_TAG_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
]);

export function normaliseEmail(raw: string): string | null {
  const trimmed = (raw ?? "").trim().replace(/^mailto:/i, "").replace(/[.,;:!?'"<>()\]]+$/, "");
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  let local = trimmed.slice(0, at).toLowerCase();
  let domain = trimmed.slice(at + 1).toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9._%+'-]+$/.test(local)) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (PLUS_TAG_DOMAINS.has(domain)) local = local.split("+")[0] ?? local;
  if (DOT_INSENSITIVE_DOMAINS.has(domain)) local = local.replace(/\./g, "");
  if (local === "") return null;
  return `${local}@${domain}`;
}

export interface PhoneOptions {
  /** Country code assumed for a bare national number. India by default. */
  defaultCountry?: string;
}

/**
 * E.164, or null. A 10-digit bare number is only accepted with a default
 * country code, because a bridge on the wrong country is a bridge to a
 * stranger.
 */
export function normalisePhone(raw: string, opts?: PhoneOptions): string | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  const international = text.startsWith("+") || text.startsWith("00");
  const digits = text.replace(/\D/g, "");
  if (digits === "") return null;

  if (international) {
    const body = text.startsWith("00") ? digits.replace(/^00/, "") : digits;
    if (body.length < 8 || body.length > 15) return null;
    return `+${body}`;
  }
  const cc = opts?.defaultCountry ?? "91";
  const national = digits.replace(/^0+/, "");
  if (national.length === 10) return `+${cc}${national}`;
  // A number that already carries its country code, typed without the plus.
  if (national.length > 10 && national.length <= 15 && national.startsWith(cc)) return `+${national}`;
  return null;
}

// ---- opaque ids ------------------------------------------------------------

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * `vendor:ORDERID`. The id keeps its own spelling (upper-cased, spaces gone)
 * because an order reference is an exact string the vendor owns; only the
 * vendor half is slugged so "Make My Trip" and "makemytrip" are one vendor.
 */
export function normaliseOrderId(vendor: string | null | undefined, id: string): string | null {
  const value = (id ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (value.length < 4) return null;
  const v = slug(vendor ?? "");
  return `${v === "" ? "generic" : v}:${value}`;
}

/** `provider:fileid`. The provider id is opaque and keeps its case. */
export function normaliseFileId(provider: string | null | undefined, id: string): string | null {
  const value = (id ?? "").trim();
  if (value.length < 6) return null;
  const p = slug(provider ?? "");
  return `${p === "" ? "generic" : p}:${value}`;
}

/** A media_work bridge is an ENTITY id — already canonical, only trimmed. */
export function normaliseMediaWorkId(id: string): string | null {
  const value = (id ?? "").trim();
  return value === "" ? null : value;
}

// ---- sets ------------------------------------------------------------------

/** The `attendee_set` normal form: sorted, de-duplicated entity ids. */
export function normaliseAttendeeSet(ids: readonly string[]): string | null {
  const clean = [...new Set(ids.map((i) => (i ?? "").trim()).filter((i) => i !== ""))].sort();
  return clean.length === 0 ? null : clean.join("+");
}

/** |A ∩ B| / |A ∪ B|. Two empty sets share nothing, so they score 0. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function intersection(a: readonly string[], b: readonly string[]): string[] {
  const right = new Set(b);
  return [...new Set(a)].filter((i) => right.has(i)).sort();
}

// ---- geo -------------------------------------------------------------------

const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Standard geohash, 6 characters (~1.2 km × 0.6 km).
 *
 * The cell is the KEY, never the test: two points 150 m apart can straddle a
 * cell boundary, which is why `geoTimeFires` measures real metres and the
 * geohash only names the bridge.
 */
export function geohash(lat: number, lon: number, precision = 6): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  let latRange: [number, number] = [-90, 90];
  let lonRange: [number, number] = [-180, 180];
  let isLon = true;
  let bit = 0;
  let ch = 0;
  let out = "";
  while (out.length < precision) {
    if (isLon) {
      const mid = (lonRange[0] + lonRange[1]) / 2;
      if (lon >= mid) {
        ch = (ch << 1) + 1;
        lonRange = [mid, lonRange[1]];
      } else {
        ch = ch << 1;
        lonRange = [lonRange[0], mid];
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat >= mid) {
        ch = (ch << 1) + 1;
        latRange = [mid, latRange[1]];
      } else {
        ch = ch << 1;
        latRange = [latRange[0], mid];
      }
    }
    isLon = !isLon;
    if (++bit === 5) {
      out += GEOHASH_ALPHABET[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `geohash6@<45-minute bucket>` — the normal form, stamped on the EARLIER point. */
export function geoTimeValue(lat: number, lon: number, tsMs: number): string | null {
  const cell = geohash(lat, lon);
  if (cell === "" || !Number.isFinite(tsMs)) return null;
  return `${cell}@${Math.floor(tsMs / GEO_BUCKET_MS)}`;
}

/** §11.2: within 200 m **and** 45 min. Both, never either. */
export function geoTimeFires(
  a: { lat: number; lon: number; tsMs: number },
  b: { lat: number; lon: number; tsMs: number },
): boolean {
  if (!Number.isFinite(a.tsMs) || !Number.isFinite(b.tsMs)) return false;
  if (Math.abs(a.tsMs - b.tsMs) > GEO_MAX_MS) return false;
  return haversineMeters(a, b) <= GEO_MAX_METERS;
}

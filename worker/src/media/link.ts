// ===========================================================================
// Fetching what is behind a link (v3 §3, v6 §4, v7 §4).
//
// No model is involved: HTML → readable text is deterministic, and a summary is
// out of scope. What is very much in scope is that the URL arrived inside a
// message, so it is attacker-controlled input. Two consequences shape this file:
//
//   - The address guard runs at CONNECT time, not before it. Resolving the host
//     ourselves and then handing the hostname to the socket would let a DNS
//     rebinding answer the second lookup differently; instead the request's own
//     `lookup` resolves once, drops every private/loopback/link-local/reserved
//     address, and the socket connects to what is left. Every redirect hop goes
//     through the same gate.
//   - Fetching tells whoever sent the link that this machine opened it, which is
//     why the switch is off by default.
//
// What is worth reading is the other half. A page ships its content twice: once
// as og:/JSON-LD metadata a few hundred bytes wide, and once as the several
// hundred kilobytes of JavaScript that render it. YouTube puts its og:title
// 683 KB into a 1.5 MB document, behind its player configuration, and the body
// text underneath is a consent footer. So the read is sized to reach the end of
// <head> rather than to a fixed offset, metadata is preferred over body text,
// and body text is taken from <main>/<article> when the page marks it.
//
// Nothing that is not prose is stored as prose. A body cut at a byte budget
// ends mid-<script>, and a terminator that only matched a closing tag let the
// orphan JavaScript through as "the page" — every link row in the database
// recorded that as success. Terminators are anchored to end-of-input, and a
// final gate refuses anything that still reads as code.
//
// A failure is recorded with its reason. Nothing is ever synthesised: a page we
// could not read stores no text at all.
// ===========================================================================

import {
  lookup as dnsLookup,
  type LookupAddress,
  type LookupAllOptions,
} from "node:dns";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import type { LinkScrapeStatus, MediaFrame } from "../db/ingest.js";
import { readLinkVideo, type LinkVideoBounds } from "./linkvideo.js";
import { resolveYtDlpBin, run } from "./tools.js";

/** No browser string: this is not a browser, and pretending otherwise is a lie. */
const USER_AGENT = "SuperTwinV13/1.0 (+link preview; no cookies)";

/** Whole fetch, redirects included. A page that is slower than this is not worth it. */
const SCRAPE_TIMEOUT_MS = 15_000;

/**
 * How far the read will go looking for the end of <head>. The metadata block is
 * the only part of a video or social page worth having, and YouTube's sits at
 * 683 KB — a smaller budget severs it and leaves nothing but scripts.
 */
const MAX_HEAD_BYTES = 1024 * 1024;

/**
 * Read this much past the head for body prose. An article fits; YouTube's
 * remaining 600 KB of player state does not get pulled down for a footer.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** Decompressed bytes the read will ever take, whatever the page claims. */
const MAX_BYTES = MAX_HEAD_BYTES + MAX_BODY_BYTES;

/**
 * Wire bytes per decompressed byte before the connection is cut, so a stream
 * that inflates to almost nothing cannot be fed to us indefinitely.
 */
const MAX_WIRE_RATIO = 8;

const MAX_REDIRECTS = 3;

/**
 * Stored page text. Same ceiling as a media description so one long article
 * cannot outweigh a whole conversation in the FTS index.
 */
export const MAX_SCRAPED_CHARS = 2000;

/** Markup we can turn into text. Anything else is a file, not a page. */
const READABLE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

/** The outcome of one scrape, as `recordLinkScrape` wants it. */
export interface LinkScrapeResult {
  status: LinkScrapeStatus;
  scrapedText: string | null;
  /** The page's own title; only fills a preview that arrived without one. */
  title: string | null;
  error: string | null;
  /**
   * Stills taken off the video the page was for (v7 §4). Recorded separately
   * from the text, because `media_frames_json` is the only thing keeping those
   * files on disk.
   */
  frames?: MediaFrame[];
}

export interface ScrapeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Decompressed bytes the read may take, across head and body together. */
  maxBytes?: number;
  maxRedirects?: number;
  /**
   * What may be done with the video behind a video link (v7 §4). Absent means
   * the page and its caption track and nothing else — no download, no stills.
   */
  video?: LinkVideoBounds;
  /**
   * Which resolved addresses the request refuses to connect to. Production
   * leaves this alone; it exists so the fetch path can be exercised against a
   * loopback test server without the guard being switched off anywhere else.
   */
  blocked?: (address: string) => boolean;
}

// ---- Address guard ---------------------------------------------------------

/** IPv4 blocks that are not somebody else's public web server. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const b = Number(part);
    if (b > 255) return null;
    n = n * 256 + b;
  }
  return n >>> 0;
}

function blockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true;
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === ((v4ToInt(base) as number) & mask) >>> 0;
  });
}

/** Expand an IPv6 literal to its eight 16-bit groups; null if it is not one. */
function v6Groups(ip: string): number[] | null {
  const bare = ip.split("%")[0];
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (part.includes(".")) {
        const n = v4ToInt(part);
        if (n === null) return null;
        out.push(n >>> 16, n & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function blockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const [a, b] = g;
  // ::ffff:0:0/96 and 64:ff9b::/96 carry an IPv4 address in the low 32 bits, so
  // 10.0.0.1 can be written as ::ffff:10.0.0.1 — the guard has to see through
  // the wrapper to the address that will actually be dialled.
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const nat64 =
    a === 0x0064 && b === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (mapped || nat64) {
    return blockedV4(
      `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`,
    );
  }
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 documentation
  if (a === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64
  return false;
}

/** True for anything that is not a routable address on the public internet. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blockedV4(ip);
  if (family === 6) return blockedV6(ip);
  // Not an address at all — refuse rather than hand it to the socket.
  return true;
}

/** Refused before anything left the machine — retrying cannot change it. */
class Refused extends Error {}

/**
 * The resolver the request itself uses. Resolving here rather than beforehand is
 * the point: the socket connects to an address this function already vetted, so
 * a second DNS answer never gets a say.
 *
 * It is not the whole guard, though: Node skips `lookup` when the host is
 * already an IP literal, so `http://10.0.0.1/` would never reach this function.
 * fetchOnce checks literals itself.
 */
function guardedLookup(blocked: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    const query: LookupAllOptions = { ...options, all: true };
    dnsLookup(hostname, query, (err, addresses: LookupAddress[]) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const allowed = addresses.filter((a) => !blocked(a.address));
      if (allowed.length === 0) {
        callback(
          new Refused(`${hostname} resolves only to non-public addresses`),
          "",
          0,
        );
        return;
      }
      if ((options as { all?: boolean }).all) {
        callback(null, allowed);
        return;
      }
      callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

// ---- HTML → text -----------------------------------------------------------

/**
 * Not the whole HTML5 table — the ones real pages put in a title, a byline or
 * an og:description. An entity that is not here is left as it was written,
 * which reads as a mistake but is at least not a wrong character.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** One line of text, or null when there was nothing in it. */
function normalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = decodeEntities(value).replace(/\s+/g, " ").trim();
  return s.length ? s : null;
}

function capText(s: string): string {
  if (s.length <= MAX_SCRAPED_CHARS) return s;
  return `${s.slice(0, MAX_SCRAPED_CHARS - 1).trimEnd()}…`;
}

/**
 * Element bodies that are not prose: code, and the title, which is read
 * separately and would otherwise be indexed twice. Both terminators are
 * optional — a body cut at the byte budget ends mid-script, and a pattern that
 * insisted on the closing tag simply did not match, leaving the JavaScript to
 * be read as the page's text.
 */
const CODE_BLOCKS =
  /<(script|style|noscript|template|svg|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Elements that are how a page is got around rather than what it says. They sit
 * inside the content region often enough to matter: Wikipedia's ninety language
 * names are inside its own <main>, and they are the first two thousand
 * characters of every article if nothing takes them out.
 */
const CHROME_BLOCKS =
  /<(nav|header|footer|aside|form|select|button|dialog)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

function stripCode(html: string): string {
  return html.replace(COMMENTS, " ").replace(CODE_BLOCKS, " ");
}

/**
 * The part of a page that is the page. <main>/<article> when the document says
 * so, the body otherwise, and never the head — its metadata is read directly
 * and the rest of it is scripts. Terminators are optional again, so a truncated
 * document still gives up the region it opened.
 *
 * `marked` says which of the two it was, because they are worth different
 * things: a marked region is the content, while an unmarked body is whatever
 * the page renders around it — on YouTube, the cookie-and-copyright footer.
 */
function contentRegion(html: string): { html: string; marked: boolean } {
  const without = (
    region: string,
    marked: boolean,
  ): { html: string; marked: boolean } => ({
    html: region.replace(CHROME_BLOCKS, " "),
    marked,
  });
  for (const tag of ["main", "article"]) {
    const found = new RegExp(
      `<${tag}\\b[^>]*>([\\s\\S]*?)(?:</${tag}\\s*>|$)`,
      "i",
    ).exec(html);
    if (found && found[1].trim()) return without(found[1], true);
  }
  const body = /<body\b[^>]*>([\s\S]*)$/i.exec(html);
  if (body) return without(body[1], false);
  return without(html.replace(/<head\b[\s\S]*?(?:<\/head\s*>|$)/i, " "), false);
}

/** Markup to text: block-level tags become line breaks, everything else goes. */
function toText(html: string): string {
  const text = html
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer)\s*>/gi, "\n")
    // The second alternative is the tag the byte budget cut in half.
    .replace(/<[^>]+>|<[^>]*$/g, " ");
  return decodeEntities(text)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The page's own <title>, or null when it has none. */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? normalize(m[1]) : null;
}

/** Every <meta> the page declares, keyed by property or name, first one wins. */
function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of tag[1].matchAll(
      /([a-z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
    )) {
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const content = normalize(attrs.get("content"));
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}

interface VideoObject {
  name: string | null;
  description: string | null;
}

/** Depth-bounded walk for the VideoObject a video page describes itself with. */
function findVideoObject(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findVideoObject(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  if (type === "VideoObject" || (Array.isArray(type) && type.includes("VideoObject"))) {
    return record;
  }
  for (const key of ["@graph", "video", "mainEntity", "itemListElement"]) {
    const hit = findVideoObject(record[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * The JSON-LD VideoObject, when the page ships one. Read from the raw HTML,
 * before scripts are stripped, and only when its closing tag arrived: a block
 * the byte budget cut in half is not JSON and is not guessed at.
 */
function jsonLdVideo(html: string): VideoObject | null {
  for (const block of html.matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(block[1]);
    } catch {
      continue;
    }
    const node = findVideoObject(data);
    if (node) {
      return { name: normalize(node.name), description: normalize(node.description) };
    }
  }
  return null;
}

/**
 * Readable text, deterministically. Script/style/template content is dropped
 * (it is code, not prose), the page's own content region is preferred over its
 * chrome, block-level tags become line breaks so sentences do not run together,
 * and the result is capped.
 */
export function htmlToText(html: string): string {
  return capText(toText(contentRegion(stripCode(html)).html));
}

export interface PageContent {
  /** og:title, then twitter:title, then the JSON-LD name, then <title>. */
  title: string | null;
  /**
   * Prose candidates, best first. The title is deliberately absent: it is
   * stored and indexed in its own column, and repeating it here would weight
   * one page's name twice in every search.
   */
  parts: (string | null)[];
}

/** What a page says it is, preferred over what its body happens to render. */
export function readPage(html: string): PageContent {
  const video = jsonLdVideo(html);
  const stripped = stripCode(html);
  const meta = metaTags(stripped);
  const described =
    meta.get("og:description") ??
    meta.get("twitter:description") ??
    meta.get("description") ??
    video?.description ??
    null;
  const region = contentRegion(stripped);
  // On a page whose content is a video, unmarked body text is the site around
  // the player: "About Press Copyright Contact us Creators" is what YouTube
  // renders as prose, and it is how a lecture came to be stored as that.
  const isVideo = meta.get("og:type")?.startsWith("video") || video !== null;
  return {
    title:
      meta.get("og:title") ??
      meta.get("twitter:title") ??
      video?.name ??
      extractTitle(html),
    parts: [described, region.marked || !isVideo ? toText(region.html) : null],
  };
}

/**
 * Fingerprints of a page that handed over its configuration instead of its
 * content. Every link row written before this check claimed success.
 */
const CODE_MARKERS = [/\bytcfg\b/, /\{"require":\[\[/, /\bytInitialData\b/];

/** Structure and escapes: a sentence has almost none, JSON is made of them. */
const BRACES = /[{}[\]\\]/g;
const QUOTES = /["“”]/g;

/**
 * Prose, or something that only looks like it from a distance. Each density is
 * given a floor as well as a ratio: a ratio alone convicts a short sentence
 * with a quoted word in it, and lets a seven-character JSON object through.
 */
export function looksLikeProse(text: string): boolean {
  const t = text.trim();
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return false;
  if (CODE_MARKERS.some((marker) => marker.test(t))) return false;
  if ((t.match(BRACES)?.length ?? 0) > Math.max(2, t.length * 0.01)) return false;
  if ((t.match(QUOTES)?.length ?? 0) > Math.max(4, t.length * 0.05)) return false;
  // Word shape only says anything once there is enough text to have a shape.
  return t.length < 200 || (t.match(/\s/g)?.length ?? 0) / t.length > 0.05;
}

/**
 * One block of stored text out of the candidates, best first. Anything that is
 * not prose is thrown away rather than stored as though it were, and `dropped`
 * says whether that happened — a page whose every candidate was code is a
 * failure, not an empty page.
 */
export function assemble(parts: readonly (string | null)[]): {
  text: string;
  dropped: boolean;
} {
  const kept: string[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const part of parts) {
    const t = part?.trim();
    if (!t) continue;
    // Judged whole: half a JSON blob is not rescued by one prose-shaped line.
    if (!looksLikeProse(t)) {
      dropped = true;
      continue;
    }
    // og:description and the opening paragraph are routinely the same sentence.
    for (const line of t.split("\n")) {
      const l = line.trim();
      if (!l || seen.has(l)) continue;
      seen.add(l);
      kept.push(l);
    }
  }
  return { text: capText(kept.join("\n")), dropped };
}

// ---- Video links -----------------------------------------------------------
//
// yt-dlp is bundled (v6 §4) for what a page cannot tell us: what is said and
// what is shown in the video it is a page for. YouTube publishes a caption
// track; Instagram publishes none, but v7 §4 measured a public reel downloading
// in 0.3s with no cookies at all, so both are now routed through it.
//
// It makes its own requests, so the address guard cannot cover them. What
// covers them instead is that nothing of the sender's string reaches it: the
// host must be one of the two sites' exactly, the id must have the shape that
// site's ids have, and the URL handed over is rebuilt from that id.
//
// The order the transcript is looked for in is v7 §4's, and it is not the cheap
// order: creator-uploaded captions first because a person wrote them, then
// local whisper over the downloaded file, and YouTube's own auto-captions only
// when both of those came back empty. Whisper is stronger on Hindi and Hinglish
// than YouTube's ASR, and by then the file is already here.

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);

/** The three shapes Instagram gives a video its own page under. */
const INSTAGRAM_KINDS = new Set(["reel", "reels", "p", "tv"]);

/** Preference order for a track: these chats are English, Hindi and Marathi. */
const CAPTION_LANGS = ["en", "hi", "mr"] as const;

/** yt-dlp unpacks ~38 MB of itself on every run, so it is never quick. */
const CAPTION_TIMEOUT_MS = 90_000;

/** The video id in a YouTube URL, or null for anything that is not one. */
export function youTubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  // Exact hosts only: a suffix test would accept youtube.com.attacker.example.
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const path = url.pathname;
  const id = host.endsWith("youtu.be")
    ? path.slice(1).split("/")[0]
    : path === "/watch"
      ? url.searchParams.get("v")
      : /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(path)?.[1];
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/**
 * The kind and shortcode of an Instagram video page, or null. `/reel/<code>`
 * also appears under a profile (`/<user>/reel/<code>`), so the kind is looked
 * for anywhere in the path rather than only at its head — but only as one of
 * the three literals above, never as whatever segment happened to be there.
 */
export function instagramPost(url: URL): { kind: string; code: string } | null {
  if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (!INSTAGRAM_KINDS.has(parts[i])) continue;
    const code = parts[i + 1];
    // Shortcodes are base64url and eleven characters today; the range is wide
    // enough to outlive that and narrow enough to be a path segment and nothing
    // else.
    if (!/^[A-Za-z0-9_-]{5,24}$/.test(code)) return null;
    return { kind: parts[i] === "reels" ? "reel" : parts[i], code };
  }
  return null;
}

/** A video page's canonical URL, REBUILT from what we recognised in it. */
export function videoLinkUrl(url: URL): string | null {
  const youtube = youTubeVideoId(url);
  if (youtube) return `https://www.youtube.com/watch?v=${youtube}`;
  const instagram = instagramPost(url);
  if (instagram) {
    return `https://www.instagram.com/${instagram.kind}/${instagram.code}/`;
  }
  return null;
}

/**
 * A WebVTT track as one paragraph. Cue numbers, timings and inline karaoke tags
 * are scaffolding; an auto-generated track also repeats each line as its window
 * rolls, so a line identical to the one before it is dropped.
 */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  let last = "";
  let inHeader = false;
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      inHeader = false;
      continue;
    }
    if (inHeader) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION|Kind:|Language:)/i.test(line)) {
      inHeader = true;
      continue;
    }
    if (line.includes("-->") || /^\d+$/.test(line)) continue;
    const text = normalize(line.replace(/<[^>]*>/g, ""));
    if (!text || text === last) continue;
    out.push(text);
    last = text;
  }
  return out.join(" ");
}

/**
 * Which track: the one the creator uploaded, or the one YouTube's ASR made.
 * They are asked for separately — v7 §4 wants a person's own subtitles chosen
 * over any machine's, and a single run that passes both flags cannot tell which
 * of them it came back with.
 */
export type CaptionKind = "creator" | "auto";

/**
 * The spoken content of a YouTube video, or null. A video with no captions, a
 * rate limit and a yt-dlp that was never staged are all the same answer: the
 * page's own metadata is still worth storing, so none of them is an error.
 */
export async function youTubeCaptions(
  id: string,
  kind: CaptionKind,
  signal?: AbortSignal,
): Promise<string | null> {
  const bin = resolveYtDlpBin();
  if (!bin) return null;
  const dir = await mkdtemp(join(tmpdir(), "supertwin-captions-"));
  try {
    await run(
      bin,
      [
        "--no-config",
        "--no-cache-dir",
        "--no-playlist",
        "--skip-download",
        kind === "creator" ? "--write-subs" : "--write-auto-subs",
        "--sub-langs",
        CAPTION_LANGS.join(","),
        "--sub-format",
        "vtt",
        "--no-progress",
        "--no-warnings",
        "--retries",
        "1",
        "-o",
        join(dir, "cap.%(ext)s"),
        `https://www.youtube.com/watch?v=${id}`,
      ],
      { timeoutMs: CAPTION_TIMEOUT_MS, signal },
    );
    for (const lang of CAPTION_LANGS) {
      const file = join(dir, `cap.${lang}.vtt`);
      if (!existsSync(file)) continue;
      const text = vttToText(await readFile(file, "utf8"));
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- Fetch -----------------------------------------------------------------

/**
 * Decompression as a stream rather than in one piece at the end. That is what
 * lets a body we cut at the byte budget still be read: everything before the
 * cut inflates normally, and only the trailer is missing.
 */
function decompressor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new Error(`unsupported content-encoding "${encoding}"`);
  }
}

/** A type we will never be able to read — retrying cannot change it. */
class UnreadableType extends Error {}

/** "</head" minus one, so a marker split across two chunks is still seen. */
const MARKER_OVERLAP = 6;

/** One hop. Rejects on transport failure, a bad status, or an unreadable type. */
function fetchOnce(
  url: URL,
  opts: Required<Pick<ScrapeOptions, "maxBytes" | "blocked">> & {
    signal?: AbortSignal;
  },
): Promise<{ redirect: URL } | { body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (isIP(url.hostname) && opts.blocked(url.hostname)) {
      reject(new Refused(`${url.hostname} is a non-public address`));
      return;
    }
    // A URL can smuggle credentials in its authority, which Node would turn
    // into an Authorization header. This request authenticates as nobody.
    url.username = "";
    url.password = "";
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "GET",
        lookup: guardedLookup(opts.blocked),
        headers: {
          // No cookie, no auth, no referer: this request carries nothing of the
          // user's, and the header set is the whole story of what it sends.
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "accept-language": "en",
          "accept-encoding": "gzip, br, deflate",
        },
        signal: opts.signal,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.destroy();
          if (!location) {
            reject(new Error(`HTTP ${status} with no redirect target`));
            return;
          }
          try {
            resolve({ redirect: new URL(location, url) });
          } catch {
            reject(new Error(`HTTP ${status} to an unreadable target`));
          }
          return;
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const contentType = (res.headers["content-type"] ?? "").toString();
        if (!READABLE_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
          res.destroy();
          reject(
            new UnreadableType(
              `${contentType || "an unnamed type"} is not a readable page`,
            ),
          );
          return;
        }

        let inflate: Transform | null;
        try {
          inflate = decompressor(res.headers["content-encoding"]?.toString());
        } catch (err) {
          res.destroy();
          reject(err as Error);
          return;
        }

        const headLimit = Math.min(MAX_HEAD_BYTES, opts.maxBytes);
        const bodyLimit = Math.min(MAX_BODY_BYTES, opts.maxBytes);
        const chunks: Buffer[] = [];
        let decoded = 0;
        let wire = 0;
        let headEnd: number | null = null;
        let marker = "";
        let settled = false;
        let ended = false;

        // The cap cuts the connection mid-page. Where it cuts is what matters:
        // the metadata lives at the end of the head, so the read is sized to
        // get there and then to take a bounded look at the body underneath.
        const enough = (): boolean =>
          decoded >= opts.maxBytes ||
          decoded >= (headEnd === null ? headLimit : headEnd + bodyLimit);

        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolve({ body: Buffer.concat(chunks) });
        };
        const stop = (): void => {
          res.destroy();
          inflate?.destroy();
          settle();
        };
        const flush = (): void => {
          if (settled || ended) return;
          ended = true;
          if (inflate) inflate.end();
          else settle();
        };

        const take = (chunk: Buffer): void => {
          chunks.push(chunk);
          decoded += chunk.length;
          if (headEnd === null) {
            // latin1 keeps one character per byte, and the markers are ASCII.
            const seen = marker + chunk.toString("latin1").toLowerCase();
            if (seen.includes("</head") || seen.includes("<body")) headEnd = decoded;
            else marker = seen.slice(-MARKER_OVERLAP);
          }
          if (enough()) stop();
        };

        if (inflate) {
          inflate.on("data", take);
          inflate.on("end", settle);
          // What arrived before a cut is real text, so it is kept; only a
          // stream that yielded nothing at all is a failure.
          inflate.on("error", (err: Error) => {
            if (chunks.length) settle();
            else reject(err);
          });
        }

        res.on("data", (chunk: Buffer) => {
          wire += chunk.length;
          if (inflate) inflate.write(chunk);
          else take(chunk);
          if (wire >= opts.maxBytes * MAX_WIRE_RATIO) stop();
        });
        res.on("end", flush);
        res.on("close", flush);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch a URL and pull the readable text out of it. Never throws: every failure
 * comes back as a status plus the reason it failed.
 *
 * - `done` — text was extracted
 * - `skipped` — refused before any request was made, or the host only resolves
 *   to non-public addresses. Retrying would refuse it again.
 * - `unsupported` — reachable, but not a page we can read
 * - `error` — transport, timeout or HTTP failure, or a page that gave us code
 *   where its content should have been
 */
export async function scrapeLink(
  rawUrl: string,
  opts: ScrapeOptions = {},
): Promise<LinkScrapeResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refused(`"${rawUrl}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refused(`${url.protocol} is not fetchable`);
  }

  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const blocked = opts.blocked ?? isBlockedAddress;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  // One deadline for the whole chain: a redirect loop that stays under the
  // per-hop budget must still not hold the queue open indefinitely.
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? SCRAPE_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, deadline])
    : deadline;

  try {
    for (let hop = 0; ; hop++) {
      const step = await fetchOnce(url, { maxBytes, blocked, signal });
      if (!("redirect" in step)) {
        const page = readPage(step.body.toString("utf8"));
        // Read off the final URL, so a share link that redirects to a video is
        // still recognised as one. The page's deadline is not passed on: it is
        // spent by the time we get here, and the video steps have budgets of
        // their own — a shutdown still stops them.
        const spoken = await linkVideoContent(url, opts);
        const { text, dropped } = assemble([...page.parts, spoken.transcript]);
        if (!text) {
          return dropped
            ? failed("the page returned code where its text should be")
            : {
                status: "unsupported",
                scrapedText: null,
                title: null,
                error: "the page has no readable text",
              };
        }
        return {
          status: "done",
          scrapedText: text,
          title: page.title,
          // The page read succeeded; this says what we could not ALSO get, so
          // a video that would not download is on the row rather than nowhere.
          error: spoken.error,
          frames: spoken.frames,
        };
      }
      if (hop >= maxRedirects) {
        return failed(`more than ${maxRedirects} redirects`);
      }
      if (step.redirect.protocol !== "http:" && step.redirect.protocol !== "https:") {
        return refused(`redirected to ${step.redirect.protocol}`);
      }
      url = step.redirect;
    }
  } catch (err) {
    const e = err as Error;
    if (e instanceof UnreadableType) {
      return {
        status: "unsupported",
        scrapedText: null,
        title: null,
        error: e.message,
      };
    }
    // A refusal from the resolver surfaces here as a connection failure, but it
    // is a decision, not a transport blip: the socket must not be retried into.
    if (e instanceof Refused || /non-public address/.test(e.message)) {
      return refused(e.message);
    }
    if (deadline.aborted) return failed(`the fetch timed out`);
    return failed(e.message);
  }
}

/**
 * What the video behind a page says and shows, in v7 §4's order of preference:
 * the creator's own subtitles, then whisper over the downloaded file, then
 * YouTube's ASR. Nothing here can fail the scrape — a page whose video would
 * not download is still a page we read.
 */
export async function linkVideoContent(
  url: URL,
  opts: ScrapeOptions = {},
): Promise<{ transcript: string | null; frames: MediaFrame[]; error: string | null }> {
  const canonical = videoLinkUrl(url);
  if (!canonical) return { transcript: null, frames: [], error: null };
  const youtube = youTubeVideoId(url);

  const written = youtube
    ? await youTubeCaptions(youtube, "creator", opts.signal)
    : null;
  if (written && !opts.video?.frames) {
    // A person's own subtitles, and no reason left to fetch the file.
    return { transcript: written, frames: [], error: null };
  }

  const read = opts.video
    ? await readLinkVideo(
        canonical,
        // Whisper is only worth its minutes when nobody has already written the
        // words down.
        written ? { ...opts.video, audio: false } : opts.video,
        opts.signal,
      )
    : { transcript: null, frames: [] as MediaFrame[], error: null };

  const transcript =
    written ??
    read.transcript ??
    (youtube ? await youTubeCaptions(youtube, "auto", opts.signal) : null);
  return { transcript, frames: read.frames, error: read.error };
}

function refused(reason: string): LinkScrapeResult {
  return { status: "skipped", scrapedText: null, title: null, error: reason };
}

function failed(reason: string): LinkScrapeResult {
  return { status: "error", scrapedText: null, title: null, error: reason };
}

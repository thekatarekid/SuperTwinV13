// ===========================================================================
// [CODE, zero model calls] Seed a REALISTIC corpus into a scratch home, so the
// understanding pipeline can be verified end to end against something shaped
// like a real install (verify: e2e, 13.11.6).
//
// The user's 13.11.5 install had ~76k archive rows, a few thousand inside the
// Understand window, WhatsApp across dozens of chats plus months of browser
// history, and produced nothing. Reproducing "nothing" needs a corpus with the
// same SHAPE, not the same size:
//
//   * two consent rows (whatsapp, browser) with INDEX reaching back ~8 months
//     and UNDERSTAND covering only a recent slice — so the great majority of
//     rows land as origin='archive' with dispatched_at stamped, exactly as they
//     do in the field, and only the slice is ever offered to a model. Source ids,
//     stream ids and key shapes are the production ones (`whatsapp:st:<jid>`);
//   * ~2.5k WhatsApp messages over ~24 chats (groups, DMs, never-replied
//     businesses) spanning the whole index window;
//   * ~450 browser visits over the same months, on domains that BRIDGE to the
//     chat topics (a flat listing, a flight search, a bank page);
//   * inside the Understand window, hand-written threads that carry real
//     commitments — an amount and a date, a booking, a deadline, a follow-up
//     someone owes the user — because a pipeline that runs but understands
//     nothing is the failure this exists to catch.
//
// Everything goes through the real single writer (db/eventlog.appendEvents),
// so the consent gate, the archive layer, bridging and FTS all run exactly as
// they do in production. Nothing here reaches a model.
//
// Usage (never against a real home — the caller sets SUPERTWIN_HOME):
//   SUPERTWIN_HOME=/tmp/scratch npx tsx src/evals/seed-corpus.ts [--scale 1]
// ===========================================================================

import { pathToFileURL } from "node:url";

import { closeDb, getDb, runMigrations, resolveDbPath } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { setConsentGateMode } from "../db/consent-gate.js";
import { grantConsent } from "../db/v6core.js";
import { ensureEntityForActor } from "../entities/from-ingest.js";
import { isProductionDbPath } from "../home-guard.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

/** INDEX reaches back this far; everything older is dropped at the funnel. */
export const INDEX_DAYS = 240;
/** UNDERSTAND covers this recent slice; older admitted rows are archive. */
export const UNDERSTAND_DAYS = 3;

export interface SeedReport {
  dbPath: string;
  waEvents: number;
  browserEvents: number;
  inserted: number;
  skipped: number;
  understandFrom: string;
  indexFrom: string;
}

// ---------------------------------------------------------------------------
// Deterministic randomness — a seeded LCG, so two runs seed the same corpus.
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

interface Chat {
  key: string;
  actor: string;
  /** Other speakers in a group. */
  others?: string[];
  /** Does the user write back? A never-replied business is the T2/T3 path. */
  replied: boolean;
  /** Filler lines for the archive months. */
  lines: string[];
}

// ---------------------------------------------------------------------------
// The roster.
//
// In production `events.actor` is the raw JID and the adapter announces every
// actor it sees through ingest's onActor(), which mints the entity and binds
// its jid + phone identity (entities/from-ingest.ts). A seed that writes
// through appendEvents alone announces nobody, so People stays empty and the
// packer's [ROSTER] block is blank — the corpus would be testing a world with
// no people in it. This table is that announcement.
// ---------------------------------------------------------------------------

interface Person {
  jid: string;
  name: string;
}

const SELF_JID = "919820099999@s.whatsapp.net";

const ROSTER: Record<string, Person> = {
  "contact:rohan": { jid: "919820011001@s.whatsapp.net", name: "Rohan Mehta" },
  "contact:meera": { jid: "919820011002@s.whatsapp.net", name: "Meera Iyer" },
  "contact:vikram-broker": { jid: "919820011003@s.whatsapp.net", name: "Vikram (broker)" },
  "contact:dr-shah-clinic": { jid: "919820011004@s.whatsapp.net", name: "Dr Shah Clinic" },
  "contact:kabir": { jid: "919820011005@s.whatsapp.net", name: "Kabir Rao" },
  "contact:aditi": { jid: "919820011006@s.whatsapp.net", name: "Aditi Sen" },
  "contact:landlord-mehta": { jid: "919820011007@s.whatsapp.net", name: "Mehta (landlord)" },
  "contact:sameer": { jid: "919820011008@s.whatsapp.net", name: "Sameer Joshi" },
  "contact:ca-deshpande": { jid: "919820011009@s.whatsapp.net", name: "CA Deshpande" },
  "contact:ishita": { jid: "919820011010@s.whatsapp.net", name: "Ishita" },
  "contact:naveen": { jid: "919820011011@s.whatsapp.net", name: "Naveen" },
  "contact:priya": { jid: "919820011012@s.whatsapp.net", name: "Priya Nambiar" },
  "contact:zomato-rider": { jid: "919820011013@s.whatsapp.net", name: "Delivery" },
  "contact:tailor-anwar": { jid: "919820011014@s.whatsapp.net", name: "Anwar (tailor)" },
  "contact:shreya": { jid: "919820011015@s.whatsapp.net", name: "Shreya" },
  "contact:hdfc-bank": { jid: "918000000001@s.whatsapp.net", name: "HDFC Bank" },
  "contact:jio-offers": { jid: "918000000002@s.whatsapp.net", name: "Jio" },
  "contact:apollo-pharmacy": { jid: "918000000003@s.whatsapp.net", name: "Apollo Pharmacy" },
  // Group-only speakers — a jid the user has no DM with, which is the common case.
  "contact:secretary": { jid: "919820012001@s.whatsapp.net", name: "Society Secretary" },
  "contact:mrs-nair": { jid: "919820012002@s.whatsapp.net", name: "Mrs Nair" },
  "contact:kulkarni": { jid: "919820012003@s.whatsapp.net", name: "Kulkarni" },
  "contact:dev-arjun": { jid: "919820012004@s.whatsapp.net", name: "Arjun (dev)" },
  "contact:amma": { jid: "919820012005@s.whatsapp.net", name: "Amma" },
  "contact:papa": { jid: "919820012006@s.whatsapp.net", name: "Papa" },
  "contact:sister-ishita": { jid: "919820012007@s.whatsapp.net", name: "Ishita (sister)" },
  "contact:varun": { jid: "919820012008@s.whatsapp.net", name: "Varun" },
  "contact:tarun": { jid: "919820012009@s.whatsapp.net", name: "Tarun" },
  "contact:nikhil": { jid: "919820012010@s.whatsapp.net", name: "Nikhil" },
};

/** The jid an actor ref stands for. `self` stays `self` (the envelope's own word). */
function jidOf(ref: string): string {
  if (ref === "self") return "self";
  return ROSTER[ref]?.jid ?? ref;
}

const GROUPS: Chat[] = [
  {
    key: "goa-gang-2019@g.us",
    actor: "contact:rohan",
    others: ["contact:meera", "contact:aditi", "contact:sameer"],
    replied: true,
    lines: [
      "anyone up for a game on saturday",
      "sending the photos from last time",
      "that place near the beach was so good",
      "who is driving this time",
      "lets keep the group alive people",
    ],
  },
  {
    key: "sunrise-402-owners@g.us",
    actor: "contact:secretary",
    others: ["contact:mrs-nair", "contact:kulkarni"],
    replied: true,
    lines: [
      "maintenance for the month is due by the 5th",
      "water tanker coming tomorrow morning",
      "lift service scheduled this weekend",
      "please park in your allotted slot only",
      "society meeting minutes attached",
    ],
  },
  {
    key: "product-standup@g.us",
    actor: "contact:priya",
    others: ["contact:dev-arjun", "contact:kabir"],
    replied: true,
    lines: [
      "standup in 10",
      "build is green on main",
      "moving the release to next week",
      "can someone look at the flaky test",
      "design review notes are in the doc",
    ],
  },
  {
    key: "family-katare@g.us",
    actor: "contact:amma",
    others: ["contact:papa", "contact:sister-ishita"],
    replied: true,
    lines: [
      "did you eat",
      "call when you are free",
      "sending sweets with the neighbour",
      "papa's checkup went fine",
      "the weather here is finally cooler",
    ],
  },
  {
    key: "badminton-tuesdays@g.us",
    actor: "contact:varun",
    others: ["contact:naveen"],
    replied: true,
    lines: [
      "court booked for tuesday 7pm",
      "need one more player",
      "shuttles are finished, someone bring a box",
      "skipping this week, travelling",
      "same time next week?",
    ],
  },
  {
    key: "college-2016-batch@g.us",
    actor: "contact:tarun",
    others: ["contact:nikhil", "contact:shreya"],
    replied: false,
    lines: [
      "throwback thursday",
      "anyone in bangalore next month",
      "congrats on the new job!",
      "reunion poll link inside",
      "happy birthday bro",
    ],
  },
];

const DMS: Chat[] = [
  { key: "919820011001@s.whatsapp.net", actor: "contact:rohan", replied: true, lines: ["free tonight?", "sent you the link", "haha true", "call me when you land", "did you see the mail"] },
  { key: "919820011002@s.whatsapp.net", actor: "contact:meera", replied: true, lines: ["good morning", "will send by evening", "thanks a ton", "let me check and revert", "sounds good"] },
  { key: "919820011003@s.whatsapp.net", actor: "contact:vikram-broker", replied: true, lines: ["shared two more options", "owner is asking for a call", "site visit possible sunday?", "rates went up in that area", "let me know your budget range"] },
  { key: "919820011004@s.whatsapp.net", actor: "contact:dr-shah-clinic", replied: true, lines: ["reports are ready", "please come fasting", "prescription sent", "follow up in a month", "take the tablets after food"] },
  { key: "919820011005@s.whatsapp.net", actor: "contact:kabir", replied: true, lines: ["pushed the branch", "ping when free", "that ticket is mine", "reviewing now", "merged"] },
  { key: "919820011006@s.whatsapp.net", actor: "contact:aditi", replied: true, lines: ["sent the invite", "are you coming", "photos uploaded", "loved it", "see you there"] },
  { key: "919820011007@s.whatsapp.net", actor: "contact:landlord-mehta", replied: true, lines: ["rent received", "plumber will come at 11", "renewal papers ready", "society noc done", "keep the receipt"] },
  { key: "919820011008@s.whatsapp.net", actor: "contact:sameer", replied: true, lines: ["bike serviced", "traffic is mad", "reaching in 20", "got the tickets", "count me in"] },
  { key: "919820011009@s.whatsapp.net", actor: "contact:ca-deshpande", replied: true, lines: ["advance tax due date is near", "send the bank statement", "filed, acknowledgement attached", "gst return done", "need form 16"] },
  { key: "919820011010@s.whatsapp.net", actor: "contact:ishita", replied: true, lines: ["landed safely", "sending pics", "amma called you?", "ok", "talk later"] },
  { key: "919820011011@s.whatsapp.net", actor: "contact:naveen", replied: true, lines: ["gym at 7?", "skipping today", "new routine is brutal", "protein order placed", "see you"] },
  { key: "919820011012@s.whatsapp.net", actor: "contact:priya", replied: true, lines: ["deck updated", "client call moved", "can you join", "thanks for the fix", "eod is fine"] },
  { key: "919820011013@s.whatsapp.net", actor: "contact:zomato-rider", replied: false, lines: ["order picked up", "reaching in 5 minutes", "at the gate", "delivered", "please rate"] },
  { key: "919820011014@s.whatsapp.net", actor: "contact:tailor-anwar", replied: true, lines: ["ready by friday", "measurements taken", "cloth arrived", "trial on sunday", "collected"] },
  { key: "919820011015@s.whatsapp.net", actor: "contact:shreya", replied: false, lines: ["long time!", "how is work", "we should catch up", "sharing my new number", "take care"] },
];

/** Never-replied businesses — the T2/T3 path, bounded to keep tier.v1 cheap. */
const BUSINESSES: Chat[] = [
  { key: "918000000001@s.whatsapp.net", actor: "contact:hdfc-bank", replied: false, lines: ["Your OTP is 4 digits, valid for 10 minutes. Do not share.", "Rs 2,340 debited from a/c XX4412 at a merchant.", "Your credit card statement is generated.", "Salary credited to a/c XX4412.", "Minimum amount due is payable by month end."] },
  { key: "918000000002@s.whatsapp.net", actor: "contact:jio-offers", replied: false, lines: ["Recharge now and get extra data.", "Your bill is generated.", "Enjoy unlimited calls this month.", "Offer valid till the end of the week.", "Download the app for more."] },
  { key: "918000000003@s.whatsapp.net", actor: "contact:apollo-pharmacy", replied: false, lines: ["Your order has been shipped.", "Refill reminder for your prescription.", "Flat discount on health checkups.", "Your order is out for delivery.", "Thank you for shopping with us."] },
];

const BROWSER_DOMAINS: Array<{ domain: string; titles: string[]; paths: string[] }> = [
  { domain: "news.ycombinator.com", titles: ["Hacker News", "Show HN: a small tool", "Ask HN: how do you"], paths: ["/", "/newest", "/item?id=1"] },
  { domain: "github.com", titles: ["GitHub", "Pull requests", "Issues"], paths: ["/", "/pulls", "/issues"] },
  { domain: "www.google.com", titles: ["Google Search", "flights to goa", "stamp duty maharashtra"], paths: ["/search", "/search", "/search"] },
  { domain: "housing.com", titles: ["2 BHK in Powai", "Flats for sale", "Property details"], paths: ["/in/buy", "/in/buy/powai", "/in/listing"] },
  { domain: "www.makemytrip.com", titles: ["Flights BOM to GOI", "Hotels in Goa", "My trips"], paths: ["/flight", "/hotels", "/mytrips"] },
  { domain: "netbanking.hdfcbank.com", titles: ["HDFC NetBanking", "Account summary", "Fund transfer"], paths: ["/netbanking", "/summary", "/transfer"] },
  { domain: "www.youtube.com", titles: ["YouTube", "Watch later", "Music"], paths: ["/", "/playlist", "/feed"] },
  { domain: "docs.google.com", titles: ["Q3 plan", "Design notes", "Sheet1"], paths: ["/document/d/1", "/document/d/2", "/spreadsheets/d/3"] },
  { domain: "www.practo.com", titles: ["Dr Shah — Cardiologist", "Book appointment", "Lab tests"], paths: ["/doctor", "/book", "/labs"] },
  { domain: "www.amazon.in", titles: ["Your orders", "Shuttlecocks", "Cart"], paths: ["/orders", "/s", "/cart"] },
];

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

function waMsg(
  chat: Chat,
  atMs: number,
  text: string,
  o: { actor?: string; origin?: "live" | "backfill"; self?: boolean } = {},
): EventEnvelope {
  const isGroup = chat.key.endsWith("@g.us");
  const actor = jidOf(o.self ? "self" : (o.actor ?? chat.actor));
  const audience = (
    isGroup
      ? ["self", chat.actor, ...(chat.others ?? [])]
      : [o.self ? chat.actor : "self"]
  )
    .map(jidOf)
    .filter((a) => a !== actor);
  return {
    ts: new Date(atMs).toISOString(),
    source: "whatsapp",
    kind: "wa.message",
    origin: o.origin ?? "backfill",
    streamKey: chat.key,
    actor,
    roles: { sender: actor, audience, receiver: audience, mentions: [] },
    payload: { text, chat_kind: isGroup ? "group" : "dm" },
  };
}

function visit(domain: string, atMs: number, url: string, title: string, o: { origin?: "live" | "backfill" } = {}): EventEnvelope {
  const day = new Date(atMs).toISOString().slice(0, 10);
  return {
    ts: new Date(atMs).toISOString(),
    source: "browser",
    kind: "browser.visit",
    origin: o.origin ?? "backfill",
    streamKey: `browser:chrome:default:${domain}:${day}`,
    actor: "self",
    roles: { sender: "self", audience: [], receiver: [], mentions: [] },
    payload: { text: `${title} https://${domain}${url}`, url: `https://${domain}${url}`, title, domain, browser: "chrome" },
  };
}

// ---------------------------------------------------------------------------
// The Understand window — hand-written, load-bearing threads.
//
// Each carries something a twin must be able to name: an amount and a due
// date, a booking with a date, a deadline, a person who owes the user a reply.
// ---------------------------------------------------------------------------

function understandThreads(now: number): EventEnvelope[] {
  const d = (days: number, h: number, m = 0): number =>
    now - days * DAY + h * HOUR + m * MIN - 12 * HOUR;
  const broker = DMS[2]; // vikram-broker
  const family = GROUPS[3];
  const work = GROUPS[2];
  const trip = GROUPS[0];
  const ca = DMS[8];
  const clinic = DMS[3];
  const bank = BUSINESSES[0];
  const out: EventEnvelope[] = [];

  // ---- The flat: an amount, a deadline, a document the user owes ----------
  out.push(
    waMsg(broker, d(2, 10, 5), "Good news — the Powai 2BHK owner accepted 1.42 cr. He wants the token amount of Rs 2,00,000 by the 9th to block it."),
    waMsg(broker, d(2, 10, 7), "Also need your PAN and Aadhaar copies for the agreement draft."),
    waMsg(broker, d(2, 10, 22), "ok that works. I will transfer the token on the 9th.", { self: true }),
    waMsg(broker, d(2, 10, 24), "Will send PAN and Aadhaar tonight.", { self: true }),
    waMsg(broker, d(2, 15, 40), "Perfect. Registration slot is tentatively the 21st at the Powai sub-registrar office, 11am."),
    waMsg(broker, d(1, 9, 15), "Any update on the documents? The owner is asking."),
    waMsg(broker, d(1, 20, 30), "sorry, sending tonight for sure", { self: true }),
  );

  // ---- The trip: a booking, a date, a shared cost ------------------------
  out.push(
    waMsg(trip, d(2, 19, 0), "Goa is ON. 14th to 17th next month. I am booking the Anjuna house tonight — 4 rooms.", { actor: "contact:rohan" }),
    waMsg(trip, d(2, 19, 4), "Per head comes to about 8,500 including the house. Send it when you can.", { actor: "contact:rohan" }),
    waMsg(trip, d(2, 19, 12), "in. booking my flight tomorrow", { self: true }),
    waMsg(trip, d(2, 19, 20), "same, BOM-GOI morning flight", { actor: "contact:meera" }),
    waMsg(trip, d(1, 11, 0), "Guys the house needs the advance by friday or we lose it.", { actor: "contact:rohan" }),
    waMsg(trip, d(1, 11, 30), "sending 8500 today", { actor: "contact:sameer" }),
  );

  // ---- Work: a deadline, a commitment made by the user -------------------
  out.push(
    waMsg(work, d(2, 6, 0), "Reminder: the client demo is on the 12th. Whoever owns the export flow, it has to be stable by the 10th.", { actor: "contact:priya" }),
    waMsg(work, d(2, 6, 18), "export flow is mine. I will have it stable by the 10th.", { self: true }),
    waMsg(work, d(1, 7, 30), "Also we need the Q3 plan doc updated before the demo.", { actor: "contact:priya" }),
    waMsg(work, d(0, 5, 10), "standup in 10", { actor: "contact:dev-arjun" }),
    waMsg(work, d(0, 5, 40), "joining", { self: true }),
  );

  // ---- Money and health: dated obligations ------------------------------
  out.push(
    waMsg(ca, d(2, 12, 0), "Advance tax second instalment is due on the 15th. Rough estimate this quarter is Rs 48,000."),
    waMsg(ca, d(2, 12, 30), "noted. will pay before the 15th", { self: true }),
    waMsg(clinic, d(1, 8, 0), "Your blood report is ready. Vitamin D is low. Dr Shah suggests a follow-up consultation next week."),
    waMsg(clinic, d(1, 8, 20), "can I get an appointment for saturday morning?", { self: true }),
    waMsg(family, d(1, 18, 0), "Papa's cardiology follow-up is on the 20th at 10am. Please block the day.", { actor: "contact:amma" }),
    waMsg(family, d(1, 18, 10), "blocked. I will take him", { self: true }),
  );

  // ---- A never-replied business inside the window (tiering + digest) ----
  out.push(
    waMsg(bank, d(2, 9, 0), "Rs 2,00,000 transfer limit change request received for a/c XX4412."),
    waMsg(bank, d(1, 9, 0), "Your credit card statement is generated. Total due Rs 34,120, minimum Rs 1,706, due date the 18th."),
  );

  // ---- The live tail: the last hour, origin='live' (state gate + burst) --
  out.push(
    waMsg(broker, now - 42 * MIN, "The owner's lawyer wants the token by the 9th, not the 10th. Can you confirm?", { origin: "live" }),
    waMsg(broker, now - 40 * MIN, "confirmed, 9th it is", { self: true, origin: "live" }),
    waMsg(trip, now - 34 * MIN, "House is booked! Advance paid. 14th to 17th confirmed.", { actor: "contact:rohan", origin: "live" }),
    waMsg(trip, now - 31 * MIN, "sending my share now", { self: true, origin: "live" }),
    waMsg(work, now - 25 * MIN, "Demo moved up — it is on the 11th now, not the 12th.", { actor: "contact:priya", origin: "live" }),
    waMsg(work, now - 22 * MIN, "ok, export flow will still be ready", { self: true, origin: "live" }),
  );

  // ---- Browser inside the window: bridges to the threads above ----------
  out.push(
    visit("housing.com", d(2, 11, 0), "/in/buy/powai/2bhk-lake-view", "2 BHK in Powai — Lake View, 1.45 Cr"),
    visit("www.google.com", d(2, 11, 10), "/search?q=stamp+duty+maharashtra+2026", "stamp duty maharashtra 2026 - Google Search"),
    visit("netbanking.hdfcbank.com", d(2, 11, 25), "/netbanking/transfer", "HDFC NetBanking — Fund transfer"),
    visit("www.makemytrip.com", d(1, 21, 0), "/flight/search?from=BOM&to=GOI", "Flights BOM to GOI — MakeMyTrip"),
    visit("www.makemytrip.com", d(1, 21, 12), "/hotels/goa/anjuna", "Hotels in Anjuna, Goa"),
    visit("docs.google.com", d(1, 10, 0), "/document/d/1/edit", "Q3 plan — Google Docs"),
    visit("www.practo.com", d(1, 8, 40), "/doctor/dr-shah-cardiologist-mumbai", "Dr Shah — Cardiologist, Mumbai"),
    visit("www.google.com", now - 55 * MIN, "/search?q=powai+sub+registrar+office+timings", "powai sub registrar office timings - Google Search", { origin: "live" }),
    visit("housing.com", now - 50 * MIN, "/in/buy/powai/2bhk-lake-view", "2 BHK in Powai — Lake View, 1.45 Cr", { origin: "live" }),
  );

  return out;
}

/**
 * The noise the signal has to be found in. A real Understand window is not a
 * hand-written script: it is three days of ordinary chatter with four things
 * that matter buried in it. Filler costs tokens, not calls — the history lane
 * sends one bundle per day whatever it holds — so this is the cheap half of
 * realism and the half that actually tests extraction.
 */
function windowNoise(now: number): EventEnvelope[] {
  const rnd = lcg(775533);
  const out: EventEnvelope[] = [];
  const chats = [...GROUPS, ...DMS, ...BUSINESSES];
  for (let day = UNDERSTAND_DAYS - 1; day >= 0; day--) {
    const dayStart = now - day * DAY - 13 * HOUR;
    const perDay = day === 0 ? 18 : 34;
    for (let i = 0; i < perDay; i++) {
      const chat = chats[Math.floor(rnd() * chats.length)];
      const at = dayStart + Math.floor(rnd() * 11 * HOUR);
      if (at >= now - 90 * MIN) continue; // the last stretch belongs to the live tail
      const line = chat.lines[Math.floor(rnd() * chat.lines.length)];
      const self = chat.replied && rnd() < 0.3;
      const speaker = !self && chat.others && rnd() < 0.5 ? chat.others[Math.floor(rnd() * chat.others.length)] : undefined;
      out.push(waMsg(chat, at, line, { self, actor: speaker }));
    }
    for (let i = 0; i < 11; i++) {
      const site = BROWSER_DOMAINS[Math.floor(rnd() * BROWSER_DOMAINS.length)];
      const at = dayStart + Math.floor(rnd() * 11 * HOUR);
      if (at >= now - 90 * MIN) continue;
      const k = Math.floor(rnd() * site.paths.length);
      out.push(visit(site.domain, at, site.paths[k], site.titles[k]));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The archive months — volume, spread, and the shape of a real log.
// ---------------------------------------------------------------------------

function archiveMonths(now: number, scale: number): EventEnvelope[] {
  const rnd = lcg(20260906);
  const out: EventEnvelope[] = [];
  const chats = [...GROUPS, ...DMS, ...BUSINESSES];
  const floor = now - (INDEX_DAYS - 2) * DAY;
  const ceiling = now - (UNDERSTAND_DAYS + 1) * DAY;
  const span = ceiling - floor;

  for (const chat of chats) {
    // Busy chats carry more; a dormant one carries a handful.
    const base = chat.key.endsWith("@g.us") ? 150 : 90;
    const n = Math.max(8, Math.round(base * scale * (0.5 + rnd())));
    for (let i = 0; i < n; i++) {
      const at = floor + Math.floor(rnd() * span);
      const line = chat.lines[Math.floor(rnd() * chat.lines.length)];
      const self = chat.replied && rnd() < 0.35;
      const speaker = self
        ? undefined
        : chat.others && rnd() < 0.5
          ? chat.others[Math.floor(rnd() * chat.others.length)]
          : chat.actor;
      out.push(waMsg(chat, at, line, { self, actor: speaker }));
    }
  }

  for (const site of BROWSER_DOMAINS) {
    const n = Math.max(6, Math.round(45 * scale * (0.5 + rnd())));
    for (let i = 0; i < n; i++) {
      const at = floor + Math.floor(rnd() * span);
      const k = Math.floor(rnd() * site.paths.length);
      out.push(visit(site.domain, at, site.paths[k], site.titles[k]));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export function seedCorpus(opts: { now?: number; scale?: number } = {}): SeedReport {
  const dbPath = resolveDbPath();
  if (isProductionDbPath(dbPath)) {
    throw new Error(`refusing to seed the production database at ${dbPath}`);
  }
  const now = opts.now ?? Date.now();
  const scale = opts.scale ?? 1;

  runMigrations();

  const indexFrom = new Date(now - INDEX_DAYS * DAY).toISOString();
  const understandFrom = new Date(now - UNDERSTAND_DAYS * DAY).toISOString();
  grantConsent({ source: "whatsapp", indexAll: false, indexFrom, understandFrom });
  // The browser consent names ONE profile, and it does not exist. The consent
  // row is what the boot path hands the watcher (`profilesForConsent`), so a
  // scope naming no real profile means the watcher discovers nothing and polls
  // nothing. Without this the seeded worker walks the DEVELOPER'S own Chrome
  // history into the scratch database — a thousand real visits that are not
  // the corpus under test, and not ours to read.
  grantConsent({
    source: "browser",
    indexAll: false,
    indexFrom,
    understandFrom,
    scope: { profiles: ["/dev/null/no-such-browser-profile"] },
  });

  // The gate is what we are testing — enforce it, whatever a setup file said.
  setConsentGateMode("enforce");

  // Announce the roster exactly as the adapter's onActor does — jid identity,
  // phone identity, provisional person — so [ROSTER], People and the gate's
  // entity lookups see the same world a real install sees.
  const seenAt = new Date(now - INDEX_DAYS * DAY).toISOString();
  ensureEntityForActor({ sourceId: "whatsapp", jid: SELF_JID, displayName: "Aditya Katare", isSelf: true, seenAt });
  for (const person of Object.values(ROSTER)) {
    ensureEntityForActor({ sourceId: "whatsapp", jid: person.jid, displayName: person.name, seenAt });
  }
  for (const group of GROUPS) {
    ensureEntityForActor({
      sourceId: "whatsapp",
      jid: group.key,
      displayName: group.key.split("@")[0].replace(/-/g, " "),
      seenAt,
    });
  }

  const envs = [...archiveMonths(now, scale), ...windowNoise(now), ...understandThreads(now)];
  envs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < envs.length; i += 500) {
    const r = appendEvents(envs.slice(i, i + 500), now);
    inserted += r.inserted;
    skipped += r.skipped;
  }

  // Chat labels, so the surfaces have something to render.
  const db = getDb();
  const label = db.prepare(`UPDATE streams SET label = ? WHERE external_key = ?`);
  for (const chat of [...GROUPS, ...DMS, ...BUSINESSES]) {
    const nice = chat.actor.replace(/^contact:/, "").replace(/-/g, " ");
    label.run(chat.key.endsWith("@g.us") ? chat.key.split("@")[0].replace(/-/g, " ") : nice, chat.key);
  }

  return {
    dbPath,
    waEvents: envs.filter((e) => e.source === "whatsapp").length,
    browserEvents: envs.filter((e) => e.source === "browser").length,
    inserted,
    skipped,
    understandFrom,
    indexFrom,
  };
}

async function main(argv: string[]): Promise<number> {
  const scaleArg = argv.indexOf("--scale");
  const scale = scaleArg >= 0 ? Number(argv[scaleArg + 1]) : 1;
  try {
    const r = seedCorpus({ scale: Number.isFinite(scale) ? scale : 1 });
    console.log(JSON.stringify(r, null, 2));
    return 0;
  } finally {
    closeDb();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`seed-corpus: ${(err as Error).stack ?? String(err)}`);
      process.exitCode = 3;
    });
}

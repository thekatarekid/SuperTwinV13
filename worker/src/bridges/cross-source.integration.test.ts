// ===========================================================================
// [CODE] Cross-source bridges — build item 5.3 (PHASE 5, the thesis proof).
//
// A WhatsApp conversation about an event and a calendar entry for that same
// event must land in ONE arc, joined at rung ① of the arc ladder by a bridge
// (`url` / `attendee_set`), at precision 1.0 and zero model calls — and every
// module on the path is the UNMODIFIED generic layer:
//
//   ingest    → db/ingest for WhatsApp; the REAL CalendarAdapter + Ingestion
//               for calendar (the 5.1 fixture path, .ics and all)
//   entities  → entities/binding + resolve; contacts-rung email identities
//               filed on the WhatsApp entities so both sources speak one
//               entity vocabulary (item 5.2's [CODE] merge surface)
//   sessions  → sessions/segment + seal, policies resolved off each source's
//               OWN manifest (conversation for WhatsApp, bounded for calendar)
//   episodes  → episodes/engine via scheduler/episode-pass's engineSessionOf
//   bridges   → bridges/extract runBridgePass, kinds gated by the manifests
//   arcs      → arcs/ladder runArcLadder + arcs/provisional applyLadderResult
//               + arcs/reconcile (provisional → committed, the real two-phase)
//
// PRECISION 1.0 IS MEASURED, NOT ASSUMED. The fixture carries near-miss traps:
//
//   * same DOMAIN, different URL — the WhatsApp "Weekend plans" chat pastes
//     meet.example.com/other-sync while the trap calendar event carries
//     meet.example.com/quarterly-sync. A domain is not a literal; no bridge.
//   * overlapping-but-DIFFERENT attendee sets — the trap events share me (and
//     me+Rohan) with the WhatsApp chats but sit at Jaccard 0.4 and 0.33,
//     both under the 0.6 bar. Two overlapping rooms are two rooms.
//
// If any trap bridges, the precision assertion at the bottom fails. If the
// extractor had "whatsapp" special-cased anywhere, the manifest-gate
// assertions fail (attendee_set is live here ONLY because the CALENDAR
// manifest declares it — WhatsApp's does not).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getManifest, registerSource } from "../adapters/registry.js";
import type { SourceAdapter } from "../adapters/source-adapter.js";
import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { CalendarAdapter, calendarExternalId } from "../adapters/calendar/adapter.js";
import { CALENDAR_MANIFEST, CALENDAR_SOURCE_ID } from "../adapters/calendar/manifest.js";
import { runArcLadder, type LadderEpisode } from "../arcs/ladder.js";
import {
  applyLadderResult,
  arcEpisodeIds,
  readArcCandidates,
  readArcs,
} from "../arcs/provisional.js";
import { promoteArcs, readSpaces } from "../arcs/promote-store.js";
import { reconcile } from "../arcs/reconcile.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { bindSelfIdentity, ensureMeEntity } from "../entities/binding.js";
import { putIdentity } from "../entities/identities.js";
import { resolveIdentity } from "../entities/resolve.js";
import { runEpisodePass } from "../episodes/engine.js";
import type { EpisodeRow } from "../episodes/store.js";
import { Ingestion } from "../ingest/index.js";
import { engineSessionOf } from "../scheduler/episode-pass.js";
import { resolvePolicy } from "../sessions/policies.js";
import { segment, type SegEvent } from "../sessions/segment.js";
import { sealStream, textIndex } from "../sessions/seal.js";
import { bridgeKeysFor, liveBridgeKeys, runBridgePass, type BridgeItem } from "./extract.js";

// ---------------------------------------------------------------------------
// Fixture clock and people
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Truncated to the hour so in-session minute offsets never cross midnight. */
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const WA_BASE = NOW - 3 * DAY;
const CAL_BASE = NOW - 2 * DAY;

const SELF_EMAIL = "me@example.com";
const SELF_JID = "911234500001@s.whatsapp.net";

const WA_SOURCE = WHATSAPP_MANIFEST.source_id;

/** People on BOTH sources (jid on WhatsApp, email on the calendar invite). */
const PEOPLE = [
  { ext: "gargi", jid: "911234500002@s.whatsapp.net", email: "gargi@x.com", name: "Gargi" },
  { ext: "mansi", jid: "911234500003@s.whatsapp.net", email: "mansi@x.com", name: "Mansi" },
  { ext: "rohan", jid: "911234500004@s.whatsapp.net", email: "rohan@x.com", name: "Rohan" },
] as const;

/** Calendar-only people — trap attendees the WhatsApp side has never seen. */
const CAL_ONLY = ["priya@x.com", "u1@x.com", "u2@x.com", "u3@x.com", "u4@x.com", "u5@x.com"];

const CAL_NAME = "Team Calendar";
/** The shared literal: one page, spelled with tracking noise on one side. */
const PARTY_URL_WA = "https://meet.example.com/gargi-40?utm_source=whatsapp&si=Zx9Q";
const PARTY_URL_CAL = "https://meet.example.com/gargi-40";
const PARTY_URL_NORM = "meet.example.com/gargi-40";

function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

function icsStamp(ms: number): string {
  return iso(ms).replace(/[-:]/g, "").slice(0, 15) + "Z";
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cross-source-bridge-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
  // Both manifests through the REAL registry — the extractor's kind gate reads
  // them there, which is what makes `bridge_keys` data instead of a constant.
  // (The registry is process-wide and a source registers once.)
  if (!getManifest(WA_SOURCE)) {
    registerSource({
      manifest: WHATSAPP_MANIFEST,
      adapter: { sourceId: WA_SOURCE, sourceType: "whatsapp" } as unknown as SourceAdapter,
    });
  }
  if (!getManifest(CALENDAR_SOURCE_ID)) {
    registerSource({
      manifest: CALENDAR_MANIFEST,
      adapter: { sourceId: CALENDAR_SOURCE_ID, sourceType: "calendar" } as unknown as SourceAdapter,
    });
  }
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stage 1 — identities: one entity vocabulary across both sources
// ---------------------------------------------------------------------------

interface World {
  me: string;
  /** jid/email → entity id, for every person either source can name. */
  entityOf: Map<string, string>;
}

function bindWorld(): World {
  ensureMeEntity();
  const me = bindSelfIdentity({ sourceId: WA_SOURCE, kind: "jid", value: SELF_JID });
  bindSelfIdentity({ sourceId: CALENDAR_SOURCE_ID, kind: "email", value: SELF_EMAIL });
  const entityOf = new Map<string, string>([
    [SELF_JID, me],
    [SELF_EMAIL, me],
  ]);
  for (const p of PEOPLE) {
    const resolved = resolveIdentity({
      sourceId: WA_SOURCE,
      kind: "jid",
      value: p.jid,
      displayName: p.name,
      seenAt: iso(WA_BASE),
    });
    const entityId = resolved.bind.entityId;
    // Item 5.2's [CODE] merge surface: a contact card links the email to the
    // same person, so a calendar-side email lands on the WhatsApp entity via
    // the identity ladder's exact/cross-source rungs — zero model calls.
    putIdentity({
      entityId,
      sourceId: "contacts",
      kind: "email",
      value: p.email,
      confidence: 1,
      decidedBy: "code:cross_source",
    });
    entityOf.set(p.jid, entityId);
    entityOf.set(p.email, entityId);
  }
  for (const email of CAL_ONLY) {
    const resolved = resolveIdentity({
      sourceId: CALENDAR_SOURCE_ID,
      kind: "email",
      value: email,
      seenAt: iso(CAL_BASE),
    });
    entityOf.set(email, resolved.bind.entityId);
  }
  return { me, entityOf };
}

// ---------------------------------------------------------------------------
// Stage 2 — ingest: WhatsApp via db/ingest, calendar via the REAL adapter
// ---------------------------------------------------------------------------

interface WaMessage {
  ext: string;
  jid: string;
  at: number;
  text: string;
}

interface WaChat {
  extId: string;
  name: string;
  messages: WaMessage[];
}

const WA_CHATS: WaChat[] = [
  {
    extId: "group_gargi40",
    name: "Gargi's 40th",
    messages: [
      { ext: "wa-g1", jid: SELF_JID, at: WA_BASE, text: "Cake tasting shortlist is done!" },
      { ext: "wa-g2", jid: PEOPLE[0].jid, at: WA_BASE + 2 * MINUTE, text: "I still can't believe you're planning this for me" },
      { ext: "wa-g3", jid: PEOPLE[1].jid, at: WA_BASE + 4 * MINUTE, text: `Planning call tonight, join here: ${PARTY_URL_WA}` },
      { ext: "wa-g4", jid: SELF_JID, at: WA_BASE + 6 * MINUTE, text: "Joining at 9" },
    ],
  },
  {
    // The TRAP chat: same URL domain as the trap calendar event, different
    // path; shares me+Rohan with it, but its attendee overlap sits at 0.4.
    extId: "group_weekend",
    name: "Weekend plans",
    messages: [
      { ext: "wa-w1", jid: PEOPLE[2].jid, at: WA_BASE + HOUR, text: "Trek on Saturday?" },
      { ext: "wa-w2", jid: SELF_JID, at: WA_BASE + HOUR + 2 * MINUTE, text: "In. Let's sync later https://meet.example.com/other-sync" },
    ],
  },
];

function ingestWhatsApp(): Map<string, string> {
  upsertSource({ id: WA_SOURCE, type: "whatsapp", name: "WhatsApp" });
  const streamDbIds = new Map<string, string>();
  const actorDbIds = new Map<string, string>();
  const actorOf = (jid: string, name: string, isSelf: boolean): string => {
    const held = actorDbIds.get(jid);
    if (held !== undefined) return held;
    const id = upsertActor({ sourceId: WA_SOURCE, sourceExtId: jid, displayName: name, isSelf });
    actorDbIds.set(jid, id);
    return id;
  };
  for (const chat of WA_CHATS) {
    const streamId = upsertStream({ sourceId: WA_SOURCE, sourceExtId: chat.extId, name: chat.name, kind: "group" });
    streamDbIds.set(chat.extId, streamId);
    for (const m of chat.messages) {
      const name = m.jid === SELF_JID ? "Me" : PEOPLE.find((p) => p.jid === m.jid)?.name ?? m.jid;
      insertEvent({
        externalId: m.ext,
        sourceId: WA_SOURCE,
        sourceType: "whatsapp",
        streamId,
        actorId: actorOf(m.jid, name, m.jid === SELF_JID),
        ts: iso(m.at),
        kind: "message",
        text: m.text,
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      });
    }
  }
  return streamDbIds;
}

/** UID → { organizer, attendees, url } — the fixture's calendar records. */
const CAL_EVENTS = [
  {
    uid: "cal-party",
    summary: "Gargi's 40th planning",
    at: CAL_BASE,
    url: PARTY_URL_CAL,
    organizer: SELF_EMAIL,
    attendees: [PEOPLE[0].email, PEOPLE[1].email], // {me,gargi,mansi} = the chat
  },
  {
    // TRAP — same url DOMAIN as "Weekend plans"' link, different URL; shares
    // me+Rohan with that chat, Jaccard 2/5 = 0.4 < 0.6.
    uid: "cal-quarterly",
    summary: "Quarterly sync",
    at: CAL_BASE + 2 * HOUR,
    url: "https://meet.example.com/quarterly-sync",
    organizer: SELF_EMAIL,
    attendees: [PEOPLE[2].email, "u3@x.com", "u4@x.com", "u5@x.com"],
  },
  {
    // TRAP — no URL; shares me+Gargi with the party chat, Jaccard 2/6 = 0.33.
    uid: "cal-potluck",
    summary: "Neighbourhood potluck",
    at: CAL_BASE + 4 * HOUR,
    url: null,
    organizer: SELF_EMAIL,
    attendees: [PEOPLE[0].email, "priya@x.com", "u1@x.com", "u2@x.com"],
  },
] as const;

function icsFixture(): string {
  const lines = ["BEGIN:VCALENDAR", `X-WR-CALNAME:${CAL_NAME}`];
  for (const ev of CAL_EVENTS) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTART:${icsStamp(ev.at)}`,
      `DTEND:${icsStamp(ev.at + HOUR)}`,
      `SUMMARY:${ev.summary}`,
    );
    if (ev.url !== null) lines.push(`URL:${ev.url}`);
    lines.push(`ORGANIZER;CN=Me:mailto:${ev.organizer}`);
    for (const a of ev.attendees) lines.push(`ATTENDEE:mailto:${a}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

async function ingestCalendar(): Promise<string> {
  const fixturePath = join(tmpDir, "calendar.ics");
  writeFileSync(fixturePath, icsFixture());
  const adapter = new CalendarAdapter({ fixturePath, selfEmail: SELF_EMAIL, home: tmpDir });
  const ingestion = new Ingestion(adapter, { manifest: CALENDAR_MANIFEST });
  ingestion.start();
  await adapter.connect();
  await adapter.backfill("all");
  const stream = getDb()
    .prepare(`SELECT id FROM streams WHERE source_id = ?`)
    .get(CALENDAR_SOURCE_ID) as { id: string };
  return stream.id;
}

// ---------------------------------------------------------------------------
// Stage 3+4 — sessions (each source under its OWN manifest policy) → episodes
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  external_id: string;
  ts: string;
  actor_id: string | null;
  text: string | null;
  link_url: string | null;
  raw_json: string | null;
}

function streamEvents(streamDbId: string): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, external_id, ts, actor_id, text, link_url, raw_json
         FROM events WHERE stream_id = ? ORDER BY ts, id`,
    )
    .all(streamDbId) as EventRow[];
}

const INSERT_SESSION = `
  INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, tz, event_ids,
                        participant_entity_ids, boundary_reason_start, boundary_reason_end,
                        boundary_params_json, seal_mode, content_hash, superseded_hash,
                        hash_version, status, sealed_at, late_arrival)
  VALUES (@id, @streamId, @sourceId, @startedAt, @endedAt, @tz, @eventIds, @participants,
          @boundaryStart, @boundaryEnd, @boundaryParams, @sealMode, @contentHash,
          @supersededHash, @hashVersion, 'sealed', @sealedAt, 0)`;

/**
 * Segment + seal one stream under a policy resolved from its source's OWN
 * manifest, persist the sealed sessions, and run the episode pass (no judge:
 * the engine's safe 1:1 fallback, zero model calls). `participantsOf` maps a
 * session's member events to the entity set that was actually in the room.
 */
function sessionsToEpisodes(opts: {
  streamDbId: string;
  sourceId: string;
  lane: string;
  participantsOf: (memberExtIds: readonly string[]) => string[];
}): { episodes: EpisodeRow[]; modelCalls: number } {
  const manifest = getManifest(opts.sourceId);
  if (manifest === undefined) throw new Error(`no manifest for ${opts.sourceId}`);
  const kind = manifest.stream_kind_of({ external_key: opts.streamDbId, kind: opts.lane });
  const policy = resolvePolicy({
    kind,
    segmentation: manifest.segmentation,
    lane: opts.lane,
    actor_model: manifest.actor_model,
  });

  const rows = streamEvents(opts.streamDbId);
  const dbIdByExt = new Map(rows.map((r) => [r.external_id, r.id]));
  const segEvents: SegEvent[] = rows.map((r) => ({
    external_id: r.external_id,
    ts: r.ts,
    actor: r.actor_id ?? "unknown",
    kind: "message",
    text: r.text ?? "",
  }));
  const walked = segment({
    stream: { key: opts.streamDbId, tz: "Asia/Kolkata", source_id: opts.sourceId },
    policy,
    events: segEvents,
    run_mode: "bootstrap",
  });
  const done = sealStream(walked.sessions, { policy, run_mode: "bootstrap", now: NOW }, textIndex(segEvents));

  const db = getDb();
  const insert = db.prepare(INSERT_SESSION);
  const episodes: EpisodeRow[] = [];
  let modelCalls = 0;
  for (const session of done.sessions) {
    if (session.status !== "sealed") continue;
    const memberDbIds = session.event_ids
      .map((ext) => dbIdByExt.get(ext))
      .filter((v): v is string => v !== undefined);
    insert.run({
      id: session.id,
      streamId: opts.streamDbId,
      sourceId: opts.sourceId,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      tz: session.tz,
      eventIds: JSON.stringify(memberDbIds),
      participants: JSON.stringify([...new Set(opts.participantsOf(session.event_ids))].sort()),
      boundaryStart: session.boundary_reason_start,
      boundaryEnd: session.boundary_reason_end,
      boundaryParams: JSON.stringify(session.boundary_params),
      sealMode: session.seal_mode,
      contentHash: session.content_hash,
      supersededHash: session.superseded_hash,
      hashVersion: session.hash_version,
      sealedAt: session.sealed_at ?? iso(NOW),
    });
    const engineSession = engineSessionOf(session.id);
    if (engineSession === null) throw new Error(`session ${session.id} did not read back`);
    const pass = runEpisodePass(engineSession, { now: NOW, runId: "run_item_5_3" });
    modelCalls += pass.modelCalls;
    episodes.push(...pass.episodes);
  }
  return { episodes, modelCalls };
}

// ---------------------------------------------------------------------------
// Stage 5 — bridge items, from the GENERIC event columns only
// ---------------------------------------------------------------------------

/** An episode as a bridgeable object: its text, its urls, its people. */
function bridgeItemOf(ep: EpisodeRow): BridgeItem {
  const marks = ep.eventIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT text, link_url FROM events WHERE id IN (${marks}) ORDER BY ts, id`)
    .all(...ep.eventIds) as { text: string | null; link_url: string | null }[];
  return {
    id: ep.id,
    source_id: ep.sourceId ?? "",
    object_kind: "episode",
    ts: ep.startedAt,
    text: rows.map((r) => r.text ?? "").join("\n"),
    urls: rows.map((r) => r.link_url).filter((u): u is string => u !== null),
    attendees: ep.entityIds,
  };
}

const ladderEpisodeOf = (ep: EpisodeRow): LadderEpisode => ({
  id: ep.id,
  label: ep.topicLabel,
  sourceId: ep.sourceId,
  anchors: ep.entityIds.map((entityId) => ({ entityId, type: "person" })),
  bridgeIds: [ep.id, ...ep.sessionIds, ...ep.eventIds],
});

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

describe("item 5.3 — cross-source bridges (WhatsApp × Calendar, no core changes)", () => {
  it("bridges the chat and the invite into ONE arc via url/attendee_set at precision 1.0", async () => {
    const world = bindWorld();
    const waStreams = ingestWhatsApp();
    const calStream = await ingestCalendar();

    // ---- sessions → episodes, each source under its own manifest policy.
    let modelCalls = 0;
    const waEpisodes: EpisodeRow[] = [];
    for (const chat of WA_CHATS) {
      const jidByExt = new Map(chat.messages.map((m) => [m.ext, m.jid]));
      const { episodes, modelCalls: calls } = sessionsToEpisodes({
        streamDbId: waStreams.get(chat.extId)!,
        sourceId: WA_SOURCE,
        lane: "group",
        participantsOf: (members) =>
          members.map((ext) => world.entityOf.get(jidByExt.get(ext) ?? "")!).filter((v) => v !== undefined),
      });
      modelCalls += calls;
      waEpisodes.push(...episodes);
    }
    const calByExt = new Map(CAL_EVENTS.map((ev) => [calendarExternalId(CAL_NAME, ev.uid), ev]));
    const calPass = sessionsToEpisodes({
      streamDbId: calStream,
      sourceId: CALENDAR_SOURCE_ID,
      lane: "calendar",
      participantsOf: (members) =>
        members.flatMap((ext) => {
          const record = calByExt.get(ext);
          if (record === undefined) return [];
          return [record.organizer, ...record.attendees].map((email) => world.entityOf.get(email)!);
        }),
    });
    modelCalls += calPass.modelCalls;
    const calEpisodes = calPass.episodes;

    // One episode per WhatsApp sitting, one per calendar record (bounded lane).
    expect(waEpisodes).toHaveLength(2);
    expect(calEpisodes).toHaveLength(3);
    const epParty = waEpisodes.find((e) => e.eventIds.some((id) => id.endsWith("wa-g1")))!;
    const epWeekend = waEpisodes.find((e) => e.eventIds.some((id) => id.endsWith("wa-w1")))!;
    const calEpOf = (uid: string): EpisodeRow =>
      calEpisodes.find((e) => e.eventIds.includes(`calendar:${calendarExternalId(CAL_NAME, uid)}`))!;
    const epInvite = calEpOf("cal-party");
    const epQuarterly = calEpOf("cal-quarterly");
    const epPotluck = calEpOf("cal-potluck");

    // ---- the manifest gate is DATA: attendee_set is live in this run only
    //      because CALENDAR declares it. WhatsApp's manifest never did.
    expect(bridgeKeysFor(WA_SOURCE)).not.toContain("attendee_set");
    expect(bridgeKeysFor(CALENDAR_SOURCE_ID)).toEqual(["url", "attendee_set", "email"]);
    const allItems = [...waEpisodes, ...calEpisodes].map(bridgeItemOf);
    const live = liveBridgeKeys(allItems);
    expect(live.has("attendee_set")).toBe(true);
    expect(live.has("geo_time")).toBe(false); // neither manifest declares it

    // ---- Stage 5: the bridge pass, over episodes of BOTH sources at once.
    const edges = runBridgePass(allItems);

    // Exactly one bridged pair — the chat and its invite — reached two ways.
    const pairs = new Set(edges.map((e) => `${e.left_id}|${e.right_id}`));
    const expectedPair = [epParty.id, epInvite.id].sort().join("|");
    expect([...pairs]).toEqual([expectedPair]);
    expect(edges.map((e) => e.kind).sort()).toEqual(["attendee_set", "url"]);
    const urlEdge = edges.find((e) => e.kind === "url")!;
    expect(urlEdge.value_norm).toBe(PARTY_URL_NORM); // tracking params gone, scheme gone
    expect(urlEdge.decided_by).toBe("code:bridge/url");
    const attendeeEdge = edges.find((e) => e.kind === "attendee_set")!;
    expect(attendeeEdge.value_norm.split("+").sort()).toEqual(
      [world.me, world.entityOf.get(PEOPLE[0].jid)!, world.entityOf.get(PEOPLE[1].jid)!].sort(),
    );

    // MEASURED precision over every bridge the pass produced: 1.0, exactly.
    const correct = [...pairs].filter((p) => p === expectedPair).length;
    expect(correct / pairs.size).toBe(1);

    // ---- Stage 6: arcs. WhatsApp episodes first (bootstrap order): no arcs
    //      exist yet, so both go provisional; reconcile commits them.
    for (const ep of [epParty, epWeekend]) {
      const result = runArcLadder(ladderEpisodeOf(ep), readArcCandidates());
      expect(result.decision).toBe("new");
      modelCalls += result.modelCalls;
      applyLadderResult(result, {
        anchors: ladderEpisodeOf(ep).anchors,
        label: ep.topicLabel,
        sourceId: WA_SOURCE,
        startedAt: ep.startedAt,
        endedAt: ep.endedAt,
        batchId: "wa",
        now: NOW,
      });
    }
    reconcile({ now: NOW, batchId: "wa" });
    const waArcs = readArcs();
    expect(waArcs).toHaveLength(2);
    const partyArc = waArcs.find((a) => arcEpisodeIds(a.id).includes(epParty.id))!;
    const weekendArc = waArcs.find((a) => arcEpisodeIds(a.id).includes(epWeekend.id))!;

    // ---- The calendar invite: rung ① fires. The bridge IS the route, and it
    //      outranks the perfect entity overlap rung ② would also have found.
    const inviteResult = runArcLadder(ladderEpisodeOf(epInvite), readArcCandidates());
    modelCalls += inviteResult.modelCalls;
    expect(inviteResult.decision).toBe("join");
    expect(inviteResult.rung).toBe("bridge");
    expect(inviteResult.arcId).toBe(partyArc.id);
    expect(inviteResult.bridge).not.toBeNull();
    expect(["url", "attendee_set"]).toContain(inviteResult.bridge!.kind);
    expect(inviteResult.bridge!.confidence).toBe(1);
    applyLadderResult(inviteResult, {
      anchors: ladderEpisodeOf(epInvite).anchors,
      label: epInvite.topicLabel,
      sourceId: CALENDAR_SOURCE_ID,
      startedAt: epInvite.startedAt,
      endedAt: epInvite.endedAt,
      batchId: "cal",
      now: NOW,
    });

    // ---- The traps: near-misses must NOT join — not by bridge, not at all.
    for (const trap of [epQuarterly, epPotluck]) {
      const result = runArcLadder(ladderEpisodeOf(trap), readArcCandidates());
      modelCalls += result.modelCalls;
      expect(result.bridge).toBeNull(); // same domain / overlapping room ≠ a literal
      expect(result.overlaps.every((o) => !o.joins)).toBe(true);
      expect(result.decision).toBe("new");
      applyLadderResult(result, {
        anchors: ladderEpisodeOf(trap).anchors,
        label: trap.topicLabel,
        sourceId: CALENDAR_SOURCE_ID,
        startedAt: trap.startedAt,
        endedAt: trap.endedAt,
        batchId: "cal",
        now: NOW,
      });
    }
    reconcile({ now: NOW, batchId: "cal" });

    // ---- The thesis gate's shape: ONE arc spans WhatsApp AND calendar, and
    //      the recorded route on the calendar membership is the bridge.
    const arcs = readArcs();
    const crossSource = arcs.filter(
      (a) => a.sourceIds.includes(WA_SOURCE) && a.sourceIds.includes(CALENDAR_SOURCE_ID),
    );
    expect(crossSource).toHaveLength(1);
    expect(crossSource[0]!.id).toBe(partyArc.id);
    expect(arcEpisodeIds(partyArc.id).sort()).toEqual([epParty.id, epInvite.id].sort());
    expect(crossSource[0]!.sourceIds).toEqual([CALENDAR_SOURCE_ID, WA_SOURCE].sort());

    const membership = getDb()
      .prepare(`SELECT added_by, signal FROM arc_episodes WHERE arc_id = ? AND episode_id = ?`)
      .get(partyArc.id, epInvite.id) as { added_by: string; signal: string | null };
    expect(membership.added_by).toBe("bridge");
    expect(membership.signal).toBe("bridge");

    // The traps ended as their own arcs; the weekend arc stayed single-source.
    expect(weekendArc.sourceIds).toEqual([WA_SOURCE]);
    expect(arcEpisodeIds(weekendArc.id)).toEqual([epWeekend.id]);
    const trapArcs = arcs.filter((a) => {
      const members = arcEpisodeIds(a.id);
      return members.includes(epQuarterly.id) || members.includes(epPotluck.id);
    });
    expect(trapArcs).toHaveLength(2);
    for (const trapArc of trapArcs) expect(trapArc.sourceIds).toEqual([CALENDAR_SOURCE_ID]);

    // ---- Cross-source join precision over the WHOLE run, measured: of every
    //      episode that landed in an arc holding another source's episodes,
    //      all are the intended pair. 1.0, and not a single model call spent.
    const crossJoins: [string, string][] = [];
    for (const arc of arcs) {
      const members = arcEpisodeIds(arc.id);
      const sources = new Set(
        members.map((id) => [...waEpisodes, ...calEpisodes].find((e) => e.id === id)?.sourceId ?? ""),
      );
      if (sources.size > 1) for (const m of members) crossJoins.push([arc.id, m]);
    }
    const intended = new Set([`${partyArc.id}|${epParty.id}`, `${partyArc.id}|${epInvite.id}`]);
    const good = crossJoins.filter(([a, m]) => intended.has(`${a}|${m}`)).length;
    expect(crossJoins.length).toBeGreaterThan(0);
    expect(good / crossJoins.length).toBe(1);

    // ---- Stage 7: promotion — the 5.4 thesis gate names a SPACE, not an
    //      arc. A space is `promoted = 1` on the arcs row, set by the REAL
    //      promotion sweep off a route. The route here is ⚑ cmt: an open
    //      loop the user owns ("finalise the cake order", straight out of
    //      the chat) — fixture-seeded into `loops` exactly where the claims
    //      layer would file it, because loops are a model-rung product and
    //      this run spends zero model calls. Promotion itself is all code.
    getDb()
      .prepare(
        `INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id,
                            state, arc_id, due_utc, stated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "loop-cake",
        "cake-order",
        "finalise the cake order for the surprise party",
        "commitment",
        world.me,
        world.entityOf.get(PEOPLE[0].jid)!,
        "open",
        partyArc.id,
        iso(NOW + 4 * DAY),
        iso(WA_BASE),
      );
    const sweep = promoteArcs({ now: NOW });
    expect(sweep.blockedByParty).toBe(0);
    expect(sweep.justified).toBe(sweep.promoted);

    const spaces = readSpaces();
    const partySpace = spaces.find((s) => s.id === partyArc.id);
    expect(partySpace).toBeDefined();
    expect(partySpace!.promotionReason).toBe("cmt");
    expect(partySpace!.status).toBe("active");
    // The space IS the cross-source arc: its arc spans WhatsApp AND calendar,
    // joined via the url/attendee_set bridge membership asserted above.
    expect(crossSource[0]!.id).toBe(partySpace!.id);
    // Nothing else was promoted — the traps and the weekend chat stay threads.
    for (const s of spaces) expect(s.id).toBe(partyArc.id);

    expect(modelCalls).toBe(0);
  });

  it("replays to the same rows: a second bridge pass writes nothing new", async () => {
    const world = bindWorld();
    const waStreams = ingestWhatsApp();
    await ingestCalendar();
    const chat = WA_CHATS[0]!;
    const jidByExt = new Map(chat.messages.map((m) => [m.ext, m.jid]));
    const { episodes } = sessionsToEpisodes({
      streamDbId: waStreams.get(chat.extId)!,
      sourceId: WA_SOURCE,
      lane: "group",
      participantsOf: (members) =>
        members.map((ext) => world.entityOf.get(jidByExt.get(ext) ?? "")!).filter((v) => v !== undefined),
    });
    const items = episodes.map(bridgeItemOf);

    runBridgePass(items);
    const countAfterFirst = (getDb().prepare(`SELECT COUNT(*) AS n FROM bridges`).get() as { n: number }).n;
    runBridgePass(items);
    const countAfterSecond = (getDb().prepare(`SELECT COUNT(*) AS n FROM bridges`).get() as { n: number }).n;
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

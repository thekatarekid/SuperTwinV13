// ===========================================================================
// Shared fixtures for the scheduler/v6 suites and the BND / GATE eval
// executors: a scratch DB, envelope builders, and world-state seeders (open
// task, active episode, active space with a bridge or an entity). Nothing
// here reaches a model.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";

export const T0 = Date.parse("2026-08-28T12:00:00.000Z");
export const SEC = 1_000;
export const MIN = 60_000;

export interface ScratchDb {
  dir: string;
  close(): void;
}

/** A fresh migrated DB under a temp dir; SUPERTWIN_DB_PATH points at it until close(). */
export function openScratchDb(prefix = "supertwin-v6-"): ScratchDb {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.SUPERTWIN_DB_PATH = join(dir, "st.db");
  closeDb();
  runMigrations();
  return {
    dir,
    close() {
      closeDb();
      delete process.env.SUPERTWIN_DB_PATH;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const streamIdOf = (source: string, streamKey: string): string => `${source}:st:${streamKey}`;

export interface MsgOptions {
  actor?: string;
  origin?: "live" | "backfill";
  source?: string;
  kind?: string;
  extra?: Record<string, unknown>;
  roles?: EventEnvelope["roles"];
}

/** A WhatsApp-shaped message at an absolute time. */
export function msgAt(streamKey: string, atMs: number, text: string, o: MsgOptions = {}): EventEnvelope {
  const actor = o.actor ?? "contact:karan";
  return {
    ts: new Date(atMs).toISOString(),
    source: o.source ?? "wa",
    kind: o.kind ?? "wa.message",
    origin: o.origin ?? "live",
    streamKey,
    actor,
    roles: o.roles ?? { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, ...(o.extra ?? {}) },
  };
}

/** A browser visit at an absolute time; the URL is the bridge key. */
export function visitAt(domain: string, atMs: number, url: string, title: string, day?: string): EventEnvelope {
  const d = day ?? new Date(atMs).toISOString().slice(0, 10);
  return {
    ts: new Date(atMs).toISOString(),
    source: "browser",
    kind: "browser.visit",
    origin: "live",
    streamKey: `browser:chrome:default:${domain}:${d}`,
    actor: "self",
    roles: { sender: "self", audience: [], receiver: [], mentions: [] },
    payload: { text: `${title} ${url}`, url, title },
  };
}

/** A screen frame; identical text = a heartbeat. */
export function screenAt(bundleId: string, atMs: number, text: string, session = "s1"): EventEnvelope {
  return {
    ts: new Date(atMs).toISOString(),
    source: "screen",
    kind: "screen.text",
    origin: "live",
    streamKey: `screen:${bundleId}:${session}`,
    actor: "self",
    roles: { sender: "self", audience: [], receiver: [], mentions: [] },
    payload: { text, app: bundleId },
  };
}

/** Append and return the ids in input order. */
export function append(envs: EventEnvelope[], nowMs = T0): string[] {
  const r = appendEvents(envs, nowMs);
  return r.ids;
}

// ---- World state -----------------------------------------------------------

export function seedSpace(id: string, label: string, status: "active" | "dormant" | "proposed" = "active"): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO spaces (id, label, status, created_by) VALUES (?, ?, ?, 'test')`)
    .run(id, label, status);
}

/** An open task in a space; optional evidence event ids tie it to a stream. */
export function seedOpenTask(id: string, title: string, spaceId: string | null, evidenceEventIds: string[] = []): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, status, evidence_json, created_by)
       VALUES (?, ?, ?, 'explicit', 'open', ?, 'test')`,
    )
    .run(id, spaceId, title, JSON.stringify(evidenceEventIds));
}

/** An episode on a stream; `lastMs` is its last member's time. */
export function seedEpisode(
  id: string,
  streamId: string,
  lastMs: number,
  o: { spaceId?: string | null; state?: "open" | "dormant" | "closed"; eventIds?: string[] } = {},
): void {
  const db = getDb();
  const cut = streamId.indexOf(":st:");
  const source = cut > 0 ? streamId.slice(0, cut) : "wa";
  db.prepare(`INSERT INTO sources (id, type, name) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(source, source, source);
  db.prepare(`INSERT OR IGNORE INTO streams (id, source_id, external_key) VALUES (?, ?, ?)`).run(
    streamId,
    source,
    cut > 0 ? streamId.slice(cut + 4) : streamId,
  );
  db.prepare(
    `INSERT INTO episodes (id, stream_id, space_id, state, summary, first_ts, last_ts, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'test')`,
  ).run(id, streamId, o.spaceId ?? null, o.state ?? "open", `episode ${id}`, new Date(lastMs - MIN).toISOString(), new Date(lastMs).toISOString());
  for (const eid of o.eventIds ?? []) {
    db.prepare(
      `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, event_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`${id}:${eid}`, id, eid, eid, eid);
  }
}

/** A bridge key the space owns (what commit.ts seeds from founding events). */
export function seedSpaceBridge(spaceId: string, kind: string, valueNorm: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO space_bridge_keys (space_id, kind, value_norm) VALUES (?, ?, ?)`)
    .run(spaceId, kind, valueNorm);
}

/** A person with a handle identity, optionally a member of a space. */
export function seedPerson(entityId: string, name: string, handle: string, spaceId?: string): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical, provisional) VALUES (?, 'person', ?, 0)`).run(entityId, name);
  db.prepare(
    `INSERT OR IGNORE INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES (?, ?, 'wa', 'handle', ?)`,
  ).run(`ei_${entityId}`, entityId, handle);
  if (spaceId) {
    db.prepare(`INSERT OR IGNORE INTO space_entities (space_id, entity_id, weight) VALUES (?, ?, 1)`).run(spaceId, entityId);
  }
}

/** Set a stream's tier ('T1'..'T4'). */
export function setStreamTier(streamId: string, tier: "T1" | "T2" | "T3" | "T4"): void {
  getDb().prepare(`UPDATE streams SET tier = ? WHERE id = ?`).run(tier, streamId);
}

export function undispatchedCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE dispatched_at IS NULL`).get() as { n: number }).n;
}

export function dispatchedIds(): Set<string> {
  return new Set(
    (getDb().prepare(`SELECT id FROM events WHERE dispatched_at IS NOT NULL`).all() as { id: string }[]).map((r) => r.id),
  );
}

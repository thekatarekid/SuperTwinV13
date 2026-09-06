// ===========================================================================
// Enrichment — fetches compared by content hash (V6 P1 S5.1; Product_V6_Phase1
// §13.4; Product_V6 §11.10.5).
//
// P1 enrichment is web fetch only: prices, availability, hours. Every refresh
// is a FETCH, hashed in code and compared with the last hash for the same
// (space, kind, url). Only a CHANGED hash reaches the model: the space is
// re-queued for Decide with the fresh snapshot and a decisions row says why.
// An unchanged fetch bumps `fetched_at` / `fetch_count` and nothing else —
// no queue row, no decision, no call (SPC-08).
//
// The fetcher is injected: the executor's web tool in production, a canned
// string in tests. This module never opens a socket itself.
// ===========================================================================

import { createHash, randomBytes } from "node:crypto";

import { enqueueDecide } from "../brain/decide-queue.js";
import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";

export type Fetcher = (url: string) => Promise<string>;

export interface EnrichmentInput {
  spaceId: string;
  /** fare | availability | hours | price | weather | ... — open-ended. */
  kind: string;
  url: string;
  /** The fetched content (already extracted to text by the fetcher). */
  content: string;
  now?: Date;
}

export interface EnrichmentOutcome {
  enrichmentId: string;
  /** True when the hash moved (or this is the first fetch) — the model will see it. */
  changed: boolean;
  first: boolean;
  contentHash: string;
  /** True iff a Decide row was enqueued for the space by this fetch. */
  queued: boolean;
}

export interface EnrichmentRow {
  id: string;
  space_id: string;
  kind: string;
  url: string;
  content_hash: string;
  summary: string | null;
  fetched_at: string;
  changed_at: string;
  fetch_count: number;
}

/** Stable sha256 over normalized whitespace — trivial reflows are not changes. */
export function contentHash(content: string): string {
  const norm = content.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

/** A short snapshot the model sees when the enrichment changed. */
function snapshot(content: string, max = 600): string {
  const norm = content.replace(/\s+/g, " ").trim();
  return norm.length > max ? `${norm.slice(0, max)}…` : norm;
}

/**
 * Record one fetch. Unchanged → bookkeeping only. Changed → snapshot stored,
 * decision written, the space re-queued for Decide (the only path to a call).
 */
export function recordEnrichmentFetch(input: EnrichmentInput): EnrichmentOutcome {
  const db = getDb();
  const nowIso = (input.now ?? new Date()).toISOString();
  const hash = contentHash(input.content);
  const existing = db
    .prepare(`SELECT id, content_hash FROM space_enrichments WHERE space_id = ? AND kind = ? AND url = ?`)
    .get(input.spaceId, input.kind, input.url) as { id: string; content_hash: string } | undefined;

  if (existing && existing.content_hash === hash) {
    db.prepare(
      `UPDATE space_enrichments SET fetched_at = ?, fetch_count = fetch_count + 1 WHERE id = ?`,
    ).run(nowIso, existing.id);
    return { enrichmentId: existing.id, changed: false, first: false, contentHash: hash, queued: false };
  }

  const id = existing?.id ?? `en_${randomBytes(9).toString("hex")}`;
  if (existing) {
    db.prepare(
      `UPDATE space_enrichments
          SET content_hash = ?, summary = ?, fetched_at = ?, changed_at = ?, fetch_count = fetch_count + 1
        WHERE id = ?`,
    ).run(hash, snapshot(input.content), nowIso, nowIso, id);
  } else {
    db.prepare(
      `INSERT INTO space_enrichments (id, space_id, kind, url, content_hash, summary, fetched_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.spaceId, input.kind, input.url, hash, snapshot(input.content), nowIso, nowIso);
  }
  writeDecision({
    pass: "code:enrichment",
    targetKind: "space",
    targetId: input.spaceId,
    action: "enrichment_changed",
    old: existing ? { content_hash: existing.content_hash } : null,
    new: { kind: input.kind, url: input.url, content_hash: hash },
    reason: existing
      ? `${input.kind} at ${input.url} changed — the model sees the new snapshot`
      : `first ${input.kind} fetch for ${input.url}`,
  });
  enqueueDecide(input.spaceId, [], "live");
  return { enrichmentId: id, changed: true, first: !existing, contentHash: hash, queued: true };
}

/** Every enrichment the space tracks, most recently changed first. */
export function enrichmentsFor(spaceId: string): EnrichmentRow[] {
  return getDb()
    .prepare(`SELECT * FROM space_enrichments WHERE space_id = ? ORDER BY changed_at DESC`)
    .all(spaceId) as EnrichmentRow[];
}

export interface RefreshReport {
  spaceId: string;
  fetched: number;
  changed: number;
  failed: number;
}

/**
 * Re-fetch every tracked target for a space through the injected fetcher.
 * Each result goes through `recordEnrichmentFetch`, so an unchanged page
 * still costs zero model calls.
 */
export async function refreshEnrichments(spaceId: string, fetcher: Fetcher, now?: Date): Promise<RefreshReport> {
  const report: RefreshReport = { spaceId, fetched: 0, changed: 0, failed: 0 };
  for (const row of enrichmentsFor(spaceId)) {
    try {
      const content = await fetcher(row.url);
      report.fetched += 1;
      if (recordEnrichmentFetch({ spaceId, kind: row.kind, url: row.url, content, now }).changed) report.changed += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}

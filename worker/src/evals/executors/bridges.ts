// ===========================================================================
// [CODE] Category K executor — the real bridge extractor (build item 2.4).
//
// K is `[CODE]` end to end: there is no model verdict to freeze, so
// `frozen_response` carries a SCENARIO — one `tag|key=value|…` record per line —
// exactly like the accounting and calib executors. Every bridge below comes out
// of `worker/src/bridges/{extract,normalise}.ts` over a real temp SQLite DB with
// real migrations; nothing here re-implements a normal form or a threshold.
//
// Scenario records:
//
//   source|id=browser|keys=url,file_id     a manifest for a source whose
//                                          adapter is not built yet. WhatsApp's
//                                          keys are NOT declared here — they are
//                                          read off the registered manifest, so
//                                          these cases prove the gate is data.
//   expand|from=https://bit.ly/x|to=https://site0.com/x
//                                          a shortlink expansion somebody
//                                          already learned. Bridges never fetch.
//   item|id=e1|source=whatsapp|ts=…|text=… one bridgeable object. Also:
//                                          urls= emails= phones= orders=
//                                          files= media= attendees= lat= lon=
//                                          kind= (event|episode|…)
//
// The pass is run TWICE over the same DB, and `state.replay_stable` reports
// that the second run wrote no new rows — a bridge is content-addressed and
// never expires, so a replay must land on exactly the rows the first run left.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIDGE_KEYS, getManifest, registerSource, type BridgeKey } from "../../adapters/registry.js";
import type { SourceAdapter } from "../../adapters/source-adapter.js";
import { WHATSAPP_MANIFEST } from "../../adapters/whatsapp/manifest.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { bridgeKeysFor, extractBridges, persistBridges, type BridgeItem } from "../../bridges/extract.js";
import type { Executor, Produced } from "../runner.js";

interface ScenarioLine {
  tag: string;
  fields: Record<string, string>;
}

/** Splits on `|`, then on the FIRST `=` — a url keeps its own query string. */
function parseScenario(text: string): ScenarioLine[] {
  const out: ScenarioLine[] = [];
  for (const raw of (typeof text === "string" ? text : "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`bridges scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, fields });
  }
  return out;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function keysOf(value: string | undefined): BridgeKey[] {
  return list(value).map((k) => {
    if (!(BRIDGE_KEYS as readonly string[]).includes(k)) {
      throw new Error(`bridges scenario: ${JSON.stringify(k)} is not one of ${BRIDGE_KEYS.join(" ")}`);
    }
    return k as BridgeKey;
  });
}

/** `makemytrip:NF281…` — the vendor/provider half is optional. */
function prefixed(raw: string): { head: string | null; value: string } {
  const at = raw.indexOf(":");
  if (at === -1) return { head: null, value: raw };
  return { head: raw.slice(0, at), value: raw.slice(at + 1) };
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function itemOf(fields: Record<string, string>): BridgeItem {
  const lat = num(fields.lat);
  const lon = num(fields.lon);
  return {
    id: fields.id ?? "",
    source_id: fields.source ?? "",
    object_kind: fields.kind ?? "event",
    ts: fields.ts ?? null,
    text: fields.text ?? null,
    urls: list(fields.urls),
    emails: list(fields.emails),
    phones: list(fields.phones),
    order_ids: list(fields.orders).map((o) => {
      const { head, value } = prefixed(o);
      return { vendor: head, value };
    }),
    file_ids: list(fields.files).map((f) => {
      const { head, value } = prefixed(f);
      return { provider: head, value };
    }),
    media_work_ids: list(fields.media),
    attendees: list(fields.attendees),
    geo: lat !== null && lon !== null ? { lat, lon } : null,
  };
}

export const bridgesExecutor: Executor = ({ response }) => {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-bridges-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return runScenario(response);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

function runScenario(response: string): Produced {
  runMigrations();
  // The real manifest, through the real registry — this is what makes
  // `bridge_keys` data rather than a constant in the extractor. The registry is
  // process-wide and a source registers once, so a second case finds it there.
  if (!getManifest(WHATSAPP_MANIFEST.source_id)) {
    registerSource({
      manifest: WHATSAPP_MANIFEST,
      adapter: { sourceId: WHATSAPP_MANIFEST.source_id, sourceType: "whatsapp" } as unknown as SourceAdapter,
    });
  }

  const declared = new Map<string, BridgeKey[]>();
  const expansions = new Map<string, string>();
  const items: BridgeItem[] = [];

  for (const { tag, fields } of parseScenario(response)) {
    switch (tag) {
      case "source":
        declared.set(fields.id ?? "", keysOf(fields.keys));
        break;
      case "expand":
        if (fields.from && fields.to) expansions.set(fields.from, fields.to);
        break;
      case "item":
        items.push(itemOf(fields));
        break;
      default:
        throw new Error(`bridges scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  // The live kind set: the union over the sources present. A registered source
  // narrows to its manifest, a scenario-declared source to its declaration, and
  // a source with neither narrows nothing.
  const live = new Set<BridgeKey>();
  for (const sourceId of new Set(items.map((i) => i.source_id))) {
    for (const key of declared.get(sourceId) ?? bridgeKeysFor(sourceId) ?? BRIDGE_KEYS) live.add(key);
  }

  const opts = { keys: [...live], expansions };
  const edges = extractBridges(items, opts);
  const inserted = persistBridges(edges);
  // Replay: the same pass, over the DB it already wrote.
  const replayEdges = extractBridges(items, opts);
  const replayInserted = persistBridges(replayEdges);

  const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM bridges`).get() as { n: number };
  const kinds = [...new Set(edges.map((e) => e.kind))].sort();

  return {
    output: {
      bridges: edges.map((e) => ({
        kind: e.kind,
        value: e.value_norm,
        left: e.left_id,
        right: e.right_id,
      })),
    },
    state: {
      bridges: edges.length,
      kinds,
      rows: rows.n,
      model_calls: 0,
      live_keys: [...live].sort(),
      replay_stable: replayInserted === 0 && replayEdges.length === edges.length,
      confidence_min: edges.length === 0 ? null : Math.min(...edges.map((e) => e.confidence)),
    },
    metrics: {
      bridges: edges.length,
      rows: rows.n,
      inserted,
      model_calls: 0,
    },
  };
}

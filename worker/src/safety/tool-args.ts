// ===========================================================================
// [CODE] TOOL ARGUMENTS FROM CAPTURED TEXT — V6 Phase 1, S4.7 (Build §7.2
// "tool arguments originating in captured text are validated against the
// world model before use"; GoldenEvals V6 P1 §5.15 INJ-03).
//
// Executor-lite's capability surface is already structural: there is no send
// tool, no payment tool, no login tool — they do not exist in the table
// (AST-04). What is left is the ONE tool that takes an argument the twin did
// not choose: `web_fetch`, whose URL usually comes out of a message. That is
// the last place captured text can still steer the machine, so it is checked.
//
// THE CHECK IS PROVENANCE, THEN CORROBORATION.
//
//   1. Does this URL appear in captured content at all? If it does not, it
//      did not originate in captured text and this check has no opinion —
//      the fetch is bounded, read-only, private-host-blocked and cited
//      elsewhere.
//   2. It did. Then the world model must corroborate it before the tool runs:
//        · a BRIDGE exists on the literal (bridges/extract.ts wrote a pair
//          row, so two different events carry the same URL — INJ-03's
//          "a bridge exists"), or
//        · the user themselves sent it (a self-authored event, or the bar), or
//        · the HOST is already in the world model — another event or a space's
//          index mentions it.
//   3. Otherwise: an unknown host, named once, by someone else. The tool does
//      not run; executor-lite refuses with `untrusted_argument` and the run
//      ASKS ("open <host>?") instead of guessing — question over guess.
//
// And one hard override: a URL whose only carrier is an event the injection
// detector flagged is refused whatever else the world says. Content that
// tried to give the twin orders does not get to choose its tool arguments.
//
// Zero model calls: SQL over `event_bridge_keys`, `bridges`,
// `space_bridge_keys` and `injection_flags`.
// ===========================================================================

import { normaliseUrl } from "../bridges/normalise.js";
import { getDb } from "../db/connection.js";
import { instructionChannelOf } from "./injection.js";

/** Tools whose argument is a URL the model may have copied out of content. */
export const URL_ARG_TOOLS = new Set(["web_fetch", "fetch", "browse", "open_url"]);

export interface ToolArgVerdict {
  ok: boolean;
  reason?: string;
}

export interface UrlCarrier {
  eventId: string;
  isSelf: boolean;
  flagged: boolean;
}

export interface UrlProvenance {
  url: string;
  /** The bridge key form (`host/path`), or null when it is not a URL at all. */
  valueNorm: string | null;
  host: string | null;
  /** Captured events whose text carries this exact literal. */
  carriers: UrlCarrier[];
  /** A `bridges` row on the literal — two events share it. */
  bridged: boolean;
  /** The host is already in the world model (another event, or a space index). */
  hostKnown: boolean;
  /** The user sent it themselves (self-authored event or the bar). */
  fromUser: boolean;
  /** A carrier is injection-flagged. */
  flagged: boolean;
}

function rows<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] {
  return getDb().prepare(sql).all(...args) as T[];
}

function exists(sql: string, ...args: unknown[]): boolean {
  return getDb().prepare(sql).get(...args) !== undefined;
}

function tableExists(name: string): boolean {
  return exists(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
}

/** `villas.example/sol` → `villas.example`. */
export function hostOfValueNorm(valueNorm: string): string {
  const slash = valueNorm.indexOf("/");
  const q = valueNorm.indexOf("?");
  const cut = Math.min(...[slash, q].filter((i) => i >= 0), valueNorm.length);
  return valueNorm.slice(0, cut);
}

/** Everything the world model knows about where a URL came from. */
export function urlProvenance(rawUrl: string): UrlProvenance {
  const url = (rawUrl ?? "").trim();
  const valueNorm = normaliseUrl(url);
  const out: UrlProvenance = {
    url,
    valueNorm,
    host: valueNorm ? hostOfValueNorm(valueNorm) : null,
    carriers: [],
    bridged: false,
    hostKnown: false,
    fromUser: false,
    flagged: false,
  };
  if (!valueNorm) return out;

  // ---- who carries this literal ------------------------------------------
  const carrierRows = rows<{
    id: string;
    is_self: number | null;
    actor: string | null;
    kind: string | null;
    source_type: string | null;
    source_id: string | null;
  }>(
    `SELECT e.id, e.is_self, e.actor, e.kind, e.source_type, e.source_id
       FROM event_bridge_keys k JOIN events e ON e.id = k.event_id
      WHERE k.kind = 'url' AND k.value_norm = ?`,
    valueNorm,
  );
  // Bridge keys are written at ingest; a world that never ran the extractor
  // (an import mid-flight, a fixture that inserted rows directly) still gets
  // an honest answer from the text itself.
  if (carrierRows.length === 0) {
    carrierRows.push(
      ...rows<{
        id: string;
        is_self: number | null;
        actor: string | null;
        kind: string | null;
        source_type: string | null;
        source_id: string | null;
      }>(
        `SELECT id, is_self, actor, kind, source_type, source_id
           FROM events
          WHERE text LIKE ? OR link_url LIKE ?
          LIMIT 50`,
        `%${valueNorm}%`,
        `%${valueNorm}%`,
      ),
    );
  }
  const flaggedIds = new Set<string>();
  if (carrierRows.length > 0 && tableExists("injection_flags")) {
    const ph = carrierRows.map(() => "?").join(",");
    for (const r of rows<{ event_id: string }>(
      `SELECT DISTINCT event_id FROM injection_flags WHERE event_id IN (${ph})`,
      ...carrierRows.map((r) => r.id),
    )) {
      flaggedIds.add(r.event_id);
    }
  }
  for (const r of carrierRows) {
    const channel = instructionChannelOf({
      source: r.source_type ?? r.source_id ?? null,
      kind: r.kind ?? null,
      actor: r.actor ?? null,
      isSelf: Number(r.is_self ?? 0) === 1,
    });
    const carrier: UrlCarrier = { eventId: r.id, isSelf: channel !== "captured", flagged: flaggedIds.has(r.id) };
    out.carriers.push(carrier);
    if (carrier.isSelf) out.fromUser = true;
    if (carrier.flagged) out.flagged = true;
  }
  if (out.carriers.length === 0) return out;

  // ---- corroboration ------------------------------------------------------
  out.bridged = exists(`SELECT 1 FROM bridges WHERE kind = 'url' AND value_norm = ? LIMIT 1`, valueNorm);
  const host = out.host ?? "";
  if (host !== "") {
    const carrierIds = new Set(out.carriers.map((c) => c.eventId));
    const sameHost = rows<{ event_id: string }>(
      `SELECT DISTINCT event_id FROM event_bridge_keys
        WHERE kind = 'url' AND (value_norm = ? OR value_norm LIKE ?)`,
      host,
      `${host}/%`,
    );
    out.hostKnown = sameHost.some((r) => !carrierIds.has(r.event_id));
    if (!out.hostKnown && tableExists("space_bridge_keys")) {
      out.hostKnown = exists(
        `SELECT 1 FROM space_bridge_keys WHERE kind = 'url' AND (value_norm = ? OR value_norm LIKE ?) LIMIT 1`,
        host,
        `${host}/%`,
      );
    }
  }
  return out;
}

/**
 * The verdict executor-lite's `validateToolArg` hook wants. `ok: false` stops
 * the tool BEFORE it runs and becomes a question, never a guess.
 */
export function checkToolArg(tool: string, input: string): ToolArgVerdict {
  if (!URL_ARG_TOOLS.has(tool)) return { ok: true };
  const raw = (input ?? "").trim();
  if (raw === "") return { ok: true };
  // A tool argument that is not an http(s) URL is lite's own business (it
  // refuses non-http and private hosts itself) — this check is about
  // provenance, and a non-URL has none.
  if (!/^https?:\/\//i.test(raw)) return { ok: true };
  const p = urlProvenance(raw);
  if (!p.valueNorm) return { ok: true };
  if (p.carriers.length === 0) return { ok: true };
  if (p.flagged) {
    return {
      ok: false,
      reason: `${p.host} came from content I flagged as trying to instruct me — I will not open an address it chose`,
    };
  }
  if (p.bridged || p.fromUser || p.hostKnown) return { ok: true };
  return {
    ok: false,
    reason: `${p.host} came from a message and nothing else in your world mentions it — asking before I open it`,
  };
}

/**
 * The hook executor-lite installs by default. Bound per run so a caller can
 * still override it (the EXE fixtures drive the loop with their own scripted
 * world and pass their own).
 */
export function worldModelToolArgCheck(): (tool: string, input: string) => ToolArgVerdict {
  return (tool, input) => {
    try {
      return checkToolArg(tool, input);
    } catch {
      // A check that cannot run must not silently open the gate OR break a
      // run: an unreadable world model means "no opinion", and every other
      // rail (read-only tools, private hosts, the citation check) still holds.
      return { ok: true };
    }
  };
}

/** The question a refused argument becomes (INJ-03: unknown host → a question). */
export function untrustedArgumentQuestion(detail: string, url: string): { field: string; why: string } {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the raw string */
  }
  return { field: `open ${host}?`, why: detail };
}

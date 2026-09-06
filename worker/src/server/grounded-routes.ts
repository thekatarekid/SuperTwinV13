// ===========================================================================
// [CODE] Timeline + grounded-bar routes (build P4.1, spec §14.3.1 / §14.8).
//
//   GET  /api/timeline            paged event-log read (filters + grouping)
//   GET  /api/timeline/days       per-day counts + sources (the day scrubber)
//   GET  /api/bar/search?q=       live results while typing (state ② — no model)
//   POST /api/bar                 one submission: route.v1 → the bar turn
//   GET  /api/bar/threads         past threads (⌘↑ history, USR-06)
//   GET  /api/bar/threads/:id     one thread's messages (reopen + continue)
//
// Timeline rows group micro-events (a 12-message burst, a visit chain) into
// one line per stream per 30-minute window; every row shows its filing chip
// (the space its episode filed under). The bar's model calls are injectable
// so route tests stay offline; production uses the traced runners.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import {
  runBarTurn,
  type BarDeps,
  type BarLockRef,
  type BarTurnResult,
} from "../grounded/bar.js";
import {
  applyPendingAction,
  handleSearch,
  type BarModelCall,
  type CitationResolver,
} from "../grounded/handlers.js";
import type { IntentRouter } from "../grounded/router.js";
import {
  appendBarMessage,
  listThreads,
  mintThreadId,
  readThread,
} from "../grounded/threads.js";
import { parseActionOutput, type ParsedBarAction } from "../prompts/bar-action.v1.js";
import { TYPEAHEAD_BUDGET_MS, typeahead } from "../retrieval/typeahead.js";

// ---------------------------------------------------------------------------
// Plumbing (same shape as every other route module)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Injectable model seams — production defaults are the traced runners.
 * `route` + `answerCall` are the P4.1 four-way seam, kept so the route tests
 * and the USR eval executor drive the legacy path unchanged; `planner` /
 * `judge` / `general` are the V6 bar's three (P-08, P-09, P-14).
 */
export interface GroundedDeps {
  route?: IntentRouter;
  answerCall?: BarModelCall;
  actionCall?: BarModelCall;
  planner?: BarDeps["planner"];
  judge?: BarDeps["judge"];
  general?: BarDeps["general"];
  correctionParser?: BarDeps["correctionParser"];
  reranker?: BarDeps["reranker"];
  listLimit?: BarDeps["listLimit"];
  resolveCitation?: CitationResolver;
}

/** The one line the twin says back — what the thread and the shelf show. */
function twinLine(turn: BarTurnResult): string {
  if (turn.answer) return turn.answer.answer;
  if (turn.action) {
    return turn.action.status === "needs_input" ? turn.action.question ?? turn.action.summary : turn.action.summary;
  }
  return turn.summary ?? "";
}

function readLock(raw: unknown): BarLockRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : "";
  const id = typeof r.id === "string" ? r.id : "";
  if (kind === "" || id === "") return null;
  return { kind: kind as BarLockRef["kind"], id, label: typeof r.label === "string" ? r.label : id };
}

/** The lock the thread carries: whatever the last twin line locked onto. */
function lockFromThread(threadId: string): BarLockRef | null {
  const messages = readThread(threadId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "twin" || !m.meta) continue;
    const lock = readLock(m.meta.lock);
    if (lock) return lock;
  }
  return null;
}

/** The ask-once question still open on this thread, if any. */
function pendingFromThread(threadId: string): {
  question: string;
  options: { id: string; label: string }[];
  action: ParsedBarAction;
} | null {
  const messages = readThread(threadId);
  const last = messages.filter((m) => m.role === "twin").at(-1);
  const outcome = last?.meta?.outcome as
    | { status?: string; question?: string; options?: { id: string; label: string }[]; pending?: unknown }
    | undefined;
  if (!outcome || outcome.status !== "needs_input" || !Array.isArray(outcome.options)) return null;
  const action = parseActionOutput(JSON.stringify(outcome.pending ?? null) ?? "");
  if (!action) return null;
  return { question: outcome.question ?? "which one?", options: outcome.options, action };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** Micro-events group into one row when same stream + gap under 30 min. */
const GROUP_GAP_MS = 30 * 60 * 1000;
/** Raw events fetched per page before grouping. */
const RAW_FETCH = 400;
const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;

interface RawTimelineEvent {
  id: string;
  ts: string;
  source_type: string | null;
  kind: string | null;
  text: string | null;
  stream_id: string | null;
  stream_key: string | null;
  actor_name: string | null;
  chat_name: string | null;
  space_id: string | null;
  space_label: string | null;
}

export interface TimelineRow {
  /** First (newest) event id in the group — the modal anchor. */
  id: string;
  ts: string;
  end_ts: string;
  source: string;
  kind: string | null;
  actor: string | null;
  chat: string | null;
  /** Newest event's text, truncated. */
  text: string;
  count: number;
  event_ids: string[];
  space_id: string | null;
  space_label: string | null;
}

/**
 * One page of the rendered event log, newest first. Filters: source (exact
 * source_type), person (actor name LIKE), space (filed under that space via
 * its episodes), q (FTS-free LIKE — the bar owns real search). `before` is
 * an exclusive ts cursor for paging.
 */
export function timelinePage(opts: {
  before?: string;
  limit?: number;
  source?: string;
  person?: string;
  space?: string;
  q?: string;
}): { rows: TimelineRow[]; next_before: string | null } {
  const db = getDb();
  const where: string[] = ["e.ts IS NOT NULL"];
  const params: unknown[] = [];
  if (opts.before) {
    where.push("e.ts < ?");
    params.push(opts.before);
  }
  if (opts.source) {
    where.push("e.source_type = ?");
    params.push(opts.source);
  }
  if (opts.person) {
    where.push("(a.display_name LIKE ? OR e.actor_raw LIKE ?)");
    params.push(`%${opts.person}%`, `%${opts.person}%`);
  }
  if (opts.q) {
    where.push("e.text LIKE ?");
    params.push(`%${opts.q}%`);
  }
  // The filing chip: which space this event's episode filed it under. One
  // correlated lookup per row over the episode_events rowid ranges.
  const spaceSelect = /* sql */ `
    (SELECT ep.space_id FROM episode_events ee
       JOIN episodes ep ON ep.id = ee.episode_id
      WHERE ep.space_id IS NOT NULL
        AND e.rowid BETWEEN ee.start_rowid AND ee.end_rowid
      LIMIT 1)`;
  if (opts.space) {
    where.push(`${spaceSelect} = ?`);
    params.push(opts.space);
  }
  const raw = db
    .prepare(
      `SELECT e.id, e.ts, e.source_type, e.kind, e.text,
              e.stream_id, e.stream_key,
              a.display_name AS actor_name,
              c.name         AS chat_name,
              ${spaceSelect}  AS space_id
         FROM events e
         LEFT JOIN actors a   ON a.id = e.actor_id
         LEFT JOIN channels c ON c.id = e.channel_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.ts DESC
        LIMIT ?`,
    )
    .all(...params, RAW_FETCH) as RawTimelineEvent[];

  // Resolve space labels once per distinct id.
  const labelById = new Map<string, string>();
  for (const r of raw) {
    if (r.space_id && !labelById.has(r.space_id)) {
      const row = db.prepare(`SELECT label FROM spaces WHERE id = ?`).get(r.space_id) as
        | { label: string }
        | undefined;
      labelById.set(r.space_id, row?.label ?? r.space_id);
    }
  }

  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_ROW_LIMIT), MAX_ROW_LIMIT);
  const rows: TimelineRow[] = [];
  let consumed = 0;
  let i = 0;
  while (i < raw.length && rows.length < limit) {
    const head = raw[i]!;
    const groupKey = head.stream_key ?? head.stream_id ?? head.id;
    const ids: string[] = [head.id];
    let end = i;
    while (end + 1 < raw.length) {
      const next = raw[end + 1]!;
      const nextKey = next.stream_key ?? next.stream_id ?? next.id;
      if (nextKey !== groupKey) break;
      const gap = Date.parse(raw[end]!.ts) - Date.parse(next.ts);
      if (!Number.isFinite(gap) || gap > GROUP_GAP_MS) break;
      ids.push(next.id);
      end += 1;
    }
    const tail = raw[end]!;
    rows.push({
      id: head.id,
      ts: head.ts,
      end_ts: tail.ts,
      source: head.source_type ?? "unknown",
      kind: head.kind,
      actor: head.actor_name,
      chat: head.chat_name,
      text: (head.text ?? "").slice(0, 200),
      count: ids.length,
      event_ids: ids,
      space_id: head.space_id,
      space_label: head.space_id ? labelById.get(head.space_id) ?? null : null,
    });
    consumed = end + 1;
    i = end + 1;
  }
  const exhausted = raw.length < RAW_FETCH && consumed >= raw.length;
  const next_before = exhausted || consumed === 0 ? null : raw[consumed - 1]!.ts;
  return { rows, next_before };
}

/** Per-day counts for the scrubber + the distinct sources for the filter. */
export function timelineDays(days = 90): {
  days: { day: string; count: number }[];
  sources: string[];
} {
  const db = getDb();
  const dayRows = db
    .prepare(
      `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS count
         FROM events WHERE ts IS NOT NULL
        GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(days) as { day: string; count: number }[];
  const sourceRows = db
    .prepare(
      `SELECT DISTINCT source_type FROM events
        WHERE source_type IS NOT NULL ORDER BY source_type`,
    )
    .all() as { source_type: string }[];
  return { days: dayRows, sources: sourceRows.map((r) => r.source_type) };
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

export async function handleGroundedRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GroundedDeps = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // ---- Timeline -----------------------------------------------------------
  if (method === "GET" && path === "/api/timeline") {
    const limitRaw = Number(url.searchParams.get("limit"));
    sendJson(res, 200, timelinePage({
      before: url.searchParams.get("before") ?? undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      source: url.searchParams.get("source") ?? undefined,
      person: url.searchParams.get("person") ?? undefined,
      space: url.searchParams.get("space") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    }));
    return true;
  }

  if (method === "GET" && path === "/api/timeline/days") {
    sendJson(res, 200, timelineDays());
    return true;
  }

  // ---- Bar: T0 type-ahead (S2.7) — events, episodes, spaces, tasks, people,
  // claims; SQLite only, no model, under 150 ms. `took_ms` rides on the body.
  if (method === "GET" && path === "/api/bar/typeahead") {
    const q = url.searchParams.get("q") ?? "";
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const result = typeahead(q, Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {});
    if (result.took_ms > TYPEAHEAD_BUDGET_MS) {
      console.warn(`[bar] type-ahead over budget: ${result.took_ms} ms > ${TYPEAHEAD_BUDGET_MS} ms for ${JSON.stringify(q)}`);
    }
    sendJson(res, 200, result);
    return true;
  }

  // ---- Bar: live search while typing (no model, no thread) ---------------
  if (method === "GET" && path === "/api/bar/search") {
    const q = url.searchParams.get("q") ?? "";
    if (q.trim() === "") {
      sendJson(res, 200, { events: [], spaces: [] });
      return true;
    }
    sendJson(res, 200, handleSearch(q));
    return true;
  }

  // ---- Bar: history (⌘↑) --------------------------------------------------
  if (method === "GET" && path === "/api/bar/threads") {
    sendJson(res, 200, { threads: listThreads() });
    return true;
  }

  const threadMatch = path.match(/^\/api\/bar\/threads\/([^/]+)$/);
  if (method === "GET" && threadMatch) {
    const id = decodeURIComponent(threadMatch[1]!);
    sendJson(res, 200, { thread_id: id, messages: readThread(id) });
    return true;
  }

  // ---- Bar: one submission ------------------------------------------------
  if (method === "POST" && path === "/api/bar") {
    const body = (await readBody(req)) as
      | {
          text?: unknown;
          thread_id?: unknown;
          /** The object the overlay had open — the thread locks to it. */
          lock?: unknown;
          /** The ask-once answer: the user tapped a space option. */
          answer?: { pending?: unknown; space_id?: unknown };
        }
      | undefined;

    // The held parse coming back with its one-tap answer (USR-03).
    if (body?.answer) {
      const pending = parseActionOutput(JSON.stringify(body.answer.pending ?? null) ?? "");
      const spaceId = typeof body.answer.space_id === "string" ? body.answer.space_id : "";
      if (!pending || spaceId === "") {
        sendJson(res, 400, { error: "answer needs {pending, space_id}" });
        return true;
      }
      const threadId = typeof body.thread_id === "string" && body.thread_id ? body.thread_id : mintThreadId();
      const outcome = applyPendingAction(pending, spaceId);
      appendBarMessage({
        threadId,
        role: "twin",
        text: outcome.summary,
        intent: "action",
        meta: { outcome },
      });
      sendJson(res, 200, { intent: "action", thread_id: threadId, action: outcome });
      return true;
    }

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (text === "") {
      sendJson(res, 400, { error: "text required" });
      return true;
    }
    const threadId = typeof body?.thread_id === "string" && body.thread_id ? body.thread_id : mintThreadId();
    const priorHistory = readThread(threadId).map((m) => ({ role: m.role, text: m.text }));

    // The thread's own state: what it is locked to (BAR-09 — a follow-up is a
    // correction on the object the bar just made, never a second object) and
    // whether an ask-once question is still open on it (BAR-10 / USR-03).
    const lock = readLock(body?.lock) ?? lockFromThread(threadId);
    const turn = await runBarTurn(
      { text, threadId, lock, history: priorHistory, pending: pendingFromThread(threadId) },
      {
        route: deps.route,
        answerCall: deps.answerCall,
        planner: deps.planner,
        judge: deps.judge,
        general: deps.general,
        actionCall: deps.actionCall,
        correctionParser: deps.correctionParser,
        resolveCitation: deps.resolveCitation,
        ...(deps.reranker !== undefined ? { reranker: deps.reranker } : {}),
        ...(deps.listLimit !== undefined ? { listLimit: deps.listLimit } : {}),
      },
    );

    // Search is instantly revisable — nothing persisted, nothing spent. An
    // unlocked correction is guidance, not a mutation, and persists nothing
    // either. Everything else is a real thread (USR-06), and the user's own
    // line lands in the ONE event log on the bar's hot stream, which is how
    // the rest of the utterance reaches the live path (BAR-08).
    const persists = turn.intent === "question" || turn.intent === "action" || turn.correction !== undefined;
    if (persists) {
      appendBarMessage({ threadId, role: "user", text, intent: turn.intent });
      appendBarMessage({
        threadId,
        role: "twin",
        text: twinLine(turn),
        intent: turn.intent,
        meta: {
          ...(turn.answer ? { citations: turn.answer.citations, grounded: turn.answer.grounded } : {}),
          ...(turn.action ? { outcome: turn.action } : {}),
          ...(turn.correction ? { correction: turn.correction } : {}),
          lock: turn.lock,
          chips: turn.chips,
        },
      });
    }

    sendJson(res, 200, {
      intent: turn.intent,
      class: turn.class,
      thread_id: threadId,
      lock: turn.lock,
      chips: turn.chips,
      model_calls: turn.model_calls,
      ...(turn.search ? { search: turn.search } : {}),
      ...(turn.answer ? { answer: turn.answer } : {}),
      ...(turn.action ? { action: turn.action } : {}),
      ...(turn.correction ? { correction: turn.correction } : {}),
      ...(turn.summary ? { summary: turn.summary } : {}),
    });
    return true;
  }

  return false;
}

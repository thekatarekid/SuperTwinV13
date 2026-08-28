// ===========================================================================
// Timeline + grounded-bar routes (build P4.1, spec §14.3.1 / §14.8). No live
// model calls: the intent router and both model calls are injected. Covers
// the paged event-log read (grouping, filters, cursor), the day scrubber,
// and the bar contract — search results, cited answers (with the in-code
// refusal), action outcomes incl. ask-once, and threads as a real surface
// stored in the event log (USR-06).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent } from "../db/eventlog.js";
import { handleGroundedRoute, timelinePage, type GroundedDeps } from "./grounded-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-grounded-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  deps?: GroundedDeps,
): Promise<{ handled: boolean; status: number | null; body: any }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  ) as unknown as IncomingMessage;
  (req as any).method = method;
  (req as any).url = path;
  let status: number | null = null;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const handled = await handleGroundedRoute(req, res, deps);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

function seed(text: string, opts?: { ts?: string; streamKey?: string; source?: string }): string {
  const { id } = appendEvent({
    ts: opts?.ts ?? new Date().toISOString(),
    source: opts?.source ?? "wa",
    kind: `${opts?.source ?? "wa"}.message`,
    origin: "live",
    streamKey: opts?.streamKey ?? "911234@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  });
  return id;
}

describe("GET /api/timeline", () => {
  it("renders the event log newest-first and groups same-stream bursts", async () => {
    // A 3-message burst inside 30 minutes in one chat, one visit elsewhere.
    seed("msg one", { ts: "2026-08-28T10:00:00.000Z" });
    seed("msg two", { ts: "2026-08-28T10:05:00.000Z" });
    seed("msg three", { ts: "2026-08-28T10:10:00.000Z" });
    seed("airbnb.com/rooms/1", { ts: "2026-08-28T11:00:00.000Z", streamKey: "tab:1", source: "browser" });

    const { status, body } = await call("GET", "/api/timeline");
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].source).toBe("browser");
    expect(body.rows[1].source).toBe("wa");
    expect(body.rows[1].count).toBe(3); // the burst is ONE row
    expect(body.rows[1].event_ids).toHaveLength(3);
    expect(body.rows[1].text).toBe("msg three"); // newest of the group leads
  });

  it("filters by source and pages with the before cursor", async () => {
    seed("chat a", { ts: "2026-08-28T09:00:00.000Z" });
    seed("visit", { ts: "2026-08-28T10:00:00.000Z", streamKey: "tab:1", source: "browser" });
    seed("chat b", { ts: "2026-08-28T12:00:00.000Z", streamKey: "915555@g.us" });

    const wa = await call("GET", "/api/timeline?source=wa");
    expect(wa.body.rows.every((r: any) => r.source === "wa")).toBe(true);
    expect(wa.body.rows).toHaveLength(2);

    const paged = await call("GET", "/api/timeline?limit=1");
    expect(paged.body.rows).toHaveLength(1);
    expect(paged.body.next_before).toBe("2026-08-28T12:00:00.000Z");
    const page2 = await call("GET", `/api/timeline?limit=1&before=${encodeURIComponent(paged.body.next_before)}`);
    expect(page2.body.rows[0].ts).toBe("2026-08-28T10:00:00.000Z");
  });

  it("shows the filing chip when an episode filed the event under a space", async () => {
    const evId = seed("pool villa yes", { ts: "2026-08-28T10:00:00.000Z" });
    const db = getDb();
    const rowid = (db.prepare(`SELECT rowid FROM events WHERE id = ?`).get(evId) as any).rowid;
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa', 'Goa trip', 'active')`).run();
    db.prepare(`INSERT INTO episodes (id, space_id, state) VALUES ('ep1', 'sp_goa', 'open')`).run();
    db.prepare(
      `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
       VALUES ('ee1', 'ep1', ?, ?, ?, ?)`,
    ).run(evId, evId, rowid, rowid);

    const { body } = await call("GET", "/api/timeline");
    const row = body.rows.find((r: any) => r.event_ids.includes(evId));
    expect(row.space_id).toBe("sp_goa");
    expect(row.space_label).toBe("Goa trip");

    // The space filter keys off the same filing.
    const filtered = await call("GET", "/api/timeline?space=sp_goa");
    expect(filtered.body.rows).toHaveLength(1);
  });

  it("serves per-day counts + sources for the scrubber", async () => {
    seed("a", { ts: "2026-08-27T10:00:00.000Z" });
    seed("b", { ts: "2026-08-28T10:00:00.000Z", source: "browser", streamKey: "tab:1" });
    const { body } = await call("GET", "/api/timeline/days");
    expect(body.days.map((d: any) => d.day)).toEqual(["2026-08-28", "2026-08-27"]);
    expect(body.sources.sort()).toEqual(["browser", "wa"]);
  });
});

describe("POST /api/bar", () => {
  it("routes search: live results, nothing persisted", async () => {
    seed("anjuna pool villa link");
    const deps: GroundedDeps = { route: async () => "search" };
    const { body } = await call("POST", "/api/bar", { text: "anjuna villa" }, deps);
    expect(body.intent).toBe("search");
    expect(body.search.events.length).toBeGreaterThan(0);
    const threads = await call("GET", "/api/bar/threads");
    expect(threads.body.threads).toHaveLength(0); // search is instantly revisable
  });

  it("routes question: cited answer rides back, thread persisted as events", async () => {
    const evId = seed("max 6k a night yaar for the villa budget");
    const deps: GroundedDeps = {
      route: async () => "question",
      answerCall: async () =>
        `₹6k/night max [1]\nCITATIONS: [{"n":1,"kind":"event","id":"${evId}","label":"rohan · villa"}]`,
    };
    const { body } = await call(
      "POST",
      "/api/bar",
      { text: "what did rohan say about the villa budget?" },
      deps,
    );
    expect(body.intent).toBe("question");
    expect(body.answer.grounded).toBe(true);
    expect(body.answer.citations[0].id).toBe(evId);

    // USR-06: the thread is real — listed, reopenable, stored in the log.
    const threads = await call("GET", "/api/bar/threads");
    expect(threads.body.threads).toHaveLength(1);
    const thread = await call("GET", `/api/bar/threads/${body.thread_id}`);
    expect(thread.body.messages.map((m: any) => m.role)).toEqual(["user", "twin"]);
    // Bar messages are events like everything else (searchable on Timeline).
    const logged = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'bar.message'`)
      .get() as any;
    expect(logged.n).toBe(2);
  });

  it("USR-04 gate holds at the route: an uncited model answer is refused", async () => {
    seed("max 6k a night yaar for the villa budget");
    const deps: GroundedDeps = {
      route: async () => "question",
      answerCall: async () => "I remember it being ₹8k per night.",
    };
    const { body } = await call("POST", "/api/bar", { text: "villa budget?" }, deps);
    expect(body.answer.grounded).toBe(false);
    expect(body.answer.refused_uncited).toBe(true);
    expect(body.answer.citations).toEqual([]);
  });

  it("routes action: outcome applied, continuing in the same thread keeps context", async () => {
    const deps: GroundedDeps = {
      route: async () => "action",
      actionCall: async () =>
        `{"verb":"create_space","title":"Hampi trek Oct","risky":false,"chapters":["Travel"],"first_tasks":["book train"]}`,
    };
    const { body } = await call("POST", "/api/bar", { text: "plan a hampi trek" }, deps);
    expect(body.intent).toBe("action");
    expect(body.action.status).toBe("done");
    expect(body.action.progress).toContain("creating space ✓");
    const space = getDb().prepare(`SELECT * FROM spaces WHERE id = ?`).get(body.action.space_id) as any;
    expect(space.status).toBe("active");
  });

  it("ask-once: needs_input outcome, then the answer applies the held parse", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_a', 'Goa Dec', 'active')`).run();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_b', 'Goa wedding', 'active')`).run();
    const deps: GroundedDeps = {
      route: async () => "action",
      actionCall: async () =>
        `{"verb":"create_task","title":"buy sunscreen","space_candidates":["sp_a","sp_b"],"risky":false}`,
    };
    const first = await call("POST", "/api/bar", { text: "add task: buy sunscreen for goa" }, deps);
    expect(first.body.action.status).toBe("needs_input");
    expect(first.body.action.options).toHaveLength(2);

    const second = await call("POST", "/api/bar", {
      thread_id: first.body.thread_id,
      answer: { pending: first.body.action.pending, space_id: "sp_a" },
    });
    expect(second.body.action.status).toBe("done");
    const task = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(second.body.action.task_id) as any;
    expect(task.space_id).toBe("sp_a");
  });

  it("routes correction (unlocked) to guidance, and rejects empty text", async () => {
    const deps: GroundedDeps = { route: async () => "correction" };
    const { body } = await call("POST", "/api/bar", { text: "that's wrong" }, deps);
    expect(body.intent).toBe("correction");
    expect(body.summary).toContain("Tell the twin");

    const bad = await call("POST", "/api/bar", { text: "" }, deps);
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/bar/search", () => {
  it("serves live results while typing without a model", async () => {
    seed("anjuna pool villa link");
    const { body } = await call("GET", "/api/bar/search?q=anjuna%20villa");
    expect(body.events.length).toBeGreaterThan(0);
    const empty = await call("GET", "/api/bar/search?q=");
    expect(empty.body).toEqual({ events: [], spaces: [] });
  });
});

describe("timelinePage (direct)", () => {
  it("does not group across the 30-minute gap", () => {
    seed("morning", { ts: "2026-08-28T08:00:00.000Z" });
    seed("afternoon", { ts: "2026-08-28T14:00:00.000Z" });
    const { rows } = timelinePage({});
    expect(rows).toHaveLength(2);
  });
});

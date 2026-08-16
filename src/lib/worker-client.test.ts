import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SseParser,
  parseSseFrame,
  streamChat,
  listSessions,
  cancelRun,
  listRuns,
  getLogsInfo,
  revealLogs,
  getBrainInfo,
  revealBrain,
  setProcessEnabled,
  getChatStatus,
  getMediaSettings,
  setMediaSettings,
  getMediaQueue,
  rescanMedia,
  getMediaTools,
  downloadWhisperModel,
  cancelWhisperModel,
  deleteWhisperModel,
  type ProviderStreamEvent,
  type Usage,
} from "./worker-client";

/** All four counts, as the adapter now reports them. */
const USAGE: Usage = {
  inputTokens: 12,
  cacheCreationInputTokens: 10_651,
  cacheReadInputTokens: 48_000,
  outputTokens: 8,
  costUsd: 0.001,
};

// ---------------------------------------------------------------------------
// Build a mock fetch Response whose body is a ReadableStream that yields the
// given text chunks as UTF-8 bytes (mimicking network reads arriving piecemeal).
// ---------------------------------------------------------------------------
function streamResponse(chunks: string[], init?: { ok?: boolean; status?: number }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: "OK",
    body,
  } as unknown as Response;
}

function sse(evt: ProviderStreamEvent): string {
  return `data: ${JSON.stringify(evt)}\n\n`;
}

describe("parseSseFrame", () => {
  it("parses a single data frame", () => {
    const evt = parseSseFrame(`data: ${JSON.stringify({ type: "delta", text: "hi" })}`);
    expect(evt).toEqual({ type: "delta", text: "hi" });
  });

  it("ignores heartbeats and event/id lines", () => {
    expect(parseSseFrame(":\n")).toBeNull();
    expect(parseSseFrame("event: ping\nid: 1")).toBeNull();
  });

  it("joins multiple data lines", () => {
    const frame = `data: {"type":"delta",\ndata: "text":"multi"}`;
    expect(parseSseFrame(frame)).toEqual({ type: "delta", text: "multi" });
  });
});

describe("SseParser incremental buffering", () => {
  it("emits complete frames and holds partial ones across pushes", () => {
    const p = new SseParser();
    // First push: one complete frame + the start of a second (no delimiter yet).
    const first = p.push(sse({ type: "session", sessionId: "s1" }) + `data: {"type":"del`);
    expect(first).toEqual([{ type: "session", sessionId: "s1" }]);

    // Second push completes the JSON that was split mid-object across chunks.
    const second = p.push(`ta","text":"Hel"}\n\n`);
    expect(second).toEqual([{ type: "delta", text: "Hel" }]);
  });

  it("accumulates a delta whose payload is split across two chunks", () => {
    const p = new SseParser();
    const events: ProviderStreamEvent[] = [];
    // "data: {\"type\":\"delta\",\"text\":\"Hello world\"}\n\n" arriving in two reads.
    const full = sse({ type: "delta", text: "Hello world" });
    const mid = Math.floor(full.length / 2);
    events.push(...p.push(full.slice(0, mid)));
    events.push(...p.push(full.slice(mid)));
    expect(events).toEqual([{ type: "delta", text: "Hello world" }]);
  });

  it("flushes a trailing frame with no terminating blank line", () => {
    const p = new SseParser();
    expect(p.push(`data: ${JSON.stringify({ type: "delta", text: "tail" })}`)).toEqual([]);
    expect(p.flush()).toEqual([{ type: "delta", text: "tail" }]);
  });
});

describe("streamChat", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires handlers in order and accumulates text across a split delta", async () => {
    // Sequence: session, delta split across two chunks, delta, usage, done.
    const chunks = [
      sse({ type: "session", sessionId: "sess-1" }),
      // A single logical delta frame cut in half at the chunk boundary:
      `data: {"type":"delta","text":"Hel`,
      `lo, "}\n\n`,
      sse({ type: "delta", text: "world!" }),
      sse({ type: "usage", usage: USAGE }),
      sse({ type: "done", sessionId: "sess-1", usage: USAGE }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const order: string[] = [];
    let text = "";
    let doneSession = "";
    let usageSeen: Usage | null = null;

    await streamChat(
      { runId: "r1", sessionId: null, message: "hi" },
      {
        onSession: (id) => {
          order.push("session");
          expect(id).toBe("sess-1");
        },
        onDelta: (d) => {
          order.push("delta");
          text += d;
        },
        onUsage: (u) => {
          order.push("usage");
          usageSeen = u;
        },
        onDone: (d) => {
          order.push("done");
          doneSession = d.sessionId;
        },
      },
    );

    expect(order).toEqual(["session", "delta", "delta", "usage", "done"]);
    expect(text).toBe("Hello, world!");
    // The frame carries the whole Usage object, cache fields included — the
    // adapter's own numbers, not a two-field slice of them.
    expect(usageSeen).toEqual(USAGE);
    expect(doneSession).toBe("sess-1");

    // Verify POST body shape.
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ runId: "r1", sessionId: null, message: "hi" });
  });

  it("delivers a worker error frame via onError (not thrown)", async () => {
    const chunks = [
      sse({ type: "session", sessionId: "s2" }),
      sse({ type: "error", code: "CANCELLED", message: "run cancelled", sessionId: "s2" }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(chunks)));

    const errors: { code: string; message: string }[] = [];
    await streamChat(
      { runId: "r2", message: "x" },
      { onError: (e) => errors.push({ code: e.code, message: e.message }) },
    );
    expect(errors).toEqual([{ code: "CANCELLED", message: "run cancelled" }]);
  });

  it("throws on a non-OK HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamResponse([], { ok: false, status: 500 })),
    );
    await expect(streamChat({ runId: "r3", message: "x" }, {})).rejects.toThrow(/500/);
  });

  it("resolves cleanly when the fetch is aborted", async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamChat({ runId: "r4", message: "x" }, {}, controller.signal),
    ).resolves.toBeUndefined();
  });
});

describe("plain JSON endpoints", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listSessions GETs and returns the array", async () => {
    const rows = [{ sessionId: "a", title: "t", cwd: "/", status: "active", createdAt: "", updatedAt: "", messageCount: 2 }];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => rows,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(listSessions()).resolves.toEqual(rows);
    // Phase-0 chat sessions moved under /api/chat/ so the V2 surface can own
    // /api/sessions (which returns an object, not this bare array).
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/chat\/sessions$/);
  });

  it("cancelRun POSTs the runId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(cancelRun("run-9")).resolves.toEqual({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/cancel$/);
    expect(JSON.parse(opts.body)).toEqual({ runId: "run-9" });
  });
});

// ---------------------------------------------------------------------------
// Phase 3/4 — task engine + execution client fns
// ---------------------------------------------------------------------------

/** Mock a plain-JSON fetch Response returning `body` from `.json()`. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

describe("brain folder + per-process on/off", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getBrainInfo GETs /api/brain/info and returns { dir, fileCount }", async () => {
    const info = { dir: "/Users/x/SuperTwinV11/brain", fileCount: 42 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(info));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getBrainInfo()).resolves.toEqual(info);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/brain\/info$/);
    expect(opts.method).toBe("GET");
  });

  it("revealBrain POSTs to /api/brain/reveal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(revealBrain()).resolves.toEqual({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/brain\/reveal$/);
    expect(opts.method).toBe("POST");
  });

  it("setProcessEnabled POSTs { role, enabled } and returns the flag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ role: "chat", enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(setProcessEnabled("chat", false)).resolves.toEqual({
      role: "chat",
      enabled: false,
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/settings\/models\/enabled$/);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ role: "chat", enabled: false });
  });
});

describe("runs viewer + logs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listRuns unwraps { runs } and passes the page through", async () => {
    const runs = [
      {
        id: "r1",
        process: "chat",
        model: "opus",
        input_tokens: 10,
        output_tokens: 4,
        duration_ms: 900,
        status: "ok",
        created_at: "2026-07-01T09:00:00Z",
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ runs }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listRuns({ limit: 25, offset: 50 })).resolves.toEqual(runs);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/api\/runs\?limit=25&offset=50$/,
    );
  });

  it("listRuns omits the query string when no page is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ runs: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listRuns()).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/runs$/);
  });

  it("getLogsInfo GETs /api/logs/info and returns { dir, files }", async () => {
    const info = {
      dir: "/Users/x/SuperTwinV11/logs",
      files: [{ name: "worker.log", size: 120, modified: "2026-07-01T09:00:00Z" }],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(info));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLogsInfo()).resolves.toEqual(info);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/logs\/info$/);
  });

  it("revealLogs POSTs to /api/logs/reveal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(revealLogs()).resolves.toEqual({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/logs\/reveal$/);
    expect(opts.method).toBe("POST");
  });
});


describe("chat status + media endpoints", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getChatStatus GETs /api/chat/status and returns { enabled }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getChatStatus()).resolves.toEqual({ enabled: false });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/chat\/status$/);
    expect(opts.method).toBe("GET");
  });

  it("getMediaSettings GETs /api/settings/media", async () => {
    const settings = {
      describe_enabled: true,
      backfill_enabled: false,
      images_enabled: true,
      video_enabled: false,
      business_enabled: false,
      link_scrape_enabled: false,
      rate_per_min: 12,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(settings));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMediaSettings()).resolves.toEqual(settings);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/settings\/media$/);
  });

  it("setMediaSettings POSTs the patch and returns the stored settings", async () => {
    const stored = {
      describe_enabled: true,
      backfill_enabled: true,
      images_enabled: true,
      video_enabled: false,
      business_enabled: false,
      link_scrape_enabled: false,
      rate_per_min: 30,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(stored));
    vi.stubGlobal("fetch", fetchMock);
    await expect(setMediaSettings({ rate_per_min: 30 })).resolves.toEqual(stored);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/settings\/media$/);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ rate_per_min: 30 });
  });

  it("getMediaQueue GETs /api/media/queue", async () => {
    const queue = { pending: 7, done: 120, unsupported: 3, error: 1 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(queue));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMediaQueue()).resolves.toEqual(queue);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/media\/queue$/);
  });

  it("rescanMedia POSTs the requested types and returns every count", async () => {
    const result = { media: 128, links: 4, transcripts: 31, frames: 9 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      rescanMedia(["image", "link", "frames", "transcript"]),
    ).resolves.toEqual(result);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/media\/rescan$/);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      types: ["image", "link", "frames", "transcript"],
    });
  });
});

describe("media toolchain endpoints (v5 §4)", () => {
  afterEach(() => vi.restoreAllMocks());

  const TOOLS = {
    ffmpeg: { path: "/app/bin/ffmpeg", present: true, version: "8.1" },
    whisper: { path: "/app/bin/whisper-cli", present: true, version: "1.9.1" },
    models: [
      {
        id: "tiny",
        label: "Tiny",
        bytes: 77_691_713,
        bundled: false,
        present: false,
        bytesOnDisk: null,
        selected: false,
        download: null,
      },
    ],
    modelsDir: "/Users/x/SuperTwinV11/models",
  };

  it("getMediaTools GETs /api/media/tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TOOLS));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMediaTools()).resolves.toEqual(TOOLS);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/media\/tools$/);
    expect(opts.method).toBe("GET");
  });

  it("downloadWhisperModel POSTs the id and returns the rows it hands back", async () => {
    const body = { id: "tiny", download: null, models: TOOLS.models };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadWhisperModel("tiny")).resolves.toEqual(body);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/media\/models\/download$/);
    expect(JSON.parse(opts.body)).toEqual({ id: "tiny" });
  });

  it("cancelWhisperModel POSTs the id", async () => {
    const body = { id: "tiny", cancelled: true, models: TOOLS.models };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    await expect(cancelWhisperModel("tiny")).resolves.toEqual(body);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/api\/media\/models\/cancel$/,
    );
  });

  it("deleteWhisperModel surfaces the worker's refusal verbatim", async () => {
    // The reason is the whole value of the error: "it is the model in use" and
    // "it ships inside the app" are different problems with different fixes.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: "this is the model transcription uses — select another one first" },
        { ok: false, status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteWhisperModel("tiny")).rejects.toThrow(
      /select another one first/,
    );
  });
});

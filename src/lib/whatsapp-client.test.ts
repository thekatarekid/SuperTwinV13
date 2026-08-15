import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getWhatsappStatus,
  pairWhatsapp,
  importWhatsapp,
  extendWhatsapp,
  pauseWhatsapp,
  logoutWhatsapp,
  resetWhatsapp,
  relinkWhatsapp,
  getInboxChats,
  getChannelMessages,
  searchInbox,
  streamWhatsapp,
  mediaUrl,
  displayName,
  prettyPhone,
  isMaskedNumber,
  type StatusUpdate,
} from "./worker-client";

// The config resolves WORKER_BASE_URL at import time; no window override is set
// in this suite, so it falls back to the localhost default. That's fine — the
// URL assertions below only look at the path suffix.

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function sseResponse(chunks: string[], init?: { ok?: boolean; status?: number }): Response {
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

function frame(f: StatusUpdate): string {
  return `data: ${JSON.stringify(f)}\n\n`;
}

afterEach(() => vi.restoreAllMocks());

describe("mediaUrl", () => {
  it("builds an absolute URL from an eventId", () => {
    expect(mediaUrl("wa:chat/msg1")).toMatch(
      /\/api\/media\/wa%3Achat%2Fmsg1$/,
    );
  });
  it("passes through a leading-slash worker path", () => {
    expect(mediaUrl("/api/media/abc")).toMatch(/\/api\/media\/abc$/);
  });
});

describe("whatsapp JSON endpoints hit the right URL + method", () => {
  it("getWhatsappStatus GETs /api/whatsapp/status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ state: "online", paired: true, paused: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getWhatsappStatus()).resolves.toMatchObject({ paired: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/status$/);
    expect(opts.method).toBe("GET");
  });

  it("pairWhatsapp POSTs /api/whatsapp/pair", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pairWhatsapp()).resolves.toEqual({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/pair$/);
    expect(opts.method).toBe("POST");
  });

  it("importWhatsapp POSTs the chosen range", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await importWhatsapp("30d");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/import$/);
    expect(JSON.parse(opts.body)).toEqual({ range: "30d" });
  });

  it("extendWhatsapp POSTs the chosen range", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await extendWhatsapp("1y");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/extend$/);
    expect(JSON.parse(opts.body)).toEqual({ range: "1y" });
  });

  it("pauseWhatsapp POSTs the paused flag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, paused: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pauseWhatsapp(true)).resolves.toEqual({ ok: true, paused: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/pause$/);
    expect(JSON.parse(opts.body)).toEqual({ paused: true });
  });

  it("logoutWhatsapp POSTs /api/whatsapp/logout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await logoutWhatsapp();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/whatsapp\/logout$/);
  });

  it("resetWhatsapp POSTs /api/whatsapp/reset", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, cleared: { events: 5, channels: 2, actors: 3 } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(resetWhatsapp()).resolves.toMatchObject({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/reset$/);
    expect(opts.method).toBe("POST");
  });

  it("relinkWhatsapp POSTs /api/whatsapp/relink", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(relinkWhatsapp()).resolves.toEqual({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/relink$/);
    expect(opts.method).toBe("POST");
  });

  it("getInboxChats GETs with limit/offset query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await getInboxChats({ limit: 50, offset: 10 });
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /\/api\/inbox\/chats\?limit=50&offset=10$/,
    );
  });

  it("getChannelMessages GETs the channel messages URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await getChannelMessages("ch-1", { limit: 200 });
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /\/api\/inbox\/chats\/ch-1\/messages\?limit=200$/,
    );
  });

  it("searchInbox GETs with the q param", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await searchInbox("hello world", { limit: 20 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/\/api\/inbox\/search\?/);
    expect(url).toMatch(/q=hello\+world/);
    expect(url).toMatch(/limit=20/);
  });
});

describe("displayName / prettyPhone (name fallback)", () => {
  it("keeps a resolved human name as-is", () => {
    expect(displayName("Mom")).toBe("Mom");
    expect(displayName("Family Group")).toBe("Family Group");
  });

  it("pretty-prints an India phone JID instead of showing the raw number", () => {
    expect(displayName("919731006976@s.whatsapp.net")).toBe("+91 97310 06976");
    expect(displayName("919731006976")).toBe("+91 97310 06976");
    expect(prettyPhone("919731006976@s.whatsapp.net")).toBe("+91 97310 06976");
  });

  it("falls back (never invents a name) for empty or group-like ids", () => {
    expect(displayName(null)).toBe("Unknown");
    expect(displayName("")).toBe("Unknown");
    expect(displayName("   ")).toBe("Unknown");
    // A group JID's local part is not a usable phone number → placeholder.
    expect(displayName("120363000000000000@g.us", null, "Unknown chat")).toBe(
      "Unknown chat",
    );
    expect(prettyPhone("120363000000000000@g.us")).toBeNull();
  });

  // R7.3 — masked numbers ("+91········15"). Confirm OUR formatter never emits
  // masking characters (dots/stars): for a normal number it formats plainly; for
  // a LID / odd / already-masked input it returns null or a plain format — never
  // dots. The mask in the field is WhatsApp's own privacy value passed through as
  // the name; we display it as-is (displayName keeps it) but must not ADD masking.
  it("prettyPhone never emits masking characters (dots/stars)", () => {
    const noMask = (v: string | null) => {
      // A returned string may only contain +, digits and spaces.
      if (v !== null) expect(v).toMatch(/^\+[\d ]+$/);
      expect(v ?? "").not.toMatch(/[·•.*]/);
    };

    // Normal number → plain international format (no mask chars).
    noMask(prettyPhone("919731006976"));
    expect(prettyPhone("919731006976")).toBe("+91 97310 06976");

    // A LID identifier (@lid) — local part is a bare number; formats plainly or
    // returns null, but NEVER produces dots.
    noMask(prettyPhone("123456789012345@lid"));

    // Already-masked WhatsApp value → not a usable number → null (we do NOT
    // re-emit the dots, and we certainly don't add more).
    expect(prettyPhone("+91········15")).toBeNull();
    expect(prettyPhone("··········")).toBeNull();
    // A group JID → null (its local part isn't a phone number).
    noMask(prettyPhone("120363000000000000@g.us"));
  });

  it("displayName never renders a masked number as stars (R7.3)", () => {
    // A real name always wins, even if a masked value exists elsewhere.
    expect(displayName("Airtel")).toBe("Airtel");
    // A WhatsApp privacy-masked identifier as the only name is NOT shown as rows
    // of stars — it's not a usable name, so we fall back cleanly. (The daemon now
    // avoids storing these at all; this is the UI safety net.)
    expect(displayName("+91········15")).toBe("Unknown");
    expect(displayName("+91········15", null, "Unknown chat")).toBe("Unknown chat");
    expect(displayName("+91 ***** **015")).toBe("Unknown");
    // The result must never contain mask characters.
    expect(displayName("+91········15")).not.toMatch(/[*·•]/);
  });

  it("isMaskedNumber detects WhatsApp privacy masks, not real names (R7.3)", () => {
    for (const m of ["+91········15", "+91••••••15", "+91 ***** **015", "**********", "··········"]) {
      expect(isMaskedNumber(m)).toBe(true);
    }
    for (const real of ["Mom", "Airtel", "+919731006976", "919731006976", "J.R.", "24.7 Diner"]) {
      expect(isMaskedNumber(real)).toBe(false);
    }
  });
});

describe("streamWhatsapp SSE parsing", () => {
  it("parses status/qr/progress/paired frames and delivers them to onFrame", async () => {
    const chunks = [
      frame({ type: "status", state: "need_pairing" }),
      frame({ type: "qr", code: "QR-DATA-1", timeoutS: 60 }),
      frame({ type: "paired", jid: "123@s", pushName: "Me" }),
      frame({
        type: "progress",
        progress: {
          phase: "backfill",
          chatsDone: 2,
          chatsTotal: 4,
          messages: 40,
          done: false,
        },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(chunks)));

    const seen: StatusUpdate[] = [];
    await new Promise<void>((resolve) => {
      streamWhatsapp(
        (f) => {
          seen.push(f);
        },
        () => {
          // onError fires when the mock stream closes — all frames have arrived.
          resolve();
        },
      );
    });

    expect(seen.map((f) => f.type)).toEqual([
      "status",
      "qr",
      "paired",
      "progress",
    ]);
    const qr = seen.find((f) => f.type === "qr");
    expect(qr).toMatchObject({ code: "QR-DATA-1", timeoutS: 60 });
    const progress = seen.find((f) => f.type === "progress");
    expect(progress).toMatchObject({
      progress: { chatsDone: 2, chatsTotal: 4, messages: 40 },
    });
  });

  it("calls onError when the fetch transport fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const err = await new Promise<Error>((resolve) => {
      streamWhatsapp(
        () => {
          /* no frames */
        },
        (e) => resolve(e),
      );
    });
    expect(err.message).toMatch(/ECONNREFUSED/);
  });
});

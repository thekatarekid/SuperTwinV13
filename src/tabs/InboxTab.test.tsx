import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { act } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InboxTab } from "./InboxTab";
import type {
  WorkerClient,
  AdapterStatus,
  InboxChat,
  InboxMessage,
  SearchHit,
  StatusUpdate,
} from "../lib/worker-client";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// A controllable fake worker client. `streamWhatsapp` records its onFrame/onError
// callbacks so a test can drive SSE frames (qr → paired → progress) by hand,
// exactly like the real stream would. All data methods default to empty and can
// be overridden per test.
// ---------------------------------------------------------------------------
interface StreamHandle {
  onFrame: (f: StatusUpdate) => void;
  onError?: (e: Error) => void;
}

/**
 * The Inbox's own stylesheet, as text. Two of the fixes below live only in CSS
 * — jsdom applies none of it — and both are invisible until someone reads a
 * long chat in a real browser, so they are pinned here rather than nowhere.
 */
function inboxCss(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "styles", "tabs", "inbox.css"), "utf8");
}

function makeClient(overrides: Partial<WorkerClient> = {}) {
  const streams: StreamHandle[] = [];
  const importWhatsapp = vi.fn(async (_r: string) => ({ ok: true }));
  const extendWhatsapp = vi.fn(async (_r: string) => ({ ok: true }));
  const pauseWhatsapp = vi.fn(async (paused: boolean) => ({ ok: true, paused }));
  const pairWhatsapp = vi.fn(async () => ({ ok: true }));
  const resetWhatsapp = vi.fn(async () => ({ ok: true }));
  const relinkWhatsapp = vi.fn(async () => ({ ok: true }));

  const client = {
    // unused chat methods, present for the type
    streamChat: vi.fn(),
    cancelRun: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => {
      throw new Error("nope");
    }),
    getQuota: vi.fn(async () => {
      throw new Error("nope");
    }),
    getHealth: vi.fn(async () => ({ ok: true })),

    // whatsapp
    getWhatsappStatus: vi.fn(
      async (): Promise<AdapterStatus> => ({
        state: "need_pairing",
        paired: false,
        paused: false,
      }),
    ),
    streamWhatsapp: vi.fn(
      (onFrame: (f: StatusUpdate) => void, onError?: (e: Error) => void) => {
        streams.push({ onFrame, onError });
        return () => undefined;
      },
    ),
    pairWhatsapp,
    importWhatsapp,
    extendWhatsapp,
    pauseWhatsapp,
    logoutWhatsapp: vi.fn(async () => ({ ok: true })),
    resetWhatsapp,
    relinkWhatsapp,

    // inbox
    getInboxChats: vi.fn(async (): Promise<InboxChat[]> => []),
    getChannelMessages: vi.fn(async (): Promise<InboxMessage[]> => []),
    searchInbox: vi.fn(async (): Promise<SearchHit[]> => []),
    mediaUrl: (p: string) =>
      p.startsWith("/") ? `http://w${p}` : `http://w/api/media/${p}`,

    ...overrides,
  } as unknown as WorkerClient;

  return {
    client,
    streams,
    importWhatsapp,
    extendWhatsapp,
    pauseWhatsapp,
    pairWhatsapp,
    resetWhatsapp,
    relinkWhatsapp,
  };
}

describe("Inbox onboarding flow", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  it("advances QR → range picker → Inbox (banner, NOT a blocking modal) as the stream drives it", async () => {
    const chats: InboxChat[] = [
      {
        id: "ch-1",
        name: "Mom",
        kind: "dm",
        lastText: "hi honey",
        lastTs: "2026-07-01T10:00:00Z",
        messageCount: 3,
      },
    ];
    const { client, streams, importWhatsapp } = makeClient({
      getInboxChats: vi.fn(async () => chats),
    });

    render(<InboxTab client={client} />);

    // 1. QR step: status is need_pairing/not paired. Drive a qr frame.
    await waitFor(() => expect(streams.length).toBe(1));
    const s = streams[0];
    act(() => s.onFrame({ type: "qr", code: "QR-XYZ", timeoutS: 60 }));
    const qrImg = await screen.findByLabelText("WhatsApp pairing QR code");
    expect(qrImg).toBeTruthy();

    // 2. paired → range picker appears (all 8 ranges).
    act(() => s.onFrame({ type: "paired", jid: "1@s", pushName: "Me" }));
    await screen.findByText("How much history?");
    expect(screen.getByRole("radio", { name: "Last 24 hours" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Entire history" })).toBeTruthy();

    // 3. R5.1: choosing a range + import goes STRAIGHT to the Inbox — NO
    //    blocking "Importing your messages…" full-screen modal.
    fireEvent.click(screen.getByRole("radio", { name: "Last 30 days" }));
    fireEvent.click(screen.getByRole("button", { name: /Import last 30 days/i }));
    await waitFor(() => expect(importWhatsapp).toHaveBeenCalledWith("30d"));

    // The Inbox (chat list) renders immediately; the old blocking modal never
    // appears.
    await waitFor(() =>
      expect(document.querySelector(".inbox__chats")).not.toBeNull(),
    );
    expect(screen.queryByText(/Importing your messages/i)).toBeNull();
    // A non-blocking banner is present instead.
    const banner = document.querySelector(".inbox__import-banner") as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/Importing/i);
    expect(banner.textContent).toMatch(/runs in the background/i);

    // 4. progress frames update the banner counts in place (still no modal).
    act(() =>
      s.onFrame({
        type: "progress",
        progress: {
          phase: "backfill",
          chatsDone: 12,
          chatsTotal: 293,
          messages: 204,
          done: false,
        },
      }),
    );
    await waitFor(() =>
      expect(
        (document.querySelector(".inbox__import-banner") as HTMLElement)
          .textContent,
      ).toMatch(/12\/293 chats · 204 messages/i),
    );
    expect(screen.queryByText(/Importing your messages/i)).toBeNull();

    // 5. backfill_complete clears the banner; the chat list stays.
    act(() =>
      s.onFrame({
        type: "backfill_complete",
        range: "30d",
        chats: 293,
        messages: 204,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".inbox__import-banner")).toBeNull(),
    );
    const list = document.querySelector(".inbox__chats") as HTMLElement;
    expect(within(list).getByText("Mom")).toBeTruthy();
  });
});

/** Wait until the Inbox chat list has rendered (paired + imported). */
async function waitForInbox() {
  await waitFor(() =>
    expect(document.querySelector(".inbox__chats")).not.toBeNull(),
  );
}

// A client already paired + imported, so the Inbox renders immediately.
function pairedClient(overrides: Partial<WorkerClient> = {}) {
  return makeClient({
    getWhatsappStatus: vi.fn(
      async (): Promise<AdapterStatus> => ({
        state: "online",
        paired: true,
        paused: false,
        progress: {
          phase: "backfill",
          chatsDone: 3,
          chatsTotal: 3,
          messages: 30,
          done: true,
        },
      }),
    ),
    ...overrides,
  });
}

describe("Inbox view (paired)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Mom",
      kind: "dm",
      lastText: "call me back",
      lastTs: "2026-07-01T12:00:00Z",
      messageCount: 2,
    },
    {
      id: "ch-2",
      name: "Family",
      kind: "group",
      lastText: "dinner at 8",
      lastTs: "2026-07-02T09:00:00Z",
      messageCount: 5,
    },
  ];

  it("renders the chat list and a selected chat's messages, including an image <img>", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "dinner at 8",
        fromMe: false,
        actorName: "Dad",
      },
      {
        id: "m2",
        ts: "2026-07-02T09:01:00Z",
        kind: "image",
        text: "look",
        fromMe: false,
        actorName: "Dad",
        mediaUrl: "/api/media/m2",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);

    // chat list sorted lastTs desc → Family (07-02) before Mom (07-01)
    await waitForInbox();
    const list = document.querySelector(".inbox__chats") as HTMLElement;
    const names = within(list)
      .getAllByRole("listitem")
      .map((el) => el.querySelector(".inbox__chat-name")?.textContent);
    expect(names).toEqual(["Family", "Mom"]);

    // messages of the auto-selected (first) chat render; image -> <img>
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("dinner at 8")).toBeTruthy(),
    );
    const img = document.querySelector(".inbox__media-img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("http://w/api/media/m2");
  });

  it("R6.5: a media-only chat (messageCount>0, media lastText) shows the label, not 'No messages'", async () => {
    // "Ghar+" / "Kusum ki bagiya" style groups: latest message is media-only, so
    // the worker hands us a kind label as lastText. The row must render that
    // label as-is; the italic "No messages" placeholder must NOT appear.
    const mediaChats: InboxChat[] = [
      {
        id: "ch-media",
        name: "Ghar+",
        kind: "group",
        lastText: "🎥 Video",
        lastTs: "2026-07-02T09:00:00Z",
        messageCount: 4,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => mediaChats),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const list = document.querySelector(".inbox__chats") as HTMLElement;
    const preview = list.querySelector(".inbox__chat-preview") as HTMLElement;
    expect(preview.textContent).toBe("🎥 Video");
    expect(within(list).queryByText("No messages")).toBeNull();

    // Read-only invariant still holds.
    expect(document.querySelector(".chat__composer")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
  });

  it("R6.5: a chat with messageCount===0 shows the 'No messages' placeholder", async () => {
    // Per R4.3 an empty chat shouldn't be listed at all, but if one ever is, the
    // placeholder is driven by messageCount===0 (not an empty lastText).
    const emptyChats: InboxChat[] = [
      {
        id: "ch-empty",
        name: "Silent Group",
        kind: "group",
        lastText: null,
        lastTs: null,
        messageCount: 0,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => emptyChats),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const list = document.querySelector(".inbox__chats") as HTMLElement;
    const placeholder = within(list).getByText("No messages");
    expect(placeholder).toBeTruthy();
    // It's the muted italic placeholder, not real preview text.
    expect(placeholder.classList.contains("inbox__muted")).toBe(true);
  });

  it("search renders FTS hits and clicking one jumps to its chat", async () => {
    const hits: SearchHit[] = [
      {
        eventId: "m9",
        channelId: "ch-2",
        channelName: "Family",
        ts: "2026-07-02T09:00:00Z",
        snippet: "dinner at <b>8</b>",
        text: "dinner at 8",
      },
    ];
    const getChannelMessages = vi.fn(async () => [] as InboxMessage[]);
    const searchInbox = vi.fn(async () => hits);
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages,
      searchInbox,
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const box = screen.getByLabelText("Search messages");
    fireEvent.change(box, { target: { value: "dinner" } });
    fireEvent.submit(box.closest("form")!);

    await waitFor(() => expect(searchInbox).toHaveBeenCalledWith("dinner", { limit: 50 }));
    // result row shows channel name + snippet
    const results = document.querySelector(".inbox__results") as HTMLElement;
    expect(within(results).getByText("Family")).toBeTruthy();

    // clicking the result jumps to ch-2 and loads its LATEST window (R7.1: no
    // cursor, page size 60 — not the old limit:200 oldest-first fetch).
    fireEvent.click(within(results).getByRole("listitem"));
    await waitFor(() =>
      expect(getChannelMessages).toHaveBeenCalledWith("ch-2", { limit: 60 }),
    );
  });

  it("the kill-switch toggle calls pauseWhatsapp", async () => {
    const { client, pauseWhatsapp } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();

    // toggle is checked when Live; unchecking pauses.
    const toggle = screen.getByLabelText("Pause ingestion") as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(pauseWhatsapp).toHaveBeenCalledWith(true));
  });

  it("Extend history opens the range picker and calls extendWhatsapp", async () => {
    const { client, extendWhatsapp } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();

    fireEvent.click(screen.getByRole("button", { name: "Extend history" }));
    // modal with all 8 ranges
    const dialog = await screen.findByRole("dialog", { name: "Extend history" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Last year" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(extendWhatsapp).toHaveBeenCalledWith("1y"));
  });

  // -------------------------------------------------------------------------
  // Shallow-bootstrap honesty. WhatsApp can decline to re-upload the bulk of a
  // linked device's history; the import still "completes" and the Inbox still
  // fills with chats, each holding one message. The old UI said nothing.
  // -------------------------------------------------------------------------

  /** The observed failure: 305 messages, 89 chats, 61 with a single message. */
  const SHALLOW_DEPTH = {
    verdict: "shallow" as const,
    reason: "bootstrap_only" as const,
    chats: 89,
    messages: 305,
    singleMessageChats: 61,
    payloads: 1,
    bulkPayloads: 0,
    syncTypes: ["INITIAL_BOOTSTRAP"],
    messagesSeen: 486,
    messagesEmitted: 292,
    messagesFiltered: 194,
    syncTypesKnown: true,
    checkedAt: "2026-08-17T02:00:00.000Z",
  };

  function depthBanner(): HTMLElement | null {
    return document.querySelector(".inbox__depth-banner");
  }

  it("says WhatsApp sent a short history when the worker judges the import shallow", async () => {
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();
    expect(depthBanner()).toBeNull();

    act(() => streams[0].onFrame({ type: "history_depth", depth: SHALLOW_DEPTH }));

    const banner = await waitFor(() => {
      const el = depthBanner();
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // States what arrived, in the user's terms.
    expect(banner.textContent).toMatch(/305 messages across 89 chats/);
    expect(banner.textContent).toMatch(/61 of them hold a single message/);
    // Names WhatsApp as the decider and clears the user explicitly — a sync the
    // server declined must never read as something they did wrong.
    expect(banner.textContent).toMatch(/WhatsApp decides how much history/i);
    expect(banner.textContent).toMatch(/nothing on your side went wrong/i);
    // Offers the one recovery action that exists, and does NOT offer a re-link.
    expect(
      within(banner).getByRole("button", { name: "Extend history" }),
    ).toBeTruthy();
    expect(within(banner).queryByText(/re-?sync|re-?link|scan/i)).toBeNull();
  });

  it("stays silent on a healthy import and while one is still running", async () => {
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();

    act(() =>
      streams[0].onFrame({
        type: "history_depth",
        depth: {
          ...SHALLOW_DEPTH,
          verdict: "deep",
          reason: "bulk_received",
          messages: 3632,
          singleMessageChats: 35,
          bulkPayloads: 25,
        },
      }),
    );
    await waitFor(() => expect(depthBanner()).toBeNull());

    // A verdict arriving mid-import is premature — the chunks may still be on
    // their way — so the strip waits for the import banner to clear.
    act(() =>
      streams[0].onFrame({
        type: "progress",
        progress: {
          phase: "backfill",
          chatsDone: 1,
          chatsTotal: 90,
          messages: 10,
          done: false,
        },
      }),
    );
    act(() => streams[0].onFrame({ type: "history_depth", depth: SHALLOW_DEPTH }));
    await waitFor(() =>
      expect(document.querySelector(".inbox__import-banner")).not.toBeNull(),
    );
    expect(depthBanner()).toBeNull();
  });

  it("the shallow banner's button opens the extend picker and never re-links", async () => {
    const { client, streams, extendWhatsapp, relinkWhatsapp } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();
    act(() => streams[0].onFrame({ type: "history_depth", depth: SHALLOW_DEPTH }));

    const banner = await waitFor(() => depthBanner() as HTMLElement);
    fireEvent.click(
      within(banner).getByRole("button", { name: "Extend history" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Extend history" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Last 90 days" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Extend" }));

    await waitFor(() => expect(extendWhatsapp).toHaveBeenCalledWith("90d"));
    // WhatsApp grants ONE full history push per link. Nothing on the detection
    // path may spend it.
    expect(relinkWhatsapp).not.toHaveBeenCalled();
  });

  it("reports what an extend actually recovered, including that more may remain", async () => {
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();

    act(() =>
      streams[0].onFrame({
        type: "extend_result",
        outcome: {
          range: "90d",
          startedAt: "2026-08-17T02:10:00.000Z",
          finishedAt: "2026-08-17T02:10:20.000Z",
          running: false,
          chatsPaginated: 41,
          streamsWithNewMessages: 37,
          messagesRecovered: 214,
          mayHaveMore: true,
        },
      }),
    );

    const strip = await waitFor(() => {
      const el = document.querySelector(".inbox__extend-banner");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(strip.textContent).toMatch(/recovered 214 messages across 37 chats/);
    // One click is never exhaustive: on-demand pages cap at 50 per request.
    expect(strip.textContent).toMatch(/up to 50 messages per chat per request/i);

    fireEvent.click(within(strip).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(document.querySelector(".inbox__extend-banner")).toBeNull(),
    );
  });

  it("says plainly when an extend brought nothing back", async () => {
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();

    act(() =>
      streams[0].onFrame({
        type: "extend_result",
        outcome: {
          range: "all",
          startedAt: "2026-08-17T02:20:00.000Z",
          finishedAt: "2026-08-17T02:20:10.000Z",
          running: false,
          chatsPaginated: 12,
          streamsWithNewMessages: 0,
          messagesRecovered: 0,
          mayHaveMore: false,
        },
      }),
    );

    const strip = await waitFor(
      () => document.querySelector(".inbox__extend-banner") as HTMLElement,
    );
    expect(strip.textContent).toMatch(/no older messages came back for 12 chats/i);
    expect(strip.textContent).not.toMatch(/recovered \d/);
  });

  it("restores a persisted shallow verdict from the polled status", async () => {
    // The verdict outlives the SSE frame that announced it, so a reload does not
    // silently drop the user back into an unexplained one-message-per-chat Inbox.
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getWhatsappStatus: vi.fn(
        async (): Promise<AdapterStatus> => ({
          state: "online",
          paired: true,
          paused: false,
          importDone: true,
          historyDepth: SHALLOW_DEPTH,
        }),
      ),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();
    await waitFor(() => expect(depthBanner()).not.toBeNull());
  });

  it("is strictly read-only: no composer / send control anywhere", async () => {
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => [
        {
          id: "m1",
          ts: "2026-07-02T09:00:00Z",
          kind: "message",
          text: "hi",
          fromMe: false,
          actorName: "Dad",
        },
      ]),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();

    // No Send button; no message composer textarea.
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    expect(screen.queryByLabelText(/^message$/i)).toBeNull();
    expect(document.querySelector(".chat__composer")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("range picker completeness", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  it("renders all 8 ranges and imports the chosen one", async () => {
    const { client, streams, importWhatsapp } = makeClient();
    render(<InboxTab client={client} />);
    await waitFor(() => expect(streams.length).toBe(1));
    act(() => streams[0].onFrame({ type: "paired", jid: "1@s", pushName: "Me" }));

    await screen.findByText("How much history?");
    const labels = [
      "Last 24 hours",
      "Last 3 days",
      "Last 7 days",
      "Last 30 days",
      "Last 90 days",
      "Last 180 days",
      "Last year",
      "Entire history",
    ];
    for (const l of labels) {
      expect(screen.getByRole("radio", { name: l })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("radio", { name: "Entire history" }));
    fireEvent.click(screen.getByRole("button", { name: /Import entire history/i }));
    await waitFor(() => expect(importWhatsapp).toHaveBeenCalledWith("all"));
  });
});

// ===========================================================================
// Revision 2 real-device bug fixes.
// ===========================================================================

describe("bug 1 — auto-pair + QR contrast + refresh", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  it("auto-calls pair on mount when not paired (no manual click)", async () => {
    const { client, pairWhatsapp } = makeClient();
    render(<InboxTab client={client} />);
    // Pairing is kicked off automatically once the not-paired status resolves.
    await waitFor(() => expect(pairWhatsapp).toHaveBeenCalledTimes(1));
    // There is NO "Generate pairing code" button anymore.
    expect(
      screen.queryByRole("button", { name: /generate pairing code/i }),
    ).toBeNull();
  });

  it("renders the QR with high-contrast props inside a solid frame", async () => {
    const { client, streams } = makeClient();
    render(<InboxTab client={client} />);
    await waitFor(() => expect(streams.length).toBe(1));
    act(() => streams[0].onFrame({ type: "qr", code: "QR-ABC", timeoutS: 60 }));

    const qr = await screen.findByLabelText("WhatsApp pairing QR code");
    // qrcode.react renders an <svg>; assert the contrast fg/bg reached the DOM.
    // The white module rects use fill=#ffffff; the dark modules use #000000.
    const svg = qr as unknown as SVGElement;
    const fills = Array.from(svg.querySelectorAll("[fill]")).map((n) =>
      (n.getAttribute("fill") || "").toLowerCase(),
    );
    expect(fills).toContain("#ffffff");
    expect(fills).toContain("#000000");
    // It lives inside the solid white .wa-qr frame.
    expect(qr.closest(".wa-qr")).not.toBeNull();
  });

  it("the Refresh QR code button re-triggers pairing", async () => {
    const { client, streams, pairWhatsapp } = makeClient();
    render(<InboxTab client={client} />);
    await waitFor(() => expect(streams.length).toBe(1));
    // one auto-pair already happened
    await waitFor(() => expect(pairWhatsapp).toHaveBeenCalledTimes(1));
    act(() => streams[0].onFrame({ type: "qr", code: "QR-ABC", timeoutS: 60 }));

    fireEvent.click(screen.getByRole("button", { name: /refresh qr code/i }));
    await waitFor(() => expect(pairWhatsapp).toHaveBeenCalledTimes(2));
  });
});

describe("bug 6 — importDone skips the range picker", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  it("goes straight to the Inbox when paired && importDone (no range prompt)", async () => {
    const chats: InboxChat[] = [
      {
        id: "ch-1",
        name: "Mom",
        kind: "dm",
        lastText: "hi",
        lastTs: "2026-07-01T10:00:00Z",
        messageCount: 1,
      },
    ];
    // Paired + importDone, but NO completed progress in the snapshot: importDone
    // alone must be enough to skip the picker (bug 6 on relaunch).
    const { client, pairWhatsapp, importWhatsapp } = makeClient({
      getWhatsappStatus: vi.fn(
        async (): Promise<AdapterStatus> => ({
          state: "online",
          paired: true,
          paused: false,
          importDone: true,
          importRange: "30d",
        }),
      ),
      getInboxChats: vi.fn(async () => chats),
    });

    render(<InboxTab client={client} />);

    await waitForInbox();
    // The range picker must NOT appear…
    expect(screen.queryByText("How much history?")).toBeNull();
    // …and we don't re-pair or re-import an already-set-up account.
    expect(pairWhatsapp).not.toHaveBeenCalled();
    expect(importWhatsapp).not.toHaveBeenCalled();
    const list = document.querySelector(".inbox__chats") as HTMLElement;
    expect(within(list).getByText("Mom")).toBeTruthy();
  });
});

describe("bugs 2 & 3 — ingest nudge + fallback poll refresh", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  it("an ingest SSE frame refetches the chat list (stale → fresh)", async () => {
    const stale: InboxChat[] = [
      {
        id: "ch-1",
        name: "Mom",
        kind: "dm",
        lastText: "old message",
        lastTs: "2026-07-01T10:00:00Z",
        messageCount: 1,
      },
    ];
    const fresh: InboxChat[] = [
      {
        id: "ch-1",
        name: "Mom",
        kind: "dm",
        lastText: "brand new message",
        lastTs: "2026-07-02T10:00:00Z",
        messageCount: 2,
      },
    ];
    let call = 0;
    const getInboxChats = vi.fn(async () => (call++ === 0 ? stale : fresh));
    const { client, streams } = pairedClient({ getInboxChats });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const list = document.querySelector(".inbox__chats") as HTMLElement;
    expect(within(list).getByText("old message")).toBeTruthy();

    // The onboarding hook + inbox subscribe to the same stream; the ingest
    // frame reaches every registered onFrame handler.
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-07-02T10:00:00Z", channels: ["ch-1"] }),
      ),
    );

    await waitFor(() =>
      expect(within(list).getByText("brand new message")).toBeTruthy(),
    );
    expect(within(list).queryByText("old message")).toBeNull();
  });

  it("the fallback poll refetches the chat list on its interval", async () => {
    vi.useFakeTimers();
    try {
      const getInboxChats = vi.fn(async (): Promise<InboxChat[]> => []);
      const { client } = pairedClient({ getInboxChats });
      render(<InboxTab client={client} />);

      // Initial mount load.
      await vi.waitFor(() => expect(getInboxChats).toHaveBeenCalledTimes(1));
      const initial = getInboxChats.mock.calls.length;

      // Advance past the ≤20s fallback interval → at least one more refetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16000);
      });
      expect(getInboxChats.mock.calls.length).toBeGreaterThan(initial);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R3.3 — re-sync from scratch = RE-LINK", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Mom",
      kind: "dm",
      lastText: "hi",
      lastTs: "2026-07-01T10:00:00Z",
      messageCount: 1,
    },
  ];

  it("confirms, calls relinkWhatsapp (NOT reset), and returns to the QR onboarding", async () => {
    // Start paired + importDone (Inbox shows). After relink the daemon unlinks
    // and status moves logged_out → need_pairing; the UI shows the QR screen.
    let statusCall = 0;
    const getWhatsappStatus = vi.fn(async (): Promise<AdapterStatus> => {
      statusCall++;
      return statusCall === 1
        ? {
            state: "online",
            paired: true,
            paused: false,
            importDone: true,
            importRange: "30d",
          }
        : { state: "need_pairing", paired: false, paused: false };
    });
    const { client, relinkWhatsapp, resetWhatsapp } = makeClient({
      getWhatsappStatus,
      getInboxChats: vi.fn(async () => chats),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    // Open the confirm dialog. Copy must be the honest re-link wording.
    fireEvent.click(
      screen.getByRole("button", { name: /re-sync from scratch/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Re-sync from scratch",
    });
    expect(
      within(dialog).getByText(/re-links WhatsApp/i),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/scan the QR code again/i),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /re-link & re-sync/i }));

    // It RE-LINKS (not the silent reset).
    await waitFor(() => expect(relinkWhatsapp).toHaveBeenCalledTimes(1));
    expect(resetWhatsapp).not.toHaveBeenCalled();

    // Back to the QR onboarding — NOT an empty Inbox, NOT the range picker.
    await screen.findByRole("heading", { name: /re-linking whatsapp/i });
    expect(document.querySelector(".inbox__chats")).toBeNull();
    expect(screen.queryByText("How much history?")).toBeNull();
  });

  it("a logged_out/need_pairing status after relink shows the QR screen with a friendly re-linking state (no error flash)", async () => {
    // The relink lands us on the QR step. A qr frame then confirms the QR renders.
    let statusCall = 0;
    const getWhatsappStatus = vi.fn(async (): Promise<AdapterStatus> => {
      statusCall++;
      return statusCall === 1
        ? {
            state: "online",
            paired: true,
            paused: false,
            importDone: true,
            importRange: "30d",
          }
        : { state: "logged_out", paired: false, paused: false };
    });
    const { client, streams } = makeClient({
      getWhatsappStatus,
      getInboxChats: vi.fn(async () => chats),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    fireEvent.click(
      screen.getByRole("button", { name: /re-sync from scratch/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Re-sync from scratch",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /re-link & re-sync/i }));

    // Friendly transient copy, no scary error banner, no empty inbox.
    await screen.findByRole("heading", { name: /re-linking whatsapp/i });
    const status = document.querySelector(".wa-onboard__status") as HTMLElement;
    expect(status.textContent).toMatch(/Re-linking… scan the QR code/i);
    expect(document.querySelector(".wa-onboard__error")).toBeNull();
    expect(document.querySelector(".inbox__chats")).toBeNull();

    // A fresh QR frame arrives → the QR image renders (fresh scan → clean import).
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) => s.onFrame({ type: "qr", code: "QR-RELINK", timeoutS: 60 })),
    );
    expect(await screen.findByLabelText("WhatsApp pairing QR code")).toBeTruthy();
  });

  it("surfaces a visible error if relink fails (worker lag / 404) — dialog stays open", async () => {
    const getWhatsappStatus = vi.fn(
      async (): Promise<AdapterStatus> => ({
        state: "online",
        paired: true,
        paused: false,
        importDone: true,
        importRange: "30d",
      }),
    );
    const relinkWhatsapp = vi.fn(async () => {
      throw new Error("POST /api/whatsapp/relink → 404 Not Found");
    });
    const { client } = makeClient({
      getWhatsappStatus,
      getInboxChats: vi.fn(async () => chats),
      relinkWhatsapp: relinkWhatsapp as unknown as WorkerClient["relinkWhatsapp"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    fireEvent.click(
      screen.getByRole("button", { name: /re-sync from scratch/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Re-sync from scratch",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /re-link & re-sync/i }));

    // A visible error (RELINK_FAILED) is surfaced; we stay on the Inbox (dialog open).
    await waitFor(() =>
      expect(screen.getByText(/RELINK_FAILED/)).toBeTruthy(),
    );
    expect(screen.getByRole("dialog", { name: "Re-sync from scratch" })).toBeTruthy();
  });

  it("stays strictly read-only after a relink transition (no composer / send)", async () => {
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => [
        {
          id: "m1",
          ts: "2026-07-02T09:00:00Z",
          kind: "message",
          text: "hi",
          fromMe: false,
          actorName: "Dad",
        },
      ]),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();

    // The Inbox is read-only regardless of the relink control being present.
    expect(screen.getByRole("button", { name: /re-sync from scratch/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    expect(document.querySelector(".chat__composer")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });
});

// ===========================================================================
// Revision 5.
// ===========================================================================

describe("R5.1 — non-blocking import (banner, never a blocking modal)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Mom",
      kind: "dm",
      lastText: "hi",
      lastTs: "2026-07-01T10:00:00Z",
      messageCount: 1,
    },
  ];

  it("shows the Inbox + a progress banner while importing, with NO blocking modal", async () => {
    // Paired but NOT yet imported → the range picker shows first.
    const { client, streams, importWhatsapp } = makeClient({
      getWhatsappStatus: vi.fn(
        async (): Promise<AdapterStatus> => ({
          state: "online",
          paired: true,
          paused: false,
        }),
      ),
      getInboxChats: vi.fn(async () => chats),
    });

    render(<InboxTab client={client} />);

    // Range picker (paired, not imported).
    await screen.findByText("How much history?");
    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    fireEvent.click(screen.getByRole("button", { name: /Import last 7 days/i }));
    await waitFor(() => expect(importWhatsapp).toHaveBeenCalledWith("7d"));

    // Straight to the Inbox — banner present, blocking modal absent.
    await waitForInbox();
    const banner = document.querySelector(".inbox__import-banner") as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("role")).toBe("status");
    expect(screen.queryByText(/Importing your messages/i)).toBeNull();

    // The big FULL-sync phase arrives as another progress frame — still just the
    // banner, no re-opened modal (this is the exact bug-1 failure mode).
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({
          type: "progress",
          progress: {
            phase: "backfill",
            chatsDone: 4,
            chatsTotal: 300,
            messages: 900,
            done: false,
          },
        }),
      ),
    );
    await waitFor(() =>
      expect(
        (document.querySelector(".inbox__import-banner") as HTMLElement)
          .textContent,
      ).toMatch(/4\/300 chats · 900 messages/i),
    );
    expect(screen.queryByText(/Importing your messages/i)).toBeNull();
    // Read-only invariant holds during import.
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
  });

  it("once importDone, relaunch goes straight to the Inbox with NO modal and NO banner", async () => {
    // Paired + importDone (a completed prior import) — the fresh app state on
    // relaunch. No progress in the snapshot.
    const { client, importWhatsapp } = makeClient({
      getWhatsappStatus: vi.fn(
        async (): Promise<AdapterStatus> => ({
          state: "online",
          paired: true,
          paused: false,
          importDone: true,
          importRange: "30d",
        }),
      ),
      getInboxChats: vi.fn(async () => chats),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    // No range picker, no blocking modal, no lingering banner, no re-import.
    expect(screen.queryByText("How much history?")).toBeNull();
    expect(screen.queryByText(/Importing your messages/i)).toBeNull();
    expect(document.querySelector(".inbox__import-banner")).toBeNull();
    expect(importWhatsapp).not.toHaveBeenCalled();
    const list = document.querySelector(".inbox__chats") as HTMLElement;
    expect(within(list).getByText("Mom")).toBeTruthy();
  });

  it("a later history-sync phase after importDone surfaces only as the banner (no modal)", async () => {
    // Already imported; then the daemon streams a fresh (FULL) backfill phase.
    const { client, streams } = makeClient({
      getWhatsappStatus: vi.fn(
        async (): Promise<AdapterStatus> => ({
          state: "online",
          paired: true,
          paused: false,
          importDone: true,
          importRange: "30d",
        }),
      ),
      getInboxChats: vi.fn(async () => chats),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({
          type: "progress",
          progress: {
            phase: "backfill",
            chatsDone: 50,
            chatsTotal: 300,
            messages: 5000,
            done: false,
          },
        }),
      ),
    );

    // Banner appears (non-blocking); still on the Inbox; no modal.
    await waitFor(() =>
      expect(document.querySelector(".inbox__import-banner")).not.toBeNull(),
    );
    expect(document.querySelector(".inbox__chats")).not.toBeNull();
    expect(screen.queryByText(/Importing your messages/i)).toBeNull();

    // done → banner clears.
    act(() =>
      streams.forEach((s) =>
        s.onFrame({
          type: "progress",
          progress: {
            phase: "backfill",
            chatsDone: 300,
            chatsTotal: 300,
            messages: 5000,
            done: true,
          },
        }),
      ),
    );
    await waitFor(() =>
      expect(document.querySelector(".inbox__import-banner")).toBeNull(),
    );
  });
});

describe("R5.3 / R5.4 — reactions + quoted replies rendering", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Mom",
      kind: "dm",
      lastText: "dinner?",
      lastTs: "2026-07-02T09:00:00Z",
      messageCount: 3,
    },
  ];

  it("names who reacted, on the target bubble and NOT as a standalone bubble", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "dinner?",
        fromMe: false,
        actorName: "Mom",
        reactions: [
          { emoji: "👍", fromMe: true, actorName: "Me" },
          { emoji: "👍", fromMe: false, actorName: "Mom" },
          { emoji: "❤️", fromMe: false, actorName: "Dad" },
        ],
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("dinner?")).toBeTruthy(),
    );

    // Reaction chips live INSIDE the message bubble (attached, not standalone).
    const bubbleMsg = thread.querySelector(
      '[data-event-id="m1"]',
    ) as HTMLElement;
    const reactions = bubbleMsg.querySelector(".inbox__reactions") as HTMLElement;
    expect(reactions).toBeTruthy();
    // One chip per emoji, each naming its own reactors — the reader is "You".
    expect(within(reactions).getByText("👍")).toBeTruthy();
    expect(within(reactions).getByText("You and Mom")).toBeTruthy();
    expect(within(reactions).getByText("❤️")).toBeTruthy();
    expect(within(reactions).getByText("Dad")).toBeTruthy();

    // There is exactly ONE message bubble — reactions did NOT spawn extra
    // stream bubbles.
    expect(thread.querySelectorAll(".inbox__msg").length).toBe(1);
    expect(thread.querySelector('[data-kind="reaction"]')).toBeNull();
  });

  it("keeps a crowded chip short, with everyone named in its title", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "we're here",
        fromMe: true,
        actorName: "Me",
        reactions: [
          { emoji: "🙏", fromMe: false, actorName: "Mom" },
          { emoji: "🙏", fromMe: false, actorName: "Dad" },
          { emoji: "🙏", fromMe: false, actorName: "Keerti" },
          // An unresolved reactor carries no JID of its own to fall back to.
          { emoji: "🙏", fromMe: false, actorName: null },
        ],
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelector(".inbox__reaction")).not.toBeNull(),
    );
    const chip = thread.querySelector(".inbox__reaction") as HTMLElement;
    expect(within(chip).getByText("Mom, Dad and 2 others")).toBeTruthy();
    expect(chip.getAttribute("title")).toBe("🙏 Mom, Dad, Keerti, Someone");
  });

  // The chips are overlaid on the bubble's lower edge, and the room the bubble
  // keeps clear for them is a `:has(> .inbox__reactions)` rule. Nest them any
  // deeper and the chips silently land back on the timestamp.
  it("hangs the chips off the bubble itself, not off something inside it", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "on my way",
        fromMe: false,
        actorName: "Mom",
        reactions: [{ emoji: "👍", fromMe: true, actorName: "Me" }],
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelector(".inbox__reactions")).not.toBeNull(),
    );
    const bubble = thread.querySelector(".inbox__bubble") as HTMLElement;
    expect(
      bubble.querySelector(":scope > .inbox__reactions"),
    ).not.toBeNull();
    // And the bubble is the message's own child, which is what earns the row
    // the extra margin that keeps the chips off the next message.
    const msg = thread.querySelector(".inbox__msg") as HTMLElement;
    expect(msg.querySelector(":scope > .inbox__bubble")).toBe(bubble);
  });

  it("renders a quoted-reply block above the reply bubble", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "dinner at 8?",
        fromMe: false,
        actorName: "Mom",
      },
      {
        id: "m2",
        ts: "2026-07-02T09:05:00Z",
        kind: "message",
        text: "sounds good",
        fromMe: true,
        actorName: "Me",
        replyTo: {
          externalId: "ch-1/m1",
          text: "dinner at 8?",
          actorName: "Mom",
        },
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("sounds good")).toBeTruthy(),
    );

    // The reply (m2) carries a quoted block with the quoted sender + text.
    const reply = thread.querySelector('[data-event-id="m2"]') as HTMLElement;
    const quote = reply.querySelector(".inbox__quote") as HTMLElement;
    expect(quote).toBeTruthy();
    expect(within(quote).getByText("Mom")).toBeTruthy();
    expect(within(quote).getByText("dinner at 8?")).toBeTruthy();
  });

  it("shows a subtle placeholder when the quoted target text is empty/unknown", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m2",
        ts: "2026-07-02T09:05:00Z",
        kind: "message",
        text: "ok",
        fromMe: true,
        actorName: "Me",
        replyTo: { externalId: "ch-1/gone", text: "", actorName: null },
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("ok")).toBeTruthy());
    const quote = thread.querySelector(".inbox__quote") as HTMLElement;
    expect(quote).toBeTruthy();
    expect(within(quote).getByText(/Replied to a message/i)).toBeTruthy();
  });

  it("degrades gracefully when messages carry no reactions/replyTo (older worker)", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "plain message",
        fromMe: false,
        actorName: "Mom",
        // no reactions, no replyTo
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("plain message")).toBeTruthy(),
    );
    // No reaction/quote chrome when the fields are absent.
    expect(thread.querySelector(".inbox__reactions")).toBeNull();
    expect(thread.querySelector(".inbox__quote")).toBeNull();
    // Still read-only.
    expect(document.querySelector("textarea")).toBeNull();
  });
});

// ===========================================================================
// Rich media — attachment facts + model-written descriptions.
// ===========================================================================

describe("rich media rendering", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Mom",
      kind: "dm",
      lastText: "📷 Photo",
      lastTs: "2026-07-02T09:00:00Z",
      messageCount: 3,
    },
  ];

  it("shows filename, type and size on a document, plus its duration on a video", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "document",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "application/pdf",
        mediaFilename: "lease-agreement.pdf",
        mediaSize: 2 * 1024 * 1024,
      },
      {
        id: "m2",
        ts: "2026-07-02T09:01:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m2",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaSize: 5 * 1024 * 1024,
        mediaSeconds: 38,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("lease-agreement.pdf")).toBeTruthy(),
    );
    expect(within(thread).getByText("application/pdf · 2.0 MB")).toBeTruthy();
    expect(within(thread).getByText("clip.mp4")).toBeTruthy();
    expect(within(thread).getByText("video/mp4 · 5.0 MB · 0:38")).toBeTruthy();
  });

  it("labels a media description as AI-written and keeps it out of the message text", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "image",
        text: "look at this",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "image/jpeg",
        mediaFilename: "garden.jpg",
        mediaSize: 240 * 1024,
        mediaDescription: "A marigold in a clay pot on a sunlit balcony.",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    // The image still renders from the media endpoint, with its facts beside it.
    await waitFor(() =>
      expect(thread.querySelector(".inbox__media-img")).not.toBeNull(),
    );
    expect(
      within(thread).getByText("garden.jpg · image/jpeg · 240 KB"),
    ).toBeTruthy();

    // The description is present, tagged, and NOT rendered as the sender's text.
    const desc = thread.querySelector(".inbox__ai-desc") as HTMLElement;
    expect(desc).not.toBeNull();
    expect(within(desc).getByText("AI description")).toBeTruthy();
    expect(
      within(desc).getByText("A marigold in a clay pot on a sunlit balcony."),
    ).toBeTruthy();
    const caption = thread.querySelector(".inbox__msg-caption") as HTMLElement;
    expect(caption.textContent).toBe("look at this");
  });

  it("describes an image to a screen reader by its caption, not its filename", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "image",
        text: "the new sofa",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaFilename: "IMG-20260702-WA0003.jpg",
      },
      {
        id: "m2",
        ts: "2026-07-02T09:01:00Z",
        kind: "image",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m2",
        mediaFilename: "receipt.jpg",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__media-img").length).toBe(2),
    );
    const [captioned, bare] = [
      ...thread.querySelectorAll(".inbox__media-img"),
    ] as HTMLImageElement[];
    expect(captioned.alt).toBe("the new sofa");
    // No caption to use: the filename is the fallback, not the other way round.
    expect(bare.alt).toBe("receipt.jpg");
  });

  it("marks a message the sender deleted, even though its kind is still image", async () => {
    // Spec §5: a revoke tombstones the ORIGINAL row — text and media are gone
    // but `kind` is untouched, so revokedAt is the only marker left.
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "image",
        text: "",
        fromMe: false,
        actorName: "Mom",
        revokedAt: "2026-07-02T09:05:00Z",
        mediaDescription: "A marigold in a clay pot.",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(
        within(thread).getByText("🚫 This message was deleted"),
      ).toBeTruthy(),
    );
    // Whatever the reader saw before the delete must not survive it.
    expect(thread.querySelector(".inbox__ai-desc")).toBeNull();
  });

  it("marks an edited message and a forwarded one", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "7pm not 6pm",
        fromMe: false,
        actorName: "Mom",
        editedAt: "2026-07-02T09:02:00Z",
      },
      {
        id: "m2",
        ts: "2026-07-02T09:03:00Z",
        kind: "message",
        text: "read this",
        fromMe: false,
        actorName: "Mom",
        isForwarded: true,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("Edited")).toBeTruthy());
    expect(within(thread).getByText("↪ Forwarded")).toBeTruthy();

    // Each marker belongs to its own message, not to both.
    const edited = thread.querySelector('[data-event-id="m1"]') as HTMLElement;
    const forwarded = thread.querySelector('[data-event-id="m2"]') as HTMLElement;
    expect(edited.querySelector(".inbox__msg-forwarded")).toBeNull();
    expect(forwarded.querySelector(".inbox__msg-edited")).toBeNull();
  });

  it("shows the picture when the bytes are a picture, whatever the kind says", async () => {
    // The WhatsApp official-account row: a video whose download failed, leaving
    // only its JPEG thumbnail on disk. Gating on kind renders a real, readable
    // photo as a file chip — which is the "business media missing" report.
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "WhatsApp",
        mediaUrl: "/api/media/m1",
        mediaThumbUrl: "/api/media/m1/thumb",
        mediaMime: "image/jpeg",
        mediaSize: 16 * 1024,
        mediaSeconds: 14,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    const img = await waitFor(() => {
      const el = thread.querySelector(".inbox__media-img") as HTMLImageElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(img.getAttribute("src")).toBe("http://w/api/media/m1");
    expect(thread.querySelector(".inbox__file")).toBeNull();
    // The stored thumbnail IS this file — offering it again would be the same
    // bytes twice.
    expect(thread.querySelectorAll("img").length).toBe(1);
    // And the seconds belong to the video that never arrived: a 16 KB still
    // does not play for fourteen seconds.
    expect(within(thread).getByText("image/jpeg · 16 KB")).toBeTruthy();
    expect(within(thread).queryByText(/0:14/)).toBeNull();
  });

  it("shows a video as its stored frame, with the clip's own length", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaThumbUrl: "/api/media/m1/thumb",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaSize: 5 * 1024 * 1024,
        mediaSeconds: 38,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    const poster = await waitFor(() => {
      const el = thread.querySelector(".inbox__media-img") as HTMLImageElement;
      expect(el).not.toBeNull();
      return el;
    });
    // The frame is the thumbnail; the link still opens the video itself.
    expect(poster.getAttribute("src")).toBe("http://w/api/media/m1/thumb");
    const link = thread.querySelector(
      ".inbox__media-link--poster",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("http://w/api/media/m1");
    expect(thread.querySelector(".inbox__media-play")).not.toBeNull();
    expect(within(thread).getByText("clip.mp4 · video/mp4 · 5.0 MB · 0:38")).toBeTruthy();
  });

  it("falls back to the file chip for a video with no stored frame", async () => {
    // 10 of the 17 videos on the real DB have no thumbnail at all.
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaSize: 5 * 1024 * 1024,
        mediaSeconds: 38,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("clip.mp4")).toBeTruthy(),
    );
    expect(thread.querySelector("img")).toBeNull();
    expect(thread.querySelector(".inbox__file")).not.toBeNull();
  });

  it("falls back to the chip when the stored frame will not load", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaThumbUrl: "/api/media/m1/thumb",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaSize: 5 * 1024 * 1024,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    const poster = await waitFor(() => {
      const el = thread.querySelector(".inbox__media-img") as HTMLImageElement;
      expect(el).not.toBeNull();
      return el;
    });
    fireEvent.error(poster);

    await waitFor(() =>
      expect(thread.querySelector(".inbox__file")).not.toBeNull(),
    );
    expect(thread.querySelector("img")).toBeNull();
    expect(within(thread).getByText("clip.mp4")).toBeTruthy();
  });

  it("renders nothing extra for a message without media fields", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "just words",
        fromMe: false,
        actorName: "Mom",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("just words")).toBeTruthy(),
    );
    expect(thread.querySelector(".inbox__ai-desc")).toBeNull();
    expect(thread.querySelector(".inbox__media-meta")).toBeNull();
    expect(thread.querySelector(".inbox__file-meta")).toBeNull();
  });

  // ---- v5 §3: transcripts ------------------------------------------------

  it("labels a transcript as machine-read, the way it labels a description", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "audio",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "audio/ogg",
        mediaSeconds: 14,
        transcript: "कल सुबह दस बजे मिलते हैं",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelector(".inbox__ai-desc")).not.toBeNull(),
    );
    const note = thread.querySelector(".inbox__ai-desc") as HTMLElement;
    // The label is what keeps it from reading as something Mom typed.
    expect(within(note).getByText("Machine transcript")).toBeTruthy();
    expect(within(note).getByText("कल सुबह दस बजे मिलते हैं")).toBeTruthy();
    expect(thread.querySelector(".inbox__msg-text")).toBeNull();
  });

  it("keeps a description and a transcript apart on the same video", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "video/mp4",
        mediaDescription: "Two people walking through a market.",
        transcript: "यहाँ से सीधा जाओ",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__ai-desc")).toHaveLength(2),
    );
    const [desc, tx] = [...thread.querySelectorAll(".inbox__ai-desc")];
    expect(within(desc as HTMLElement).getByText("AI description")).toBeTruthy();
    expect(
      within(tx as HTMLElement).getByText("Machine transcript"),
    ).toBeTruthy();
  });

  // ---- v5 §2: sampled video frames ---------------------------------------

  it("leads with the poster and keeps the frames behind a control (v7 §3)", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaSeconds: 20,
        mediaThumbUrl: "/api/media/m1/thumb",
        mediaFrames: [
          { url: "/api/media/m1/frame0", seconds: 2.5 },
          { url: "/api/media/m1/frame1", seconds: 7.5 },
          { url: "/api/media/m1/frame2", seconds: 12.5 },
          { url: "/api/media/m1/frame3", seconds: 17.5 },
        ],
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    // A strip of stills reads as a photo album, so the poster is what this
    // bubble opens with — play badge and the clip's own length on it.
    await waitFor(() =>
      expect(thread.querySelector(".inbox__media-link--poster")).not.toBeNull(),
    );
    expect(thread.querySelector(".inbox__media-play")).not.toBeNull();
    expect(
      thread.querySelector(".inbox__media-duration")?.textContent,
    ).toBe("0:20");
    expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(0);

    // The frames are what the model actually looked at, so they stay reachable
    // — and the control says how many, because nothing here watched the clip.
    const more = within(thread).getByRole("button", {
      name: "Show 4 sampled frames",
    });
    fireEvent.click(more);
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(4),
    );
    expect(within(thread).getByText("0:03")).toBeTruthy();
    expect(within(thread).getByText("0:18")).toBeTruthy();
    // Under the poster the strip does not repeat the file's facts.
    expect(within(thread).queryByText(/4 sampled frames · video\/mp4/)).toBeNull();

    fireEvent.click(within(thread).getByRole("button", { name: /^Hide/ }));
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(0),
    );
  });

  it("shows the frames outright when the clip has no poster to lead with", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaSeconds: 20,
        mediaFrames: [
          { url: "/api/media/m1/frame0", seconds: 2.5 },
          { url: "/api/media/m1/frame1", seconds: 17.5 },
        ],
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(2),
    );
    // Standing on their own the stills carry the count and the file's facts.
    expect(
      within(thread).getByText("clip.mp4 · 2 sampled frames · video/mp4 · 0:20"),
    ).toBeTruthy();
    expect(thread.querySelector(".inbox__more")).toBeNull();
  });

  it("falls back to the poster when a video has no sampled frames", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "video/mp4",
        mediaThumbUrl: "/api/media/m1/thumb",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelector(".inbox__media-link--poster")).not.toBeNull(),
    );
    expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(0);
  });

  it("drops a frame whose file went missing, and the chip takes over if they all do", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "video",
        text: "",
        fromMe: false,
        actorName: "Mom",
        mediaUrl: "/api/media/m1",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaFrames: [
          { url: "/api/media/m1/frame0", seconds: 2.5 },
          { url: "/api/media/m1/frame1", seconds: 7.5 },
        ],
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(2),
    );

    fireEvent.error(thread.querySelectorAll(".inbox__frame img")[0]);
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(1),
    );
    // The count follows what is actually on screen rather than what was stored.
    expect(within(thread).getByText(/1 sampled frame ·/)).toBeTruthy();

    fireEvent.error(thread.querySelectorAll(".inbox__frame img")[0]);
    await waitFor(() =>
      expect(thread.querySelector(".inbox__file")).not.toBeNull(),
    );
    expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(0);
  });
});

// ===========================================================================
// Link previews — what WhatsApp sent with the URL, plus the fetched page text.
// ===========================================================================

describe("link previews", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Mom",
      kind: "dm",
      lastText: "have a look",
      lastTs: "2026-07-02T09:00:00Z",
      messageCount: 2,
    },
  ];

  function render1(messages: InboxMessage[]) {
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });
    render(<InboxTab client={client} />);
    return waitForInbox();
  }

  it("shows the preview WhatsApp sent — title, blurb, thumbnail and host", async () => {
    await render1([
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "https://www.nasa.gov/artemis",
        fromMe: false,
        actorName: "Mom",
        link: {
          url: "https://www.nasa.gov/artemis",
          title: "Artemis II crew announced",
          description: "Four astronauts will fly around the Moon.",
          previewType: "image",
          scrapedText: null,
          thumbUrl: "/api/media/m1/link-thumb",
        },
      },
    ]);

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    const card = await waitFor(() => {
      const el = thread.querySelector(".inbox__link") as HTMLAnchorElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(card.href).toBe("https://www.nasa.gov/artemis");
    expect(within(card).getByText("Artemis II crew announced")).toBeTruthy();
    expect(
      within(card).getByText("Four astronauts will fly around the Moon."),
    ).toBeTruthy();
    // The byline is the host without the www, not the whole URL again.
    expect(within(card).getByText("nasa.gov")).toBeTruthy();
    const thumb = card.querySelector(".inbox__link-thumb") as HTMLImageElement;
    expect(thumb.src).toBe("http://w/api/media/m1/link-thumb");
  });

  it("renders a history-synced preview — title and blurb, no picture frame", async () => {
    // 0 of 32 links in the real DB carry a thumbnail: history sync strips
    // JPEGThumbnail. The card has to be a complete thing without one.
    await render1([
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "https://www.thehindu.com/news/cities/bangalore/",
        fromMe: false,
        actorName: "Mom",
        link: {
          url: "https://www.thehindu.com/news/cities/bangalore/",
          title: "Bengaluru News",
          description: "Latest from the city.",
          previewType: "video",
          scrapedText: null,
        },
      },
    ]);

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    const card = await waitFor(() => {
      const el = thread.querySelector(".inbox__link") as HTMLAnchorElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(within(card).getByText("Bengaluru News")).toBeTruthy();
    expect(within(card).getByText("Latest from the city.")).toBeTruthy();
    expect(within(card).getByText("thehindu.com")).toBeTruthy();
    // No thumbnail means no <img> at all — not an empty 54px box.
    expect(card.querySelector("img")).toBeNull();
  });

  it("drops a thumbnail whose file has gone rather than showing a broken frame", async () => {
    await render1([
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "https://example.com/post",
        fromMe: false,
        actorName: "Mom",
        link: {
          url: "https://example.com/post",
          title: "A post",
          description: null,
          previewType: "image",
          scrapedText: null,
          thumbUrl: "/api/media/m1/link-thumb",
        },
      },
    ]);

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    const thumb = await waitFor(() => {
      const el = thread.querySelector(".inbox__link-thumb") as HTMLImageElement;
      expect(el).not.toBeNull();
      return el;
    });
    fireEvent.error(thumb);

    await waitFor(() =>
      expect(thread.querySelector(".inbox__link-thumb")).toBeNull(),
    );
    // The card itself survives — the title is still worth reading.
    expect(
      within(thread.querySelector(".inbox__link") as HTMLElement).getByText(
        "A post",
      ),
    ).toBeTruthy();
  });

  it("shows the stills taken from a linked clip (v7 §4)", async () => {
    await render1([
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "https://www.youtube.com/watch?v=abc",
        fromMe: false,
        actorName: "Mom",
        // No mediaUrl: the download is deleted after sampling, so the stills
        // are all there is — and they hang off the message, not off a file.
        mediaFrames: [
          { url: "/api/media/m1/frame0", seconds: 4 },
          { url: "/api/media/m1/frame1", seconds: 12 },
        ],
        link: {
          url: "https://www.youtube.com/watch?v=abc",
          title: "A cooking video",
          description: null,
          previewType: "video",
          scrapedText: null,
        },
      },
    ]);

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__frame")).toHaveLength(2),
    );
    expect(within(thread).getByText("0:04")).toBeTruthy();
    // Where they came from, said out loud: nobody in the chat took these, and
    // they are not of anything the message itself carries.
    expect(
      within(thread).getByText("From the linked video · 2 sampled frames"),
    ).toBeTruthy();
    // A still opens the page the clip is on — there is no local file to open.
    expect(
      (thread.querySelector(".inbox__frame") as HTMLAnchorElement).href,
    ).toBe("https://www.youtube.com/watch?v=abc");
    // And no file chip: there is no attachment here, only a link.
    expect(thread.querySelector(".inbox__file")).toBeNull();
  });

  it("labels the fetched page text as machine-read, like a media description", async () => {
    await render1([
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "https://example.com/post",
        fromMe: false,
        actorName: "Mom",
        link: {
          url: "https://example.com/post",
          title: "A post",
          description: null,
          previewType: null,
          scrapedText: "The council voted 7-2 to keep the library open.",
        },
      },
    ]);

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    // Same treatment as an AI description: nobody in the chat wrote this.
    const note = await waitFor(() => {
      const el = thread.querySelector(".inbox__ai-desc") as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(within(note).getByText("From the linked page")).toBeTruthy();
    expect(
      within(note).getByText("The council voted 7-2 to keep the library open."),
    ).toBeTruthy();
    // …and it is NOT rendered as the message's own text.
    const text = thread.querySelector(".inbox__msg-text") as HTMLElement;
    expect(text.textContent).toBe("https://example.com/post");
  });

  it("renders no card for a URL WhatsApp sent no preview for", async () => {
    await render1([
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "http://example.com",
        fromMe: false,
        actorName: "Mom",
        link: {
          url: "http://example.com",
          title: null,
          description: null,
          previewType: null,
          scrapedText: null,
        },
      },
    ]);

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("http://example.com")).toBeTruthy(),
    );
    // The message text already IS the URL — a card repeating it is noise.
    expect(thread.querySelector(".inbox__link")).toBeNull();
    expect(thread.querySelector(".inbox__ai-desc")).toBeNull();
  });

  it("drops the preview of a message the sender deleted", async () => {
    await render1([
      {
        id: "m1",
        ts: "2026-07-02T09:00:00Z",
        kind: "message",
        text: "",
        fromMe: false,
        actorName: "Mom",
        revokedAt: "2026-07-02T09:05:00Z",
        link: {
          url: "https://example.com/post",
          title: "A post",
          description: null,
          previewType: null,
          scrapedText: "Readable text of the page.",
        },
      },
    ]);

    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(
        within(thread).getByText("🚫 This message was deleted"),
      ).toBeTruthy(),
    );
    expect(thread.querySelector(".inbox__link")).toBeNull();
    expect(thread.querySelector(".inbox__ai-desc")).toBeNull();
  });
});

// ===========================================================================
// Revision 7 — latest-window default + scroll-up older-page pagination (R7.1).
// ===========================================================================

describe("R7.1 — chat detail: latest window + scroll-up pagination", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const PAGE = 60; // must mirror PAGE_SIZE in InboxTab.tsx

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Subhashree",
      kind: "dm",
      lastText: "latest!",
      lastTs: "2026-06-10T12:00:00Z",
      messageCount: 5356,
    },
  ];

  /** A page of ascending messages ts = base + i minutes, ids `<prefix>-<i>`. */
  function makePage(prefix: string, count: number, startMin: number): InboxMessage[] {
    const out: InboxMessage[] = [];
    for (let i = 0; i < count; i++) {
      const min = startMin + i;
      const mm = String(min % 60).padStart(2, "0");
      const hh = String(Math.floor(min / 60)).padStart(2, "0");
      out.push({
        id: `${prefix}-${i}`,
        ts: `2026-06-10T${hh}:${mm}:00Z`,
        kind: "message",
        text: `${prefix} #${i}`,
        fromMe: false,
        actorName: "Subhashree",
      });
    }
    return out;
  }

  it("opening a chat requests the LATEST window (no cursor) and renders newest-at-bottom", async () => {
    // A full latest window (ascending): text "latest #0" (oldest of window) …
    // "latest #59" (newest). The worker already reversed to ascending.
    const latest = makePage("latest", PAGE, 600); // 10:00 … 10:59
    const getChannelMessages = vi.fn(
      async (_id: string, _opts?: { before?: string; limit?: number }) => latest,
    );
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();

    // First (and only, until scroll) call: NO `before` cursor, page size 60.
    await waitFor(() =>
      expect(getChannelMessages).toHaveBeenCalledWith("ch-1", { limit: PAGE }),
    );
    // It must NOT have been called with a cursor on open.
    expect(
      getChannelMessages.mock.calls.some(
        (c) => (c[1] as { before?: string })?.before != null,
      ),
    ).toBe(false);

    // Newest message is present and is the LAST bubble in DOM order (bottom).
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("latest #59")).toBeTruthy(),
    );
    const bubbles = thread.querySelectorAll(".inbox__msg");
    const lastBubble = bubbles[bubbles.length - 1] as HTMLElement;
    expect(lastBubble.getAttribute("data-event-id")).toBe("latest-59");
    // A full page came back → an older page may exist → NO "Beginning of chat".
    expect(thread.querySelector(".inbox__older-start")).toBeNull();
  });

  it("scrolling to the TOP requests an OLDER page with a '<ts>|<id>' before cursor and PREPENDS without losing existing messages", async () => {
    const latest = makePage("latest", PAGE, 600); // full page → hasMore
    const older = makePage("older", PAGE, 540); // 09:00 … 09:59 (older) → still full
    const getChannelMessages = vi.fn(
      async (_id: string, opts?: { before?: string; limit?: number }) =>
        opts?.before ? older : latest,
    );
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("latest #0")).toBeTruthy(),
    );

    // Simulate a scroll to the very top (jsdom scrollTop defaults to 0, which is
    // ≤ the threshold) and fire the scroll event the component listens for.
    act(() => {
      thread.scrollTop = 0;
      thread.dispatchEvent(new Event("scroll"));
    });

    // It requested the OLDER page with a compound cursor built from the OLDEST
    // currently-loaded message: "<oldest.ts>|<oldest.id>" = latest #0.
    await waitFor(() =>
      expect(
        getChannelMessages.mock.calls.some(
          (c) => (c[1] as { before?: string })?.before === "2026-06-10T10:00:00Z|latest-0",
        ),
      ).toBe(true),
    );

    // The older page is PREPENDED: older rows now precede the still-present
    // latest rows (nothing was lost).
    await waitFor(() =>
      expect(within(thread).getByText("older #0")).toBeTruthy(),
    );
    expect(within(thread).getByText("latest #59")).toBeTruthy(); // kept
    const ids = Array.from(thread.querySelectorAll(".inbox__msg")).map((el) =>
      el.getAttribute("data-event-id"),
    );
    // older-0 is first, latest-59 is last → prepend order preserved.
    expect(ids[0]).toBe("older-0");
    expect(ids[ids.length - 1]).toBe("latest-59");
    // Combined length = both pages, no duplicates.
    expect(ids.length).toBe(PAGE * 2);
    expect(new Set(ids).size).toBe(PAGE * 2);
  });

  it("hasMore stops paging when a SHORT batch returns (Beginning of chat)", async () => {
    const latest = makePage("latest", PAGE, 600); // full → hasMore true
    const shortOlder = makePage("older", 10, 590); // short batch → exhausted
    const getChannelMessages = vi.fn(
      async (_id: string, opts?: { before?: string; limit?: number }) =>
        opts?.before ? shortOlder : latest,
    );
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("latest #0")).toBeTruthy(),
    );

    // First scroll-up → loads the short older page.
    act(() => {
      thread.scrollTop = 0;
      thread.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() =>
      expect(within(thread).getByText("older #0")).toBeTruthy(),
    );
    const afterFirst = getChannelMessages.mock.calls.length;

    // The short batch flipped hasMore → false: "Beginning of chat" appears and
    // further scroll-up events do NOT trigger any more fetches.
    await waitFor(() =>
      expect(thread.querySelector(".inbox__older-start")).not.toBeNull(),
    );
    act(() => {
      thread.scrollTop = 0;
      thread.dispatchEvent(new Event("scroll"));
    });
    // Give any (unwanted) async fetch a tick — the count must not grow.
    await Promise.resolve();
    expect(getChannelMessages.mock.calls.length).toBe(afterFirst);
  });

  it("a short FIRST window marks the chat's beginning immediately (no scroll-up needed)", async () => {
    // Small chat: only 3 messages ever. First window is short → hasMore false.
    const small = makePage("m", 3, 600);
    const getChannelMessages = vi.fn(async () => small);
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages,
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("m #2")).toBeTruthy(),
    );
    // No older page possible → "Beginning of chat", and a scroll-up is a no-op.
    expect(thread.querySelector(".inbox__older-start")).not.toBeNull();
    const calls = getChannelMessages.mock.calls.length;
    act(() => {
      thread.scrollTop = 0;
      thread.dispatchEvent(new Event("scroll"));
    });
    await Promise.resolve();
    expect(getChannelMessages.mock.calls.length).toBe(calls);
    // Read-only invariant holds.
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
  });

  it("a live ingest nudge for the open chat reloads the LATEST window (new msg at bottom)", async () => {
    // Window before/after a new message arrives. The nudge reloads the latest
    // window; the new bottom message appears without a cursor fetch.
    const before = makePage("m", 3, 600);
    const after = [
      ...before,
      {
        id: "m-new",
        ts: "2026-06-10T10:59:00Z",
        kind: "message",
        text: "just sent",
        fromMe: true,
        actorName: "Me",
      } as InboxMessage,
    ];
    let call = 0;
    const getChannelMessages = vi.fn(async () => (call++ === 0 ? before : after));
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages,
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("m #2")).toBeTruthy());

    // Drive an ingest frame for the open chat.
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T10:59:00Z", channels: ["ch-1"] }),
      ),
    );

    // The just-sent message shows up at the bottom (latest window reloaded, no
    // `before` cursor was used for the nudge).
    await waitFor(() =>
      expect(within(thread).getByText("just sent")).toBeTruthy(),
    );
    const ids = Array.from(thread.querySelectorAll(".inbox__msg")).map((el) =>
      el.getAttribute("data-event-id"),
    );
    expect(ids[ids.length - 1]).toBe("m-new");
  });
});

// ===========================================================================
// v7 §5 — the five measured causes of the scroll jank, one test each.
// ===========================================================================

describe("v7 §5 — scrolling back through a chat", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const PAGE = 60; // must mirror PAGE_SIZE in InboxTab.tsx

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Pranjali",
      kind: "dm",
      lastText: "latest!",
      lastTs: "2026-06-10T12:00:00Z",
      messageCount: 5356,
    },
  ];

  function makePage(prefix: string, count: number, startMin: number): InboxMessage[] {
    const out: InboxMessage[] = [];
    for (let i = 0; i < count; i++) {
      const min = startMin + i;
      const mm = String(min % 60).padStart(2, "0");
      const hh = String(Math.floor(min / 60)).padStart(2, "0");
      out.push({
        id: `${prefix}-${i}`,
        ts: `2026-06-10T${hh}:${mm}:00Z`,
        kind: "message",
        text: `${prefix} #${i}`,
        fromMe: false,
        actorName: "Pranjali",
      });
    }
    return out;
  }

  /**
   * jsdom lays nothing out, so a scroll container reports 0 for every one of
   * the three numbers the component reads. This is that whole viewport: each
   * loaded message is `ROW_PX` tall, and the "Loading older messages…" line
   * that sits above them while a page is in the air is `SPINNER_PX` — it is
   * there for exactly the stretch between asking for a page and getting it,
   * which is the stretch a stale anchor is measured across.
   */
  const ROW_PX = 40;
  const SPINNER_PX = 60;
  const CLIENT_PX = 300;

  function fakeViewport(el: HTMLElement) {
    Object.defineProperty(el, "clientHeight", {
      get: () => CLIENT_PX,
      configurable: true,
    });
    Object.defineProperty(el, "scrollHeight", {
      get: () =>
        el.querySelectorAll(".inbox__msg").length * ROW_PX +
        (el.querySelector(".inbox__older-loading") ? SPINNER_PX : 0),
      configurable: true,
    });
  }

  /** Scroll to the top and let the component's handler run. */
  function scrollToTop(thread: HTMLElement) {
    act(() => {
      thread.scrollTop = 0;
      thread.dispatchEvent(new Event("scroll"));
    });
  }

  it("§5.1 a quiet refresh folds into the loaded window instead of replacing it", async () => {
    const latest = makePage("latest", PAGE, 600);
    const older = makePage("older", PAGE, 540);
    const getChannelMessages = vi.fn(
      async (_id: string, opts?: { before?: string; limit?: number }) =>
        opts?.before ? older : latest,
    );
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());

    scrollToTop(thread);
    await waitFor(() => expect(within(thread).getByText("older #0")).toBeTruthy());
    expect(thread.querySelectorAll(".inbox__msg").length).toBe(PAGE * 2);

    // A nudge lands: it fetches the newest window and nothing else, so before
    // this fix the 120 loaded rows became the 60 it happens to hold.
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T11:00:00Z", channels: ["ch-1"] }),
      ),
    );
    await waitFor(() =>
      expect(getChannelMessages.mock.calls.length).toBeGreaterThan(2),
    );

    const ids = Array.from(thread.querySelectorAll(".inbox__msg")).map((el) =>
      el.getAttribute("data-event-id"),
    );
    expect(ids.length).toBe(PAGE * 2);
    expect(ids[0]).toBe("older-0");
    expect(ids[ids.length - 1]).toBe("latest-59");
    // And the paging state survives with it: the refresh has nothing to say
    // about how far back the reader has got.
    expect(thread.querySelector(".inbox__older-start")).toBeNull();
  });

  it("§5.1 a message that arrives during the refresh lands at the bottom, in order", async () => {
    const before = makePage("m", 3, 600);
    const after = [
      ...before,
      {
        id: "m-new",
        ts: "2026-06-10T10:04:00Z",
        kind: "message",
        text: "just sent",
        fromMe: true,
        actorName: "Me",
      } as InboxMessage,
    ];
    let call = 0;
    const getChannelMessages = vi.fn(async () => (call++ === 0 ? before : after));
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages,
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("m #2")).toBeTruthy());

    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T10:04:00Z", channels: ["ch-1"] }),
      ),
    );
    await waitFor(() => expect(within(thread).getByText("just sent")).toBeTruthy());
    const ids = Array.from(thread.querySelectorAll(".inbox__msg")).map((el) =>
      el.getAttribute("data-event-id"),
    );
    expect(ids).toEqual(["m-0", "m-1", "m-2", "m-new"]);
  });

  it("§5.1 an edit that arrives on a refresh rewrites the row where it sits", async () => {
    const before = makePage("m", 3, 600);
    const edited = before.map((m, i) =>
      i === 0 ? { ...m, text: "m #0 (fixed)", editedAt: "2026-06-10T10:05:00Z" } : m,
    );
    let call = 0;
    const getChannelMessages = vi.fn(async () => (call++ === 0 ? before : edited));
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages,
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("m #0")).toBeTruthy());

    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T10:05:00Z", channels: ["ch-1"] }),
      ),
    );
    await waitFor(() =>
      expect(within(thread).getByText("m #0 (fixed)")).toBeTruthy(),
    );
    const ids = Array.from(thread.querySelectorAll(".inbox__msg")).map((el) =>
      el.getAttribute("data-event-id"),
    );
    // Still three rows, still in place — a merge that appended would have put
    // the edited copy under the two messages that came after it.
    expect(ids).toEqual(["m-0", "m-1", "m-2"]);
    expect(within(thread).queryByText("m #0")).toBeNull();
  });

  it("§5.2 a scroll that starts during an in-flight refresh is not yanked back down", async () => {
    const latest = makePage("latest", PAGE, 600);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const getChannelMessages = vi.fn(async () => {
      if (call++ > 0) await held; // the quiet refresh, held open
      return latest;
    });
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages,
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());
    fakeViewport(thread);

    // The reader is at the bottom when the nudge goes out…
    thread.scrollTop = PAGE * ROW_PX - CLIENT_PX;
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T11:00:00Z", channels: ["ch-1"] }),
      ),
    );
    // …and scrolls up while it is still in the air.
    act(() => {
      thread.scrollTop = 400;
      thread.dispatchEvent(new Event("scroll"));
    });

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(getChannelMessages.mock.calls.length).toBe(2));
    // Sampling "was the reader at the bottom?" before the request and applying
    // the answer after it is what pulled the view down mid-gesture.
    expect(thread.scrollTop).toBe(400);
  });

  it("§5.3 the thread turns the browser's own scroll anchoring off", async () => {
    // Asserted against the stylesheet because jsdom applies no CSS: the
    // component compensates for a prepend itself, and Chromium doing it too is
    // invisible everywhere except in a real browser, about a page too far.
    const css = inboxCss();
    const thread = css.slice(css.indexOf(".inbox__thread {"));
    expect(thread.slice(0, thread.indexOf("}"))).toContain(
      "overflow-anchor: none",
    );
  });

  it("§5.4 a prepend leaves the reader looking at the same message", async () => {
    const latest = makePage("latest", PAGE, 600);
    const older = makePage("older", PAGE, 540);
    const getChannelMessages = vi.fn(
      async (_id: string, opts?: { before?: string; limit?: number }) =>
        opts?.before ? older : latest,
    );
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());
    fakeViewport(thread);

    // Near the top, but not at it — which is where the double compensation
    // used to bite, since the browser's own anchoring is only suppressed at
    // exactly 0 while a page is asked for anywhere in the top 80px.
    thread.scrollTop = 40;
    act(() => thread.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(within(thread).getByText("older #0")).toBeTruthy());

    // The reader was looking at "latest #1". Above it there are now PAGE new
    // messages, and the spinner that was there while the page was in the air
    // is gone — so that is exactly how far down the document it has moved. A
    // height measured before the spinner rendered misses the second half.
    expect(thread.scrollTop).toBe(40 + PAGE * ROW_PX - SPINNER_PX);
  });

  it("§5.4 an image reserves its box before the bytes decode", async () => {
    const messages: InboxMessage[] = [
      {
        id: "m1",
        ts: "2026-06-10T10:00:00Z",
        kind: "image",
        text: "",
        fromMe: false,
        actorName: "Pranjali",
        mediaUrl: "/api/media/m1",
        mediaMime: "image/jpeg",
        mediaWidth: 1080,
        mediaHeight: 1920,
      },
      {
        id: "m2",
        ts: "2026-06-10T10:01:00Z",
        kind: "image",
        text: "",
        fromMe: false,
        actorName: "Pranjali",
        mediaUrl: "/api/media/m2",
        mediaMime: "image/jpeg",
      },
      {
        id: "m3",
        ts: "2026-06-10T10:02:00Z",
        kind: "sticker",
        text: "",
        fromMe: false,
        actorName: "Pranjali",
        mediaUrl: "/api/media/m3",
        mediaMime: "image/webp",
        mediaWidth: 120,
        mediaHeight: 90,
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__media-img").length).toBe(3),
    );
    const [sized, unsized, small] = [
      ...thread.querySelectorAll(".inbox__media-img"),
    ] as HTMLImageElement[];
    // The box the picture ends up in, stated outright: 1080x1920 fits inside
    // 260x300 as 169x300, and the row is that tall before a byte has arrived.
    expect(sized.style.width).toBe("169px");
    expect(sized.style.height).toBe("300px");
    expect(sized.getAttribute("width")).toBe("169");
    expect(sized.className).not.toContain("--unsized");
    // A row WhatsApp sent no dimensions for gets a box from the stylesheet
    // instead — a guessed shape, but the same one before and after the load.
    expect(unsized.getAttribute("width")).toBeNull();
    expect(unsized.style.height).toBe("");
    expect(unsized.className).toContain("inbox__media-img--unsized");
    // A sticker smaller than the bubble stays its own size — the box only ever
    // shrinks, or a 120px sticker would be blown up to fill the space.
    expect(small.style.width).toBe("120px");
    expect(small.style.height).toBe("90px");
  });

  it("§5.5 paging keeps working when an update is already queued", async () => {
    const latest = makePage("latest", PAGE, 600);
    const older = makePage("older", PAGE, 540);
    const oldest = makePage("oldest", PAGE, 480);
    const getChannelMessages = vi.fn(
      async (_id: string, opts?: { before?: string; limit?: number }) =>
        opts?.before === "2026-06-10T10:00:00Z|latest-0"
          ? older
          : opts?.before
            ? oldest
            : latest,
    );
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());

    // Type in the search box and scroll in the SAME batch, so the fiber has a
    // pending update when the scroll handler runs. Reading the loaded window
    // back through a setMessages updater silently returned nothing there —
    // React only runs an updater eagerly when nothing is queued — and the page
    // was never requested.
    act(() => {
      fireEvent.change(screen.getByLabelText("Search messages"), {
        target: { value: "a" },
      });
      thread.scrollTop = 0;
      thread.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(within(thread).getByText("older #0")).toBeTruthy());

    // And again from the newly prepended end, which is the cursor the ref has
    // to be carrying by then.
    scrollToTop(thread);
    await waitFor(() =>
      expect(within(thread).getByText("oldest #0")).toBeTruthy(),
    );
    expect(
      getChannelMessages.mock.calls.some(
        (c) => (c[1] as { before?: string })?.before === "2026-06-10T09:00:00Z|older-0",
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Switching chats is the gap every one of these fixes has to survive: the
  // rows of the chat just left stay on screen until the new one's arrive, and
  // anything that folds into the loaded window rather than replacing it lands
  // in that gap.
  // -------------------------------------------------------------------------

  const twoChats: InboxChat[] = [
    { ...chats[0] },
    {
      id: "ch-2",
      name: "Mummy",
      kind: "dm",
      lastText: "ok",
      lastTs: "2026-06-09T12:00:00Z",
      messageCount: 900,
    },
  ];

  /** Click a chat in the left list by its name. */
  function openChat(name: string) {
    const list = document.querySelector(".inbox__chats") as HTMLElement;
    fireEvent.click(within(list).getByText(name).closest("button")!);
  }

  function rowIds(thread: HTMLElement): (string | null)[] {
    return Array.from(thread.querySelectorAll(".inbox__msg")).map((el) =>
      el.getAttribute("data-event-id"),
    );
  }

  it("a refresh answered after the reader moved on does not merge two chats", async () => {
    const a = makePage("a", 3, 600);
    const b = makePage("b", 3, 500);
    let refreshes = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const getChannelMessages = vi.fn(async (id: string) => {
      if (id === "ch-2") return b;
      // The chat's own opening fetch answers at once; the nudge's refresh of it
      // is the second call and is held past the switch.
      if (++refreshes === 2) await held;
      return a;
    });
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => twoChats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("a #0")).toBeTruthy());

    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T11:00:00Z", channels: ["ch-1"] }),
      ),
    );
    await waitFor(() => expect(refreshes).toBe(2));

    act(() => openChat("Mummy"));
    await waitFor(() => expect(rowIds(thread)).toEqual(["b-0", "b-1", "b-2"]));

    await act(async () => {
      release();
      await Promise.resolve();
    });
    // Pranjali's newest page, folded into Mummy's window: six messages from two
    // people in one thread, sorted together by time.
    expect(rowIds(thread)).toEqual(["b-0", "b-1", "b-2"]);
  });

  it("a slow chat that finishes opening after the reader left it does not take the thread", async () => {
    const a = makePage("a", 3, 600);
    const b = makePage("b", 3, 500);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const getChannelMessages = vi.fn(async (id: string) => {
      if (id === "ch-2") return b;
      await held;
      return a;
    });
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => twoChats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() =>
      expect(within(thread).getByText("Loading messages…")).toBeTruthy(),
    );

    // Away before it answered, and the chat that WAS chosen has answered since.
    act(() => openChat("Mummy"));
    await waitFor(() => expect(rowIds(thread)).toEqual(["b-0", "b-1", "b-2"]));

    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(rowIds(thread)).toEqual(["b-0", "b-1", "b-2"]);
    expect(within(thread).queryByText("Loading messages…")).toBeNull();
  });

  it("an older page for the chat just left is not prepended onto the one just opened", async () => {
    const latest = makePage("latest", PAGE, 600);
    const older = makePage("older", PAGE, 540);
    const b = makePage("b", 3, 500);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const getChannelMessages = vi.fn(
      async (id: string, opts?: { before?: string; limit?: number }) => {
        if (id === "ch-2") return b;
        if (!opts?.before) return latest;
        await held;
        return older;
      },
    );
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => twoChats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());

    scrollToTop(thread);
    await waitFor(() =>
      expect(
        getChannelMessages.mock.calls.some((c) => (c[1] as { before?: string })?.before),
      ).toBe(true),
    );

    act(() => openChat("Mummy"));
    await waitFor(() => expect(within(thread).getByText("b #0")).toBeTruthy());

    await act(async () => {
      release();
      await Promise.resolve();
    });
    // Pranjali's history arriving after the reader has moved on: prepended, it
    // would put sixty of her messages above three of Mummy's.
    expect(rowIds(thread)).toEqual(["b-0", "b-1", "b-2"]);
  });

  it("§5.2 a refresh that found no news leaves the scroll position alone", async () => {
    const latest = makePage("latest", PAGE, 600);
    const withNew = [
      ...latest,
      {
        id: "latest-new",
        ts: "2026-06-10T11:00:00Z",
        kind: "message",
        text: "just in",
        fromMe: false,
        actorName: "Pranjali",
      } as InboxMessage,
    ];
    let news = false;
    const getChannelMessages = vi.fn(async () => (news ? withNew : latest));
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages,
    });

    render(<InboxTab client={client} />);
    await waitForInbox();
    const thread = document.querySelector(".inbox__thread") as HTMLElement;
    await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());
    fakeViewport(thread);
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    // Forty pixels short of the newest message — inside the band that counts as
    // "at the bottom", which is what makes this the case that bites.
    const atBottom = PAGE * ROW_PX - CLIENT_PX;
    thread.scrollTop = atBottom - 40;
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T11:00:00Z", channels: ["ch-1"] }),
      ),
    );
    await waitFor(() => expect(getChannelMessages.mock.calls.length).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    // Every fifteen seconds, forever, for nothing.
    expect(thread.scrollTop).toBe(atBottom - 40);

    // And when there IS something, it still follows it down.
    news = true;
    act(() =>
      streams.forEach((s) =>
        s.onFrame({ type: "ingest", ts: "2026-06-10T11:00:00Z", channels: ["ch-1"] }),
      ),
    );
    await waitFor(() => expect(within(thread).getByText("just in")).toBeTruthy());
    expect(thread.scrollTop).toBe((PAGE + 1) * ROW_PX);
  });

  /**
   * jsdom has no `scrollIntoView` at all — calling it throws — so a jump can
   * only be exercised with one standing in. This one does what a browser's
   * does to the number the component then reads back: it moves the thread.
   */
  function stubScrollIntoView(to: number): () => void {
    const proto = Element.prototype as unknown as {
      scrollIntoView?: (arg?: unknown) => void;
    };
    const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
    const prev = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      const thread = this.closest(".inbox__thread") as HTMLElement | null;
      if (thread) thread.scrollTop = to;
    };
    return () => {
      if (had) proto.scrollIntoView = prev;
      else delete proto.scrollIntoView;
    };
  }

  it("a jumped-to search hit is not thrown to the bottom the next commit", async () => {
    const latest = makePage("latest", PAGE, 600);
    const hits: SearchHit[] = [
      {
        eventId: "latest-10",
        channelId: "ch-1",
        channelName: "Pranjali",
        ts: "2026-06-10T10:10:00Z",
        snippet: "latest #<b>10</b>",
        text: "latest #10",
      },
    ];
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => latest),
      searchInbox: vi.fn(async () => hits),
    });

    const restore = stubScrollIntoView(420);
    try {
      render(<InboxTab client={client} />);
      await waitForInbox();
      const thread = document.querySelector(".inbox__thread") as HTMLElement;
      await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());
      fakeViewport(thread);

      const box = screen.getByLabelText("Search messages");
      fireEvent.change(box, { target: { value: "10" } });
      fireEvent.submit(box.closest("form")!);
      await waitFor(() =>
        expect(document.querySelector(".inbox__result")).not.toBeNull(),
      );
      const results = document.querySelector(".inbox__results") as HTMLElement;
      act(() => fireEvent.click(within(results).getByRole("listitem")));

      await waitFor(() =>
        expect(thread.querySelector(".wa-msg--flash")).not.toBeNull(),
      );
      await act(async () => {
        await Promise.resolve();
      });
      // Clearing the hit runs the positioning effect a second time, and a chat
      // opened from a search result is a fresh open — so stick-to-bottom was
      // still armed and undid the jump the instant it landed.
      expect(thread.scrollTop).toBe(420);
    } finally {
      restore();
    }
  });

  it("a hit found in a prepended page does not leave that page's anchor behind", async () => {
    const latest = makePage("latest", PAGE, 600);
    const older = makePage("older", PAGE, 540);
    const hits: SearchHit[] = [
      {
        eventId: "older-5",
        channelId: "ch-1",
        channelName: "Pranjali",
        ts: "2026-06-10T09:05:00Z",
        snippet: "older #<b>5</b>",
        text: "older #5",
      },
    ];
    const arrived: InboxMessage = {
      id: "latest-new",
      ts: "2026-06-10T11:00:00Z",
      kind: "message",
      text: "just in",
      fromMe: false,
      actorName: "Pranjali",
    };
    let news = false;
    const getChannelMessages = vi.fn(
      async (_id: string, opts?: { before?: string; limit?: number }) =>
        opts?.before ? older : news ? [...latest, arrived] : latest,
    );
    const { client, streams } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: getChannelMessages as unknown as WorkerClient["getChannelMessages"],
      searchInbox: vi.fn(async () => hits),
    });

    const restore = stubScrollIntoView(700);
    try {
      render(<InboxTab client={client} />);
      await waitForInbox();
      const thread = document.querySelector(".inbox__thread") as HTMLElement;
      await waitFor(() => expect(within(thread).getByText("latest #0")).toBeTruthy());
      fakeViewport(thread);

      // The hit is in a page nobody has loaded, so the jump waits — and it is
      // the scroll-up that finally renders it.
      const box = screen.getByLabelText("Search messages");
      fireEvent.change(box, { target: { value: "older" } });
      fireEvent.submit(box.closest("form")!);
      await waitFor(() =>
        expect(document.querySelector(".inbox__result")).not.toBeNull(),
      );
      const results = document.querySelector(".inbox__results") as HTMLElement;
      act(() => fireEvent.click(within(results).getByRole("listitem")));

      scrollToTop(thread);
      await waitFor(() => expect(within(thread).getByText("older #5")).toBeTruthy());
      await waitFor(() =>
        expect(thread.querySelector(".wa-msg--flash")).not.toBeNull(),
      );
      expect(thread.scrollTop).toBe(700);

      // The prepend measured an anchor the jump then took priority over. Left
      // set, it fires on whatever renders next — here a message arriving, a
      // hundred and twenty rows below — and takes the reader with it.
      news = true;
      await waitFor(() => expect(streams.length).toBeGreaterThan(0));
      act(() =>
        streams.forEach((s) =>
          s.onFrame({ type: "ingest", ts: "2026-06-10T11:00:00Z", channels: ["ch-1"] }),
        ),
      );
      await waitFor(() => expect(within(thread).getByText("just in")).toBeTruthy());
      expect(thread.scrollTop).toBe(700);
    } finally {
      restore();
    }
  });
});

// ===========================================================================
// v7 §2 — machine-written notes are folded, so one description cannot own the
// thread. Their collapsed height is fixed, because this list restores its
// scroll position before the browser has painted anything (§5).
// ===========================================================================

describe("v7 §2 — folded machine notes", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  const chats: InboxChat[] = [
    {
      id: "ch-1",
      name: "Mom",
      kind: "dm",
      lastText: "…",
      lastTs: "2026-07-02T09:00:00Z",
      messageCount: 1,
    },
  ];

  const LONG =
    "A kitchen table seen from above with one plate of rice on it, a steel " +
    "tumbler of water beside the plate, a folded newspaper at the edge of the " +
    "frame and somebody's hand reaching in from the right holding a spoon.";
  const SHORT = "A plate of rice.";

  async function render1(messages: InboxMessage[]) {
    const { client } = pairedClient({
      getInboxChats: vi.fn(async () => chats),
      getChannelMessages: vi.fn(async () => messages),
    });
    render(<InboxTab client={client} />);
    await waitForInbox();
    return document.querySelector(".inbox__thread") as HTMLElement;
  }

  function media(over: Partial<InboxMessage> = {}): InboxMessage {
    return {
      id: "m1",
      ts: "2026-07-02T09:00:00Z",
      kind: "image",
      text: "",
      fromMe: false,
      actorName: "Mom",
      mediaUrl: "/api/media/m1",
      mediaMime: "image/jpeg",
      ...over,
    };
  }

  it("folds a long description to two lines and opens it in place", async () => {
    const thread = await render1([media({ mediaDescription: LONG })]);
    await waitFor(() =>
      expect(thread.querySelector(".inbox__ai-desc")).not.toBeNull(),
    );
    const text = thread.querySelector(".inbox__ai-desc-text") as HTMLElement;
    // Folded: the whole description is in the DOM (it is searchable and
    // selectable), the stylesheet is what holds it to two lines.
    expect(text.className).toContain("inbox__ai-desc-text--folded");
    expect(text.textContent).toBe(LONG);

    const more = within(thread).getByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    await waitFor(() =>
      expect(
        (thread.querySelector(".inbox__ai-desc-text") as HTMLElement).className,
      ).not.toContain("--folded"),
    );
    // In place: still one note, no dialog, nothing navigated.
    expect(thread.querySelectorAll(".inbox__ai-desc").length).toBe(1);

    fireEvent.click(within(thread).getByRole("button", { name: "Show less" }));
    await waitFor(() =>
      expect(
        (thread.querySelector(".inbox__ai-desc-text") as HTMLElement).className,
      ).toContain("--folded"),
    );
  });

  it("leaves a short one alone — a control that shows the same text is a lie", async () => {
    const thread = await render1([media({ mediaDescription: SHORT })]);
    await waitFor(() =>
      expect(thread.querySelector(".inbox__ai-desc")).not.toBeNull(),
    );
    const text = thread.querySelector(".inbox__ai-desc-text") as HTMLElement;
    expect(text.className).not.toContain("--folded");
    expect(within(thread).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("folds a transcript and a fetched page the same way", async () => {
    const thread = await render1([
      media({
        transcript: LONG,
        link: {
          url: "https://example.com/a",
          title: null,
          description: null,
          previewType: null,
          scrapedText: LONG,
        },
      }),
    ]);
    await waitFor(() =>
      expect(thread.querySelectorAll(".inbox__ai-desc").length).toBe(2),
    );
    expect(
      thread.querySelectorAll(".inbox__ai-desc-text--folded").length,
    ).toBe(2);
    expect(
      within(thread).getAllByRole("button", { name: "Show more" }).length,
    ).toBe(2);
    // Each opens on its own — they are different texts by different machines.
    fireEvent.click(within(thread).getAllByRole("button", { name: "Show more" })[0]);
    await waitFor(() =>
      expect(
        thread.querySelectorAll(".inbox__ai-desc-text--folded").length,
      ).toBe(1),
    );
  });

  it("states the folded height rather than leaving it to the text", async () => {
    // The one property that matters and that jsdom cannot show: a note whose
    // height settles after paint moves every row under it, which is the bug
    // §5 exists to fix.
    const rule = inboxCss().slice(
      inboxCss().indexOf(".inbox__ai-desc-text--folded {"),
    );
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("height: calc(2 * 1.4em)");
    expect(body).toContain("overflow: hidden");
  });
});

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
import { ChatTab } from "./ChatTab";
import type {
  WorkerClient,
  StreamChatRequest,
  StreamHandlers,
  SessionSummary,
  SessionDetail,
  EvaluationInput,
  Usage,
} from "../lib/worker-client";

afterEach(cleanup);

/** Token counts every `done` frame carries; no test here reads the numbers. */
const USAGE: Usage = {
  inputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 2,
};

// ---------------------------------------------------------------------------
// A controllable mock worker client. `streamChat` records the request and hands
// the test a `handlers` bundle to drive the fake stream frame-by-frame, plus a
// `resolve` to end the stream (as the real fn does when the body closes).
// ---------------------------------------------------------------------------
interface ActiveStream {
  req: StreamChatRequest;
  handlers: StreamHandlers;
  resolve: () => void;
}

function makeClient(overrides: Partial<WorkerClient> = {}) {
  const streams: ActiveStream[] = [];
  const cancelRun = vi.fn(async (_runId: string) => ({ ok: true }));
  const postEvaluation = vi.fn(async (_input: EvaluationInput) => ({ ok: true }));
  const getEventDetail = vi.fn(async (id: string) => ({
    id,
    ts: "2026-07-01T10:00:00Z",
    kind: "message",
    text: "Flights are still pending booking",
    actor_name: "Alice",
    channel_name: "Goa Trip 2026",
  }));

  const client: WorkerClient = {
    getChatStatus: vi.fn(async () => ({ enabled: true })),
    listSessions: vi.fn(async () => [] as SessionSummary[]),
    getSession: vi.fn(async (): Promise<SessionDetail> => {
      throw new Error("not mocked");
    }),
    getQuota: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    getHealth: vi.fn(async () => ({ ok: true })),
    cancelRun,
    postEvaluation,
    getEventDetail,
    streamChat: vi.fn((req: StreamChatRequest, handlers: StreamHandlers) => {
      return new Promise<void>((resolve) => {
        streams.push({ req, handlers, resolve });
      });
    }),
    ...overrides,
  } as WorkerClient;

  return { client, streams, cancelRun, postEvaluation, getEventDetail };
}

function type(text: string) {
  const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  return box;
}

describe("ChatTab / useChat", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  it("(a) renders the user bubble and streams assistant deltas into a bubble", async () => {
    const { client, streams } = makeClient();
    render(<ChatTab client={client} />);

    // initial sessions load
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());

    const box = type("hello there");
    fireEvent.keyDown(box, { key: "Enter" });

    // user bubble appears immediately (optimistic)
    await screen.findByText("hello there");
    await waitFor(() => expect(streams.length).toBe(1));

    const s = streams[0];
    // drive the fake stream
    act(() => s.handlers.onSession?.("sess-A"));
    act(() => s.handlers.onDelta?.("Hi "));
    act(() => s.handlers.onDelta?.("there!"));
    act(() => s.handlers.onDone?.({ sessionId: "sess-A", usage: USAGE }));
    await act(async () => {
      s.resolve();
    });

    await screen.findByText("Hi there!");

    // one user + one assistant row
    const rows = document.querySelectorAll(".chat__row");
    expect(rows.length).toBe(2);
    expect(document.querySelector(".chat__row--user")?.textContent).toContain("hello there");
    expect(document.querySelector(".chat__row--assistant")?.textContent).toContain("Hi there!");
  });

  it("(b) captures sessionId from the first session event and reuses it on the next send", async () => {
    const { client, streams } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());

    // turn 1 — fresh session (sessionId null), server assigns sess-XYZ
    type("first");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(1));
    expect(streams[0].req.sessionId).toBeNull();

    act(() => streams[0].handlers.onSession?.("sess-XYZ"));
    act(() => streams[0].handlers.onDelta?.("ok"));
    act(() => streams[0].handlers.onDone?.({ sessionId: "sess-XYZ", usage: USAGE }));
    await act(async () => streams[0].resolve());

    // turn 2 — must resume with the adopted sessionId
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send" })).not.toBeNull());
    type("second");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(2));
    expect(streams[1].req.sessionId).toBe("sess-XYZ");
  });

  it("adopts a NEW sessionId if the server swaps it mid-conversation (poison fallback)", async () => {
    const { client, streams } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());

    type("one");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(1));
    act(() => streams[0].handlers.onSession?.("sess-1"));
    act(() => streams[0].handlers.onDone?.({ sessionId: "sess-1", usage: USAGE }));
    await act(async () => streams[0].resolve());

    // next turn resumes sess-1, but the worker falls back to a fresh sess-2
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send" })).not.toBeNull());
    type("two");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(2));
    expect(streams[1].req.sessionId).toBe("sess-1");
    act(() => streams[1].handlers.onSession?.("sess-2")); // swapped id
    act(() => streams[1].handlers.onDone?.({ sessionId: "sess-2", usage: USAGE }));
    await act(async () => streams[1].resolve());

    // third turn must use the NEW id
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send" })).not.toBeNull());
    type("three");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(3));
    expect(streams[2].req.sessionId).toBe("sess-2");
  });

  it("(c) Cancel calls cancelRun with the runId and stops streaming", async () => {
    const { client, streams, cancelRun } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());

    type("do a thing");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(1));

    act(() => streams[0].handlers.onSession?.("sess-C"));
    act(() => streams[0].handlers.onDelta?.("partial"));

    // Cancel button is shown while streaming
    const cancelBtn = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(1));
    expect(cancelRun.mock.calls[0][0]).toBe(streams[0].req.runId);

    // streaming stops → Send button returns
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send" })).not.toBeNull());
    // partial text stays in the bubble
    expect(document.querySelector(".chat__row--assistant")?.textContent).toContain("partial");
  });

  it("(d) selecting a past session loads its messages via getSession", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionId: "old-1",
        title: "Yesterday's chat",
        cwd: "/",
        status: "active",
        createdAt: "2026-07-01T10:00:00Z",
        updatedAt: "2026-07-01T10:05:00Z",
        messageCount: 2,
      },
    ];
    const detail: SessionDetail = {
      session: sessions[0],
      messages: [
        { role: "user", content: "old question", ts: "2026-07-01T10:00:00Z" },
        { role: "assistant", content: "old answer", ts: "2026-07-01T10:00:05Z" },
      ],
    };
    const { client } = makeClient({
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async () => detail),
    });

    render(<ChatTab client={client} />);

    // sidebar shows the session
    const item = await screen.findByRole("listitem", { name: /Yesterday's chat/ });
    fireEvent.click(item);

    await waitFor(() => expect(client.getSession).toHaveBeenCalledWith("old-1"));
    await screen.findByText("old question");
    await screen.findByText("old answer");
  });

  it("New chat clears the active conversation and thread", async () => {
    const sessions: SessionSummary[] = [
      { sessionId: "s", title: "prev", cwd: "/", status: "active", createdAt: "", updatedAt: "", messageCount: 1 },
    ];
    const detail: SessionDetail = {
      session: sessions[0],
      messages: [{ role: "user", content: "existing msg", ts: "" }],
    };
    const { client } = makeClient({
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async () => detail),
    });
    render(<ChatTab client={client} />);

    fireEvent.click(await screen.findByRole("listitem", { name: /prev/ }));
    await screen.findByText("existing msg");

    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    await waitFor(() => expect(screen.queryByText("existing msg")).toBeNull());
    // header reflects a fresh chat
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
  });

  it("Shift+Enter does not send", async () => {
    const { client, streams } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());
    const box = type("line one");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    // no stream started
    expect(streams.length).toBe(0);
  });
});

describe("grounded chat (Phase 2 T4)", () => {
  async function streamGroundedAnswer(
    streams: ActiveStream[],
    text = "Flights are pending [1] in the trip space [2].",
  ) {
    const s = streams[0];
    act(() => s.handlers.onSession?.("sess-G"));
    act(() => s.handlers.onDelta?.(text));
    act(() =>
      s.handlers.onDelta?.(
        '\nCITATIONS: [{"n":1,"kind":"event","id":"evt_flights","label":"Alice · flights pending"},{"n":2,"kind":"space","id":"space_goa","label":"Goa Trip"}]',
      ),
    );
    act(() =>
      s.handlers.onCitations?.([
        { n: 1, kind: "event", id: "evt_flights", label: "Alice · flights pending" },
        { n: 2, kind: "space", id: "space_goa", label: "Goa Trip" },
      ]),
    );
    act(() =>
      s.handlers.onDone?.({
        sessionId: "sess-G",
        usage: USAGE,
      }),
    );
    await act(async () => s.resolve());
  }

  it("shows the grounded indicator on a new chat", async () => {
    const { client } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());
    expect(screen.getByText(/grounded/)).toBeTruthy();
  });

  it("hides the indicator on an old ungrounded session", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionId: "old-1",
        title: "old",
        cwd: "/",
        status: "active",
        grounded: false,
        createdAt: "",
        updatedAt: "",
        messageCount: 1,
      },
    ];
    const detail: SessionDetail = {
      session: sessions[0],
      messages: [{ role: "user", content: "hi", ts: "" }],
    };
    const { client } = makeClient({
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async () => detail),
    });
    render(<ChatTab client={client} />);
    fireEvent.click(await screen.findByRole("listitem"));
    await screen.findByText("hi");
    expect(screen.queryByText(/grounded/)).toBeNull();
  });

  it("strips the CITATIONS line and renders [n] markers as clickable chips", async () => {
    const { client, streams } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());
    type("what's pending for the trip?");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(1));
    await streamGroundedAnswer(streams);

    const bubble = document.querySelector(".chat__row--assistant");
    expect(bubble?.textContent).toContain("Flights are pending");
    expect(bubble?.textContent).not.toContain("CITATIONS:");

    // Only the event citation becomes a chip; the space citation's [2] marker
    // is left as plain text.
    const chips = document.querySelectorAll(".chat__cite");
    expect(chips.length).toBe(1);
    expect(
      screen.getByRole("button", { name: /Citation 1: Alice/ }),
    ).toBeTruthy();
  });

  it("clicking an event chip opens the provenance popover with the source message", async () => {
    const { client, streams, getEventDetail } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());
    type("q");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(1));
    await streamGroundedAnswer(streams);

    fireEvent.click(screen.getByRole("button", { name: /Citation 1/ }));
    await waitFor(() => expect(getEventDetail).toHaveBeenCalledWith("evt_flights"));
    const popover = await screen.findByRole("dialog", { name: "Citation source" });
    expect(popover.textContent).toContain("Flights are still pending booking");
    expect(popover.textContent).toContain("Alice");

    fireEvent.click(screen.getByRole("button", { name: "Close citation" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Citation source" })).toBeNull(),
    );
  });

  it("a non-event citation (space) never becomes a chip", async () => {
    const { client, streams } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());
    type("q");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(1));
    await streamGroundedAnswer(streams);

    // The Spaces surface is out of scope in V8, so a space citation has nowhere
    // to go — it must not render a chip the user can click into nothing.
    expect(screen.queryByRole("button", { name: /Citation 2/ })).toBeNull();
    expect(client.getEventDetail).not.toHaveBeenCalled();
  });

  it("drops a stale persisted non-event citation instead of rendering a dead chip", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionId: "g-2",
        title: "old grounded chat",
        cwd: "/",
        status: "active",
        grounded: true,
        createdAt: "",
        updatedAt: "",
        messageCount: 2,
      },
    ];
    const detail: SessionDetail = {
      session: sessions[0],
      messages: [
        { role: "user", content: "what's pending?", ts: "", runId: "r-9" },
        {
          role: "assistant",
          content: "Flights [1] for the trip [2].",
          ts: "",
          runId: "r-9",
          citations: [
            { n: 1, kind: "event", id: "evt_flights", label: "Alice · flights" },
            { n: 2, kind: "space", id: "space_goa", label: "Goa Trip" },
          ],
        },
      ],
    };
    const { client } = makeClient({
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async () => detail),
    });
    render(<ChatTab client={client} />);
    fireEvent.click(await screen.findByRole("listitem"));
    await screen.findByText("what's pending?");

    expect(document.querySelectorAll(".chat__cite").length).toBe(1);
    expect(screen.queryByRole("button", { name: /Citation 2/ })).toBeNull();
  });

  it("👍/👎 posts a chat_answer evaluation keyed by the runId", async () => {
    const { client, streams, postEvaluation } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.listSessions).toHaveBeenCalled());
    type("rate me");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streams.length).toBe(1));
    await streamGroundedAnswer(streams, "Answer.");

    fireEvent.click(screen.getByRole("button", { name: "Good answer" }));
    await waitFor(() => expect(postEvaluation).toHaveBeenCalledTimes(1));
    expect(postEvaluation.mock.calls[0][0]).toEqual({
      output_type: "chat_answer",
      output_id: streams[0].req.runId,
      verdict: "up",
    });
    // buttons collapse into a "voted" marker
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull(),
    );
  });

  it("re-opening a saved session renders persisted citations as chips", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionId: "g-1",
        title: "grounded chat",
        cwd: "/",
        status: "active",
        grounded: true,
        createdAt: "",
        updatedAt: "",
        messageCount: 2,
      },
    ];
    const detail: SessionDetail = {
      session: sessions[0],
      messages: [
        { role: "user", content: "what's pending?", ts: "", runId: "r-1" },
        {
          role: "assistant",
          content: "Flights [1].",
          ts: "",
          runId: "r-1",
          citations: [
            { n: 1, kind: "event", id: "evt_flights", label: "Alice · flights" },
          ],
        },
      ],
    };
    const { client } = makeClient({
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async () => detail),
    });
    render(<ChatTab client={client} />);
    fireEvent.click(await screen.findByRole("listitem"));
    await screen.findByText("what's pending?");
    expect(document.querySelectorAll(".chat__cite").length).toBe(1);
    // grounded indicator shows for the grounded session
    expect(document.querySelector(".chat__grounded")).toBeTruthy();
  });
});

describe("chat kill-switch visibility", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = globalThis.window ?? {};
  });

  function offClient() {
    return makeClient({
      getChatStatus: vi.fn(async () => ({ enabled: false })),
    });
  }

  it("banners the off state and locks the composer when chat is disabled", async () => {
    const { client } = offClient();
    render(<ChatTab client={client} />);

    const banner = await screen.findByTestId("chat-off-banner");
    expect(banner.textContent).toContain("Chat is turned off");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows no banner and an open composer when chat is enabled", async () => {
    const { client } = makeClient();
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.getChatStatus).toHaveBeenCalled());

    expect(screen.queryByTestId("chat-off-banner")).toBeNull();
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: "hi" } });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("the banner's button opens Settings", async () => {
    const onOpenSettings = vi.fn();
    const { client } = offClient();
    render(<ChatTab client={client} onOpenSettings={onOpenSettings} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("stays usable when the worker cannot answer the status call", async () => {
    const { client } = makeClient({
      getChatStatus: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    render(<ChatTab client={client} />);
    await waitFor(() => expect(client.getChatStatus).toHaveBeenCalled());

    expect(screen.queryByTestId("chat-off-banner")).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(
      false,
    );
  });
});

describe("useChat helper: getSession detail shapes into bubbles", () => {
  it("filters out non-user/assistant roles", async () => {
    const detail: SessionDetail = {
      session: { sessionId: "x", title: null, cwd: "/", status: "active", createdAt: "", updatedAt: "", messageCount: 3 },
      messages: [
        { role: "system", content: "sys prompt", ts: "" },
        { role: "user", content: "hi", ts: "" },
        { role: "assistant", content: "hello", ts: "" },
      ],
    };
    const { client } = makeClient({
      listSessions: vi.fn(async () => [detail.session]),
      getSession: vi.fn(async () => detail),
    });
    render(<ChatTab client={client} />);
    fireEvent.click(await screen.findByRole("listitem"));
    await screen.findByText("hi");
    await screen.findByText("hello");
    expect(screen.queryByText("sys prompt")).toBeNull();

    const rows = document.querySelectorAll(".chat__row");
    expect(rows.length).toBe(2);
    // sanity: within thread
    const thread = document.querySelector(".chat__thread") as HTMLElement;
    expect(within(thread).getByText("hi")).toBeTruthy();
  });
});

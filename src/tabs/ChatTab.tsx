// Functional Phase 0 Chat tab (docs/PHASE0_ARCHITECTURE.md §8).
//
// Layout: a sessions sidebar (list + "New chat"), a scrollable message thread
// with user/assistant bubbles (assistant text streams in live), and a composer
// (textarea + Send; Enter sends, Shift+Enter inserts a newline). A Cancel
// button replaces Send while a response is streaming.
//
// Chat can be switched off in Settings. It is the app's ONLY feature, so an off
// switch must be visible rather than silent: the tab keeps rendering, states
// plainly that chat is off, and locks the composer.
//
// State lives in useChat; this component is presentation + input handling only.
// The `client` prop exists so tests can inject a mock worker client; production
// callers (App.tsx) render <ChatTab /> with no props.

import { useCallback, useEffect, useRef, useState } from "react";
import { useChat, type ChatMessage } from "../lib/useChat";
import {
  workerClient as defaultClient,
  type Citation,
  type EventDetail,
  type WorkerClient,
  type SessionSummary,
} from "../lib/worker-client";

/** How often the tab re-reads the chat kill-switch. */
const STATUS_POLL_MS = 5000;

interface ChatTabProps {
  /** Injected worker client (tests). Defaults to the real localhost client. */
  client?: WorkerClient;
  /** Switches the app to the Settings tab (the off-switch lives there). */
  onOpenSettings?: () => void;
}

/** State for the event-citation provenance popover. */
interface CitePopover {
  citation: Citation;
  loading: boolean;
  event: EventDetail | null;
  error: string | null;
}

/**
 * Render assistant text with `[n]` markers turned into clickable superscript
 * citation chips (only for ns that actually exist in `citations`).
 *
 * Space/person/task citations have no destination in V8 — the tabs that showed
 * them are gone — so they never become a chip. The worker drops them too, but a
 * transcript persisted before it did must not resurrect a dead chip either.
 */
function renderWithCitations(
  content: string,
  citations: Citation[] | null | undefined,
  onCite: (c: Citation) => void,
): React.ReactNode {
  const events = (citations ?? []).filter((c) => c.kind === "event");
  if (events.length === 0) return content;
  const byN = new Map(events.map((c) => [c.n, c]));
  const parts = content.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    const cite = m ? byN.get(Number(m[1])) : undefined;
    if (!cite) return <span key={i}>{part}</span>;
    return (
      <button
        key={i}
        type="button"
        className="chat__cite"
        title={cite.label || `${cite.kind} ${cite.id}`}
        aria-label={`Citation ${cite.n}: ${cite.label || cite.kind}`}
        onClick={() => onCite(cite)}
      >
        <sup>[{cite.n}]</sup>
      </button>
    );
  });
}

function sessionLabel(s: SessionSummary): string {
  if (s.title && s.title.trim().length > 0) return s.title;
  return `Chat ${s.sessionId.slice(0, 8)}`;
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ChatTab({ client, onOpenSettings }: ChatTabProps = {}) {
  const wc = client ?? defaultClient;
  const chat = useChat(client);
  const [draft, setDraft] = useState("");
  const [popover, setPopover] = useState<CitePopover | null>(null);
  /** message client-id -> vote already cast ("up" | "down"). */
  const [votes, setVotes] = useState<Record<string, "up" | "down">>({});
  // Assume on until the worker says otherwise, so an offline worker never
  // accuses the user of having switched chat off.
  const [chatEnabled, setChatEnabled] = useState(true);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Re-read the kill-switch on a timer as well as on mount: the toggle lives in
  // Settings, and the tab stays mounted while the user flips it back.
  useEffect(() => {
    const controller = new AbortController();

    async function poll() {
      try {
        const status = await wc.getChatStatus(controller.signal);
        if (mountedRef.current) setChatEnabled(status.enabled);
      } catch {
        // Worker down / older worker without the endpoint: leave chat usable.
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [wc]);

  // Click on a [n] chip. Only event citations become chips, so this always has
  // a source message to open the provenance popover on.
  const onCite = useCallback(
    (c: Citation) => {
      setPopover({ citation: c, loading: true, event: null, error: null });
      wc.getEventDetail(c.id)
        .then((event) =>
          setPopover((p) =>
            p && p.citation.id === c.id ? { ...p, loading: false, event } : p,
          ),
        )
        .catch((err: unknown) =>
          setPopover((p) =>
            p && p.citation.id === c.id
              ? {
                  ...p,
                  loading: false,
                  error: err instanceof Error ? err.message : "Failed to load",
                }
              : p,
          ),
        );
    },
    [wc],
  );

  // 👍/👎 on an assistant answer → POST /api/evaluations (chat_answer).
  const onVote = useCallback(
    (m: ChatMessage, verdict: "up" | "down") => {
      setVotes((prev) => ({ ...prev, [m.id]: verdict }));
      void wc
        .postEvaluation({
          output_type: "chat_answer",
          output_id: m.runId ?? m.id,
          verdict,
        })
        .catch(() => {
          // Vote is best-effort; drop the optimistic mark on failure.
          setVotes((prev) => {
            const next = { ...prev };
            delete next[m.id];
            return next;
          });
        });
    },
    [wc],
  );

  // Keep the thread pinned to the newest content as it streams.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const canSend = draft.trim().length > 0 && !chat.streaming && chatEnabled;

  async function submit() {
    if (!canSend) return;
    const text = draft;
    setDraft("");
    await chat.send(text);
    textareaRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  const showThreadEmpty = chat.messages.length === 0 && !chat.loadingSession;

  return (
    <section className="chat" aria-label="Chat">
      {/* ---- Sessions sidebar ------------------------------------------- */}
      <aside className="chat__sessions" aria-label="Conversations">
        <div className="chat__sessions-head">
          <span className="chat__sessions-title">Conversations</span>
          <button
            type="button"
            className="chat__newbtn"
            onClick={() => {
              chat.newChat();
              setDraft("");
              textareaRef.current?.focus();
            }}
          >
            + New chat
          </button>
        </div>

        <div className="chat__sessions-list" role="list">
          {chat.sessionsLoading && chat.sessions.length === 0 ? (
            <p className="chat__sessions-empty">Loading…</p>
          ) : chat.sessions.length === 0 ? (
            <p className="chat__sessions-empty">No conversations yet.</p>
          ) : (
            chat.sessions.map((s) => {
              const active = s.sessionId === chat.activeSessionId;
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  role="listitem"
                  className={
                    "chat__session" + (active ? " chat__session--active" : "")
                  }
                  aria-current={active ? "true" : undefined}
                  onClick={() => void chat.openSession(s.sessionId)}
                  title={sessionLabel(s)}
                >
                  <span className="chat__session-name">{sessionLabel(s)}</span>
                  <span className="chat__session-meta">
                    {s.status === "poisoned" && (
                      <span className="chat__session-flag">reset</span>
                    )}
                    <span className="chat__session-when">
                      {formatWhen(s.updatedAt)}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ---- Main conversation ------------------------------------------ */}
      <div className="chat__main">
        <header className="chat__header">
          <h1 className="chat__title">
            {chat.activeSessionId ? "Conversation" : "New chat"}
          </h1>
          {chat.grounded && (
            <span
              className="chat__grounded"
              title="This conversation can read your brain (spaces, people, events) and cites its sources."
            >
              ⛁ grounded
            </span>
          )}
          {chat.streaming && (
            <span className="chat__status" aria-live="polite">
              <span className="chat__status-dot" /> Assistant is typing…
            </span>
          )}
        </header>

        {!chatEnabled && (
          <div className="chat__off" role="status" data-testid="chat-off-banner">
            <span>
              <strong>Chat is turned off.</strong> It's switched off in Settings,
              and it's the only thing SuperTwinV13 does — nothing here works until
              you turn it back on.
            </span>
            <button
              type="button"
              className="chat__off-btn"
              onClick={() => onOpenSettings?.()}
            >
              Open Settings
            </button>
          </div>
        )}

        {chat.error && (
          <div className="chat__error" role="alert">
            <span>
              <strong>{chat.error.code}:</strong> {chat.error.message}
            </span>
            <button
              type="button"
              className="chat__error-x"
              aria-label="Dismiss error"
              onClick={chat.dismissError}
            >
              ×
            </button>
          </div>
        )}

        <div className="chat__thread" ref={threadRef}>
          {chat.loadingSession ? (
            <div className="chat__thread-empty">Loading conversation…</div>
          ) : showThreadEmpty ? (
            <div className="chat__thread-empty">
              <div className="chat__welcome">
                <p className="chat__welcome-title">Ask SuperTwinV13 anything</p>
                <p className="chat__welcome-sub">
                  Messages stream in live. Your conversation is saved locally so
                  you can pick it back up from the sidebar.
                </p>
              </div>
            </div>
          ) : (
            chat.messages.map((m) => (
              <div
                key={m.id}
                className={`chat__row chat__row--${m.role}`}
                data-role={m.role}
              >
                <div
                  className={
                    "chat__bubble chat__bubble--" +
                    m.role +
                    (m.error ? " chat__bubble--error" : "")
                  }
                >
                  {m.content.length > 0 ? (
                    <span className="chat__bubble-text">
                      {m.role === "assistant"
                        ? renderWithCitations(m.content, m.citations, onCite)
                        : m.content}
                    </span>
                  ) : m.streaming ? (
                    <span className="chat__typing" aria-label="typing">
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <span className="chat__bubble-text chat__bubble-text--muted">
                      (no response)
                    </span>
                  )}
                  {m.error && (
                    <span className="chat__bubble-err">
                      {m.error.code}: {m.error.message}
                    </span>
                  )}
                </div>
                {m.role === "assistant" &&
                  !m.streaming &&
                  !m.error &&
                  m.content.length > 0 && (
                    <div className="chat__eval" aria-label="Rate this answer">
                      {votes[m.id] ? (
                        <span className="chat__eval-done">
                          {votes[m.id] === "up" ? "👍" : "👎"} thanks
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="chat__eval-btn"
                            aria-label="Good answer"
                            onClick={() => onVote(m, "up")}
                          >
                            👍
                          </button>
                          <button
                            type="button"
                            className="chat__eval-btn"
                            aria-label="Bad answer"
                            onClick={() => onVote(m, "down")}
                          >
                            👎
                          </button>
                        </>
                      )}
                    </div>
                  )}
              </div>
            ))
          )}

        </div>

        {/* ---- Citation provenance popover -------------------------------- */}
        {popover && (
          <div
            className="chat__cite-popover"
            role="dialog"
            aria-label="Citation source"
          >
            <div className="chat__cite-popover-head">
              <span className="chat__cite-popover-title">
                Source [{popover.citation.n}]
              </span>
              <button
                type="button"
                className="chat__error-x"
                aria-label="Close citation"
                onClick={() => setPopover(null)}
              >
                ×
              </button>
            </div>
            {popover.loading ? (
              <p className="chat__cite-popover-body">Loading…</p>
            ) : popover.error ? (
              <p className="chat__cite-popover-body">
                {popover.citation.label || popover.citation.id}
                <br />
                <em>({popover.error})</em>
              </p>
            ) : popover.event ? (
              <div className="chat__cite-popover-body">
                <p className="chat__cite-popover-meta">
                  {popover.event.actor_name ?? "Unknown"} ·{" "}
                  {popover.event.channel_name ?? "?"}
                  {popover.event.ts ? ` · ${formatWhen(popover.event.ts)}` : ""}
                </p>
                <p className="chat__cite-popover-text">
                  {popover.event.text ?? "(no text)"}
                </p>
              </div>
            ) : null}
          </div>
        )}

        {/* ---- Composer -------------------------------------------------- */}
        <div className="chat__composer">
          <textarea
            ref={textareaRef}
            className="chat__input"
            placeholder={
              chatEnabled
                ? "Message SuperTwinV13…  (Enter to send, Shift+Enter for a new line)"
                : "Chat is turned off in Settings."
            }
            value={draft}
            rows={1}
            disabled={!chatEnabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Message"
          />
          {chat.streaming ? (
            <button
              type="button"
              className="chat__send chat__send--cancel"
              onClick={() => void chat.cancel()}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="chat__send"
              disabled={!canSend}
              onClick={() => void submit()}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

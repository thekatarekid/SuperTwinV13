// Chat state hook (Phase 0 §8).
//
// Owns everything the Chat tab renders: the sessions sidebar list, the active
// session id, the message thread, the streaming flag, the in-flight runId, and
// the last error. It talks to the worker exclusively through an injected
// `WorkerClient` (defaults to the real one) so tests can supply a mock.
//
// Multi-turn resume: the sessionId is NOT known until the worker sends the
// first `session` event of a run. We optimistically render before that, then
// adopt whatever id the server reports — and re-adopt if it changes mid-stream
// (a poison fallback swaps in a fresh id, which §4 says to treat as normal).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  workerClient as defaultClient,
  type Citation,
  type ProviderErrorCode,
  type SessionMessage,
  type SessionSummary,
  type WorkerClient,
} from "./worker-client";

export interface ChatMessage {
  /** Stable client id for React keys; distinct from any server id. */
  id: string;
  role: "user" | "assistant";
  content: string;
  /** true while this (assistant) bubble is still receiving deltas. */
  streaming?: boolean;
  /** set when this assistant turn ended in a worker error. */
  error?: { code: ProviderErrorCode; message: string };
  /** The runId that produced this message (eval output_id for chat answers). */
  runId?: string | null;
  /** Citations attached to a grounded assistant answer. */
  citations?: Citation[] | null;
}

/**
 * Strip a trailing `CITATIONS: [...]` line from streamed assistant text. The
 * worker strips it before persisting, but the raw deltas the UI streamed still
 * contain it — this removes it from the live bubble.
 */
export function stripCitationsLine(text: string): string {
  const m = /(?:^|\n)\s*CITATIONS:\s*\[[\s\S]*\]\s*$/.exec(text);
  if (!m) return text;
  return text.slice(0, m.index).replace(/\s+$/, "");
}

export interface ChatError {
  code: ProviderErrorCode | "TRANSPORT";
  message: string;
}

export interface UseChat {
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  activeSessionId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  runId: string | null;
  error: ChatError | null;
  loadingSession: boolean;
  /** True when the current conversation has brain access (grounded chat). */
  grounded: boolean;

  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  newChat(): void;
  openSession(sessionId: string): Promise<void>;
  refreshSessions(): Promise<void>;
  dismissError(): void;
}

let msgSeq = 0;
function newMessageId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}-${msgSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function genRunId(): string {
  // crypto.randomUUID is available in the Tauri webview and jsdom.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toChatMessages(rows: SessionMessage[]): ChatMessage[] {
  return rows
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: newMessageId(m.role),
      role: m.role as "user" | "assistant",
      content: m.content,
      runId: m.runId ?? null,
      citations: m.citations ?? null,
    }));
}

export function useChat(client: WorkerClient = defaultClient): UseChat {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);

  // Refs mirror the pieces the async stream callback needs without going stale.
  const abortRef = useRef<AbortController | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const setActive = useCallback((id: string | null) => {
    activeSessionRef.current = id;
    setActiveSessionId(id);
  }, []);

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const list = await client.listSessions();
      if (mountedRef.current) setSessions(list);
    } catch {
      // A missing/offline worker just means an empty sidebar — not a hard error.
      if (mountedRef.current) setSessions([]);
    } finally {
      if (mountedRef.current) setSessionsLoading(false);
    }
  }, [client]);

  // Load the sidebar once on mount.
  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const patchAssistant = useCallback(
    (mut: (m: ChatMessage) => ChatMessage) => {
      const id = assistantIdRef.current;
      if (!id) return;
      setMessages((prev) => prev.map((m) => (m.id === id ? mut(m) : m)));
    },
    [],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || streaming) return;

      setError(null);
      const id = genRunId();
      runIdRef.current = id;
      setRunId(id);

      // Optimistic append: user bubble + an empty assistant bubble to stream into.
      const userMsg: ChatMessage = {
        id: newMessageId("user"),
        role: "user",
        content: trimmed,
        runId: id,
      };
      const assistantMsg: ChatMessage = {
        id: newMessageId("assistant"),
        role: "assistant",
        content: "",
        streaming: true,
        runId: id,
      };
      assistantIdRef.current = assistantMsg.id;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await client.streamChat(
          {
            runId: id,
            sessionId: activeSessionRef.current,
            message: trimmed,
          },
          {
            onSession: (sessionId) => {
              // Adopt (or re-adopt on poison fallback) the server session id.
              setActive(sessionId);
            },
            onDelta: (delta) => {
              patchAssistant((m) => ({ ...m, content: m.content + delta }));
            },
            onCitations: (citations) => {
              // The worker already stripped the CITATIONS line from the
              // persisted text; mirror that on the live streamed bubble.
              patchAssistant((m) => ({
                ...m,
                citations,
                content: stripCitationsLine(m.content),
              }));
            },
            onError: (e) => {
              patchAssistant((m) => ({
                ...m,
                streaming: false,
                error: { code: e.code, message: e.message },
              }));
              if (mountedRef.current) setError({ code: e.code, message: e.message });
            },
            onDone: () => {
              // Defensive second strip: if the citations frame was missed the
              // trailing machine line still never reaches the user.
              patchAssistant((m) => ({
                ...m,
                streaming: false,
                content: stripCitationsLine(m.content),
              }));
            },
          },
          controller.signal,
        );
      } catch (err) {
        // Transport-level failure (worker down / network). Surface on the bubble.
        const message =
          err instanceof Error ? err.message : "Failed to reach the worker.";
        patchAssistant((m) => ({
          ...m,
          streaming: false,
          error: { code: "CLI_ERROR", message },
        }));
        if (mountedRef.current) setError({ code: "TRANSPORT", message });
      } finally {
        if (mountedRef.current) {
          setStreaming(false);
          setRunId(null);
          patchAssistant((m) => (m.streaming ? { ...m, streaming: false } : m));
        }
        runIdRef.current = null;
        abortRef.current = null;
        assistantIdRef.current = null;
        // Refresh the sidebar so a brand-new session appears / titles update.
        void refreshSessions();
      }
    },
    [client, streaming, setActive, patchAssistant, refreshSessions],
  );

  const cancel = useCallback(async () => {
    const id = runIdRef.current;
    // Tear down the fetch locally first so the stream stops immediately.
    abortRef.current?.abort();
    if (id) {
      try {
        await client.cancelRun(id);
      } catch {
        // Even if the worker cancel call fails, the local abort already stopped
        // the UI stream — nothing more to do.
      }
    }
    if (mountedRef.current) {
      setStreaming(false);
      setRunId(null);
      patchAssistant((m) => ({ ...m, streaming: false }));
    }
  }, [client, patchAssistant]);

  const newChat = useCallback(() => {
    if (streaming) {
      abortRef.current?.abort();
      const id = runIdRef.current;
      if (id) void client.cancelRun(id).catch(() => undefined);
    }
    setActive(null);
    setMessages([]);
    setError(null);
    setStreaming(false);
    setRunId(null);
  }, [client, streaming, setActive]);

  const openSession = useCallback(
    async (sessionId: string) => {
      if (streaming) {
        abortRef.current?.abort();
        const id = runIdRef.current;
        if (id) void client.cancelRun(id).catch(() => undefined);
        setStreaming(false);
        setRunId(null);
      }
      setError(null);
      setLoadingSession(true);
      setActive(sessionId);
      try {
        const detail = await client.getSession(sessionId);
        if (mountedRef.current) setMessages(toChatMessages(detail.messages));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load session.";
        if (mountedRef.current) {
          setMessages([]);
          setError({ code: "TRANSPORT", message });
        }
      } finally {
        if (mountedRef.current) setLoadingSession(false);
      }
    },
    [client, streaming, setActive],
  );

  const dismissError = useCallback(() => setError(null), []);

  // Grounded indicator: fresh chats are grounded by default; saved sessions
  // report their own flag (old Phase-0 sessions report false).
  const grounded = useMemo(() => {
    if (!activeSessionId) return true;
    const s = sessions.find((x) => x.sessionId === activeSessionId);
    return s ? s.grounded === true : true;
  }, [activeSessionId, sessions]);

  return useMemo(
    () => ({
      sessions,
      sessionsLoading,
      activeSessionId,
      messages,
      streaming,
      runId,
      error,
      loadingSession,
      grounded,
      send,
      cancel,
      newChat,
      openSession,
      refreshSessions,
      dismissError,
    }),
    [
      sessions,
      sessionsLoading,
      activeSessionId,
      messages,
      streaming,
      runId,
      error,
      loadingSession,
      grounded,
      send,
      cancel,
      newChat,
      openSession,
      refreshSessions,
      dismissError,
    ],
  );
}

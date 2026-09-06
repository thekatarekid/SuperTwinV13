// ===========================================================================
// Grounded bar — build P4.1, spec §14.8 (all six states).
//
// One pill, morphing states, NO modes:
//   ① collapsed  — always visible; ↑ opens history (⌘↑)
//   ② focused    — live results while typing (worker /api/bar/search)
//   ③ answer     — grounded chat: citations mandatory (chips → Timeline),
//                  inline webview card when the answer carries a URL
//   ④ acting     — action outcomes: inline progress, ask-once options,
//                  risky work lands behind the normal task/approval gates
//   ⑤ context-locked — "Tell the twin" (P1.7, unchanged)
//   ⑥ history    — past threads, reopenable + continuable (USR-06)
//
// Intent is inferred worker-side (traced Haiku router); Esc walks back one
// state; threads survive in history because the worker stores them as events.
//
// V6 P1 R2 renders what S5.5 started returning and the overlay was dropping on
// the floor (Product_V6_Phase1 §19.4–19.6, §21):
//
//   coverage caveat   what the twin does NOT have over the asked range, in the
//                     worker's own sentence ("I only have WhatsApp back to
//                     Jan 2024"). Never inferred here — the coverage index
//                     decides, the bar prints.
//   sufficiency       decided in CODE per class, so a partial answer says it
//                     is partial and NAMES its gaps instead of reading like a
//                     complete one. Insufficient is never silence.
//   general label     an answer with no retrieval behind it is labelled "not
//                     from your data" — the one answer that is not grounded
//                     must be the one answer that says so.
//   quick chips       the thread locks to the object the bar just made, and
//                     the chips for that object type ride back with it. A chip
//                     IS a correction: it goes down the same pipeline as a
//                     drag, undo included.
// ===========================================================================

import { useEffect, useRef, useState } from "react";
import {
  fetchBarThread,
  fetchBarThreads,
  postBar,
  type ArtifactRow,
  type BarActionView,
  type BarAnswerView,
  type BarChipView,
  type BarCitationView,
  type BarLockView,
  type BarResponse,
  type BarThreadSummaryView,
  type TargetKind,
  type TypeaheadView,
} from "../lib/api";
import { useTypeahead } from "../lib/useTypeahead";

export interface BarLock {
  kind: TargetKind;
  id: string;
  label: string;
}

interface BarMessage {
  role: "user" | "twin";
  text: string;
  citations?: BarCitationView[];
  action?: BarActionView;
  /** The whole answer, so the caveat / gaps / label render with their turn. */
  answer?: BarAnswerView;
}

type BarView = "input" | "thread" | "history";

const URL_RE = /https?:\/\/[^\s")\]]+/;

/** The inline webview card (spec §14.8 ③) — rendered by the SuperTwin Browser. */
function WebviewCard(props: { url: string }): JSX.Element {
  let host = props.url;
  try {
    host = new URL(props.url).host;
  } catch {
    // keep the raw url
  }
  return (
    <div className="webview-card" data-testid="webview-card">
      <span className="chip">SuperTwin Browser</span>
      <span className="host">{host}</span>
    </div>
  );
}

/**
 * What the worker decided ABOUT an answer, rendered under it (S5.5):
 * the general-answer label, the partial mark with its named gaps, and the
 * coverage caveat. All three are worker verdicts — nothing here re-decides.
 */
function AnswerNotes(props: { answer: BarAnswerView }): JSX.Element | null {
  const a = props.answer;
  const general = a.not_from_your_data === true || a.class === "general";
  const gaps = a.gaps ?? [];
  const caveat = a.coverage_caveat?.text ?? null;
  if (!general && a.partial !== true && gaps.length === 0 && !caveat) return null;
  return (
    <div className="answer-notes" aria-label="answer notes">
      {general && (
        <span className="chip warn" data-testid="not-from-your-data">
          not from your data
        </span>
      )}
      {a.partial === true && (
        <span className="chip warn" data-testid="partial-answer">
          partial answer
        </span>
      )}
      {gaps.length > 0 && (
        <span className="meta gaps" aria-label="gaps">
          missing: {gaps.join(" · ")}
        </span>
      )}
      {caveat && (
        <span className="meta caveat" aria-label="coverage caveat">
          {caveat}
        </span>
      )}
    </div>
  );
}

export function GroundedBar(props: {
  lock: BarLock | null;
  onUnlock: () => void;
  /** Submit a context-locked utterance; resolves to the "what I did" line. */
  onTellTwin: (lock: BarLock, utterance: string) => Promise<string>;
  /** Idle chip (spec §14.7.8): the freshest relevant unseen nudge, if any. */
  nudge?: ArtifactRow | null;
  onOpenNudge?: (artifact: ArtifactRow) => void;
  /** Typing anything dismisses the chip silently (zero-cost negative). */
  onNudgeTyped?: (artifact: ArtifactRow) => void;
  /** A citation chip / search hit → Timeline at that event (spec §14.8.2). */
  onOpenEvent?: (eventId: string) => void;
  /** An action outcome's space / task → the normal modals. */
  onOpenSpace?: (spaceId: string) => void;
  onOpenTask?: (taskId: string) => void;
  /**
   * A quick chip on the object this thread locked to (§21). The chip IS the
   * correction — the shell's one dispatcher applies it and shows the undo.
   */
  onQuickChip?: (target: { kind: TargetKind; id: string }, structured: Record<string, unknown>) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [chipDismissed, setChipDismissed] = useState<string | null>(null);
  const [view, setView] = useState<BarView>("input");
  const [live, setLive] = useState<TypeaheadView | null>(null);
  const [messages, setMessages] = useState<BarMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<BarThreadSummaryView[]>([]);
  const [busy, setBusy] = useState(false);
  // What the THREAD is locked to (the object the bar just made) and the chips
  // that object type offers — both decided worker-side, both ride the response.
  const [threadLock, setThreadLock] = useState<BarLockView | null>(null);
  const [chips, setChips] = useState<BarChipView[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // The idle chip: bar focused but EMPTY, no lock, a fresh nudge exists and
  // typing hasn't silently dismissed it.
  const chip =
    focused && text === "" && !props.lock && props.nudge && chipDismissed !== props.nudge.id
      ? props.nudge
      : null;

  // Entering context-locked state focuses the input (spec §14.8.4).
  useEffect(() => {
    if (props.lock) {
      setReply(null);
      setText("");
      setView("input");
      inputRef.current?.focus();
    }
  }, [props.lock]);

  // ⌘↑ opens history from anywhere (spec §14.8 ⑥).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.metaKey && e.key === "ArrowUp") {
        e.preventDefault();
        void openHistory();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openHistory(): Promise<void> {
    try {
      const { threads: list } = await fetchBarThreads();
      setThreads(list);
      setView("history");
      inputRef.current?.focus();
    } catch {
      // keep the current view
    }
  }

  async function reopenThread(id: string): Promise<void> {
    try {
      const { messages: msgs } = await fetchBarThread(id);
      setThreadId(id);
      setMessages(
        msgs.map((m) => ({
          role: m.role,
          text: m.text,
          citations: Array.isArray(m.meta?.citations)
            ? (m.meta!.citations as BarCitationView[])
            : undefined,
        })),
      );
      // A reopened thread is still locked to whatever it made (USR-06): the
      // worker stored the lock and the chips on the last twin message.
      const last = [...msgs].reverse().find((m) => m.role === "twin" && m.meta);
      setThreadLock((last?.meta?.lock as BarLockView | null | undefined) ?? null);
      setChips(Array.isArray(last?.meta?.chips) ? (last!.meta!.chips as BarChipView[]) : []);
      setView("thread");
      inputRef.current?.focus();
    } catch {
      // stay in history
    }
  }

  // Live results while typing (state ② — T0 type-ahead, S2.7, no model). The
  // hook debounces and sequences (latest wins); the bar only shows what it
  // returns. Locked or in history, the bar is not searching.
  const typeahead = useTypeahead(view === "input" && !props.lock ? text : "");
  useEffect(() => {
    if (typeahead.result) setLive(typeahead.result);
  }, [typeahead.result]);

  function absorb(response: BarResponse, submitted: string): void {
    setThreadId(response.thread_id);
    // The lock and its chips are the thread's, not the turn's: they survive
    // until the worker sends different ones (BAR-09).
    setThreadLock(response.lock ?? null);
    setChips(response.chips ?? []);
    if (response.intent === "search" && response.search) {
      setLive(response.search);
      setView("input");
      return;
    }
    const twin: BarMessage =
      response.intent === "question" && response.answer
        ? { role: "twin", text: response.answer.answer, citations: response.answer.citations, answer: response.answer }
        : response.intent === "action" && response.action
          ? {
              role: "twin",
              text:
                response.action.status === "needs_input"
                  ? response.action.question ?? response.action.summary
                  : response.action.summary,
              action: response.action,
            }
          : { role: "twin", text: response.summary ?? "" };
    setMessages((prev) => [...prev, { role: "user", text: submitted }, twin]);
    setView("thread");
  }

  async function submit(): Promise<void> {
    const utterance = text.trim();
    if (utterance === "" || busy) return;
    if (props.lock) {
      setText("");
      const line = await props.onTellTwin(props.lock, utterance);
      setReply(line);
      return;
    }
    setText("");
    setLive(null);
    setBusy(true);
    try {
      const response = await postBar({
        text: utterance,
        thread_id: view === "thread" && threadId ? threadId : undefined,
      });
      absorb(response, utterance);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "user", text: utterance },
        { role: "twin", text: "couldn't reach the worker" },
      ]);
      setView("thread");
    } finally {
      setBusy(false);
    }
  }

  /** Ask-once (USR-03): the user tapped one of the offered spaces. */
  async function answerOption(action: BarActionView, spaceId: string): Promise<void> {
    if (!action.pending) return;
    setBusy(true);
    try {
      const response = await postBar({
        thread_id: threadId ?? undefined,
        answer: { pending: action.pending, space_id: spaceId },
      });
      if (response.action) {
        setMessages((prev) => [
          ...prev,
          { role: "twin", text: response.action!.summary, action: response.action },
        ]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "twin", text: "couldn't reach the worker" }]);
    } finally {
      setBusy(false);
    }
  }

  /** Esc walks back ONE state (spec §14.8.4). */
  function walkBack(e: React.KeyboardEvent): void {
    if (view === "history") {
      e.stopPropagation();
      setView(messages.length > 0 ? "thread" : "input");
      return;
    }
    if (view === "thread") {
      e.stopPropagation();
      setView("input");
      return;
    }
    if (live || text !== "") {
      e.stopPropagation();
      setLive(null);
      setText("");
      return;
    }
    // Truly collapsed: let the shell handle Esc (modal → lock → hide).
    inputRef.current?.blur();
  }

  const lastAction = [...messages].reverse().find((m) => m.action)?.action;
  const answerUrl = messages
    .filter((m) => m.role === "twin")
    .map((m) => URL_RE.exec(m.text)?.[0])
    .filter((u): u is string => Boolean(u))
    .pop();

  return (
    <div className="bar-wrap">
      <div className="bar" aria-label="grounded bar">
        {chip && (
          <button
            type="button"
            className="chip accent nudge-chip-idle"
            data-testid="bar-nudge-chip"
            onMouseDown={(e) => {
              // Fires before the input loses focus.
              e.preventDefault();
              props.onOpenNudge?.(chip);
            }}
          >
            ◆ {chip.title.toLowerCase()}
          </button>
        )}

        {props.lock && (
          <div className="lock-chip">
            <span className="chip accent">
              ⊙ {props.lock.kind}: {props.lock.label}
            </span>
            <button type="button" className="linklike" onClick={props.onUnlock} aria-label="unlock">
              ✕ unlock
            </button>
          </div>
        )}

        {view === "history" && (
          <div className="bar-history" aria-label="bar history">
            {threads.length === 0 && <p className="empty">no past threads yet</p>}
            {threads.map((t) => (
              <button
                key={t.thread_id}
                type="button"
                className="bar-history-row"
                onClick={() => void reopenThread(t.thread_id)}
              >
                ▸ {t.title} <span className="when">{t.last_ts.slice(0, 10)}</span>
              </button>
            ))}
          </div>
        )}

        {view === "thread" && messages.length > 0 && (
          <div className="bar-thread" aria-label="bar thread">
            {messages.map((m, i) => (
              <div key={i} className={`bar-msg ${m.role}`}>
                <span className="who">{m.role === "user" ? "you:" : "twin:"}</span> {m.text}
                {m.citations && m.citations.length > 0 && (
                  <span className="citations">
                    {m.citations.map((c) => (
                      <button
                        key={c.n}
                        type="button"
                        className="chip citation-chip"
                        aria-label={`citation ${c.n}`}
                        title={c.label}
                        onClick={() => props.onOpenEvent?.(c.id)}
                      >
                        ❝{c.label}❞ →
                      </button>
                    ))}
                  </span>
                )}
                {m.answer && <AnswerNotes answer={m.answer} />}
                {m.action && m.action.progress.length > 0 && (
                  <div className="progress">
                    {m.action.progress.map((line, j) => (
                      <div key={j}>{line}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {threadLock && (
              <div className="bar-thread-lock" aria-label="thread lock">
                <span className="chip accent">
                  ⊙ {threadLock.kind}: {threadLock.label}
                </span>
                <span className="meta">a follow-up here corrects this, it never makes a second one</span>
                {chips.length > 0 && (
                  <span className="bar-chips" aria-label="quick chips">
                    {chips.map((c) => (
                      <button
                        key={c.label}
                        type="button"
                        className="chip"
                        aria-label={`${c.label} on ${threadLock.label}`}
                        onClick={() =>
                          props.onQuickChip?.({ kind: threadLock.kind, id: threadLock.id }, c.structured)
                        }
                      >
                        {c.label}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            )}
            {answerUrl && <WebviewCard url={answerUrl} />}
            {lastAction?.status === "needs_input" && lastAction.options && (
              <div className="bar-options">
                {lastAction.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className="chip"
                    onClick={() => void answerOption(lastAction, o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            {lastAction?.status === "done" && (
              <div className="bar-links">
                {lastAction.space_id && (
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => props.onOpenSpace?.(lastAction.space_id!)}
                  >
                    open space
                  </button>
                )}
                {lastAction.task_id && (
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => props.onOpenTask?.(lastAction.task_id!)}
                  >
                    open task
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {view === "input" && live && (
          <div className="bar-live" aria-label="live results">
            {live.events.slice(0, 4).map((hit) => (
              <button
                key={hit.id}
                type="button"
                className="bar-live-row"
                onClick={() => props.onOpenEvent?.(hit.id)}
              >
                ▸ {hit.chat ?? hit.actor ?? "event"}: {hit.snippet}
              </button>
            ))}
            {live.spaces.map((s) => (
              <button
                key={s.chapter_id ? `${s.id}/${s.chapter_id}` : s.id}
                type="button"
                className="bar-live-row"
                onClick={() => props.onOpenSpace?.(s.id)}
              >
                ▸ {s.label} (space)
              </button>
            ))}
            {(live.episodes ?? []).slice(0, 3).map((ep) => (
              <button
                key={ep.id}
                type="button"
                className="bar-live-row"
                onClick={() => ep.space_id && props.onOpenSpace?.(ep.space_id)}
              >
                ▸ {ep.summary} (episode)
              </button>
            ))}
            {(live.tasks ?? []).slice(0, 3).map((t) => (
              <button
                key={t.id}
                type="button"
                className="bar-live-row"
                onClick={() => props.onOpenTask?.(t.id)}
              >
                ▸ {t.title} (task · {t.status})
              </button>
            ))}
            {(live.people ?? []).slice(0, 3).map((p) => (
              <div key={p.id} className="bar-live-row">
                ▸ {p.name} (person)
              </div>
            ))}
            {(live.claims ?? []).slice(0, 3).map((c) => (
              <div key={c.claim_key} className="bar-live-row">
                ▸ {c.text} (claim)
              </div>
            ))}
            {live.events.length === 0 &&
              live.spaces.length === 0 &&
              !live.episodes?.length &&
              !live.tasks?.length &&
              !live.people?.length &&
              !live.claims?.length && <p className="empty">no matches</p>}
          </div>
        )}

        <div className="bar-input-row">
          <input
            ref={inputRef}
            value={text}
            placeholder={
              props.lock
                ? "tell the twin what's wrong…"
                : view === "thread"
                  ? "follow up…"
                  : "Ask, search, or tell me to do something"
            }
            aria-label="ask"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              // Typing anything dismisses the idle chip silently (§14.7.8).
              if (chip && e.target.value !== "") {
                setChipDismissed(chip.id);
                props.onNudgeTyped?.(chip);
              }
              setText(e.target.value);
              // Clearing the field clears the live box at once; the type-ahead
              // hook fills it again as soon as there is text.
              if (e.target.value.trim() === "") setLive(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                walkBack(e);
                return;
              }
              if (e.key === "Enter") {
                if (chip && text === "") {
                  props.onOpenNudge?.(chip);
                  return;
                }
                void submit();
              }
            }}
          />
          <button
            type="button"
            className="linklike history-btn"
            aria-label="history"
            title="history (⌘↑)"
            onClick={() => void openHistory()}
          >
            ↑
          </button>
        </div>
        {busy && <div className="reply">…</div>}
        {reply && <div className="reply">twin: {reply}</div>}
      </div>
    </div>
  );
}

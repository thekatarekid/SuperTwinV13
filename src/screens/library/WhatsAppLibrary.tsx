// ===========================================================================
// Library › WhatsApp — the chat inbox (spec §14.3.2).
//
// Rebuilt against the v13 event log from the V11 Inbox tab (src/tabs/InboxTab
// .tsx, pruned in 112e014): a connection bar with the range + pause controls,
// a left conversation list with tier/category badges and a last-message
// preview, and a right message pane paged from the event log.
//
// Not connected is a FIRST-CLASS state, not an empty list: unpaired shows the
// real pairing flow (POST /api/sources/whatsapp/pair, QR over the source SSE
// stream); paired-but-unconfirmed shows the windows card (V6 S1.5): MEASURED
// counts per window from GET …/counts (never guesses), the INDEX and UNDERSTAND
// windows, the honest caveats, and one confirm — POST …/confirm stores the card
// text verbatim in `decisions`, grants the consent row, and only then imports.
// Nothing is read between pairing and that confirm.
//
// The confirm is OPTIMISTIC (V6 P1 S6d L3). `importDone` flips only on the
// daemon's `backfill_complete`, which over a real history is minutes away, so
// gating the transition on it left the card sitting there under a button that
// looked dead while the import ran underneath. The import view now goes up on
// the click — before the request is even sent — carries the confirm's own
// in-flight state, and keeps refreshing the chat list while history lands. A
// confirm that fails rolls the view back to the card and says so; a window the
// daemon has already installed skips the card entirely instead of offering a
// second Confirm under a caveat that says one was already confirmed.
//
// STRICTLY READ-ONLY: there is no composer anywhere in this view.
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import {
  LoadFailure,
  PanelSkeleton,
  RefreshingHint,
  SkeletonRows,
  useCachedRead,
} from "../../components/LoadState";
import {
  IMPORT_RANGES,
  RANGE_LABELS,
  confirmSource,
  describeWorkerError,
  extendSource,
  fetchChatMessages,
  fetchLibraryChats,
  fetchSourceCounts,
  fetchSourceStatus,
  pairSource,
  pauseSource,
  pauseStream,
  type ChatStreamRow,
  type ConfirmSourceRequest,
  type ImportRange,
  type InboxMessageRow,
  type SourceCounts,
  type SourceStatus,
} from "../../lib/api";
import { workerUrl } from "../../lib/config";
import { ConnectCard, hhmm, knowsFromLabel, relative } from "./shared";
import { SourcePanelStatus } from "./SourceStatus";

const SOURCE = "whatsapp";
const POLL_MS = 5_000;
/** Defaults (Product_V6_Phase1): INDEX everything, UNDERSTAND the last 30 days. */
const DEFAULT_RANGE: ImportRange = "all";
const DEFAULT_UNDERSTAND: ImportRange = "30d";

const ACCURACY_TEXT = {
  measured: "measured",
  "so-far": "so far — still arriving",
  none: "nothing received yet",
} as const;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** The option label for a window: the measured count rides on the range name. */
function windowLabel(range: ImportRange, counts: SourceCounts | null): string {
  const row = counts?.windows.find((w) => w.range === range);
  if (!row) return RANGE_LABELS[range];
  return `${RANGE_LABELS[range]} · ${fmt(row.messages)} messages in ${fmt(row.chats)} chats`;
}

/**
 * The card's text, exactly as shown — this string is what POST …/confirm stores
 * verbatim in `decisions` (T4-10 / CNS-09), so the record says what the user saw.
 */
function cardText(index: ImportRange, understand: ImportRange | null, counts: SourceCounts | null): string {
  const idx = counts?.windows.find((w) => w.range === index);
  const und = understand ? counts?.windows.find((w) => w.range === understand) : null;
  const lines = [
    `Index ${RANGE_LABELS[index]}: ${idx ? `${fmt(idx.messages)} messages in ${fmt(idx.chats)} chats over ${fmt(idx.days)} days (${ACCURACY_TEXT[idx.accuracy]})` : "count pending"}.`,
    understand
      ? `Understand ${RANGE_LABELS[understand]}: ${und ? `${fmt(und.messages)} messages over ${fmt(und.days)} days (${ACCURACY_TEXT[und.accuracy]})` : "count pending"}.`
      : "Understand: nothing goes to the model.",
    ...(counts?.caveats ?? []),
  ];
  return lines.join("\n");
}

const STATE_TEXT: Record<string, string> = {
  starting: "starting…",
  need_pairing: "waiting for you to scan",
  pairing: "pairing…",
  connected: "connected",
  syncing: "syncing…",
  online: "live",
  reconnecting: "reconnecting…",
  logged_out: "logged out",
  error: "connection error",
};

/** Media-only rows have no text; show what KIND of thing it was instead. */
function preview(row: ChatStreamRow): string {
  const text = row.last_text?.trim();
  if (text) return text;
  switch (row.last_kind) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎥 Video";
    case "audio":
      return "🎙️ Audio";
    case "document":
      return "📄 Document";
    case "sticker":
      return "📷 Sticker";
    case "revoked":
      return "🚫 Deleted";
    default:
      return row.event_count > 0 ? "—" : "no messages yet";
  }
}

function messageBody(m: InboxMessageRow): string {
  if (m.revokedAt) return "🚫 this message was deleted";
  const text = m.text?.trim();
  if (text) return text;
  if (m.transcript) return m.transcript;
  if (m.mediaDescription) return m.mediaDescription;
  return m.kind ? `(${m.kind})` : "—";
}

export function WhatsAppLibrary(props: {
  /** Injected by the tests; production polls the real worker. */
  pollMs?: number;
} = {}): JSX.Element {
  // Both reads are cached per pane (L2): flipping to Screen and back repaints
  // the inbox from the last answer in the same frame, and a slow reply that
  // arrives after a newer one can no longer overwrite it.
  const statusCache = useCachedRead<SourceStatus>("library.whatsapp.status");
  const chatsCache = useCachedRead<ChatStreamRow[]>("library.whatsapp.chats");
  const [status, setStatus] = useState<SourceStatus | null>(statusCache.seed);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [streams, setStreams] = useState<ChatStreamRow[] | null>(chatsCache.seed);
  /** A read is in flight over an answer already on screen — the subtle hint. */
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessageRow[] | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [range, setRange] = useState<ImportRange>(DEFAULT_RANGE);
  const [understand, setUnderstand] = useState<ImportRange | null>(DEFAULT_UNDERSTAND);
  const [counts, setCounts] = useState<SourceCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Confirm has its own two flags, deliberately not the shared `busy`:
  //   confirming — the POST is on the wire (the button's in-flight state)
  //   confirmed  — the user said yes; the import view is up OPTIMISTICALLY,
  //                before the request answers and long before the import ends.
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const pollMs = props.pollMs ?? POLL_MS;
  const alive = useRef(true);
  /** Latches synchronously — a second click cannot outrun React's re-render. */
  const confirmInFlight = useRef(false);
  /** A slow chat read skips its turn instead of queueing another behind it. */
  const streamsInFlight = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    const token = statusCache.begin();
    try {
      const s = await fetchSourceStatus(SOURCE);
      // A newer read for this key has already answered: this reply is history
      // and must not overwrite it, on screen or in the cache.
      if (!statusCache.publish(token, s)) return;
      if (!alive.current) return;
      setStatus(s);
      setStatusError(null);
    } catch (err) {
      if (alive.current && statusCache.accept(token)) setStatusError(describeWorkerError(err));
    }
  }, [statusCache]);

  const loadStreams = useCallback(async () => {
    const token = chatsCache.begin();
    setRefreshing(true);
    try {
      const { streams: rows } = await fetchLibraryChats(SOURCE);
      if (!chatsCache.publish(token, rows)) return;
      if (!alive.current) return;
      setStreams(rows);
      setError(null);
    } catch (err) {
      if (alive.current && chatsCache.accept(token)) setError(describeWorkerError(err));
    } finally {
      if (alive.current && chatsCache.accept(token)) setRefreshing(false);
    }
  }, [chatsCache]);

  /** The Retry both failed reads share — the pane has one worker, not two. */
  const retry = useCallback(() => {
    setRetrying(true);
    void Promise.all([loadStatus(), loadStreams()]).finally(() => {
      if (alive.current) setRetrying(false);
    });
  }, [loadStatus, loadStreams]);

  useEffect(() => {
    void loadStatus();
    void loadStreams();
    const timer = setInterval(() => void loadStatus(), pollMs);
    return () => clearInterval(timer);
  }, [loadStatus, loadStreams, pollMs]);

  // The QR only exists on the source's SSE stream (the status snapshot has no
  // place to keep a code that expires in seconds). EventSource is absent under
  // jsdom, so the pairing card degrades to its written instructions there.
  const paired = status?.paired === true;
  useEffect(() => {
    if (paired || typeof EventSource === "undefined") return;
    const es = new EventSource(workerUrl(`/api/sources/${SOURCE}/stream`));
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const update = JSON.parse(ev.data) as { type?: string; code?: string };
        if (update.type === "qr" && typeof update.code === "string") setQr(update.code);
        if (update.type === "paired") setQr(null);
      } catch {
        // a malformed frame is not worth breaking pairing over
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [paired]);

  // A range the daemon has already installed — or one persisted from an earlier
  // confirm — means the yes ALREADY happened and history is flowing. Printing
  // "A window (all) is already confirmed" as a caveat under a live "Confirm and
  // import" button was the card contradicting itself; the honest state for that
  // is the import view, not a second chance to choose.
  const windowAlreadyChosen =
    status?.importRange != null || counts?.counts.rangeInstalled === true;

  // Paired but not yet confirmed: ask the daemon what each window would import
  // (measured over the history it is holding) and keep asking while WhatsApp is
  // still sending — the bootstrap lands first, the bulk follows within minutes.
  // Once the user has said yes the card is gone, so the polling stops with it:
  // /counts is a daemon round-trip and the import needs the worker more.
  const awaitingConfirm =
    paired && status?.importDone !== true && !confirmed && !windowAlreadyChosen;

  // Everything still landing, in ONE line inside this panel. `importDone` only
  // flips on the daemon's `backfill_complete`, which for a real history is
  // minutes away — so this is what the user watches after they confirm, and it
  // must be true from the click, not from the first progress frame.
  const progress = status?.progress;
  const importing =
    confirming ||
    (paired && status?.importDone !== true) ||
    (progress != null && progress.done !== true);

  // The import view has to keep FILLING as events land: a chat list frozen at
  // whatever existed when the panel mounted is the same "nothing is happening"
  // the card was. Polled only while the import runs, at half the status
  // cadence, and never stacked.
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => {
      if (streamsInFlight.current) return;
      streamsInFlight.current = true;
      void loadStreams().finally(() => {
        streamsInFlight.current = false;
      });
    }, pollMs * 2);
    return () => clearInterval(timer);
  }, [importing, loadStreams, pollMs]);

  /**
   * The yes. The next screen goes up FIRST — before the request is sent, let
   * alone answered — because the import behind it runs for minutes and a card
   * that sits there while it does reads as a dead button. The request is still
   * awaited: if it fails, the optimistic view is rolled back and the card says
   * why, so the transition never claims an import that did not start.
   */
  const confirmNow = useCallback(
    (req: ConfirmSourceRequest) => {
      if (confirmInFlight.current) return; // impossible to double-fire
      confirmInFlight.current = true;
      setConfirming(true);
      setConfirmError(null);
      setConfirmed(true);
      void (async () => {
        try {
          await confirmSource(SOURCE, req);
          if (alive.current) {
            void loadStatus();
            void loadStreams();
          }
        } catch (err) {
          // The yes never landed: nothing is importing, so say so and go back.
          if (alive.current) {
            setConfirmed(false);
            setConfirmError(describeWorkerError(err));
          }
        } finally {
          confirmInFlight.current = false;
          if (alive.current) setConfirming(false);
        }
      })();
    },
    [loadStatus, loadStreams],
  );

  useEffect(() => {
    if (!awaitingConfirm) return;
    let stop = false;
    const load = async () => {
      try {
        const c = await fetchSourceCounts(SOURCE);
        if (!stop && alive.current) setCounts(c);
      } catch {
        // the daemon is not answering yet (still connecting) — the card says so
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [awaitingConfirm, pollMs]);

  const openChat = useCallback(async (id: string) => {
    setSelected(id);
    setMessages(null);
    setMessagesError(null);
    try {
      const rows = await fetchChatMessages(id);
      if (alive.current) setMessages(rows);
    } catch (err) {
      // An empty array here read as "no messages in this chat", which is a
      // different claim from "we could not ask" (W3).
      if (alive.current) {
        setMessages([]);
        setMessagesError(describeWorkerError(err));
      }
    }
  }, []);

  async function run(fn: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await loadStatus();
      await loadStreams();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const selectedRow = useMemo(
    () => streams?.find((s) => s.id === selected) ?? null,
    [streams, selected],
  );

  // ---- Unknown is not empty ------------------------------------------------
  // Until the status read answers, this pane does not know whether the account
  // is paired, mid-import or live — so it paints none of those. It used to fall
  // through to the inbox shell (or, for an unpaired account, show the inbox and
  // then flip to the pairing card seconds later); the status read measured 3 s
  // on the user's machine, all of it spent on a screen that was not true.
  if (status === null && statusError === null) {
    return <PanelSkeleton what="WhatsApp" rows={5} />;
  }

  // ---- Not connected: the real pairing flow --------------------------------

  if (statusError !== null && !status) {
    return (
      <ConnectCard
        glyph="◙"
        title="WhatsApp"
        body="The worker isn't answering, so SuperTwin can't tell whether WhatsApp is linked. Start the worker and this page connects on its own."
        actions={[{ label: retrying ? "retrying…" : "Retry", onClick: retry, disabled: retrying }]}
        note={statusError}
      />
    );
  }

  if (status && !status.paired) {
    return (
      <ConnectCard
        glyph="◙"
        title="Connect WhatsApp"
        body="Link WhatsApp and the twin starts reading your conversations — the chats, the tiers, and how far back it knows you. Nothing is ever sent on your behalf without an approval."
        actions={[
          {
            label: status.state === "need_pairing" ? "Show a new code" : "Pair WhatsApp",
            onClick: () => void run(() => pairSource(SOURCE), "pairing failed"),
            disabled: busy,
          },
        ]}
        note={
          <>
            On your phone: WhatsApp › Settings › <strong>Linked devices</strong> › Link a device,
            then scan the code. Status: {STATE_TEXT[status.state] ?? status.state}
            {status.lastError ? ` — ${status.lastError.code}: ${status.lastError.message}` : ""}
          </>
        }
      >
        {qr && (
          <div className="connect-qr" aria-label="pairing code">
            <QRCodeSVG value={qr} size={180} />
          </div>
        )}
      </ConnectCard>
    );
  }

  if (status && awaitingConfirm) {
    // Understand can never exceed Index (CNS-03): the options stop at the index.
    const understandOptions = IMPORT_RANGES.filter(
      (r) => IMPORT_RANGES.indexOf(r) <= IMPORT_RANGES.indexOf(range),
    );
    const effectiveUnderstand =
      understand && understandOptions.includes(understand) ? understand : understand === null ? null : range;
    const text = cardText(range, effectiveUnderstand, counts);
    const totalRow = counts?.windows.find((w) => w.range === "all");
    return (
      <ConnectCard
        glyph="◙"
        title="Choose how far back"
        body={
          counts && totalRow && totalRow.accuracy !== "none"
            ? `WhatsApp is linked and has sent ${fmt(counts.counts.messages)} messages in ${fmt(counts.counts.chats)} chats so far. Nothing is read until you confirm. Pick what the twin keeps (Index) and what it reads closely (Understand).`
            : "WhatsApp is linked. Counting what it has sent — nothing is read until you confirm. Pick what the twin keeps (Index) and what it reads closely (Understand)."
        }
        actions={[
          {
            label: confirming ? "confirming…" : "Confirm and import",
            onClick: () =>
              confirmNow({
                index: range,
                understand: effectiveUnderstand,
                card_text: text,
                ...(counts ? { counts: counts.counts } : {}),
              }),
            disabled: confirming,
          },
        ]}
        note={
          <>
            Linked as {status.pushName ?? "this account"} ·{" "}
            {STATE_TEXT[status.state] ?? status.state}
            {confirmError && (
              <>
                <br />
                <strong>Nothing was imported — the confirm did not land:</strong> {confirmError}
              </>
            )}
          </>
        }
      >
        <label className="connect-field">
          <span>index (kept, searchable)</span>
          <select
            aria-label="import range"
            value={range}
            onChange={(e) => setRange(e.target.value as ImportRange)}
          >
            {IMPORT_RANGES.map((r) => (
              <option key={r} value={r}>
                {windowLabel(r, counts)}
              </option>
            ))}
          </select>
        </label>
        <label className="connect-field">
          <span>understand (read by the model)</span>
          <select
            aria-label="understand range"
            value={effectiveUnderstand ?? "none"}
            onChange={(e) => setUnderstand(e.target.value === "none" ? null : (e.target.value as ImportRange))}
          >
            {understandOptions.map((r) => (
              <option key={r} value={r}>
                {windowLabel(r, counts)}
              </option>
            ))}
            <option value="none">nothing goes to the model</option>
          </select>
        </label>
        <ul className="connect-caveats" aria-label="counts caveats">
          {(counts?.caveats ?? ["Counting what WhatsApp has sent…"]).map((line) => (
            <li key={line} className="meta">
              {line}
            </li>
          ))}
        </ul>
      </ConnectCard>
    );
  }

  // ---- Connected (or importing): the chat inbox ----------------------------

  return (
    <section className="card inbox" aria-label="WhatsApp">
      <header className="inbox-bar">
        <span className={`chip${status?.state === "online" ? " accent" : ""}`}>
          {status ? (STATE_TEXT[status.state] ?? status.state) : "…"}
        </span>
        {status?.pushName && <span className="meta">{status.pushName}</span>}
        {status?.importRange && (
          <span className="meta">history: {RANGE_LABELS[status.importRange as ImportRange] ?? status.importRange}</span>
        )}
        <RefreshingHint active={refreshing && streams !== null} what="chats" />
        <span className="inbox-bar-spacer" />
        <label className="connect-field">
          <span className="visually-hidden">extend history</span>
          <select
            aria-label="extend history"
            value={range}
            onChange={(e) => {
              const next = e.target.value as ImportRange;
              setRange(next);
              void run(() => extendSource(SOURCE, next), "extend failed");
            }}
          >
            {IMPORT_RANGES.map((r) => (
              <option key={r} value={r}>
                extend to {RANGE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          aria-label={status?.paused ? "resume WhatsApp capture" : "pause WhatsApp capture"}
          onClick={() => void run(() => pauseSource(SOURCE, !status?.paused), "pause failed")}
        >
          {status?.paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      </header>

      {/* L6: WhatsApp's OWN status, inside WhatsApp's own panel — its consent
          window, its own coverage range, its own backlog. Never the top-right
          chip's cross-source sum. */}
      <SourcePanelStatus
        source={SOURCE}
        title="WhatsApp"
        connection={
          status
            ? status.paused
              ? "capture paused"
              : (STATE_TEXT[status.state] ?? status.state)
            : null
        }
      />

      {importing && (
        // This source's own state, inside this source's own panel. It has to
        // say something true from the instant the user confirms — the daemon's
        // first progress frame is not the start of the import, it is minutes in.
        <p className="empty" role="status" aria-label="whatsapp import status">
          {confirming
            ? "confirming your window — the import starts the moment it lands"
            : progress
              ? `importing… ${progress.chatsDone ?? 0}${progress.chatsTotal ? `/${progress.chatsTotal}` : ""} chats · ${progress.messages ?? 0} messages — runs in the background`
              : `importing your history — ${
                  streams === null
                    ? "reading what has landed so far…"
                    : streams.length === 0
                      ? "nothing has landed yet"
                      : `${fmt(streams.length)} chat${streams.length === 1 ? "" : "s"} so far`
                }`}
        </p>
      )}
      {error && <LoadFailure what="your chats" error={error} onRetry={retry} retrying={retrying} />}

      <div className="inbox-panes">
        <div className="inbox-list" role="list" aria-label="conversations">
          {streams === null ? (
            // A failed read paints the LoadFailure above; the pending line
            // must not sit under it pretending the request is still running.
            // With no answer yet the list shows its own shape, never "no chats".
            error === null ? (
              <SkeletonRows rows={6} />
            ) : null
          ) : streams.length === 0 ? (
            <p className="empty">
              {importing
                ? "your chats appear here as they land"
                : "linked, but no chats have arrived yet"}
            </p>
          ) : (
            streams.map((s) => {
              const name = s.label ?? s.external_key;
              return (
                <div
                  key={s.id}
                  className={`row chat-row${selected === s.id ? " active" : ""}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="chat-open"
                    aria-label={`open chat ${name}`}
                    aria-current={selected === s.id ? "true" : undefined}
                    onClick={() => void openChat(s.id)}
                  >
                    <span className="chat-top">
                      <span className="glyph">{s.stream_kind === "group" ? "⬡" : "◙"}</span>
                      <span className="chat-name">{name}</span>
                      {s.tier && <span className="chip">{s.tier}</span>}
                      {s.category && (
                        <span className="chip">{s.category === "cat1" ? "Cat-1" : "Cat-2"}</span>
                      )}
                      <span className="meta">
                        {s.today_count > 0 ? `${s.today_count} today` : relative(s.last_ts)}
                      </span>
                    </span>
                    <span className="chat-preview">{preview(s)}</span>
                    <span className="chat-knows meta">
                      {s.category === "cat2" && s.knows_from == null
                        ? "never replied (reply promotes)"
                        : knowsFromLabel(s.knows_from)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="linklike"
                    aria-label={`${s.capture_paused === 1 ? "resume" : "pause"} ${name}`}
                    title={s.capture_paused === 1 ? "resume capture" : "pause capture"}
                    onClick={() =>
                      void run(
                        () => pauseStream(s.id, s.capture_paused !== 1),
                        "pause failed",
                      )
                    }
                  >
                    {s.capture_paused === 1 ? "▶" : "⏸"}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="inbox-thread" aria-label="messages">
          {!selectedRow ? (
            <p className="empty">pick a conversation to read it</p>
          ) : (
            <>
              <header className="thread-head">
                <span className="chat-name">{selectedRow.label ?? selectedRow.external_key}</span>
                {selectedRow.tier && <span className="chip">{selectedRow.tier}</span>}
                <span className="meta">{selectedRow.event_count} messages</span>
              </header>
              {messagesError !== null ? (
                <LoadFailure
                  what="this conversation"
                  error={messagesError}
                  onRetry={() => void openChat(selectedRow.id)}
                  retrying={messages === null}
                />
              ) : messages === null ? (
                <p className="empty">loading messages…</p>
              ) : messages.length === 0 ? (
                <p className="empty">no messages in this chat</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`bubble${m.fromMe ? " mine" : ""}`}>
                    <span className="bubble-who meta">
                      {m.fromMe ? "you" : (m.actorName ?? "them")}
                      {m.ts ? ` · ${hhmm(m.ts)}` : ""}
                    </span>
                    <span className="bubble-text">{messageBody(m)}</span>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

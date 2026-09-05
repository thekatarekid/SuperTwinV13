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
// STRICTLY READ-ONLY: there is no composer anywhere in this view.
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import {
  IMPORT_RANGES,
  RANGE_LABELS,
  confirmSource,
  extendSource,
  fetchChatMessages,
  fetchLibraryChats,
  fetchSourceCounts,
  fetchSourceStatus,
  pairSource,
  pauseSource,
  pauseStream,
  type ChatStreamRow,
  type ImportRange,
  type InboxMessageRow,
  type SourceCounts,
  type SourceStatus,
} from "../../lib/api";
import { workerUrl } from "../../lib/config";
import { ConnectCard, hhmm, knowsFromLabel, relative } from "./shared";

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
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [streams, setStreams] = useState<ChatStreamRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessageRow[] | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [range, setRange] = useState<ImportRange>(DEFAULT_RANGE);
  const [understand, setUnderstand] = useState<ImportRange | null>(DEFAULT_UNDERSTAND);
  const [counts, setCounts] = useState<SourceCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollMs = props.pollMs ?? POLL_MS;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchSourceStatus(SOURCE);
      if (!alive.current) return;
      setStatus(s);
      setStatusError(false);
    } catch {
      if (alive.current) setStatusError(true);
    }
  }, []);

  const loadStreams = useCallback(async () => {
    try {
      const { streams: rows } = await fetchLibraryChats(SOURCE);
      if (!alive.current) return;
      setStreams(rows);
      setError(null);
    } catch {
      if (alive.current) setError("worker unreachable");
    }
  }, []);

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

  // Paired but not yet confirmed: ask the daemon what each window would import
  // (measured over the history it is holding) and keep asking while WhatsApp is
  // still sending — the bootstrap lands first, the bulk follows within minutes.
  const awaitingConfirm = paired && status?.importDone !== true;
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
    try {
      const rows = await fetchChatMessages(id);
      if (alive.current) setMessages(rows);
    } catch {
      if (alive.current) setMessages([]);
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

  // ---- Not connected: the real pairing flow --------------------------------

  if (statusError && !status) {
    return (
      <ConnectCard
        glyph="◙"
        title="WhatsApp"
        body="The worker isn't answering, so SuperTwin can't tell whether WhatsApp is linked. Start the worker and this page connects on its own."
        note="worker unreachable"
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

  if (status && status.paired && !status.importDone) {
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
            label: "Confirm and import",
            onClick: () =>
              void run(
                () =>
                  confirmSource(SOURCE, {
                    index: range,
                    understand: effectiveUnderstand,
                    card_text: text,
                    ...(counts ? { counts: counts.counts } : {}),
                  }),
                "confirm failed",
              ),
            disabled: busy,
          },
        ]}
        note={`Linked as ${status.pushName ?? "this account"} · ${STATE_TEXT[status.state] ?? status.state}`}
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

  // ---- Connected: the chat inbox -------------------------------------------

  const importing = status?.progress != null && status.progress.done !== true;

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

      {importing && (
        <p className="empty" role="status">
          importing… {status?.progress?.chatsDone ?? 0}
          {status?.progress?.chatsTotal ? `/${status.progress.chatsTotal}` : ""} chats ·{" "}
          {status?.progress?.messages ?? 0} messages — runs in the background
        </p>
      )}
      {error && <p className="empty">{error}</p>}

      <div className="inbox-panes">
        <div className="inbox-list" role="list" aria-label="conversations">
          {streams === null ? (
            <p className="empty">loading chats…</p>
          ) : streams.length === 0 ? (
            <p className="empty">linked, but no chats have arrived yet</p>
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
              {messages === null ? (
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

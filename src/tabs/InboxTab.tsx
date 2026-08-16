// Read-only WhatsApp Inbox + onboarding (docs/PHASE1_CONTRACT §6).
//
// When not yet paired-and-imported this renders the onboarding flow
// (QR → range picker → backfill progress). Once done it renders the Inbox:
//   - a connection status bar (state pill + kill-switch + "Extend history"),
//   - a left chat list (from getInboxChats), sorted by lastTs desc,
//   - a right message pane (from getChannelMessages) with media + fromMe
//     alignment, and
//   - an FTS search box (searchInbox) whose hits jump to a chat.
//
// STRICTLY READ-ONLY: there is no composer, no send button, anywhere.
//
// State that survives across the app lives in useWhatsapp; the Inbox's own
// list/message/search state is local here. The `client` prop is injectable so
// tests can supply a mock worker client (same pattern as ChatTab).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useWhatsapp } from "../lib/useWhatsapp";
import { ExtendResultNotice, ShallowHistoryNotice } from "./HistoryDepthNotice";
import { WhatsappOnboarding } from "./WhatsappOnboarding";
import {
  RANGES,
  RANGE_LABELS,
  displayName,
  workerClient as defaultClient,
  type InboxChat,
  type InboxMessage,
  type MessageFrame,
  type MessageLink,
  type Progress,
  type Range,
  type Reaction,
  type SearchHit,
  type SourceState,
  type WorkerClient,
} from "../lib/worker-client";

/** How often to fall back to polling the chat list if the SSE stream drops. */
const INBOX_POLL_MS = 15000;

/**
 * R7.1: chat-detail page size. Opening a chat loads the newest `PAGE_SIZE`
 * messages (no cursor); scrolling to the top loads the next older page. When a
 * batch comes back shorter than this, there's nothing older left (`hasMore`
 * flips false). Kept in the 50–100 band the contract recommends.
 */
const PAGE_SIZE = 60;

/**
 * R7.1: how close (px) to an edge counts as "at" it. Used both to decide when a
 * scroll-up should fetch the next older page and to decide whether a live nudge
 * may auto-stick the viewport to the bottom (only when the user was already
 * reading the newest messages — never yank them down mid-scrollback).
 */
const EDGE_THRESHOLD_PX = 80;

/**
 * R7.1 cursor: the opaque `before` value is `"<ts>|<id>"` built from the OLDEST
 * currently-loaded message (the first element of the ascending array). The
 * worker splits on the first `|`; ISO timestamps carry no `|`, and the row id
 * uses `/` as its separator, so this is unambiguous.
 */
function beforeCursor(oldest: InboxMessage): string {
  return `${oldest.ts ?? ""}|${oldest.id}`;
}

/** Milliseconds for ordering. An undated row sorts last, where a new one lands. */
function tsOrder(m: InboxMessage): number {
  const t = Date.parse(m.ts ?? "");
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

/**
 * Whether a re-fetched row says anything the loaded copy did not. Compared by
 * serialisation rather than by a list of fields, because everything about a row
 * can change — an edit, a revoke and a new reaction all arrive as a rewrite of
 * a row already loaded — and a hand-written list would silently stop covering a
 * field added after it. Both sides are parsed from the same endpoint, so key
 * order matches; were it ever to differ the answer is "changed", which costs a
 * render and nothing else.
 */
function sameRow(a: InboxMessage, b: InboxMessage): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Fold a freshly-fetched NEWEST window into the window the reader is actually
 * looking at. The quiet refresh only ever asks for the newest PAGE_SIZE
 * messages, so adopting its answer wholesale threw away every older page that
 * had been paged in — the list snapped back to 60 rows under a reader who had
 * scrolled through 180 of them (v7 §5.1).
 *
 * A row already loaded is REPLACED in place, because that is how an edit, a
 * revoke or a new reaction arrives. Anything genuinely new is added and the
 * result ordered by timestamp: history sync can insert into the middle of a
 * window, so arrival order is not position.
 */
function mergeWindow(
  current: InboxMessage[],
  fresh: readonly InboxMessage[],
): InboxMessage[] {
  if (current.length === 0) return [...fresh];
  const merged = new Map(current.map((m) => [m.id, m]));
  const added: InboxMessage[] = [];
  let rewritten = false;
  for (const row of fresh) {
    const loaded = merged.get(row.id);
    if (loaded === undefined) {
      added.push(row);
    } else if (!sameRow(loaded, row)) {
      merged.set(row.id, row);
      rewritten = true;
    }
  }
  // A refresh that found no news hands back the very array that is rendered, so
  // the thread is not rebuilt and — more to the point — the effect that
  // positions it does not run. A reader sitting a few pixels above the newest
  // message counts as near the bottom, and every 15s tick was pulling them the
  // rest of the way down to say nothing (§5.2).
  if (added.length === 0 && !rewritten) return current;
  if (added.length === 0) return [...merged.values()];
  // Sort is stable, so rows sharing a timestamp keep the order they came in.
  return [...merged.values(), ...added].sort((a, b) => tsOrder(a) - tsOrder(b));
}

/** True when the viewport is at (or within a thumb's width of) the newest end. */
function isNearBottom(el: HTMLElement | null): boolean {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= EDGE_THRESHOLD_PX;
}

interface InboxTabProps {
  /** Injected worker client (tests). Defaults to the real localhost client. */
  client?: WorkerClient;
}

const STATE_PILL: Record<SourceState, { label: string; variant: string }> = {
  starting: { label: "Starting", variant: "busy" },
  need_pairing: { label: "Needs pairing", variant: "warn" },
  pairing: { label: "Pairing", variant: "busy" },
  connected: { label: "Connected", variant: "online" },
  syncing: { label: "Syncing", variant: "busy" },
  online: { label: "Online", variant: "online" },
  reconnecting: { label: "Reconnecting", variant: "busy" },
  logged_out: { label: "Logged out", variant: "warn" },
  error: { label: "Error", variant: "error" },
};

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFullTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function kindIcon(kind: string | null): string {
  return kind === "group" ? "👥" : "👤";
}

/**
 * Preview text for a chat row's last message. Per R6.5 the worker now returns a
 * non-empty `lastText` for any chat that has messages (a media/kind label like
 * "🎥 Video" when the latest message carries no text), so we render it as-is.
 * The "No messages" placeholder is driven by `messageCount === 0`, not by an
 * empty preview (see the row rendering).
 */
function chatPreview(c: InboxChat): string {
  return c.lastText ?? "";
}

export function InboxTab({ client = defaultClient }: InboxTabProps = {}) {
  const wa = useWhatsapp(client);
  // R3.3: track a just-triggered relink so the brief unlink→QR transition shows
  // a friendly "Re-linking…" message instead of an empty Inbox or a scary error.
  const [relinking, setRelinking] = useState(false);

  const showOnboarding = !wa.paired || wa.step !== "done";

  // The relink transition is over once a fresh QR actually renders (the daemon
  // has restarted into pairing and emitted a new code) — from there the normal
  // "Link WhatsApp" copy takes over. We must NOT clear on `paired`/`step==="done"`:
  // right after the confirm click `relink()` hasn't resolved yet, so we're
  // momentarily still paired/done, and clearing there would drop the friendly
  // message before the unlink even happens. Once re-pairing + import finish the
  // onboarding unmounts entirely, so a lingering flag is harmless.
  useEffect(() => {
    if (relinking && wa.qr) setRelinking(false);
  }, [relinking, wa.qr]);

  return (
    <section className="inbox" aria-label="Inbox">
      {showOnboarding ? (
        <WhatsappOnboarding
          step={wa.step}
          state={wa.state}
          qr={wa.qr}
          lastError={wa.lastError}
          relinking={relinking}
          onPair={() => void wa.pair()}
          onImport={(r) => void wa.startImport(r)}
        />
      ) : (
        <InboxView wa={wa} client={client} onRelinkStart={() => setRelinking(true)} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The Inbox proper (paired + imported).
// ---------------------------------------------------------------------------

interface InboxViewProps {
  wa: ReturnType<typeof useWhatsapp>;
  client: WorkerClient;
  /** R3.3: called the moment a relink succeeds, so the parent shows the
   * "Re-linking… scan the QR" transition instead of an empty Inbox. */
  onRelinkStart(): void;
}

function InboxView({ wa, client, onRelinkStart }: InboxViewProps) {
  const [chats, setChats] = useState<InboxChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [jumpToEventId, setJumpToEventId] = useState<string | null>(null);

  // R7.1 scroll-up pagination state.
  // - hasMore: whether an older page might still exist (a full batch came back).
  // - loadingOlder: an older-page fetch is in flight (guards duplicate loads on
  //   rapid scroll and against the initial-load spinner).
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Ref mirror of loadingOlder so the scroll handler (attached once) reads the
  // live value without being re-bound on every fetch.
  const loadingOlderRef = useRef(false);
  // After we PREPEND an older page, the layout effect below puts the viewport
  // back where it was. What it restores is the distance from the BOTTOM: that
  // is the part of the document a prepend does not move, so it is right however
  // much taller the content turned out to be.
  const prependAnchorRef = useRef<number | null>(null);
  // Whether the *next* messages render should stick to the bottom (newest).
  // True on a fresh chat open / initial load; false when we prepend older rows.
  const stickBottomRef = useRef(true);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [showExtend, setShowExtend] = useState(false);
  const [showResync, setShowResync] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  // The extend-result strip is dismissible per outcome, keyed by its start time
  // so the NEXT run's result shows even after this one was dismissed.
  const [dismissedExtend, setDismissedExtend] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const threadRef = useRef<HTMLDivElement | null>(null);
  // The loaded window, mirrored so the scroll + nudge callbacks can read it
  // without depending on `messages` (which would rebuild them every render).
  // Every setMessages goes through writeMessages, so this is never a render
  // behind — reading state back through a setMessages updater is what made
  // paging silently no-op whenever an update was already queued (v7 §5.5).
  const messagesRef = useRef<InboxMessage[]>([]);
  const writeMessages = useCallback((next: InboxMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);
  // Which chat the rows in `messagesRef` are, as a fresh identity every time the
  // window is replaced wholesale. Everything that folds into a loaded window
  // rather than replacing it — the quiet refresh, the older page — asks this
  // whether it is still the window it asked about. Switching chats leaves the
  // previous chat's rows loaded until the new ones arrive, and a merge landing
  // in that gap builds one list out of two conversations; today the loading
  // line is over it so nobody sees that, which is not a reason to build it.
  const windowRef = useRef<{ channel: string } | null>(null);
  /** Replace the loaded window: new rows, and a new identity for them. */
  const openWindow = useCallback(
    (channel: string | null, rows: InboxMessage[]) => {
      windowRef.current = channel === null ? null : { channel };
      writeMessages(rows);
    },
    [writeMessages],
  );
  // Keep the latest selectedId in a ref so the ingest-nudge + fallback-poll +
  // scroll-up callbacks can read the open chat without re-subscribing on every
  // switch. Declared up here because loadOlder (below) reads it.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `quiet` refreshes (ingest nudges / fallback polls) must NOT flash the
  // loading spinner or blow away the list on a transient error — they refresh
  // in place so the left list stays live (bugs 2 & 3).
  const loadChats = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setChatsLoading(true);
        setChatsError(null);
      }
      try {
        const rows = await client.getInboxChats({ limit: 200 });
        if (!mountedRef.current) return;
        // Defensive sort by lastTs desc (server already sorts, but be safe).
        const sorted = [...rows].sort(
          (a, b) => (Date.parse(b.lastTs ?? "") || 0) - (Date.parse(a.lastTs ?? "") || 0),
        );
        setChats(sorted);
        setChatsError(null);
        setSelectedId((prev) => prev ?? (sorted.length > 0 ? sorted[0].id : null));
      } catch (err) {
        if (mountedRef.current && !quiet) {
          setChats([]);
          setChatsError(
            err instanceof Error ? err.message : "Failed to load chats.",
          );
        }
      } finally {
        if (mountedRef.current && !quiet) setChatsLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  // R7.1: load the LATEST window for a chat (newest `PAGE_SIZE`, no cursor).
  // Used on open and on live-ingest nudges. The worker returns the newest page
  // ascending; we render newest-at-bottom and scroll there.
  //
  // `quiet` (nudges/polls) MERGES into whatever is loaded rather than replacing
  // it, and leaves `hasMore` alone: the window is the reader's, built by their
  // scrolling, and a refresh has nothing to say about how far back it goes. It
  // must not flash the spinner or clobber the list on a transient error either.
  const loadMessages = useCallback(
    async (channelId: string, quiet = false) => {
      if (!quiet) {
        setMessagesLoading(true);
        setMessagesError(null);
      }
      try {
        const rows = await client.getChannelMessages(channelId, {
          limit: PAGE_SIZE,
        });
        if (!mountedRef.current) return;
        // The answer to a chat the reader has since left is not theirs to apply.
        if (selectedIdRef.current !== channelId) return;
        // A merge is only ever into this chat's own window. In the gap between
        // opening a chat and its rows arriving, the rows on screen are still the
        // previous chat's — folding into those is how two conversations end up
        // in one thread.
        if (quiet && windowRef.current?.channel !== channelId) return;
        // Whether to stick to the newest end is decided from where the viewport
        // is NOW, not from where it was when the request went out: a scroll that
        // begins mid-flight must not be yanked back by the answer to it (§5.2).
        stickBottomRef.current = quiet ? isNearBottom(threadRef.current) : true;
        if (quiet) {
          writeMessages(mergeWindow(messagesRef.current, rows));
          setMessagesError(null);
        } else {
          // A full page back means older history may still exist upward.
          setHasMore(rows.length === PAGE_SIZE);
          openWindow(channelId, rows);
        }
      } catch (err) {
        if (mountedRef.current && !quiet && selectedIdRef.current === channelId) {
          // The window stays this chat's, empty: a later nudge then merges into
          // it and the thread recovers on its own from a transient failure.
          openWindow(channelId, []);
          setHasMore(false);
          setMessagesError(
            err instanceof Error ? err.message : "Failed to load messages.",
          );
        }
      } finally {
        // The spinner belongs to the chat that is open, so a load the reader
        // walked away from does not clear it — the chat they walked TO is still
        // fetching, and its own load is what says it has arrived.
        if (mountedRef.current && !quiet && selectedIdRef.current === channelId) {
          setMessagesLoading(false);
        }
      }
    },
    [client, openWindow, writeMessages],
  );

  // R7.1: scroll-UP pagination. Fetch the page immediately OLDER than the oldest
  // currently-loaded message (cursor = "<oldest.ts>|<oldest.id>"), PREPEND it,
  // and preserve scroll position (the layout effect adjusts scrollTop from the
  // height delta so the viewport doesn't jump). Guards against concurrent/
  // duplicate loads and stops once a short batch (or empty) comes back.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const channelId = selectedIdRef.current;
    if (!channelId) return;
    // The window this page will continue, taken now so the answer can be held
    // against it. The cursor below is the oldest row of that window, so there is
    // nothing to ask for while it belongs to some other chat.
    const loaded = windowRef.current;
    if (loaded === null || loaded.channel !== channelId) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    // The next render is a prepend, not a fresh open → do NOT stick to bottom.
    stickBottomRef.current = false;

    try {
      const older = await client.getChannelMessages(channelId, {
        before: beforeCursor(oldest),
        limit: PAGE_SIZE,
      });
      if (!mountedRef.current) return;
      // A window replaced while the page was in the air is not the one this
      // continues: prepending onto a chat reopened since leaves the stretch
      // between the two windows missing, and prepending onto a different chat
      // needs no explaining.
      if (windowRef.current !== loaded) return;
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      // De-dupe defensively at the seam (a same-ts boundary or an overlapping
      // live insert) so a message can't appear twice after prepend.
      const seen = new Set(messagesRef.current.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      setHasMore(older.length === PAGE_SIZE);
      if (fresh.length === 0) return;
      // Measured HERE and not when the request went out (§5.4). In between,
      // the "Loading older messages…" line rendered above the thread and an
      // image somewhere in it may have finished decoding — both change the
      // height the restore is measured against, and the first of them is
      // undone again by the very commit this anchors.
      const el = threadRef.current;
      prependAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
      writeMessages([...fresh, ...messagesRef.current]);
    } catch {
      // Older-page fetch failed: don't disturb the existing view. Leave hasMore
      // as-is so a later scroll can retry.
    } finally {
      loadingOlderRef.current = false;
      if (mountedRef.current) setLoadingOlder(false);
    }
  }, [client, writeMessages]);

  // Opening (or switching) a chat: reset paging + load the latest window and
  // stick to the bottom on the resulting render.
  useEffect(() => {
    if (selectedId) {
      setHasMore(false);
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      prependAnchorRef.current = null;
      stickBottomRef.current = true;
      void loadMessages(selectedId);
    } else {
      openWindow(null, []);
      setHasMore(false);
    }
  }, [selectedId, loadMessages, openWindow]);

  // R7.1: fire older-page loads when the user scrolls to (near) the TOP. The
  // in-flight guard lives in loadOlder; hasMore short-circuits once history is
  // exhausted so we stop hitting the worker.
  const onThreadScroll = useCallback(() => {
    if (!hasMore) return;
    if (loadingOlderRef.current) return;
    const el = threadRef.current;
    if (!el) return;
    if (el.scrollTop <= EDGE_THRESHOLD_PX) void loadOlder();
  }, [hasMore, loadOlder]);

  // A single quiet refresh of the list + (if open) the current chat's messages.
  //
  // R7.1: a live nudge for the OPEN chat folds the LATEST window into what is
  // loaded so a just-sent/received message appears at the bottom, without
  // touching the pages the reader scrolled back through. Whether the viewport
  // follows it down is decided inside loadMessages, once the rows are in hand.
  // We still skip the reload entirely while an older-page fetch is in flight, so
  // a nudge cannot race a prepend.
  const refreshLive = useCallback(() => {
    void loadChats(true);
    const open = selectedIdRef.current;
    if (!open) return;
    if (loadingOlderRef.current) return;
    void loadMessages(open, true);
  }, [loadChats, loadMessages]);

  // R2.2 (bugs 2 & 3): on every live-ingest nudge from the SSE stream, refetch
  // the chat list AND the open chat so incoming + self-sent messages appear
  // within ~1s and the left list stops showing stale last-message state.
  const onIngest = wa.onIngest;
  useEffect(() => {
    const unsub = onIngest(() => {
      refreshLive();
    });
    return unsub;
  }, [onIngest, refreshLive]);

  // Fallback poll (R2.2): if the SSE stream drops, still refresh at least every
  // INBOX_POLL_MS. Cheap (quiet, in-place) and torn down on unmount.
  useEffect(() => {
    const id = setInterval(refreshLive, INBOX_POLL_MS);
    return () => clearInterval(id);
  }, [refreshLive]);

  // Position the thread after each messages render. Three cases, in priority
  // order (runs in a LAYOUT effect so scroll adjustments happen before paint —
  // no visible jump):
  //   1. A jump-to-hit target (from search) → center it and flash.
  //   2. A prepend just happened (older page loaded) → PRESERVE position by
  //      restoring the distance from the bottom (R7.1: no viewport jump).
  //   3. Otherwise stick to the bottom (newest) only when stickBottom is set —
  //      true on a fresh open / initial load and on a nudge while near-bottom,
  //      false when the user has scrolled up into history.
  //
  // This is the ONLY thing that compensates for a prepend. Chromium's own
  // scroll anchoring would otherwise do it too and the two would add up to
  // about a page too far, so `.inbox__thread` sets `overflow-anchor: none`
  // (v7 §5.3) — one mechanism, and it is this one.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;

    if (jumpToEventId) {
      const target = el.querySelector(
        `[data-event-id="${cssEscape(jumpToEventId)}"]`,
      ) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.classList.add("wa-msg--flash");
        // Where the reader asked to be, so nothing else may move them: clearing
        // the hit re-runs this effect one commit later, and a chat opened from
        // a search hit is a fresh open, which means stick-to-bottom is still
        // armed. It fired the moment the jump landed and threw the reader to
        // the newest message. An anchor from a prepend the jump preempted would
        // do the same, a page's worth of scroll from a document that is gone.
        prependAnchorRef.current = null;
        stickBottomRef.current = false;
        setJumpToEventId(null);
        return;
      }
    }

    // Prepend position preservation: put back the distance from the BOTTOM, the
    // part of the document the new rows did not move.
    if (prependAnchorRef.current != null) {
      const fromBottom = prependAnchorRef.current;
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - fromBottom;
      return;
    }

    if (stickBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, jumpToEventId]);

  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (trimmed.length === 0) {
        setHits(null);
        return;
      }
      setSearching(true);
      try {
        const rows = await client.searchInbox(trimmed, { limit: 50 });
        if (mountedRef.current) setHits(rows);
      } catch {
        if (mountedRef.current) setHits([]);
      } finally {
        if (mountedRef.current) setSearching(false);
      }
    },
    [client],
  );

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    void runSearch(query);
  }

  function jumpToHit(hit: SearchHit) {
    setHits(null);
    setQuery("");
    if (hit.channelId) {
      setSelectedId(hit.channelId);
      setJumpToEventId(hit.eventId);
    }
  }

  const selectedChat = chats.find((ch) => ch.id === selectedId) ?? null;
  const pill = STATE_PILL[wa.state];

  return (
    <div className="inbox__grid">
      {/* ---- Status bar ------------------------------------------------- */}
      <header className="inbox__bar">
        <div className="inbox__conn">
          <span className={`wa-dot wa-dot--${pill.variant}`} />
          <span className="inbox__conn-label">{pill.label}</span>
          {wa.pushName && (
            <span className="inbox__conn-name">· {wa.pushName}</span>
          )}
        </div>

        <div className="inbox__bar-actions">
          <button
            type="button"
            className="wa-btn wa-btn--ghost"
            onClick={() => setShowExtend(true)}
          >
            Extend history
          </button>
          <button
            type="button"
            className="wa-btn wa-btn--ghost inbox__resync-btn"
            onClick={() => setShowResync(true)}
            title="Clear imported messages locally and re-link WhatsApp (scan QR again) for a clean re-import"
          >
            Re-sync from scratch
          </button>
          <label className="inbox__killswitch" title="Pause / resume ingestion">
            <input
              type="checkbox"
              checked={!wa.paused}
              onChange={(e) => void wa.setPaused(!e.target.checked)}
              aria-label={wa.paused ? "Resume ingestion" : "Pause ingestion"}
            />
            <span className="inbox__killswitch-track" aria-hidden="true" />
            <span className="inbox__killswitch-text">
              {wa.paused ? "Paused" : "Live"}
            </span>
          </label>
        </div>
      </header>

      {/* R5.1: non-blocking import banner. Shown while a backfill/import runs
          (including the big FULL history-sync phase) so the user stays in the
          Inbox and watches messages arrive live — never a blocking modal. It
          clears the moment progress.done / backfill_complete lands. */}
      {wa.importing && <ImportBanner progress={wa.progress} />}

      {/* A finished import is not the same as a complete one. When the worker
          judged this sync SHALLOW — WhatsApp sent the bootstrap batch and no
          bulk chunks — say so instead of leaving the user with a full-looking
          Inbox of one-message chats. Hidden while an import is still running,
          because a verdict on a sync in flight would be premature. */}
      {!wa.importing && wa.historyDepth?.verdict === "shallow" && (
        <ShallowHistoryNotice
          depth={wa.historyDepth}
          onExtend={() => setShowExtend(true)}
        />
      )}

      {wa.lastExtend && wa.lastExtend.startedAt !== dismissedExtend && (
        <ExtendResultNotice
          outcome={wa.lastExtend}
          onDismiss={() => setDismissedExtend(wa.lastExtend?.startedAt ?? null)}
        />
      )}

      {wa.lastError && (
        <div className="inbox__error" role="alert">
          <strong>{wa.lastError.code}:</strong> {wa.lastError.message}
        </div>
      )}

      <div className="inbox__panes">
        {/* ---- Left: chat list + search ------------------------------- */}
        <aside className="inbox__list" aria-label="Chats">
          <form className="inbox__search" onSubmit={onSearchSubmit} role="search">
            <input
              type="search"
              className="inbox__search-input"
              placeholder="Search messages…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value.trim().length === 0) setHits(null);
              }}
              aria-label="Search messages"
            />
          </form>

          {hits !== null ? (
            <div className="inbox__results" role="list" aria-label="Search results">
              {searching ? (
                <p className="inbox__empty">Searching…</p>
              ) : hits.length === 0 ? (
                <p className="inbox__empty">No matches.</p>
              ) : (
                hits.map((h) => (
                  <button
                    key={h.eventId}
                    type="button"
                    role="listitem"
                    className="inbox__result"
                    onClick={() => jumpToHit(h)}
                  >
                    <span className="inbox__result-head">
                      <span className="inbox__result-name">
                        {displayName(h.channelName, null, "Unknown chat")}
                      </span>
                      <span className="inbox__result-when">
                        {formatWhen(h.ts)}
                      </span>
                    </span>
                    <span
                      className="inbox__result-snippet"
                      // snippet() from FTS may contain <b> highlight markers.
                      dangerouslySetInnerHTML={{ __html: sanitizeSnippet(h.snippet) }}
                    />
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="inbox__chats" role="list">
              {chatsLoading ? (
                <p className="inbox__empty">Loading chats…</p>
              ) : chatsError ? (
                <p className="inbox__empty inbox__empty--error">{chatsError}</p>
              ) : chats.length === 0 ? (
                <p className="inbox__empty">No chats yet.</p>
              ) : (
                chats.map((ch) => {
                  const active = ch.id === selectedId;
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      role="listitem"
                      className={
                        "inbox__chat" + (active ? " inbox__chat--active" : "")
                      }
                      aria-current={active ? "true" : undefined}
                      onClick={() => setSelectedId(ch.id)}
                    >
                      <span className="inbox__chat-icon" aria-hidden="true">
                        {kindIcon(ch.kind)}
                      </span>
                      <span className="inbox__chat-body">
                        <span className="inbox__chat-top">
                          <span className="inbox__chat-name">
                            {displayName(ch.name, ch.sourceExtId)}
                          </span>
                          <span className="inbox__chat-when">
                            {formatWhen(ch.lastTs)}
                          </span>
                        </span>
                        <span className="inbox__chat-preview">
                          {ch.messageCount === 0 ? (
                            <em className="inbox__muted">No messages</em>
                          ) : (
                            chatPreview(ch)
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </aside>

        {/* ---- Right: messages ---------------------------------------- */}
        <div className="inbox__thread-wrap">
          {selectedChat ? (
            <>
              <header className="inbox__thread-head">
                <span className="inbox__thread-icon" aria-hidden="true">
                  {kindIcon(selectedChat.kind)}
                </span>
                <span className="inbox__thread-title">
                  {displayName(selectedChat.name, selectedChat.sourceExtId)}
                </span>
                <span className="inbox__thread-count">
                  {selectedChat.messageCount} messages
                </span>
              </header>

              <div
                className="inbox__thread"
                ref={threadRef}
                onScroll={onThreadScroll}
              >
                {messagesLoading ? (
                  <p className="inbox__empty">Loading messages…</p>
                ) : messagesError ? (
                  <p className="inbox__empty inbox__empty--error">
                    {messagesError}
                  </p>
                ) : messages.length === 0 ? (
                  <p className="inbox__empty">No messages in this chat.</p>
                ) : (
                  <>
                    {/* R7.1: scroll-up pagination affordance at the TOP. Shows a
                        spinner while an older page loads; once history is
                        exhausted (hasMore=false) it marks the start of the chat. */}
                    {loadingOlder ? (
                      <p
                        className="inbox__older-loading"
                        role="status"
                        aria-live="polite"
                      >
                        Loading older messages…
                      </p>
                    ) : !hasMore ? (
                      <p className="inbox__older-start">Beginning of chat</p>
                    ) : null}
                    {messages.map((msg) => (
                      <MessageBubble
                        key={msg.id}
                        msg={msg}
                        isGroup={selectedChat.kind === "group"}
                        mediaUrl={client.mediaUrl}
                      />
                    ))}
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="inbox__thread-empty">
              <p>Select a chat to read messages.</p>
            </div>
          )}
        </div>
      </div>

      {showExtend && (
        <ExtendModal
          onClose={() => setShowExtend(false)}
          onExtend={(r) => {
            void wa.extend(r);
            setShowExtend(false);
          }}
        />
      )}

      {showResync && (
        <ResyncModal
          busy={resyncing}
          onClose={() => {
            if (!resyncing) setShowResync(false);
          }}
          onConfirm={async () => {
            setResyncing(true);
            // R3.3: "Re-sync from scratch" is a full RE-LINK, not a silent
            // reset. Signal the parent FIRST so the brief unlink→QR transition
            // shows a friendly "Re-linking…" message — wa.relink()
            // optimistically flips paired→false, which unmounts this InboxView,
            // so we can't rely on running code after the await here.
            onRelinkStart();
            try {
              // useWhatsapp.relink() wipes imported data AND unlinks WhatsApp,
              // so the UI returns to the QR onboarding for a fresh scan
              // (WhatsApp then re-pushes full history).
              await wa.relink();
              if (mountedRef.current) {
                setChats([]);
                openWindow(null, []);
                setSelectedId(null);
                setShowResync(false);
              }
            } catch {
              // Error surfaced via wa.lastError (e.g. relink 404 on worker lag);
              // keep the dialog open so the user can retry.
              if (mountedRef.current) setResyncing(false);
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// R5.1: non-blocking import progress banner (top of the Inbox).
// ---------------------------------------------------------------------------

function ImportBanner({ progress }: { progress: Progress | null }) {
  const chatsDone = progress?.chatsDone ?? 0;
  const chatsTotal = progress?.chatsTotal ?? 0;
  const messages = progress?.messages ?? 0;

  // "Importing… 12/293 chats · 204 messages — runs in the background". Before
  // any totals arrive we can't show N/M, so degrade to just the counts we have.
  const chatsLabel =
    chatsTotal > 0
      ? `${chatsDone}/${chatsTotal} chats`
      : chatsDone > 0
        ? `${chatsDone} chats`
        : "";
  const msgLabel = messages > 0 ? `${messages} messages` : "";
  const parts = [chatsLabel, msgLabel].filter(Boolean).join(" · ");

  return (
    <div className="inbox__import-banner" role="status" aria-live="polite">
      <span className="wa-spinner wa-spinner--sm" aria-hidden="true" />
      <span className="inbox__import-banner-text">
        <strong>Importing…</strong>
        {parts ? ` ${parts}` : " starting"}
        <span className="inbox__import-banner-hint"> — runs in the background</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single message bubble. Read-only. Handles media/system/revoked kinds.
// ---------------------------------------------------------------------------

/**
 * What `kind` says when the stored bytes never recorded a mime. Only a fallback:
 * a video whose download failed keeps `kind: "video"` while what landed on disk
 * is its JPEG thumbnail, so the mime is the one that knows what it is looking at.
 */
const IMAGE_KINDS = new Set(["image", "sticker"]);

/** True when the stored file is a picture, whatever the sender's kind was. */
function isImageMedia(msg: InboxMessage): boolean {
  const mime = (msg.mediaMime ?? "").trim().toLowerCase();
  if (mime) return mime.startsWith("image/");
  return IMAGE_KINDS.has(msg.kind ?? "");
}

function MessageBubble({
  msg,
  isGroup,
  mediaUrl,
}: {
  msg: InboxMessage;
  isGroup: boolean;
  mediaUrl: (p: string) => string;
}) {
  const side = msg.fromMe ? "out" : "in";
  const src = msg.mediaUrl ? mediaUrl(msg.mediaUrl) : null;
  const isImage = src !== null && isImageMedia(msg);
  // A video's stored frame, shown in place of a bare chip. On a thumbnail-only
  // fallback row the thumbnail IS the file, and that already rendered above as
  // the picture — a poster there would be a second copy of the same bytes.
  const poster = !isImage && msg.mediaThumbUrl ? mediaUrl(msg.mediaThumbUrl) : null;
  const frames = !isImage ? msg.mediaFrames ?? [] : [];
  const meta = mediaMeta(msg, isImage);
  // The same guard `meta` uses: on a thumbnail-only fallback row the seconds
  // describe a clip nobody has, so they are not stamped on the picture either.
  const seconds = isImage ? null : msg.mediaSeconds ?? null;
  // A file chip falls back to the caption for its label when the worker
  // recorded no filename — repeating that text underneath would be a duplicate.
  const fileName = msg.mediaFilename || msg.text || fileLabel(msg.kind);
  const showCaption =
    src !== null && Boolean(msg.text) && (isImage || msg.text !== fileName);

  // A revoke tombstones the original row (media spec §5), leaving `kind` as
  // image/message — so `revokedAt` is what marks it, and the older `revoked`
  // kind still covers rows ingested before that change.
  const isRevoked = msg.revokedAt != null || msg.kind === "revoked";
  const isSystem = msg.kind === "system";

  if (isSystem) {
    return (
      <div className="inbox__system" data-event-id={msg.id}>
        {msg.text || "System message"}
      </div>
    );
  }

  const reactions = msg.reactions ?? [];

  return (
    <div
      className={`inbox__msg inbox__msg--${side}`}
      data-event-id={msg.id}
      data-kind={msg.kind ?? ""}
    >
      <div className={`inbox__bubble inbox__bubble--${side}`}>
        {isGroup && !msg.fromMe && msg.actorName && (
          <span className="inbox__msg-actor">{msg.actorName}</span>
        )}

        {/* Not the sender's own words — say so before the content, the way
            WhatsApp does. A deleted message is nobody's words, so it drops. */}
        {msg.isForwarded && !isRevoked && (
          <span className="inbox__msg-forwarded">↪ Forwarded</span>
        )}

        {/* R5.4: quoted-reply block ABOVE the reply content (WhatsApp Web
            style): a left-border chip with the quoted sender + truncated text.
            Rendered even for revoked replies — the quote references a DIFFERENT
            message. */}
        {msg.replyTo && <QuotedReply reply={msg.replyTo} />}

        {isRevoked ? (
          <span className="inbox__msg-revoked">🚫 This message was deleted</span>
        ) : (
          <>
            {isImage ? (
              <>
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className="inbox__media-link"
                >
                  <MediaImage
                    src={src}
                    // The sender's caption describes the picture; a WhatsApp
                    // filename ("IMG-20260702-WA0003.jpg") does not, so it is
                    // only the fallback.
                    alt={msg.text || msg.mediaFilename || "image"}
                    width={msg.mediaWidth}
                    height={msg.mediaHeight}
                  />
                </a>
                {(msg.mediaFilename || meta) && (
                  <span className="inbox__media-meta">
                    {[msg.mediaFilename, meta].filter(Boolean).join(" · ")}
                  </span>
                )}
              </>
            ) : src && (poster || frames.length > 0) ? (
              <VideoMedia
                href={src}
                poster={poster}
                frames={frames}
                label={fileName}
                meta={meta}
                seconds={seconds}
                width={msg.mediaWidth}
                height={msg.mediaHeight}
                mediaUrl={mediaUrl}
              />
            ) : src ? (
              <FileChip href={src} name={fileName} meta={meta} />
            ) : null}

            {msg.text && !src && (
              <span className="inbox__msg-text">{msg.text}</span>
            )}
            {showCaption && (
              <span className="inbox__msg-caption">{msg.text}</span>
            )}

            {msg.link && (
              <LinkPreview
                link={msg.link}
                // A message that carries its own file has already shown its
                // frames above; these are only ever the linked clip's.
                frames={src === null ? frames : []}
                mediaUrl={mediaUrl}
              />
            )}

            {msg.mediaDescription && (
              <MachineNote label="AI description" text={msg.mediaDescription} />
            )}

            {msg.transcript && (
              <MachineNote label="Machine transcript" text={msg.transcript} />
            )}
          </>
        )}

        <span className="inbox__msg-time">
          {/* An edit rewrites the row in place, so without this the new body
              looks like what was sent originally. */}
          {msg.editedAt && !isRevoked && (
            <span className="inbox__msg-edited">Edited</span>
          )}
          {formatFullTime(msg.ts)}
        </span>

        {/* R5.3: reaction chips overlaid at the bottom edge of the bubble
            (WhatsApp style). Duplicates are grouped + counted. These are the
            reactions the worker ATTACHED to this message — reactions never
            appear as their own stream bubbles. */}
        {reactions.length > 0 && <ReactionChips reactions={reactions} />}
      </div>
    </div>
  );
}

/** An attachment we can offer but not show: the download link and its facts. */
function FileChip({
  href,
  name,
  meta,
}: {
  href: string;
  name: string;
  meta: string;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inbox__file" download>
      <span className="inbox__file-icon" aria-hidden="true">
        📎
      </span>
      <span className="inbox__file-body">
        <span className="inbox__file-name">{name}</span>
        {meta && <span className="inbox__file-meta">{meta}</span>}
      </span>
    </a>
  );
}

/**
 * The largest a picture is drawn in a bubble. Mirrored by `.inbox__media-img`'s
 * max-width/max-height, which catch anything that reaches the thread without a
 * box of its own.
 */
const MEDIA_MAX_W = 260;
const MEDIA_MAX_H = 300;

/** The box a `width`x`height` picture ends up in. Only ever shrinks. */
function fitBox(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MEDIA_MAX_W / width, MEDIA_MAX_H / height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/**
 * A picture in a box the browser can lay out before it has a single byte of it.
 * The box is computed from the dimensions WhatsApp sent, so the row is its
 * final height from the first paint — an image left to size itself goes from
 * nothing to 300px after decode, and a whole prepended page of that is what
 * moved the thread under a reader (v7 §5.4). Stating it outright rather than
 * leaving it to `aspect-ratio` is deliberate: with `width: auto` a picture that
 * has not loaded has no width to apply a ratio to, so the height would still
 * arrive late. A row carrying no dimensions gets a box of our choosing instead
 * (`.inbox__media-img--unsized`) — a guessed shape, but the same one twice.
 */
function MediaImage({
  src,
  alt,
  width,
  height,
  onError,
}: {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  onError?: () => void;
}) {
  const box =
    width != null && width > 0 && height != null && height > 0
      ? fitBox(width, height)
      : null;
  return (
    <img
      className={"inbox__media-img" + (box ? "" : " inbox__media-img--unsized")}
      src={src}
      alt={alt}
      {...(box
        ? {
            width: box.width,
            height: box.height,
            style: { width: `${box.width}px`, height: `${box.height}px` },
          }
        : {})}
      onError={onError}
    />
  );
}

/**
 * A video in the thread (v7 §3): its poster, the play badge, and how long it
 * runs. The poster LEADS whenever there is one — a strip of stills reads as a
 * photo album, and the first thing this bubble has to say is that it is a clip.
 * The frames are what the model actually looked at, so they stay reachable
 * behind a control rather than being dropped; a video with no poster at all
 * still shows them outright, there being nothing better to lead with.
 */
function VideoMedia({
  href,
  poster,
  frames,
  label,
  meta,
  seconds,
  width,
  height,
  mediaUrl,
}: {
  href: string;
  poster: string | null;
  frames: MessageFrame[];
  label: string;
  meta: string;
  seconds: number | null;
  width?: number | null;
  height?: number | null;
  mediaUrl: (p: string) => string;
}) {
  // A stored path can go stale, so a poster that will not load hands over to
  // whatever else the clip has rather than leaving a broken picture.
  const [posterBroken, setPosterBroken] = useState(false);
  const [showFrames, setShowFrames] = useState(false);

  if (poster === null || posterBroken) {
    return frames.length > 0 ? (
      <FrameStrip
        href={href}
        frames={frames}
        label={label}
        meta={meta}
        mediaUrl={mediaUrl}
        standalone
      />
    ) : (
      <FileChip href={href} name={label} meta={meta} />
    );
  }

  const count = `${frames.length} sampled ${frames.length === 1 ? "frame" : "frames"}`;
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inbox__media-link inbox__media-link--poster"
      >
        <MediaImage
          src={poster}
          alt={label}
          width={width}
          height={height}
          onError={() => setPosterBroken(true)}
        />
        <span className="inbox__media-play" aria-hidden="true">
          ▶
        </span>
        {seconds != null && seconds > 0 && (
          <span className="inbox__media-duration">{formatDuration(seconds)}</span>
        )}
      </a>
      {(label || meta) && (
        <span className="inbox__media-meta">
          {[label, meta].filter(Boolean).join(" · ")}
        </span>
      )}
      {frames.length > 0 && (
        <>
          <button
            type="button"
            className="inbox__more"
            aria-expanded={showFrames}
            onClick={() => setShowFrames((v) => !v)}
          >
            {showFrames ? "Hide" : "Show"} {count}
          </button>
          {showFrames && (
            <FrameStrip
              href={href}
              frames={frames}
              label={label}
              meta={meta}
              mediaUrl={mediaUrl}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * v5 §2: the frames sampled across a video, each labelled with where in the
 * clip it was taken. A frame whose file went missing drops out of the strip.
 *
 * `standalone` means the strip IS the clip's rendering: it then spells the
 * count out — nothing here watched the video, it saw N moments of it — carries
 * the file's own facts, and falls back to the chip if every frame is gone.
 * Under a poster all three have already been said. `note` says where the stills
 * came from when that is not obvious, and rides with the live count so it can
 * never outlive the tiles it describes.
 */
function FrameStrip({
  href,
  frames,
  label,
  meta,
  mediaUrl,
  standalone = false,
  note,
}: {
  href: string;
  frames: MessageFrame[];
  label: string;
  meta: string;
  mediaUrl: (p: string) => string;
  standalone?: boolean;
  note?: string;
}) {
  const [broken, setBroken] = useState<number[]>([]);
  const shown = frames.filter((_, i) => !broken.includes(i));
  if (shown.length === 0) {
    return standalone ? <FileChip href={href} name={label} meta={meta} /> : null;
  }

  const count = `${shown.length} sampled ${shown.length === 1 ? "frame" : "frames"}`;
  return (
    <>
      <div className="inbox__frames" aria-label={`${count} from the video`}>
        {frames.map((f, i) =>
          broken.includes(i) ? null : (
            <a
              key={f.url}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inbox__frame"
            >
              <img
                src={mediaUrl(f.url)}
                alt={`${label} at ${formatDuration(f.seconds)}`}
                onError={() => setBroken((b) => [...b, i])}
              />
              <span className="inbox__frame-at">{formatDuration(f.seconds)}</span>
            </a>
          ),
        )}
      </div>
      {standalone ? (
        <span className="inbox__media-meta">
          {[label, count, meta].filter(Boolean).join(" · ")}
        </span>
      ) : note ? (
        <span className="inbox__media-meta">
          {note} · {count}
        </span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Text nobody in the chat wrote — what the media model read out of an
// attachment (rich-media spec §8), or what the worker fetched from a linked
// page (v3 §3). Labelled and styled as machine-read so it can never be mistaken
// for the sender's own words, and kept visually below the real message text.
// ---------------------------------------------------------------------------

/**
 * Longer than this and the note is folded to two lines (v7 §2). The threshold
 * is characters and not measured height on purpose: a measurement only lands
 * after paint, and this list restores its scroll position before it (§5) — a
 * box that settles on its height afterwards is the scroll bug in another coat.
 * At the bubble's narrowest this many characters is three lines and at its
 * widest two, so a folded note is never taller than the text inside it.
 */
const NOTE_CLAMP_CHARS = 140;

function MachineNote({ label, text }: { label: string; text: string }) {
  const foldable = text.length > NOTE_CLAMP_CHARS;
  const [open, setOpen] = useState(false);
  const folded = foldable && !open;
  return (
    <span className="inbox__ai-desc">
      <span className="inbox__ai-desc-label">{label}</span>
      <span
        className={
          "inbox__ai-desc-text" +
          (folded ? " inbox__ai-desc-text--folded" : "")
        }
      >
        {text}
      </span>
      {foldable && (
        <button
          type="button"
          className="inbox__more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// v3 §3: the link preview WhatsApp sent with the message — title, blurb and
// thumbnail — plus the linked page's own text when link fetching is on.
// ---------------------------------------------------------------------------

function LinkPreview({
  link,
  frames,
  mediaUrl,
}: {
  link: MessageLink;
  /**
   * v7 §4: stills taken from the clip a YouTube/Instagram link points at. The
   * download is deleted afterwards, so these are the only picture of it there
   * will ever be — and they hang off the message rather than off a file,
   * because a link message has none.
   */
  frames: MessageFrame[];
  mediaUrl: (p: string) => string;
}) {
  const host = linkHost(link.url);
  // History sync strips the preview image (0 of 32 links in the real DB have
  // one), so the card is laid out to read as a title + blurb on its own — and a
  // thumbnail whose file went missing drops back to exactly that.
  const [thumbBroken, setThumbBroken] = useState(false);
  const thumb =
    link.thumbUrl && !thumbBroken ? mediaUrl(link.thumbUrl) : null;
  // A URL WhatsApp sent no preview for is already the message text; a card
  // repeating it would print the same line twice.
  const hasPreview = Boolean(link.title || link.description || thumb);
  return (
    <>
      {hasPreview && (
        <a
          className="inbox__link"
          href={link.url}
          target="_blank"
          rel="noreferrer"
        >
          {thumb && (
            <img
              className="inbox__link-thumb"
              src={thumb}
              alt=""
              onError={() => setThumbBroken(true)}
            />
          )}
          <span className="inbox__link-body">
            <span className="inbox__link-title">{link.title || host}</span>
            {link.description && (
              <span className="inbox__link-desc">{link.description}</span>
            )}
            <span className="inbox__link-host">{host}</span>
          </span>
        </a>
      )}
      {frames.length > 0 && (
        <FrameStrip
          href={link.url}
          frames={frames}
          label={link.title || host}
          meta=""
          mediaUrl={mediaUrl}
          note="From the linked video"
        />
      )}
      {link.scrapedText && (
        <MachineNote label="From the linked page" text={link.scrapedText} />
      )}
    </>
  );
}

/** Host for the card's byline; an unparseable URL shows as-is rather than not at all. */
function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// R5.4 quoted-reply chip (rendered above a reply's content).
// ---------------------------------------------------------------------------

function QuotedReply({ reply }: { reply: NonNullable<InboxMessage["replyTo"]> }) {
  const who = displayName(reply.actorName, reply.actorSourceExtId, "");
  const text = (reply.text ?? "").trim();
  // Subtle placeholder when the quoted target is unknown / carried no text.
  const body = text.length > 0 ? text : "Replied to a message";
  return (
    <div className="inbox__quote" aria-label="Replied message">
      {who && <span className="inbox__quote-actor">{who}</span>}
      <span className="inbox__quote-text">{body}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// R5.3 reaction chips (rendered on/under the target bubble).
// ---------------------------------------------------------------------------

/**
 * One chip per emoji, naming who left it. The reactor rides along at every
 * layer, so counting the emoji and stopping there threw away the half of a
 * reaction that says whose it is.
 */
function ReactionChips({ reactions }: { reactions: Reaction[] }) {
  const groups = groupReactions(reactions);
  if (groups.length === 0) return null;
  return (
    <div className="inbox__reactions" aria-label="Reactions">
      {groups.map(({ emoji, who }) => (
        <span
          className="inbox__reaction"
          key={emoji}
          title={`${emoji} ${who.join(", ")}`}
        >
          <span className="inbox__reaction-emoji">{emoji}</span>
          <span className="inbox__reaction-who">{reactorLabel(who)}</span>
        </span>
      ))}
    </div>
  );
}

/** One entry per emoji, carrying who left it in the order they did. */
function groupReactions(
  reactions: Reaction[],
): { emoji: string; who: string[] }[] {
  const byEmoji = new Map<string, string[]>();
  for (const r of reactions) {
    const emoji = (r.emoji ?? "").trim();
    if (!emoji) continue;
    // The reader is "You", the way WhatsApp names them. A reaction carries no
    // JID of its own, so an unresolved reactor falls back to the placeholder
    // rather than to a number this cannot know.
    const who = r.fromMe ? "You" : displayName(r.actorName, null, "Someone");
    const list = byEmoji.get(emoji);
    if (list) list.push(who);
    else byEmoji.set(emoji, [who]);
  }
  return [...byEmoji.entries()].map(([emoji, who]) => ({ emoji, who }));
}

/** "Mummy", "You and Mummy", "You, Mummy and 2 others" — names, not a tally. */
function reactorLabel(who: string[]): string {
  if (who.length <= 1) return who[0] ?? "";
  if (who.length === 2) return `${who[0]} and ${who[1]}`;
  const rest = who.length - 2;
  return `${who[0]}, ${who[1]} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/**
 * Attachment facts we actually have, as one line: "image/jpeg · 240 KB · 0:38".
 * `still` drops the duration: when a failed video download leaves its thumbnail
 * behind, the seconds describe the clip nobody has — printing them under the
 * picture claims a 16 KB JPEG plays for fourteen seconds.
 */
function mediaMeta(msg: InboxMessage, still: boolean): string {
  const parts: string[] = [];
  if (msg.mediaMime) parts.push(msg.mediaMime);
  if (msg.mediaSize != null && msg.mediaSize > 0) {
    parts.push(formatBytes(msg.mediaSize));
  }
  if (!still && msg.mediaSeconds != null && msg.mediaSeconds > 0) {
    parts.push(formatDuration(msg.mediaSeconds));
  }
  return parts.join(" · ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Clip length as "m:ss". */
function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fileLabel(kind: string | null): string {
  switch (kind) {
    case "video":
      return "Video";
    case "audio":
      return "Audio message";
    case "document":
      return "Document";
    case "location":
      return "Location";
    case "contact":
      return "Contact";
    default:
      return "Attachment";
  }
}

// ---------------------------------------------------------------------------
// Extend-history modal (reuses the range list).
// ---------------------------------------------------------------------------

function ExtendModal({
  onClose,
  onExtend,
}: {
  onClose(): void;
  onExtend(range: Range): void;
}) {
  const [range, setRange] = useState<Range>("30d");
  return (
    <div className="wa-modal" role="dialog" aria-modal="true" aria-label="Extend history">
      <div className="wa-modal__backdrop" onClick={onClose} />
      <div className="wa-modal__card">
        <h2 className="wa-modal__title">Extend history</h2>
        <p className="wa-onboard__hint">
          Fetch older messages to widen your imported range.
        </p>
        <div className="wa-ranges" role="radiogroup" aria-label="Extend range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              className={"wa-range" + (range === r ? " wa-range--selected" : "")}
              onClick={() => setRange(r)}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="wa-modal__actions">
          <button type="button" className="wa-btn wa-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="wa-btn wa-btn--primary"
            onClick={() => onExtend(range)}
          >
            Extend
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-sync-from-scratch confirm dialog (bug 7).
// ---------------------------------------------------------------------------

function ResyncModal({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  return (
    <div
      className="wa-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Re-sync from scratch"
    >
      <div className="wa-modal__backdrop" onClick={onClose} />
      <div className="wa-modal__card">
        <h2 className="wa-modal__title">Re-sync from scratch?</h2>
        <p className="wa-onboard__hint">
          This clears imported messages locally AND re-links WhatsApp — you'll
          scan the QR code again. Your chats then re-import fresh (fixes
          duplicates).
        </p>
        <div className="wa-modal__actions">
          <button
            type="button"
            className="wa-btn wa-btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="wa-btn wa-btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Re-linking…" : "Re-link & re-sync"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep only <b>/</b> tags from an FTS snippet; strip everything else. */
function sanitizeSnippet(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Re-enable the bold highlight markers the DB emits.
  return escaped
    .replace(/&lt;b&gt;/g, "<b>")
    .replace(/&lt;\/b&gt;/g, "</b>");
}

function cssEscape(s: string): string {
  // Minimal escape for attribute-selector usage.
  return s.replace(/["\\]/g, "\\$&");
}

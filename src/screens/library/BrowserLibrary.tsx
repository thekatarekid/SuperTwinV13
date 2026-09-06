// ===========================================================================
// Library › Browser — visit chains as TAB CHAINS (spec §14.3.2, §12) and the
// browser SOURCE connect flow (V6 P1 S1.4; Product §3.2–3.4, §4).
//
// Two states, decided by the CONSENT ROW — not by whether events exist yet:
//
//   * not connected → the connect card: every browser and every profile found
//     (Chrome, Brave, Arc, Edge, Comet, Safari), real counts per window read
//     copy-then-read before anything is imported, the plateau note ("Chrome
//     keeps 90 days"), Safari's Full Disk Access message, and the local-path
//     disclosure.
//   * connected → the source's own data.
//
// Chain hops fold at render: consecutive hops to one URL within 30 s show
// once with ×N (T6-3), mirroring the packer's collapse. Nothing is deleted.
//
// ---------------------------------------------------------------------------
// S6d L5 — THE CHOICE THE CARD ALREADY IMPLIED, AND THE BLANK AFTER "CONNECT"
//
// WHAT THE USER SAW. The card listed four browser profiles under diamond
// bullets that looked selectable and were not: Connect took EVERY browser and
// ALL history, with no window control of any kind — while WhatsApp, one
// sub-tab over, asks for an Index window and an Understand window before it
// reads a byte. Then, after Connect, the panel showed "connected — reading
// your history; visits appear here as they land" for minutes with no sign of
// life.
//
// WHY THE BLANK. Two causes, both measured on the user's own worker (a
// WhatsApp import of ~11k events was running, and better-sqlite3 is
// synchronous, so every read queues behind the importer's writes):
//
//   1. `POST /api/sources/browser/connect` did not answer until the whole
//      first history poll had finished. The watcher ran its first poll on a
//      `queueMicrotask`, which drains BEFORE the `await` in the route
//      resolves — so "Connect" hung for the length of the import
//      (adapters/browser/watcher.ts now defers it to a macrotask).
//   2. The panel had one number for the connected state, `event_count`, an
//      unbounded COUNT over the event log: 0.13 s / 3.0 s / 6.9 s for the
//      same query minutes apart. And while it was pending, `status === null`
//      fell through to the connected branch and printed the "reading your
//      history" line — a verdict the panel had not earned.
//
// WHAT THIS FILE DOES ABOUT IT.
//
//   * Per-profile CHECKBOXES, defaulting to every readable profile. A profile
//     that cannot be read (Safari without Full Disk Access) is disabled and
//     carries the button that opens the right settings pane.
//   * INDEX and UNDERSTAND windows on the same footing as WhatsApp's, with
//     the counts MEASURED for the current selection — uncheck Brave and every
//     number on the card drops. Understand can never reach past Index (CNS-03).
//   * Connect posts the pick, the windows, the per-profile counts and the
//     card's own words; the worker scopes the watcher to exactly that.
//   * The moment Connect returns, the panel is the CONNECTED panel, showing
//     the import profile by profile from the worker's in-process ledger
//     (GET …/import — no event-log query, so it is safe to poll while the
//     importer holds the database). The chain list refreshes underneath it as
//     rows land.
//   * `unknown` is never rendered as `empty`: while the panel does not know
//     whether the browser is connected, it paints L2's skeleton.
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LoadFailure, PanelSkeleton, RefreshingHint, useLoad } from "../../components/LoadState";
import {
  IMPORT_RANGES,
  connectBrowserSource,
  describeWorkerError,
  fetchBrowserDiscovery,
  fetchBrowserImport,
  fetchBrowserSourceStatus,
  fetchLibraryBrowser,
  type BrowserChainVisit,
  type BrowserDiscovery,
  type BrowserImportProgress,
  type BrowserProfileCounts,
  type BrowserProfileImport,
  type BrowserSourceStatus,
  type ImportRange,
  type LibraryBrowser,
} from "../../lib/api";
import { openExternal } from "../../lib/tauri";
import { ConnectCard, hhmm, minutesLabel } from "./shared";
import { SourcePanelStatus } from "./SourceStatus";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Empty for an unmeasured hop — an invented "1s" would be a made-up number. */
function dwellLabel(ms: number): string {
  if (!ms || ms <= 0) return "";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return minutesLabel(Math.round(ms / 60_000));
}

/** How many hops of a chain are shown before the "+N more" line. */
const HOPS_SHOWN = 8;

/** Render-time fold (T6-3): consecutive hops to one URL within 30 s. */
export const HOP_COLLAPSE_MS = 30_000;

/** How often the import ledger is asked while history is landing. */
export const IMPORT_POLL_MS = 2_000;
/** Floor between chain-list refreshes while importing — that read IS expensive. */
export const CHAIN_REFRESH_MS = 15_000;
/** A sub-tab flip inside this window repaints from cache instead of re-asking. */
const FRESH_MS = 10_000;

export interface FoldedHop {
  visit: BrowserChainVisit;
  count: number;
  first_ts: string;
  last_ts: string;
  dwell_ms: number;
}

export function foldHops(visits: readonly BrowserChainVisit[], windowMs: number = HOP_COLLAPSE_MS): FoldedHop[] {
  const out: FoldedHop[] = [];
  for (const v of visits) {
    const last = out[out.length - 1];
    const t = Date.parse(v.ts);
    const start = last ? Date.parse(last.first_ts) : NaN;
    if (last && last.visit.url === v.url && Number.isFinite(t) && Number.isFinite(start) && t >= start && t - start <= windowMs) {
      last.count += 1;
      last.last_ts = v.ts;
      last.dwell_ms += v.dwell_ms;
      continue;
    }
    out.push({ visit: v, count: 1, first_ts: v.ts, last_ts: v.ts, dwell_ms: v.dwell_ms });
  }
  return out;
}

// ---- Windows ---------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Days behind "now" for each import range; `null` = no floor at all. */
const RANGE_DAYS: Record<ImportRange, number | null> = {
  "24h": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "1y": 365,
  "2y": 730,
  "3y": 1095,
  "4y": 1460,
  "5y": 1825,
  all: null,
};

/** Browser wording — RANGE_LABELS in lib/api is phrased for WhatsApp. */
const WINDOW_LABELS: Record<ImportRange, string> = {
  "24h": "last 24 hours",
  "3d": "last 3 days",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  "180d": "last 6 months",
  "1y": "last year",
  "2y": "last 2 years",
  "3y": "last 3 years",
  "4y": "last 4 years",
  "5y": "last 5 years",
  all: "everything these browsers still have",
};

/** The windows the card offers in its two selects, in order. */
const OFFERED_WINDOWS: readonly ImportRange[] = ["7d", "30d", "90d", "180d", "1y", "2y", "5y", "all"];

/**
 * The four windows shown side by side on every profile row and in the totals
 * line — enough to see the shape of a browser's history at a glance. Short
 * labels: this is a scan, not a sentence.
 */
const CARD_WINDOWS: Array<{ key: ImportRange; label: string }> = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "1y", label: "1 year" },
  { key: "all", label: "everything" },
];

/** ISO floor for a range at the start of that UTC day; null = no floor. */
export function windowFloorIso(range: ImportRange, nowMs: number): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  const d = new Date(nowMs - days * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Understand can never reach further back than Index (CNS-03). A shorter Index
 * clamps the Understand pick down; it is never silently widened.
 */
export function clampUnderstandWindow(understand: ImportRange, index: ImportRange): ImportRange {
  const u = RANGE_DAYS[understand];
  const i = RANGE_DAYS[index];
  if (i === null) return understand;
  if (u === null || u > i) return index;
  return understand;
}

/** The windows the card can honestly price: what the worker actually counted. */
export function offeredWindows(counted: readonly string[] | undefined): ImportRange[] {
  const have = new Set(counted ?? IMPORT_RANGES);
  const out = OFFERED_WINDOWS.filter((w) => have.has(w));
  return out.length > 0 ? out : ["all"];
}

// ---- The connect card ------------------------------------------------------

function n(v: number | undefined): string {
  return (v ?? 0).toLocaleString("en-IN");
}

export function profileName(p: { browser_name: string; profile: string; label: string | null }): string {
  const who = p.label ?? (p.profile === "Default" || p.profile === "Safari" ? null : p.profile);
  return who ? `${p.browser_name} · ${who}` : p.browser_name;
}

function visitsIn(profiles: readonly BrowserProfileCounts[], range: ImportRange): number {
  return profiles.reduce((a, p) => a + (p.windows[range]?.visits ?? 0), 0);
}

function bookmarksIn(profiles: readonly BrowserProfileCounts[], range: ImportRange): number {
  return profiles.reduce((a, p) => a + (p.windows[range]?.bookmarks ?? 0), 0);
}

/**
 * What the user is agreeing to, in the card's own words. Stored verbatim with
 * the consent row (T4-10 in spirit): the record says what the card said.
 */
export function browserCardText(
  chosen: readonly BrowserProfileCounts[],
  skipped: readonly BrowserProfileCounts[],
  index: ImportRange,
  understand: ImportRange | null,
): string {
  const lines = [
    `Index ${WINDOW_LABELS[index]}: ${n(visitsIn(chosen, index))} visits and ${n(bookmarksIn(chosen, index))} bookmarks ` +
      `from ${chosen.length} browser profile${chosen.length === 1 ? "" : "s"} (measured).`,
    understand
      ? `Understand ${WINDOW_LABELS[understand]}: ${n(visitsIn(chosen, understand))} visits go to the model (measured).`
      : "Understand: nothing goes to the model.",
    ...chosen.map((p) => `· ${profileName(p)} — ${n(p.windows[index]?.visits)} visits in this window`),
    ...skipped.map(
      (p) =>
        `· ${profileName(p)} — not included${p.readable ? "" : p.error?.code === "full-disk-access" ? " (needs Full Disk Access)" : " (couldn't be read)"}`,
    ),
    ...chosen.filter((p) => p.retention_note).map((p) => p.retention_note!),
  ];
  return lines.join("\n");
}

function ProfileRow(props: {
  profile: BrowserProfileCounts;
  checked: boolean;
  onToggle: (path: string, on: boolean) => void;
  onOpenSettings: (url: string) => void;
}): JSX.Element {
  const p = props.profile;
  const label = profileName(p);
  if (!p.readable) {
    const fda = p.error?.code === "full-disk-access";
    return (
      <li className="row static profile-row unreadable" aria-label={`browser profile ${label}`}>
        <input
          type="checkbox"
          className="profile-check"
          aria-label={`include ${label}`}
          checked={false}
          disabled
          readOnly
        />
        <span>
          <strong>{label}</strong>
          <span className="meta"> · {fda ? "needs Full Disk Access" : "couldn't read"}</span>
          <br />
          <span className="meta">{p.error?.message}</span>
          {fda && (
            <>
              <br />
              <button
                type="button"
                className="linklike"
                aria-label={`open Full Disk Access for ${label}`}
                onClick={() => props.onOpenSettings(p.error?.settings_url ?? "")}
              >
                Open Full Disk Access
              </button>
            </>
          )}
        </span>
      </li>
    );
  }
  return (
    <li className="row static profile-row" aria-label={`browser profile ${label}`}>
      <input
        type="checkbox"
        className="profile-check"
        aria-label={`include ${label}`}
        checked={props.checked}
        onChange={(e) => props.onToggle(p.history_path, e.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        <span className="meta">
          {" · "}
          {CARD_WINDOWS.map((w) => `${n(p.windows[w.key]?.visits)} visits / ${w.label}`).join(" · ")}
          {p.total_bookmarks > 0 ? ` · ${n(p.total_bookmarks)} bookmarks` : ""}
        </span>
        {p.retention_note && (
          <>
            <br />
            <span className="meta">{p.retention_note}</span>
          </>
        )}
      </span>
    </li>
  );
}

// ---- The import view -------------------------------------------------------

const IMPORT_STATE_TEXT: Record<BrowserProfileImport["state"], string> = {
  pending: "waiting its turn",
  reading: "reading…",
  done: "done",
  failed: "couldn't be read",
};

export function importHeadline(p: BrowserImportProgress): string {
  if (!p.known) return "starting the import…";
  const done = p.profiles.filter((x) => x.state === "done").length;
  const of = `${done} of ${p.profiles.length} profile${p.profiles.length === 1 ? "" : "s"}`;
  const visits =
    p.expected_visits !== null && p.expected_visits > 0
      ? `${n(p.visits_read)} of about ${n(p.expected_visits)} visits`
      : `${n(p.visits_read)} visits`;
  if (p.first_pass_done && !p.reading) return `History imported — ${of}, ${visits}.`;
  return `Reading your history — ${of}, ${visits} so far.`;
}

function ImportPanel(props: { progress: BrowserImportProgress }): JSX.Element {
  const p = props.progress;
  const running = !p.first_pass_done || p.reading;
  const pct =
    p.expected_visits !== null && p.expected_visits > 0
      ? Math.min(100, Math.round((p.visits_read / p.expected_visits) * 100))
      : null;
  return (
    <div className="import-panel" aria-label="browser import progress" role="status" aria-live="polite">
      <div className="import-head">
        <span className="glyph" aria-hidden="true">
          ◇
        </span>
        <strong>{importHeadline(p)}</strong>
        {pct !== null && <span className="chip">{pct}%</span>}
      </div>
      {running && (
        <div
          className="import-bar"
          role="progressbar"
          aria-label="history import"
          {...(pct !== null ? { "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 } : {})}
        >
          <span className="import-bar-fill" style={pct !== null ? { width: `${pct}%` } : undefined} />
        </div>
      )}
      <ul className="import-list">
        {p.profiles.map((x) => (
          <li key={x.history_path} aria-label={`import ${profileName(x)}`}>
            <span className="hop-title">{profileName(x)}</span>
            <span className="chip">{IMPORT_STATE_TEXT[x.state]}</span>
            {x.visits_read > 0 && (
              <span className="meta">
                {n(x.visits_read)} visits read
                {x.expected_visits !== null && x.expected_visits > 0 ? ` of about ${n(x.expected_visits)}` : ""}
                {x.events_written !== x.visits_read ? ` · ${n(x.events_written)} new` : ""}
              </span>
            )}
            {x.error && <span className="meta">{x.error}</span>}
          </li>
        ))}
      </ul>
      {running && <p className="meta">Visits appear below as they land — you can leave this tab.</p>}
    </div>
  );
}

// ---- The panel -------------------------------------------------------------

export function BrowserLibrary(props: { pollMs?: number } = {}): JSX.Element {
  const pollMs = props.pollMs ?? IMPORT_POLL_MS;
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BrowserImportProgress | null>(null);
  /** Chains whose hop list the user asked to see in full. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Chosen profiles, by history path. Null until discovery has been seen. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [indexWindow, setIndexWindow] = useState<ImportRange>("all");
  const [understandWindow, setUnderstandWindow] = useState<ImportRange | null>("30d");

  const statusLoad = useLoad<BrowserSourceStatus>(fetchBrowserSourceStatus, [], {
    cacheKey: "library.browser.status",
    freshFor: FRESH_MS,
  });
  const status = statusLoad.data;
  const connected = status?.connected === true;
  const disconnected = status !== null && !status.connected;

  const discoveryLoad = useLoad<BrowserDiscovery | null>(
    () => (disconnected ? fetchBrowserDiscovery() : Promise.resolve(null)),
    [disconnected],
    // The key carries the CONDITION: the placeholder a not-applicable read
    // resolves to must never be cached under the key the real answer uses, or
    // `freshFor` would serve that placeholder back as the answer.
    { cacheKey: disconnected ? "library.browser.discovery" : "library.browser.discovery.idle", freshFor: FRESH_MS },
  );
  const discovery = discoveryLoad.data;

  const dataLoad = useLoad<LibraryBrowser | null>(
    () => (connected ? fetchLibraryBrowser() : Promise.resolve(null)),
    [connected],
    { cacheKey: connected ? "library.browser.chains" : "library.browser.chains.idle", freshFor: FRESH_MS },
  );
  const data = dataLoad.data;

  // ---- The live import ledger. Cheap by construction (no event-log query),
  // so it can be asked every couple of seconds while history lands; it stops
  // asking the moment the first pass is done.
  const settled = useRef(false);
  // Seeded at mount: the chain read has just run, so the first ledger tick
  // must not immediately ask for it again.
  const lastChainRefresh = useRef(Date.now());
  const lastWritten = useRef(-1);
  const refreshChains = dataLoad.retry;
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    let inFlight = false;
    const tick = async (): Promise<void> => {
      if (inFlight || settled.current) return;
      inFlight = true;
      try {
        const r = await fetchBrowserImport();
        if (!alive) return;
        setProgress(r.progress);
        const done = r.progress.known && r.progress.first_pass_done && !r.progress.reading;
        const grew = r.progress.events_written > lastWritten.current;
        lastWritten.current = r.progress.events_written;
        const now = Date.now();
        // Repaint the chains when new rows have landed — but that read walks
        // the log, so never more often than CHAIN_REFRESH_MS.
        if ((done || grew) && now - lastChainRefresh.current >= CHAIN_REFRESH_MS) {
          lastChainRefresh.current = now;
          refreshChains();
        }
        if (done) settled.current = true;
      } catch {
        // Keep the last honest picture; the next tick tries again.
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [connected, pollMs, refreshChains]);

  const openSettings = useCallback((url: string) => {
    if (!url) return;
    void openExternal(url).catch((err: unknown) => {
      setNote(`couldn't open System Settings — ${(err as Error).message ?? "unknown error"}`);
    });
  }, []);

  const profiles = useMemo(() => discovery?.profiles ?? [], [discovery]);
  // The default is DERIVED, not an effect: the first frame that lists profiles
  // already has every readable one ticked, so a click on that frame toggles a
  // real value instead of un-ticking a box that was drawn empty for one render.
  const picked = useMemo(
    () => selected ?? new Set(profiles.filter((p) => p.readable).map((p) => p.history_path)),
    [selected, profiles],
  );
  const toggleProfile = useCallback(
    (path: string, on: boolean) => {
      const next = new Set(picked);
      if (on) next.add(path);
      else next.delete(path);
      setSelected(next);
    },
    [picked],
  );
  const chosen = useMemo(
    () => profiles.filter((p) => p.readable && picked.has(p.history_path)),
    [profiles, picked],
  );
  const skipped = useMemo(
    () => profiles.filter((p) => !p.readable || !picked.has(p.history_path)),
    [profiles, picked],
  );
  const windows = useMemo(
    () => offeredWindows(discovery?.windows as string[] | undefined),
    [discovery],
  );
  const understandOptions = useMemo(
    () => windows.filter((w) => clampUnderstandWindow(w, indexWindow) === w),
    [windows, indexWindow],
  );
  // The pick, clamped to Index (CNS-03) and then to what the card can price —
  // an option the card cannot show a measured count for is not offered, and a
  // value not in the list would render a select with nothing selected.
  const effectiveUnderstand = useMemo(() => {
    if (understandWindow === null) return null;
    const clamped = clampUnderstandWindow(understandWindow, indexWindow);
    return understandOptions.includes(clamped) ? clamped : (understandOptions[understandOptions.length - 1] ?? null);
  }, [understandWindow, indexWindow, understandOptions]);

  const connect = useCallback(async () => {
    setBusy(true);
    setNote(null);
    const nowMs = Date.now();
    const counts: Record<string, number> = {};
    for (const p of chosen) counts[p.history_path] = p.windows[indexWindow]?.visits ?? 0;
    try {
      const r = await connectBrowserSource({
        profiles: chosen.map((p) => p.history_path),
        index_all: indexWindow === "all",
        index_from: windowFloorIso(indexWindow, nowMs),
        understand_from: effectiveUnderstand === null ? null : windowFloorIso(effectiveUnderstand, nowMs),
        counts,
        card_text: browserCardText(chosen, skipped, indexWindow, effectiveUnderstand),
      });
      // Move to the next screen NOW. The worker has the consent row and the
      // watcher is started; waiting for a fresh status read (an unbounded
      // COUNT that queues behind the import) is what made Connect look dead.
      if (r.progress) setProgress(r.progress);
      settled.current = false;
      lastWritten.current = -1;
      lastChainRefresh.current = Date.now();
      statusLoad.setData({
        source: "browser",
        connected: true,
        running: r.running,
        consent: r.consent,
        event_count: 0,
      });
      if (!r.started) setNote("Consent recorded, but the watcher didn't start; check again.");
    } catch (err) {
      // The honest reason, not "the worker refused or is unreachable" for both:
      // a 400 from the scoped-import check reads differently from a dead port.
      setNote(`couldn't connect — ${describeWorkerError(err)}`);
    } finally {
      setBusy(false);
    }
  }, [chosen, skipped, indexWindow, effectiveUnderstand, statusLoad]);

  // ---- Unknown is not empty: no verdict until the read has landed.
  if (statusLoad.unknown) {
    return <PanelSkeleton what="Browser" rows={4} />;
  }

  if (statusLoad.error !== null && status === null) {
    return (
      <ConnectCard
        glyph="◇"
        title="Browser"
        body="The worker isn't answering, so SuperTwin can't tell what it has captured from your browsing."
        actions={[
          { label: statusLoad.loading ? "retrying…" : "Retry", onClick: statusLoad.retry, disabled: statusLoad.loading },
        ]}
        note={statusLoad.error}
      />
    );
  }

  // ---- Not connected: the connect flow. Decided by consent, never by counts.
  if (status && !status.connected) {
    const readable = profiles.filter((p) => p.readable);
    // Consent is a PICK, so there is no Connect before the list to pick from.
    // A discovery that failed leaves Connect off rather than quietly falling
    // back to "every browser, all history" — the widening the card removed.
    const nothingChosen = chosen.length === 0;
    return (
      <ConnectCard
        glyph="◇"
        title="Connect your browsing"
        body={
          <>
            History and bookmarks from the browsers you tick below — read by copying each history file and opening the
            copy, never the browser's own. Incognito and private windows are never in these files. Disk only until you
            choose what the model may read.
          </>
        }
        actions={[
          {
            label: busy ? "Connecting…" : "Connect",
            onClick: () => void connect(),
            disabled: busy || nothingChosen,
          },
          { label: discoveryLoad.loading ? "checking…" : "Check again", onClick: discoveryLoad.retry },
        ]}
        note={
          note ??
          (discoveryLoad.error !== null
            ? `couldn't look for browsers — ${discoveryLoad.error}`
            : discovery
              ? readable.length === 0
                ? "No readable browser history found yet."
                : nothingChosen
                  ? "Tick at least one browser profile."
                  : `${n(chosen.length)} of ${n(readable.length)} profiles · ${n(visitsIn(chosen, indexWindow))} visits will be kept · ` +
                    `${effectiveUnderstand ? `${n(visitsIn(chosen, effectiveUnderstand))} go to the model` : "nothing goes to the model"}`
              : "Looking for browsers…")
        }
      >
        {discovery === null ? (
          <p className="empty" role="status">
            {discoveryLoad.error !== null ? "no browsers listed" : "reading each browser's history file…"}
          </p>
        ) : (
          <div className="connect-details" aria-label="browser profiles found">
            {profiles.length === 0 ? (
              <p className="empty">no browsers found</p>
            ) : (
              <ul className="connect-list">
                {profiles.map((p) => (
                  <ProfileRow
                    key={p.history_path}
                    profile={p}
                    checked={picked.has(p.history_path)}
                    onToggle={toggleProfile}
                    onOpenSettings={openSettings}
                  />
                ))}
              </ul>
            )}

            {readable.length > 0 && (
              <>
                <div className="connect-windows">
                  <label className="connect-field">
                    <span>keep searchable (index)</span>
                    <select
                      aria-label="index window"
                      value={indexWindow}
                      onChange={(e) => {
                        const next = e.target.value as ImportRange;
                        setIndexWindow(next);
                        setUnderstandWindow((u) => (u === null ? null : clampUnderstandWindow(u, next)));
                      }}
                    >
                      {windows.map((w) => (
                        <option key={w} value={w}>
                          {WINDOW_LABELS[w]} · {n(visitsIn(chosen, w))} visits
                        </option>
                      ))}
                    </select>
                    <span className="confirm-window-hint">kept on this Mac · costs disk</span>
                  </label>
                  <label className="connect-field">
                    <span>understand (read by the model)</span>
                    <select
                      aria-label="understand window"
                      value={effectiveUnderstand ?? "none"}
                      onChange={(e) =>
                        setUnderstandWindow(e.target.value === "none" ? null : (e.target.value as ImportRange))
                      }
                    >
                      {understandOptions.map((w) => (
                        <option key={w} value={w}>
                          {WINDOW_LABELS[w]} · {n(visitsIn(chosen, w))} visits
                        </option>
                      ))}
                      <option value="none">nothing goes to the model</option>
                    </select>
                    <span className="confirm-window-hint">sent to the model · costs money</span>
                  </label>
                </div>

                <p className="meta" aria-label="totals per window">
                  {CARD_WINDOWS.map((w) => `${w.label}: ${n(visitsIn(chosen, w.key))} visits`).join(" · ")}
                </p>
                <pre className="confirm-text" aria-label="card text">
                  {browserCardText(chosen, skipped, indexWindow, effectiveUnderstand)}
                </pre>
              </>
            )}

            {discovery.needs_full_disk_access && (
              <p className="connect-note" aria-label="full disk access">
                Safari needs Full Disk Access: System Settings › Privacy &amp; Security › Full Disk Access → SuperTwin.
                Then “Check again”.
              </p>
            )}
            <details className="connect-disclosure">
              <summary className="meta">What is read, and from where</summary>
              <p className="meta">{discovery.disclosure.text}</p>
              <ul className="meta">
                {profiles.map((p) => (
                  <li key={p.history_path}>
                    <code>{p.history_path}</code>
                    {p.bookmarks_path ? (
                      <>
                        {" · "}
                        <code>{p.bookmarks_path}</code>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </ConnectCard>
    );
  }

  const bookmarkedUrls = new Set((data?.bookmarks ?? []).map((b) => b.url));
  const importing = progress !== null && (!progress.known || !progress.first_pass_done || progress.reading);

  return (
    <section className="card" aria-label="Browser">
      <header className="inbox-bar">
        <h2>Browser</h2>
        <span className="inbox-bar-spacer" />
        <RefreshingHint active={dataLoad.refreshing} what="visits" />
      </header>

      {/* L6: the browser's OWN status — its consent window, its own coverage
          range, its own import backlog. The window used to be a bare line in
          the header with no coverage and no progress, and the progress lived
          in a cross-source chip in the app's top-right corner that mixed this
          source's backlog with WhatsApp's. */}
      <SourcePanelStatus
        source="browser"
        title="Browser"
        connection={status ? (status.running ? "connected · watching" : "connected") : null}
      />

      {/* L5: the first thing the panel shows after Connect — which profiles
          were chosen and where the history import has got to. It stays up
          while history is landing, and while there is nothing else to show
          (so "imported, but nothing in this window" is explained rather than
          left as a bare empty line); a panel with chains lets them speak. */}
      {progress !== null && (importing || (data?.chains.length ?? 0) === 0) && <ImportPanel progress={progress} />}
      {note && <p className="connect-note">{note}</p>}

      {(data?.domains_today.length ?? 0) > 0 && (
        <div className="row static" aria-label="today's domains">
          <span className="glyph">today</span>
          <span>
            {data!.domains_today
              .slice(0, 6)
              .map((d) => `${d.domain} ×${d.visits}`)
              .join(" · ")}
          </span>
        </div>
      )}

      {dataLoad.unknown ? (
        <PanelSkeleton what="your visits" rows={3} className="inline" />
      ) : (data?.chains.length ?? 0) === 0 ? (
        <p className="empty">
          {importing
            ? "visits appear here as they land"
            : (data?.event_count ?? 0) === 0
              ? "nothing imported from these browsers in the chosen window"
              : "no visit chains captured yet"}
        </p>
      ) : (
        data!.chains.map((c) => {
          const open = expanded.has(c.stream_key);
          const hops = foldHops(c.visits);
          const shown = open ? hops : hops.slice(0, HOPS_SHOWN);
          const hidden = hops.length - shown.length;
          const dwellMs = c.visits.reduce((a, v) => a + v.dwell_ms, 0);
          return (
            <div className="chain-card" key={c.stream_key} aria-label={`tab chain ${c.stream_key}`}>
              <div className="chain-head">
                <span className="glyph">⇥</span>
                <span className="chain-title">
                  {c.visits[0]?.title ?? host(c.visits[0]?.url ?? c.stream_key)}
                </span>
                {c.space_label && <span className="chip accent">→ {c.space_label}</span>}
                <span className="meta">
                  {c.started_at ? hhmm(c.started_at) : ""}
                  {dwellMs > 0 ? ` · ${minutesLabel(Math.max(1, Math.round(dwellMs / 60_000)))}` : ""}{" "}
                  · {c.visits.length} hops
                </span>
              </div>
              <ol className="chain-hops">
                {shown.map((h, i) => (
                  <li key={`${h.first_ts}-${i}`}>
                    <span className="hop-title">{h.visit.title ?? h.visit.url}</span>
                    {h.count > 1 && (
                      <span className="chip" aria-label={`${h.count} visits within 30 seconds`}>
                        ×{h.count} · {hhmm(h.first_ts)}–{hhmm(h.last_ts)}
                      </span>
                    )}
                    <span className="chip">{host(h.visit.url)}</span>
                    {bookmarkedUrls.has(h.visit.url) && <span className="chip">★ bookmarked</span>}
                    {dwellLabel(h.dwell_ms) && <span className="meta">{dwellLabel(h.dwell_ms)}</span>}
                  </li>
                ))}
              </ol>
              {(hidden > 0 || open) && (
                <button
                  type="button"
                  className="linklike"
                  aria-label={`${open ? "collapse" : "expand"} chain ${c.stream_key}`}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.stream_key)) next.delete(c.stream_key);
                      else next.add(c.stream_key);
                      return next;
                    })
                  }
                >
                  {open ? "show fewer hops" : `+${hidden} more hops`}
                </button>
              )}
            </div>
          );
        })
      )}

      {(data?.bookmarks.length ?? 0) > 0 && (
        <div className="bookmark-shelf" aria-label="bookmark shelf">
          <h3 className="shelf-title">★ shelf</h3>
          {data!.bookmarks.slice(0, 8).map((b) => (
            <div className="row static" key={`${b.ts}-${b.url}`}>
              <span className="glyph">★</span>
              <span>{b.title ?? b.url}</span>
              {b.folder && <span className="chip">{b.folder}</span>}
              <span className="meta">{host(b.url)}</span>
            </div>
          ))}
        </div>
      )}

      <p className="privacy-line">
        every visit is kept · tracking params are stripped from the searchable text only, the raw URL stays on the event
        · per-site lists in Settings › Capture
      </p>
      {dataLoad.error !== null && (
        <LoadFailure
          what="the browser library"
          error={dataLoad.error}
          onRetry={dataLoad.retry}
          retrying={dataLoad.loading}
        />
      )}
    </section>
  );
}

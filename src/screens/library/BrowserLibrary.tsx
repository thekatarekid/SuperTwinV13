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
//     disclosure. "Connect" grants consent (Index everything, Understand 30 d
//     by default — the confirm card refines) and starts the watcher.
//   * connected → the source's own data. A connected source with nothing
//     imported yet says so; it never falls back to the connect card.
//
// Chain hops fold at render: consecutive hops to one URL within 30 s show
// once with ×N (T6-3), mirroring the packer's collapse. Nothing is deleted.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import { LoadFailure } from "../../components/LoadState";
import {
  connectBrowserSource,
  describeWorkerError,
  fetchBrowserDiscovery,
  fetchBrowserSourceStatus,
  fetchLibraryBrowser,
  type BrowserChainVisit,
  type BrowserDiscovery,
  type BrowserProfileCounts,
  type BrowserSourceStatus,
  type LibraryBrowser,
} from "../../lib/api";
import { ConnectCard, hhmm, minutesLabel } from "./shared";

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

/** The windows the card shows side by side — enough to see the shape. */
const CARD_WINDOWS: Array<{ key: string; label: string }> = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "1y", label: "1 year" },
  { key: "all", label: "everything" },
];

function n(v: number | undefined): string {
  return (v ?? 0).toLocaleString("en-IN");
}

function profileName(p: BrowserProfileCounts): string {
  const who = p.label ?? (p.profile === "Default" || p.profile === "Safari" ? null : p.profile);
  return who ? `${p.browser_name} · ${who}` : p.browser_name;
}

function ProfileRow(props: { profile: BrowserProfileCounts }): JSX.Element {
  const p = props.profile;
  if (!p.readable) {
    return (
      <li className="row static" aria-label={`browser profile ${profileName(p)}`}>
        <span className="glyph">◇</span>
        <span>
          <strong>{profileName(p)}</strong>
          <span className="meta"> · {p.error?.code === "full-disk-access" ? "needs Full Disk Access" : "couldn't read"}</span>
          <br />
          <span className="meta">{p.error?.message}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="row static" aria-label={`browser profile ${profileName(p)}`}>
      <span className="glyph">◇</span>
      <span>
        <strong>{profileName(p)}</strong>
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

export function BrowserLibrary(): JSX.Element {
  const [data, setData] = useState<LibraryBrowser | null>(null);
  const [status, setStatus] = useState<BrowserSourceStatus | null>(null);
  const [discovery, setDiscovery] = useState<BrowserDiscovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Chains whose hop list the user asked to see in full. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    let st: BrowserSourceStatus | null = null;
    try {
      st = await fetchBrowserSourceStatus();
      setStatus(st);
      setError(null);
    } catch (err) {
      setStatus(null);
      setError(describeWorkerError(err));
      setLoading(false);
      return;
    }
    if (st && !st.connected) {
      try {
        setDiscovery(await fetchBrowserDiscovery());
      } catch {
        setDiscovery(null);
      }
      setLoading(false);
      return;
    }
    try {
      setData(await fetchLibraryBrowser());
    } catch (err) {
      setError(describeWorkerError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await connectBrowserSource({});
      setNote(r.started ? "Connected — reading your history now." : "Consent recorded, but the watcher didn't start; check again.");
      await refresh();
    } catch {
      setNote("couldn't connect — the worker refused or is unreachable");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (error && !status) {
    return (
      <ConnectCard
        glyph="◇"
        title="Browser"
        body="The worker isn't answering, so SuperTwin can't tell what it has captured from your browsing."
        actions={[{ label: loading ? "retrying…" : "Retry", onClick: () => void refresh(), disabled: loading }]}
        note={error}
      />
    );
  }

  // ---- Not connected: the connect flow. Decided by consent, never by counts.
  if (status && !status.connected) {
    const profiles = discovery?.profiles ?? [];
    const readable = profiles.filter((p) => p.readable);
    const totals = discovery?.totals ?? {};
    return (
      <ConnectCard
        glyph="◇"
        title="Connect your browsing"
        body={
          <>
            History and bookmarks of every browser on this Mac, every profile — read by copying each history file and
            opening the copy, never the browser's own. Incognito and private windows are never in these files. Disk only
            until you confirm what the model may read.
          </>
        }
        actions={[
          {
            label: busy ? "Connecting…" : "Connect",
            onClick: () => void connect(),
            disabled: busy || (discovery !== null && readable.length === 0),
          },
          { label: "Check again", onClick: () => void refresh() },
        ]}
        note={
          note ??
          (discovery
            ? readable.length === 0
              ? "No readable browser history found yet."
              : `Index everything · Understand the last 30 days — you can change both on the confirm card.`
            : "Looking for browsers…")
        }
      >
        {discovery && (
          <div className="connect-details" aria-label="browser profiles found">
            {profiles.length === 0 ? (
              <p className="empty">no browsers found</p>
            ) : (
              <ul className="connect-list">
                {profiles.map((p) => (
                  <ProfileRow key={p.history_path} profile={p} />
                ))}
              </ul>
            )}
            {readable.length > 0 && (
              <p className="meta" aria-label="totals per window">
                {CARD_WINDOWS.map((w) => `${w.label}: ${n(totals[w.key]?.visits)} visits`).join(" · ")}
              </p>
            )}
            {discovery.needs_full_disk_access && (
              <p className="connect-note" aria-label="full disk access">
                Safari needs Full Disk Access: System Settings › Privacy & Security › Full Disk Access → SuperTwin. Then
                “Check again”.
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
  const consent = status?.consent ?? null;

  return (
    <section className="card" aria-label="Browser">
      <header className="inbox-bar">
        <h2>Browser</h2>
        <span className="inbox-bar-spacer" />
        {status && (
          <span className="meta">
            {status.running ? "connected · watching" : "connected"}
            {consent ? ` · index ${consent.index_all ? "everything" : `from ${consent.index_from?.slice(0, 10)}`}` : ""}
            {consent
              ? ` · understand ${consent.understand_from ? `from ${consent.understand_from.slice(0, 10)}` : "off"}`
              : ""}
          </span>
        )}
      </header>

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

      {(data?.chains.length ?? 0) === 0 ? (
        <p className="empty">
          {(data?.event_count ?? 0) === 0 ? "connected — reading your history; visits appear here as they land" : "no visit chains captured yet"}
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
      {error && (
        <LoadFailure what="the browser library" error={error} onRetry={() => void refresh()} retrying={loading} />
      )}
    </section>
  );
}

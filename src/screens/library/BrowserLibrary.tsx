// ===========================================================================
// Library › Browser — visit chains as TAB CHAINS (spec §14.3.2, §12).
//
// The tab-chain stream keys already exist in the log (P0.8), so a chain is
// rendered as what it was: one tab's journey. Each chain card shows its
// entry point, every hop with its own dwell, the total time, the filing chip
// (→ the space the twin filed it under), and any bookmark that landed on one
// of its URLs. Today's domain counts sit on top; the bookmark shelf below.
//
// Not connected is the browser-profile connect flow, not an empty list.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import {
  browserImportChrome,
  fetchBrowserStatus,
  fetchLibraryBrowser,
  type BrowserStatus,
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

export function BrowserLibrary(): JSX.Element {
  const [data, setData] = useState<LibraryBrowser | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Chains whose hop list the user asked to see in full. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setData(await fetchLibraryBrowser());
      setError(null);
    } catch {
      setError("worker unreachable");
    }
    try {
      setStatus(await fetchBrowserStatus());
    } catch {
      setStatus(null); // no SuperTwin Browser staged in this build
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error && !data) {
    return (
      <ConnectCard
        glyph="◇"
        title="Browser"
        body="The worker isn't answering, so SuperTwin can't tell what it has captured from your browsing."
        note="worker unreachable"
      />
    );
  }

  const captured =
    (data?.event_count ?? 0) > 0 ||
    (data?.chains.length ?? 0) > 0 ||
    (data?.domains_today.length ?? 0) > 0;

  if (!captured) {
    return (
      <ConnectCard
        glyph="◇"
        title="Connect your browsing"
        body="SuperTwin browses in its own Chromium with its own profile. Import your Chrome history, bookmarks and logins once and the twin sees the same web you do — visit chains, dwell, and what you saved."
        actions={[
          {
            label: "Import from Chrome",
            onClick: () =>
              void browserImportChrome()
                .then(() => setNote("Chromium opened its import window — finish it there."))
                .catch(() => setNote("couldn't open the import window")),
            disabled: status ? !status.available : false,
          },
          { label: "Check again", onClick: () => void refresh() },
        ]}
        note={
          note ??
          (status && !status.available
            ? "The SuperTwin Browser isn't staged in this build, so there's nothing to import into yet."
            : "Chromium's own import runs it — SuperTwin never reads Chrome's encrypted stores itself.")
        }
      />
    );
  }

  const bookmarkedUrls = new Set((data?.bookmarks ?? []).map((b) => b.url));

  return (
    <section className="card" aria-label="Browser">
      <header className="inbox-bar">
        <h2>Browser</h2>
        <span className="inbox-bar-spacer" />
        {status && (
          <span className="meta">
            {status.running ? "browser running" : status.available ? "browser idle" : "browser not staged"}
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
        <p className="empty">no visit chains captured yet</p>
      ) : (
        data!.chains.map((c) => {
          const open = expanded.has(c.stream_key);
          const shown = open ? c.visits : c.visits.slice(0, HOPS_SHOWN);
          const hidden = c.visits.length - shown.length;
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
                {shown.map((v, i) => (
                  <li key={`${v.ts}-${i}`}>
                    <span className="hop-title">{v.title ?? v.url}</span>
                    <span className="chip">{host(v.url)}</span>
                    {bookmarkedUrls.has(v.url) && <span className="chip">★ bookmarked</span>}
                    {dwellLabel(v.dwell_ms) && <span className="meta">{dwellLabel(v.dwell_ms)}</span>}
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
        page text: captured from the page's own text (AX / fetched) · per-domain blocklist in
        Settings › Capture
      </p>
      {error && <p className="empty">{error}</p>}
    </section>
  );
}

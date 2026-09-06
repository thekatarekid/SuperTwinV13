// ===========================================================================
// The one loading / error / retry primitive the whole shell uses (V6 P1 W3).
//
// WHAT WAS BROKEN. 13.11.1 shipped with a worker that threw before it ever
// listened. Home said "worker unreachable" — correct — and Settings sat on
// `loading…` forever, because every panel was written as
//
//     useEffect(() => { void fetchX().then(setX).catch(() => {}); }, []);
//     if (!x) return <p className="empty">loading…</p>;
//
// A swallowed rejection and a null-means-pending render are indistinguishable
// from a slow request, so a dead worker looked like a busy one. Eleven panels
// and eight screens each had their own copy of that shape.
//
// THE CONTRACT. A failed read must resolve into a visible, honest, retryable
// state. Never an indefinite spinner. `useLoad` guarantees it: exactly one of
// { pending, data, error } is true at any moment, a rejection always lands in
// `error`, and `retry()` re-runs the same read. `LoadFallback` renders the
// pending/failed halves so the words and the Retry button exist once.
//
// HONESTY. "worker unreachable" is reserved for the case where `fetch` itself
// rejected — nothing is listening on the worker port. A route that answered
// 404, or a body that would not parse, says what actually failed instead of
// blaming a process that is plainly alive (lib/api.ts · describeWorkerError).
// ===========================================================================

// ===========================================================================
// UNKNOWN IS NOT EMPTY (13.12.x · L2) — the second half of the same contract.
//
// WHAT WAS BROKEN. Every Library sub-tab painted a verdict it had not earned.
// With `data === null` meaning both "no answer yet" and "the answer is
// nothing", each pane picked the second reading on its first frame: Browser
// said "connected — reading your history" before it had asked whether the
// browser was connected at all; Screen said "the screen watcher isn't running";
// WhatsApp put up the inbox shell of an account that might not be paired.
// Seconds later the real answer arrived and the screen changed under the user.
// Measured on the user's own worker while a WhatsApp import ran (better-sqlite3
// is synchronous, so every read queues behind the importer's writes):
// /api/library/browser 9.6 s, /api/library/screen 5.4 s, /api/library/storage
// 4.0 s, /api/sources/whatsapp/status 3.0 s. Four seconds of a confident lie,
// then a flip. That is exactly "default state, freeze, then the real state".
//
// THE CONTRACT, extended. `unknown` is its own phase — true until the read has
// produced either a value or an error. While it is true a pane paints a
// SKELETON and never a verdict. And the answer, once there is one, is kept in
// a module-level cache keyed per pane, so flipping back to a sub-tab repaints
// it in the same frame instead of asking a busy worker all over again:
//
//   * `cacheKey` seeds `data` synchronously on mount — a re-visit is instant;
//   * `freshFor` skips the request outright when that answer is still young
//     (a `retry()` always asks, so nothing gets stuck on a stale value);
//   * one request per key is in flight at a time — four sub-tab flips must not
//     stack four aggregate queries on a worker that is already struggling;
//   * a reply from an older request never overwrites a newer answer, for the
//     pane OR for the cache. Switch away and back, and the slow first reply
//     loses to the fast second one instead of clobbering it.
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { describeWorkerError, WORKER_UNREACHABLE } from "../lib/api";

export interface LoadState<T> {
  /** The loaded value, or null while pending / after a failure with no value. */
  data: T | null;
  /** An honest one-line description of the failure, or null. */
  error: string | null;
  /** True only while a request is genuinely in flight. */
  loading: boolean;
  /** Re-run the read. Safe to call from a click handler. */
  retry: () => void;
  /** Replace the value locally — for a panel whose save returns the new row. */
  setData: (v: T) => void;
  /**
   * Bumped by every `retry()`. A pane whose secondary, non-gating reads should
   * also be re-tried puts this in their effect's dependency list.
   */
  attempt: number;
  /**
   * NO ANSWER YET — which is not the same claim as "the answer is nothing".
   * While this is true the pane must paint a skeleton, never an empty state,
   * a default, or a "not connected" card: it does not know any of that yet.
   */
  unknown: boolean;
  /** A read is running over an answer we already have (cached, or earlier). */
  refreshing: boolean;
}

export interface LoadOptions {
  /**
   * Keep this read's answer under this key for the life of the window, so a
   * pane that is unmounted and re-mounted (a sub-tab flip) paints immediately.
   */
  cacheKey?: string;
  /**
   * Don't re-ask on mount when the cached answer is younger than this many ms.
   * `retry()` — including a poll tick — always asks regardless.
   */
  freshFor?: number;
}

/**
 * How long a pane's cached answer counts as fresh enough to re-paint without
 * asking again. Ten seconds is longer than a sub-tab flip and shorter than a
 * visit, so flipping WhatsApp → Screen → WhatsApp costs the worker nothing
 * while an actual return to the Library still re-reads.
 */
export const PANE_FRESH_MS = 10_000;

interface CacheEntry {
  value: unknown;
  at: number;
}

const CACHE = new Map<string, CacheEntry>();
/**
 * One request per key at a time; a second mount joins it instead of stacking.
 * The deps that produced it ride along, because joining a request built from a
 * different `deps` would answer the new question with the old one's read.
 */
const INFLIGHT = new Map<string, { p: Promise<unknown>; deps: unknown[] }>();

function sameDeps(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
/** Monotonic per key: a reply from an older issue is dropped, not applied. */
const ISSUE = new Map<string, number>();

/** Drop every cached pane answer. The tests call this between renders. */
export function resetLoadCache(): void {
  CACHE.clear();
  INFLIGHT.clear();
  ISSUE.clear();
}

/** What the cache holds for `key` right now, if anything. */
export function peekLoadCache<T>(key: string): T | undefined {
  const hit = CACHE.get(key);
  return hit ? (hit.value as T) : undefined;
}

/**
 * Run `load` on mount, on every change to `deps`, and on `retry()`.
 *
 * The loader is held in a ref so callers can pass an inline lambda without
 * re-firing on every render; `deps` is the explicit re-run key, exactly as the
 * hand-rolled `useCallback` + `useEffect` pairs it replaces did.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
  opts: LoadOptions = {},
): LoadState<T> {
  const key = opts.cacheKey ?? null;
  const freshFor = opts.freshFor ?? 0;
  const seed = key ? CACHE.get(key) : undefined;

  const [data, setData] = useState<T | null>(seed ? (seed.value as T) : null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fn = useRef(load);
  fn.current = load;

  // The seed above is read once, on the first render. A pane whose read is
  // keyed by something that changes (a day, an id) re-seeds here instead of
  // showing the previous key's answer under the new key's heading.
  const [seededKey, setSeededKey] = useState(key);
  if (key !== seededKey) {
    setSeededKey(key);
    const next = key ? CACHE.get(key) : undefined;
    setData(next ? (next.value as T) : null);
    setError(null);
    setLoading(true);
  }

  useEffect(() => {
    let alive = true;
    const fresh = key ? CACHE.get(key) : undefined;
    // A young cached answer IS the answer. Re-mounting a pane by flipping a
    // sub-tab is not a reason to make a busy worker run the aggregate again.
    if (fresh && nonce === 0 && freshFor > 0 && Date.now() - fresh.at < freshFor) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const issue = (key ? (ISSUE.get(key) ?? 0) : 0) + 1;
    if (key) ISSUE.set(key, issue);

    // The same read for this key is already on the wire — join it rather than
    // send a second. A poll tick, or a second pane mounting mid-request, must
    // not stack another aggregate query on a worker that is already behind.
    const open = key ? INFLIGHT.get(key) : undefined;
    const joined = open && sameDeps(open.deps, deps) ? (open.p as Promise<T>) : undefined;
    const p = joined ?? fn.current();
    if (key && !joined) {
      const entry = { p: p as Promise<unknown>, deps };
      INFLIGHT.set(key, entry);
      const clear = (): void => {
        if (INFLIGHT.get(key) === entry) INFLIGHT.delete(key);
      };
      void p.then(clear, clear);
    }

    p.then((v) => {
      // Out of order: a newer read for this key has already been issued, so
      // this reply is history. It must not touch the cache or the pane.
      if (key && ISSUE.get(key) !== issue) return;
      // The cache is written even when this pane is gone — that answer is the
      // whole point of coming back to the sub-tab and seeing it immediately.
      if (key) CACHE.set(key, { value: v, at: Date.now() });
      if (!alive) return;
      setData(v);
      setError(null);
    })
      .catch((err: unknown) => {
        // The whole point: a rejection becomes a rendered sentence, never a
        // spinner that outlives the request.
        if (key && ISSUE.get(key) !== issue) return;
        if (alive) setError(describeWorkerError(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `deps` is the caller's explicit re-run key, spread on purpose; `fn` is a
    // ref so an inline lambda does not re-fire the read on every render.
  }, [...deps, nonce, key]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const publish = useCallback(
    (v: T) => {
      if (key) CACHE.set(key, { value: v, at: Date.now() });
      setData(v);
    },
    [key],
  );
  return {
    data,
    error,
    loading,
    retry,
    setData: publish,
    attempt: nonce,
    unknown: data === null && error === null,
    refreshing: loading && data !== null,
  };
}

export interface CachedRead<T> {
  /** What this key already holds — pass it to `useState` as the initial value. */
  seed: T | null;
  /** Call before firing a read; hand the token back to `publish` / `accept`. */
  begin: () => number;
  /**
   * Cache an answer. Returns false — and writes nothing — when a newer read for
   * this key has been issued since `begin()`, so the slow first reply can never
   * overwrite the fast second one.
   */
  publish: (token: number, value: T) => boolean;
  /** Whether a token is still the current read (for the failure branch). */
  accept: (token: number) => boolean;
}

/**
 * `useLoad`'s cache and staleness guard, for a pane whose read is hand-rolled —
 * one that polls on its own cadence, or where two reads share one Retry. Same
 * map, same rules, so a pane can adopt the cache without giving up its loader.
 */
export function useCachedRead<T>(key: string): CachedRead<T> {
  return useMemo(
    () => ({
      seed: (CACHE.get(key)?.value as T | undefined) ?? null,
      begin: (): number => {
        const token = (ISSUE.get(key) ?? 0) + 1;
        ISSUE.set(key, token);
        return token;
      },
      publish: (token: number, value: T): boolean => {
        if (ISSUE.get(key) !== token) return false;
        CACHE.set(key, { value, at: Date.now() });
        return true;
      },
      accept: (token: number): boolean => ISSUE.get(key) === token,
    }),
    [key],
  );
}

/** The pending line. Same words the panels used before, in one place. */
export function Loading(): JSX.Element {
  return <p className="empty">loading…</p>;
}

/**
 * A failed read, with the retry. `what` names the thing that did not load
 * ("General settings", "the calendar") and is only used in the sentence.
 */
export function LoadFailure(props: {
  what: string;
  error: string;
  onRetry: () => void;
  /** True while the retry is in flight — the button says so and is disabled. */
  retrying?: boolean;
}): JSX.Element {
  const unreachable = props.error === WORKER_UNREACHABLE;
  return (
    <div className="load-error" role="alert">
      <p className="error">{unreachable ? WORKER_UNREACHABLE : `couldn't load ${props.what}`}</p>
      <p className="meta">
        {unreachable
          ? `SuperTwin's local worker isn't answering, so ${props.what} can't load. It may still be starting up, or it stopped.`
          : props.error}
      </p>
      <button type="button" className="btn" onClick={props.onRetry} disabled={props.retrying === true}>
        {props.retrying === true ? "retrying…" : "Retry"}
      </button>
    </div>
  );
}

/**
 * The early-return every panel makes while it has no value yet: the failure
 * with its retry if the read failed, otherwise the pending line.
 *
 *     const gate = useLoad(fetchSettingsGeneral);
 *     const s = gate.data;
 *     if (!s) return <LoadFallback state={gate} what="General settings" />;
 */
export function LoadFallback<T>(props: { state: LoadState<T>; what: string }): JSX.Element {
  const { error, loading, retry } = props.state;
  if (error !== null) {
    return <LoadFailure what={props.what} error={error} onRetry={retry} retrying={loading} />;
  }
  return <Loading />;
}

/**
 * True once `active` has been continuously true for `ms`. A wait short enough
 * to pass for a frame gets no extra furniture; a wait the user would call a
 * freeze gets a line that admits it.
 */
export function useSlow(active: boolean, ms = 900): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return slow;
}

/** The shimmer rows themselves — the shape of the answer, minus the answer. */
export function SkeletonRows(props: { rows?: number; wide?: boolean }): JSX.Element {
  const rows = props.rows ?? 4;
  return (
    <div className={`skeleton-rows${props.wide === true ? " wide" : ""}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-block skeleton-glyph" />
          <span className="skeleton-lines">
            <span className="skeleton-block skeleton-line-a" />
            <span className="skeleton-block skeleton-line-b" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * What a pane paints while `unknown` is true: the shape it is about to show,
 * an indeterminate bar that says work is happening, and — only once the wait
 * is long enough to feel like a freeze — one line saying so. Never the empty
 * state, never a default, never a "not connected" card.
 */
export function PanelSkeleton(props: {
  /** Names the thing being loaded: "WhatsApp", "the storage overview". */
  what: string;
  rows?: number;
  /** Extra class on the section, so a pane can keep its own card geometry. */
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const slow = useSlow(true);
  return (
    <section
      className={`card skeleton-card${props.className ? ` ${props.className}` : ""}`}
      aria-label={`loading ${props.what}`}
      aria-busy="true"
      role="status"
    >
      <div className="skeleton-head">
        <span className="meta">loading {props.what}…</span>
        <span className="skeleton-progress" role="progressbar" aria-label={`${props.what} progress`} />
      </div>
      {props.children ?? <SkeletonRows rows={props.rows} />}
      {slow && (
        <p className="meta skeleton-slow">
          still loading — the worker is busy (a large import holds the database while it writes)
        </p>
      )}
    </section>
  );
}

/**
 * The subtle hint over already-good data: this is the last answer, a newer one
 * is on its way. Silent until the refresh is slow enough to be worth saying.
 */
export function RefreshingHint(props: { active: boolean; what?: string }): JSX.Element | null {
  const slow = useSlow(props.active);
  if (!props.active || !slow) return null;
  return (
    <span className="refreshing-hint meta" role="status">
      refreshing{props.what ? ` ${props.what}` : ""}…
    </span>
  );
}

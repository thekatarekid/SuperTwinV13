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

import { useCallback, useEffect, useRef, useState } from "react";

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
}

/**
 * Run `load` on mount, on every change to `deps`, and on `retry()`.
 *
 * The loader is held in a ref so callers can pass an inline lambda without
 * re-firing on every render; `deps` is the explicit re-run key, exactly as the
 * hand-rolled `useCallback` + `useEffect` pairs it replaces did.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fn = useRef(load);
  fn.current = load;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn.current()
      .then((v) => {
        if (!alive) return;
        setData(v);
        setError(null);
      })
      .catch((err: unknown) => {
        // The whole point: a rejection becomes a rendered sentence, never a
        // spinner that outlives the request.
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
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, retry, setData, attempt: nonce };
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

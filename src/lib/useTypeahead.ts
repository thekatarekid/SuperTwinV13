// ===========================================================================
// useTypeahead — the bar's T0 type-ahead hook (build S2.7, Product_V6 §22
// rule 1: "type-ahead is free").
//
// Owns the three things a live-results box gets wrong when written inline:
//   * debounce   — one worker round trip per pause in typing, not per key;
//   * sequencing — the LATEST query wins; a slow older response never
//                  overwrites a newer one (monotonic sequence, not timing);
//   * emptiness  — an empty / whitespace query yields `null` immediately and
//                  cancels anything in flight.
// The worker measures its own `took_ms` and never reaches a model; the hook
// surfaces the result untouched so the bar can show the budget was kept.
// ===========================================================================

import { useEffect, useRef, useState } from "react";

import { barTypeahead, type TypeaheadView } from "./api";

export interface TypeaheadState {
  /** Latest result for the current text; null when the text is empty. */
  result: TypeaheadView | null;
  /** A request is debouncing or in flight. */
  pending: boolean;
  /** The last request failed (the previous result, if any, is kept). */
  error: string | null;
}

export interface TypeaheadHookOptions {
  /** Pause after the last keystroke before asking the worker. Default 40 ms. */
  debounceMs?: number;
  /** Per-group cap forwarded to the worker. */
  limit?: number;
  /** False disables the hook (bar locked, history view). Default true. */
  enabled?: boolean;
}

const IDLE: TypeaheadState = { result: null, pending: false, error: null };

export function useTypeahead(text: string, options: TypeaheadHookOptions = {}): TypeaheadState {
  const { debounceMs = 40, limit, enabled = true } = options;
  const [state, setState] = useState<TypeaheadState>(IDLE);
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    const q = text.trim();
    if (!enabled || q === "") {
      setState((s) => (s === IDLE ? s : IDLE));
      return;
    }
    setState((s) => (s.pending ? s : { ...s, pending: true }));
    const timer = setTimeout(() => {
      barTypeahead(q, limit)
        .then((result) => {
          if (seq.current === mySeq) setState({ result, pending: false, error: null });
        })
        .catch((err: unknown) => {
          if (seq.current === mySeq) {
            setState((s) => ({ ...s, pending: false, error: err instanceof Error ? err.message : String(err) }));
          }
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [text, enabled, debounceMs, limit]);

  return state;
}

// WhatsApp connection + onboarding state hook (docs/PHASE1_CONTRACT §6).
//
// Owns everything the Inbox onboarding + status chrome renders:
//   - the connection status snapshot (state, paired, paused, jid, lastError),
//   - the current QR pairing code (raw string; the UI encodes it to an image),
//   - the live backfill Progress,
//   - and the pair / import / extend / pause / logout actions.
//
// It talks to the worker exclusively through an injected `WorkerClient`
// (defaults to the real one) so tests can supply a mock — same pattern as
// useChat. On mount it fetches the status once, then subscribes to the SSE
// stream for live status/qr/progress/paired frames. If the stream drops it
// falls back to polling GET /api/whatsapp/status.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  workerClient as defaultClient,
  type AdapterStatus,
  type Progress,
  type Range,
  type SourceError,
  type SourceState,
  type StatusUpdate,
  type WorkerClient,
} from "./worker-client";

/**
 * High-level onboarding phase derived from status + progress.
 *
 * R5.1: there is NO blocking "importing" step anymore. The only full-screen
 * onboarding steps are QR and the range picker; once an import STARTS (or once
 * the worker reports importDone) we move straight to "done" (the Inbox) and the
 * import surfaces as a non-blocking banner there.
 */
export type OnboardingStep =
  | "loading" // fetching the first status
  | "qr" // not paired → show QR to scan
  | "range" // paired, no import started yet → pick a range
  | "done"; // paired + import started/finished → Inbox (banner shows progress)

const POLL_MS = 4000;

export interface UseWhatsapp {
  /** null until the first status resolves. */
  status: AdapterStatus | null;
  state: SourceState;
  paired: boolean;
  paused: boolean;
  /**
   * R2.1: true once the first backfill has completed (persisted server-side).
   * A missing value from the worker is treated as false. Drives skipping the
   * range picker on relaunch.
   */
  importDone: boolean;
  jid?: string;
  pushName?: string;
  /** Raw QR string to encode, or null when there is no active QR. */
  qr: string | null;
  progress: Progress | null;
  lastError: SourceError | null;
  /** Derived onboarding step for the flow UI. */
  step: OnboardingStep;
  /** true once the user has kicked off an import this session (drives step). */
  importStarted: boolean;
  /**
   * R5.1: true while a backfill/import is actively running (progress present and
   * not done). Drives the NON-BLOCKING Inbox progress banner. Clears the moment
   * `progress.done` (or `backfill_complete`) arrives.
   */
  importing: boolean;
  loading: boolean;

  pair(): Promise<void>;
  startImport(range: Range): Promise<void>;
  extend(range: Range): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  logout(): Promise<void>;
  /** R2.3: wipe imported data + persisted import state, keep the session. */
  reset(): Promise<void>;
  /**
   * R3.3: the honest "clean re-sync" = full RE-LINK. Wipes imported data +
   * import state AND unlinks WhatsApp, so the UI returns to the QR screen for a
   * fresh scan (WhatsApp then re-pushes full history). Unlike {@link reset},
   * this does NOT keep the session.
   */
  relink(): Promise<void>;
  refresh(): Promise<void>;
  /**
   * R2.2: subscribe to live-ingest nudges from the SSE stream. The Inbox uses
   * this to refetch the chat list (and the open chat) within ~1s of new
   * events persisting. Returns an unsubscribe function.
   */
  onIngest(cb: (channels: string[] | undefined) => void): () => void;
}

function deriveStep(
  status: AdapterStatus | null,
  progress: Progress | null,
  importStarted: boolean,
): OnboardingStep {
  if (!status) return "loading";
  if (!status.paired) return "qr";
  // Paired.
  //
  // R5.1 (bug 1): once an import has STARTED — either this session
  // (importStarted) or on a prior run (importDone persisted) — we go STRAIGHT to
  // the Inbox. The import (including the big FULL history-sync phase) surfaces as
  // a NON-BLOCKING banner there, never a full-screen modal. This is the fix for
  // the "stuck at 4% / modal re-opens for the FULL phase" bug: we must not show a
  // blocking import step at all once ingestion is under way.
  if (status.importDone) return "done";
  if (importStarted) return "done";
  // A live backfill reported by the worker (e.g. history-sync that began on the
  // daemon side without a UI-initiated import) also means "already importing" —
  // show the Inbox + banner, not the picker.
  if (progress && !progress.done) return "done";
  if (progress && progress.done) return "done";
  // Paired but never imported → let the user pick a range (the ONLY remaining
  // full-screen post-QR onboarding step).
  return "range";
}

export function useWhatsapp(client: WorkerClient = defaultClient): UseWhatsapp {
  const [status, setStatus] = useState<AdapterStatus | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [lastError, setLastError] = useState<SourceError | null>(null);
  const [importStarted, setImportStarted] = useState(false);
  const [loading, setLoading] = useState(true);

  const mountedRef = useRef(true);
  const unsubRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // R2.2: listeners for live-ingest nudges. Kept in a ref (stable identity) so
  // subscribing doesn't retrigger the once-only SSE effect below.
  const ingestListenersRef = useRef<Set<(channels: string[] | undefined) => void>>(
    new Set(),
  );
  // Bug 1: guard so auto-pairing fires at most once per mount (avoid duplicate
  // start_pairing calls across re-renders / status refetches).
  const autoPairedRef = useRef(false);

  const onIngest = useCallback(
    (cb: (channels: string[] | undefined) => void) => {
      ingestListenersRef.current.add(cb);
      return () => {
        ingestListenersRef.current.delete(cb);
      };
    },
    [],
  );

  const applyStatus = useCallback((s: AdapterStatus) => {
    if (!mountedRef.current) return;
    setStatus(s);
    if (s.progress) setProgress(s.progress);
    if (s.lastError) setLastError(s.lastError);
    // Once paired, drop any stale QR.
    if (s.paired) setQr(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await client.getWhatsappStatus();
      applyStatus(s);
    } catch {
      // Worker unreachable — leave prior status; surface via lastError so the UI
      // can show "worker unreachable" without crashing.
      if (mountedRef.current && status == null) {
        setLastError({
          code: "WORKER_UNREACHABLE",
          message: "Cannot reach the local worker.",
        });
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [client, applyStatus, status]);

  // ---- SSE frame handling -------------------------------------------------
  const onFrame = useCallback(
    (frame: StatusUpdate) => {
      if (!mountedRef.current) return;
      switch (frame.type) {
        case "status":
          setStatus((prev) => ({
            state: frame.state,
            paired: prev?.paired ?? false,
            paused: prev?.paused ?? false,
            jid: frame.jid ?? prev?.jid,
            pushName: frame.pushName ?? prev?.pushName,
            progress: prev?.progress,
            lastError: prev?.lastError,
            importDone: prev?.importDone,
            importRange: prev?.importRange,
          }));
          if (frame.state === "logged_out") {
            setStatus((prev) =>
              prev ? { ...prev, paired: false } : prev,
            );
            setQr(null);
            setProgress(null);
            setImportStarted(false);
            // R3.3: a relink/logout unlinks the device. Reset the auto-pair
            // guard so the bug-1 auto-pair effect re-fires and requests a fresh
            // QR (the daemon restarts into need_pairing after a relink).
            autoPairedRef.current = false;
          }
          break;
        case "qr":
          setQr(frame.code);
          break;
        case "paired":
          setStatus((prev) => ({
            state: prev?.state ?? "online",
            paired: true,
            paused: prev?.paused ?? false,
            jid: frame.jid,
            pushName: frame.pushName,
            progress: prev?.progress,
            lastError: prev?.lastError,
            importDone: prev?.importDone,
            importRange: prev?.importRange,
          }));
          setQr(null);
          break;
        case "progress":
          setProgress(frame.progress);
          break;
        case "backfill_complete":
          setProgress((prev) =>
            prev
              ? { ...prev, done: true }
              : {
                  phase: "backfill",
                  chatsDone: frame.chats,
                  chatsTotal: frame.chats,
                  messages: frame.messages,
                  done: true,
                  range: frame.range,
                },
          );
          // The first backfill completing means the range picker should not
          // reappear on relaunch. Reflect R2.1 optimistically; the next status
          // refetch confirms the persisted importDone.
          setStatus((prev) =>
            prev ? { ...prev, importDone: true, importRange: frame.range } : prev,
          );
          break;
        case "ingest":
          // R2.2 (bugs 2 & 3): new events persisted — nudge subscribers so the
          // chat list + open chat refetch. The frame's mere presence is the
          // signal; `channels` (if present) lets a listener scope its refetch.
          for (const cb of ingestListenersRef.current) cb(frame.channels);
          break;
        case "error":
          setLastError({ code: frame.code, message: frame.message });
          break;
      }
    },
    [],
  );

  // ---- Polling fallback ---------------------------------------------------
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void refresh();
    }, POLL_MS);
  }, [refresh]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // ---- Subscription lifecycle ---------------------------------------------
  const subscribe = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = client.streamWhatsapp(onFrame, () => {
      // Stream dropped/ended → poll and try to re-subscribe after a beat.
      if (!mountedRef.current) return;
      startPolling();
    });
  }, [client, onFrame, startPolling]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    subscribe();
    return () => {
      mountedRef.current = false;
      unsubRef.current?.();
      unsubRef.current = null;
      stopPolling();
    };
    // Intentionally run once: client/onFrame are stable for a given client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Actions ------------------------------------------------------------
  const pair = useCallback(async () => {
    setLastError(null);
    try {
      await client.pairWhatsapp();
    } catch (err) {
      setLastError({
        code: "PAIR_FAILED",
        message: err instanceof Error ? err.message : "Failed to start pairing.",
      });
    }
  }, [client]);

  const startImport = useCallback(
    async (range: Range) => {
      setLastError(null);
      setImportStarted(true);
      setProgress({
        phase: "backfill",
        chatsDone: 0,
        chatsTotal: 0,
        messages: 0,
        done: false,
        range,
      });
      try {
        await client.importWhatsapp(range);
      } catch (err) {
        setImportStarted(false);
        setLastError({
          code: "IMPORT_FAILED",
          message: err instanceof Error ? err.message : "Failed to start import.",
        });
      }
    },
    [client],
  );

  const extend = useCallback(
    async (range: Range) => {
      setLastError(null);
      try {
        await client.extendWhatsapp(range);
      } catch (err) {
        setLastError({
          code: "EXTEND_FAILED",
          message: err instanceof Error ? err.message : "Failed to extend range.",
        });
      }
    },
    [client],
  );

  const setPaused = useCallback(
    async (paused: boolean) => {
      setLastError(null);
      // Optimistic — the stream/poll will confirm.
      setStatus((prev) => (prev ? { ...prev, paused } : prev));
      try {
        await client.pauseWhatsapp(paused);
      } catch (err) {
        setStatus((prev) => (prev ? { ...prev, paused: !paused } : prev));
        setLastError({
          code: "PAUSE_FAILED",
          message: err instanceof Error ? err.message : "Failed to toggle kill-switch.",
        });
      }
    },
    [client],
  );

  const logout = useCallback(async () => {
    setLastError(null);
    try {
      await client.logoutWhatsapp();
      setStatus((prev) => (prev ? { ...prev, paired: false } : prev));
      setQr(null);
      setProgress(null);
      setImportStarted(false);
    } catch (err) {
      setLastError({
        code: "LOGOUT_FAILED",
        message: err instanceof Error ? err.message : "Failed to log out.",
      });
    }
  }, [client]);

  const reset = useCallback(async () => {
    setLastError(null);
    try {
      await client.resetWhatsapp();
      // Locally drop imported state so the UI returns to the range picker
      // immediately (paired stays true — the session is kept). The next status
      // refetch confirms importDone:false server-side.
      setStatus((prev) =>
        prev
          ? { ...prev, importDone: false, importRange: undefined, progress: undefined }
          : prev,
      );
      setProgress(null);
      setImportStarted(false);
    } catch (err) {
      setLastError({
        code: "RESET_FAILED",
        message: err instanceof Error ? err.message : "Failed to reset WhatsApp data.",
      });
      throw err instanceof Error ? err : new Error("reset failed");
    }
  }, [client]);

  const relink = useCallback(async () => {
    setLastError(null);
    try {
      await client.relinkWhatsapp();
      // Optimistically drop the link + imported state so the UI returns to the
      // QR onboarding immediately (paired → false, importDone → false). The
      // daemon then restarts into need_pairing → the auto-pair effect requests
      // a fresh QR. Reset the auto-pair guard so it re-fires (also handled on
      // the logged_out SSE frame; done here too in case the frame is missed).
      autoPairedRef.current = false;
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              paired: false,
              state: "logged_out",
              importDone: false,
              importRange: undefined,
              progress: undefined,
            }
          : prev,
      );
      setQr(null);
      setProgress(null);
      setImportStarted(false);
    } catch (err) {
      // Worker lag / 404 (endpoint not yet live): fail gracefully with a
      // visible error rather than a silent no-op or a crash.
      setLastError({
        code: "RELINK_FAILED",
        message:
          err instanceof Error ? err.message : "Failed to re-link WhatsApp.",
      });
      throw err instanceof Error ? err : new Error("relink failed");
    }
  }, [client]);

  // ---- Auto-pair (bug 1) --------------------------------------------------
  // When the user lands on the Inbox and we've confirmed they are NOT paired,
  // kick off pairing automatically (once) so the daemon starts emitting QR
  // frames — no manual "generate code" click. Guarded by autoPairedRef against
  // duplicate calls across re-renders. Resets if the user logs out (unpairs).
  useEffect(() => {
    if (loading || !status) return;
    if (status.paired) {
      // Paired again → allow a fresh auto-pair if they later log out.
      autoPairedRef.current = false;
      return;
    }
    if (autoPairedRef.current) return;
    autoPairedRef.current = true;
    void pair();
  }, [loading, status, pair]);

  const state: SourceState = status?.state ?? "starting";
  const paired = status?.paired ?? false;
  const paused = status?.paused ?? false;
  const importDone = status?.importDone ?? false;
  const pushName = status?.pushName;
  const jid = status?.jid;
  const step = deriveStep(status, progress, importStarted);
  // R5.1: the banner shows whenever an import is under way. That is true when we
  // have live progress that hasn't finished, OR the user just kicked off an
  // import this session and no completed progress has arrived yet (so the banner
  // appears immediately on the Inbox even before the first `progress` frame).
  const importing =
    (!!progress && !progress.done) || (importStarted && !(progress && progress.done));

  return useMemo(
    () => ({
      status,
      state,
      paired,
      paused,
      importDone,
      jid,
      pushName,
      qr,
      progress,
      lastError,
      step,
      importStarted,
      importing,
      loading,
      pair,
      startImport,
      extend,
      setPaused,
      logout,
      reset,
      relink,
      refresh,
      onIngest,
    }),
    [
      status,
      state,
      paired,
      paused,
      importDone,
      jid,
      pushName,
      qr,
      progress,
      lastError,
      step,
      importStarted,
      importing,
      loading,
      pair,
      startImport,
      extend,
      setPaused,
      logout,
      reset,
      relink,
      refresh,
      onIngest,
    ],
  );
}

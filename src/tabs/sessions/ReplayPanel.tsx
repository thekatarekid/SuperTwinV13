// [CODE] Replay and the per-stream segmentation override editor — arch §14.2.
//
//   REPLAY stream "Pranjali" with G=4h  →  diff: 3 sessions become 5
//      [ apply new params ][ discard ]
//
// The rule this component exists to enforce: A REPLAY DIFFS, IT DOES NOT APPLY.
// `replaySegmentation` is a dry run against candidate params and writes
// nothing; `applySegmentation` is a second, separate call that only a human
// click can reach, and it is only reachable once a diff is on screen. Re-cutting
// a stream rewrites session ids, hashes and every episode built on them, so the
// gap between "show me" and "do it" is the whole feature.
//
// The override editor writes the candidate params as the stream's standing
// policy — a different write from applying a re-cut, and offered separately.

import { useEffect, useState } from "react";

import { explainBoundary } from "./boundary";
import {
  USER_ACTOR,
  type MutationReceipt,
  type ReplayDiff,
  type SegmentationParams,
  type StreamSegmentation,
  type SurfacesClient,
} from "../../lib/surfaces-client";

const MINUTE = 60_000;

export interface ReplayPanelProps {
  client: SurfacesClient;
  streamId: string;
  onReceipt(receipt: MutationReceipt): void;
  onClose(): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function MinutesField({
  id,
  label,
  ms,
  onChange,
}: {
  id: string;
  label: string;
  ms: number;
  onChange(ms: number): void;
}) {
  return (
    <label className="seg-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        min={0}
        value={Number.isFinite(ms) ? Math.round(ms / MINUTE) : 0}
        onChange={(e) => onChange(Number(e.target.value) * MINUTE)}
      />
      <span className="seg-field__unit">min</span>
    </label>
  );
}

function CountField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <label className="seg-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        min={0}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function ReplayPanel({ client, streamId, onReceipt, onClose }: ReplayPanelProps) {
  const [segmentation, setSegmentation] = useState<StreamSegmentation | null>(null);
  const [params, setParams] = useState<SegmentationParams | null>(null);
  const [diff, setDiff] = useState<ReplayDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setSegmentation(null);
    setParams(null);
    setDiff(null);
    client
      .getSegmentation(streamId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setSegmentation(next);
        setParams(next.effective);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(message(err));
      });
    return () => controller.abort();
  }, [client, streamId]);

  const set = (patch: Partial<SegmentationParams>) =>
    setParams((prev) => {
      if (!prev) return prev;
      // Any edit invalidates the diff on screen: a diff must never be applied
      // with params other than the ones it was computed from.
      setDiff(null);
      return { ...prev, ...patch };
    });

  const replay = async () => {
    if (!params) return;
    setBusy(true);
    setError(null);
    try {
      setDiff(await client.replaySegmentation({ streamId, params }));
    } catch (err) {
      setError(`replay failed — ${message(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!diff) return;
    setBusy(true);
    setError(null);
    try {
      onReceipt(
        await client.applySegmentation({ streamId, params: diff.params, actor: USER_ACTOR }),
      );
      setDiff(null);
    } catch (err) {
      setError(`apply failed — ${message(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveOverride = async () => {
    if (!params) return;
    setBusy(true);
    setError(null);
    try {
      onReceipt(
        await client.saveSegmentation({ streamId, overrides: params, actor: USER_ACTOR }),
      );
    } catch (err) {
      setError(`save failed — ${message(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="replay" aria-label="Replay stream">
      <header className="replay__head">
        <h2 className="replay__title">
          Replay stream “{segmentation?.streamLabel ?? streamId}”
        </h2>
        <button type="button" className="replay__close" onClick={onClose}>
          close
        </button>
      </header>

      {error && (
        <p className="surface__error" role="alert">
          {error}
        </p>
      )}

      {!params ? (
        <p className="surface__empty">loading segmentation…</p>
      ) : (
        <>
          <p className="replay__kind">
            policy kind: {segmentation?.kind ?? "unknown"} · editing this stream’s override
          </p>

          <div className="seg-editor">
            <MinutesField id="seg-gap" label="gap (G)" ms={params.gapMs} onChange={(gapMs) => set({ gapMs })} />
            <MinutesField
              id="seg-shift"
              label="min gap for participant shift"
              ms={params.shiftMinGapMs}
              onChange={(shiftMinGapMs) => set({ shiftMinGapMs })}
            />
            <MinutesField
              id="seg-debounce"
              label="debounce"
              ms={params.debounceMs}
              onChange={(debounceMs) => set({ debounceMs })}
            />
            <MinutesField
              id="seg-ceiling"
              label="ceiling"
              ms={params.ceilingMs}
              onChange={(ceilingMs) => set({ ceilingMs })}
            />
            <CountField
              id="seg-events"
              label="size cap (events)"
              value={params.sizeCapEvents}
              onChange={(sizeCapEvents) => set({ sizeCapEvents })}
            />
            <CountField
              id="seg-chars"
              label="size cap (chars)"
              value={params.sizeCapChars}
              onChange={(sizeCapChars) => set({ sizeCapChars })}
            />
            <label className="seg-field seg-field--check" htmlFor="seg-day">
              <input
                id="seg-day"
                type="checkbox"
                checked={params.dayBoundary}
                onChange={(e) => set({ dayBoundary: e.target.checked })}
              />
              <span>cut at local midnight</span>
            </label>
          </div>

          <p className="replay__actions">
            <button type="button" disabled={busy} onClick={() => void replay()}>
              replay stream
            </button>
            <button type="button" disabled={busy} onClick={() => void saveOverride()}>
              save override
            </button>
          </p>

          {diff && (
            <div className="replay__diff" role="region" aria-label="Replay diff">
              <p className="replay__summary">
                diff: {diff.sessionsBefore} sessions become {diff.sessionsAfter} —{" "}
                <strong>nothing has been applied</strong>
              </p>
              <ol className="replay__rows">
                {diff.rows.map((row, index) => (
                  <li
                    key={`${row.change}-${row.startedAt ?? index}`}
                    className={`replay__row replay__row--${row.change}`}
                  >
                    <span className="replay__change">
                      {row.change === "added" ? "+" : row.change === "removed" ? "−" : "="}
                    </span>
                    <span className="replay__span">
                      {row.startedAt ?? "?"} → {row.endedAt ?? "?"} · {row.eventCount} events
                    </span>
                    <span className="replay__why">
                      START: {explainBoundary(row.boundaryStart)}
                      {row.boundaryEnd ? ` · END: ${explainBoundary(row.boundaryEnd)}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="replay__confirm">
                <button type="button" disabled={busy} onClick={() => void apply()}>
                  apply new params
                </button>
                <button type="button" disabled={busy} onClick={() => setDiff(null)}>
                  discard
                </button>
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

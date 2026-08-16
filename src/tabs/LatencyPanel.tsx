// Latency panel (build item 4.2, arch §9.5.3 rule 4) — the minimal ops read
// over GET /api/latency, mounted under Settings → Recent runs until item 4.4's
// fuller ops surface takes it over.
//
// Three blocks, all straight from the persisted marks — nothing recomputed
// client-side beyond formatting:
//   * the global-acceptance milestones, each graded against the budget stored
//     with its mark (first claim ≤ 30 s, spaces/tasks ≤ 120 s, silent gap
//     ≤ 90 s, steady-state calls ≤ 12);
//   * the live ledger's model-call count over the trailing day;
//   * per (model, call type): worst TTFT, worst total, slowest tokens/sec —
//     worst, never mean, so one breach reads as a breach.

import { useCallback, useEffect, useRef, useState } from "react";

import { getLatency, type LatencyInfo } from "../lib/worker-client";

/** Milestone names → the words the panel shows. */
const MILESTONE_LABELS: Record<string, string> = {
  first_claim: "First claim",
  spaces_tasks: "Spaces and tasks",
  silent_gap: "Longest silent gap",
  steady_calls: "Steady-state calls/day",
  live_visibility: "Live visibility",
};

function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtValue(value: number, unit: "ms" | "calls"): string {
  return unit === "calls" ? `${value.toLocaleString()} calls` : fmtMs(value);
}

export interface LatencyPanelProps {
  /** Injectable fetcher; defaults to the worker client's GET /api/latency. */
  getLatencyFn?: typeof getLatency;
}

export function LatencyPanel({ getLatencyFn = getLatency }: LatencyPanelProps) {
  const [info, setInfo] = useState<LatencyInfo | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await getLatencyFn(signal);
        if (!mounted.current) return;
        setInfo(next);
        setOffline(false);
      } catch {
        // Worker offline: keep whatever was last shown, dash the rest.
        if (mounted.current) setOffline(true);
      }
    },
    [getLatencyFn],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [refresh]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  return (
    <div className="settings__latency" data-testid="latency-panel">
      <div className="settings__section-head">
        <h3 className="settings__section-title">Latency</h3>
        <button
          type="button"
          className="wa-btn wa-btn--ghost"
          onClick={() => void onRefresh()}
          disabled={refreshing}
          data-testid="latency-refresh"
        >
          {refreshing ? "Reloading…" : "Reload"}
        </button>
      </div>
      <p className="settings__section-desc">
        Measured, never asserted: worst-case TTFT and streaming rate per model
        per call type, and the shipped budgets each measurement is graded
        against.
      </p>

      {offline && info === null ? (
        <p className="settings__note">Worker offline — no latency data.</p>
      ) : info === null ? (
        <p className="settings__note">Loading…</p>
      ) : (
        <>
          {info.milestones.length === 0 ? (
            <p className="settings__note" data-testid="latency-no-milestones">
              No milestones measured yet — budgets: first claim{" "}
              {fmtMs(info.budgets.firstClaimMs)}, spaces and tasks{" "}
              {fmtMs(info.budgets.spacesTasksMs)}, silent gap{" "}
              {fmtMs(info.budgets.silentGapMs)}, steady-state{" "}
              {info.budgets.steadyCallsPerDay} calls/day.
            </p>
          ) : (
            <ul className="settings__latency-milestones" data-testid="latency-milestones">
              {info.milestones.map((m) => (
                <li key={m.name}>
                  <span
                    className={`settings__run-status settings__run-status--${m.met ? "ok" : "error"}`}
                    data-testid={`milestone-${m.name}`}
                  >
                    {m.met ? "within budget" : "BREACH"}
                  </span>{" "}
                  {MILESTONE_LABELS[m.name] ?? m.name}: {fmtValue(m.value, m.unit)} against{" "}
                  {fmtValue(m.budget, m.unit)}
                </li>
              ))}
            </ul>
          )}

          <p className="settings__note" data-testid="latency-steady">
            Live model calls, last 24 h: {info.steady.callsLast24h} of{" "}
            {info.steady.budget} budgeted{info.steady.met ? "" : " — OVER BUDGET"}
          </p>

          {info.calls.length === 0 ? (
            <p className="settings__note">No calls recorded yet.</p>
          ) : (
            <div className="settings__runs" role="region" aria-label="Per-call latency">
              <table className="settings__runs-table" data-testid="latency-calls">
                <thead>
                  <tr>
                    <th>Call</th>
                    <th>Model</th>
                    <th className="settings__runs-num">Calls</th>
                    <th className="settings__runs-num">Worst TTFT</th>
                    <th className="settings__runs-num">Worst total</th>
                    <th className="settings__runs-num">Slowest tok/s</th>
                  </tr>
                </thead>
                <tbody>
                  {info.calls.map((c) => (
                    <tr key={`${c.model}|${c.callType}`}>
                      <td>{c.callType}</td>
                      <td>{c.model || "—"}</td>
                      <td className="settings__runs-num">{c.calls.toLocaleString()}</td>
                      <td className="settings__runs-num">{fmtMs(c.worstTtftMs)}</td>
                      <td className="settings__runs-num">{fmtMs(c.worstTotalMs)}</td>
                      <td className="settings__runs-num">
                        {c.minTokensPerSecond === null ? "—" : c.minTokensPerSecond.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Settings › AI Connector (Product_V6 §9, §25; V6 P1 S5.6).
//
// One door ships in P1 — the Claude Code CLI, running on your own
// subscription. The other three are listed anyway, and each says which phase
// it arrives in rather than sitting there greyed out with no explanation: a
// door you cannot open is only honest if it tells you why.
//
// The ceilings are the ones the worker ENFORCES (providers/budget.ts throws
// before the model is called), read back from it — not a second copy typed
// into this pane that could drift from the real gate. They are shown, not
// edited: raising a spend ceiling from a settings pane is exactly the kind of
// one-click regret P1 does not offer.
//
// "Stop all model activity" lives in General and is mirrored here because §25
// lists it under the connector. Both switches are the same latch.
// ===========================================================================

import { useState } from "react";

import { LoadFallback, useLoad } from "../../components/LoadState";
import {
  describeWorkerError,
  fetchSettingsConnector,
  saveSettingsConnector,
  type ConnectorSettings,
} from "../../lib/api";
import { rowStyle, SaveError } from "./shared";

function phaseNote(status: string): string {
  if (status === "live") return "in use";
  if (status === "local-only") return "on device";
  return "arrives in P3";
}

export function ConnectorPanel(): JSX.Element {
  const gate = useLoad<ConnectorSettings>(fetchSettingsConnector);
  const s = gate.data;
  const setS = gate.setData;
  const [saveError, setSaveError] = useState<string | null>(null);
  if (!s) return <LoadFallback state={gate} what="AI Connector settings" />;

  const move = (door: string, by: number): void => {
    const order = [...s.fallback_order];
    const i = order.indexOf(door);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i]!, order[j]!] = [order[j]!, order[i]!];
    setSaveError(null);
    void saveSettingsConnector({ fallback_order: order })
      .then(setS)
      .catch((err: unknown) => setSaveError(`the fallback order was not saved — ${describeWorkerError(err)}`));
  };

  return (
    <div>
      <h2>AI Connector</h2>
      <SaveError error={saveError} onDismiss={() => setSaveError(null)} />
      <p className="meta">
        One door in P1: your own Claude Code CLI. Prompts go out on stdin, JSON comes back, every
        call is metered and traced. No key of ours, no copy of your data anywhere but this Mac.
      </p>

      <h3>Doors</h3>
      {s.doors.map((d) => (
        <div key={d.door} style={rowStyle}>
          <span>
            {d.label}
            {d.connected && <span className="meta"> · connected</span>}
          </span>
          <span className="meta">
            {phaseNote(d.status)}
            {d.detail ? ` · ${d.detail}` : ""}
          </span>
        </div>
      ))}

      <h3>Fallback order</h3>
      <p className="meta">
        Which door is tried first when one is unavailable. Only doors that exist in this build can
        be ordered.
      </p>
      {s.fallback_order.map((door, i) => (
        <div key={door} style={rowStyle}>
          <span>
            {i + 1}. {door}
          </span>
          <span>
            <button className="linklike" aria-label={`move ${door} up`} disabled={i === 0} onClick={() => move(door, -1)}>
              ↑
            </button>{" "}
            <button
              className="linklike"
              aria-label={`move ${door} down`}
              disabled={i === s.fallback_order.length - 1}
              onClick={() => move(door, 1)}
            >
              ↓
            </button>
          </span>
        </div>
      ))}
      {(s.refused ?? []).length > 0 && (
        <p className="meta" role="status">
          not saved: {(s.refused ?? []).join(" · ")}
        </p>
      )}

      <h3>Spend ceilings</h3>
      <p className="meta">
        Enforced before a call is made, not after it is billed. A breach pauses background work and
        asks; the bar keeps working. The latch survives a restart.
      </p>
      <div style={rowStyle}>
        <span>Per call</span>
        <span className="meta">${s.ceilings.usd_per_call}</span>
      </div>
      <div style={rowStyle}>
        <span>Per hour</span>
        <span className="meta">
          ${s.ceilings.usd_per_hour} · {s.ceilings.calls_per_hour} calls
        </span>
      </div>
      <div style={rowStyle}>
        <span>Per day</span>
        <span className="meta">
          ${s.ceilings.usd_per_day} · {s.ceilings.calls_per_day} calls
        </span>
      </div>
      <p className="meta" role="status">
        {s.stop_all
          ? "All model activity is STOPPED. Nothing new will spawn until you release it in General."
          : "Model activity is running. General › Stop all model activity halts it."}
      </p>
    </div>
  );
}

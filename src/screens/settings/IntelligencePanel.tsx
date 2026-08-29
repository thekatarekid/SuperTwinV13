// ===========================================================================
// Settings › Intelligence — model per V13 step (default Haiku everywhere, the
// recommendation shown beside each picker and applied only by choice), the
// per-step on/off and 7d cost, and the embedding-model registry.
//
// Moved out of the monolithic Settings.tsx unchanged.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import {
  fetchEmbeddingModels,
  fetchSettingsIntelligence,
  saveIntelligenceStep,
  type EmbeddingModelRow,
  type IntelligenceSettings,
} from "../../lib/api";
import { mb, rowStyle } from "./shared";

export function IntelligencePanel(): JSX.Element {
  const [s, setS] = useState<IntelligenceSettings | null>(null);
  const [embed, setEmbed] = useState<{ active: string; models: EmbeddingModelRow[] } | null>(null);

  const refresh = useCallback(async () => {
    setS(await fetchSettingsIntelligence());
    try {
      setEmbed(await fetchEmbeddingModels());
    } catch {
      setEmbed(null);
    }
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  if (!s) return <p className="empty">loading…</p>;
  const groups = [...new Set(s.steps.map((x) => x.group))];
  return (
    <div>
      <h2>Intelligence — model per step</h2>
      <p className="meta">default: Haiku everywhere · rec = advised, applied only by your choice</p>
      {groups.map((g) => (
        <div key={g}>
          <h3>{g}</h3>
          {s.steps
            .filter((x) => x.group === g)
            .map((x) => (
              <div key={x.key} style={rowStyle}>
                <span>{x.label}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <select
                    aria-label={`${x.label} model`}
                    value={x.selected}
                    onChange={(e) =>
                      void saveIntelligenceStep({ step: x.key, model: e.target.value }).then(refresh)
                    }
                  >
                    {s.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <span className="meta">rec: {x.recommended}</span>
                  <span className="meta">
                    {x.calls_7d > 0 ? `$${x.cost_7d_usd.toFixed(2)} / 7d` : "—"}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`${x.label} enabled`}
                    checked={x.enabled}
                    onChange={(e) =>
                      void saveIntelligenceStep({ step: x.key, enabled: e.target.checked }).then(
                        refresh,
                      )
                    }
                  />
                </span>
              </div>
            ))}
        </div>
      ))}

      <h3>Retrieval — embedding model</h3>
      {embed ? (
        embed.models.map((m) => (
          <div key={m.id} style={rowStyle}>
            <span>
              {m.label} · {m.dim}d {m.active && <span className="chip accent">active</span>}{" "}
              {m.recommended && <span className="chip">recommended</span>}
            </span>
            <span className="meta">
              {m.present ? `${m.indexed} indexed` : `${mb(m.bytes)} download`}
            </span>
          </div>
        ))
      ) : (
        <p className="meta">registry unavailable</p>
      )}
      <p className="meta">swapping re-embeds in the background (§15 T3); the old index serves until the new one is complete</p>
      <p className="meta">⚠ a model change runs the golden set first; ships only if it doesn't regress (§18)</p>
    </div>
  );
}

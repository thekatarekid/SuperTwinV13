// ===========================================================================
// Settings › Retrieval (Product_V6 §25; V6 P1 S5.6).
//
// P1 ships T0 hybrid plus the T1 route-and-plan the bar uses, and 2-hop graph
// walks. The T2 agentic budgets exist in the worker and are stored — they are
// deliberately NOT rendered here, because a control for a tier that does not
// run is a promise the build cannot keep. They arrive with T2 in P2.
//
// The three numbers that are here are the ones that change what a search
// COSTS: how many rows an exhaustive scan may read, how far a graph walk may
// hop, and how wide it may fan out at each hop. Their defaults come from the
// retrieval module itself, so this pane cannot quietly disagree with the walk.
//
// Hubs are the exclusion list: an entity so connected that walking through it
// reaches everything and means nothing. `self` can never be removed — the walk
// through you is always noise — and the worker refuses that rather than the UI
// pretending to offer it.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import {
  fetchSettingsRetrieval,
  saveSettingsRetrieval,
  type RetrievalPatch,
  type RetrievalSettings,
} from "../../lib/api";
import { rowStyle, Toggle } from "./shared";

export function RetrievalPanel(): JSX.Element {
  const [s, setS] = useState<RetrievalSettings | null>(null);
  const [hub, setHub] = useState("");
  const refresh = useCallback(async () => {
    setS(await fetchSettingsRetrieval());
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  if (!s) return <p className="empty">loading…</p>;
  const save = async (patch: RetrievalPatch): Promise<void> => {
    setS(await saveSettingsRetrieval(patch));
  };

  return (
    <div>
      <h2>Retrieval</h2>
      <Toggle
        label="Agentic retrieval in the bar (route → plan → execute → rerank)"
        checked={s.agentic}
        onChange={(v) => void save({ agentic: v })}
      />
      <p className="meta">
        Off, the bar answers from one hybrid search. On, it plans which methods to run and reranks
        what comes back — more thorough, one extra call.
      </p>

      <h3>Budgets</h3>
      <div style={rowStyle}>
        <span>Exhaustive-scan row limit</span>
        <input
          type="number"
          style={{ width: 100 }}
          aria-label="Exhaustive-scan row limit"
          defaultValue={s.scan_row_limit}
          onBlur={(e) => void save({ scan_row_limit: Number(e.target.value) })}
        />
      </div>
      <div style={rowStyle}>
        <span>Graph hop limit</span>
        <input
          type="number"
          style={{ width: 100 }}
          aria-label="Graph hop limit"
          defaultValue={s.graph.hops}
          onBlur={(e) => void save({ graph: { hops: Number(e.target.value) } })}
        />
      </div>
      <div style={rowStyle}>
        <span>Graph fan-out cap (per hop)</span>
        <input
          type="number"
          style={{ width: 100 }}
          aria-label="Graph fan-out cap"
          defaultValue={s.graph.fanout}
          onBlur={(e) => void save({ graph: { fanout: Number(e.target.value) } })}
        />
      </div>
      <p className="meta">
        defaults: {s.graph.default_hops} hops · fan-out {s.graph.default_fanout}. Both are guesses
        until they are measured on a real graph (§28) — raising them costs time, not accuracy.
      </p>
      {(s.refused ?? []).length > 0 && (
        <p className="meta" role="status">
          not saved: {(s.refused ?? []).join(" · ")}
        </p>
      )}

      <h3>Hub exclusions</h3>
      <p className="meta">
        Entities a walk should never pass through, because everything connects to them.
      </p>
      {s.hubs.length === 0 ? (
        <p className="empty">no hubs excluded</p>
      ) : (
        s.hubs.map((h) => (
          <div key={h.entity_id} style={rowStyle}>
            <span>{h.entity_id}</span>
            <span className="meta">
              {h.reason}
              {h.degree != null ? ` · degree ${h.degree}` : ""}{" "}
              <button
                className="linklike"
                aria-label={`remove hub ${h.entity_id}`}
                onClick={() => void save({ remove_hub: h.entity_id })}
              >
                remove
              </button>
            </span>
          </div>
        ))
      )}
      <div style={rowStyle}>
        <input
          aria-label="entity id to exclude"
          placeholder="entity id"
          value={hub}
          style={{ flex: 1 }}
          onChange={(e) => setHub(e.target.value)}
        />
        <button
          className="btn"
          disabled={hub.trim() === ""}
          onClick={() => {
            const id = hub.trim();
            setHub("");
            void save({ add_hub: id });
          }}
        >
          exclude
        </button>
      </div>

      <p className="meta">
        T2 agentic retrieval (hop and time budgets) arrives with P2 — P1 ships T0 hybrid, the T1
        plan the bar runs on, and 2-hop graph walks.
      </p>
    </div>
  );
}

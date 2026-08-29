// ===========================================================================
// Settings › Intelligence — which model runs each V13 step, how hard it
// thinks, and which encoder retrieval is built on.
//
// WHAT WAS BROKEN (defects 6 and 5b). The per-step picker offered three
// strings — haiku / sonnet / opus. None of them says which version will run,
// none of them carries a price, and there was no way to reach the dozen other
// models the local CLI can actually run. There was no reasoning control at
// all. And the encoder list underneath was four lines of inert text: sizes,
// no buttons, no way to fetch the model it called "recommended".
//
// WHAT IT IS NOW. The model list is DISCOVERED from the CLI's own catalogue
// (worker/src/providers/claude-local/discovery.ts) — versioned ids, per-
// million prices, and the reasoning levels each model genuinely accepts — with
// a curated list as the fallback and a line saying which of the two you are
// looking at. Beside each picker sits a second one for the reasoning level,
// built from the SELECTED model's own levels and disabled outright for a model
// that has none. The encoder list is a real list with Download, Delete, live
// progress and a size-on-disk readout.
//
// What was already right is kept: the per-step recommendation, the on/off
// toggle, the observed 7-day cost, and the eval gate on every change.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";

import {
  activateEmbeddingModel,
  cancelEmbeddingModelDownload,
  deleteEmbeddingModel,
  downloadEmbeddingModel,
  fetchEmbeddingModels,
  fetchSettingsIntelligence,
  saveIntelligenceStep,
  type EmbeddingRegistry,
  type IntelligenceSettings,
  type ModelOptionRow,
} from "../../lib/api";
import { ModelList, type ModelRowView } from "./ModelList";
import { rowStyle } from "./shared";

/** How often the encoder list re-reads itself while a fetch is in flight. */
const PROGRESS_POLL_MS = 1000;

/** "$1.00 in / $5.00 out per Mtok" — the number that decides a picker choice. */
function priceOf(m: ModelOptionRow): string {
  if (m.input_per_mtok === null || m.output_per_mtok === null) return "price unlisted";
  return `$${m.input_per_mtok}/M in · $${m.output_per_mtok}/M out`;
}

/**
 * The picker rows. The worker serves `models`; `options` is the 13.4.1 shape
 * and is only read when talking to a worker that predates the fix, so the two
 * halves of an in-place upgrade never render an empty dropdown.
 */
function modelRows(s: IntelligenceSettings): ModelOptionRow[] {
  if (s.models && s.models.length > 0) return s.models;
  return s.options.map((id) => ({
    id,
    label: id,
    family: id,
    alias: true,
    resolves_to: null,
    input_per_mtok: null,
    output_per_mtok: null,
    thinking_levels: [],
    default_thinking: null,
    effort: false,
    context_window: null,
  }));
}

export function IntelligencePanel(): JSX.Element {
  const [s, setS] = useState<IntelligenceSettings | null>(null);
  const [embed, setEmbed] = useState<EmbeddingRegistry | null>(null);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshEmbed = useCallback(async () => {
    try {
      setEmbed(await fetchEmbeddingModels());
    } catch {
      setEmbed(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setS(await fetchSettingsIntelligence());
    await refreshEmbed();
  }, [refreshEmbed]);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // A download is minutes of work reported by polling the registry, not by a
  // held-open request; without this the progress line would never move.
  useEffect(() => {
    const busy =
      embed?.models.some((m) => m.download?.status === "downloading") === true ||
      (embed?.swap != null && embed.swap.phase === "embedding");
    if (!busy) return;
    timer.current = setTimeout(() => void refreshEmbed(), PROGRESS_POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [embed, refreshEmbed]);

  /** Run one registry action and adopt whatever it answers with, error included. */
  const act = useCallback(
    async (fn: (id: string) => Promise<EmbeddingRegistry>, id: string) => {
      try {
        const next = await fn(id);
        setEmbedError(next.error ?? null);
        if (next.models) setEmbed(next);
        else await refreshEmbed();
      } catch (err) {
        setEmbedError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshEmbed],
  );

  if (!s) return <p className="empty">loading…</p>;
  const groups = [...new Set(s.steps.map((x) => x.group))];
  const models = modelRows(s);
  const byId = new Map(models.map((m) => [m.id, m]));
  const discovery = s.discovery;

  return (
    <div>
      <h2>Intelligence — model per step</h2>
      <p className="meta">default: Haiku everywhere · rec = advised, applied only by your choice</p>
      <p className="meta">
        {discovery?.mode === "discovered"
          ? `${models.length} models read from the local Claude CLI · prices per million tokens`
          : discovery?.mode === "cached"
            ? `${models.length} models read from the Claude CLI earlier — could not re-read it now (${discovery.error ?? "unknown"})`
            : discovery
              ? `curated fallback list — could not read the CLI's catalogue (${discovery.error ?? "unknown"})`
              : "model list served by the worker"}
      </p>
      {groups.map((g) => (
        <div key={g}>
          <h3>{g}</h3>
          {s.steps
            .filter((x) => x.group === g)
            .map((x) => {
              const picked = byId.get(x.selected);
              // The levels the SELECTED model offers — the worker sends them
              // per step, and the catalogue row is the fallback for a worker
              // that does not yet.
              const levels = x.thinking_levels ?? picked?.thinking_levels ?? [];
              return (
                <div key={x.key} style={rowStyle}>
                  <span>{x.label}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <select
                      aria-label={`${x.label} model`}
                      value={x.selected}
                      onChange={(e) =>
                        void saveIntelligenceStep({ step: x.key, model: e.target.value }).then(
                          refresh,
                        )
                      }
                    >
                      {models.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label} — {priceOf(o)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`${x.label} thinking`}
                      // A model with no reasoning dial gets a disabled control
                      // saying so, never a dropdown of choices that do nothing.
                      disabled={levels.length === 0}
                      value={levels.length === 0 ? "none" : (x.thinking ?? "off")}
                      onChange={(e) =>
                        void saveIntelligenceStep({
                          step: x.key,
                          thinking: e.target.value,
                        }).then(refresh)
                      }
                    >
                      {levels.length === 0 ? (
                        <option value="none">no thinking levels</option>
                      ) : (
                        levels.map((l) => (
                          <option key={l} value={l}>
                            thinking: {l}
                          </option>
                        ))
                      )}
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
              );
            })}
        </div>
      ))}

      <h3>Retrieval — embedding model</h3>
      {embed ? (
        <ModelList
          activeWord="active"
          error={embedError}
          rows={embed.models.map(
            (m): ModelRowView => ({
              id: m.id,
              label: `${m.label} · ${m.dim}d`,
              note: m.active ? `${m.indexed} indexed` : undefined,
              bytes: m.bytes,
              bytesOnDisk:
                m.files?.reduce((n, f) => n + (f.bytesOnDisk ?? 0), 0) ?? null,
              present: m.present,
              active: m.active,
              bundled: m.bundled,
              chips: [
                ...(m.active ? [{ text: "active", accent: true }] : []),
                ...(embed.default === m.id ? [{ text: "default" }] : []),
                ...(m.recommended && embed.default !== m.id ? [{ text: "recommended" }] : []),
                ...(m.bundled ? [{ text: "bundled" }] : []),
              ],
              download: m.download ?? null,
            }),
          )}
          onDownload={(id) => void act(downloadEmbeddingModel, id)}
          onCancel={(id) => void act(cancelEmbeddingModelDownload, id)}
          onDelete={(id) => void act(deleteEmbeddingModel, id)}
          onActivate={(id) => void act(activateEmbeddingModel, id)}
        />
      ) : (
        <p className="meta">registry unavailable</p>
      )}
      {embed?.swap && embed.swap.phase === "embedding" ? (
        <p className="meta" role="status">
          re-embedding onto {embed.swap.toModel ?? "the new model"} —{" "}
          {embed.swap.embedded ?? 0} of {embed.swap.total ?? 0}
        </p>
      ) : null}
      <p className="meta">swapping re-embeds in the background (§15 T3); the old index serves until the new one is complete</p>
      <p className="meta">⚠ a model change runs the golden set first; ships only if it doesn't regress (§18)</p>
    </div>
  );
}

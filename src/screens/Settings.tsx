// ===========================================================================
// Settings — build P4.3, spec §14.9. Left rail of eight subtabs, content
// pane right: General · Capture & Privacy · Sources · Intelligence ·
// Enrichment · Assist · Runs · Data.
//
//   Intelligence  model picker per V13 step — DEFAULT HAIKU everywhere, the
//                 recommendation shown beside each picker and applied only by
//                 choice (eval-gated, spec §18); per-step on/off; the
//                 embedding-model registry (EmbeddingGemma 300M recommended,
//                 swap re-embeds in the background via T3); per-step 7d cost.
//   Runs          the trace viewer (§17): filter by pass/day, open a run to
//                 the EXACT system prompt / packed context / raw output,
//                 diff two runs, cost rollup, quarantine browser, run undo.
//   Data          storage per store, export path, retention, honest delete
//                 (the cascading delete itself lives in Library › Screen).
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  fetchEmbeddingModels,
  fetchHealth,
  fetchQuarantine,
  fetchSettingsAssist,
  fetchSettingsCapture,
  fetchSettingsData,
  fetchSettingsGeneral,
  fetchSettingsGraduation,
  fetchSettingsIntelligence,
  fetchSettingsMedia,
  fetchSettingsSources,
  fetchSettingsT3,
  fetchTraceFull,
  fetchTraces,
  saveGraduationMode,
  saveIntelligenceStep,
  saveSettingsAssist,
  saveSettingsCapture,
  saveSettingsGeneral,
  saveSettingsMedia,
  saveTracesRetention,
  undoRun,
  type AssistSettings,
  type CaptureSettings,
  type DataSettings,
  type FullTraceRecord,
  type GeneralSettings,
  type GraduationSettings,
  type IntelligenceSettings,
  type MediaSettings,
  type QuarantineRow,
  type SourceStatusRow,
  type T3Status,
  type TraceIndexRow,
  type TracePassCost,
  type EmbeddingModelRow,
} from "../lib/api";

const SUBTABS = [
  "General",
  "Capture & Privacy",
  "Sources",
  "Intelligence",
  "Enrichment",
  "Assist",
  "Runs",
  "Data",
] as const;

type Subtab = (typeof SUBTABS)[number];

const WHISPER_OPTIONS = [
  "tiny",
  "base",
  "small",
  "medium-q5_0",
  "large-v3-turbo-q5_0",
  "large-v3-turbo",
  "large-v3-q5_0",
];

const rail: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 140,
};
const railBtn = (active: boolean): React.CSSProperties => ({
  textAlign: "left",
  padding: "6px 10px",
  borderRadius: 8,
  border: "none",
  cursor: "pointer",
  background: active ? "var(--glass-2, rgba(127,127,127,.18))" : "transparent",
  color: "inherit",
  font: "inherit",
});
const paneStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "4px 0",
};

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function Toggle(props: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label style={rowStyle}>
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// General (incl. graduation + T3 status + version footer)
// ---------------------------------------------------------------------------

function GeneralPane(): JSX.Element {
  const [s, setS] = useState<GeneralSettings | null>(null);
  const [grad, setGrad] = useState<GraduationSettings | null>(null);
  const [t3, setT3] = useState<T3Status | null>(null);
  const [footer, setFooter] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setS(await fetchSettingsGeneral());
    setGrad(await fetchSettingsGraduation());
    setT3(await fetchSettingsT3());
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
    void fetchHealth()
      .then((h) => setFooter(`v${h.version} · built through ${h.builtThroughPhase}`))
      .catch(() => {});
  }, [refresh]);

  if (!s) return <p className="empty">loading…</p>;
  const save = async (patch: Partial<GeneralSettings>): Promise<void> => {
    setS(await saveSettingsGeneral(patch));
  };
  return (
    <div>
      <h2>General</h2>
      <div style={rowStyle}>
        <span>Summon hotkey</span>
        <span className="chip">{s.hotkey_summon}</span>
      </div>
      <div style={rowStyle}>
        <span>Bar hotkey</span>
        <span className="chip">{s.hotkey_bar}</span>
      </div>
      <Toggle
        label="Launch at login"
        checked={s.launch_at_login}
        onChange={(v) => void save({ launch_at_login: v })}
      />
      <Toggle
        label="macOS notifications"
        checked={s.notifications_enabled}
        onChange={(v) => void save({ notifications_enabled: v })}
      />
      <div style={rowStyle}>
        <span>Brief times</span>
        <input
          defaultValue={s.brief_times.join(", ")}
          onBlur={(e) =>
            void save({
              brief_times: e.target.value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
      <div style={rowStyle}>
        <span>Appearance</span>
        <select value={s.appearance} onChange={(e) => void save({ appearance: e.target.value })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <h3>Space creation</h3>
      {grad && (
        <>
          <div style={rowStyle}>
            <span>
              {grad.mode === "auto"
                ? "Auto-create: new spaces activate on their own"
                : `Propose-only: gates green ${grad.consecutive_green}/${grad.required_days} consecutive days`}
            </span>
            <button
              className="btn"
              onClick={() =>
                void saveGraduationMode(grad.mode === "auto" ? "propose" : "auto").then(setGrad)
              }
            >
              {grad.mode === "auto" ? "Revert to propose-only" : "Turn on auto-create"}
            </button>
          </div>
          <p className="meta">
            Auto-create flips itself after {grad.required_days} straight days with every gate
            green; reverting here keeps it off until you turn it back on.
          </p>
        </>
      )}

      {t3?.last_report && (
        <p className="meta">
          Last deep pass {t3.last_report.ranAt.slice(0, 16)}: {t3.last_report.crossLinks} links ·{" "}
          {t3.last_report.claimVersionsCompressed} claim versions compressed ·{" "}
          {t3.last_report.ephemeralArchived} ephemeral spaces archived
        </p>
      )}
      {footer && (
        <p className="version-footer" style={{ color: "var(--ink-2)", fontSize: 12 }}>
          {footer}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capture & Privacy
// ---------------------------------------------------------------------------

function CapturePane(): JSX.Element {
  const [s, setS] = useState<CaptureSettings | null>(null);
  useEffect(() => {
    void fetchSettingsCapture().then(setS).catch(() => {});
  }, []);
  if (!s) return <p className="empty">loading…</p>;
  const save = async (patch: Partial<CaptureSettings>): Promise<void> => {
    setS(await saveSettingsCapture(patch));
  };
  const listEditor = (
    label: string,
    key: "app_blocklist" | "domain_blocklist" | "pagetext_rules",
  ): JSX.Element => (
    <div style={{ padding: "4px 0" }}>
      <div>{label}</div>
      <textarea
        rows={2}
        style={{ width: "100%" }}
        defaultValue={s[key].join("\n")}
        onBlur={(e) => void save({ [key]: e.target.value.split("\n").filter(Boolean) })}
      />
    </div>
  );
  return (
    <div>
      <h2>Capture &amp; Privacy</h2>
      {Object.entries(s.sources).map(([source, v]) => (
        <Toggle
          key={source}
          label={`Capture ${source}`}
          checked={!v.paused}
          onChange={(on) => void save({ sources: { [source]: { paused: !on } } })}
        />
      ))}
      {listEditor("App blocklist (never captured)", "app_blocklist")}
      {listEditor("Domain blocklist", "domain_blocklist")}
      {listEditor("Page-text capture rules (per domain)", "pagetext_rules")}
      <p className="privacy-line">Incognito windows: always excluded — not a setting.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function SourcesPane(): JSX.Element {
  const [rows, setRows] = useState<SourceStatusRow[] | null>(null);
  useEffect(() => {
    void fetchSettingsSources()
      .then((r) => setRows(r.sources))
      .catch(() => {});
  }, []);
  if (!rows) return <p className="empty">loading…</p>;
  if (rows.length === 0) return <p className="empty">No sources connected yet.</p>;
  return (
    <div>
      <h2>Sources</h2>
      {rows.map((r) => (
        <div key={r.source} style={rowStyle}>
          <span>
            {r.source} · {r.streams} stream{r.streams === 1 ? "" : "s"}
            {r.paused_streams > 0 && ` (${r.paused_streams} paused)`}
          </span>
          <span className="meta">
            {r.paused ? "source paused" : r.import_done ? "backfilled" : "importing"}
            {r.last_event_at && ` · last ${r.last_event_at.slice(0, 16)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

function IntelligencePane(): JSX.Element {
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

// ---------------------------------------------------------------------------
// Enrichment (V11 media system)
// ---------------------------------------------------------------------------

function EnrichmentPane(): JSX.Element {
  const [s, setS] = useState<MediaSettings | null>(null);
  useEffect(() => {
    void fetchSettingsMedia().then(setS).catch(() => {});
  }, []);
  if (!s) return <p className="empty">loading…</p>;
  const save = async (patch: Partial<MediaSettings>): Promise<void> => {
    setS(await saveSettingsMedia(patch));
  };
  const num = (
    label: string,
    key: "rate_per_min" | "concurrency" | "video_frame_interval_sec" | "video_frame_max" | "video_max_height",
  ): JSX.Element => (
    <div style={rowStyle}>
      <span>{label}</span>
      <input
        type="number"
        style={{ width: 80 }}
        defaultValue={s[key]}
        onBlur={(e) => void save({ [key]: Number(e.target.value) })}
      />
    </div>
  );
  return (
    <div>
      <h2>Enrichment — media &amp; links</h2>
      <h3>Voice &amp; audio (local whisper — zero tokens)</h3>
      <div style={rowStyle}>
        <span>Whisper model</span>
        <select
          value={s.whisper_model}
          onChange={(e) => void save({ whisper_model: e.target.value })}
        >
          {WHISPER_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <Toggle label="Voice notes / audio attachments" checked={s.voice_notes_enabled} onChange={(v) => void save({ voice_notes_enabled: v })} />
      <Toggle label="Audio track inside videos" checked={s.video_audio_enabled} onChange={(v) => void save({ video_audio_enabled: v })} />
      <h3>Images &amp; video (token-metered)</h3>
      <Toggle label="Describe media as it arrives" checked={s.describe_enabled} onChange={(v) => void save({ describe_enabled: v })} />
      <Toggle label="Work through history backlog" checked={s.backfill_enabled} onChange={(v) => void save({ backfill_enabled: v })} />
      <Toggle label="Photos & stickers" checked={s.images_enabled} onChange={(v) => void save({ images_enabled: v })} />
      <Toggle label="Video thumbnail frame" checked={s.video_enabled} onChange={(v) => void save({ video_enabled: v })} />
      <Toggle label="Frame sampling" checked={s.video_frames_enabled} onChange={(v) => void save({ video_frames_enabled: v })} />
      {num("Frame interval (s)", "video_frame_interval_sec")}
      {num("Max frames", "video_frame_max")}
      {num("Max height (px)", "video_max_height")}
      <Toggle label="Media in business/official chats" checked={s.business_enabled} onChange={(v) => void save({ business_enabled: v })} />
      <h3>Links</h3>
      <Toggle label="Fetch pages links point at" checked={s.link_scrape_enabled} onChange={(v) => void save({ link_scrape_enabled: v })} />
      <p className="meta">browser page-text capture (§4.2.3) is separate — Capture &amp; Privacy governs it</p>
      <h3>Throughput</h3>
      {num("Backfill rate (/min)", "rate_per_min")}
      {num("Concurrency", "concurrency")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assist
// ---------------------------------------------------------------------------

function AssistPane(): JSX.Element {
  const [s, setS] = useState<AssistSettings | null>(null);
  useEffect(() => {
    void fetchSettingsAssist().then(setS).catch(() => {});
  }, []);
  if (!s) return <p className="empty">loading…</p>;
  const save = async (
    patch: Partial<AssistSettings> & { clear_suppressed?: boolean },
  ): Promise<void> => {
    setS(await saveSettingsAssist(patch));
  };
  const threshold = (cat: string, label: string): JSX.Element => (
    <div style={rowStyle}>
      <span>{label}</span>
      <input
        type="number"
        style={{ width: 60 }}
        defaultValue={s.thresholds[cat] ?? 5}
        onBlur={(e) => void save({ thresholds: { [cat]: Number(e.target.value) } })}
      />
    </div>
  );
  return (
    <div>
      <h2>Assist — when the twin steps in</h2>
      <Toggle label="Nudge popups (off = Prepared only)" checked={s.enabled} onChange={(v) => void save({ enabled: v })} />
      <h3>Novelty threshold (distinct events before an assist pass may run)</h3>
      {threshold("default", "default")}
      {threshold("transaction", "transactions")}
      {threshold("research", "research")}
      {threshold("communication", "communication")}
      <div style={rowStyle}>
        <span>Cooldown per context (min)</span>
        <input
          type="number"
          style={{ width: 60 }}
          defaultValue={s.cooldown_min}
          onBlur={(e) => void save({ cooldown_min: Number(e.target.value) })}
        />
      </div>
      <div style={rowStyle}>
        <span>Quiet hours</span>
        <span>
          <input
            style={{ width: 64 }}
            defaultValue={s.quiet_hours.start}
            onBlur={(e) => void save({ quiet_hours: { start: e.target.value, end: s.quiet_hours.end } })}
          />
          {" – "}
          <input
            style={{ width: 64 }}
            defaultValue={s.quiet_hours.end}
            onBlur={(e) => void save({ quiet_hours: { start: s.quiet_hours.start, end: e.target.value } })}
          />
        </span>
      </div>
      <h3>Suppressed contexts (from your dismissals)</h3>
      {s.suppressed_contexts.length === 0 ? (
        <p className="empty">none</p>
      ) : (
        <>
          {s.suppressed_contexts.map((c) => (
            <div key={c.topic_key} style={rowStyle}>
              <span>{c.topic_key}</span>
              <span className="meta">until {c.suppressed_until.slice(0, 10)}</span>
            </div>
          ))}
          <button className="btn" onClick={() => void save({ clear_suppressed: true })}>
            clear…
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs & Traces viewer
// ---------------------------------------------------------------------------

function diffMarks(a: string, b: string): { onlyA: number; onlyB: number } {
  const setA = new Set(a.split("\n"));
  const setB = new Set(b.split("\n"));
  let onlyA = 0;
  let onlyB = 0;
  for (const l of setA) if (!setB.has(l)) onlyA++;
  for (const l of setB) if (!setA.has(l)) onlyB++;
  return { onlyA, onlyB };
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2) ?? "";
}

function RunsPane(): JSX.Element {
  const [pass, setPass] = useState("");
  const [day, setDay] = useState("");
  const [rows, setRows] = useState<TraceIndexRow[]>([]);
  const [costs, setCosts] = useState<TracePassCost[]>([]);
  const [open, setOpen] = useState<FullTraceRecord | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [diff, setDiff] = useState<[FullTraceRecord, FullTraceRecord] | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantineRow[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetchTraces({
      pass: pass || undefined,
      day: day || undefined,
      limit: 50,
    });
    setRows(r.traces);
    setCosts(r.costs);
    try {
      setQuarantine((await fetchQuarantine()).items);
    } catch {
      setQuarantine([]);
    }
  }, [pass, day]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const pick = (id: string): void => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  };
  const runDiff = async (): Promise<void> => {
    if (picked.length !== 2) return;
    const [a, b] = await Promise.all(picked.map((id) => fetchTraceFull(id)));
    setDiff([a!.trace, b!.trace]);
  };

  return (
    <div>
      <h2>Runs &amp; Traces</h2>
      <div style={rowStyle}>
        <input placeholder="filter by pass" value={pass} onChange={(e) => setPass(e.target.value)} />
        <input placeholder="day (YYYY-MM-DD)" value={day} onChange={(e) => setDay(e.target.value)} />
        <button className="btn" disabled={picked.length !== 2} onClick={() => void runDiff()}>
          diff selected
        </button>
      </div>

      {costs.length > 0 && (
        <p className="meta">
          cost:{" "}
          {costs.map((c) => `${c.pass} $${c.cost_usd.toFixed(2)} (${c.calls})`).join(" · ")}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="empty">no runs match</p>
      ) : (
        rows.map((t) => (
          <div key={t.id} style={rowStyle}>
            <span>
              <input
                type="checkbox"
                aria-label={`select ${t.id}`}
                checked={picked.includes(t.id)}
                onChange={() => pick(t.id)}
              />{" "}
              <button
                className="linklike"
                onClick={() => void fetchTraceFull(t.id).then((r) => setOpen(r.trace))}
              >
                {t.pass ?? "?"} · {t.model ?? "default"} · {t.created_at?.slice(0, 16)}
              </button>
            </span>
            <span className="meta">
              {t.cost_usd != null && `$${t.cost_usd.toFixed(4)}`} · {t.latency_ms ?? "—"}ms
              {t.run_id && (
                <>
                  {" "}
                  <button
                    className="linklike"
                    onClick={() =>
                      void undoRun(t.run_id!)
                        .then(() => setNote(`run ${t.run_id} reversed`))
                        .catch(() => setNote("undo failed"))
                    }
                  >
                    undo run
                  </button>
                </>
              )}
            </span>
          </div>
        ))
      )}
      {note && <p className="meta">{note}</p>}

      {open && (
        <div className="trace-box">
          <div style={rowStyle}>
            <strong>
              {open.pass} · {open.prompt_version ?? ""} · {open.model ?? "default model"}
            </strong>
            <button className="btn" onClick={() => setOpen(null)}>
              close
            </button>
          </div>
          <h4>system prompt</h4>
          <pre>{str(open.system_prompt)}</pre>
          <h4>packed context (byte-what-the-model-saw)</h4>
          <pre>{str(open.packed_context)}</pre>
          <h4>raw output</h4>
          <pre>{str(open.raw_output)}</pre>
        </div>
      )}

      {diff && (
        <div className="trace-box">
          <div style={rowStyle}>
            <strong>
              diff: {diff[0].trace_id} vs {diff[1].trace_id}
            </strong>
            <button className="btn" onClick={() => setDiff(null)}>
              close
            </button>
          </div>
          {(() => {
            const d = diffMarks(str(diff[0].packed_context), str(diff[1].packed_context));
            return (
              <p className="meta">
                packed context: {d.onlyA} line(s) only in A · {d.onlyB} only in B
              </p>
            );
          })()}
          <div style={{ display: "flex", gap: 8 }}>
            <pre style={{ flex: 1 }}>{str(diff[0].packed_context)}</pre>
            <pre style={{ flex: 1 }}>{str(diff[1].packed_context)}</pre>
          </div>
        </div>
      )}

      <h3>Quarantine</h3>
      {quarantine.length === 0 ? (
        <p className="empty">nothing quarantined</p>
      ) : (
        quarantine.map((q) => (
          <div key={String(q.id)} style={rowStyle}>
            <span>{String(q.kind ?? "unit")}</span>
            <span className="meta">{String(q.reason ?? "")}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function DataPane(): JSX.Element {
  const [s, setS] = useState<DataSettings | null>(null);
  useEffect(() => {
    void fetchSettingsData().then(setS).catch(() => {});
  }, []);
  if (!s) return <p className="empty">loading…</p>;
  return (
    <div>
      <h2>Data</h2>
      <h3>Storage</h3>
      <div style={rowStyle}>
        <span>Database</span>
        <span className="meta">{mb(s.storage.db_bytes)}</span>
      </div>
      <div style={rowStyle}>
        <span>Traces</span>
        <span className="meta">{mb(s.storage.traces_bytes)}</span>
      </div>
      <div style={rowStyle}>
        <span>Media</span>
        <span className="meta">{mb(s.storage.media_bytes)}</span>
      </div>
      <div style={rowStyle}>
        <span>Logs</span>
        <span className="meta">{mb(s.storage.logs_bytes)}</span>
      </div>
      {s.events_per_source.map((r) => (
        <div key={r.source} style={rowStyle}>
          <span className="meta">{r.source}</span>
          <span className="meta">{r.events} events</span>
        </div>
      ))}
      <h3>Export</h3>
      <p className="meta">Everything lives under {s.home} — SQLite + JSON, yours to copy.</p>
      <h3>Retention</h3>
      <div style={rowStyle}>
        <span>Trace detail kept (days; index rows keep forever)</span>
        <input
          type="number"
          style={{ width: 80 }}
          defaultValue={s.retention.traces_days}
          onBlur={(e) =>
            void saveTracesRetention(Number(e.target.value))
              .then(() => fetchSettingsData().then(setS))
              .catch(() => {})
          }
        />
      </div>
      <h3>Honest delete</h3>
      <p className="meta">
        Deleting a span (Library › Screen) hard-deletes the events AND everything derived from
        them — episodes, claims, tasks. No soft hides.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function Settings(): JSX.Element {
  const [tab, setTab] = useState<Subtab>("General");
  return (
    <div className="library" style={{ display: "flex", gap: 16 }}>
      <nav style={rail} aria-label="Settings sections">
        {SUBTABS.map((t) => (
          <button key={t} style={railBtn(t === tab)} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div style={paneStyle}>
        {tab === "General" && <GeneralPane />}
        {tab === "Capture & Privacy" && <CapturePane />}
        {tab === "Sources" && <SourcesPane />}
        {tab === "Intelligence" && <IntelligencePane />}
        {tab === "Enrichment" && <EnrichmentPane />}
        {tab === "Assist" && <AssistPane />}
        {tab === "Runs" && <RunsPane />}
        {tab === "Data" && <DataPane />}
      </div>
    </div>
  );
}

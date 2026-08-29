// ===========================================================================
// Settings › Enrichment — media & links: local whisper (zero tokens), the
// token-metered image/video describers, frame sampling, link fetching, and
// the backfill throughput knobs.
//
// WHAT WAS BROKEN (defect 7). Whisper was ONE DROPDOWN over seven model names.
// It let you select `large-v3` — 3 GB — that was not on the machine and never
// would be, said nothing about which models were actually on disk, and gave no
// way to fetch one or to reclaim the space a 1.6 GB model was sitting on. The
// worker has had download/cancel/delete since v5 §4; the dropdown called none
// of them.
//
// It is the same list-with-controls the encoder registry uses now — literally
// the same component (ModelList) and the same polling — because "what is on
// disk, what is in use, fetch it, drop it" is one problem, not two.
//
// The default stays large-v3-turbo-q5_0: it is the one bundled inside the .app.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelWhisperModelDownload,
  deleteWhisperModel,
  downloadWhisperModel,
  fetchMediaTools,
  fetchSettingsMedia,
  saveSettingsMedia,
  type MediaSettings,
  type MediaToolsReport,
} from "../../lib/api";
import { ModelList, type ModelRowView } from "./ModelList";
import { rowStyle, Toggle } from "./shared";

/** How often the list re-reads itself while a model is being fetched. */
const PROGRESS_POLL_MS = 1000;

export function EnrichmentPanel(): JSX.Element {
  const [s, setS] = useState<MediaSettings | null>(null);
  const [tools, setTools] = useState<MediaToolsReport | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshTools = useCallback(async () => {
    try {
      setTools(await fetchMediaTools());
    } catch {
      setTools(null);
    }
  }, []);

  useEffect(() => {
    void fetchSettingsMedia().then(setS).catch(() => {});
    void refreshTools();
  }, [refreshTools]);

  // A whisper model is up to 3 GB; progress is polled off the GET rather than
  // held open on the POST, so without this the bar would never move.
  useEffect(() => {
    if (!tools?.models.some((m) => m.download?.status === "downloading")) return;
    timer.current = setTimeout(() => void refreshTools(), PROGRESS_POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tools, refreshTools]);

  const act = useCallback(
    async (fn: (id: string) => Promise<MediaToolsReport>, id: string) => {
      try {
        const next = await fn(id);
        setToolsError(next.error ?? null);
        if (next.models) setTools({ ...(tools ?? next), ...next });
        else await refreshTools();
      } catch (err) {
        setToolsError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshTools, tools],
  );

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
      {tools ? (
        <ModelList
          activeWord="in use"
          error={toolsError}
          dir={tools.modelsDir}
          rows={tools.models.map(
            (m): ModelRowView => ({
              id: m.id,
              label: m.label,
              note: m.id,
              bytes: m.bytes,
              bytesOnDisk: m.bytesOnDisk,
              present: m.present,
              active: m.selected,
              bundled: m.bundled,
              chips: [
                ...(m.selected ? [{ text: "in use", accent: true }] : []),
                ...(m.bundled ? [{ text: "bundled" }] : []),
              ],
              download: m.download ?? null,
            }),
          )}
          onDownload={(id) => void act(downloadWhisperModel, id)}
          onCancel={(id) => void act(cancelWhisperModelDownload, id)}
          onDelete={(id) => void act(deleteWhisperModel, id)}
          // Selecting a whisper model is a media SETTING, not a registry
          // action — it goes through the same POST it always did, and only a
          // model that is actually on disk can be selected at all.
          onActivate={(id) =>
            void save({ whisper_model: id }).then(refreshTools)
          }
        />
      ) : (
        <div style={rowStyle}>
          <span>Whisper model</span>
          <span className="meta">model list unavailable — {s.whisper_model} selected</span>
        </div>
      )}
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

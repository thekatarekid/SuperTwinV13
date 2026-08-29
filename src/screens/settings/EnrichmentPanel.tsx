// ===========================================================================
// Settings › Enrichment — media & links: local whisper (zero tokens), the
// token-metered image/video describers, frame sampling, link fetching, and
// the backfill throughput knobs.
//
// Moved out of the monolithic Settings.tsx unchanged.
// ===========================================================================

import { useEffect, useState } from "react";

import { fetchSettingsMedia, saveSettingsMedia, type MediaSettings } from "../../lib/api";
import { rowStyle, Toggle } from "./shared";

const WHISPER_OPTIONS = [
  "tiny",
  "base",
  "small",
  "medium-q5_0",
  "large-v3-turbo-q5_0",
  "large-v3-turbo",
  "large-v3-q5_0",
];

export function EnrichmentPanel(): JSX.Element {
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

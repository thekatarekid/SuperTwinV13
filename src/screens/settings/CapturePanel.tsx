// ===========================================================================
// Settings › Capture & Privacy — per-source capture switches, the blocklists,
// per-domain page-text rules, and the one line that is never a setting:
// incognito windows are always excluded (spec §14.9.2).
// ===========================================================================

import { useEffect, useState } from "react";

import { fetchSettingsCapture, saveSettingsCapture, type CaptureSettings } from "../../lib/api";
import { Toggle } from "./shared";

export function CapturePanel(): JSX.Element {
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

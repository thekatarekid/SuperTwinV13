// ===========================================================================
// Settings shell — spec §14.9, Product_V6 §25. The subtabs, TOP-CENTER,
// directly under the main pill nav; the selected panel — and only that panel —
// below.
//
// V6 P1 S5.6 adds the three §25 groups P1 ships that had no pane: AI
// Connector, Retrieval and Calendar. Sharing, Public and Economy stay hidden
// until their phase — an empty pane for a feature that does not exist is worse
// than no pane at all. The order follows the doc's own table so the rail reads
// the way the spec does.
//
// The 13.4.1 build stacked the eight subtab buttons as a plain vertical list
// in normal flow, so they scrolled away with the panel and overlapped its
// content. They are a centred segmented row now — the same .subnav-row /
// .pill-nav-sub language Library's source subtabs use, so the two screens read
// as one system — plus the sticky, wrap-don't-clip behaviour eight full labels
// need (styles/settings.css).
//
// The shell knows the LIST and nothing else: every panel is its own file under
// screens/settings/, so a change to one subtab never touches the other seven.
// ===========================================================================

import { useState } from "react";

import { AssistPanel } from "./settings/AssistPanel";
import { CalendarPanel } from "./settings/CalendarPanel";
import { CapturePanel } from "./settings/CapturePanel";
import { ConnectorPanel } from "./settings/ConnectorPanel";
import { DataPanel } from "./settings/DataPanel";
import { EnrichmentPanel } from "./settings/EnrichmentPanel";
import { GeneralPanel } from "./settings/GeneralPanel";
import { IntelligencePanel } from "./settings/IntelligencePanel";
import { RetrievalPanel } from "./settings/RetrievalPanel";
import { RunsPanel } from "./settings/RunsPanel";
import { SourcesPanel } from "./settings/SourcesPanel";

/** Full labels — no abbreviations; the row wraps before a label is cut. */
export const SETTINGS_SUBTABS = [
  { id: "general", label: "General", Panel: GeneralPanel },
  { id: "capture", label: "Capture & Privacy", Panel: CapturePanel },
  { id: "sources", label: "Sources", Panel: SourcesPanel },
  { id: "connector", label: "AI Connector", Panel: ConnectorPanel },
  { id: "intelligence", label: "Intelligence", Panel: IntelligencePanel },
  { id: "retrieval", label: "Retrieval", Panel: RetrievalPanel },
  { id: "enrichment", label: "Enrichment", Panel: EnrichmentPanel },
  { id: "assist", label: "Assist", Panel: AssistPanel },
  { id: "calendar", label: "Calendar", Panel: CalendarPanel },
  { id: "runs", label: "Runs & Traces", Panel: RunsPanel },
  { id: "data", label: "Data", Panel: DataPanel },
] as const;

export type SettingsSubtab = (typeof SETTINGS_SUBTABS)[number]["id"];

export function Settings(): JSX.Element {
  const [tab, setTab] = useState<SettingsSubtab>("general");
  const active = SETTINGS_SUBTABS.find((t) => t.id === tab) ?? SETTINGS_SUBTABS[0];
  const Panel = active.Panel;
  return (
    <div className="settings">
      <div className="subnav-row settings-subtabs">
        <nav className="pill-nav pill-nav-sub" aria-label="Settings sections">
          {SETTINGS_SUBTABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={t.id === tab ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="settings-panel">
        <Panel />
      </div>
    </div>
  );
}

// ===========================================================================
// Library — spec §14.3.2.
//
// One source at a time, chosen from a subtab pill that sits top-center
// directly under the main nav (same visual language, one size down):
//
//     WhatsApp · Screen · Browser          [Storage]
//
// Each subtab owns its source end-to-end: the connect flow when the source is
// not connected, and that source's own real view of the data when it is —
// a chat inbox, sessions grouped by app, tab chains. Per-source trust
// controls stay inline where the data lives (spec §14.3.2), never buried.
//
// Storage (V6 S1.8, T5-6) is not a source, so it is not in the source pill:
// a second pill beside it opens the panel with free disk first, two bars per
// source (searchable · understood) and the two disk budgets.
//
// People used to live at the bottom of this scroll; it is now its own nav
// destination (src/screens/People.tsx), because the CRM is not a source.
// ===========================================================================

import { useState } from "react";

import { BrowserLibrary } from "./library/BrowserLibrary";
import { ScreenLibrary } from "./library/ScreenLibrary";
import { StoragePanel } from "./library/StoragePanel";
import { WhatsAppLibrary } from "./library/WhatsAppLibrary";

const SUBTABS = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "screen", label: "Screen" },
  { id: "browser", label: "Browser" },
] as const;

export type LibrarySubtab = (typeof SUBTABS)[number]["id"];
export type LibraryView = LibrarySubtab | "storage";

export function Library(props: { initial?: LibraryView } = {}): JSX.Element {
  const [view, setView] = useState<LibraryView>(props.initial ?? "whatsapp");

  return (
    <div className="library">
      <div className="subnav-row">
        <nav className="pill-nav pill-nav-sub" aria-label="library sources">
          {SUBTABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={view === t.id ? "page" : undefined}
              onClick={() => setView(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <nav className="pill-nav pill-nav-sub library-storage-pill" aria-label="library storage">
          <button
            type="button"
            aria-current={view === "storage" ? "page" : undefined}
            onClick={() => setView("storage")}
          >
            Storage
          </button>
        </nav>
      </div>

      {view === "whatsapp" && <WhatsAppLibrary />}
      {view === "screen" && <ScreenLibrary />}
      {view === "browser" && <BrowserLibrary />}
      {view === "storage" && <StoragePanel />}
    </div>
  );
}

// ===========================================================================
// Library — spec §14.3.2.
//
// One source at a time, chosen from a subtab pill that sits top-center
// directly under the main nav (same visual language, one size down):
//
//     WhatsApp · Screen · Browser
//
// Each subtab owns its source end-to-end: the connect flow when the source is
// not connected, and that source's own real view of the data when it is —
// a chat inbox, sessions grouped by app, tab chains. Per-source trust
// controls stay inline where the data lives (spec §14.3.2), never buried.
//
// People used to live at the bottom of this scroll; it is now its own nav
// destination (src/screens/People.tsx), because the CRM is not a source.
// ===========================================================================

import { useState } from "react";

import { BrowserLibrary } from "./library/BrowserLibrary";
import { ScreenLibrary } from "./library/ScreenLibrary";
import { WhatsAppLibrary } from "./library/WhatsAppLibrary";

const SUBTABS = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "screen", label: "Screen" },
  { id: "browser", label: "Browser" },
] as const;

export type LibrarySubtab = (typeof SUBTABS)[number]["id"];

export function Library(props: { initial?: LibrarySubtab } = {}): JSX.Element {
  const [sub, setSub] = useState<LibrarySubtab>(props.initial ?? "whatsapp");

  return (
    <div className="library">
      <div className="subnav-row">
        <nav className="pill-nav pill-nav-sub" aria-label="library sources">
          {SUBTABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={sub === t.id ? "page" : undefined}
              onClick={() => setSub(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {sub === "whatsapp" && <WhatsAppLibrary />}
      {sub === "screen" && <ScreenLibrary />}
      {sub === "browser" && <BrowserLibrary />}
    </div>
  );
}

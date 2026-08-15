import { useState } from "react";
import { InboxTab } from "./tabs/InboxTab";
import { ChatTab } from "./tabs/ChatTab";
import { SettingsTab } from "./tabs/SettingsTab";

type TabId = "inbox" | "chat" | "settings";

interface TabDef {
  id: TabId;
  label: string;
  icon: JSX.Element;
}

/** Shared props for the 18px stroke-style rail icons. */
const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const ICONS: Record<TabId, JSX.Element> = {
  inbox: (
    <svg {...ICON_PROPS}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  chat: (
    <svg {...ICON_PROPS}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  settings: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

const TABS: TabDef[] = [
  { id: "inbox", label: "Inbox", icon: ICONS.inbox },
  { id: "chat", label: "Chat", icon: ICONS.chat },
  { id: "settings", label: "Settings", icon: ICONS.settings },
];

export function App() {
  const [active, setActive] = useState<TabId>("chat");

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Primary">
        <div className="sidebar__brand">
          <span className="sidebar__logo" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="none"
            >
              {/* Four-petal bloom brand mark. */}
              <path d="M12 2c1.8 2.2 2.6 4.5 2.6 6.4 0 2-1.1 3.6-2.6 3.6S9.4 10.4 9.4 8.4C9.4 6.5 10.2 4.2 12 2zM12 22c-1.8-2.2-2.6-4.5-2.6-6.4 0-2 1.1-3.6 2.6-3.6s2.6 1.6 2.6 3.6c0 1.9-.8 4.2-2.6 6.4zM2 12c2.2-1.8 4.5-2.6 6.4-2.6 2 0 3.6 1.1 3.6 2.6s-1.6 2.6-3.6 2.6C6.5 14.6 4.2 13.8 2 12zM22 12c-2.2 1.8-4.5 2.6-6.4 2.6-2 0-3.6-1.1-3.6-2.6s1.6-2.6 3.6-2.6c1.9 0 4.2.8 6.4 2.6z" />
            </svg>
          </span>
          <span className="sidebar__title">SuperTwinV11</span>
        </div>
        <ul className="sidebar__nav">
          {TABS.map((tab) => (
            <li key={tab.id}>
              <button
                type="button"
                className={
                  "sidebar__item" +
                  (active === tab.id ? " sidebar__item--active" : "")
                }
                aria-current={active === tab.id ? "page" : undefined}
                onClick={() => setActive(tab.id)}
              >
                <span className="sidebar__item-icon" aria-hidden="true">
                  {tab.icon}
                </span>
                <span className="sidebar__item-label">{tab.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="content">
        {active === "inbox" && <InboxTab />}
        {active === "chat" && (
          <ChatTab onOpenSettings={() => setActive("settings")} />
        )}
        {active === "settings" && <SettingsTab />}
      </main>
    </div>
  );
}

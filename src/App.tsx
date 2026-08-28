import { useState } from "react";
import { InboxTab } from "./tabs/InboxTab";
import { ChatTab } from "./tabs/ChatTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { EntitiesTab } from "./tabs/EntitiesTab";
import { SessionsTab } from "./tabs/SessionsTab";
import { EpisodesTab } from "./tabs/EpisodesTab";
import { ThreadsTab } from "./tabs/ThreadsTab";
import { ClaimsTab } from "./tabs/ClaimsTab";
import { SpacesTab } from "./tabs/SpacesTab";
import { TasksTab } from "./tabs/TasksTab";
import { PeopleTab } from "./tabs/PeopleTab";
import { OpsTab } from "./tabs/OpsTab";

type TabId =
  | "inbox"
  | "chat"
  | "entities"
  | "sessions"
  | "episodes"
  | "threads"
  | "claims"
  | "spaces"
  | "tasks"
  | "people"
  | "ops"
  | "settings";

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
  entities: (
    <svg {...ICON_PROPS}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  sessions: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  episodes: (
    <svg {...ICON_PROPS}>
      {/* Stacked sessions: an episode is a run of them. */}
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <rect x="3" y="12" width="13" height="5" rx="1.5" />
      <path d="M6 20h9" />
    </svg>
  ),
  threads: (
    <svg {...ICON_PROPS}>
      {/* Strands from several sources converging — an arc. */}
      <path d="M3 6c5 0 5 6 9 6s4-6 9-6" />
      <path d="M3 18c5 0 5-6 9-6" />
      <circle cx="21" cy="6" r="1.4" />
      <circle cx="3" cy="18" r="1.4" />
    </svg>
  ),
  claims: (
    <svg {...ICON_PROPS}>
      {/* A statement with a mark against it — a claim carries its evidence. */}
      <path d="M4 5h16v11H8l-4 4z" />
      <path d="M8 10h8" />
    </svg>
  ),
  spaces: (
    <svg {...ICON_PROPS}>
      {/* A promoted arc: a container the threads were lifted into. */}
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M3 11h18" />
      <path d="M8 7V4h8v3" />
    </svg>
  ),
  tasks: (
    <svg {...ICON_PROPS}>
      <path d="M4 6.5 6 8.5 10 4.5" />
      <path d="M4 16.5 6 18.5 10 14.5" />
      <path d="M13 6.5h7" />
      <path d="M13 16.5h7" />
    </svg>
  ),
  people: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  ),
  ops: (
    <svg {...ICON_PROPS}>
      {/* Gauge: an arc with a needle. */}
      <path d="M4 15a8 8 0 0 1 16 0" />
      <path d="M12 15 15.5 9.5" />
      <circle cx="12" cy="15" r="1.2" />
      <path d="M3 19h18" />
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
  { id: "entities", label: "Entities", icon: ICONS.entities },
  { id: "sessions", label: "Sessions", icon: ICONS.sessions },
  { id: "episodes", label: "Episodes", icon: ICONS.episodes },
  { id: "threads", label: "Threads", icon: ICONS.threads },
  { id: "claims", label: "Claims", icon: ICONS.claims },
  { id: "spaces", label: "Spaces", icon: ICONS.spaces },
  { id: "tasks", label: "Tasks", icon: ICONS.tasks },
  { id: "people", label: "People", icon: ICONS.people },
  { id: "ops", label: "Ops", icon: ICONS.ops },
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
          <span className="sidebar__title">SuperTwinV13</span>
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
        {active === "entities" && <EntitiesTab />}
        {active === "sessions" && <SessionsTab />}
        {active === "episodes" && <EpisodesTab />}
        {active === "threads" && <ThreadsTab />}
        {active === "claims" && <ClaimsTab />}
        {active === "spaces" && <SpacesTab onOpenThreads={() => setActive("threads")} />}
        {active === "tasks" && <TasksTab onOpenSpace={() => setActive("spaces")} />}
        {active === "people" && <PeopleTab />}
        {active === "ops" && <OpsTab />}
        {active === "settings" && <SettingsTab />}
      </main>
    </div>
  );
}

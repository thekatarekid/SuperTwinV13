// ===========================================================================
// Agent-tab isolation — build P3.4 safety, spec §12.5, eval BRW-03.
//
// The one profile is shared by user browsing and agent runs (spec §12.2), so
// the isolation contract is STRUCTURAL: every mutating harness operation
// resolves its target through this registry, and a target that was not created
// by the agent path simply cannot be named. `tab-hijack` is a hard-fail gate
// (tab_isolation), so the guard throws — it never warns.
// ===========================================================================

export class TabIsolationError extends Error {
  constructor(targetId: string) {
    super(
      `tab isolation: target ${targetId} is not an agent tab — ` +
        `agent operations never touch user tabs (BRW-03)`,
    );
    this.name = "TabIsolationError";
  }
}

export interface AgentTab {
  targetId: string;
  sessionId: string;
  createdAt: number;
  /** Why the tab exists — lands in the replay log. */
  purpose: string;
}

export class AgentTabRegistry {
  private readonly tabs = new Map<string, AgentTab>();

  tag(tab: AgentTab): void {
    this.tabs.set(tab.targetId, tab);
  }

  untag(targetId: string): void {
    this.tabs.delete(targetId);
  }

  isAgent(targetId: string): boolean {
    return this.tabs.has(targetId);
  }

  /** The BRW-03 gate: throws for any target the agent did not create. */
  assertAgent(targetId: string): AgentTab {
    const tab = this.tabs.get(targetId);
    if (!tab) throw new TabIsolationError(targetId);
    return tab;
  }

  list(): AgentTab[] {
    return [...this.tabs.values()];
  }
}

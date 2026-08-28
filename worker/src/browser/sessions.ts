// ===========================================================================
// "Connect your accounts" — build P3.4, spec §12.3. Sessions are born in the
// browser that uses them: onboarding opens a VISIBLE login tab per service and
// the human does the login (one-time). Chromium's own import-from-Chrome flow
// (chrome://settings/importData) brings passwords + bookmarks — a user-driven
// browser feature; this code never touches encrypted stores or cookie files.
//
// Health checks probe each service in an agent tab and classify the landing
// page: "login" means the session died → notify + the source pauses (BRW-08
// wording: "X needs you to sign in again — open browser"). Nothing here can
// type a credential — the login tab is not even an agent tab.
// ===========================================================================

import type { BrowserHarness } from "./harness.js";
import { classifyPage, type PageClass } from "./safety.js";
import { BrowserHardStopError } from "./safety.js";

export interface ConnectableService {
  id: string;
  label: string;
  /** Where the visible login tab opens. */
  loginUrl: string;
  /** Cheap logged-in probe: a page that renders differently signed out. */
  healthUrl: string;
}

/** The expansion sources the browser will serve (spec §13, rollout order). */
export const SERVICES: readonly ConnectableService[] = [
  {
    id: "youtube",
    label: "YouTube",
    loginUrl: "https://www.youtube.com/",
    healthUrl: "https://www.youtube.com/feed/history",
  },
  {
    id: "x",
    label: "X",
    loginUrl: "https://x.com/i/flow/login",
    healthUrl: "https://x.com/i/bookmarks",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    loginUrl: "https://chatgpt.com/",
    healthUrl: "https://chatgpt.com/",
  },
  {
    id: "gemini",
    label: "Gemini",
    loginUrl: "https://gemini.google.com/",
    healthUrl: "https://gemini.google.com/app",
  },
  {
    id: "instagram",
    label: "Instagram",
    loginUrl: "https://www.instagram.com/accounts/login/",
    healthUrl: "https://www.instagram.com/",
  },
];

export function serviceById(id: string): ConnectableService | undefined {
  return SERVICES.find((s) => s.id === id);
}

/** The Chromium-native import flow (passwords + bookmarks, user-driven). */
export const IMPORT_FROM_CHROME_URL = "chrome://settings/importData";

export interface SessionHealth {
  service: string;
  checkedAt: number;
  state: "healthy" | "needs_login" | "challenge" | "unknown";
}

export interface ConnectDeps {
  /** Opens a VISIBLE user tab (NOT agent-tagged, NOT hidden). Injectable so
   * tests observe it; production sends Target.createTarget + activateTarget
   * through the same CDP client the harness owns. */
  openUserTab: (url: string) => Promise<void>;
  now?: () => number;
}

export class AccountConnector {
  private readonly health = new Map<string, SessionHealth>();
  private readonly now: () => number;

  constructor(
    private readonly harness: BrowserHarness,
    private readonly deps: ConnectDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Onboarding step 1: a visible tab where the USER logs in. */
  async startLogin(serviceId: string): Promise<ConnectableService> {
    const service = serviceById(serviceId);
    if (!service) throw new Error(`unknown service: ${serviceId}`);
    await this.deps.openUserTab(service.loginUrl);
    return service;
  }

  /** Onboarding step 0 (optional): Chromium's own import-from-Chrome UI. */
  async startImportFromChrome(): Promise<void> {
    await this.deps.openUserTab(IMPORT_FROM_CHROME_URL);
  }

  /**
   * Probe one service in a throwaway agent tab. A login wall surfaces as
   * "needs_login" (the harness has already hard-stopped + notified); a
   * challenge as "challenge". Never throws past classification — health is a
   * report, not a run.
   */
  async checkSession(serviceId: string): Promise<SessionHealth> {
    const service = serviceById(serviceId);
    if (!service) throw new Error(`unknown service: ${serviceId}`);
    let state: SessionHealth["state"] = "unknown";
    let targetId: string | null = null;
    try {
      targetId = await this.harness.createAgentTab(`session health: ${service.id}`);
      const sample = await this.harness.navigate(targetId, service.healthUrl);
      const cls: PageClass = classifyPage(sample);
      state = cls === "ok" ? "healthy" : cls === "login" ? "needs_login" : "challenge";
    } catch (err) {
      if (err instanceof BrowserHardStopError) {
        state =
          err.kind === "login"
            ? "needs_login"
            : err.kind === "challenge"
              ? "challenge"
              : "unknown";
      }
    } finally {
      if (targetId) {
        await this.harness.closeAgentTab(targetId).catch(() => {});
      }
    }
    const result: SessionHealth = {
      service: service.id,
      checkedAt: this.now(),
      state,
    };
    this.health.set(service.id, result);
    return result;
  }

  lastHealth(): SessionHealth[] {
    return [...this.health.values()];
  }
}

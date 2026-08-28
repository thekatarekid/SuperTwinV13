// ===========================================================================
// Browser safety — build P3.4, spec §12.6 (ban-risk posture, code-enforced),
// evals BRW-01 (challenge = hard stop) and BRW-08 (login never automated).
//
// Everything here is CODE, not prompt: the challenge classifier runs on every
// page the harness loads; one challenge → the whole browser lane hard-stops,
// the source is paused (with a decisions row, reversible), and the user is
// notified with the evidence. `challenge_ignore = 0` and `login_automation =
// 0` are hard gates — so both stops throw and stay stopped until a human
// resumes. The kill-switch is a stored flag every harness action checks; the
// menu bar flips it through the /api/browser routes.
// ===========================================================================

import { appStateGet, appStateSet } from "../db/ingest.js";
import { writeDecision } from "../db/decisions.js";

export const BROWSER_KILL_SWITCH_KEY = "browser.kill_switch";
export const BROWSER_PAUSED_SOURCES_KEY = "browser.paused_sources";

// ---------------------------------------------------------------------------
// Challenge / login page classification (pure — testable against any HTML)
// ---------------------------------------------------------------------------

export type PageClass = "ok" | "challenge" | "login";

export interface PageSample {
  url: string;
  title: string;
  /** First few KB of body innerText — enough for every known interstitial. */
  bodyText: string;
  /** Whether the DOM holds a password input (login walls; BRW-08). */
  hasPasswordField?: boolean;
}

// Challenge interstitials: bot checks, checkpoints, rate walls. Matched on
// url, title and text. Deliberately broad — a false "challenge" costs one
// paused run; a miss is a hard-gate breach.
const CHALLENGE_URL = [
  /\/challenge/i,
  /\/checkpoint/i,
  /\/captcha/i,
  /\/sorry\//i, // google "unusual traffic"
  /\/cdn-cgi\/challenge-platform/i,
  /arkoselabs/i,
  /hcaptcha/i,
  /recaptcha/i,
  /__cf_chl/i,
];

const CHALLENGE_TEXT = [
  /verify (that )?you('| a)re (a )?human/i,
  /prove you('| a)re not a robot/i,
  /i('| a)m not a robot/i,
  /unusual (traffic|activity)/i,
  /suspicious activity/i,
  /security check/i,
  /checking your browser/i,
  /verify it'?s you/i,
  /complete the (security )?(check|challenge|captcha)/i,
  /confirm you('| a)re human/i,
  /attention required.*cloudflare/i,
  /access denied/i,
  /rate limited?/i,
  /too many requests/i,
  /\bcaptcha\b/i,
];

const LOGIN_URL = [
  /\/log-?in\b/i,
  /\/sign-?in\b/i,
  /\/accounts?\/login/i,
  /\/auth\//i,
  /\/session\/new/i,
  /\/i\/flow\/login/i, // x.com
  /accounts\.google\.com/i,
];

const LOGIN_TEXT = [
  /\b(log|sign) ?in to (continue|your account)/i,
  /session (has )?expired/i,
  /please (log|sign) ?in\b/i,
  /enter your password/i,
  /\byou('| a)re logged out\b/i,
];

/** Classify one loaded page. Challenge outranks login: a captcha inside a
 * login flow is still a challenge, and both halt anyway. */
export function classifyPage(sample: PageSample): PageClass {
  const { url, title, bodyText } = sample;
  const haystacks = [title, bodyText];
  if (
    CHALLENGE_URL.some((re) => re.test(url)) ||
    haystacks.some((h) => CHALLENGE_TEXT.some((re) => re.test(h)))
  ) {
    return "challenge";
  }
  if (
    LOGIN_URL.some((re) => re.test(url)) ||
    haystacks.some((h) => LOGIN_TEXT.some((re) => re.test(h))) ||
    sample.hasPasswordField === true
  ) {
    return "login";
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Errors the harness throws (and stays thrown)
// ---------------------------------------------------------------------------

export class BrowserHardStopError extends Error {
  constructor(
    readonly kind: "challenge" | "login" | "kill_switch" | "stopped",
    message: string,
  ) {
    super(message);
    this.name = "BrowserHardStopError";
  }
}

/** BRW-08: any code path that would put credentials into a page throws this. */
export class LoginAutomationError extends Error {
  constructor(detail: string) {
    super(`login is never automated (BRW-08): ${detail}`);
    this.name = "LoginAutomationError";
  }
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export interface BrowserNotice {
  at: number;
  kind: "challenge" | "login" | "kill_switch";
  site: string;
  message: string;
  /** Evidence: the page sample that triggered the stop. */
  sample?: PageSample;
}

export interface SafetyDeps {
  /** Kill-switch flag storage; defaults to app_state (DB). */
  getFlag?: (key: string) => string | null;
  setFlag?: (key: string, value: string) => void;
  /** Notify surface (menu bar / notices feed). */
  notify?: (notice: BrowserNotice) => void;
  /** Decisions-row writer (reversible pause); defaults to db writeDecision. */
  writeDecision?: typeof writeDecision;
  now?: () => number;
}

/**
 * One SafetyController guards one browser instance. `assertRunnable` is called
 * by EVERY harness action; after a hard stop nothing runs again until a human
 * calls `resume()` (BRW-01: "source paused until user reopens manually").
 */
export class SafetyController {
  private stoppedReason: BrowserNotice | null = null;
  private readonly notices: BrowserNotice[] = [];
  private readonly getFlag: (key: string) => string | null;
  private readonly setFlag: (key: string, value: string) => void;
  private readonly notifyFn: (notice: BrowserNotice) => void;
  private readonly decide: typeof writeDecision;
  private readonly now: () => number;

  constructor(deps: SafetyDeps = {}) {
    this.getFlag = deps.getFlag ?? ((k) => appStateGet(k) ?? null);
    this.setFlag = deps.setFlag ?? appStateSet;
    this.notifyFn = deps.notify ?? (() => {});
    this.decide = deps.writeDecision ?? writeDecision;
    this.now = deps.now ?? Date.now;
  }

  get killSwitch(): boolean {
    return this.getFlag(BROWSER_KILL_SWITCH_KEY) === "1";
  }

  setKillSwitch(on: boolean): void {
    this.setFlag(BROWSER_KILL_SWITCH_KEY, on ? "1" : "0");
  }

  get stopped(): BrowserNotice | null {
    return this.stoppedReason;
  }

  recentNotices(): BrowserNotice[] {
    return [...this.notices];
  }

  /** Every harness action calls this FIRST. */
  assertRunnable(): void {
    if (this.killSwitch) {
      throw new BrowserHardStopError(
        "kill_switch",
        "browser kill-switch is on — no agent browser activity",
      );
    }
    if (this.stoppedReason) {
      throw new BrowserHardStopError(
        "stopped",
        `browser is hard-stopped (${this.stoppedReason.kind} on ` +
          `${this.stoppedReason.site}) — resume manually`,
      );
    }
  }

  pausedSources(): string[] {
    const raw = this.getFlag(BROWSER_PAUSED_SOURCES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
    } catch {
      return [];
    }
  }

  isSourcePaused(site: string): boolean {
    return this.pausedSources().includes(site);
  }

  /**
   * BRW-01 / BRW-08: immediate halt. No retry, no solve attempt; the session
   * (profile) is preserved; the user is notified with the evidence; the source
   * is paused (decisions row, reversible). Throws so the in-flight run dies.
   */
  hardStop(kind: "challenge" | "login", site: string, sample: PageSample): never {
    const message =
      kind === "challenge"
        ? `${site} served a verification challenge — stopped immediately. ` +
          `Open the browser and complete it yourself; capture stays paused ` +
          `until you resume.`
        : `${site} needs you to sign in again — open the browser. The twin ` +
          `never types credentials; capture resumes after you log in.`;
    const notice: BrowserNotice = { at: this.now(), kind, site, message, sample };
    this.stoppedReason = notice;
    this.notices.push(notice);
    this.pauseSource(site, kind);
    this.notifyFn(notice);
    throw new BrowserHardStopError(kind, message);
  }

  /** Human pressed "resume" (or re-opened the source) — the only way back. */
  resume(site?: string): void {
    this.stoppedReason = null;
    const sources = this.pausedSources().filter((s) => site == null || s !== site);
    this.setFlag(BROWSER_PAUSED_SOURCES_KEY, JSON.stringify(sources));
  }

  private pauseSource(site: string, reason: string): void {
    const before = this.pausedSources();
    if (before.includes(site)) return;
    const after = [...before, site];
    this.setFlag(BROWSER_PAUSED_SOURCES_KEY, JSON.stringify(after));
    try {
      this.decide({
        pass: "code:browser-safety",
        targetKind: "source",
        targetId: `browser:${site}`,
        action: "pause",
        old: { paused: before },
        new: { paused: after },
        reason: `hard stop: ${reason} page on ${site}`,
      });
    } catch {
      // No DB in a unit-test context with injected flags — pause still holds.
    }
  }
}

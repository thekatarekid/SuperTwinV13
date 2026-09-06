// ===========================================================================
// Library › Screen — the three gates between "connected" and "capturing"
// (V6 P1 S6d / L4; Build §4.2 S1.3; Product_V6_Phase1 §2, §4).
//
// WHAT WAS BROKEN, and it was the whole capability. Screen capture could not
// be switched on at all in 13.11.5:
//
//   1. Nothing in the tree ever ASKED for Accessibility. Every path called
//      `AXIsProcessTrusted()`, which reports and registers nothing, so macOS
//      never listed SuperTwin in Privacy & Security › Accessibility. "Open
//      System Settings" dutifully opened a pane with no SuperTwin row in it —
//      the user's screenshot of a long list with no SuperTwin is exactly that.
//      An app appears in that list when, and only when, some process calls
//      AXIsProcessTrustedWithOptions with kAXTrustedCheckOptionPrompt.
//   2. Gate 1 (the consent row) and gate 3 (the explicit "Record from now on",
//      which is what actually spawns the sidecar — supervisor.ts answers
//      `not-armed` without it) had NO user interface anywhere. Even with the
//      permission granted by hand, capture would still not have started.
//
// So this is the ladder, with the live state of each rung read from the worker
// rather than assumed. It never claims a step is done that isn't, and never
// re-asks for one the user has already taken.
//
// Gate 3 stays a separate, deliberate press. Product_V6_Phase1 §2 lists Screen
// as "Allow", and Build §4.2 S1.3 is explicit that the sidecar spawns only on
// the user's own "Record from now on" — collapsing it into the permission
// grant would start recording as a side effect of a dialog, which is the one
// thing this flow exists to prevent.
// ===========================================================================

import { useEffect, useRef, useState } from "react";

import {
  confirmConsent,
  describeWorkerError,
  fetchScreenPermission,
  requestScreenPermission,
  startScreenRecording,
  type ScreenStatus,
} from "../../lib/api";
import { openExternal, requestAccessibility } from "../../lib/tauri";

/**
 * How often the card re-reads the real trust state while the permission rung
 * is open. The point is that ticking the row in System Settings flips this
 * panel over on its own — no restart, no "Check again". The worker memoises
 * the probe, so a tick here is not a process spawn.
 */
export const PERMISSION_POLL_MS = 2_000;

export type ScreenGateStep = "consent" | "permission" | "record" | "capturing";

const STEP_ORDER: readonly ScreenGateStep[] = ["consent", "permission", "record"];

const STEP_LABEL: Readonly<Record<string, string>> = {
  consent: "Allow screen capture",
  permission: "Grant Accessibility",
  record: "Record from now on",
};

/**
 * Which rung the flow is actually on, from the worker's own answer.
 *
 * A field the worker did not send is UNKNOWN, not false — the pane must not
 * demand a step it has no evidence is outstanding. `consent` and `recordFrom`
 * only arrived with S6d, so an older worker (or a status read that failed) is
 * judged on what it does report: permission, and whether the sidecar is up.
 */
export function screenGateStep(status: ScreenStatus | null): ScreenGateStep {
  if (!status) return "consent";
  if (status.consent === false) return "consent";
  if (status.permission !== true) return "permission";
  // `recordFrom` is the armed flag, `running` is the sidecar. Either one
  // missing means capture is not actually happening yet.
  const armed = status.recordFrom === undefined ? status.running : Boolean(status.recordFrom);
  if (!armed || !status.running) return "record";
  return "capturing";
}

/** The one honest sentence for a probe that failed for a reason of its own. */
export function permissionReasonLine(status: ScreenStatus | null): string | null {
  const reason = status?.permissionReason;
  if (!reason || reason === "granted" || reason === "denied") return null;
  if (reason === "binary-missing") {
    return "the screen watcher isn't installed in this build — reinstall SuperTwin";
  }
  if (reason === "probe-unsupported") {
    return "the installed screen watcher is older than this app — reinstall SuperTwin";
  }
  if (reason === "timeout" || reason === "no-answer" || reason === "spawn-failed") {
    return `the screen watcher didn't answer (${reason})`;
  }
  return reason;
}

interface GateActions {
  step: ScreenGateStep;
  /** The rung currently running, or null. */
  busy: ScreenGateStep | null;
  error: string | null;
  clearError: () => void;
  /** True once this session has asked macOS — the poll runs from here. */
  asked: boolean;
  /** Do the current rung's step. */
  act: () => void;
}

/**
 * The three rungs as actions, shared by the full card and the one-line notice
 * so there is exactly one implementation of "what happens when you press it".
 */
function useScreenGate(status: ScreenStatus | null, onChanged: () => void): GateActions {
  const step = screenGateStep(status);
  const [busy, setBusy] = useState<ScreenGateStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  // `onChanged` is called from a poll; hold it in a ref so a new identity on
  // every render does not restart the interval.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // ---- The poll that makes the tick land without a restart ----------------
  // Only while the permission rung is open, and only after the user started
  // the flow: an idle Library sub-tab has no business probing anything.
  useEffect(() => {
    if (step !== "permission" || !asked) return;
    let alive = true;
    const timer = setInterval(() => {
      void fetchScreenPermission()
        .then((p) => {
          if (alive && p.granted) changed.current();
        })
        .catch(() => {
          /* a failed poll is not news; the next tick tries again */
        });
    }, PERMISSION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [step, asked]);

  function run(which: ScreenGateStep, fn: () => Promise<void>): void {
    setBusy(which);
    setError(null);
    void fn()
      .catch((err: unknown) => setError(describeWorkerError(err)))
      .finally(() => {
        setBusy(null);
        changed.current();
      });
  }

  function act(): void {
    if (busy !== null) return;
    if (step === "consent") {
      // Gate 1 — the consent row. Screen is live-only: understand from now.
      run("consent", async () => {
        await confirmConsent({
          source: "screen",
          index_all: true,
          index_from: null,
          understand_from: new Date().toISOString(),
        });
      });
      return;
    }
    if (step === "permission") {
      // Gate 2 — THE ASK, and only then the deep link.
      //
      // The order is the fix. Opening the pane before anything has asked is
      // what the old button did, and it is why the user found a list of other
      // apps with no SuperTwin in it. The host app asks when we are inside it
      // (the row then carries the app's own identity, name and icon); the
      // worker route is the fallback and lands on the same row, because TCC
      // attributes the sidecar's ask to its responsible process — this app.
      run("permission", async () => {
        const host = await requestAccessibility();
        if (!host) await requestScreenPermission();
        setAsked(true);
        try {
          await openExternal(status?.settingsUrl ?? "");
        } catch (err) {
          // Failing to OPEN Settings is not failing to ask: the row exists
          // either way, so say where it is instead of reporting a dead end.
          setError(
            "SuperTwinV13 is now listed in System Settings › Privacy & Security › " +
              `Accessibility — open it and switch it on. (${describeWorkerError(err)})`,
          );
        }
      });
      return;
    }
    if (step === "record") {
      // Gate 3 — the explicit record. This is what spawns the sidecar.
      run("record", async () => {
        await startScreenRecording();
      });
    }
  }

  return { step, busy, error, clearError: () => setError(null), asked, act };
}

function actionLabel(step: ScreenGateStep, busy: ScreenGateStep | null, asked: boolean): string {
  if (busy === "consent") return "allowing…";
  if (busy === "permission") return "asking macOS…";
  if (busy === "record") return "starting…";
  if (step === "permission") return asked ? "Open System Settings again" : "Grant Accessibility";
  return STEP_LABEL[step] ?? "Continue";
}

/**
 * The full card, shown when the pane has nothing to show behind it: the ladder,
 * the current rung's button, and what the step means.
 */
export function ScreenGate(props: {
  status: ScreenStatus | null;
  /** Re-read the panel: the gate changed something the panel renders. */
  onChanged: () => void;
}): JSX.Element | null {
  const { status, onChanged } = props;
  const g = useScreenGate(status, onChanged);
  if (g.step === "capturing") return null;

  const at = STEP_ORDER.indexOf(g.step);
  const reasonLine = permissionReasonLine(status);

  return (
    <section className="card connect-card screen-gate" aria-label="connect Screen">
      <div className="connect-glyph" aria-hidden="true">
        ⬡
      </div>
      <h2 className="connect-title">
        {g.step === "consent"
          ? "Read what's on your screen"
          : g.step === "permission"
            ? "Grant Accessibility to SuperTwin"
            : "Start recording from now on"}
      </h2>
      <p className="connect-body">
        {g.step === "consent"
          ? "SuperTwin reads the accessibility tree of your front window — app, title, document and text. No screenshots, no recording, nothing sent anywhere. Password managers, secret fields and private windows are never read."
          : g.step === "permission"
            ? "macOS gates this behind the Accessibility permission. Granting it adds SuperTwinV13 to System Settings › Privacy & Security › Accessibility; switch it on there and this panel picks it up on its own."
            : "Accessibility is granted and nothing is being captured yet. Screen capture is live only — it starts the moment you press this, and never reaches backwards."}
      </p>

      <ol className="gate-steps" aria-label="steps">
        {STEP_ORDER.map((s, i) => (
          <li
            key={s}
            className={`gate-step${i < at ? " done" : i === at ? " current" : ""}`}
            aria-current={i === at ? "step" : undefined}
          >
            <span className="gate-step-mark" aria-hidden="true">
              {i < at ? "✓" : "○"}
            </span>
            {STEP_LABEL[s]}
          </li>
        ))}
      </ol>

      <div className="btn-row">
        <button type="button" className="btn primary" disabled={g.busy !== null} onClick={g.act}>
          {actionLabel(g.step, g.busy, g.asked)}
        </button>
        {g.step === "permission" && (
          <button type="button" className="btn" disabled={g.busy !== null} onClick={onChanged}>
            Check again
          </button>
        )}
      </div>

      <p className="connect-note">
        {g.step === "permission" && g.asked
          ? "Waiting for the switch — this panel re-checks every couple of seconds. If SuperTwinV13 is listed but off, switch it on. If it is listed from an older build, remove it with − and grant it again: this app is ad-hoc signed, so macOS reads each build as a different program."
          : g.step === "record"
            ? "privacy: pause any time · blocklist an app · delete a span (honest delete)"
            : "Screen capture is live only — it never reads your past. Pause it, blocklist an app, or delete any span at any time."}
      </p>

      {reasonLine && (
        <p className="error" role="alert">
          {reasonLine}
        </p>
      )}
      {g.error && (
        <p className="error" role="alert">
          {g.error}{" "}
          <button type="button" className="linklike" onClick={g.clearError}>
            dismiss
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * The same ladder as one line, for when the pane HAS captures to show. Old
 * captures are the user's own history and must not be hidden behind a card —
 * but "capture is off" is still news, and the way to fix it belongs next to
 * the sentence that says so, not in a deep link that goes nowhere useful.
 */
export function ScreenGateNotice(props: {
  status: ScreenStatus | null;
  onChanged: () => void;
}): JSX.Element | null {
  const { status, onChanged } = props;
  const g = useScreenGate(status, onChanged);
  if (g.step === "capturing") return null;

  return (
    <p className="source-notice" role="status">
      {g.step === "consent"
        ? "Screen capture isn't switched on. What's below is what was captured before."
        : g.step === "permission"
          ? "Capture is blocked: the macOS Accessibility permission is off, so nothing new is being read. What's below is what was captured before."
          : "Accessibility is granted, but recording hasn't been started. Nothing new is being read."}{" "}
      <button type="button" className="linklike" disabled={g.busy !== null} onClick={g.act}>
        {actionLabel(g.step, g.busy, g.asked)}
      </button>
      {g.error && (
        <>
          {" "}
          <span className="error">{g.error}</span>
        </>
      )}
    </p>
  );
}

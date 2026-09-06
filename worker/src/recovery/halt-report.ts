// ===========================================================================
// The halt says so at BOOT (V6 P1 S6e · E2, second half).
//
// WHAT WAS BROKEN. `app_state.budget_tripped_at` never clears on its own — not
// on the hour, not on restart. That is deliberate (SPD-02), and it means a
// latched home comes back up latched: the user quits the app on a paused
// pipeline and relaunches into the same paused pipeline. The user's install
// still carries a latch from 2026-09-06T17:38:06.843Z.
//
// 13.11.6 fixed the in-app half of this: `HaltBanner` renders on every tab off
// its own three-key read, and one tap resumes (FIX-C3), with the hour forgiven
// so the resume is not instantly re-latched (FIX-C1). What was still silent is
// the FIRST MINUTE and the OPERATOR LOG. The spend heartbeat only speaks after
// sixty seconds, and only says BLOCKED once something has actually been
// refused; a lane's `[budget] HELD` line waits for that lane's first tick. So
// `worker.log` opened right after a relaunch reads exactly like a healthy
// boot, which is the same class of silence the whole C-series was about.
//
// THE RULE. One line at boot, always, before anything else can ask to spend:
// what the switches say, what the windows hold, and — when something is
// holding — the way out, named. Absence of a halt is stated too, because "no
// line" and "no halt" must not be the same evidence.
// ===========================================================================

import { backgroundModelHold, budgetStatus, type BudgetStatus } from "../providers/budget.js";

export interface HaltReport {
  held: boolean;
  kind: "kill-switch" | "budget" | null;
  since: string | null;
  line: string;
  status: BudgetStatus;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The boot line. Pure: no writes, three `app_state` reads plus the ledger, so
 * it costs the same as `/api/ops/spend` and can run before the listener.
 */
export function haltReport(now: number = Date.now()): HaltReport {
  const status = budgetStatus(now);
  const hold = backgroundModelHold();
  const windows =
    `hour ${status.hour.calls}/${status.ceilings.callsPerHour} calls · ` +
    `${money(status.hour.usd)}/${money(status.ceilings.usdPerHour)}; ` +
    `day ${status.day.calls}/${status.ceilings.callsPerDay} calls · ` +
    `${money(status.day.usd)}/${money(status.ceilings.usdPerDay)}`;
  if (!hold.held) {
    return { held: false, kind: null, since: null, status, line: `[budget] running — ${windows}` };
  }
  const way =
    hold.kind === "kill-switch"
      ? 'Turn "Stop all model activity" back on in the app, or POST /api/ops/model-activity {"paused":false}.'
      : "Resume from the banner on any tab in the app, or POST /api/ops/budget/reset.";
  return {
    held: true,
    kind: hold.kind,
    since: hold.since,
    status,
    line:
      `[budget] HALTED AT BOOT — ${hold.label}. Background understanding is paused: ` +
      `nothing new will be learned until this is cleared. ${way} (${windows})`,
  };
}

/** Say it, once, at boot. Returns the report so the caller can assert on it. */
export function reportHaltOnBoot(
  log: (line: string) => void = (l) => console.error(l),
  now: number = Date.now(),
): HaltReport {
  const report = haltReport(now);
  log(report.line);
  return report;
}

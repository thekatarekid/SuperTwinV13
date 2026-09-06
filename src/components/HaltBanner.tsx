// ===========================================================================
// The halt banner — when the understanding pipeline is stopped, say so HERE
// (V6 P1 S6d · C3).
//
// WHAT WAS BROKEN. On the user's 13.11.5 install the pipeline ran hard for
// forty-one minutes, spent the $3 hourly ceiling, latched
// `app_state.budget_tripped_at` — a latch that by design never clears on its
// own, not on the hour, not on restart — and from then on threw
// BUDGET_EXCEEDED at the gate before every spawn. Five spaces, 265 episodes
// and 8 tasks in, understanding simply stopped.
//
// Nothing told the user. The trip was surfaced in exactly one place in the
// whole product — Settings › General — and the only reset control was the
// button beside it. That panel is gated on /api/settings/general, which was
// measured at 11.2 s on the user's own worker while an import held the
// database; the user reported it "stuck on loading". The one screen that could
// explain the app's state, and the one control that could restore it, were
// behind the slowest read in the app. Meanwhile Home said "nothing needs you
// right now" and the freshness chip said "caught up".
//
// THE CONTRACT. A state that stops background understanding announces itself
// on every tab, carries the reason and the time, and offers the way out in the
// same breath. Specifically:
//
//   * its own tiny read (/api/ops/spend — three app_state gets), never gated
//     behind a panel, a screen, or any aggregate query;
//   * `unknown` renders nothing: absence of the banner is the normal state,
//     so painting one before the answer arrives would be its own lie;
//   * a failed poll never ERASES a halt we already know about — the last known
//     answer stands until a newer one replaces it;
//   * not dismissible while the halt stands. Dismissing it would put the app
//     back to claiming everything is fine, which is the bug;
//   * the kill switch outranks the budget latch, because it stops strictly
//     more (the bar included).
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import {
  describeWorkerError,
  fetchSpend,
  resetBudgetLatch,
  setModelActivityPaused,
  type SpendStatus,
} from "../lib/api";

/** How often the banner re-asks. Cheap read; the halt can start any minute. */
export const HALT_POLL_MS = 30_000;

/**
 * A timestamp in the reader's own clock. The worker stores UTC; the user who
 * saw this trip lives at UTC+5:30, so the naive `slice(0, 16)` this product
 * uses elsewhere would have told them it happened five and a half hours before
 * it did.
 */
export function formatWhen(iso: string, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  });
}

interface Halt {
  kind: "kill-switch" | "budget";
  headline: string;
  detail: string;
  /** The extra sentence that keeps a resume from looking broken. */
  caution: string | null;
  action: string;
  run: () => Promise<SpendStatus>;
}

/** Which halt, if any, the spend status describes. Exported for the tests. */
export function haltOf(spend: SpendStatus | null): Halt | null {
  if (!spend) return null;

  // The kill switch first: it is the human's own hard stop and it blocks more
  // than the latch does — the bar and chat included.
  if (spend.modelActivityPausedAt) {
    return {
      kind: "kill-switch",
      headline: "Model activity is off",
      detail:
        `“Stop all model activity” has been on since ${formatWhen(spend.modelActivityPausedAt)}. ` +
        "Nothing is sent to the model — not the background pipeline, not the bar — until you switch it back.",
      caution: null,
      action: "Turn model activity back on",
      run: () => setModelActivityPaused(false),
    };
  }

  if (spend.trippedAt) {
    const hot = spend.hour.usd >= spend.ceilings.usdPerHour;
    return {
      kind: "budget",
      headline: "Understanding is paused — the spend ceiling was reached",
      detail:
        `${spend.trippedReason ?? "a spend ceiling was breached"} · stopped ${formatWhen(spend.trippedAt)}. ` +
        "Nothing new is being learned in the background until you resume. The bar still answers.",
      caution: hot
        ? `The last hour still holds $${spend.hour.usd.toFixed(2)} of the $${spend.ceilings.usdPerHour.toFixed(2)} ceiling, ` +
          "so work may stop again until that rolls off."
        : null,
      action: "Resume background work",
      run: () => resetBudgetLatch(),
    };
  }

  return null;
}

/**
 * Rendered above the screen on every tab. Null — nothing at all — whenever the
 * pipeline is not halted, or while we do not yet know.
 */
export function HaltBanner(): JSX.Element | null {
  const [spend, setSpend] = useState<SpendStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      setSpend(await fetchSpend());
    } catch {
      // A read that did not answer is not evidence the halt ended. Keep the
      // last known state rather than clearing a warning we cannot re-confirm.
    }
  }, []);

  useEffect(() => {
    void read();
    const t = setInterval(() => void read(), HALT_POLL_MS);
    return () => clearInterval(t);
  }, [read]);

  const halt = haltOf(spend);
  if (!halt) return null;

  const resume = async (): Promise<void> => {
    setBusy(true);
    setFailed(null);
    try {
      setSpend(await halt.run());
    } catch (err) {
      setFailed(describeWorkerError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`halt-banner halt-${halt.kind}`} role="alert" aria-label="pipeline halted">
      <div className="halt-text">
        <strong>{halt.headline}</strong>
        <span className="meta">{halt.detail}</span>
        {halt.caution && <span className="meta halt-caution">{halt.caution}</span>}
        {failed && <span className="error">{halt.action.toLowerCase()} failed — {failed}</span>}
      </div>
      <button type="button" className="btn" onClick={() => void resume()} disabled={busy}>
        {busy ? "resuming…" : halt.action}
      </button>
    </div>
  );
}

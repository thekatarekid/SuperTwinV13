// ===========================================================================
// Nudge card — V6 P1 S4.3 (Build §7.1; Product_V6_Phase1 §18.3;
// Product_V6 §14.4.1). Top-right on the Mac, ONE at a time, and the same card
// inside the overlay.
//
// The anatomy is fixed and short, because the whole design rests on a card
// costing at most a glance:
//
//   space chip → INTENT LINE ("Saw you comparing Anjuna villas")
//              → WHAT I DID (one line per merged item, " · " between them)
//              → ARTIFACT PEEK
//              → [ Open ] [ Not now ] ✕
//
// It AUTO-CLOSES after Settings › Assist › card duration (60 s) and has a
// close button. Closing loses nothing: the artifact is already in the panel,
// on the Prepared shelf, in its space and on the timeline, and the menu-bar
// icon carries it as UNREAD until it is opened. That counter is what makes
// closing free.
//
// This window does not decide WHETHER anything shows. It polls
// /api/surfaces/nudge and renders whatever `surface-router.v1` put on the
// card — presence, merging, the decay order, blocked kinds and the intent
// floor are all the router's, in the worker, where they are tested.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchSurfaceNudge,
  nudgeAutoClose,
  nudgeNotNow,
  nudgeOpened,
  nudgeShown,
  type NudgeCardView,
} from "../lib/api";
import { hideNudgeWindow, openMainWindow, showNudgeWindow } from "../lib/tauri";

export const NUDGE_POLL_MS = 8_000;
/** The doc's number; the worker's card_duration_s overrides it per poll. */
export const CARD_DURATION_MS = 60_000;

export function Nudge(): JSX.Element {
  const [card, setCard] = useState<NudgeCardView | null>(null);
  const [unread, setUnread] = useState(0);
  // Ids already shown: a card goes up ONCE. It never pops again.
  const shown = useRef<Set<string>>(new Set());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  /** Take the card down. `keep` = the 60-second close / the ✕: nothing lost. */
  const close = useCallback(
    (id: string | null, keep: boolean) => {
      clearTimer();
      setCard(null);
      void hideNudgeWindow();
      if (id && keep) void nudgeAutoClose(id).then((r) => setUnread(r.unread)).catch(() => {});
    },
    [clearTimer],
  );

  const poll = useCallback(async () => {
    try {
      const view = await fetchSurfaceNudge();
      setUnread(view.unread);
      const next = view.card;
      if (!next || shown.current.has(next.id)) return;
      shown.current.add(next.id);
      setCard(next);
      await showNudgeWindow();
      // Unread from the moment it goes up — "shown but not opened".
      await nudgeShown(next.id)
        .then((r) => setUnread(r.unread))
        .catch(() => {});
      clearTimer();
      closeTimer.current = setTimeout(() => close(next.id, true), view.cardDurationMs || CARD_DURATION_MS);
    } catch {
      // Worker offline: quietly try again next poll.
    }
  }, [clearTimer, close]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), NUDGE_POLL_MS);
    return () => {
      clearInterval(timer);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [poll]);

  if (!card) {
    return (
      <div className="nudge-empty" data-testid="nudge-empty" data-unread={unread}>
        {unread > 0 ? <span className="nudge-unread">{unread}</span> : null}
      </div>
    );
  }

  async function onOpen(): Promise<void> {
    if (!card) return;
    await nudgeOpened(card.id)
      .then((r) => setUnread(r.unread))
      .catch(() => {});
    await openMainWindow();
    close(null, false);
  }

  async function onNotNow(): Promise<void> {
    if (!card) return;
    // A graded negative: ranks this kind down, parks the work in Prepared.
    await nudgeNotNow(card.id)
      .then((r) => setUnread(r.unread))
      .catch(() => {});
    close(null, false);
  }

  const merged = card.mergedWith.length;

  return (
    <div className="nudge" data-testid="nudge" role="alert" data-kind={card.kind}>
      <div className="nudge-chip">
        ◆ {card.title}
        {merged > 0 ? <span className="nudge-merged"> · {merged + 1} updates</span> : null}
      </div>
      <div className="nudge-intent">{card.intent}</div>
      <div className="nudge-did">{card.line}</div>
      {card.peek && <div className="nudge-peek">{card.peek}</div>}
      <div className="nudge-actions">
        <button type="button" onClick={() => void onOpen()}>
          Open
        </button>
        <button type="button" onClick={() => void onNotNow()}>
          Not now
        </button>
        <button type="button" aria-label="close" onClick={() => close(card.id, true)}>
          ✕
        </button>
      </div>
    </div>
  );
}

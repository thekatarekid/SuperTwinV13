// ===========================================================================
// Nudge window — build P2.3, spec §14.7 nudge anatomy. Transient top-right
// card, ONE at a time, auto-minimizes into the panel's Prepared list.
//
// Fixed anatomy: space/chapter chip → intent line ("Saw you…") → what I did →
// artifact peek → [ Open ] [ Not now ] ✕. "Not now" = graded negative that
// parks the artifact in Prepared; ✕ = stronger negative, still kept (nothing
// vanishes). Never a question for auto-class work — the work is already done.
//
// This window's React polls /api/assist/nudge; when a NEW unseen artifact
// appears it asks Rust to show the (non-focusing) window, and hides it again
// on action or after the auto-minimize timer.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  artifactDismiss,
  artifactSeen,
  artifactSignal,
  fetchNudge,
  type ArtifactRow,
} from "../lib/api";
import { hideNudgeWindow, openMainWindow, showNudgeWindow } from "../lib/tauri";

export const NUDGE_POLL_MS = 8_000;
export const AUTO_MINIMIZE_MS = 15_000;

/** First artifact-body section line, as the peek (best-effort). */
export function peekOf(artifact: ArtifactRow): string | null {
  try {
    const body = JSON.parse(artifact.bodyJson ?? "null") as {
      sections?: { tool: string; content: string }[];
    } | null;
    const draft = body?.sections?.find((s) => s.tool === "draft") ?? body?.sections?.[0];
    if (!draft) return null;
    const line = draft.content.split("\n").find((l) => l.trim() !== "");
    return line ? line.slice(0, 90) : null;
  } catch {
    return null;
  }
}

export function Nudge(): JSX.Element {
  const [artifact, setArtifact] = useState<ArtifactRow | null>(null);
  // Ids already shown: an artifact minimizes ONCE; it never pops again.
  const shown = useRef<Set<string>>(new Set());
  const minimizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const minimize = useCallback(() => {
    if (minimizeTimer.current) clearTimeout(minimizeTimer.current);
    minimizeTimer.current = null;
    setArtifact(null);
    void hideNudgeWindow();
  }, []);

  const poll = useCallback(async () => {
    try {
      const { artifact: next } = await fetchNudge();
      if (!next || shown.current.has(next.id)) return;
      shown.current.add(next.id);
      setArtifact(next);
      await showNudgeWindow();
      if (minimizeTimer.current) clearTimeout(minimizeTimer.current);
      minimizeTimer.current = setTimeout(minimize, AUTO_MINIMIZE_MS);
    } catch {
      // Worker offline: quietly try again next poll.
    }
  }, [minimize]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), NUDGE_POLL_MS);
    return () => {
      clearInterval(timer);
      if (minimizeTimer.current) clearTimeout(minimizeTimer.current);
    };
  }, [poll]);

  if (!artifact) return <div className="nudge-empty" data-testid="nudge-empty" />;

  const peek = peekOf(artifact);

  async function onOpen(): Promise<void> {
    if (!artifact) return;
    await artifactSeen(artifact.id).catch(() => {});
    await openMainWindow();
    minimize();
  }

  async function onNotNow(): Promise<void> {
    if (!artifact) return;
    // Graded negative: parks in Prepared as SEEN (kept, dot cleared).
    await artifactSignal(artifact.id, "ignored").catch(() => {});
    await artifactSeen(artifact.id).catch(() => {});
    minimize();
  }

  async function onDismiss(): Promise<void> {
    if (!artifact) return;
    // Stronger negative: dismissed, still kept in the "older" drawer.
    await artifactDismiss(artifact.id).catch(() => {});
    minimize();
  }

  return (
    <div className="nudge" data-testid="nudge" role="alert">
      <div className="nudge-chip">
        ◆ {artifact.spaceId ? artifact.spaceId : (artifact.kind || "prepared")}
      </div>
      <div className="nudge-intent">{artifact.intent ?? artifact.title}</div>
      {artifact.summary && <div className="nudge-did">{artifact.summary}</div>}
      {peek && <div className="nudge-peek">{peek}</div>}
      <div className="nudge-actions">
        <button type="button" onClick={() => void onOpen()}>
          Open
        </button>
        <button type="button" onClick={() => void onNotNow()}>
          Not now
        </button>
        <button type="button" aria-label="dismiss" onClick={() => void onDismiss()}>
          ✕
        </button>
      </div>
    </div>
  );
}

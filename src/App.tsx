// ===========================================================================
// SuperTwinV13 shell — build P1.7 (spec §14.1, §14.2, §14.4, §14.6).
//
// Translucent liquid-glass main window: top-center pill nav (Home · Timeline
// · Library · Settings, ⌘1-4), the Home sections, the one modal system, the
// grounded bar (collapsed + context-locked states), and the feedback loop —
// every correction path (drag, chips, "Tell the twin") posts through
// /api/corrections and surfaces an undo chip.
//
// Esc walks back one layer (menu → modal → bar lock → hide the window; the
// Rust side owns summoning via double-tap right-⌘ / ⌘⇧S).
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  approveProposal,
  artifactDismiss,
  artifactGraduate,
  artifactSeen,
  artifactSignal,
  fetchArtifacts,
  fetchHome,
  postCorrection,
  rejectProposal,
  undoCorrection,
  type ArtifactRow,
  type ClaimRow,
  type HomeData,
  type SpaceRow,
  type TargetKind,
  type TaskRow,
} from "./lib/api";
import { hideMainWindow } from "./lib/tauri";
import { FreshnessChip } from "./components/FreshnessChip";
import { AccessibilityOnboarding } from "./components/AccessibilityOnboarding";
import { GroundedBar, type BarLock } from "./components/GroundedBar";
import { ModalFrame, parseEvidence } from "./components/Modal";
import { Home } from "./screens/Home";
import { Library } from "./screens/Library";
import { Settings, Timeline } from "./screens/Stubs";
import { ProposalModal } from "./modals/ProposalModal";
import { SpaceModal } from "./modals/SpaceModal";
import { TaskModal } from "./modals/TaskModal";

const TABS = [
  { id: "home", label: "⌂ Home" },
  { id: "timeline", label: "◷ Timeline" },
  { id: "library", label: "▤ Library" },
  { id: "settings", label: "⚙ Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type ModalState =
  | { type: "task"; task: TaskRow }
  | { type: "space"; space: SpaceRow }
  | { type: "proposal"; proposal: SpaceRow }
  | { type: "claim"; claim: ClaimRow }
  | { type: "artifact"; artifact: ArtifactRow };

interface UndoChip {
  correctionId: string;
  summary: string;
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<TabId>("home");
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [lock, setLock] = useState<BarLock | null>(null);
  const [undo, setUndo] = useState<UndoChip | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchHome());
      setError(null);
    } catch {
      setError("worker unreachable");
    }
    // The "Prepared for you" shelf (spec §14.7.8) rides the same refresh;
    // a failure leaves the shelf as-is rather than erroring the shell.
    try {
      const { artifacts: rows } = await fetchArtifacts();
      setArtifacts(rows.filter((a) => a.status === "new" || a.status === "seen"));
    } catch {
      // keep the previous shelf
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Esc walks back one layer; ⌘1-4 switch tabs (spec §14.1.3).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        if (modal) setModal(null);
        else if (lock) setLock(null);
        else void hideMainWindow();
        return;
      }
      if (e.metaKey && e.key >= "1" && e.key <= "4") {
        const next = TABS[Number(e.key) - 1];
        if (next) {
          e.preventDefault();
          setTab(next.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, lock]);

  /** One correction dispatcher for every path (spec §14.4.5). */
  const correct = useCallback(
    async (target: { kind: TargetKind; id: string }, structured: Record<string, unknown>) => {
      try {
        const result = await postCorrection({ target, structured });
        if (result.decision_id) {
          setUndo({ correctionId: result.correction_id, summary: result.summary });
        }
        await refresh();
      } catch {
        setError("correction failed");
      }
    },
    [refresh],
  );

  const tellTwin = useCallback(
    async (barLock: BarLock, utterance: string): Promise<string> => {
      try {
        const result = await postCorrection({ target: { kind: barLock.kind, id: barLock.id }, utterance });
        if (result.decision_id) {
          setUndo({ correctionId: result.correction_id, summary: result.summary });
        }
        await refresh();
        return result.status === "applied" ? `${result.summary} ✓` : result.summary;
      } catch {
        return "couldn't reach the worker";
      }
    },
    [refresh],
  );

  function lockTo(kind: TargetKind, id: string, label: string): void {
    setModal(null);
    setLock({ kind, id, label });
  }

  async function handleUndo(chip: UndoChip): Promise<void> {
    try {
      await undoCorrection(chip.correctionId);
      setUndo(null);
      await refresh();
    } catch {
      setError("undo failed");
    }
  }

  async function resolveProposal(proposal: SpaceRow, verdict: "approve" | "reject"): Promise<void> {
    try {
      await (verdict === "approve" ? approveProposal(proposal.id) : rejectProposal(proposal.id));
      setModal(null);
      await refresh();
    } catch {
      setError(`${verdict} failed`);
    }
  }

  // Opening a nudge artifact clears the ● dot EVERYWHERE (spec §14.7.8) —
  // one artifact, one status, three surfaces.
  const openArtifact = useCallback(
    async (artifact: ArtifactRow) => {
      if (artifact.status === "new") {
        await artifactSeen(artifact.id).catch(() => {});
      } else {
        await artifactSignal(artifact.id, "opened_dwelled").catch(() => {});
      }
      setModal({ type: "artifact", artifact });
      await refresh();
    },
    [refresh],
  );

  async function artifactAction(artifact: ArtifactRow, verb: "dismiss" | "graduate"): Promise<void> {
    try {
      if (verb === "dismiss") await artifactDismiss(artifact.id);
      else await artifactGraduate(artifact.id);
      setModal(null);
      await refresh();
    } catch {
      setError(`${verb} failed`);
    }
  }

  // The newest unseen nudge — the grounded bar's idle chip + shelf pulse.
  const freshNudge = artifacts.find((a) => a.status === "new") ?? null;

  return (
    <div className="shell">
      <div className="nav-row">
        <nav className="pill-nav" aria-label="primary">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <FreshnessChip />
      </div>

      <AccessibilityOnboarding />

      <main className="screen">
        {tab === "home" && (
          <Home
            data={data}
            error={error}
            prepared={artifacts}
            onOpenArtifact={(a) => void openArtifact(a)}
            onOpenTask={(task) => setModal({ type: "task", task })}
            onOpenSpace={(space) => setModal({ type: "space", space })}
            onOpenProposal={(proposal) => setModal({ type: "proposal", proposal })}
            onOpenClaim={(claim) => setModal({ type: "claim", claim })}
            onDragMove={(target, toSpaceId) =>
              void correct(target, { type: "move", to_space_id: toSpaceId })
            }
          />
        )}
        {tab === "timeline" && <Timeline />}
        {tab === "library" && <Library />}
        {tab === "settings" && <Settings />}
      </main>

      {modal?.type === "task" && (
        <TaskModal
          task={modal.task}
          spaces={data?.spaces ?? []}
          onCorrection={(s) => void correct({ kind: "task", id: modal.task.id }, s)}
          onTellTwin={() => lockTo("task", modal.task.id, modal.task.title)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "space" && (
        <SpaceModal
          space={modal.space}
          tasks={data?.today ?? []}
          nudge={artifacts.find((a) => a.spaceId === modal.space.id && a.status === "new") ?? null}
          onOpenNudge={(a) => void openArtifact(a)}
          onCorrection={(s) => void correct({ kind: "space", id: modal.space.id }, s)}
          onTellTwin={() => lockTo("space", modal.space.id, modal.space.label)}
          onClose={() => setModal(null)}
          onOpenTask={(task) => setModal({ type: "task", task })}
        />
      )}
      {modal?.type === "proposal" && (
        <ProposalModal
          proposal={modal.proposal}
          onApprove={() => void resolveProposal(modal.proposal, "approve")}
          onDismiss={() => void resolveProposal(modal.proposal, "reject")}
          onCorrection={(s) => void correct({ kind: "space", id: modal.proposal.id }, s)}
          onTellTwin={() => lockTo("space", modal.proposal.id, modal.proposal.label)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "claim" && (
        <ModalFrame
          title={modal.claim.text ?? modal.claim.claim_key}
          typeChip={modal.claim.kind ?? "claim"}
          objectType="claim"
          targetKind="claim"
          targetId={modal.claim.claim_key}
          evidence={parseEvidence(modal.claim.evidence_json)}
          onCorrection={(s) => void correct({ kind: "claim", id: modal.claim.claim_key }, s)}
          onTellTwin={() => lockTo("claim", modal.claim.claim_key, modal.claim.text ?? modal.claim.claim_key)}
          onClose={() => setModal(null)}
        >
          {modal.claim.confidence != null && (
            <p style={{ color: "var(--ink-2)" }}>
              confidence {modal.claim.confidence.toFixed(2)} · stated {modal.claim.stated_at}
            </p>
          )}
        </ModalFrame>
      )}

      {modal?.type === "artifact" && (
        <div className="modal-scrim" onClick={() => setModal(null)} data-testid="modal-scrim">
          <section
            className="modal"
            role="dialog"
            aria-label={modal.artifact.title}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2 className="title">{modal.artifact.title}</h2>
              <span className="chip">◆ {modal.artifact.kind}</span>
              {modal.artifact.spaceId && <span className="chip">{modal.artifact.spaceId}</span>}
            </header>
            {modal.artifact.summary && <p>{modal.artifact.summary}</p>}
            {modal.artifact.reasoning && (
              <p style={{ color: "var(--ink-2)" }}>{modal.artifact.reasoning}</p>
            )}
            <footer>
              <button
                type="button"
                className="linklike"
                onClick={() => void artifactAction(modal.artifact, "graduate")}
              >
                make it a task
              </button>
              <button
                type="button"
                className="linklike"
                onClick={() => void artifactAction(modal.artifact, "dismiss")}
              >
                dismiss
              </button>
              <button type="button" className="linklike" onClick={() => setModal(null)}>
                close
              </button>
            </footer>
          </section>
        </div>
      )}

      {undo && (
        <div className="undo-toast" role="status">
          <span>{undo.summary}</span>
          <button type="button" className="linklike" onClick={() => void handleUndo(undo)}>
            undo
          </button>
          <button type="button" className="linklike" aria-label="dismiss" onClick={() => setUndo(null)}>
            ✕
          </button>
        </div>
      )}

      <GroundedBar
        lock={lock}
        onUnlock={() => setLock(null)}
        onTellTwin={tellTwin}
        nudge={freshNudge}
        onOpenNudge={(a) => void openArtifact(a)}
        onNudgeTyped={(a) => void artifactSignal(a.id, "ignored").catch(() => {})}
      />
    </div>
  );
}

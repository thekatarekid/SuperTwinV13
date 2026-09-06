// ===========================================================================
// SuperTwinV13 shell — build P1.7 (spec §14.1, §14.2, §14.4, §14.6).
//
// Translucent liquid-glass main window: top-center pill nav (Home · Spaces ·
// Calendar · Timeline · Library · People · Settings, ⌘1-N), the Home sections,
// the one modal system, the
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
  describeWorkerError,
  fetchArtifacts,
  fetchHome,
  fetchTaskRun,
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
import { Calendar } from "./screens/Calendar";
import { Home } from "./screens/Home";
import { Library } from "./screens/Library";
import { People } from "./screens/People";
import { Timeline } from "./screens/Timeline";
import { Settings } from "./screens/Settings";
import { Spaces } from "./screens/Spaces";
import { ArtifactModal } from "./modals/ArtifactModal";
import { ClaimModal } from "./modals/ClaimModal";
import { ProposalModal } from "./modals/ProposalModal";
import { SpaceModal } from "./modals/SpaceModal";
import { TaskModal } from "./modals/TaskModal";

const TABS = [
  { id: "home", label: "⌂ Home" },
  // V6 P1 S5.1: spaces by life area, with the why-panel and drag to re-file.
  { id: "spaces", label: "◈ Spaces" },
  // V6 P1 S5.3: the derived calendar — four layers, shown alone or together.
  { id: "calendar", label: "▦ Calendar" },
  { id: "timeline", label: "◷ Timeline" },
  { id: "library", label: "▤ Library" },
  { id: "people", label: "◍ People" },
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
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchHome());
      setError(null);
    } catch (err) {
      // W3: name the failure the worker actually had. "worker unreachable" is
      // only true when nothing is listening on the port.
      setError(describeWorkerError(err));
    } finally {
      setLoading(false);
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

  // Esc walks back one layer; ⌘1-N switch tabs (spec §14.1.3).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        if (modal) setModal(null);
        else if (lock) setLock(null);
        else void hideMainWindow();
        return;
      }
      if (e.metaKey && e.key >= "1" && e.key <= String(TABS.length)) {
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

  // P4.1: Timeline filing chips and bar action outcomes open by ID — resolve
  // against the loaded home data (the modal system takes full rows).
  const openSpaceById = useCallback(
    (spaceId: string) => {
      const space = data?.spaces.find((s) => s.id === spaceId) ?? data?.review.find((s) => s.id === spaceId);
      if (space) setModal({ type: "space", space });
    },
    [data],
  );

  const openTaskById = useCallback(async (taskId: string) => {
    try {
      const { task } = await fetchTaskRun(taskId);
      setModal({ type: "task", task });
    } catch {
      // the task may not be loadable yet — the bar keeps its summary line
    }
  }, []);

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
        {/* V6 P1 S6d L6: NOT over the Library. The chip is a cross-source
            roll-up — its range is the union of every source's and its counter
            is their sum — so on a two-source machine it printed a range no
            source had ("2010 → 32 min ago") next to a backlog no source
            carried ("11,466 events left"). The Library is per source
            (Product_V6 §7.2), and each sub-tab now states its own source's
            connection, window, coverage and backlog inside its own panel. One
            aggregate chip floating above them contradicts all four. */}
        {tab !== "library" && <FreshnessChip />}
      </div>

      <AccessibilityOnboarding />

      <main className="screen">
        {tab === "home" && (
          <Home
            data={data}
            error={error}
            loading={loading}
            onRetry={() => void refresh()}
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
        {tab === "spaces" && <Spaces onTellTwin={(id, label) => lockTo("space", id, label)} />}
        {tab === "calendar" && <Calendar onOpenSpace={openSpaceById} />}
        {tab === "timeline" && <Timeline spaces={data?.spaces ?? []} onOpenSpace={openSpaceById} />}
        {tab === "library" && <Library />}
        {tab === "people" && (
          <People
            onTellTwin={(id, label) => lockTo("person", id, label)}
            onTellTwinClaim={(claimKey, label) => lockTo("claim", claimKey, label)}
            onOpenEvent={() => setTab("timeline")}
          />
        )}
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
        <ClaimModal
          claim={modal.claim}
          onCorrection={(s) => void correct({ kind: "claim", id: modal.claim.claim_key }, s)}
          onTellTwin={() => lockTo("claim", modal.claim.claim_key, modal.claim.text ?? modal.claim.claim_key)}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.type === "artifact" && (
        <ArtifactModal
          artifact={modal.artifact}
          onGraduate={() => void artifactAction(modal.artifact, "graduate")}
          onDismiss={() => void artifactAction(modal.artifact, "dismiss")}
          onIterate={
            modal.artifact.spaceId
              ? () => lockTo("space", modal.artifact.spaceId!, modal.artifact.title)
              : null
          }
          onClose={() => setModal(null)}
        />
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
        onOpenEvent={() => setTab("timeline")}
        onOpenSpace={openSpaceById}
        onOpenTask={(id) => void openTaskById(id)}
        // A quick chip on the object the bar just made is a correction like any
        // other: one dispatcher, one decisions row, one undo chip (§21).
        onQuickChip={(target, structured) => void correct(target, structured)}
      />
    </div>
  );
}

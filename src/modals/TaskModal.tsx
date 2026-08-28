// ===========================================================================
// Task modal — build P1.7 anatomy + P3.5 live states (spec §14.6).
//
// Live states over the P1 frame: the modal polls GET /api/tasks/:id/run while
// the task executes, renders the live generative result region from the run's
// typed envelope, shows the question card on needs_input (answer → recorded →
// session resumes), and expands needs_approval into the approval modal — the
// only path to a gated action, minting the single-use token on the tap.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  answerTask,
  executeTask,
  fetchTaskRun,
  sendTaskDraft,
  type EnvelopeView,
  type SpaceRow,
  type TaskRow,
  type TaskRunState,
} from "../lib/api";
import { ModalFrame, parseEvidence } from "../components/Modal";
import { ResultRenderer } from "../components/ResultRenderer";
import { ApprovalModal, type ApprovalSpec } from "./ApprovalModal";

const POLL_MS = 1500;

/** Derive what the Approve tap authorizes from the run's envelope. */
export function approvalSpecFor(envelope: EnvelopeView): ApprovalSpec | null {
  const result = envelope.result;
  if (result?.result_type === "draft_preview") {
    const to = typeof result.data.to === "string" ? result.data.to : "";
    const body = typeof result.data.body === "string" ? result.data.body : "";
    const channel = typeof result.data.channel === "string" ? result.data.channel : "";
    if (channel === "whatsapp" && to && body) {
      return {
        title: "Approve send",
        action: "whatsapp.send",
        lines: [`Send WhatsApp to ${to}`, `“${body}”`],
        why: envelope.approval_request,
        approveLabel: "Approve & send",
      };
    }
  }
  if (result?.result_type === "approval_card") {
    const action = typeof result.data.action === "string" ? result.data.action : "";
    if (!action) return null;
    const summary = typeof result.data.summary === "string" ? result.data.summary : action;
    const details = Array.isArray(result.data.details) ? result.data.details : [];
    return {
      title: "Approve",
      action,
      lines: [
        summary,
        ...details.map((d) => {
          const row = d as Record<string, unknown>;
          return `${String(row.label ?? "")}: ${String(row.value ?? "")}`;
        }),
      ],
      why: envelope.approval_request,
      amount: typeof result.data.amount === "string" ? result.data.amount : null,
      approveLabel: "Approve",
    };
  }
  return null;
}

export function TaskModal(props: {
  task: TaskRow;
  spaces: SpaceRow[];
  onCorrection: (structured: Record<string, unknown>) => void;
  onTellTwin: () => void;
  onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<TaskRunState | null>(null);
  const [approving, setApproving] = useState(false);
  const [answer, setAnswer] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const task = state?.task ?? props.task;
  const envelope = state?.run?.envelope ?? null;
  const space = props.spaces.find((s) => s.id === task.space_id);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchTaskRun(props.task.id));
    } catch {
      /* worker unreachable — keep whatever the modal already shows */
    }
  }, [props.task.id]);

  // Fetch on open; poll while the executor is live so the result region and
  // status line move without the user doing anything (spec §14.6 task modal).
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (task.status !== "executing") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [task.status, refresh]);

  async function submitAnswer(): Promise<void> {
    const text = answer.trim();
    if (!text) return;
    try {
      setState(await answerTask(props.task.id, text));
      setAnswer("");
      setNote("answer recorded — resuming");
      // Resume the session with the answer in context; the poll picks it up.
      void executeTask(props.task.id).then(
        () => void refresh(),
        () => {},
      );
    } catch {
      setNote("couldn't record the answer");
    }
  }

  const approval = envelope && task.status === "needs_approval" ? approvalSpecFor(envelope) : null;

  async function approve(token: string): Promise<void> {
    if (!approval) return;
    if (approval.action === "whatsapp.send") {
      // The worker sends the STORED draft — the token authorizes exactly what
      // this modal displayed — then flips the task to done with a receipt.
      setState(await sendTaskDraft(props.task.id, token));
    } else {
      // Generic gated action: re-enter the executor carrying the token; the
      // gated tool consumes it at the tool-layer choke point.
      await executeTask(props.task.id, token);
      await refresh();
    }
    setApproving(false);
    setNote(null);
  }

  const statusDot =
    task.status === "executing" ? "●" : task.status === "done" ? "✓" : "○";

  return (
    <ModalFrame
      title={task.title}
      typeChip={task.category ?? "task"}
      spaceChip={space?.label ?? null}
      objectType="task"
      targetKind="task"
      targetId={task.id}
      evidence={parseEvidence(task.evidence_json)}
      onCorrection={props.onCorrection}
      onTellTwin={props.onTellTwin}
      onClose={props.onClose}
    >
      <p aria-label="task status">
        status {statusDot} <strong>{task.status}</strong>
        {task.due && <> · due {task.due}</>}
        {task.owner && task.owner !== "self" && <> · owner {task.owner}</>}
      </p>
      <p style={{ color: "var(--ink-2)" }}>risk: {task.risk_class}</p>

      {envelope?.result && <ResultRenderer result={envelope.result} />}

      {task.status === "executing" && state?.run && (
        <p style={{ color: "var(--ink-2)" }} aria-label="live activity">
          {state.run.invocations.length > 0
            ? `working — ${state.run.invocations[state.run.invocations.length - 1].tool}`
            : "working…"}
        </p>
      )}

      {task.status === "needs_input" && envelope?.question && (
        <div aria-label="question card">
          <p>
            <strong>The twin needs you:</strong> {envelope.question}
          </p>
          <input
            type="text"
            aria-label="your answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitAnswer();
            }}
          />
          <button type="button" onClick={() => void submitAnswer()}>
            Answer
          </button>
        </div>
      )}

      {envelope && envelope.gaps.length > 0 && task.status !== "done" && (
        <p style={{ color: "var(--ink-2)" }} aria-label="gaps">
          gaps: {envelope.gaps.join(" · ")}
        </p>
      )}

      {approval && (
        <button type="button" onClick={() => setApproving(true)}>
          Review &amp; approve
        </button>
      )}
      {note && <p role="status">{note}</p>}

      {approving && approval && (
        <ApprovalModal
          spec={approval}
          onApprove={approve}
          onChange={() => {
            setApproving(false);
            props.onTellTwin();
          }}
          onDiscard={() => {
            setApproving(false);
            props.onCorrection({ type: "cancel" });
          }}
          onClose={() => setApproving(false)}
        />
      )}
    </ModalFrame>
  );
}

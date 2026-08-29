// ===========================================================================
// People view — build P4.2, spec §7.3 / §14.4.1.
//
// A top-level nav destination (Home · Timeline · Library · People · Settings).
// It used to hang off the bottom of Library's scroll, which was wrong twice
// over: People is not a capture source, and it was unreachable without
// scrolling past three of them.
//
// The CRM: everyone the twin knows, grouped by circle (partner · family ·
// close friends · … · businesses · no circle yet). Direct manipulation IS
// correction: dragging a person between circle groups posts
//   {type:"set_circle", circle} → /api/corrections
// — the same pipeline as every chip and utterance (CIR-04): applied at once,
// decisions row, undo chip, auto-drafted eval case. Click a person → the
// Person modal. Open merge questions ("same person?") surface at the top —
// served by the worker, never re-derived here.
//
// Drag state lives in React (not dataTransfer) so the interaction — and its
// tests — run identically under jsdom and the real webview.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  CIRCLES,
  fetchPeople,
  postCorrection,
  undoCorrection,
  type Circle,
  type MergeQuestion,
  type PersonRow,
} from "../lib/api";
import { PersonModal, circleLabel } from "../modals/PersonModal";

type CircleKey = Circle | "unassigned";

const GROUPS: CircleKey[] = [...CIRCLES, "unassigned"];

export function People(props: {
  /** Context-locks the grounded bar to a person ("Tell the twin"). */
  onTellTwin?: (personId: string, label: string) => void;
}): JSX.Element {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [questions, setQuestions] = useState<MergeQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<PersonRow | null>(null);
  const [over, setOver] = useState<CircleKey | null>(null);
  const [open, setOpen] = useState<PersonRow | null>(null);
  const [undo, setUndo] = useState<{ correctionId: string; summary: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetchPeople();
      setPeople(r.people);
      setQuestions(r.open_questions ?? []);
      setError(null);
    } catch {
      setError("worker unreachable");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** One dispatcher for every person correction (drag, modal, chips). */
  const correct = useCallback(
    async (personId: string, structured: Record<string, unknown>) => {
      try {
        const result = await postCorrection({ target: { kind: "person", id: personId }, structured });
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

  async function drop(circle: CircleKey): Promise<void> {
    const person = dragging;
    setDragging(null);
    setOver(null);
    if (!person || circle === "unassigned" || person.circle === circle) return;
    // The drag IS the correction (spec §14.4.1, CIR-04) — no dialog.
    await correct(person.id, { type: "set_circle", circle });
  }

  async function handleUndo(chip: { correctionId: string }): Promise<void> {
    try {
      await undoCorrection(chip.correctionId);
      setUndo(null);
      await refresh();
    } catch {
      setError("undo failed");
    }
  }

  if (error) {
    return (
      <div className="people-screen">
        <section className="card" aria-label="People">
          <h2>People</h2>
          <p>{error}</p>
        </section>
      </div>
    );
  }

  const grouped = new Map<CircleKey, PersonRow[]>();
  for (const g of GROUPS) grouped.set(g, []);
  for (const p of people ?? []) grouped.get(p.circle ?? "unassigned")!.push(p);

  return (
    <div className="people-screen">
      <section className="card people" aria-label="People">
        <h2>People</h2>

      {questions.length > 0 && (
        <div aria-label="merge questions">
          {questions.map((q) => (
            <p key={q.id} style={{ color: "var(--ink-2)" }}>
              ? {q.question}
            </p>
          ))}
        </div>
      )}

      {people !== null && people.length === 0 && <p className="empty">no people known yet</p>}

      {GROUPS.map((g) => {
        const rows = grouped.get(g)!;
        if (g === "unassigned" && rows.length === 0) return null;
        return (
          <div
            key={g}
            className={`circle-group${over === g ? " drop-target" : ""}`}
            aria-label={`circle ${g === "unassigned" ? "no circle yet" : circleLabel(g)}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragging) setOver(g);
            }}
            onDragLeave={() => setOver((v) => (v === g ? null : v))}
            onDrop={() => void drop(g)}
          >
            <h3 className="circle-title">
              ⦿ {g === "unassigned" ? "no circle yet" : circleLabel(g)}
              <span className="meta"> {rows.length}</span>
            </h3>
            {rows.map((p) => (
              <div
                key={p.id}
                className="row person"
                role="button"
                tabIndex={0}
                draggable
                aria-label={`person ${p.name ?? p.id}`}
                onDragStart={() => setDragging(p)}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onClick={() => setOpen(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setOpen(p);
                }}
              >
                <span className="glyph">◙</span>
                <span>{p.name ?? p.id}</span>
                {p.provisional !== 0 && <span className="chip">provisional</span>}
              </div>
            ))}
            {rows.length === 0 && <p className="empty">drag someone here</p>}
          </div>
        );
      })}

      {open && (
        <PersonModal
          person={open}
          onCorrection={(s) => void correct(open.id, s)}
          onTellTwin={() => {
            const person = open;
            setOpen(null);
            props.onTellTwin?.(person.id, person.name ?? person.id);
          }}
          onClose={() => setOpen(null)}
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
      </section>
    </div>
  );
}

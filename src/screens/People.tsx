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
// V6 P1 S5.4 adds the two IDENTITY gestures, also drags, also undoable:
//   person onto person   → merge   POST /api/people/merge
//   alias chip onto a    → split   POST /api/people/split, then set_circle
//   circle group                   when the group is a real circle
// Undo is the inverse gesture (POST /api/people/undo with the mutation id),
// not a second concept — so one undo chip serves corrections and identity
// alike, each carrying its own reversal.
//
// Drag state lives in React (not dataTransfer) so the interaction — and its
// tests — run identically under jsdom and the real webview.
//
// R2 adds the two S5.4 surfaces that were built worker-side and never
// rendered, both above the circles because both are about the user rather
// than about one contact: the "Who I am" card (people/WhoIAm.tsx — built by
// processing, no form) and the follow-up radar (people/Radar.tsx — who owes a
// reply, and when the twin starts acting). A claim correction from the card
// rides the SAME dispatcher as a circle drag, so the undo chip serves both.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  CIRCLES,
  fetchPeople,
  fetchPersonAliases,
  mergePeople,
  postCorrection,
  splitPerson,
  undoCorrection,
  undoPeopleDrag,
  type AliasChip,
  type Circle,
  type MergeQuestion,
  type PersonRow,
} from "../lib/api";
import { PersonModal, circleLabel } from "../modals/PersonModal";
import { Radar } from "./people/Radar";
import { WhoIAm } from "./people/WhoIAm";

type CircleKey = Circle | "unassigned";

const GROUPS: CircleKey[] = [...CIRCLES, "unassigned"];

/** What is under the cursor: a whole person, or one alias chip of a person. */
type Drag = { kind: "person"; person: PersonRow } | { kind: "alias"; alias: AliasChip; of: PersonRow };

/** Every gesture hands back its own reversal — corrections and identity alike. */
interface Undo {
  summary: string;
  run: () => Promise<unknown>;
}

export function People(props: {
  /** Context-locks the grounded bar to a person ("Tell the twin"). */
  onTellTwin?: (personId: string, label: string) => void;
  /** The same gesture on a "Who I am" line, which is a claim, not a person. */
  onTellTwinClaim?: (claimKey: string, label: string) => void;
  /** An evidence quote → the timeline at that event. */
  onOpenEvent?: (eventId: string) => void;
}): JSX.Element {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [questions, setQuestions] = useState<MergeQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aliases, setAliases] = useState<Record<string, AliasChip[]>>({});
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [open, setOpen] = useState<PersonRow | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetchPeople();
      setPeople(r.people);
      setQuestions(r.open_questions ?? []);
      setError(null);
      // Alias chips are an enhancement, not the list: a worker that cannot
      // serve them still renders everyone.
      try {
        setAliases((await fetchPersonAliases()).aliases ?? {});
      } catch {
        setAliases({});
      }
    } catch {
      setError("worker unreachable");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * One dispatcher for every correction this screen fires — a circle drag, the
   * person modal, a "Who I am" claim chip. One pipeline, one undo chip.
   */
  const correctTarget = useCallback(
    async (target: { kind: "person" | "claim"; id: string }, structured: Record<string, unknown>) => {
      try {
        const result = await postCorrection({ target, structured });
        if (result.decision_id) {
          setUndo({ summary: result.summary, run: () => undoCorrection(result.correction_id) });
        }
        await refresh();
      } catch {
        setError("correction failed");
      }
    },
    [refresh],
  );

  const correct = useCallback(
    (personId: string, structured: Record<string, unknown>) => correctTarget({ kind: "person", id: personId }, structured),
    [correctTarget],
  );

  /** Drop on a circle group: re-file a person, or split an alias out into it. */
  async function dropOnCircle(circle: CircleKey): Promise<void> {
    const drag = dragging;
    setDragging(null);
    setOver(null);
    if (!drag) return;
    if (drag.kind === "alias") {
      // Dragging an alias out of a person IS the split (spec §11.3).
      try {
        const result = await splitPerson(drag.alias.id);
        if (!result.ok) {
          setError(result.summary);
          return;
        }
        if (result.undoId) setUndo({ summary: result.summary, run: () => undoPeopleDrag(result.undoId!) });
        await refresh();
        if (circle !== "unassigned") await correct(drag.alias.id, { type: "set_circle", circle });
      } catch {
        setError("split failed");
      }
      return;
    }
    if (circle === "unassigned" || drag.person.circle === circle) return;
    // The drag IS the correction (spec §14.4.1, CIR-04) — no dialog.
    await correct(drag.person.id, { type: "set_circle", circle });
  }

  /** Drop one person onto another: the merge. The card dropped on survives. */
  async function dropOnPerson(target: PersonRow): Promise<void> {
    const drag = dragging;
    setDragging(null);
    setOver(null);
    if (!drag || drag.kind !== "person" || drag.person.id === target.id) return;
    try {
      const result = await mergePeople(drag.person.id, target.id);
      if (!result.ok) {
        setError(result.summary);
        return;
      }
      if (result.undoId) setUndo({ summary: result.summary, run: () => undoPeopleDrag(result.undoId!) });
      await refresh();
    } catch {
      setError("merge failed");
    }
  }

  async function handleUndo(chip: Undo): Promise<void> {
    try {
      await chip.run();
      setUndo(null);
      await refresh();
    } catch {
      setError("undo failed");
    }
  }

  /** The identity card and the radar, above the circles on every render. */
  const heads = (
    <>
      <WhoIAm
        onCorrection={(claimKey, structured) => void correctTarget({ kind: "claim", id: claimKey }, structured)}
        {...(props.onTellTwinClaim ? { onTellTwin: props.onTellTwinClaim } : {})}
        {...(props.onOpenEvent ? { onOpenEvent: props.onOpenEvent } : {})}
      />
      <Radar />
    </>
  );

  if (error) {
    return (
      <div className="people-screen">
        {heads}
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
      {heads}
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
            onDrop={() => void dropOnCircle(g)}
          >
            <h3 className="circle-title">
              ⦿ {g === "unassigned" ? "no circle yet" : circleLabel(g)}
              <span className="meta"> {rows.length}</span>
            </h3>
            {rows.map((p) => (
              <div
                key={p.id}
                className={`row person${over === p.id ? " drop-target" : ""}`}
                role="button"
                tabIndex={0}
                draggable
                aria-label={`person ${p.name ?? p.id}`}
                onDragStart={() => setDragging({ kind: "person", person: p })}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  // A person dropped on a person is a merge — claim the event
                  // before the circle group sees it.
                  if (!dragging || dragging.kind !== "person" || dragging.person.id === p.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setOver(p.id);
                }}
                onDrop={(e) => {
                  if (!dragging || dragging.kind !== "person" || dragging.person.id === p.id) return;
                  e.stopPropagation();
                  void dropOnPerson(p);
                }}
                onClick={() => setOpen(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setOpen(p);
                }}
              >
                <span className="glyph">◙</span>
                <span>{p.name ?? p.id}</span>
                {p.provisional !== 0 && <span className="chip">provisional</span>}
                {(aliases[p.id] ?? []).map((a) => (
                  <span
                    key={a.id}
                    className="chip alias"
                    draggable
                    role="button"
                    tabIndex={0}
                    aria-label={`alias ${a.name ?? a.id} of ${p.name ?? p.id}`}
                    title="drag out to split this person back apart"
                    onDragStart={(e) => {
                      e.stopPropagation();
                      setDragging({ kind: "alias", alias: a, of: p });
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ⚯ {a.name ?? a.id}
                  </span>
                ))}
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

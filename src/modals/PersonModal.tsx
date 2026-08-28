// ===========================================================================
// Person modal — build P4.2, spec §14.6.
//
// Header: name · circle chip (changeable — the modal's equivalent of the
// People-view drag) · provisional hint. Body: profile claims with evidence,
// tone profile ("Hinglish, short, 🔥-heavy — used for drafts"), relationship
// edges ("loops"). Every change is a correction through the one pipeline:
//   circle change  → {type:"set_circle", circle}          (CIR-04 path)
//   "she's my cousin" via Tell the twin / relationship fix → set_relationship
// Provisional people show "no contact info — link a contact?" (spec §14.6).
// ===========================================================================

import { useEffect, useState } from "react";
import {
  CIRCLES,
  fetchPersonDetail,
  fetchTone,
  type Circle,
  type ClaimVersionView,
  type EdgeView,
  type PersonRow,
  type ToneProfileView,
} from "../lib/api";
import { ModalFrame } from "../components/Modal";

const CIRCLE_LABELS: Record<Circle, string> = {
  partner: "partner",
  family: "family",
  close_friends: "close friends",
  friends: "friends",
  coworkers: "coworkers",
  important_services: "important services",
  old_batchmates: "old batchmates",
  acquaintances: "acquaintances",
  businesses: "businesses",
};

export function circleLabel(circle: Circle | null): string {
  return circle ? CIRCLE_LABELS[circle] : "no circle yet";
}

function toneLine(tone: ToneProfileView | null): string | null {
  if (!tone) return null;
  const bits = [tone.languageMix, tone.register, tone.emojiHabits, tone.notes].filter(
    (b): b is string => typeof b === "string" && b.trim() !== "",
  );
  return bits.length > 0 ? `${bits.join(", ")} — used for drafts` : null;
}

export function PersonModal(props: {
  person: PersonRow;
  onCorrection: (structured: Record<string, unknown>) => void;
  onTellTwin: () => void;
  onClose: () => void;
}): JSX.Element {
  const { person } = props;
  const [claims, setClaims] = useState<ClaimVersionView[]>([]);
  const [edges, setEdges] = useState<EdgeView[]>([]);
  const [circle, setCircle] = useState<Circle | null>(person.circle);
  const [tone, setTone] = useState<ToneProfileView | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPersonDetail(person.id)
      .then((d) => {
        if (!alive) return;
        setClaims(d.claims);
        setEdges(d.edges);
        setCircle(d.circle);
      })
      .catch(() => {});
    fetchTone(person.id)
      .then((t) => {
        if (alive) setTone(t.profile);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [person.id]);

  function changeCircle(next: string): void {
    if (next === (circle ?? "")) return;
    setCircle(next === "" ? null : (next as Circle));
    // Same correction the People-view drag fires — one pipeline (CIR-04).
    props.onCorrection({ type: "set_circle", circle: next });
  }

  const tl = toneLine(tone);

  return (
    <ModalFrame
      title={person.name ?? person.id}
      typeChip={person.provisional ? "provisional person" : "person"}
      objectType="person"
      targetKind="person"
      targetId={person.id}
      evidence={[]}
      onCorrection={props.onCorrection}
      onTellTwin={props.onTellTwin}
      onClose={props.onClose}
    >
      <p>
        <span className="chip">⦿ {circleLabel(circle)}</span>{" "}
        <label style={{ color: "var(--ink-2)" }}>
          move to{" "}
          <select
            aria-label="circle"
            value={circle ?? ""}
            onChange={(e) => changeCircle(e.target.value)}
          >
            <option value="">no circle</option>
            {CIRCLES.map((c) => (
              <option key={c} value={c}>
                {CIRCLE_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </p>

      {person.provisional !== 0 && (
        <p style={{ color: "var(--ink-2)" }}>no contact info — link a contact?</p>
      )}

      {claims.length > 0 && (
        <div aria-label="claims">
          {claims.map((c) => (
            <p key={c.id}>
              {c.text ?? c.claimKey}{" "}
              {c.evidence && c.evidence.length > 0 && (
                <span style={{ color: "var(--ink-2)" }}>❝{c.evidence[0]!.quote}❞</span>
              )}
            </p>
          ))}
        </div>
      )}
      {claims.length === 0 && <p className="empty">no claims about them yet</p>}

      {tl && <p style={{ color: "var(--ink-2)" }}>tone&nbsp; {tl}</p>}

      {edges.length > 0 && (
        <div aria-label="loops">
          {edges.map((e) => (
            <p key={e.id} style={{ color: "var(--ink-2)" }}>
              {e.kind}
              {e.subtype ? ` · ${e.subtype}` : ""}
            </p>
          ))}
        </div>
      )}
    </ModalFrame>
  );
}

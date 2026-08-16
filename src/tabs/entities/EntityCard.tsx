// [CODE] One entity, inspectable — arch §14.1.
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ Pranjali Sachdeva                            person · 4 identities   │
//   │  IDENTITIES  whatsapp:jid 9177…03 ✓code   phone +9177…03 ✓code       │
//   │              gmail:pranjali@…     ✓user   slack:@pran    ⚠ml 0.71    │
//   │  RELATIONS                                                           │
//   │      Pranjali ──member_of──▶ "Ghar+"                  ✓code 1.0      │
//   │      Pranjali ──lives_at:current──▶ Bangalore    llm 0.8 "…quote…"   │
//   │  41 sessions · 12 episodes · 3 arcs · first seen 12 Mar              │
//   │  [ merge ][ split ][ rename ][ pin ][ add relation ]                 │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Every binding shows `decided_by` and its confidence, because §1.10's "zero
// silent guesses" is only true if the surface actually shows the attribution.
// An unattributed binding is rendered as unattributed rather than as fact.
//
// Gestures are RAISED, not performed. The card owns its forms; the tab owns the
// writes and the mutation receipts, so there is one place where an `actor:user`
// mutation is issued and one place where its receipt is rendered.

import { useState } from "react";

import {
  EDGE_KINDS,
  type EdgeKind,
  type EntityView,
  type IdentityView,
  type RelationView,
} from "../../lib/surfaces-client";

export type EntityGesture =
  | { kind: "merge"; id: string; into: string }
  | { kind: "split"; id: string; identityIds: string[] }
  | { kind: "rename"; id: string; canonical: string }
  | { kind: "pin"; id: string; pinned: boolean }
  | {
      kind: "add_relation";
      id: string;
      edgeKind: EdgeKind;
      subtype: string | null;
      dstEntityId: string;
    }
  | { kind: "reject_edge"; id: string; edgeId: string };

export interface EntityCardProps {
  entity: EntityView;
  /** The row vanished from the worker's answer while provisional (§14.0b). */
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  /** Other loaded entities, offered as merge and relation targets. */
  peers: readonly { id: string; label: string }[];
  onGesture(gesture: EntityGesture): void;
  busy?: boolean;
}

type OpenForm = "merge" | "split" | "rename" | "relation" | null;

/**
 * `code` and `user` decided it; anything else guessed it, and says so. The
 * `decided_by` string itself is rendered verbatim — the marker in front of it
 * is the only thing this function adds.
 */
export function decidedByBadge(decidedBy: string | null, confidence: number | null): string {
  const conf = confidence === null ? "" : ` ${confidence.toFixed(2)}`;
  if (!decidedBy) return "unattributed";
  const certain = decidedBy.startsWith("code") || decidedBy.startsWith("user");
  return `${certain ? "✓" : "⚠ "}${decidedBy}${conf}`;
}

/** `member_of`, `related_to:friend` — the subtype is never dropped (§14.1). */
export function edgeLabel(relation: Pick<RelationView, "kind" | "subtype">): string {
  return relation.subtype ? `${relation.kind}:${relation.subtype}` : relation.kind;
}

function identityLabel(identity: IdentityView): string {
  return identity.sourceId ? `${identity.sourceId}:${identity.kind}` : identity.kind;
}

function shortDate(iso: string | null): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

function Relation({
  entity,
  relation,
  onGesture,
  busy,
}: {
  entity: EntityView;
  relation: RelationView;
  onGesture(gesture: EntityGesture): void;
  busy: boolean;
}) {
  const [src, dst] =
    relation.direction === "out"
      ? [entity.label, relation.otherLabel]
      : [relation.otherLabel, entity.label];
  const quotes = relation.evidence.map((e) => `“${e.quote}”`).join(" · ");

  return (
    <li
      className={`relation relation--${relation.status}`}
      /* Hover on a pointer, and the same text is in the DOM for everyone else. */
      title={quotes || undefined}
    >
      <span className="relation__graph">
        <span className="relation__node">{src}</span>
        <span className="relation__edge" aria-hidden="true">
          ──
        </span>
        <span className="relation__kind">{edgeLabel(relation)}</span>
        <span className="relation__edge" aria-hidden="true">
          ──▶
        </span>
        <span className="relation__node">{dst}</span>
      </span>
      <span className="relation__decided">
        {decidedByBadge(relation.decidedBy, relation.confidence)}
      </span>
      {relation.status !== "active" && (
        <span className="relation__status">{relation.status}</span>
      )}
      {relation.evidence.length > 0 && (
        <span className="relation__evidence" tabIndex={0}>
          {quotes}
        </span>
      )}
      {relation.status === "active" && (
        <button
          type="button"
          className="relation__reject"
          disabled={busy}
          onClick={() => onGesture({ kind: "reject_edge", id: entity.id, edgeId: relation.edgeId })}
        >
          reject edge
        </button>
      )}
    </li>
  );
}

function MergeForm({ entity, peers, onGesture, onClose }: {
  entity: EntityView;
  peers: readonly { id: string; label: string }[];
  onGesture(gesture: EntityGesture): void;
  onClose(): void;
}) {
  const [into, setInto] = useState("");
  const listId = `merge-targets-${entity.id}`;
  return (
    <form
      className="entity-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!into.trim()) return;
        onGesture({ kind: "merge", id: entity.id, into: into.trim() });
        onClose();
      }}
    >
      <label htmlFor={`merge-${entity.id}`}>Merge into</label>
      <input
        id={`merge-${entity.id}`}
        list={listId}
        value={into}
        onChange={(e) => setInto(e.target.value)}
        placeholder="surviving entity id"
      />
      <datalist id={listId}>
        {peers.map((peer) => (
          <option key={peer.id} value={peer.id}>
            {peer.label}
          </option>
        ))}
      </datalist>
      <button type="submit">confirm merge</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

function SplitForm({ entity, onGesture, onClose }: {
  entity: EntityView;
  onGesture(gesture: EntityGesture): void;
  onClose(): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <form
      className="entity-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.length === 0) return;
        onGesture({ kind: "split", id: entity.id, identityIds: picked });
        onClose();
      }}
    >
      <fieldset>
        <legend>Split these identities out</legend>
        {entity.identities.map((identity) => (
          <label key={identity.id} className="entity-form__check">
            <input
              type="checkbox"
              checked={picked.includes(identity.id)}
              onChange={(e) =>
                setPicked((prev) =>
                  e.target.checked
                    ? [...prev, identity.id]
                    : prev.filter((v) => v !== identity.id),
                )
              }
            />
            {identityLabel(identity)} {identity.value}
          </label>
        ))}
      </fieldset>
      <button type="submit">confirm split</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

function RenameForm({ entity, onGesture, onClose }: {
  entity: EntityView;
  onGesture(gesture: EntityGesture): void;
  onClose(): void;
}) {
  const [name, setName] = useState(entity.label);
  return (
    <form
      className="entity-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onGesture({ kind: "rename", id: entity.id, canonical: name.trim() });
        onClose();
      }}
    >
      <label htmlFor={`rename-${entity.id}`}>Rename to</label>
      <input
        id={`rename-${entity.id}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit">confirm rename</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

function RelationForm({ entity, peers, onGesture, onClose }: {
  entity: EntityView;
  peers: readonly { id: string; label: string }[];
  onGesture(gesture: EntityGesture): void;
  onClose(): void;
}) {
  const [edgeKind, setEdgeKind] = useState<EdgeKind>("related_to");
  const [subtype, setSubtype] = useState("");
  const [dst, setDst] = useState("");
  const listId = `relation-targets-${entity.id}`;
  return (
    <form
      className="entity-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dst.trim()) return;
        onGesture({
          kind: "add_relation",
          id: entity.id,
          edgeKind,
          subtype: subtype.trim() || null,
          dstEntityId: dst.trim(),
        });
        onClose();
      }}
    >
      <label htmlFor={`relkind-${entity.id}`}>Relation</label>
      <select
        id={`relkind-${entity.id}`}
        value={edgeKind}
        onChange={(e) => setEdgeKind(e.target.value as EdgeKind)}
      >
        {EDGE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </select>
      <label htmlFor={`relsub-${entity.id}`}>Subtype</label>
      <input
        id={`relsub-${entity.id}`}
        value={subtype}
        onChange={(e) => setSubtype(e.target.value)}
        placeholder="optional"
      />
      <label htmlFor={`reldst-${entity.id}`}>To</label>
      <input
        id={`reldst-${entity.id}`}
        list={listId}
        value={dst}
        onChange={(e) => setDst(e.target.value)}
        placeholder="entity id"
      />
      <datalist id={listId}>
        {peers.map((peer) => (
          <option key={peer.id} value={peer.id}>
            {peer.label}
          </option>
        ))}
      </datalist>
      <button type="submit">confirm relation</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

export function EntityCard({
  entity,
  retracted = false,
  onDismissRetracted,
  peers,
  onGesture,
  busy = false,
}: EntityCardProps) {
  const [open, setOpen] = useState<OpenForm>(null);
  const close = () => setOpen(null);
  const others = peers.filter((peer) => peer.id !== entity.id);

  return (
    <li
      className={
        "entity" +
        (entity.provisional ? " entity--provisional" : "") +
        (retracted ? " entity--retracted" : "")
      }
      data-entity-id={entity.id}
    >
      {retracted && (
        <p className="entity__retracted" role="status">
          <span aria-hidden="true">◍ </span>
          no longer listed — a resolution pass merged or dropped it
          <button type="button" onClick={() => onDismissRetracted?.(entity.id)}>
            dismiss
          </button>
        </p>
      )}

      <header className="entity__head">
        <h3 className="entity__name">{entity.label}</h3>
        {entity.pinned && <span className="entity__pin">📌 pinned</span>}
        {entity.provisional && (
          <span className="entity__provisional" title="not yet reconciled — this may change">
            ◍ provisional
          </span>
        )}
        <span className="entity__meta">
          {entity.subtype ? `${entity.type}·${entity.subtype}` : entity.type} ·{" "}
          {entity.identities.length} identities
        </span>
      </header>

      <div className="entity__block">
        <span className="entity__label">Identities</span>
        <ul className="identity-list">
          {entity.identities.map((identity) => (
            <li key={identity.id} className="identity">
              <span className="identity__kind">{identityLabel(identity)}</span>
              <span className="identity__value">{identity.value}</span>
              <span className="identity__decided">
                {decidedByBadge(identity.decidedBy, identity.confidence)}
              </span>
            </li>
          ))}
          {entity.identities.length === 0 && <li className="identity">no identities bound</li>}
        </ul>
      </div>

      <div className="entity__block">
        <span className="entity__label">Relations</span>
        <ul className="relation-list">
          {entity.relations.map((relation) => (
            <Relation
              key={relation.edgeId}
              entity={entity}
              relation={relation}
              onGesture={onGesture}
              busy={busy}
            />
          ))}
          {entity.relations.length === 0 && <li className="relation">no relations yet</li>}
        </ul>
      </div>

      <p className="entity__counts">
        {entity.counts.sessions} sessions · {entity.counts.episodes} episodes ·{" "}
        {entity.counts.arcs} arcs · first seen {shortDate(entity.firstSeenAt)}
      </p>

      <p className="entity__gestures">
        <button type="button" disabled={busy} onClick={() => setOpen("merge")}>
          merge
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen("split")}>
          split
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen("rename")}>
          rename
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onGesture({ kind: "pin", id: entity.id, pinned: !entity.pinned })}
        >
          {entity.pinned ? "unpin" : "pin"}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen("relation")}>
          add relation
        </button>
      </p>

      {open === "merge" && (
        <MergeForm entity={entity} peers={others} onGesture={onGesture} onClose={close} />
      )}
      {open === "split" && <SplitForm entity={entity} onGesture={onGesture} onClose={close} />}
      {open === "rename" && <RenameForm entity={entity} onGesture={onGesture} onClose={close} />}
      {open === "relation" && (
        <RelationForm entity={entity} peers={others} onGesture={onGesture} onClose={close} />
      )}
    </li>
  );
}

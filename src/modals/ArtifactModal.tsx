// ===========================================================================
// Prepared-artifact modal — build P4.2, spec §14.6.
//
// Intent line ("Saw you comparing villas — Goa › Stay"), the generative
// artifact full-size through the §14.5 renderer (the artifact body is a typed
// {result_type, data} payload; anything else falls back to the document
// card), provenance, and the three actions: Make it a task · Iterate… (a
// context-locked bar thread) · Discard (graded negative — kept, never gone).
// ===========================================================================

import type { ArtifactRow, ExecutorResultView } from "../lib/api";
import { ResultRenderer } from "../components/ResultRenderer";

/** Parse an artifact's body_json into a renderable result, defensively. */
export function artifactResult(artifact: ArtifactRow): ExecutorResultView | null {
  if (!artifact.bodyJson) return null;
  try {
    const parsed = JSON.parse(artifact.bodyJson) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.result_type === "string" && typeof parsed.data === "object" && parsed.data !== null) {
      return { result_type: parsed.result_type, data: parsed.data as Record<string, unknown> };
    }
    // A bare payload without the envelope still gets the document card.
    return { result_type: "document", data: parsed };
  } catch {
    return null;
  }
}

export function ArtifactModal(props: {
  artifact: ArtifactRow;
  onGraduate: () => void;
  onDismiss: () => void;
  /** Opens a context-locked bar thread with the artifact's space; absent when unfiled. */
  onIterate: (() => void) | null;
  onClose: () => void;
}): JSX.Element {
  const { artifact } = props;
  const result = artifactResult(artifact);

  return (
    <div className="modal-scrim" onClick={props.onClose} data-testid="modal-scrim">
      <section
        className="modal"
        role="dialog"
        aria-label={artifact.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 className="title">
            {artifact.producer === "assist" ? "◆" : "◇"} {artifact.title}
          </h2>
          <span className="chip">{artifact.kind}</span>
          {artifact.spaceId && <span className="chip">{artifact.spaceId}</span>}
        </header>

        {artifact.intent && <p>{artifact.intent}</p>}
        {!artifact.intent && artifact.summary && <p>{artifact.summary}</p>}

        {result && <ResultRenderer result={result} />}
        {!result && artifact.intent && artifact.summary && <p>{artifact.summary}</p>}

        {artifact.reasoning && (
          <p style={{ color: "var(--ink-2)" }}>{artifact.reasoning} (provenance →)</p>
        )}

        <footer>
          <button type="button" className="linklike" onClick={props.onGraduate}>
            Make it a task
          </button>
          {props.onIterate && (
            <button type="button" className="linklike" onClick={props.onIterate}>
              Iterate…
            </button>
          )}
          <button type="button" className="linklike" onClick={props.onDismiss}>
            Discard
          </button>
          <button type="button" className="linklike" onClick={props.onClose}>
            close
          </button>
        </footer>
      </section>
    </div>
  );
}

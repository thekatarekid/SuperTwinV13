// ===========================================================================
// Grounded bar — build P1.7, spec §14.8 (P1 slice).
//
// One pill, morphing states. This phase ships ① collapsed, ② focused and
// ⑤ context-locked ("Tell the twin", §14.4.3): a locked object chip pins the
// bar to one target, the utterance posts through the corrections pipeline,
// and the twin's "what I did" line + undo ride back. Search/answer/acting
// states arrive with their lanes (grounded chat is P4).
// ===========================================================================

import { useEffect, useRef, useState } from "react";
import type { TargetKind } from "../lib/api";

export interface BarLock {
  kind: TargetKind;
  id: string;
  label: string;
}

export function GroundedBar(props: {
  lock: BarLock | null;
  onUnlock: () => void;
  /** Submit a context-locked utterance; resolves to the "what I did" line. */
  onTellTwin: (lock: BarLock, utterance: string) => Promise<string>;
}): JSX.Element {
  const [text, setText] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Entering context-locked state focuses the input (spec §14.8.4).
  useEffect(() => {
    if (props.lock) {
      setReply(null);
      setText("");
      inputRef.current?.focus();
    }
  }, [props.lock]);

  async function submit(): Promise<void> {
    const utterance = text.trim();
    if (utterance === "") return;
    if (props.lock) {
      setText("");
      const line = await props.onTellTwin(props.lock, utterance);
      setReply(line);
    }
  }

  return (
    <div className="bar-wrap">
      <div className="bar" aria-label="grounded bar">
        {props.lock && (
          <div className="lock-chip">
            <span className="chip accent">
              ⊙ {props.lock.kind}: {props.lock.label}
            </span>
            <button type="button" className="linklike" onClick={props.onUnlock} aria-label="unlock">
              ✕ unlock
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          value={text}
          placeholder={
            props.lock ? "tell the twin what's wrong…" : "Ask, search, or tell me to do something"
          }
          aria-label="ask"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {reply && <div className="reply">twin: {reply}</div>}
      </div>
    </div>
  );
}

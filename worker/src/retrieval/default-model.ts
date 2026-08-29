// ===========================================================================
// Getting an install onto the DEFAULT encoder (defect 5b).
//
// The default is EmbeddingGemma 300M (model-registry.ts). The encoder that
// SHIPS is the smaller E5 Small, because a machine that has to find 300 MB of
// network before semantic search works at all is a machine where semantic
// search is simply off. So the two are not the same model, and something has
// to move an install from the one it can always run to the one it should be
// running. That is this file, and it obeys three rules:
//
//   1. NEVER before the weights are here. Pointing the index at a model whose
//      files are absent is how search starts answering out of nothing.
//   2. NEVER over a human's choice. Picking E5 Base in Settings is an answer,
//      not a gap waiting to be filled — an explicit pick is recorded and this
//      never touches an install that has made one.
//   3. NEVER a silent flip on a populated index. With no vectors, moving the
//      pointer is free and instant. With vectors, the ONLY safe route is the
//      existing background swap (model-swap.ts): re-embed the corpus beside
//      the live index and move the pointer inside the flip transaction, so
//      every question asked meanwhile is still answered by the old one.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { embeddingModelPresent } from "./embedder.js";
import {
  activeEmbeddingModelId,
  DEFAULT_EMBEDDING_MODEL_ID,
  findEmbeddingModel,
  setActiveEmbeddingModelId,
  storedEmbeddingModelId,
} from "./model-registry.js";
import { embeddingSwapRunning, startEmbeddingSwap } from "./model-swap.js";

/**
 * Set the moment a human picks an encoder. Its only job is to stop the
 * automatic adoption below from ever overruling that pick.
 */
export const EMBEDDING_MODEL_CHOSEN_KEY = "retrieval.embedding_model_chosen";

export function markEmbeddingModelChosenByUser(): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES (@key, '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ key: EMBEDDING_MODEL_CHOSEN_KEY });
  } catch {
    // No database yet: nothing has been chosen, which is the same answer.
  }
}

export function embeddingModelChosenByUser(): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM app_state WHERE key = ?`)
      .get(EMBEDDING_MODEL_CHOSEN_KEY) as { value: string | null } | undefined;
    return row?.value === "1";
  } catch {
    return false;
  }
}

/** How many vectors the index holds right now, across every model. */
function vectorsHeld(): number {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM event_embeddings`).get() as {
      n: number;
    };
    return row.n;
  } catch {
    // A database that predates the vector table holds none.
    return 0;
  }
}

export type AdoptOutcome =
  | "already-default"
  | "not-downloaded"
  | "user-chose"
  | "swap-running"
  | "activated"
  | "swap-started";

/**
 * Move this install onto the default encoder if it is safe to. Idempotent, and
 * cheap enough to call on every boot and after every download.
 */
export function adoptDefaultEmbeddingModel(): AdoptOutcome {
  const spec = findEmbeddingModel(DEFAULT_EMBEDDING_MODEL_ID);
  if (!spec) return "already-default";
  if (activeEmbeddingModelId() === spec.id) return "already-default";
  // Rule 2 before rule 1: a user who picked something else should not have
  // their choice re-examined every time a download lands.
  if (embeddingModelChosenByUser()) return "user-chose";
  // Rule 1: the weights, all of them, at their pinned lengths.
  if (!embeddingModelPresent(spec)) return "not-downloaded";
  if (embeddingSwapRunning()) return "swap-running";

  if (vectorsHeld() === 0) {
    // Nothing to re-embed — a fresh install, or one whose index has not been
    // built yet. The pointer move IS the whole swap.
    setActiveEmbeddingModelId(spec.id);
    return "activated";
  }
  // Rule 3: there is an index. Re-embed beside it and flip at the end.
  try {
    startEmbeddingSwap(spec.id);
    return "swap-started";
  } catch {
    // Something else is already mid-swap, or the model cannot be loaded. The
    // old index keeps answering; the next call tries again.
    return "swap-running";
  }
}

/**
 * Called once at boot. Writes the resolved active id down so the pointer is
 * explicit rather than implied by a fallback, and adopts the default when it
 * is already here (an app update on a machine that downloaded Gemma before).
 */
export function seedActiveEmbeddingModel(): AdoptOutcome {
  const outcome = adoptDefaultEmbeddingModel();
  if (storedEmbeddingModelId() === null) {
    try {
      setActiveEmbeddingModelId(activeEmbeddingModelId());
    } catch {
      // No database yet — the fallback answers until there is one.
    }
  }
  return outcome;
}

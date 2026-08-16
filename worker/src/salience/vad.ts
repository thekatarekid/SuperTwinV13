// ===========================================================================
// Voice-activity detection — stage ① of the salience prefilter (arch §10.2).
//
// "audio: VAD gates the recorder; silence is never written." That sentence is
// about ambient capture — a microphone that is always on produces hours of room
// tone a day, and the only cheap place to throw it away is before it becomes a
// row. WhatsApp has no such problem: a voice note exists because a human held
// the button down, so its manifest says `salience.prefilter: "none"` and the
// detector wired in for it is PASS_THROUGH_VAD, which calls the whole clip
// speech and gates nothing.
//
// The interface exists now anyway. The alternative is discovering the shape of
// this contract while an ambient source is already writing rows, which means a
// migration and a backfill over audio that no longer exists on disk.
//
// [CODE] — the pass-through and the registry. A real detector (webrtcvad,
// silero) is [ML] and plugs in through `registerVad`; nothing in this file
// needs to change when it does.
//
// One rule this file inherits from the core (§9 of the build rules): a verdict
// never deletes anything that was already written. VAD gates a RECORDER — it
// decides what is captured in the first place. Once an event exists, the most
// its speech ratio can do is lower that event's salience.
// ===========================================================================

/** A span of the clip, in ms from the clip's own start. */
export interface VadWindow {
  start_ms: number;
  end_ms: number;
}

/**
 * What a detector is handed. `duration_ms` is the only field a capturer must
 * know; `samples` is present when the audio is still in memory, which is the
 * case that lets a real detector answer without touching disk.
 */
export interface VadInput {
  /** Total length of the clip in ms. Must be finite and >= 0. */
  duration_ms: number;
  /** Mono PCM in [-1, 1], when the capturer still holds it. */
  samples?: Float32Array;
  /** Sample rate of `samples`. Required whenever `samples` is present. */
  sample_rate_hz?: number;
}

export interface VadVerdict {
  /** Whether any speech was found at all. */
  speech: boolean;
  /** The spans holding speech — the only spans a recorder should persist. */
  windows: readonly VadWindow[];
  /** Total ms of speech across `windows`. */
  speech_ms: number;
  /** `speech_ms / duration_ms`, clamped to 0..1. Feeds the salience score. */
  speech_ratio: number;
  /** Which detector answered. */
  detector: string;
}

export interface VoiceActivityDetector {
  readonly id: string;
  /**
   * Whether this detector can actually stop a recorder. `false` means the
   * detector is a pass-through and a caller may skip the plumbing entirely —
   * it is the honest way to say "no-op" without every call site special-casing
   * an id string.
   */
  readonly gates: boolean;
  detect(input: VadInput): VadVerdict;
}

/** The id every source with `salience.prefilter: "none"` resolves to. */
export const PASS_THROUGH_VAD_ID = "none";

function normaliseDuration(duration_ms: number): number {
  if (!Number.isFinite(duration_ms) || duration_ms <= 0) return 0;
  return duration_ms;
}

/**
 * The WhatsApp no-op. Every clip is speech end to end, so `speech_ratio` is 1
 * and the salience stage sees a signal that changes nothing.
 *
 * A zero-length clip is the one case that answers `speech: false` — there is
 * nothing there to be speech — but it still returns a ratio of 1 rather than 0,
 * because a pass-through must never be the reason an event scores low.
 */
export const PASS_THROUGH_VAD: VoiceActivityDetector = {
  id: PASS_THROUGH_VAD_ID,
  gates: false,
  detect(input: VadInput): VadVerdict {
    const duration = normaliseDuration(input.duration_ms);
    return {
      speech: duration > 0,
      windows: duration > 0 ? [{ start_ms: 0, end_ms: duration }] : [],
      speech_ms: duration,
      speech_ratio: 1,
      detector: PASS_THROUGH_VAD_ID,
    };
  },
};

// ---- Registry -------------------------------------------------------------
//
// Keyed by id so a manifest can name its detector as data. The pass-through is
// pre-registered and cannot be replaced: "none" means none, and a source that
// wants real gating says so by naming a different detector.

const DETECTORS = new Map<string, VoiceActivityDetector>([
  [PASS_THROUGH_VAD_ID, PASS_THROUGH_VAD],
]);

export class VadRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VadRegistryError";
  }
}

export function registerVad(detector: VoiceActivityDetector): void {
  const id = detector?.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new VadRegistryError("a detector must have a non-empty string id");
  }
  if (id === PASS_THROUGH_VAD_ID) {
    throw new VadRegistryError(`the ${JSON.stringify(PASS_THROUGH_VAD_ID)} detector is reserved`);
  }
  if (typeof detector.detect !== "function") {
    throw new VadRegistryError(`detector ${JSON.stringify(id)} has no detect(input) function`);
  }
  if (DETECTORS.has(id)) {
    throw new VadRegistryError(`detector ${JSON.stringify(id)} is already registered`);
  }
  DETECTORS.set(id, detector);
}

/**
 * Resolve a detector by id. Unknown ids throw rather than falling back to the
 * pass-through: a typo that silently disables gating on an ambient source is
 * how a disk fills with room tone.
 */
export function getVad(id: string): VoiceActivityDetector {
  const found = DETECTORS.get(id);
  if (!found) {
    throw new VadRegistryError(
      `unknown VAD ${JSON.stringify(id)} — registered: ${listVads().join(", ")}`,
    );
  }
  return found;
}

export function listVads(): readonly string[] {
  return [...DETECTORS.keys()];
}

/** Test hygiene: drop everything but the reserved pass-through. */
export function resetVads(): void {
  for (const id of [...DETECTORS.keys()]) {
    if (id !== PASS_THROUGH_VAD_ID) DETECTORS.delete(id);
  }
}

/**
 * Fold a detector's windows into a verdict. Exported because every real
 * detector needs exactly this arithmetic and none of them should reinvent the
 * clamping — overlapping windows are merged, so a detector that emits sloppy
 * spans cannot report more speech than the clip contains.
 */
export function verdictFromWindows(
  detectorId: string,
  duration_ms: number,
  windows: readonly VadWindow[],
): VadVerdict {
  const duration = normaliseDuration(duration_ms);
  const clean = windows
    .map((w) => ({
      start_ms: Math.max(0, Math.min(w.start_ms, duration)),
      end_ms: Math.max(0, Math.min(w.end_ms, duration)),
    }))
    .filter((w) => w.end_ms > w.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms);

  const merged: VadWindow[] = [];
  for (const w of clean) {
    const last = merged[merged.length - 1];
    if (last && w.start_ms <= last.end_ms) {
      last.end_ms = Math.max(last.end_ms, w.end_ms);
    } else {
      merged.push({ ...w });
    }
  }

  const speech_ms = merged.reduce((sum, w) => sum + (w.end_ms - w.start_ms), 0);
  return {
    speech: speech_ms > 0,
    windows: merged,
    speech_ms,
    speech_ratio: duration > 0 ? Math.min(1, speech_ms / duration) : 0,
    detector: detectorId,
  };
}

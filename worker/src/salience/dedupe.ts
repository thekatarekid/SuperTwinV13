// ===========================================================================
// Perceptual dedupe — stage ② of the salience prefilter (arch §10.2), the one
// worth −90% on a screen-recording stream.
//
// A screen capture sampled on every a11y-tree change produces runs of frames
// that differ by a blinking cursor. A perceptual hash collapses that run: near
// neighbours inside a bounded per-stream window are reported as repeats of the
// frame that came first.
//
// Two things this file deliberately does NOT do:
//
//   1. It does not delete, skip, or refuse anything. `admit` returns a VERDICT.
//      The score stage turns a duplicate verdict into a low salience, and a low
//      salience orders and gates enrichment spend — the row is still written,
//      still retrievable, still counted. Nothing is dropped (build rule 9).
//   2. It does not hash. Hashing an image is [ML] work on bytes this module
//      never sees; `PerceptualHasher` is the seam. WhatsApp registers nothing
//      and runs NO_OP_HASHER, whose `hash()` returns null, which makes every
//      verdict a non-duplicate. That is the whole of the WhatsApp no-op.
//
// [CODE] — the hamming distance, the window, the verdict. [ML] — the hasher.
// ===========================================================================

/** A 64-bit perceptual hash as 16 lowercase hex chars. */
export type Phash = string;

const PHASH_RE = /^[0-9a-f]{16}$/;

export function isPhash(v: unknown): v is Phash {
  return typeof v === "string" && PHASH_RE.test(v);
}

export class DedupeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DedupeError";
  }
}

const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * Bit distance between two hashes, 0..64. Malformed input throws rather than
 * returning a large number: a distance of 64 reads as "utterly different" and
 * would quietly disable dedupe for a hasher emitting the wrong width.
 */
export function hamming(a: Phash, b: Phash): number {
  if (!isPhash(a) || !isPhash(b)) {
    throw new DedupeError(
      `phash must be 16 lowercase hex chars — got ${JSON.stringify(a)} / ${JSON.stringify(b)}`,
    );
  }
  let bits = 0;
  for (let i = 0; i < 16; i++) {
    bits += NIBBLE_BITS[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return bits;
}

/** What a hasher is handed. Bytes when they are in memory, a path when not. */
export interface PerceptualHashInput {
  /** What is being hashed. `frame` is a sampled screen/video frame. */
  media_kind: "image" | "frame" | "video" | "doc";
  path?: string;
  bytes?: Uint8Array;
  width?: number;
  height?: number;
}

export interface PerceptualHasher {
  readonly id: string;
  /**
   * Whether this hasher produces hashes at all. `false` is the no-op: callers
   * can skip decoding work entirely instead of decoding an image so a stub can
   * throw the result away.
   */
  readonly hashes: boolean;
  /** null means "cannot hash this input" — never an error, never a guess. */
  hash(input: PerceptualHashInput): Phash | null;
}

export const NO_OP_HASHER_ID = "none";

/** The WhatsApp no-op: hashes nothing, so nothing is ever a duplicate. */
export const NO_OP_HASHER: PerceptualHasher = {
  id: NO_OP_HASHER_ID,
  hashes: false,
  hash(_input: PerceptualHashInput): Phash | null {
    return null;
  },
};

// ---- Registry -------------------------------------------------------------

const HASHERS = new Map<string, PerceptualHasher>([[NO_OP_HASHER_ID, NO_OP_HASHER]]);

export function registerHasher(hasher: PerceptualHasher): void {
  const id = hasher?.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new DedupeError("a hasher must have a non-empty string id");
  }
  if (id === NO_OP_HASHER_ID) {
    throw new DedupeError(`the ${JSON.stringify(NO_OP_HASHER_ID)} hasher is reserved`);
  }
  if (typeof hasher.hash !== "function") {
    throw new DedupeError(`hasher ${JSON.stringify(id)} has no hash(input) function`);
  }
  if (HASHERS.has(id)) {
    throw new DedupeError(`hasher ${JSON.stringify(id)} is already registered`);
  }
  HASHERS.set(id, hasher);
}

export function getHasher(id: string): PerceptualHasher {
  const found = HASHERS.get(id);
  if (!found) {
    throw new DedupeError(
      `unknown hasher ${JSON.stringify(id)} — registered: ${listHashers().join(", ")}`,
    );
  }
  return found;
}

export function listHashers(): readonly string[] {
  return [...HASHERS.keys()];
}

/** Test hygiene: drop everything but the reserved no-op. */
export function resetHashers(): void {
  for (const id of [...HASHERS.keys()]) {
    if (id !== NO_OP_HASHER_ID) HASHERS.delete(id);
  }
}

// ---- The window -----------------------------------------------------------

/**
 * Bit distance at or below which two frames are "the same screen". 6/64 is the
 * conventional starting point for a 64-bit phash: tolerant of a moved cursor
 * and a scrolled pixel, intolerant of a changed paragraph.
 */
export const DEFAULT_DEDUPE_DISTANCE = 6;

/**
 * How many recent hashes are kept per stream. Bounded on purpose — dedupe is a
 * novelty check against the last few minutes (§10.2 ③), not a global index, and
 * an unbounded map is a memory leak on a source that never stops capturing.
 */
export const DEFAULT_DEDUPE_WINDOW = 64;

export interface DedupeVerdict {
  /** True when a near-identical frame is already in this stream's window. */
  duplicate: boolean;
  /** The event this one repeats, when `duplicate`. */
  of_event_id: string | null;
  /** Bit distance to that event, when `duplicate`. */
  distance: number | null;
  /** The hash computed for this event, or null when the hasher is a no-op. */
  hash: Phash | null;
  /** Which hasher answered. */
  hasher: string;
}

interface WindowEntry {
  event_id: string;
  hash: Phash;
}

export interface PerceptualDedupeOptions {
  hasher?: PerceptualHasher;
  /** Max bit distance still counted as a repeat. Default DEFAULT_DEDUPE_DISTANCE. */
  max_distance?: number;
  /** Hashes retained per stream. Default DEFAULT_DEDUPE_WINDOW. */
  window?: number;
}

/**
 * Per-stream ring of recent hashes. Streams are kept apart because two people
 * sharing the same meme in two chats is not a duplicate — it is two events, and
 * collapsing them would lose one of them.
 */
export class PerceptualDedupe {
  private readonly hasher: PerceptualHasher;
  private readonly maxDistance: number;
  private readonly windowSize: number;
  private readonly windows = new Map<string, WindowEntry[]>();

  constructor(options: PerceptualDedupeOptions = {}) {
    this.hasher = options.hasher ?? NO_OP_HASHER;
    const distance = options.max_distance ?? DEFAULT_DEDUPE_DISTANCE;
    if (!Number.isInteger(distance) || distance < 0 || distance > 64) {
      throw new DedupeError(`max_distance must be an integer 0..64 — got ${distance}`);
    }
    const window = options.window ?? DEFAULT_DEDUPE_WINDOW;
    if (!Number.isInteger(window) || window < 1) {
      throw new DedupeError(`window must be an integer >= 1 — got ${window}`);
    }
    this.maxDistance = distance;
    this.windowSize = window;
  }

  /** Whether this instance can report duplicates at all. */
  get active(): boolean {
    return this.hasher.hashes;
  }

  /**
   * Record an event and say whether it repeats a recent one.
   *
   * A duplicate is still admitted to the window — a long run of near-identical
   * frames should compare against the most recent of them, not against the one
   * that opened the run twenty minutes ago, or the run would drift out from
   * under the threshold one pixel at a time.
   */
  admit(streamId: string, eventId: string, input: PerceptualHashInput): DedupeVerdict {
    const miss: DedupeVerdict = {
      duplicate: false,
      of_event_id: null,
      distance: null,
      hash: null,
      hasher: this.hasher.id,
    };
    if (!this.hasher.hashes) return miss;

    const hash = this.hasher.hash(input);
    if (hash === null) return miss;
    if (!isPhash(hash)) {
      throw new DedupeError(
        `hasher ${JSON.stringify(this.hasher.id)} returned ${JSON.stringify(hash)}, ` +
          `which is not 16 lowercase hex chars`,
      );
    }

    const ring = this.windows.get(streamId) ?? [];
    let best: { event_id: string; distance: number } | null = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const entry = ring[i];
      if (entry.event_id === eventId) continue;
      const distance = hamming(hash, entry.hash);
      if (distance <= this.maxDistance && (best === null || distance < best.distance)) {
        best = { event_id: entry.event_id, distance };
        if (distance === 0) break;
      }
    }

    ring.push({ event_id: eventId, hash });
    while (ring.length > this.windowSize) ring.shift();
    this.windows.set(streamId, ring);

    return best
      ? {
          duplicate: true,
          of_event_id: best.event_id,
          distance: best.distance,
          hash,
          hasher: this.hasher.id,
        }
      : { ...miss, hash };
  }

  /** Hashes currently retained for a stream. */
  size(streamId: string): number {
    return this.windows.get(streamId)?.length ?? 0;
  }

  /** Forget one stream's window — e.g. after a "forget this hour" gesture. */
  forget(streamId: string): void {
    this.windows.delete(streamId);
  }

  clear(): void {
    this.windows.clear();
  }
}

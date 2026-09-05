// ===========================================================================
// [CODE] The burst condition (Product_V6 §11.3; GoldenEvals GATE-06/07).
//
// K = 4 content-new events on ONE stream within W = 180 s, with no flush yet
// → flush now. A run of events on one stream is a count of engagement read
// off the event log — five distinct product pages on one domain in three
// minutes — not a judgement about what any one of them means. Nothing here
// reads text: novelty is a key the caller derives (content hash), and the
// window is arithmetic on timestamps.
//
// Repeats never count (GATE-06 variant: 4 pages of which 2 share a hash stay
// cold — only 2 content-new). Streams are independent (GATE-07: 2 + 2 on two
// domains is not a burst). A flush resets every stream's run, because the
// condition is "with no flush yet".
// ===========================================================================

/** Content-new events on one stream that make a burst. */
export const BURST_K = 4;
/** The window those K events must fall in. */
export const BURST_WINDOW_MS = 180_000;

export interface BurstParams {
  k: number;
  windowMs: number;
}

export const DEFAULT_BURST: BurstParams = { k: BURST_K, windowMs: BURST_WINDOW_MS };

export interface BurstVerdict {
  burst: boolean;
  /** Content-new events on the stream inside the window after this one. */
  runLength: number;
  /** Whether this event counted (false = a repeat). */
  counted: boolean;
}

/** Per-stream sliding window of content-new arrivals since the last flush. */
export class BurstTracker {
  private readonly runs = new Map<string, number[]>();
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly params: BurstParams = DEFAULT_BURST) {}

  /**
   * Record one event on `streamId` at `atMs`. `contentKey` identifies the
   * content (a hash); a key already seen on the stream since the last flush
   * is a repeat and neither counts nor extends the run.
   */
  note(streamId: string, atMs: number, contentKey: string): BurstVerdict {
    let seen = this.seen.get(streamId);
    if (!seen) {
      seen = new Set();
      this.seen.set(streamId, seen);
    }
    let run = this.runs.get(streamId);
    if (!run) {
      run = [];
      this.runs.set(streamId, run);
    }
    if (seen.has(contentKey)) {
      return { burst: false, runLength: this.inWindow(run, atMs).length, counted: false };
    }
    seen.add(contentKey);
    run.push(atMs);
    const live = this.inWindow(run, atMs);
    this.runs.set(streamId, live);
    return { burst: live.length >= this.params.k, runLength: live.length, counted: true };
  }

  /** A flush happened: every stream's run starts over ("with no flush yet"). */
  reset(): void {
    this.runs.clear();
    this.seen.clear();
  }

  /** Content-new events on the stream inside the window ending at `atMs`. */
  runLength(streamId: string, atMs: number): number {
    return this.inWindow(this.runs.get(streamId) ?? [], atMs).length;
  }

  private inWindow(run: readonly number[], atMs: number): number[] {
    const floor = atMs - this.params.windowMs;
    return run.filter((t) => t > floor && t <= atMs);
  }
}

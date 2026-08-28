// ===========================================================================
// The media reader's work loop (docs/rich-media-spec.md §8, v3 §2/§3).
//
// Two arrival paths, one worker: an attachment that just landed is described
// immediately (enqueueLive), while the history-sync backlog is drained at
// media.rate_per_min. Both switches (describe / backfill) are read fresh on
// every pass, so flipping them in Settings takes effect at the next item rather
// than at the next restart.
//
// Images ride together — enrichment.image_batch_size per CLI call, default 16
// (arch §10.1), because the cost of a call is almost entirely its fixed
// preamble. Each image carries an explicit id the answer must echo back; an
// answer whose id set is not exactly the sent set is discarded WHOLE and the
// batch is split in half and retried — 16 → 8 + 8 → 4 + 4 — down to a single
// read. Three calls to recover a bad answer, not sixteen, and no image can ever
// be given a caption the model wrote about another one.
//
// What the queue takes next is the cohort priority of §9.2/§9.3 — tier first,
// then horizon, then recency — NEVER insertion order. Backfilled history has the
// highest rowids and the oldest timestamps, so FIFO is exactly backwards.
//
// None of it blocks the text path (§8.4). Pass 1 read the text the moment it
// landed; when the last attachment on a session resolves — read, failed or
// skipped alike — ./enrich-pass.ts enqueues the one completion pass.
//
// Video posters (v7 §3) share the loop too, but sit AHEAD of everything except
// live media and outside the throttle entirely. One ffmpeg seek over a file
// already on disk costs no tokens and milliseconds of CPU, and a video with no
// poster is invisible to the description queue — so pacing it against a rate
// limit meant for model calls would only delay the reads behind it.
//
// Link scraping shares this loop rather than running a second one: it is the
// same claim/verdict lifecycle at the same throttle, and it only runs when the
// backlog has nothing left, so a model call is never delayed by an HTTP fetch.
//
// Transcription (v5 §3) shares it for the same reason and sits BEHIND both: it
// costs no tokens but minutes of CPU, and v5 §5 requires that media description
// and chat keep priority. So it is the last thing a fill tries — nothing is
// transcribed while any media row or any link is still waiting, or while any
// other unit is in flight — and a live attachment arriving mid-transcription
// kills the transcription outright. That costs only wall clock: the row keeps no
// in-flight marker, so it is claimed again as soon as the queue is idle.
//
// Up to media.concurrency units run at once (v6 §5, default 5). A batch and a
// single read are both ONE unit, so the cap counts calls rather than files. What
// stays global is the throttle: a backlog unit sets a debt of one tick per
// description it asked for and no other backlog unit starts until that debt is
// paid, so media.rate_per_min keeps meaning descriptions per minute however many
// slots are open. Concurrency buys the overlap the throttle does not cover — a
// batch call runs for minutes, far longer than the debt it owes. Live media is
// exempt from the debt, as it always was, so an arriving burst fills the slots
// at once.
//
// When the API refuses a call — the five-hour subscription limit, a 429, an auth
// failure — no NEW model call starts until a growing backoff expires. Five slots
// discovering the same refusal in parallel must not become five retries a second
// later; and that failure is not the row's fault, so it does not count against
// the row's attempts. Whisper and the link fetch are not model calls and keep
// running, which is the one thing still worth doing while the limit holds.
//
// Crash safety comes from having NO in-flight marker in the DB: a row only
// leaves 'pending' when a verdict is recorded, so a kill mid-read (or a stop()
// with five in flight) leaves it exactly where the next run picks it up. The
// in-memory sets below only stop two concurrent slots claiming the same row;
// they die with the process, which is the point. Repeated failures are retried a
// bounded number of times and then recorded as 'error' with the message, rather
// than circling the queue forever.
// ===========================================================================

import {
  claimPendingLinks,
  claimPendingMedia,
  claimPendingPosters,
  claimPendingTranscription,
  listMediaFramePaths,
  recordLinkScrape,
  recordMediaDescription,
  recordMediaFrames,
  recordTranscript,
  type MediaFrame,
  type PendingLinkRow,
  type PendingMediaRow,
  type PendingPosterRow,
  type PendingTranscriptRow,
} from "../db/ingest.js";
import { logRun } from "../db/index.js";
import { DEFAULT_PROVIDER_ID } from "../providers/index.js";
import {
  getMediaBackfillEnabled,
  getMediaConcurrency,
  getMediaDescribeEnabled,
  getMediaRatePerMin,
} from "../db/settings.js";
import {
  batchable,
  enrichmentRoute,
  getEnrichmentImageBatchSize,
  orderByEnrichmentPriority,
  runBatchWithSplit,
} from "./batch.js";
import {
  describeMedia,
  describeMediaBatch,
  type DescribeBatchResult,
  type DescribeOptions,
  type DescribeResult,
} from "./describe.js";
import { resolveEnrichment } from "./bundle-pass.js";
import {
  sampleVideoFrames,
  sweepOrphanFrames,
  type SampleOptions,
  type SampleResult,
} from "./frames.js";
import { scrapeLink, type LinkScrapeResult, type ScrapeOptions } from "./link.js";
import {
  generateVideoPoster,
  type PosterOptions,
  type PosterResult,
} from "./poster.js";
import {
  anyTranscriptionEnabled,
  frameSampling,
  getMediaBusinessEnabled,
  getMediaImageBatch,
  getMediaLinkScrapeEnabled,
  linkVideoBounds,
  mediaClaimFilter,
  transcriptClaimFilter,
} from "./switches.js";
import {
  transcribeMedia,
  type TranscribeOptions,
  type TranscribeResult,
} from "./transcribe.js";

/**
 * Rows pulled per cycle: at least one full batch, because the claim hands back
 * the batchable kinds first (v4 §4c) and a window narrower than the batch would
 * be the thing capping a call.
 */
const MIN_CLAIM = 25;

/** Nothing to do: re-check on this cadence instead of spinning. */
const IDLE_MS = 60_000;

/** Reads of one row before its failure stops being retried. */
const MAX_ATTEMPTS = 3;

/** Ceiling on the live set so an import burst cannot grow it without bound. */
const LIVE_MAX = 500;

/** First wait after the API refuses a call. Doubles per consecutive refusal. */
const BACKOFF_BASE_MS = 60_000;

/**
 * Ceiling on that wait. The five-hour limit outlasts it many times over, so this
 * is not "long enough to sit the limit out" — it is how coarsely we notice the
 * limit lifting, at the cost of one failed call.
 */
const BACKOFF_MAX_MS = 900_000;

/**
 * What "not now" looks like coming back from the CLI: the five-hour
 * subscription limit (reported as `overageStatus: rejected`), an HTTP 429, and
 * the auth failures, where a re-login is the fix and no number of retries is.
 * Matched on the message because the provider has no code for any of it —
 * QUOTA_EXCEEDED is declared in the provider types and never emitted. The
 * numbers are anchored so a path or an id that happens to contain them cannot
 * stall the queue for a minute.
 */
const REFUSAL =
  /(rate[ _-]?limit|too many requests|\b429\b|\b40[13]\b|overage|usage limit|quota|unauthorized|authentication|invalid api key|credit balance|\/login)/i;

/**
 * How often the idle loop deletes frame files the DB no longer points at. The
 * only thing that makes a frame unreferenced is a revoke or a rescan, so this
 * is housekeeping, not a hot path.
 */
const SWEEP_INTERVAL_MS = 900_000;

export interface MediaQueueOptions {
  /** The reader itself. Defaults to the Claude CLI read; tests stub it. */
  describe?: (
    row: PendingMediaRow,
    opts: DescribeOptions,
  ) => Promise<DescribeResult>;
  /** The multi-image read. Defaults to the Claude CLI read; tests stub it. */
  describeBatch?: (
    rows: PendingMediaRow[],
    opts: DescribeOptions,
  ) => Promise<DescribeBatchResult>;
  /** The link fetch. Defaults to the guarded HTTP scrape; tests stub it. */
  scrape?: (url: string, opts: ScrapeOptions) => Promise<LinkScrapeResult>;
  /** The ffmpeg frame sampler. Defaults to the real one; tests stub it. */
  sampleFrames?: (
    row: PendingMediaRow,
    opts: SampleOptions,
  ) => Promise<SampleResult>;
  /** The whisper transcription. Defaults to the real one; tests stub it. */
  transcribe?: (
    row: PendingTranscriptRow,
    opts: TranscribeOptions,
  ) => Promise<TranscribeResult>;
  /** The ffmpeg poster generator. Defaults to the real one; tests stub it. */
  poster?: (
    row: PendingPosterRow,
    opts: PosterOptions,
  ) => Promise<PosterResult>;
  log?: (line: string) => void;
}

/** True when a failure is the API refusing to serve, not the file being bad. */
export function isRefusal(error: string | null | undefined): boolean {
  return error ? REFUSAL.test(error) : false;
}

function claimLimit(): number {
  return Math.max(MIN_CLAIM, getMediaImageBatch());
}

export class MediaQueue {
  private readonly describe: NonNullable<MediaQueueOptions["describe"]>;
  private readonly describeBatch: NonNullable<
    MediaQueueOptions["describeBatch"]
  >;
  private readonly scrape: NonNullable<MediaQueueOptions["scrape"]>;
  private readonly sampleFrames: NonNullable<MediaQueueOptions["sampleFrames"]>;
  private readonly transcribe: NonNullable<MediaQueueOptions["transcribe"]>;
  private readonly poster: NonNullable<MediaQueueOptions["poster"]>;
  private readonly log: (line: string) => void;

  /** Ids that jumped the queue because they arrived live. */
  private readonly live = new Set<string>();
  /** Failed reads per id, until MAX_ATTEMPTS turns the failure terminal. */
  private readonly attempts = new Map<string, number>();
  /** Failed fetches per link id, on the same bound. */
  private readonly linkAttempts = new Map<string, number>();
  /** Failed transcriptions per id, on the same bound. */
  private readonly transcriptAttempts = new Map<string, number>();
  /**
   * Failed poster runs per id, on the same bound. This one is load-bearing
   * rather than a courtesy: the poster queue has no status column, so a row
   * leaves it only when a path is written, and without this a file ffmpeg
   * cannot open would be claimed again on every cycle forever. It dies with the
   * process, which is the right bound for a local decode costing milliseconds.
   */
  private readonly posterAttempts = new Map<string, number>();

  /**
   * What each queue's slots hold right now. The DB deliberately has no
   * in-flight marker, so this is the only thing stopping two slots claiming the
   * same row; being memory-only is the point, not a shortcut — a crash leaves
   * every row plainly 'pending' rather than marked as someone's work.
   */
  private readonly readingMedia = new Set<string>();
  private readonly fetchingLinks = new Set<string>();
  private readonly transcribing = new Set<string>();
  private readonly posterizing = new Set<string>();

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Guard on the fill pass, which starts units and never awaits one. */
  private filling = false;
  /** Units in flight of every kind — what media.concurrency caps. */
  private inFlight = 0;
  /** No backlog unit starts before this: the throttle, shared by every slot. */
  private throttleUntil = 0;
  /** No model call starts before this, after the API refused one. */
  private backoffUntil = 0;
  /** The wait that produced it, doubled on each consecutive refusal. */
  private backoffMs = 0;
  private abort: AbortController | null = null;
  /**
   * Why the last batch call failed, straight from describeMediaBatch. The split
   * driver only ever sees an EMPTY results map for a rejected answer — a
   * mismatch inside the call returns no verdicts at all — so its own verdict
   * reads "N missing, 0 unexpected" whatever actually went wrong. This carries
   * the real reason (and the marker sample) through to the log line, keyed by
   * the chunk so two slots splitting at once cannot borrow each other's.
   */
  private readonly batchErrors = new Map<string, string>();
  /** The in-flight transcription's own kill switch — see enqueueLive. */
  private transcribeAbort: AbortController | null = null;
  private lastSweepAt = 0;

  constructor(opts: MediaQueueOptions = {}) {
    this.describe = opts.describe ?? describeMedia;
    this.describeBatch = opts.describeBatch ?? describeMediaBatch;
    this.scrape = opts.scrape ?? scrapeLink;
    this.sampleFrames = opts.sampleFrames ?? sampleVideoFrames;
    this.transcribe = opts.transcribe ?? transcribeMedia;
    this.poster = opts.poster ?? generateVideoPoster;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** Begin draining. Calling it on an already-running queue does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.schedule(0);
  }

  /**
   * Stop and kill every in-flight read. Each row being read stays 'pending' —
   * the verdict is dropped rather than recorded, so a shutdown with five slots
   * open is indistinguishable from a crash and costs nothing but the tokens
   * spent. The units already running answer to the AbortController we drop
   * here, which is also how a late one knows not to free a slot it no longer
   * owns.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.transcribeAbort?.abort();
    this.transcribeAbort = null;
    this.live.clear();
    this.attempts.clear();
    this.linkAttempts.clear();
    this.transcriptAttempts.clear();
    this.posterAttempts.clear();
    this.readingMedia.clear();
    this.fetchingLinks.clear();
    this.transcribing.clear();
    this.posterizing.clear();
    this.inFlight = 0;
    this.throttleUntil = 0;
    this.backoffUntil = 0;
    this.backoffMs = 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * An attachment just landed: read it ahead of the backlog. The row still has
   * to be 'pending' in the DB to be read at all, so an id whose media the
   * writer already ruled unsupported is simply forgotten on the next cycle.
   */
  enqueueLive(id: string): void {
    if (!id) return;
    // An id whose row was never queueable is only forgotten once the backlog is
    // short enough to see the whole queue, so at the ceiling evict the oldest
    // rather than refusing the newest — live media must not lose its priority
    // just because a long backlog is still draining.
    if (this.live.size >= LIVE_MAX) {
      const oldest = this.live.values().next().value;
      if (oldest !== undefined) this.live.delete(oldest);
    }
    this.live.add(id);
    // A transcription runs for minutes and holds a slot for all of it, so with
    // the slots full the attachment that just landed would wait behind it — the
    // one thing v5 §5 says must not happen. Killing it forfeits only wall
    // clock; the row stays 'pending' and is claimed again when the queue idles.
    this.transcribeAbort?.abort();
    this.wake();
  }

  // ---- Loop ---------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Cut a pending idle/throttle wait short: live work arrived, or a slot freed. */
  private wake(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.schedule(0);
  }

  private tick(): void {
    if (!this.running || this.filling) return;
    this.filling = true;
    let next = IDLE_MS;
    try {
      next = this.fill();
    } catch (err) {
      // A DB/settings failure must not kill the loop — back off and retry.
      this.log(`[media] queue cycle failed: ${(err as Error).message}`);
    } finally {
      this.filling = false;
    }
    this.schedule(next);
  }

  /**
   * Start as much work as the cap allows and say how long until the next
   * attempt is worth making. Nothing here awaits a unit: a slot that is busy
   * for the next four minutes must not hold up the four that are free.
   */
  private fill(): number {
    const cap = getMediaConcurrency();
    let wait = IDLE_MS;
    let started = false;
    while (this.inFlight < cap) {
      // Live arrivals come first at every slot, and the throttle — which exists
      // to pace the backlog — does not govern them.
      if (this.startLive()) {
        started = true;
        continue;
      }
      // Posters are one local ffmpeg seek over a file already on disk: no
      // tokens, no outbound request, milliseconds. They run ahead of the
      // backlog and are not paced by a throttle that counts model calls,
      // because until a video has one the description queue cannot see it at
      // all (v7 §3).
      if (this.startPoster()) {
        started = true;
        continue;
      }
      const now = Date.now();
      if (now < this.throttleUntil) {
        wait = Math.min(wait, this.throttleUntil - now);
        break;
      }
      const cost = this.startBacklog();
      if (cost === 0) break;
      started = true;
      // A rate of DESCRIPTIONS: a batch owes a tick for every one it asked for.
      this.throttleUntil = now + cost * this.throttleMs();
    }
    if (!started && this.inFlight === 0) this.sweep();
    const held = this.backoffUntil - Date.now();
    return held > 0 ? Math.min(wait, held) : wait;
  }

  /**
   * Start one throttled unit, in the order that IS the priority: nothing is
   * fetched while a read is owed, and nothing is transcribed while either is
   * (v5 §5). Returns the descriptions the throttle should charge for, or 0 when
   * there was nothing to start.
   */
  private startBacklog(): number {
    const descriptions = this.startBacklogMedia();
    if (descriptions > 0) return descriptions;
    if (this.startLink()) return 1;
    return this.startTranscript() ? 1 : 0;
  }

  /**
   * The media rows a slot may take right now. Rows another slot already holds
   * are excluded here rather than in the SQL, because what makes a row
   * unavailable is memory-only by design — see readingMedia.
   */
  private claimMedia(): PendingMediaRow[] {
    if (!getMediaDescribeEnabled()) return [];
    // A refused call is refused for every slot, so no new one is made at all.
    if (Date.now() < this.backoffUntil) return [];

    const limit = claimLimit() + this.readingMedia.size;
    const batch = claimPendingMedia(limit, mediaClaimFilter());
    // A short batch IS the whole pending queue, so anything remembered but
    // absent from it has left the queue and must not pin memory.
    if (batch.length < limit) this.forgetSettled(batch);

    const out: PendingMediaRow[] = [];
    for (const row of batch) {
      if (this.readingMedia.has(row.id)) continue;
      // enrichment.read_all_media = off skips stickers (§8.4 table). A skip is a
      // VERDICT, not a silence: the row leaves the queue and its session's
      // countdown moves, or pass 2 would wait on it forever.
      const route = enrichmentRoute({ kind: row.kind, seconds: row.seconds });
      if (route.step === "skip") {
        recordMediaDescription(row.id, {
          status: "skipped",
          model: "",
          error: route.reason ?? "not read at the current settings",
        });
        this.live.delete(row.id);
        this.resolvePass(row.id, null);
        continue;
      }
      out.push(row);
    }
    return out;
  }

  /** Start the read of an attachment that just landed. */
  private startLive(): boolean {
    // The row's own flag decides, not the caller's: a message history sync
    // replayed is backlog however its id reached the live set.
    const live = this.claimMedia().filter(
      (r) => this.live.has(r.id) && !r.isHistorical,
    );
    if (live.length === 0) return false;
    this.startRead(this.group(live));
    return true;
  }

  /** Start one backlog read. Returns the descriptions it asked for, or 0. */
  private startBacklogMedia(): number {
    if (!getMediaBackfillEnabled()) return 0;
    const free = this.claimMedia();
    if (free.length === 0) return 0;
    const group = this.group(free);
    this.startRead(group);
    return group.length;
  }

  /**
   * Give one video a poster. False when every video already has one, or when
   * the only ones left are files this process has already failed to open.
   */
  private startPoster(): boolean {
    const rows = claimPendingPosters(
      1 + this.posterizing.size + this.posterAttempts.size,
    );
    const row = rows.find(
      (r) =>
        !this.posterizing.has(r.id) &&
        (this.posterAttempts.get(r.id) ?? 0) < MAX_ATTEMPTS,
    );
    if (!row) return false;
    this.startUnit(this.posterizing, [row.id], () => this.makePoster(row));
    return true;
  }

  /** Fetch one link. False when scraping is off or nothing is queued. */
  private startLink(): boolean {
    if (!getMediaLinkScrapeEnabled()) return false;
    const rows = claimPendingLinks(1 + this.fetchingLinks.size, {
      business: getMediaBusinessEnabled(),
    });
    const row = rows.find((r) => !this.fetchingLinks.has(r.id));
    if (!row) return false;
    this.startUnit(this.fetchingLinks, [row.id], () => this.fetch(row));
    return true;
  }

  /**
   * Transcribe one file, and only with every other slot empty: it costs no
   * tokens but minutes of CPU, so v5 §5 keeps it behind every model call and
   * every fetch, and one whisper at a time is all a Mac has to give it. A unit
   * that came back to the top is a unit a live attachment can win.
   */
  private startTranscript(): boolean {
    if (this.inFlight > 0) return false;
    if (!anyTranscriptionEnabled()) return false;
    const [row] = claimPendingTranscription(1, transcriptClaimFilter());
    if (!row) return false;
    // enrichment.read_all_media = off skips sub-2 s audio (§8.4 table). Same
    // rule as a skipped sticker: a verdict, not a silence, so pass 2 is not
    // left waiting on a clip nobody will ever transcribe.
    const route = enrichmentRoute({ kind: row.voice ? "voice" : "audio", seconds: row.seconds });
    if (route.step === "skip") {
      recordTranscript(row.id, {
        status: "skipped",
        model: "",
        error: route.reason ?? "not transcribed at the current settings",
      });
      this.resolvePass(row.id, null);
      return true;
    }
    this.startUnit(this.transcribing, [row.id], () => this.listen(row));
    return true;
  }

  /** Take a slot for one read, batched or not. */
  private startRead(group: PendingMediaRow[]): void {
    const ids = group.map((r) => r.id);
    this.startUnit(this.readingMedia, ids, () =>
      group.length > 1 ? this.readBatch(group) : this.read(group[0]),
    );
  }

  /**
   * Take a slot, run the work, and free the slot — whatever the work did. The
   * AbortController is the generation marker: a unit that outlives a stop()
   * frees nothing, because stop() already returned every slot and a later run
   * may own them.
   */
  private startUnit(
    held: Set<string>,
    ids: readonly string[],
    work: () => Promise<unknown>,
  ): void {
    const run = this.abort;
    for (const id of ids) held.add(id);
    this.inFlight += 1;
    void work()
      .catch((err) => {
        this.log(`[media] unit failed: ${(err as Error).message}`);
      })
      .finally(() => {
        if (run !== this.abort) return;
        for (const id of ids) held.delete(id);
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.wake();
      });
  }

  /**
   * Sweep frame files the DB no longer references. Only on the idle path and
   * only every SWEEP_INTERVAL_MS — a revoke is the thing that unreferences
   * them, and nothing is waiting on the disk space.
   */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    try {
      const removed = sweepOrphanFrames(listMediaFramePaths());
      if (removed > 0) this.log(`[media] swept ${removed} unreferenced frames`);
    } catch (err) {
      this.log(`[media] frame sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * The rows one call may cover, in PRIORITY order (§9.2/§9.3) — tier first,
   * then horizon, then recency. Never the order the claim came back in, and
   * never insertion order: a photo from an hour ago is read before a photo from
   * 2023 however they reached the table.
   *
   * The head is taken from what can share a call rather than from the top of the
   * pool: a document is read one per call, and a tick that spends itself on one
   * while a full batch of images waits behind is the whole reason the claim
   * orders batchable first.
   */
  private group(pool: PendingMediaRow[]): PendingMediaRow[] {
    const ordered = orderByEnrichmentPriority(pool);
    const images = ordered.filter(batchable);
    if (images.length > 1) return images.slice(0, getEnrichmentImageBatchSize());
    return [ordered[0]!];
  }

  private async read(row: PendingMediaRow): Promise<void> {
    const startedAt = Date.now();
    const runId = `media-${row.id}`;
    const frames = await this.framesFor(row);
    let result: DescribeResult;
    try {
      result = await this.describe(row, {
        runId,
        signal: this.abort?.signal,
        frames,
      });
    } catch (err) {
      result = {
        description: null,
        status: "error",
        model: "",
        error: (err as Error).message,
      };
    }
    // Stopped while we were reading: leave the row pending, record nothing.
    if (!this.running) return;

    this.logRead(runId, result, Date.now() - startedAt);
    if (result.status === "error" && isRefusal(result.error)) {
      this.holdOff(result.error);
      // Not this row's failure — the call never looked at it, so it keeps its
      // attempts AND its place in the live set.
      this.requeue(row.id, result);
      return;
    }
    if (result.status === "done") this.resume();
    this.settle(row.id, result);
  }

  /**
   * Sample a video into frames before it is read (v5 §2), and record them — the
   * column is the only thing that says those files exist, so writing it is what
   * keeps the sweep from taking them straight back. Empty for everything that
   * is not a video, and empty when the switch is off, which is what puts the
   * reader back on the single thumbnail it used before.
   *
   * Sampling that fails is logged and not fatal: an empty list is a fall back
   * to the thumbnail, which is strictly what today's behaviour already is.
   */
  private async framesFor(row: PendingMediaRow): Promise<MediaFrame[]> {
    if (row.kind !== "video") return [];
    const { enabled, intervalSec, maxFrames } = frameSampling();
    if (!enabled) return [];

    let result: SampleResult;
    try {
      result = await this.sampleFrames(row, {
        intervalSec,
        maxFrames,
        signal: this.abort?.signal,
      });
    } catch (err) {
      this.log(`[media] frame sampling failed for ${row.id}: ${(err as Error).message}`);
      return [];
    }
    if (result.error) {
      this.log(`[media] frames for ${row.id}: ${result.error}`);
    }
    if (!this.running) return [];
    recordMediaFrames(row.id, result.frames);
    return result.frames;
  }

  /**
   * Read a group, splitting it in half every time the answer's id set does not
   * match the one that was sent (§10.1 point 4). Sixteen images that come back
   * one caption short cost three calls — 16, then 8 and 8 — rather than the
   * sixteen V11's drop-to-solo spent, and nothing from a rejected answer is
   * applied to anything.
   *
   * A row is never remembered as unbatchable: a bad answer is a property of that
   * answer, not of the images in it, so the next cycle batches them again.
   */
  private async readBatch(rows: PendingMediaRow[]): Promise<void> {
    const outcome = await runBatchWithSplit<PendingMediaRow, DescribeResult>(rows, {
      call: (chunk) => this.callBatch(chunk),
      apply: (row, result) => this.settle(row.id, result),
      solo: (row) => this.read(row),
      running: () => this.running,
      onMismatch: (verdict, chunk) => {
        // The inner error names the ids and the malformed markers; the outer
        // verdict can only ever say "all of them missing", which is noise.
        const key = chunkKey(chunk);
        const why =
          this.batchErrors.get(key) ??
          `${verdict.missing.length} id(s) missing, ${verdict.unexpected.length} unexpected`;
        this.batchErrors.delete(key);
        this.log(`[media] batch of ${chunk.length} rejected: ${why} — splitting`);
      },
    });
    if (outcome.mismatches > 0) {
      this.log(`[media] ${rows.length} images took ${outcome.calls} call(s) after a mismatch`);
    }
  }

  /**
   * One batch call. The verdicts come back for ALL of the rows or for none of
   * them — the id echo is checked inside describeMediaBatch — so there is
   * nothing here to line up by position.
   */
  private async callBatch(
    rows: readonly PendingMediaRow[],
  ): Promise<{ results: Map<string, DescribeResult>; refused?: boolean }> {
    const startedAt = Date.now();
    const runId = `media-batch-${rows[0]!.id}-${rows.length}`;
    let batch: DescribeBatchResult;
    try {
      batch = await this.describeBatch([...rows], {
        runId,
        signal: this.abort?.signal,
      });
    } catch (err) {
      batch = failedBatch([...rows], (err as Error).message);
    }
    if (!this.running) return { results: new Map() };

    // One call, one logged run — the batch's spend belongs to the invocation,
    // not to a fraction of each image. The error text carries the echo verdict
    // and a sample of the offending markers, so extraction_runs.error_code is
    // enough to tell WHY a batch was rejected without the CLI transcript.
    this.logRead(runId, batch.call, Date.now() - startedAt);
    const key = chunkKey(rows);
    if (batch.call.status === "error" && batch.call.error) {
      this.batchErrors.set(key, batch.call.error);
    } else this.batchErrors.delete(key);

    // A refusal belongs to the CALL, not to any file in it: it is counted once
    // however many rows carry the message, and re-asking one file at a time is
    // sixteen more knocks on the same closed door.
    const refused = batch.call.status === "error" && isRefusal(batch.call.error);
    if (refused) {
      this.holdOff(batch.call.error);
      for (const row of rows) {
        const result = batch.results.get(row.id);
        if (result && result.status === "error") this.requeue(row.id, result);
      }
      return { results: new Map(), refused: true };
    }
    if (batch.call.status === "done") this.resume();
    return { results: batch.results };
  }

  /**
   * Hold every model call back for a growing wait. Five slots discovering the
   * same limit must not become five retries a second later, and a limit that
   * lasts five hours is not something to poll at the throttle's cadence.
   */
  private holdOff(error: string | null): void {
    this.backoffMs = this.backoffMs
      ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
      : BACKOFF_BASE_MS;
    this.backoffUntil = Date.now() + this.backoffMs;
    this.log(
      `[media] backing off ${Math.round(this.backoffMs / 1000)}s: ${error ?? "refused"}`,
    );
  }

  /** A call got through, so the next one has nothing to wait for. */
  private resume(): void {
    this.backoffMs = 0;
    this.backoffUntil = 0;
  }

  /** Leave a row exactly as queued as it was, with the reason on it. */
  private requeue(id: string, result: DescribeResult): void {
    recordMediaDescription(id, {
      status: "pending",
      model: result.model,
      error: result.error,
    });
  }

  /** Record a verdict, or keep the row queued while its failures are retried. */
  private settle(id: string, result: DescribeResult): void {
    this.live.delete(id);

    if (result.status === "error") {
      const attempt = (this.attempts.get(id) ?? 0) + 1;
      if (attempt < MAX_ATTEMPTS) {
        this.attempts.set(id, attempt);
        // Still queued, but the reason is on the row so a stuck item is
        // explainable while it is still being retried.
        this.requeue(id, result);
        return;
      }
    }
    this.attempts.delete(id);

    recordMediaDescription(id, {
      description: result.description,
      model: result.model,
      status: result.status,
      error: result.error,
    });
    this.resolvePass(id, result.description);
  }

  /**
   * The verdict is on the row, whatever it says — so this attachment is no
   * longer pending as far as spec §4.4 is concerned. Ready, failed and skipped
   * all count as resolved; every dispatched bundle waiting on this event
   * counts down by one and, at zero, acts exactly once — one scoped
   * re-understand job, or a full re-dispatch when a placeholder forced an
   * episode into `unsorted`.
   *
   * Never fatal. Enrichment must not be able to break the text path, and an
   * event no bundle is waiting on simply has nothing to count down.
   */
  private resolvePass(id: string, text: string | null): void {
    try {
      for (const r of resolveEnrichment(id, { text })) {
        if (r.action === "understand_enqueued") {
          this.log(
            `[media] bundle ${r.bundleId} fully read — re-understand queued` +
              (r.episodeIds.length > 0 ? ` (episodes ${r.episodeIds.join(", ")})` : ""),
          );
        } else if (r.action === "redispatched") {
          this.log(`[media] bundle ${r.bundleId} fully read — placeholder forced unsorted, re-dispatching`);
        }
      }
    } catch (err) {
      this.log(`[media] completion pass check failed for ${id}: ${(err as Error).message}`);
    }
  }

  /**
   * Transcribe one row. Preempted or stopped, it records nothing: the row stays
   * 'pending', and freeing the slot is what lets the live attachment that
   * interrupted it go first.
   *
   * Nothing is logged to extraction_runs. whisper is local and costs no tokens,
   * so a row there would report a $0 model call that never happened.
   */
  private async listen(row: PendingTranscriptRow): Promise<void> {
    const abort = new AbortController();
    this.transcribeAbort = abort;
    let result: TranscribeResult;
    try {
      result = await this.transcribe(row, { signal: abort.signal });
    } catch (err) {
      result = {
        transcript: null,
        status: "error",
        model: "",
        error: (err as Error).message,
      };
    } finally {
      if (this.transcribeAbort === abort) this.transcribeAbort = null;
    }
    if (!this.running || abort.signal.aborted) return;

    if (result.status === "error") {
      const attempt = (this.transcriptAttempts.get(row.id) ?? 0) + 1;
      // A partial transcript is terminal, not retryable: it IS the answer, and
      // re-running the same file would only produce the same partial again.
      if (attempt < MAX_ATTEMPTS && result.transcript === null) {
        this.transcriptAttempts.set(row.id, attempt);
        recordTranscript(row.id, {
          status: "pending",
          model: result.model,
          error: result.error,
        });
        return;
      }
    }
    this.transcriptAttempts.delete(row.id);

    recordTranscript(row.id, {
      transcript: result.transcript,
      model: result.model,
      status: result.status,
      error: result.error,
    });
    // A transcription is an enrichment like any other: pass 2 waits for it, and
    // an unreadable voice note resolves rather than stalling the episode.
    this.resolvePass(row.id, result.transcript);
  }

  /**
   * Pull one frame out of a video and record it as that row's thumbnail (v7
   * §3). Nothing is logged to extraction_runs: it is ffmpeg, not a model call,
   * and a row there would report a $0 call that never happened.
   *
   * A failure is only remembered in memory, because there is nowhere on the row
   * to put it — recording a poster path that points at nothing would render as
   * a broken image, which is worse than the file chip it replaced.
   */
  private async makePoster(row: PendingPosterRow): Promise<void> {
    let result: PosterResult;
    try {
      result = await this.poster(row, { signal: this.abort?.signal });
    } catch (err) {
      result = { path: null, error: (err as Error).message };
    }
    if (!this.running) return;

    if (result.path) {
      this.posterAttempts.delete(row.id);
      return;
    }
    const attempt = (this.posterAttempts.get(row.id) ?? 0) + 1;
    this.posterAttempts.set(row.id, attempt);
    if (attempt >= MAX_ATTEMPTS) {
      this.log(`[media] no poster for ${row.id}: ${result.error ?? "unknown"}`);
    }
  }

  private async fetch(row: PendingLinkRow): Promise<void> {
    let result: LinkScrapeResult;
    try {
      result = await this.scrape(row.url, {
        signal: this.abort?.signal,
        video: linkVideoBounds(row.id),
      });
    } catch (err) {
      result = {
        status: "error",
        scrapedText: null,
        title: null,
        error: (err as Error).message,
      };
    }
    if (!this.running) return;

    // Before the verdict, and whatever the verdict is: the column IS the only
    // record those files exist, so a scrape that failed after sampling would
    // otherwise leave them for the sweep to delete (v5 §2).
    if (result.frames?.length) recordMediaFrames(row.id, result.frames);

    if (result.status === "error") {
      const attempt = (this.linkAttempts.get(row.id) ?? 0) + 1;
      if (attempt < MAX_ATTEMPTS) {
        this.linkAttempts.set(row.id, attempt);
        recordLinkScrape(row.id, { status: "pending", error: result.error });
        return;
      }
    }
    this.linkAttempts.delete(row.id);

    recordLinkScrape(row.id, {
      scrapedText: result.scrapedText,
      title: result.title,
      status: result.status,
      error: result.error,
    });
    this.resolvePass(row.id, result.scrapedText ?? result.title);
  }

  /** Descriptions per minute → the gap between two backlog reads. */
  private throttleMs(): number {
    return Math.ceil(60_000 / Math.max(1, getMediaRatePerMin()));
  }

  private forgetSettled(batch: PendingMediaRow[]): void {
    if (this.live.size === 0 && this.attempts.size === 0) return;
    const queued = new Set(batch.map((r) => r.id));
    for (const id of this.live) if (!queued.has(id)) this.live.delete(id);
    for (const id of this.attempts.keys()) {
      if (!queued.has(id)) this.attempts.delete(id);
    }
  }

  /**
   * Every Claude call is logged; the ones we never made are not. Usage is NOT
   * added to the quota counter: the backlog would otherwise burn the window the
   * chat gate spends, and a background reader must never lock the user out of
   * chat.
   */
  private logRead(
    runId: string,
    result: DescribeResult,
    durationMs: number,
  ): void {
    if (result.status === "unsupported" || result.status === "skipped") return;
    logRun({
      provider: DEFAULT_PROVIDER_ID,
      sessionId: null,
      runId,
      kind: "media",
      promptChars: result.promptChars ?? 0,
      inputTokens: result.usage?.inputTokens ?? 0,
      cacheCreationInputTokens: result.usage?.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      costUsd: result.usage?.costUsd ?? null,
      durationMs,
      status: result.status === "done" ? "ok" : "error",
      errorCode: result.error,
      role: "media",
      model: result.model,
    });
  }
}

/** Identifies one chunk of the split recursion — first row plus its size. */
function chunkKey(rows: readonly PendingMediaRow[]): string {
  return `${rows[0]?.id ?? ""}:${rows.length}`;
}

/** A batch whose call never returned: every row failed, retryably. */
function failedBatch(
  rows: PendingMediaRow[],
  error: string,
): DescribeBatchResult {
  const verdict: DescribeResult = {
    description: null,
    status: "error",
    model: "",
    error,
  };
  return {
    results: new Map(rows.map((r) => [r.id, verdict])),
    call: verdict,
  };
}

// ---------------------------------------------------------------------------
// Process-wide handle. The server owns the lifetime; ingestion only needs to
// point at whatever is running, so a worker booted without the queue (tests)
// silently does no live reading instead of needing the instance threaded
// through the ingestion constructor.
// ---------------------------------------------------------------------------

let current: MediaQueue | null = null;

/** Start the shared media reader. Idempotent — a second call is a no-op. */
export function startMediaQueue(opts?: MediaQueueOptions): MediaQueue {
  if (!current) current = new MediaQueue(opts);
  current.start();
  return current;
}

/** Stop the shared media reader and drop it. Safe when none is running. */
export function stopMediaQueue(): void {
  current?.stop();
  current = null;
}

/**
 * Read a just-inserted attachment ahead of the backlog. No-op when stopped, and
 * no-op for a history replay: those reach the writer through the same callback
 * as a live message, and an import treated as live would be read at no throttle,
 * one arrival per call, instead of in full batches at the configured rate.
 */
export function enqueueLiveMedia(id: string, historical = false): void {
  if (historical) return;
  current?.enqueueLive(id);
}

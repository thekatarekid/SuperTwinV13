// Typed client for the local worker (Phase 0 §7).
//
// The worker streams `POST /api/chat` as `text/event-stream`. We do NOT use the
// browser EventSource API (it only supports GET); instead we POST and parse the
// SSE frames MANUALLY off the Response body reader:
//   - accumulate decoded bytes into a buffer,
//   - split completed frames on the blank-line delimiter "\n\n",
//   - within a frame, take the `data:` line(s), strip the prefix, JSON.parse,
//   - dispatch the resulting ProviderStreamEvent to the matching handler.
//
// A frame's JSON payload may be split across multiple network chunks, and a
// single `delta` may likewise arrive in two reads — the buffering below makes
// both cases safe.

import { workerUrl, WORKER_BASE_URL } from "./config";
import type {
  InboxChat,
  InboxMessage,
  Range,
  ResetResult,
  SearchHit,
  StatusUpdate,
  WhatsAppStatusResponse,
} from "./whatsapp-types";

// Re-export the mirrored WhatsApp/Inbox contract types so consumers can import
// everything from a single client module (same convenience the Phase-0 types
// have here).
export * from "./whatsapp-types";

// ---------------------------------------------------------------------------
// Contract types — mirror worker/src/providers/types.ts (§5) and the server
// response shapes (§7). Kept local so the UI has no cross-package import.
// ---------------------------------------------------------------------------

/**
 * Token spend for one run. `inputTokens` is the FRESH, uncached delta only — on
 * a media call it is a few dozen tokens while the cache fields carry tens of
 * thousands, so the two cache numbers are what a spend figure has to include.
 */
export interface Usage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export type ProviderErrorCode =
  | "TIMEOUT"
  | "SPAWN_FAILED"
  | "CLI_ERROR"
  | "POISONED_SESSION"
  | "CANCELLED"
  | "QUOTA_EXCEEDED"
  | "BAD_REQUEST";

/** Citation kinds per the Phase 2 provenance convention. */
export type CitationKind = "event" | "space" | "person" | "task";

/** One `[n]` citation attached to a grounded chat answer. */
export interface Citation {
  n: number;
  kind: CitationKind;
  id: string;
  label: string;
}

export type ProviderStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "delta"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "done"; sessionId: string; usage: Usage; stopReason?: string }
  /** Final frame of a grounded run: the parsed citations for the answer. */
  | { type: "citations"; citations: Citation[] }
  | {
      type: "error";
      code: ProviderErrorCode;
      message: string;
      sessionId?: string;
    };

export type ChatRole = "user" | "assistant" | "system";

/** Row shape from GET /api/sessions. */
export interface SessionSummary {
  sessionId: string;
  title: string | null;
  cwd: string;
  status: "active" | "poisoned";
  /** Phase 2: true when the session runs with brain access (grounded chat). */
  grounded?: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** A stored message inside a session detail (GET /api/sessions/:id). */
export interface SessionMessage {
  role: ChatRole;
  content: string;
  ts: string;
  runId?: string | null;
  /** Phase 2: citations persisted with a grounded assistant answer. */
  citations?: Citation[] | null;
}

export interface SessionDetail {
  session: SessionSummary;
  messages: SessionMessage[];
}

/**
 * What media reading spent in the same window. It is reported separately and
 * never counts toward the chat limit — a background backlog must not be able to
 * lock the user out of chat.
 */
export interface MediaSpend {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  billableTokens: number;
  /** null when no run in the window reported a cost — which is not $0. */
  costUsd: number | null;
  runCount: number;
}

export interface QuotaInfo {
  windowMs: number;
  windowStart: string | number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /**
   * The weighted equivalent the limit is compared against: a cache read bills
   * at about a tenth of fresh input, so the raw sum would trip the gate roughly
   * ten times too early.
   */
  billableTokens: number;
  /** null when no run in the window reported a cost — which is not $0. */
  costUsd: number | null;
  runCount: number;
  nearLimit: boolean;
  media: MediaSpend;
}

export interface HealthInfo {
  ok: boolean;
  version?: string;
}

/** One selectable Claude model from the worker catalog (GET /api/settings/models). */
export interface ModelInfo {
  id: string;
  label: string;
  family: string;
}

/** One assignable role (chat / extraction / execution) from the model settings. */
export interface RoleInfo {
  key: string;
  label: string;
  description: string;
  /** True for roles not yet wired up (e.g. task execution); still persistable. */
  future: boolean;
}

/**
 * Response of GET /api/settings/models: the full catalog, the assignable roles,
 * the current per-role selections, and the per-role on/off flags.
 * `selections[roleKey]` is the chosen model id ("" means Default / subscription
 * default); `enabledByRole[roleKey]` is that process's kill-switch (`extraction`
 * aliases the extraction kill-switch). Optional so older mocks/fixtures that omit
 * it still type-check; the UI defaults a missing flag to enabled.
 */
export interface ModelSettings {
  models: ModelInfo[];
  roles: RoleInfo[];
  selections: Record<string, string>;
  enabledByRole?: Record<string, boolean>;
}

/**
 * Response of GET /api/chat/status: whether the chat role is switched on in
 * Settings. Chat is the app's only feature, so the Chat tab reads this to say
 * so out loud instead of silently failing every send.
 */
export interface ChatStatus {
  enabled: boolean;
}

/**
 * Media reading settings (GET/POST /api/settings/media). `describe_enabled` is
 * the master switch for the media reader, `backfill_enabled` lets it work
 * through already-imported media, `rate_per_min` caps how many descriptions it
 * may request per minute, and `image_batch` is how many photos share one call.
 * The four per-type switches decide WHAT may be read; only `images_enabled` is
 * on by default. Snake_case mirrors the worker's stored keys.
 */
export interface MediaSettings {
  describe_enabled: boolean;
  backfill_enabled: boolean;
  images_enabled: boolean;
  video_enabled: boolean;
  business_enabled: boolean;
  link_scrape_enabled: boolean;
  /** v5 §2: sample frames across a video instead of reading one thumbnail. */
  video_frames_enabled: boolean;
  /** v5 §3: transcribe the audio track inside videos. */
  video_audio_enabled: boolean;
  /** v5 §3: transcribe voice notes and audio attachments. */
  voice_notes_enabled: boolean;
  rate_per_min: number;
  /** v6 §5: how many media reads run at once. A batch counts as one. */
  concurrency: number;
  image_batch: number;
  /** One frame every this many seconds of clip, before the cap applies. */
  video_frame_interval_sec: number;
  /** Never more than this many frames from one video, however long it is. */
  video_frame_max: number;
  /**
   * v7 §4: the tallest a linked video is downloaded at. A download is the one
   * case where we choose the file, and a still is scaled down to 768px anyway.
   */
  video_max_height: number;
  /** The whisper model id transcription runs against (a catalogue id). */
  whisper_model: string;
}

/**
 * The worker's clamp ceiling for `image_batch` (MAX_IMAGE_BATCH). Mirrored so
 * the picker cannot offer a number the worker would silently reduce.
 */
export const MEDIA_IMAGE_BATCH_MAX = 40;

/** The worker's ceilings for the two frame-sampling numbers, mirrored likewise. */
export const MEDIA_FRAME_INTERVAL_SEC_MAX = 3600;
export const MEDIA_FRAME_MAX = 20;

/**
 * The download height's bounds. It is the one media number with a floor as well
 * as a ceiling: under it no site publishes a matching format and every download
 * silently falls back to "worst".
 */
export const MEDIA_VIDEO_MAX_HEIGHT_MIN = 144;
export const MEDIA_VIDEO_MAX_HEIGHT_MAX = 1080;

/** The worker's ceiling for `concurrency` (MAX_MEDIA_CONCURRENCY), mirrored. */
export const MEDIA_CONCURRENCY_MAX = 20;

/** What POST /api/media/rescan accepts. `business` matches by chat, not kind. */
export type RescanType =
  | "image"
  | "video"
  | "document"
  | "link"
  | "business"
  | "frames"
  | "transcript";

/** Rows POST /api/media/rescan moved back to pending, by queue. */
export interface RescanResult {
  media: number;
  links: number;
  /** Rows queued to be transcribed again. */
  transcripts: number;
  /** Videos whose sampled frames were thrown away, to be sampled again. */
  frames: number;
}

/** One bundled binary, as GET /api/media/tools reports it (v5 §4). */
export interface BinaryState {
  path: string | null;
  present: boolean;
  /** What the binary answered when asked, or null when it could not be asked. */
  version: string | null;
}

/** A download in flight, or the failure the last attempt ended in. */
export interface ModelDownload {
  id: string;
  status: "downloading" | "error";
  receivedBytes: number;
  /** What the server said it would send; null when it never said. */
  totalBytes: number | null;
  error: string | null;
}

/** One whisper model: what it costs, whether it is here, and any live fetch. */
export interface WhisperModelState {
  id: string;
  label: string;
  /** The download size. `bytesOnDisk` is what is actually here. */
  bytes: number;
  /** Shipped inside the app — present with no network, and never deletable. */
  bundled: boolean;
  present: boolean;
  bytesOnDisk: number | null;
  selected: boolean;
  download: ModelDownload | null;
}

/** Response of GET /api/media/tools — everything transcription needs to run. */
export interface MediaToolState {
  ffmpeg: BinaryState;
  whisper: BinaryState;
  /** Bundled for YouTube captions (v6 §4). */
  ytdlp: BinaryState;
  models: WhisperModelState[];
  /** Where downloaded models land — outside the app, so an update keeps them. */
  modelsDir: string;
}

/** One file of the encoder, as GET /api/retrieval/semantic reports it. */
export interface EmbeddingFileState {
  path: string;
  bytes: number;
  present: boolean;
  bytesOnDisk: number | null;
}

/** The encoder fetch in flight, or the failure the last attempt ended in. */
export interface EmbeddingDownload {
  status: "downloading" | "error";
  receivedBytes: number;
  totalBytes: number;
  /** Which of the files is being fetched right now. */
  file: string;
  error: string | null;
}

/**
 * Response of GET /api/retrieval/semantic (docs/v6-spec.md §1, tier 3). Three
 * things have to be true before chats are searchable by meaning — the switch is
 * on, the runtime shipped, and the encoder is downloaded — so all three are
 * reported separately rather than collapsed into one boolean.
 */
export interface SemanticState {
  /** The stored switch, which is not the same as the tier being usable. */
  enabled: boolean;
  availability:
    | "ready"
    | "disabled"
    | "no-runtime"
    | "no-model"
    | "failed"
    | "unknown";
  reason: string;
  model: string;
  dim: number;
  /** Messages with a vector, and messages that could have one. */
  indexed: number;
  embeddable: number;
  runtimeInstalled: boolean;
  modelBytes: number;
  /** Where the encoder being reported actually is: inside the app when bundled. */
  modelDir: string;
  /**
   * v7 §7: the encoder ships with the app. There is then nothing to fetch and
   * nothing that may be deleted, so the card offers neither.
   */
  bundled: boolean;
  present: boolean;
  files: EmbeddingFileState[];
  download: EmbeddingDownload | null;
}

/** Response of GET /api/media/queue — media rows per `media_desc_status`. */
export interface MediaQueue {
  pending: number;
  done: number;
  unsupported: number;
  error: number;
}

/** Response of GET /api/brain/info: the brain wiki dir + its recursive file count. */
export interface BrainInfo {
  dir: string;
  fileCount: number;
}

// ---------------------------------------------------------------------------
// SSE frame parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single already-delimited SSE frame (the text between two blank
 * lines) into a ProviderStreamEvent, or null if it carries no `data:` payload
 * (e.g. a comment `:` heartbeat or a bare event line).
 *
 * Per the SSE grammar, a frame may contain multiple `data:` lines that are
 * joined with "\n"; we honour that, then JSON.parse the joined payload.
 */
export function parseSseFrame(frame: string): ProviderStreamEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("data:")) {
      // strip "data:" and at most one leading space (SSE convention)
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
    // `event:` / `id:` / `retry:` lines are ignored — the payload carries type.
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (payload.length === 0 || payload === "[DONE]") return null;
  return JSON.parse(payload) as ProviderStreamEvent;
}

/**
 * A tiny incremental SSE splitter. Feed it decoded string chunks; it emits one
 * ProviderStreamEvent per complete frame. Handles frames (and their JSON) that
 * straddle chunk boundaries by holding the tail in `buffer` until the next
 * blank-line delimiter arrives.
 */
export class SseParser {
  private buffer = "";

  /** Push a decoded chunk; returns any events that completed within it. */
  push(chunk: string): ProviderStreamEvent[] {
    this.buffer += chunk;
    const events: ProviderStreamEvent[] = [];
    // Frames are separated by a blank line. Normalize CRLF so the split is
    // consistent regardless of the server's line endings.
    let sepIndex: number;
    // Look for either "\n\n" (LF) — CR already normalized away below.
    while ((sepIndex = this.indexOfDelimiter()) !== -1) {
      const frame = this.buffer.slice(0, sepIndex);
      this.buffer = this.buffer.slice(sepIndex + this.delimiterLen);
      const evt = parseSseFrame(frame);
      if (evt) events.push(evt);
    }
    return events;
  }

  /** Flush any trailing buffered frame (called once the stream ends). */
  flush(): ProviderStreamEvent[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length === 0) return [];
    const evt = parseSseFrame(rest);
    return evt ? [evt] : [];
  }

  private delimiterLen = 2;

  private indexOfDelimiter(): number {
    // Prefer LF\LF; also tolerate CRLF\CRLF.
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return -1;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      this.delimiterLen = 4;
      return crlf;
    }
    this.delimiterLen = 2;
    return lf;
  }
}

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

export interface StreamChatRequest {
  runId: string;
  sessionId?: string | null;
  message: string;
  /** Opt-out for fresh sessions; the worker grounds new sessions by default. */
  grounded?: boolean;
}

export interface StreamHandlers {
  onSession?: (sessionId: string) => void;
  onDelta?: (text: string) => void;
  onUsage?: (usage: Usage) => void;
  onCitations?: (citations: Citation[]) => void;
  onDone?: (e: { sessionId: string; usage: Usage; stopReason?: string }) => void;
  onError?: (e: { code: ProviderErrorCode; message: string; sessionId?: string }) => void;
  /** Fires for any event, after the specific handler — useful for tests/logging. */
  onEvent?: (e: ProviderStreamEvent) => void;
}

function dispatch(evt: ProviderStreamEvent, h: StreamHandlers): void {
  switch (evt.type) {
    case "session":
      h.onSession?.(evt.sessionId);
      break;
    case "delta":
      h.onDelta?.(evt.text);
      break;
    case "usage":
      h.onUsage?.(evt.usage);
      break;
    case "citations":
      h.onCitations?.(evt.citations);
      break;
    case "done":
      h.onDone?.({ sessionId: evt.sessionId, usage: evt.usage, stopReason: evt.stopReason });
      break;
    case "error":
      h.onError?.({ code: evt.code, message: evt.message, sessionId: evt.sessionId });
      break;
    case "tool_use":
      // Plain chat won't emit these in P0, but tolerate them for forward-compat.
      break;
  }
  h.onEvent?.(evt);
}

/**
 * POST /api/chat and stream the SSE response, invoking `handlers` per event.
 *
 * Resolves when the stream ends (server closed the body). Rejects only on a
 * transport failure (network error, non-OK HTTP status) — a worker-reported
 * `error` frame is delivered via `handlers.onError`, not thrown, so callers can
 * treat it as an in-band terminal event. If `signal` aborts, the fetch is torn
 * down and an `AbortError` propagates (the caller's own onError/finally handles
 * UI state); we swallow it into a clean resolve so callers don't need a
 * try/catch purely for cancellation.
 */
export async function streamChat(
  req: StreamChatRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(workerUrl("/api/chat"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) return;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`worker /api/chat responded ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("worker /api/chat returned no response body to stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const evt of parser.push(chunk)) dispatch(evt, handlers);
    }
    // Decode any bytes held back by the streaming decoder, then flush frames.
    const tail = decoder.decode();
    if (tail) for (const evt of parser.push(tail)) dispatch(evt, handlers);
    for (const evt of parser.flush()) dispatch(evt, handlers);
  } catch (err) {
    if (isAbortError(err)) {
      // Cancellation path: reader.read() rejects when the signal aborts.
      return;
    }
    throw err;
  } finally {
    // Best-effort: release the lock so the connection can be reclaimed.
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("abort"))
  );
}

// ---------------------------------------------------------------------------
// Non-streaming endpoints
// ---------------------------------------------------------------------------

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(workerUrl(path), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(workerUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** POST /api/cancel — kill the given run's process on the worker. */
export async function cancelRun(runId: string): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/cancel", { runId });
}

/** GET /api/sessions — most-recent-first list. */
export async function listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  return getJson<SessionSummary[]>("/api/sessions", signal);
}

/** GET /api/sessions/:id — session + full transcript. */
export async function getSession(id: string, signal?: AbortSignal): Promise<SessionDetail> {
  return getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`, signal);
}

/** GET /api/quota — rolling usage window. */
export async function getQuota(signal?: AbortSignal): Promise<QuotaInfo> {
  return getJson<QuotaInfo>("/api/quota", signal);
}

/** GET /api/health — worker liveness. */
export async function getHealth(signal?: AbortSignal): Promise<HealthInfo> {
  return getJson<HealthInfo>("/api/health", signal);
}

/** GET /api/settings/models — the catalog, the roles, and per-role selections. */
export async function getModels(signal?: AbortSignal): Promise<ModelSettings> {
  return getJson<ModelSettings>("/api/settings/models", signal);
}

/**
 * POST /api/settings/models — persist the chosen model id for one role.
 *
 * On non-2xx (e.g. HTTP 400 for an invalid role or model id) this throws,
 * preferring the worker's `{ error }` message when present so the UI can show it
 * verbatim.
 */
export async function setModel(
  role: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ role: string; selected: string }> {
  const res = await fetch(workerUrl("/api/settings/models"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ role, model }),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* body wasn't JSON — fall back to status text */
    }
    throw new Error(
      detail || `POST /api/settings/models → ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as { role: string; selected: string };
}

/**
 * POST /api/settings/models/enabled — flip one process's on/off toggle.
 *
 * `role` is a model role key (chat / extraction / triage / done_detection /
 * planning / execution). `extraction` aliases the extraction kill-switch, so the
 * Settings toggle and the extraction strip share one source of truth. Throws on
 * non-2xx (e.g. HTTP 400 for an invalid role) so the caller can revert its
 * optimistic toggle.
 */
export async function setProcessEnabled(
  role: string,
  enabled: boolean,
): Promise<{ role: string; enabled: boolean }> {
  return postJson<{ role: string; enabled: boolean }>(
    "/api/settings/models/enabled",
    { role, enabled },
  );
}

/** GET /api/chat/status — whether chat is enabled in Settings. */
export async function getChatStatus(signal?: AbortSignal): Promise<ChatStatus> {
  return getJson<ChatStatus>("/api/chat/status", signal);
}

/** GET /api/settings/media — the media reader's switches + rate limit. */
export async function getMediaSettings(
  signal?: AbortSignal,
): Promise<MediaSettings> {
  return getJson<MediaSettings>("/api/settings/media", signal);
}

/**
 * POST /api/settings/media — persist one or more media settings. The worker
 * merges the patch and answers with the full settings, so the caller can adopt
 * whatever it actually stored (e.g. a clamped rate).
 */
export async function setMediaSettings(
  patch: Partial<MediaSettings>,
  signal?: AbortSignal,
): Promise<MediaSettings> {
  return postJson<MediaSettings>("/api/settings/media", patch, signal);
}

/** GET /api/media/queue — how much media is still waiting to be described. */
export async function getMediaQueue(signal?: AbortSignal): Promise<MediaQueue> {
  return getJson<MediaQueue>("/api/media/queue", signal);
}

/**
 * POST /api/media/rescan — re-queue everything of the given types, clearing what
 * was read before. The only call in the client that re-reads media, and the
 * reason flipping a switch never does: this one starts model calls.
 */
export async function rescanMedia(
  types: readonly RescanType[],
  signal?: AbortSignal,
): Promise<RescanResult> {
  return postJson<RescanResult>("/api/media/rescan", { types }, signal);
}

/** GET /api/media/tools — bundled binaries, their versions, and the models. */
export async function getMediaTools(
  signal?: AbortSignal,
): Promise<MediaToolState> {
  return getJson<MediaToolState>("/api/media/tools", signal);
}

/**
 * POST /api/media/models/download — start fetching one model. Returns as soon
 * as the fetch is under way (the file is up to 3 GB); progress arrives on the
 * next GET /api/media/tools.
 */
export async function downloadWhisperModel(
  id: string,
): Promise<{ id: string; download: ModelDownload | null; models: WhisperModelState[] }> {
  return postJson("/api/media/models/download", { id });
}

/** POST /api/media/models/cancel — abort an in-flight download. */
export async function cancelWhisperModel(
  id: string,
): Promise<{ id: string; cancelled: boolean; models: WhisperModelState[] }> {
  return postJson("/api/media/models/cancel", { id });
}

/**
 * POST /api/media/models/delete — remove a downloaded model. The worker refuses
 * the bundled one and the one transcription is set to use, so the error message
 * is worth showing verbatim.
 */
export async function deleteWhisperModel(
  id: string,
): Promise<{ id: string; deleted: boolean; models: WhisperModelState[] }> {
  const res = await fetch(workerUrl("/api/media/models/delete"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* body wasn't JSON — fall back to status text */
    }
    throw new Error(detail || `POST /api/media/models/delete → ${res.status}`);
  }
  return (await res.json()) as {
    id: string;
    deleted: boolean;
    models: WhisperModelState[];
  };
}

/** GET /api/retrieval/semantic — the switch, the encoder, and the index. */
export async function getSemanticState(
  signal?: AbortSignal,
): Promise<SemanticState> {
  return getJson<SemanticState>("/api/retrieval/semantic", signal);
}

/** POST /api/retrieval/semantic/enable — turn searching by meaning on or off. */
export async function setSemanticEnabled(on: boolean): Promise<SemanticState> {
  return postJson<SemanticState>("/api/retrieval/semantic/enable", { on });
}

/**
 * POST /api/retrieval/semantic/download — start fetching the encoder. Returns
 * as soon as the fetch is under way (129 MB); progress arrives on the next GET.
 */
export async function downloadEmbeddingModel(): Promise<SemanticState> {
  return postJson<SemanticState>("/api/retrieval/semantic/download", {});
}

/** POST /api/retrieval/semantic/cancel — abort the fetch in flight. */
export async function cancelEmbeddingModel(): Promise<SemanticState> {
  return postJson<SemanticState>("/api/retrieval/semantic/cancel", {});
}

/** POST /api/retrieval/semantic/delete — remove the encoder from disk. */
export async function deleteEmbeddingModel(): Promise<SemanticState> {
  return postJson<SemanticState>("/api/retrieval/semantic/delete", {});
}

/** GET /api/brain/info — the brain wiki dir + a recursive file count. */
export async function getBrainInfo(signal?: AbortSignal): Promise<BrainInfo> {
  return getJson<BrainInfo>("/api/brain/info", signal);
}

/** POST /api/brain/reveal — best-effort `open` of the brain folder on macOS. */
export async function revealBrain(): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/brain/reveal", {});
}

// ---------------------------------------------------------------------------
// WhatsApp + Inbox (docs/PHASE1_CONTRACT §6)
// ---------------------------------------------------------------------------

/**
 * Build the ABSOLUTE URL for a media object, e.g. `/api/media/:eventId` on the
 * worker. The messages endpoint already returns a relative `mediaUrl`; this
 * helper turns an eventId (or a leading-slash worker path) into a full URL that
 * an <img src> / download link can hit directly.
 */
export function mediaUrl(eventIdOrPath: string): string {
  const path = eventIdOrPath.startsWith("/")
    ? eventIdOrPath
    : `/api/media/${encodeURIComponent(eventIdOrPath)}`;
  return `${WORKER_BASE_URL}${path}`;
}

/** GET /api/whatsapp/status — connection/pairing snapshot. */
export async function getWhatsappStatus(
  signal?: AbortSignal,
): Promise<WhatsAppStatusResponse> {
  return getJson<WhatsAppStatusResponse>("/api/whatsapp/status", signal);
}

/** POST /api/whatsapp/pair — trigger QR pairing (QR arrives on the stream). */
export async function pairWhatsapp(): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/whatsapp/pair", {});
}

/** POST /api/whatsapp/import { range } — range-limited backfill. */
export async function importWhatsapp(range: Range): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/whatsapp/import", { range });
}

/** POST /api/whatsapp/extend { range } — widen coverage to older history. */
export async function extendWhatsapp(range: Range): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/whatsapp/extend", { range });
}

/** POST /api/whatsapp/pause { paused } — kill-switch (pause/resume). */
export async function pauseWhatsapp(
  paused: boolean,
): Promise<{ ok: boolean; paused: boolean }> {
  return postJson<{ ok: boolean; paused: boolean }>("/api/whatsapp/pause", {
    paused,
  });
}

/** POST /api/whatsapp/logout — clear the session (unpair). */
export async function logoutWhatsapp(): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/whatsapp/logout", {});
}

/**
 * POST /api/whatsapp/reset (R2.3) — wipe all locally-imported WhatsApp data
 * (events/channels/actors + orphaned people) and clear the persisted import
 * state, so the UI returns to the range picker to re-import cleanly. KEEPS the
 * whatsmeow session (no re-pair). Used by the Inbox "Re-sync from scratch"
 * action to clean up already-duplicated data (bug 7).
 */
export async function resetWhatsapp(): Promise<ResetResult> {
  return postJson<ResetResult>("/api/whatsapp/reset", {});
}

/**
 * POST /api/whatsapp/relink (R3.3) — the honest "clean re-sync". Unlike
 * {@link resetWhatsapp} (which keeps the whatsmeow session), this wipes the
 * locally-imported data AND fully re-links WhatsApp: the worker clears the
 * import state, then logs the daemon out. Status then moves
 * `logged_out` → `need_pairing`, so the UI returns to the QR screen for a
 * fresh scan. WhatsApp re-pushes full history to the newly-linked device,
 * fixing the "empty inbox after reset" bug (R3 root cause: history is pushed
 * only once per link). Response shape `{ ok:true }`.
 */
export async function relinkWhatsapp(): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/whatsapp/relink", {});
}

/** GET /api/inbox/chats — chats sorted by lastTs desc. */
export async function getInboxChats(
  opts: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<InboxChat[]> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.offset != null) q.set("offset", String(opts.offset));
  const qs = q.toString();
  return getJson<InboxChat[]>(`/api/inbox/chats${qs ? `?${qs}` : ""}`, signal);
}

/** GET /api/inbox/chats/:id/messages — ascending by ts. */
export async function getChannelMessages(
  channelId: string,
  opts: { before?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<InboxMessage[]> {
  const q = new URLSearchParams();
  if (opts.before) q.set("before", opts.before);
  if (opts.limit != null) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return getJson<InboxMessage[]>(
    `/api/inbox/chats/${encodeURIComponent(channelId)}/messages${
      qs ? `?${qs}` : ""
    }`,
    signal,
  );
}

/** GET /api/inbox/search — FTS5 hits with highlight snippet. */
export async function searchInbox(
  q: string,
  opts: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q });
  if (opts.limit != null) params.set("limit", String(opts.limit));
  return getJson<SearchHit[]>(`/api/inbox/search?${params.toString()}`, signal);
}

/**
 * GET /api/whatsapp/stream — subscribe to the SSE status/qr/progress/paired
 * frames. Each frame's `data:` payload is a `StatusUpdate` (discriminated by
 * `type`). Parses frames with the shared {@link SseParser} splitter (the JSON
 * shape differs from ProviderStreamEvent, so we cast the parsed value).
 *
 * Returns an unsubscribe/abort function. `onError` fires on transport failure
 * (worker down / network drop) so the caller can fall back to polling; a normal
 * server-side stream end also triggers it (with a synthetic message) so callers
 * can decide whether to reconnect.
 */
export function streamWhatsapp(
  onFrame: (frame: StatusUpdate) => void,
  onError?: (err: Error) => void,
): () => void {
  const controller = new AbortController();

  void (async () => {
    let res: Response;
    try {
      res = await fetch(workerUrl("/api/whatsapp/stream"), {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
    } catch (err) {
      if (!isAbortError(err)) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    if (!res.ok || !res.body) {
      onError?.(
        new Error(`worker /api/whatsapp/stream responded ${res.status}`),
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const evt of parser.push(chunk)) {
          onFrame(evt as unknown as StatusUpdate);
        }
      }
      const tail = decoder.decode();
      if (tail) {
        for (const evt of parser.push(tail)) {
          onFrame(evt as unknown as StatusUpdate);
        }
      }
      for (const evt of parser.flush()) {
        onFrame(evt as unknown as StatusUpdate);
      }
      // A clean end of stream (server closed) is still a "drop" from the UI's
      // perspective — surface it so the hook can fall back to polling.
      if (!controller.signal.aborted) {
        onError?.(new Error("whatsapp stream ended"));
      }
    } catch (err) {
      if (!isAbortError(err)) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  })();

  return () => controller.abort();
}
// ---------------------------------------------------------------------------
// Grounded chat, evaluations, brain files, runs viewer and logs.
//
// What used to be the Phase 2/3/4/5 API surface (spaces, people, patterns,
// extraction control, the task engine, digest and nightly) is gone with those
// subsystems. What remains is everything the three surviving surfaces —
// Inbox, Chat and Settings — actually call.
// ---------------------------------------------------------------------------

/** The kinds of output a human can 👍/👎. */
export type EvalOutputType =
  | "space"
  | "task"
  | "suggestion"
  | "update"
  | "pattern"
  | "chat_answer";

export interface EvaluationInput {
  output_type: EvalOutputType;
  output_id: string;
  verdict: "up" | "down";
  note?: string;
}

export interface EvaluationSummary {
  by_type: Partial<Record<EvalOutputType, { up: number; down: number }>>;
}

/** GET /api/brain/file?path=… — one file out of the brain folder. */
export interface BrainFile {
  path: string;
  content: string;
}

// ---- Evaluations (human eval, 👍/👎) ----------------------------------------

/** POST /api/evaluations */
export async function postEvaluation(
  input: EvaluationInput,
): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/evaluations", input);
}

/** GET /api/evaluations/summary */
export async function getEvaluationSummary(
  signal?: AbortSignal,
): Promise<EvaluationSummary> {
  return getJson<EvaluationSummary>("/api/evaluations/summary", signal);
}

// ---- Events (citation provenance) --------------------------------------------

/** Source-message detail behind an event citation (GET /api/events/:id). */
export interface EventDetail {
  id: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  actor_name: string | null;
  channel_name: string | null;
}

/** GET /api/events/:id — resolve an event citation to its source message. */
export async function getEventDetail(
  id: string,
  signal?: AbortSignal,
): Promise<EventDetail> {
  const res = await getJson<{ event: EventDetail }>(
    `/api/events/${encodeURIComponent(id)}`,
    signal,
  );
  return res.event;
}

// ---- Brain files -------------------------------------------------------------

/**
 * GET /api/brain/file?path=… — read a file out of the brain folder (brain root
 * only). DEBUG EXPORT: the worker mounts this route only while
 * `settings.debug_export` is on, so a default install answers 404 here.
 */
export async function getBrainFile(
  path: string,
  signal?: AbortSignal,
): Promise<BrainFile> {
  return getJson<BrainFile>(
    `/api/brain/file?path=${encodeURIComponent(path)}`,
    signal,
  );
}

// ---- Runs viewer + logs ---------------------------------------

/** One row of the runs viewer (GET /api/runs → `runs`, contract §3.5). */
export interface RunListItem {
  id: string;
  process: string; // COALESCE(role, kind)
  model: string; // COALESCE(model, "")
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  /** null when the run died before the CLI reported a cost — not $0. */
  cost_usd: number | null;
  duration_ms: number;
  status: string; // ok|error
  created_at: string;
}
/** Alias kept for callers that refer to the runs-viewer row generically. */
export type RunRow = RunListItem;

/** GET /api/logs/info — the logs directory + a stat of its files (contract §11.2). */
export interface LogsInfo {
  dir: string;
  files: { name: string; size: number; modified: string }[];
}

/**
 * GET /api/runs?limit=&offset= — one page of the flat per-LLM-call runs viewer
 * log, newest first. A batch shorter than `limit` is the end of the table; the
 * worker never reports a total, so nothing counts rows to know when to stop.
 */
export async function listRuns(
  opts: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<RunListItem[]> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.offset != null) q.set("offset", String(opts.offset));
  const qs = q.toString();
  const res = await getJson<{ runs: RunListItem[] }>(
    `/api/runs${qs ? `?${qs}` : ""}`,
    signal,
  );
  return res.runs;
}

/** GET /api/logs/info — logs directory + a stat of the files inside it. */
export async function getLogsInfo(signal?: AbortSignal): Promise<LogsInfo> {
  return getJson<LogsInfo>("/api/logs/info", signal);
}

/** POST /api/logs/reveal — best-effort `open` of the logs folder on macOS. */
export async function revealLogs(): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/logs/reveal", {});
}

/** The client surface as a single object, handy for dependency injection in tests. */
export const workerClient = {
  streamChat,
  cancelRun,
  listSessions,
  getSession,
  getQuota,
  getHealth,
  getModels,
  setModel,
  setProcessEnabled,
  getChatStatus,
  getMediaSettings,
  setMediaSettings,
  getMediaQueue,
  rescanMedia,
  getMediaTools,
  downloadWhisperModel,
  cancelWhisperModel,
  deleteWhisperModel,
  getSemanticState,
  setSemanticEnabled,
  downloadEmbeddingModel,
  cancelEmbeddingModel,
  deleteEmbeddingModel,
  getBrainInfo,
  revealBrain,
  // WhatsApp + Inbox (Phase 1)
  getWhatsappStatus,
  streamWhatsapp,
  pairWhatsapp,
  importWhatsapp,
  extendWhatsapp,
  pauseWhatsapp,
  logoutWhatsapp,
  resetWhatsapp,
  relinkWhatsapp,
  getInboxChats,
  getChannelMessages,
  searchInbox,
  mediaUrl,
  // Grounded chat: citation provenance + 👍/👎
  getEventDetail,
  postEvaluation,
  getEvaluationSummary,
  getBrainFile,
  // Settings: runs viewer + logs
  listRuns,
  getLogsInfo,
  revealLogs,
};

export type WorkerClient = typeof workerClient;

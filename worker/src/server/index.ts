// ===========================================================================
// Worker HTTP + SSE server (localhost). See docs/PHASE0_ARCHITECTURE.md §7.
//
// Endpoints:
//   GET  /api/health          -> { ok, version }
//   POST /api/chat            -> SSE stream of ProviderStreamEvent frames
//   POST /api/cancel          -> { ok }
//   GET  /api/chat/sessions      -> [{ sessionId, title, cwd, status, ... }]
//   GET  /api/chat/sessions/:id  -> { session, messages }
//   GET  /api/quota              -> QuotaSnapshot + media (its own, ungated spend)
//   POST /api/chat/sessions/new  -> { sessionId: null }
//
// /api/sessions itself belongs to the V2 sessions surface (sessions-routes.ts),
// which answers with a SessionsPage object rather than this bare array.
//
// The server is the persistence + logging layer: it enforces quota, looks up
// the saved session (to feed cwd/bundle guards to the adapter), persists the
// user + assistant messages, logs every run to extraction_runs, and updates
// quota. The provider stays transport-only.
// ===========================================================================

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as db from "../db/index.js";
import { DEFAULT_WORKER_PORT } from "../home.js";
import { BUILT_THROUGH_PHASE } from "../version.js";
import { rescanMedia, type RescanType } from "../db/ingest.js";
import { get as getProvider, DEFAULT_PROVIDER_ID } from "../providers/index.js";
import type {
  Provider,
  ProviderResult,
  ProviderStreamEvent,
  Usage,
} from "../providers/index.js";
import { emptyUsage } from "../providers/usage.js";
import { withTraceContext } from "../traces/context.js";
import { isValidSessionId } from "../providers/claude-local/index.js";
import {
  MODEL_CATALOG,
  MODEL_ROLES,
  isValidModelId,
  isValidRole,
} from "../providers/claude-local/models.js";
import {
  getDebugExportEnabled,
  getSelectedModel,
  setSelectedModel,
  getAllSelectedModels,
  getProcessEnabled,
  setProcessEnabled,
  getMediaDescribeEnabled,
  setMediaDescribeEnabled,
  getMediaBackfillEnabled,
  setMediaBackfillEnabled,
  getMediaImagesEnabled,
  setMediaImagesEnabled,
  getMediaVideoEnabled,
  setMediaVideoEnabled,
  getMediaBusinessEnabled,
  setMediaBusinessEnabled,
  getMediaLinkScrapeEnabled,
  setMediaLinkScrapeEnabled,
  getMediaRatePerMin,
  setMediaRatePerMin,
  getMediaConcurrency,
  setMediaConcurrency,
  MAX_MEDIA_CONCURRENCY,
  getMediaVideoFramesEnabled,
  setMediaVideoFramesEnabled,
  getMediaVideoAudioEnabled,
  setMediaVideoAudioEnabled,
  getMediaVoiceNotesEnabled,
  setMediaVoiceNotesEnabled,
  getMediaVideoFrameIntervalSec,
  setMediaVideoFrameIntervalSec,
  getMediaVideoFrameMax,
  setMediaVideoFrameMax,
  getMediaVideoMaxHeight,
  setMediaVideoMaxHeight,
  getMediaWhisperModel,
  setMediaWhisperModel,
  MAX_VIDEO_FRAME_INTERVAL_SEC,
  MAX_VIDEO_FRAME_MAX,
  MAX_VIDEO_MAX_HEIGHT,
} from "../db/settings.js";
import { mediaQueueCounts, mediaSpend } from "../db/runs.js";
import type { Ingestion } from "../ingest/index.js";
import { startMediaQueue, stopMediaQueue } from "../media/queue.js";
// The reader's own getter, not a copy of it: it is what the claim query reads
// every cycle, so anything else here could serve a size nothing acts on.
import { getMediaImageBatch, setMediaImageBatch } from "../media/switches.js";
import {
  getEnrichmentReadAllMedia,
  getEnrichmentSalienceGate,
  setEnrichmentReadAllMedia,
  setEnrichmentSalienceGate,
} from "../media/batch.js";
import { MAX_IMAGE_BATCH } from "../media/describe.js";
import { WHISPER_MODELS } from "../media/tools.js";
import { handleSourceRoute } from "./whatsapp-routes.js";
import {
  abortModelDownloads,
  handleMediaToolsRoute,
} from "./media-tools-routes.js";
import {
  abortEmbeddingDownload,
  handleSemanticRoute,
} from "./semantic-routes.js";
import {
  startSemanticIndexer,
  stopSemanticIndexer,
} from "../retrieval/indexer.js";
import { ensureBrain, handleBrainRoute } from "../brain/index.js";
import { handleOpsRoute } from "./ops-routes.js";
import { handleScreenRoute } from "./screen-routes.js";
import { handleSystemRoute, type SystemDeps } from "./system-routes.js";
// V2 product surfaces (§3.2). Each owns its own prefix, takes no deps arg, and
// returns false for a path it does not claim, exactly like handleOpsRoute.
import { handleSurfacesRoute } from "./surfaces-routes.js";
// World-model reads (P1.1): people / spaces / claims / tone. Same contract —
// returns false for a path it does not claim.
import { handleWorldModelRoute } from "./worldmodel-routes.js";
// Review queue + drill-down (P1.7): home, proposals approve/reject, decisions
// ("why?"), trace reads, dev seed. Same contract.
import { handleReviewRoute } from "./review-routes.js";
// Corrections pipeline (P1.7, spec §14.4): drag / chips / "Tell the twin".
import { handleCorrectionsRoute } from "./corrections-routes.js";
// Settings (P4.3, spec §14.9): the eight-subtab screen's worker back-end.
import { handleSettingsRoute } from "./settings-routes.js";
// Assist artifacts + nudge state + capture quick-pause (P2.3, spec §14.7).
import { handleAssistRoute } from "./assist-routes.js";
// Freshness chip + Library screens (P2.4, spec §5.4 / §14.3.2).
import { handleLibraryRoute } from "./library-routes.js";
// SuperTwin Browser (P3.4, spec §12): status / kill-switch / connect-accounts.
import { browserManager, handleBrowserRoute } from "../browser/routes.js";
// Task run + approvals glue (P3.5, spec §14.6): the task modal's live states,
// question-card answers, and the approved WhatsApp draft send.
import { handleExecutorRoute } from "./executor-routes.js";
// Timeline + grounded bar (P4.1, spec §14.3.1 / §14.8): paged event-log
// reads, the day scrubber, and the bar's intent-routed submissions.
import { handleGroundedRoute } from "./grounded-routes.js";
import {
  augmentMessage,
  getEventDetail,
  groundedAllowedTools,
  groundedSystemPromptFile,
  isCitableKind,
  parseCitationsFromText,
  type CitationsFrame,
} from "./chat-grounding.js";

/** Everything the chat SSE stream can carry: provider frames + citations. */
type ChatStreamEvent = ProviderStreamEvent | CitationsFrame;

/**
 * Report the real app version at /api/health instead of a hardcoded string.
 * Resolution order (robust across both run modes):
 *   1. SUPERTWIN_WORKER_VERSION env — bundle-worker.mjs injects the app version
 *      into the bundle's package.json, but this env also lets any caller pin it.
 *   2. The nearest package.json (walking up from this module) that carries a
 *      real `version` — in dev that's worker/package.json (0.1.0); in the bundle
 *      it's worker/bundle/package.json, which bundle-worker.mjs stamps with the
 *      app version. We skip placeholder "0.0.0" and dirs without a version.
 *   3. Fallback literal if nothing is found (never throws).
 */
function moduleBaseDir(): string {
  // ESM source: import.meta.url. CJS bundle (esbuild): __dirname is defined on
  // the module scope; reach it via globalThis so TS doesn't require the ambient.
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    const cjsDir = (globalThis as { __dirname?: string }).__dirname;
    if (typeof cjsDir === "string") return cjsDir;
    return process.cwd();
  }
}

function resolveVersion(): string {
  const env = process.env.SUPERTWIN_WORKER_VERSION;
  if (env && env.trim().length > 0) return env.trim();

  let dir = moduleBaseDir();
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          version?: unknown;
        };
        const v = typeof pkg.version === "string" ? pkg.version.trim() : "";
        if (v && v !== "0.0.0") return v;
      } catch {
        // Unreadable/garbage package.json — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.1.0";
}

const VERSION = resolveVersion();

// Quota window + threshold. Kept high so evals are never blocked; configurable.
const QUOTA_WINDOW_MS = Number(process.env.SUPERTWIN_QUOTA_WINDOW_MS ?? 5 * 60 * 60 * 1000);
const QUOTA_TOKEN_LIMIT = Number(process.env.SUPERTWIN_QUOTA_TOKEN_LIMIT ?? 5_000_000);

// Ceiling for the media backfill throttle — a request asking for more is
// clamped, never rejected, so the picker can offer a wide range.
const MEDIA_RATE_MAX_PER_MIN = 600;

// The boolean switches /api/settings/media serves and accepts, paired with
// where each lands. Wire names mirror the stored app_state keys minus the
// `media.` prefix, so a new switch is one line in both directions.
const MEDIA_SWITCHES: readonly [string, (v: boolean) => void][] = [
  ["describe_enabled", setMediaDescribeEnabled],
  ["backfill_enabled", setMediaBackfillEnabled],
  ["images_enabled", setMediaImagesEnabled],
  ["video_enabled", setMediaVideoEnabled],
  ["business_enabled", setMediaBusinessEnabled],
  ["link_scrape_enabled", setMediaLinkScrapeEnabled],
  ["video_frames_enabled", setMediaVideoFramesEnabled],
  ["video_audio_enabled", setMediaVideoAudioEnabled],
  ["voice_notes_enabled", setMediaVoiceNotesEnabled],
  // The two V2 enrichment switches (§14.0c MEDIA panel, arch §8.4 table).
  ["read_all_media", setEnrichmentReadAllMedia],
  ["salience_gate", setEnrichmentSalienceGate],
];

// The clamped integers it serves and accepts, each with its ceiling and where
// it lands. Out-of-range values are clamped rather than rejected — the reply
// carries the full settings, so the caller sees what was actually stored.
const MEDIA_LIMITS: readonly [string, number, (v: number) => void][] = [
  ["rate_per_min", MEDIA_RATE_MAX_PER_MIN, setMediaRatePerMin],
  ["concurrency", MAX_MEDIA_CONCURRENCY, setMediaConcurrency],
  ["image_batch", MAX_IMAGE_BATCH, setMediaImageBatch],
  [
    "video_frame_interval_sec",
    MAX_VIDEO_FRAME_INTERVAL_SEC,
    setMediaVideoFrameIntervalSec,
  ],
  ["video_frame_max", MAX_VIDEO_FRAME_MAX, setMediaVideoFrameMax],
  // The only one with a floor of its own: under it no site publishes a matching
  // format and every download silently falls back to "worst", so the setter
  // clamps at both ends and this ceiling only keeps the two in agreement.
  ["video_max_height", MAX_VIDEO_MAX_HEIGHT, setMediaVideoMaxHeight],
];

// Settings that are neither a switch nor a number: one of a fixed set. An
// unknown value is REJECTED rather than clamped — the transcriber builds a
// file path out of this id, so the catalogue is the only thing that may put a
// value in it.
const MEDIA_CHOICES: readonly [string, readonly string[], (v: string) => void][] = [
  ["whisper_model", WHISPER_MODELS.map((m) => m.id), setMediaWhisperModel],
];

const RESCAN_TYPES: readonly RescanType[] = [
  "image",
  "video",
  "document",
  "link",
  "business",
  "frames",
  "transcript",
];

function isRescanType(v: unknown): v is RescanType {
  return typeof v === "string" && (RESCAN_TYPES as readonly string[]).includes(v);
}

// Default sandbox cwd for chat runs (safe, writable, no repo access needed).
const DEFAULT_CWD = process.env.SUPERTWIN_CHAT_CWD ?? tmpdir();
// Optional system-prompt file, applied to fresh sessions only.
const SYSTEM_PROMPT_FILE = process.env.SUPERTWIN_SYSTEM_PROMPT_FILE;

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  port?: number;
  /** WhatsApp ingestion instance. Optional so Phase-0 boots without it. */
  ingestion?: Ingestion | null;
  /**
   * Folder-reveal override for the logs/brain reveal routes. Injectable so tests
   * stub it (no real Finder window, deterministic temp-dir teardown). Defaults
   * to the real macOS `open` shell when unset.
   */
  openPath?: (dir: string) => void;
  /**
   * Run the media reader (media spec §8) for the life of the server. It spawns
   * real `claude` children against whatever media the DB holds, so it defaults
   * OFF under the test runner — every server test boots the real server.
   */
  media?: boolean;
}

/**
 * The prompt-bundle hash pins a session to the exact system-prompt + provider
 * config it was created with. If a later request would run under a different
 * bundle (or cwd), we must NOT resume — we start fresh. Computed cheaply here.
 */
function promptBundleHash(providerId: string, systemPromptFile?: string): string {
  const h = createHash("sha256");
  h.update(providerId);
  h.update("\x00");
  h.update(systemPromptFile ?? "");
  return h.digest("hex").slice(0, 16);
}

/** Very small CORS: allow localhost (any port) + the Tauri origin. */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const ok =
    !origin ||
    origin === "tauri://localhost" ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", ok && origin ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // caller treats undefined as a 400
  }
}

/** Write one SSE frame. */
function sseSend(res: ServerResponse, event: ChatStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function startServer(opts?: StartServerOptions): Promise<ServerHandle> {
  const provider = getProvider(DEFAULT_PROVIDER_ID);
  if (!provider) {
    return Promise.reject(
      new Error(`default provider "${DEFAULT_PROVIDER_ID}" not registered`),
    );
  }

  // runId -> AbortController, so POST /api/cancel can abort a live SSE run.
  const inflight = new Map<string, AbortController>();
  const ingestion = opts?.ingestion ?? null;
  const system: SystemDeps = { openPath: opts?.openPath };

  // Long-lived background reader: live attachments as they arrive, the import
  // backlog on the throttle from Settings. The semantic indexer keeps the same
  // company — it too is a backlog nobody should have to wait on, and it costs
  // one null per minute while the tier is off.
  if (opts?.media ?? process.env.NODE_ENV !== "test") {
    startMediaQueue();
    startSemanticIndexer();
  }

  const server = createServer((req, res) => {
    handle(req, res, provider, inflight, ingestion, system).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: (err as Error).message });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
  });

  const port =
    opts?.port ?? Number(process.env.SUPERTWIN_WORKER_PORT ?? DEFAULT_WORKER_PORT);

  return new Promise<ServerHandle>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      const actual = (server.address() as AddressInfo).port;
      // Contract: exactly this line on stdout so Tauri + tests detect readiness.
      console.log(`WORKER_READY port=${actual}`);
      resolve({
        port: actual,
        close: () =>
          new Promise<void>((res2) => {
            // Abort any live runs so their children die with the server. An
            // interrupted media read leaves its row pending, not in flight, and
            // a half-fetched model leaves only its `.part`.
            stopMediaQueue();
            stopSemanticIndexer();
            abortModelDownloads();
            abortEmbeddingDownload();
            for (const [, ac] of inflight) ac.abort();
            server.close(() => res2());
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  provider: Provider,
  inflight: Map<string, AbortController>,
  ingestion: Ingestion | null,
  system: SystemDeps,
): Promise<void> {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // --- GET /api/health (additive: include whatsapp state when available)
  if (method === "GET" && path === "/api/health") {
    const body: Record<string, unknown> = {
      ok: true,
      version: VERSION,
      builtThroughPhase: BUILT_THROUGH_PHASE,
    };
    if (ingestion) {
      const st = ingestion.getStatus();
      body.whatsapp = { state: st.state, paired: st.paired };
    }
    sendJson(res, 200, body);
    return;
  }

  // --- GET /api/quota. `media` is the same window read off extraction_runs:
  // media reading never touches the quota window itself, so this is the only
  // place that spend is visible. Both blocks carry the window's cost as well as
  // its tokens — quota_usage has only ever counted tokens, so each `costUsd` is
  // summed off extraction_runs by role (v4 §1).
  if (method === "GET" && path === "/api/quota") {
    sendJson(res, 200, {
      ...db.getQuota(QUOTA_WINDOW_MS),
      media: mediaSpend(QUOTA_WINDOW_MS),
    });
    return;
  }

  // --- GET /api/settings/models -> per-role selections + catalog + role list
  // + per-role on/off (enabledByRole). V8 serves exactly one role — chat.
  if (method === "GET" && path === "/api/settings/models") {
    const enabledByRole: Record<string, boolean> = {};
    for (const r of MODEL_ROLES) enabledByRole[r.key] = getProcessEnabled(r.key);
    sendJson(res, 200, {
      models: MODEL_CATALOG,
      roles: MODEL_ROLES,
      selections: getAllSelectedModels(),
      enabledByRole,
    });
    return;
  }

  // --- POST /api/settings/models/enabled { role, enabled } -> per-process on/off.
  // Validates the role (isValidRole) and flips its toggle.
  if (method === "POST" && path === "/api/settings/models/enabled") {
    const body = (await readBody(req)) as
      | { role?: unknown; enabled?: unknown }
      | undefined;
    const role = typeof body?.role === "string" ? body.role : "";
    if (!isValidRole(role)) {
      sendJson(res, 400, { error: "invalid role" });
      return;
    }
    if (typeof body?.enabled !== "boolean") {
      sendJson(res, 400, { error: "enabled (boolean) required" });
      return;
    }
    setProcessEnabled(role, body.enabled);
    sendJson(res, 200, { role, enabled: body.enabled });
    return;
  }

  // --- POST /api/settings/models { role, model } -> persist one role's choice.
  if (method === "POST" && path === "/api/settings/models") {
    const body = (await readBody(req)) as
      | { role?: unknown; model?: unknown }
      | undefined;
    const role = typeof body?.role === "string" ? body.role : "";
    const model = typeof body?.model === "string" ? body.model : "";
    if (!isValidRole(role)) {
      sendJson(res, 400, { error: "invalid role" });
      return;
    }
    if (!isValidModelId(model)) {
      sendJson(res, 400, { error: "invalid model" });
      return;
    }
    setSelectedModel(role, model);
    sendJson(res, 200, { role, selected: model });
    return;
  }

  // --- GET /api/settings/media -> the media reader's switches + throttle.
  if (method === "GET" && path === "/api/settings/media") {
    sendJson(res, 200, mediaSettings());
    return;
  }

  // --- POST /api/settings/media { <any switch>?, <any limit>? } -> apply
  // whichever keys are present and answer with the full settings, so the caller
  // adopts the clamped numbers. Nothing here re-queues anything: flipping a
  // switch must never start hundreds of model calls on its own (v3 §2) — that
  // is what POST /api/media/rescan is for.
  if (method === "POST" && path === "/api/settings/media") {
    const body = (await readBody(req)) as Record<string, unknown> | undefined;
    if (!body) {
      sendJson(res, 400, { error: "invalid body" });
      return;
    }
    // Validate every present key before writing any, so a rejected field never
    // leaves half the switches flipped.
    const pending: [(v: boolean) => void, boolean][] = [];
    for (const [key, apply] of MEDIA_SWITCHES) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        sendJson(res, 400, { error: `${key} must be a boolean` });
        return;
      }
      pending.push([apply, value]);
    }
    const limits: [(v: number) => void, number][] = [];
    for (const [key, ceiling, apply] of MEDIA_LIMITS) {
      const value = body[key];
      if (value === undefined) continue;
      const raw = typeof value === "number" ? value : NaN;
      if (!Number.isFinite(raw)) {
        sendJson(res, 400, { error: `${key} must be a number` });
        return;
      }
      limits.push([apply, Math.min(Math.max(1, Math.floor(raw)), ceiling)]);
    }
    const choices: [(v: string) => void, string][] = [];
    for (const [key, allowed, apply] of MEDIA_CHOICES) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !allowed.includes(value)) {
        sendJson(res, 400, { error: `${key} must be one of ${allowed.join("|")}` });
        return;
      }
      choices.push([apply, value]);
    }
    for (const [apply, value] of pending) apply(value);
    for (const [apply, value] of limits) apply(value);
    for (const [apply, value] of choices) apply(value);
    sendJson(res, 200, mediaSettings());
    return;
  }

  // --- GET /api/chat/sessions
  // Phase 0 served this at /api/sessions. V2 took that path for the segmented
  // sessions surface (a SessionsPage object, not this bare array), so the CLI
  // chat-session list moved under /api/chat/ where the rest of chat already
  // lives. Nothing derives the path — the one caller is worker-client.ts.
  if (method === "GET" && path === "/api/chat/sessions") {
    const sessions = db.listSessions();
    const out = sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      cwd: s.cwd,
      status: s.status,
      grounded: s.grounded,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: db.getMessages(s.sessionId).length,
    }));
    sendJson(res, 200, out);
    return;
  }

  // --- GET /api/chat/sessions/:id
  // Narrowed off /api/sessions/ deliberately: as a bare prefix it swallowed
  // every V2 /api/sessions/* subpath before handleSessionsV2Route could see it.
  if (method === "GET" && path.startsWith("/api/chat/sessions/")) {
    const id = decodeURIComponent(path.slice("/api/chat/sessions/".length));
    const session = db.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    const messages = db.getMessages(id).map((m) => ({
      role: m.role,
      content: m.content,
      ts: m.ts,
      runId: m.runId,
      citations: safeParseCitationsJson(m.citationsJson),
    }));
    sendJson(res, 200, { session, messages });
    return;
  }

  // --- GET /api/events/:id (citation provenance popovers)
  if (method === "GET" && path.startsWith("/api/events/")) {
    const id = decodeURIComponent(path.slice("/api/events/".length));
    const event = getEventDetail(id);
    if (!event) {
      sendJson(res, 404, { error: "event not found" });
      return;
    }
    sendJson(res, 200, { event });
    return;
  }

  // --- POST /api/chat/sessions/new (moved with the two reads above)
  if (method === "POST" && path === "/api/chat/sessions/new") {
    sendJson(res, 200, { sessionId: null });
    return;
  }

  // --- POST /api/cancel
  if (method === "POST" && path === "/api/cancel") {
    const body = (await readBody(req)) as { runId?: string } | undefined;
    if (!body || typeof body.runId !== "string") {
      sendJson(res, 400, { error: "runId required" });
      return;
    }
    const ac = inflight.get(body.runId);
    if (ac) ac.abort();
    // Also reach the provider directly in case the abort race lost.
    provider.cancel(body.runId);
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- GET /api/chat/status -> is the chat process switched on in Settings.
  // The Chat tab reads this to say chat is off instead of silently failing.
  if (method === "GET" && path === "/api/chat/status") {
    sendJson(res, 200, { enabled: getProcessEnabled("chat") });
    return;
  }

  // --- POST /api/chat (SSE)
  if (method === "POST" && path === "/api/chat") {
    await handleChat(req, res, provider, inflight);
    return;
  }

  // --- GET /api/media/queue -> backfill progress by media_desc_status. Ahead
  // of the media block below, whose /api/media/:eventId is a catch-all.
  if (method === "GET" && path === "/api/media/queue") {
    sendJson(res, 200, mediaQueueCounts());
    return;
  }

  // --- Bundled toolchain + whisper model management. Ahead of the media block
  // below for the same reason /api/media/queue is: /api/media/:eventId would
  // read "tools" as an event id.
  if (path === "/api/media/tools" || path.startsWith("/api/media/models/")) {
    const handled = await handleMediaToolsRoute(req, res);
    if (handled) return;
  }

  // --- Semantic retrieval: the switch, the encoder download, the index state.
  if (path === "/api/retrieval/semantic" || path.startsWith("/api/retrieval/semantic/")) {
    const handled = await handleSemanticRoute(req, res);
    if (handled) return;
  }

  // --- POST /api/media/rescan { types } -> re-queue matching rows and answer
  // with how many. The ONLY thing that re-processes media: an unrecognised type
  // is rejected rather than ignored, so a typo can never quietly re-read less
  // than the user asked for.
  if (method === "POST" && path === "/api/media/rescan") {
    const body = (await readBody(req)) as { types?: unknown } | undefined;
    const types = Array.isArray(body?.types) ? body.types : null;
    if (!types || !types.every(isRescanType)) {
      sendJson(res, 400, {
        error: `types must be an array of ${RESCAN_TYPES.join("|")}`,
      });
      return;
    }
    sendJson(res, 200, rescanMedia(types));
    return;
  }

  // --- Source + Inbox + media routes (Phase 1, additive). `/api/whatsapp/*`
  // is the aliased spelling of `/api/sources/whatsapp/*`, kept one release
  // (arch §3.3 leak 4).
  if (path === "/api/sources" ||
      path.startsWith("/api/sources/") ||
      path.startsWith("/api/whatsapp/") ||
      path.startsWith("/api/inbox/") ||
      path.startsWith("/api/media/") ||
      path.startsWith("/api/approvals/")) {
    const handled = await handleSourceRoute(req, res, ingestion);
    if (handled) return;
  }

  // --- Brain FILE reads are a debug export, not a product surface (V2 §3.2),
  // so GET /api/brain/file is off the default router: it is mounted only while
  // `settings.debug_export` is set. Reading the flag per request rather than at
  // boot is deliberate — turning the export off has to take effect immediately,
  // and this costs one indexed app_state lookup on a path nobody hot-loops.
  if (path.startsWith("/api/brain/") && getDebugExportEnabled()) {
    const handled = await handleBrainRoute(req, res);
    if (handled) return;
  }

  // --- Screen source (P2.1): sidecar status (incl. Accessibility permission
  // for onboarding), kill-switch pause, per-app privacy pause (spec §4.3).
  if (path.startsWith("/api/screen/")) {
    const handled = await handleScreenRoute(req, res);
    if (handled) return;
  }

  // --- Ops surface (item 4.4): import progress, quarantine browser, question
  // queue, per-lane pause/resume, undo-run. Owns everything under /api/ops/.
  if (path.startsWith("/api/ops/")) {
    const handled = await handleOpsRoute(req, res);
    if (handled) return;
  }

  // --- Runs / logs / brain folder / evaluations. Runs after the brain block,
  // which returns false for /api/brain/(info|reveal) so they land here.
  if (
    path === "/api/runs" ||
    path === "/api/latency" ||
    path === "/api/usage" ||
    path === "/api/usage/estimate" ||
    path.startsWith("/api/logs/") ||
    path === "/api/brain/info" ||
    path === "/api/brain/reveal" ||
    path.startsWith("/api/evaluations")
  ) {
    const handled = await handleSystemRoute(req, res, system);
    if (handled) return;
  }

  // --- V2 product surfaces (§3.2). Ungated: these are the product, not a debug
  // export. Each handler owns its own prefix and returns false for anything it
  // does not claim, so the order below is alphabetical rather than significant.

  // Coverage strip — polled by every surface.
  if (path === "/api/coverage") {
    const handled = await handleSurfacesRoute(req, res);
    if (handled) return;
  }

  // Review queue + drill-down (P1.7): the minimal UI's home fetch, proposal
  // approve/reject, "why?" decisions, trace reads, and the dev seed.
  if (
    path === "/api/home" ||
    path === "/api/review" ||
    path.startsWith("/api/proposals/") ||
    path.startsWith("/api/decisions/") ||
    path.startsWith("/api/trace/") ||
    path === "/api/dev/seed-review"
  ) {
    const handled = await handleReviewRoute(req, res);
    if (handled) return;
  }

  // Freshness ("Knows you: X → Y") + Library screens (P2.4): per-source
  // capture views, per-stream pause, and the honest cascading screen delete.
  if (path === "/api/freshness" || path.startsWith("/api/library/")) {
    const handled = await handleLibraryRoute(req, res);
    if (handled) return;
  }

  // Assist artifacts + nudge state + capture quick-pause (P2.3, spec §10.5,
  // §14.7): the menu-bar panel, nudge window and in-app surfaces read here.
  if (path.startsWith("/api/assist/") || path.startsWith("/api/artifacts")) {
    const handled = await handleAssistRoute(req, res);
    if (handled) return;
  }

  // SuperTwin Browser (P3.4, spec §12): status, kill-switch, resume-after-
  // hard-stop, connect-your-accounts, session health.
  if (path.startsWith("/api/browser/")) {
    const handled = await handleBrowserRoute(req, res);
    if (handled) return;
  }

  // Task run + approvals glue (P3.5, spec §14.6): GET run / POST execute /
  // POST answer / POST send under /api/tasks/:id — the modal's live states.
  if (path.startsWith("/api/tasks/")) {
    const handled = await handleExecutorRoute(req, res, ingestion, {
      browser: browserManager,
    });
    if (handled) return;
  }

  // Timeline + grounded bar (P4.1): the rendered event log and the one-input
  // bar (search / grounded chat / actions / history). Production model seams
  // are the traced runners — the defaults inside the handler.
  if (path.startsWith("/api/timeline") || path.startsWith("/api/bar")) {
    const handled = await handleGroundedRoute(req, res);
    if (handled) return;
  }

  // Settings (P4.3, spec §14.9): general/capture/sources/graduation/t3/data
  // + the Runs & Traces viewer's filtered index and full-record read.
  if (
    path.startsWith("/api/settings/general") ||
    path.startsWith("/api/settings/capture") ||
    path.startsWith("/api/settings/sources") ||
    path.startsWith("/api/settings/graduation") ||
    path.startsWith("/api/settings/intelligence") ||
    path.startsWith("/api/settings/assist") ||
    path.startsWith("/api/settings/t3") ||
    path.startsWith("/api/settings/data") ||
    path === "/api/traces" ||
    /^\/api\/trace\/[^/]+\/full$/.test(path)
  ) {
    const handled = await handleSettingsRoute(req, res);
    if (handled) return;
  }

  // Corrections pipeline (P1.7, spec §14.4): every feedback path lands here.
  if (path.startsWith("/api/corrections")) {
    const handled = await handleCorrectionsRoute(req, res);
    if (handled) return;
  }

  // World-model reads (P1.1): people, spaces, claims, tone profiles.
  if (
    path.startsWith("/api/people") ||
    path.startsWith("/api/spaces") ||
    path.startsWith("/api/claims") ||
    path === "/api/tone"
  ) {
    const handled = await handleWorldModelRoute(req, res);
    if (handled) return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  provider: Provider,
  inflight: Map<string, AbortController>,
): Promise<void> {
  const body = (await readBody(req)) as
    | {
        runId?: string;
        sessionId?: string | null;
        message?: string;
        /** Opt-out for fresh sessions; grounding is default-ON otherwise. */
        grounded?: boolean;
      }
    | undefined;

  if (!body || typeof body.message !== "string" || !body.message.length) {
    sendJson(res, 400, { error: "message required" });
    return;
  }
  const runId =
    typeof body.runId === "string" && body.runId.length
      ? body.runId
      : randomUUID();
  const message = body.message;
  const requestedSessionId =
    typeof body.sessionId === "string" && body.sessionId.length
      ? body.sessionId
      : null;

  // Open the SSE stream.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // ---- Chat kill-switch: when the chat process is turned off in Settings,
  // return a clear assistant notice and NEVER call the provider.
  if (!getProcessEnabled("chat")) {
    sseSend(res, { type: "delta", text: "Chat is turned off in Settings." });
    res.end();
    return;
  }

  // ---- Quota gate (fail fast BEFORE dispatching). Counts the BILLABLE
  // equivalent (v3 §1): cache reads are most of every run and bill at ~10%, so
  // a raw sum would trip the limit roughly ten times sooner than real spend.
  const quota = db.getQuota(QUOTA_WINDOW_MS);
  const usedTokens = quota.billableTokens;
  if (usedTokens >= QUOTA_TOKEN_LIMIT) {
    sseSend(res, {
      type: "error",
      code: "QUOTA_EXCEEDED",
      message: `quota exceeded: ${usedTokens} billable tokens used in window (limit ${QUOTA_TOKEN_LIMIT})`,
    });
    res.end();
    return;
  }

  const providerId = provider.id;

  // ---- Grounding mode (Phase 2 T4). A saved session keeps whatever mode it
  // was created with (old ungrounded sessions keep working unchanged); a fresh
  // session defaults to grounded unless the caller opts out.
  const savedSession =
    requestedSessionId && isValidSessionId(requestedSessionId)
      ? db.getSession(requestedSessionId)
      : null;
  const grounded = savedSession ? savedSession.grounded : body.grounded !== false;

  // Grounded runs execute with cwd = brain root (so Read/Grep/Glob resolve
  // against the wiki) under the grounded system prompt; ungrounded runs keep
  // the Phase-0 sandbox config. Each mode has its own prompt-bundle hash, so a
  // session can never be resumed into the wrong mode.
  const systemPromptFile = grounded
    ? groundedSystemPromptFile()
    : SYSTEM_PROMPT_FILE;
  const bundleHash = promptBundleHash(providerId, systemPromptFile);
  let runCwd = grounded ? ensureBrain() : DEFAULT_CWD;
  const allowedTools = grounded ? groundedAllowedTools() : [];

  // ---- Resume guard: only pass sessionId to the adapter if the saved session
  // exists, is active, and its cwd + bundle hash match. Otherwise fresh.
  let resumeSessionId: string | null = null;
  if (
    savedSession &&
    savedSession.status === "active" &&
    savedSession.cwd === runCwd &&
    savedSession.promptBundleHash === bundleHash
  ) {
    resumeSessionId = savedSession.sessionId;
    runCwd = savedSession.cwd;
  }
  // If saved but cwd/bundle mismatched, we intentionally start fresh (guard).

  // ---- Persist the user message. If resuming a known session, attach to it;
  // otherwise we don't know the session id yet — attach once `session` arrives.
  let currentSessionId: string | null = resumeSessionId;
  const pendingUserMessage = message;
  if (currentSessionId) {
    db.appendMessage({
      sessionId: currentSessionId,
      role: "user",
      content: message,
      runId,
    });
  }

  const ac = new AbortController();
  inflight.set(runId, ac);
  // If the client disconnects, abort the run (kills the child).
  req.on("close", () => {
    if (inflight.has(runId)) ac.abort();
  });

  const startedAt = Date.now();
  let assistantText = "";
  let sawSessionEvent = false;
  let finalUsage: Usage = emptyUsage();

  const onEvent = (ev: ProviderStreamEvent): void => {
    // Stream every event straight to the client.
    sseSend(res, ev);

    if (ev.type === "session") {
      const newId = ev.sessionId;
      const prev = currentSessionId;
      sawSessionEvent = true;

      if (prev && prev !== newId) {
        // Fresh-fallback swapped the session id mid-run: poison the old one and
        // migrate. The old user message row keeps its (now-dead) session id;
        // we re-anchor the conversation on the new session.
        db.markSessionPoisoned(prev);
      }

      // Upsert the new session (validate-before-persist: only real ids here).
      if (isValidSessionId(newId) && !db.getSession(newId)) {
        db.createSession({
          sessionId: newId,
          provider: providerId,
          cwd: runCwd,
          promptBundleHash: bundleHash,
          title: deriveTitle(pendingUserMessage),
          grounded,
        });
      }
      currentSessionId = newId;

      // If we hadn't persisted the user message yet (fresh session), do it now.
      if (!prev && isValidSessionId(newId)) {
        db.appendMessage({
          sessionId: newId,
          role: "user",
          content: pendingUserMessage,
          runId,
        });
      }
    } else if (ev.type === "delta") {
      assistantText += ev.text;
    } else if (ev.type === "usage") {
      finalUsage = ev.usage;
    }
  };

  // ---- Pre-turn retrieval (grounded only): inject the conversation around the
  // hits for this question. Nothing is written to disk — the plaintext message
  // dump the run used to be able to Grep is gone (V2 §3.2).
  // The RAW message is what gets persisted/displayed; the augmented text is
  // what gets dispatched. Awaited because the semantic tier is async; it costs
  // nothing when there is no embedding model, which is its default state.
  const dispatchMessage = grounded ? await augmentMessage(message) : message;

  let result: ProviderResult;
  try {
    // Trace scope (build P0.7): a chat turn is one traced run. The provider
    // records the actual CLI invocation(s) — fresh-fallback included — and the
    // scope flushes them when the send settles.
    result = await withTraceContext({ pass: "chat", caller: "server/chat" }, () =>
      provider.send({
      runId,
      message: dispatchMessage,
      sessionId: resumeSessionId,
      cwd: runCwd,
      allowedTools, // grounded: read-only file tools; plain chat: none.
      systemPromptFile,
      // Neutral settings (--setting-sources ""). Chat is NOT a coding session:
      // it has no use for the user's global CLAUDE.md, hooks, plugins, MCP
      // servers or skills, and loading them is what made every chat turn time
      // out. The CLI performs that discovery synchronously BEFORE it opens a
      // socket — on this machine `~/.claude/skills` is 1.0 GB / ~14k files, so
      // a cold walk blew past the 120s/180s budget and the child was killed
      // having produced no output and burned no tokens. Measured with the flag
      // vs. without, same prompt: 17 skills / 0 plugins / 0 MCP servers /
      // no hooks and 3.4k input tokens, versus 63 / 1 / 1 / SessionStart and
      // 11.7k. Safe for both modes: the sandbox cwd is empty and the brain root
      // carries no CLAUDE.md — every instruction chat needs already arrives via
      // --append-system-prompt (systemPromptFile). Same lever the media reader
      // (media/describe.ts) and plainCompletion already use.
      skipUserSettings: true,
      // Selected model for the chat role (raw). "" ⇒ adapter adds no --model
      // flag (default).
      model: getSelectedModel("chat"),
      timeoutMs: grounded ? 180_000 : 120_000,
      onEvent,
      signal: ac.signal,
      }),
    );
  } catch (err) {
    // Provider should never throw, but never leak a crash into the stream.
    sseSend(res, {
      type: "error",
      code: "CLI_ERROR",
      message: (err as Error).message,
    });
    inflight.delete(runId);
    res.end();
    return;
  }

  inflight.delete(runId);
  const durationMs = Date.now() - startedAt;
  const finalSessionId = result.sessionId || currentSessionId || null;

  // Prefer the usage the provider computed (authoritative).
  if (result.usage) finalUsage = result.usage;

  // ---- Citations (grounded): parse the trailing `CITATIONS: [...]` line off
  // the assistant text, strip it from the persisted/display content, and emit
  // it as a final SSE frame per the Phase 2 contract. Kinds the UI cannot
  // resolve are dropped here, so an inert chip never reaches the client.
  let displayText = assistantText;
  let citations: ReturnType<typeof parseCitationsFromText>["citations"] = null;
  if (grounded && result.status === "ok" && assistantText.length) {
    const parsed = parseCitationsFromText(assistantText);
    displayText = parsed.display;
    citations = parsed.citations
      ? parsed.citations.filter((c) => isCitableKind(c.kind))
      : null;
    sseSend(res, { type: "citations", citations: citations ?? [] });
  }

  // ---- Persist assistant reply (only on success + when we have a session).
  if (
    result.status === "ok" &&
    finalSessionId &&
    isValidSessionId(finalSessionId)
  ) {
    if (displayText.length) {
      db.appendMessage({
        sessionId: finalSessionId,
        role: "assistant",
        content: displayText,
        runId,
        usageJson: JSON.stringify(finalUsage),
        citationsJson: citations ? JSON.stringify(citations) : null,
      });
    }
    db.updateSessionTimestamp(finalSessionId);
  }

  // ---- Log the run (extraction_runs) — every Claude call logged.
  db.logRun({
    provider: providerId,
    sessionId: finalSessionId,
    runId,
    kind: "chat",
    promptChars: dispatchMessage.length,
    inputTokens: finalUsage.inputTokens,
    cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
    cacheReadInputTokens: finalUsage.cacheReadInputTokens,
    outputTokens: finalUsage.outputTokens,
    costUsd: finalUsage.costUsd ?? null,
    durationMs,
    status: result.status,
    errorCode: result.errorCode ?? null,
    role: "chat",
    model: getSelectedModel("chat"),
  });

  // ---- Accumulate quota from THIS run's reported usage. Unconditional: the
  // spend of a run killed by timeout or cancel is real, and it is mostly cache,
  // which a fresh-tokens-only test never sees at all.
  db.addUsage({
    inputTokens: finalUsage.inputTokens,
    cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
    cacheReadInputTokens: finalUsage.cacheReadInputTokens,
    outputTokens: finalUsage.outputTokens,
    runCount: 1,
  });

  // Guard against an unterminated stream (no session ever arrived on error).
  if (!sawSessionEvent && result.status !== "ok") {
    // error frame was already sent by the provider; nothing else to do.
  }

  res.end();
}

/** The media reader's persisted settings, as GET/POST /api/settings/media serve them. */
function mediaSettings(): {
  describe_enabled: boolean;
  backfill_enabled: boolean;
  images_enabled: boolean;
  video_enabled: boolean;
  business_enabled: boolean;
  link_scrape_enabled: boolean;
  video_frames_enabled: boolean;
  video_audio_enabled: boolean;
  voice_notes_enabled: boolean;
  read_all_media: boolean;
  salience_gate: boolean;
  rate_per_min: number;
  concurrency: number;
  image_batch: number;
  video_frame_interval_sec: number;
  video_frame_max: number;
  video_max_height: number;
  whisper_model: string;
} {
  return {
    describe_enabled: getMediaDescribeEnabled(),
    backfill_enabled: getMediaBackfillEnabled(),
    images_enabled: getMediaImagesEnabled(),
    video_enabled: getMediaVideoEnabled(),
    business_enabled: getMediaBusinessEnabled(),
    link_scrape_enabled: getMediaLinkScrapeEnabled(),
    video_frames_enabled: getMediaVideoFramesEnabled(),
    video_audio_enabled: getMediaVideoAudioEnabled(),
    voice_notes_enabled: getMediaVoiceNotesEnabled(),
    read_all_media: getEnrichmentReadAllMedia(),
    salience_gate: getEnrichmentSalienceGate(),
    rate_per_min: getMediaRatePerMin(),
    concurrency: getMediaConcurrency(),
    image_batch: getMediaImageBatch(),
    video_frame_interval_sec: getMediaVideoFrameIntervalSec(),
    video_frame_max: getMediaVideoFrameMax(),
    video_max_height: getMediaVideoMaxHeight(),
    whisper_model: getMediaWhisperModel(),
  };
}

/** Parse a stored citations_json column into an array (null on garbage). */
function safeParseCitationsJson(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** First line / first ~60 chars of the user message, as a session title. */
function deriveTitle(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const t = firstLine.length ? firstLine : message.trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

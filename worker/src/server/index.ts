// ===========================================================================
// Worker HTTP + SSE server (localhost). See docs/PHASE0_ARCHITECTURE.md §7.
//
// Endpoints:
//   GET  /api/health          -> { ok, version }
//   POST /api/chat            -> SSE stream of ProviderStreamEvent frames
//   POST /api/cancel          -> { ok }
//   GET  /api/chat/sessions      -> [{ conversationId, title, cwd, status, ... }]
//   GET  /api/chat/sessions/:id  -> { session, messages }
//   GET  /api/quota              -> QuotaSnapshot + media (its own, ungated spend)
//   POST /api/chat/sessions/new  -> { conversationId: UUIDv4 }
//
// /api/sessions itself belongs to the V2 sessions surface (sessions-routes.ts),
// which answers with a SessionsPage object rather than this bare array.
//
// The server is the persistence + logging layer: it enforces quota, looks up
// the saved session (to feed cwd/bundle guards to the adapter), persists the
// user + assistant messages, logs every run to extraction_runs, and updates
// quota. The provider stays transport-only.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as db from "../db/index.js";
import { DEFAULT_WORKER_PORT } from "../home.js";
import { moduleDir } from "../module-path.js";
import { bootDegradations } from "../boot-guard.js";
import { BUILT_THROUGH_PHASE } from "../version.js";
import { appStateGet, rescanMedia, type RescanType } from "../db/ingest.js";
import { getV2 as getProviderV2, listV2 as listProvidersV2, sendProviderRequest } from "../providers/index.js";
import type {
  NeutralProviderResult,
  ProviderErrorCode,
  ProviderStreamEvent,
  Usage,
} from "../providers/index.js";
import {
  ProviderSelectionError,
  requireMaxOutputTokens,
  resolveModelCall,
} from "../providers/selection.js";
import { reasoningRequestForResolvedCall } from "../brain/reasoning.js";
import { emptyUsage } from "../providers/usage.js";
import { withTraceContext } from "../traces/context.js";
import {
  MODEL_CATALOG,
  MODEL_ROLES,
  isValidModelId,
  isValidRole,
} from "../providers/claude-local/models.js";
import {
  getDebugExportEnabled,
  getActiveProvider,
  getProviderModelSelection,
  setProviderModelSelection,
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
import {
  ensureDefaultEmbeddingModelDownload,
  seedActiveEmbeddingModel,
} from "../retrieval/default-model.js";
import { dropChunkStaging } from "../retrieval/chunk-index.js";
import { ensureBrain, handleBrainRoute } from "../brain/index.js";
import { handleOpsRoute } from "./ops-routes.js";
import { handleScreenRoute } from "./screen-routes.js";
// Browser source connect flow (V6 S1.4): discover + counts, status, connect.
import { handleBrowserSourceRoute } from "./browser-source-routes.js";
import { handleSystemRoute, type SystemDeps } from "./system-routes.js";
// V2 product surfaces (§3.2). Each owns its own prefix, takes no deps arg, and
// returns false for a path it does not claim, exactly like handleOpsRoute.
import { handleSurfacesRoute } from "./surfaces-routes.js";
// V6 P1 S4.3: `surface-router.v1` — the nudge card, the unread counter and
// where every finished artifact goes. Owns /api/surfaces/.
import { handleNudgeRoute } from "./nudge-routes.js";
// V6 P1 S4.5: the send gate — approval cards, the tap that mints a bound
// single-use token, and the dispatcher that sends only what the card shows.
// Owns /api/approvals except /api/approvals/mint (whatsapp-routes.ts).
import { handleApprovalsRoute } from "./approvals-routes.js";
// World-model reads (P1.1): people / spaces / claims / tone. Same contract —
// returns false for a path it does not claim.
import { handleWorldModelRoute } from "./worldmodel-routes.js";
// V6 P1 S5.1: the Spaces list/view/sweep-preview/wake/enrichment/refile routes
// — claims its own /api/spaces/* subpaths and returns false for the rest
// (worldmodel owns /api/spaces and /api/spaces/:id/claims).
import { handleSpacesRoute } from "./spaces-routes.js";
// V6 P1 S5.4: the People surfaces — the person card, "Who I am", the follow-up
// radar, and merge/split by drag with undo. Claims its own /api/people/*
// subpaths and returns false for the rest (worldmodel owns the list).
import { handlePeopleRoute } from "./people-routes.js";
import { handleCalendarRoute } from "./calendar-routes.js";
// V6 P1 S4.6: the brief — one card at each set time, composed by code, prose
// only on a delta. Claims /api/brief and its subpaths only.
import { handleBriefRoute } from "./brief-routes.js";
// V6 P1 S5.2: the ONE prioritized task list and the one-tap closure answers —
// claims GET /api/tasks and /api/tasks/:id/(done|cancel|not-yet) only.
import { handleTasksRoute } from "./tasks-routes.js";
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
// V6 S1.8: confirm card + consent rows; Library storage (two bars, two budgets).
import { handleConsentRoute } from "./consent-routes.js";
import { handleLibraryStorageRoute } from "./library-storage-routes.js";
// SuperTwin Browser (P3.4, spec §12): status / kill-switch / connect-accounts.
import { browserManager, handleBrowserRoute } from "../browser/routes.js";
// Task run + approvals glue (P3.5, spec §14.6): the task modal's live states,
// question-card answers, and the approved WhatsApp draft send.
import { handleExecutorRoute } from "./executor-routes.js";
// Timeline + grounded bar (P4.1, spec §14.3.1 / §14.8): paged event-log
// reads, the day scrubber, and the bar's intent-routed submissions.
import { handleGroundedRoute } from "./grounded-routes.js";
// Capture filter lists, private moment, forget-last-N, per-source verbs with
// previews, and the tray's real capture state (V6 S1.7).
import { handleCaptureRoute } from "./capture-routes.js";
import {
  augmentMessage,
  getEventDetail,
  groundedAllowedTools,
  groundedSystemPromptFile,
  isCitableKind,
  parseCitationsFromText,
  type CitationsFrame,
} from "./chat-grounding.js";
import {
  ConversationBusyError,
  ConversationContinuationConflictError,
  ConversationInFlightGuard,
  abortConversationTurn,
  chatPromptBundleHash,
  completeConversationTurn,
  createConversationId,
  prepareConversationTurn,
  publicChatEvent,
  type ConversationBinding,
  type ConversationContinuationStore,
  type ConversationMessage,
  type PreparedConversationTurn,
} from "./chat-continuation.js";

/** Everything the chat SSE stream can carry: provider frames + citations. */
type ChatStreamEvent = ProviderStreamEvent | CitationsFrame | Record<string, unknown>;

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
  // ESM source: import.meta.url. CJS bundle (esbuild): worker.cjs's own
  // __dirname — which `globalThis.__dirname` never found, because CJS
  // `__dirname` is module scope and not a global, so the packaged app walked up
  // from process.cwd() instead (W1).
  return moduleDir(import.meta.url);
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

async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += chunk.byteLength;
    if (size > maxBytes) return undefined;
    chunks.push(chunk);
  }
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
    // Write the active encoder down explicitly, and move this install onto the
    // default one if its weights are already here (retrieval/default-model.ts).
    // Safe on an empty index, and routed through the background swap when
    // there is one — never a silent flip.
    try {
      seedActiveEmbeddingModel();
    } catch {
      // A boot must not fail over which encoder is preferred.
    }
    // V6 S2.2: a re-embed killed mid-way left a staging table search never
    // read; drop it. Then fetch the default encoder on first run — the bundled
    // one answers until it lands (retrieval/default-model.ts).
    try {
      dropChunkStaging();
      ensureDefaultEmbeddingModelDownload();
    } catch {
      // Same: neither is a reason a boot fails.
    }
  }

  const server = createServer((req, res) => {
    handle(req, res, inflight, ingestion, system).catch((err) => {
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
    // W1: an optional subsystem that failed to start degrades one feature
    // instead of taking the worker down — but silently degrading is how you
    // ship a half-dead app twice. Present only when something actually failed.
    const degraded = bootDegradations();
    if (degraded.length > 0) body.degraded = degraded.map((d) => ({ name: d.name, error: d.error }));
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
    if ([...url.searchParams.keys()].length > 0) {
      sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "invalid query" } });
      return;
    }
    const enabledByRole: Record<string, boolean> = {};
    for (const r of MODEL_ROLES) enabledByRole[r.key] = getProcessEnabled(r.key);
    const activeProvider = getActiveProvider();
    if (activeProvider === "chatgpt-oauth") {
      let catalogue;
      try {
        catalogue = appStateGet("ai.chatgpt.enabled") === "1"
          ? getProviderV2(activeProvider)?.catalogue()
          : undefined;
      } catch {
        catalogue = undefined;
      }
      const defaultModel = catalogue?.models.find((model) => model.isDefault && !model.hidden)?.id ?? "";
      const selections = Object.fromEntries(MODEL_ROLES.map((role) => [
        role.key,
        getProviderModelSelection(activeProvider, role.key) ?? defaultModel,
      ]));
      sendJson(res, 200, {
        models: (catalogue?.models ?? []).filter((model) => !model.hidden).map((model) => ({
          id: model.id,
          label: model.displayName,
          family: "chatgpt",
          alias: false,
          resolves_to: null,
          input_per_mtok: null,
          output_per_mtok: null,
          thinking_levels: model.reasoningValues,
          default_thinking: model.defaultReasoning,
          effort: model.reasoningValues.length > 0,
          context_window: model.contextWindow,
        })),
        roles: MODEL_ROLES,
        selections,
        enabledByRole,
        catalogue: catalogue ?? {
          providerId: activeProvider,
          mode: "fallback",
          source: "ChatGPT provider registration",
          discoveredAt: new Date().toISOString(),
          revision: "unavailable",
          error: "PROVIDER_UNAVAILABLE",
          models: [],
        },
      });
      return;
    }
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
    if ([...url.searchParams.keys()].length > 0) {
      sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "invalid query" } });
      return;
    }
    const body = (await readBody(req, 16 * 1024)) as
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
    if ([...url.searchParams.keys()].length > 0) {
      sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "invalid query" } });
      return;
    }
    const body = (await readBody(req, 16 * 1024)) as
      | { role?: unknown; model?: unknown }
      | undefined;
    if (!body || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "role" && key !== "model")) {
      sendJson(res, 400, { error: "invalid body" });
      return;
    }
    const role = typeof body?.role === "string" ? body.role : "";
    const model = typeof body?.model === "string" ? body.model : "";
    if (!isValidRole(role)) {
      sendJson(res, 400, { error: "invalid role" });
      return;
    }
    const activeProvider = getActiveProvider();
    if (activeProvider === "chatgpt-oauth") {
      let available = false;
      try {
        available = appStateGet("ai.chatgpt.enabled") === "1" &&
          (getProviderV2(activeProvider)?.catalogue().models
          .some((candidate) => candidate.id === model && !candidate.hidden) ?? false);
      } catch {
        available = false;
      }
      if (!available) {
        sendJson(res, 400, { error: "invalid model" });
        return;
      }
      setProviderModelSelection(activeProvider, role, model);
      sendJson(res, 200, { role, selected: model });
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
    const sessions = db.listChatSessions();
    const out = sessions.map((s) => ({
      conversationId: s.conversationId,
      title: s.title,
      cwd: s.cwd,
      status: s.status,
      grounded: s.grounded,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: db.getChatMessages(s.conversationId).length,
    }));
    sendJson(res, 200, out);
    return;
  }

  // --- GET /api/chat/sessions/:id
  // Narrowed off /api/sessions/ deliberately: as a bare prefix it swallowed
  // every V2 /api/sessions/* subpath before handleSessionsV2Route could see it.
  if (method === "GET" && path.startsWith("/api/chat/sessions/")) {
    const id = decodeURIComponent(path.slice("/api/chat/sessions/".length));
    const session = db.getChatSession(id);
    if (!session) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    const messages = db.getChatMessages(id).map((m) => ({
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
    sendJson(res, 200, { conversationId: createConversationId() });
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
    // Also reach every strict provider in case the abort race lost and the
    // active setting changed while this run was in flight.
    for (const provider of listProvidersV2()) provider.cancel(body.runId);
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
    await handleChat(req, res, inflight);
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

  // --- Browser source connect (V6 S1.4): discover/count, status, connect.
  // Ahead of the generic /api/sources/:id router so the WhatsApp adapter never
  // answers for the browser.
  if (path.startsWith("/api/sources/browser/")) {
    const handled = await handleBrowserSourceRoute(req, res);
    if (handled) return;
  }

  // The send gate (V6 P1 S4.5): approval cards and the dispatcher that can
  // only send what a card displays. It declines /api/approvals/mint, which
  // stays on the source router below, so the order of these two is not a
  // routing subtlety — each claims a disjoint set of paths.
  if (path === "/api/approvals" || path.startsWith("/api/approvals/")) {
    const handled = await handleApprovalsRoute(req, res, ingestion);
    if (handled) return;
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

  // The surface router (V6 P1 S4.3): the one card, the unread counter, and
  // the routed plan behind the panel's Prepared order.
  if (path.startsWith("/api/surfaces/")) {
    const handled = await handleNudgeRoute(req, res);
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
  if (path.startsWith("/api/library/")) {
    const handled = await handleLibraryStorageRoute(req, res);
    if (handled) return;
  }
  if (path === "/api/freshness" || path.startsWith("/api/library/")) {
    const handled = await handleLibraryRoute(req, res);
    if (handled) return;
  }

  // V6 S1.8: the confirm card (preview + confirm) and the consent rows.
  if (path === "/api/consent" || path.startsWith("/api/consent/")) {
    const handled = await handleConsentRoute(req, res);
    if (handled) return;
  }

  // Assist artifacts + nudge state + capture quick-pause (P2.3, spec §10.5,
  // §14.7): the menu-bar panel, nudge window and in-app surfaces read here.
  if (path.startsWith("/api/assist/") || path.startsWith("/api/artifacts")) {
    const handled = await handleAssistRoute(req, res);
    if (handled) return;
  }

  // Capture (V6 S1.7): filter lists, private moment, forget, source verbs,
  // tray state. Owns everything under /api/capture/.
  if (path.startsWith("/api/capture/")) {
    const handled = await handleCaptureRoute(req, res);
    if (handled) return;
  }

  // SuperTwin Browser (P3.4, spec §12): status, kill-switch, resume-after-
  // hard-stop, connect-your-accounts, session health.
  if (path.startsWith("/api/browser/")) {
    const handled = await handleBrowserRoute(req, res);
    if (handled) return;
  }

  // The one prioritized list and the one-tap closure answers (V6 P1 S5.2,
  // spec §11.13): GET /api/tasks, POST /api/tasks/:id/(done|cancel|not-yet).
  // Before the executor block, which owns the other /api/tasks/:id verbs.
  if (path === "/api/tasks" || path.startsWith("/api/tasks/")) {
    const handled = await handleTasksRoute(req, res);
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
    path === "/api/settings/provider" ||
    path === "/api/settings/models" ||
    path.startsWith("/api/providers/chatgpt-oauth/") ||
    path.startsWith("/api/settings/assist") ||
    path.startsWith("/api/settings/retrieval") ||
    path.startsWith("/api/settings/connector") ||
    path.startsWith("/api/settings/golden") ||
    path.startsWith("/api/settings/t3") ||
    path.startsWith("/api/settings/data") ||
    path === "/api/traces" ||
    path === "/api/runs" ||
    /^\/api\/runs\/[^/]+(\/quarantine)?$/.test(path) ||
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

  // The derived calendar (V6 P1 S5.3): four layers rendered at view time,
  // tentative → confirmed, recurrence confirms, lead-time plans + snooze,
  // Settings › Calendar.
  if (path.startsWith("/api/calendar") || path === "/api/settings/calendar") {
    const handled = await handleCalendarRoute(req, res);
    if (handled) return;
  }

  // The brief (V6 P1 S4.6): the standing card, its ledger, its history, and
  // an on-demand compose. Its own surface — never the nudge router's.
  if (path === "/api/brief" || path.startsWith("/api/brief/")) {
    const handled = await handleBriefRoute(req, res);
    if (handled) return;
  }

  // Spaces surfaces (V6 P1 S5.1): list by life area, view, sweep preview,
  // wake, enrichment, re-file. Before world-model so its subpaths are claimed
  // first.
  if (path.startsWith("/api/spaces/")) {
    const handled = await handleSpacesRoute(req, res);
    if (handled) return;
  }

  // People surfaces (V6 P1 S5.4): card, "Who I am", radar, merge/split/undo.
  // Before world-model so its subpaths are claimed first.
  if (path.startsWith("/api/people/")) {
    const handled = await handlePeopleRoute(req, res);
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

function chatContinuationStore(): ConversationContinuationStore {
  const publicState = (state: db.ChatContinuationState | null) => state
    ? {
        conversationId: state.conversationId,
        provider: state.provider,
        model: state.model,
        promptBundleHash: state.promptBundleHash,
        continuation: state.continuation,
        generation: state.generation,
      }
    : null;
  return {
    getContinuation: (conversationId) => {
      const state = publicState(db.getChatContinuation(conversationId));
      if (state) return state;
      // A migrated legacy conversation intentionally has no provider binding.
      // Expose its generation as an unbound reconstruction state so the
      // helper can CAS-rebind it without ever reviving the old session id.
      return db.getChatSession(conversationId)
        ? {
            conversationId,
            provider: null,
            model: null,
            promptBundleHash: null,
            continuation: null,
            generation: 0,
          }
        : null;
    },
    reserveTurn: ({ conversationId, expectedGeneration, binding }) =>
      publicState(db.reserveChatTurn({
        conversationId,
        expectedGeneration,
        provider: binding.provider,
        model: binding.model,
        promptBundleHash: binding.promptBundleHash,
      })),
    abortTurn: ({ conversationId, expectedGeneration, binding }) =>
      db.abortChatTurn({
        conversationId,
        expectedGeneration,
        provider: binding.provider,
        model: binding.model,
        promptBundleHash: binding.promptBundleHash,
      }),
    clearContinuation: db.clearChatContinuation,
    rebindContinuation: ({ conversationId, expectedGeneration, binding }) =>
      db.rebindChatContinuation({
        conversationId,
        expectedGeneration,
        provider: binding.provider,
        model: binding.model,
        promptBundleHash: binding.promptBundleHash,
      }),
    // Assistant persistence is supplied at completion; this method is replaced
    // for that one call below and must never be reached directly.
    completeTurn: () => {
      throw new Error("assistant message is required for continuation commit");
    },
  };
}

const chatConversationGuard = new ConversationInFlightGuard();

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  inflight: Map<string, AbortController>,
): Promise<void> {
  const body = (await readBody(req)) as
    | {
        runId?: string;
        conversationId?: string | null;
        /** @deprecated One-release alias whose value is the public UUID. */
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
  if (
    typeof body.conversationId === "string" && body.conversationId.length > 0 &&
    typeof body.sessionId === "string" && body.sessionId.length > 0 &&
    body.conversationId.toLowerCase() !== body.sessionId.toLowerCase()
  ) {
    sendJson(res, 400, { error: "conversationId and sessionId must match" });
    return;
  }
  const requestedConversationId =
    typeof body.conversationId === "string" && body.conversationId.length
      ? body.conversationId
      : typeof body.sessionId === "string" && body.sessionId.length
        ? body.sessionId
        : null;
  let conversationId: string;
  try {
    conversationId = requestedConversationId ?? createConversationId();
    if (requestedConversationId) {
      // Reuse the same validation without generating or accepting provider ids.
      createConversationId(() => requestedConversationId);
      conversationId = requestedConversationId.toLowerCase();
    }
  } catch {
    sendJson(res, 400, { error: "conversationId must be a UUIDv4" });
    return;
  }

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

  let releaseConversation: () => void;
  try {
    releaseConversation = chatConversationGuard.acquire(conversationId);
  } catch (error) {
    const busy = error instanceof ConversationBusyError;
    sseSend(res, {
      type: "error",
      code: busy ? error.code : "CONVERSATION_BUSY",
      message: busy ? error.message : "conversation is already in flight",
    });
    res.end();
    return;
  }

  let abortReservedTurn: (() => void) | null = null;
  try {
  let resolved;
  try {
    resolved = resolveModelCall({ source: "role", key: "chat" });
    requireMaxOutputTokens(resolved);
  } catch (error) {
    const code = error instanceof ProviderSelectionError ? error.code : "PROVIDER_UNAVAILABLE";
    const message = error instanceof ProviderSelectionError
      ? error.message
      : "provider selection failed";
    sseSend(res, { type: "error", code, message });
    res.end();
    return;
  }
  const providerId = resolved.providerId;

  // ---- Grounding mode (Phase 2 T4). A saved session keeps whatever mode it
  // was created with (old ungrounded sessions keep working unchanged); a fresh
  // session defaults to grounded unless the caller opts out.
  const savedSession = db.getChatSession(conversationId);
  const grounded = savedSession ? savedSession.grounded : body.grounded !== false;

  // Grounded runs execute with cwd = brain root (so Read/Grep/Glob resolve
  // against the wiki) under the grounded system prompt; ungrounded runs keep
  // the Phase-0 sandbox config. Each mode has its own prompt-bundle hash, so a
  // session can never be resumed into the wrong mode.
  const systemPromptFile = grounded ? groundedSystemPromptFile() : SYSTEM_PROMPT_FILE;
  const instructions = systemPromptFile ? readFileSync(systemPromptFile, "utf8") : "";
  let runCwd = grounded ? ensureBrain() : DEFAULT_CWD;
  const allowedTools = grounded ? groundedAllowedTools() : [];
  if (savedSession) runCwd = savedSession.cwd;
  if (
    !resolved.modelSnapshot.inputModalities.includes("text") ||
    !resolved.provider.capabilities.continuation ||
    (grounded && (
      !resolved.provider.capabilities.hostTools ||
      !resolved.modelSnapshot.supportsHostTools
    ))
  ) {
    const error = new ProviderSelectionError(
      "CAPABILITY_UNSUPPORTED",
      `model ${resolved.model} cannot satisfy the selected chat policy`,
      { providerId, key: resolved.key, model: resolved.model },
    );
    sseSend(res, { type: "error", code: error.code, message: error.message });
    res.end();
    return;
  }
  const maxAgentTurns = grounded && providerId === "claude-local" ? 24 : 1;
  const policy = JSON.stringify({
    grounded,
    cwd: runCwd,
    hostTools: allowedTools,
    toolChoice: grounded ? "auto" : "none",
    skipHostSettings: true,
    persistContinuation: true,
    maxAgentTurns,
  });
  const binding: ConversationBinding = {
    provider: providerId,
    model: resolved.model,
    promptBundleHash: chatPromptBundleHash({ instructions, policy }),
  };
  const priorMessages = savedSession ? db.getChatMessages(conversationId) : [];
  if (!savedSession) {
    try {
      db.createChatSession({
        conversationId,
        provider: providerId,
        model: resolved.model,
        cwd: runCwd,
        promptBundleHash: binding.promptBundleHash,
        title: deriveTitle(message),
        grounded,
        userMessage: { content: message, runId },
      });
    } catch {
      sseSend(res, {
        type: "error",
        code: "CONTINUATION_CONFLICT",
        message: "conversation could not be created",
      });
      res.end();
      return;
    }
  }

  const ac = new AbortController();
  inflight.set(runId, ac);
  // If the client disconnects, abort the run (kills the child).
  req.on("close", () => {
    if (inflight.has(runId)) ac.abort();
  });

  const startedAt = Date.now();
  let assistantText = "";
  let finalUsage: Usage = emptyUsage();
  let finalStopReason: string | undefined;
  let sawProviderError = false;

  const onEvent = (ev: ProviderStreamEvent): void => {
    if (ev.type === "delta") {
      assistantText += ev.text;
    } else if (ev.type === "usage") {
      finalUsage = ev.usage;
    } else if (ev.type === "done") {
      finalUsage = ev.usage;
      finalStopReason = ev.stopReason;
      // Completion crosses the public boundary only after the DB CAS commits.
      return;
    } else if (ev.type === "error") {
      sawProviderError = true;
    }
    const safe = publicChatEvent(ev);
    if (safe) sseSend(res, safe);
  };

  // ---- Pre-turn retrieval (grounded only): inject the conversation around the
  // hits for this question. Nothing is written to disk — the plaintext message
  // dump the run used to be able to Grep is gone (V2 §3.2).
  // The RAW message is what gets persisted/displayed; the augmented text is
  // what gets dispatched. Awaited because the semantic tier is async; it costs
  // nothing when there is no embedding model, which is its default state.
  const dispatchMessage = grounded ? await augmentMessage(message) : message;
  const transcript: ConversationMessage[] = priorMessages
    .filter((item): item is typeof item & { role: "user" | "assistant" } =>
      item.role === "user" || item.role === "assistant")
    .map((item) => ({ role: item.role, text: item.content }));
  const continuationStore = chatContinuationStore();
  let prepared: PreparedConversationTurn;
  try {
    prepared = prepareConversationTurn({
      conversationId,
      binding,
      transcript,
      currentUserText: dispatchMessage,
      store: continuationStore,
    });
  } catch (error) {
    const conflict = error instanceof ConversationContinuationConflictError;
    sseSend(res, {
      type: "error",
      code: conflict ? error.code : "CONTINUATION_CONFLICT",
      message: conflict ? error.message : "conversation continuation could not be reserved",
    });
    res.end();
    return;
  }
  abortReservedTurn = (): void => {
    if (!abortReservedTurn) return;
    abortReservedTurn = null;
    try {
      abortConversationTurn({ prepared, binding, store: continuationStore });
    } catch {
      // Another process advanced the exact generation. Never retry or send.
    }
  };
  if (savedSession) {
    try {
      // Reservation wins before the append: a cross-process loser writes no
      // orphan user message and never dispatches the provider.
      db.appendChatUserMessage({ conversationId, content: message, runId });
    } catch {
      abortReservedTurn();
      sseSend(res, {
        type: "error",
        code: "CONTINUATION_CONFLICT",
        message: "conversation user message could not be appended",
      });
      res.end();
      return;
    }
  }
  // Public application identity replaces the provider-owned session event.
  sseSend(res, { type: "conversation", conversationId });

  let result: NeutralProviderResult;
  try {
    // Trace scope (build P0.7): a chat turn is one traced run. The provider
    // records the actual CLI invocation(s) — fresh-fallback included — and the
    // scope flushes them when the send settles.
    result = await withTraceContext({ pass: "chat", caller: "server/chat" }, () =>
      sendProviderRequest({ provider: resolved.provider, toolHandlers: {}, request: {
      runId,
      model: resolved.model,
      instructions,
      input: prepared.input,
      cwd: runCwd,
      hostTools: allowedTools,
      toolChoice: grounded ? "auto" : "none",
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
      skipHostSettings: true,
      persistContinuation: true,
      maxOutputTokens: requireMaxOutputTokens(resolved),
      maxAgentTurns,
      ...reasoningRequestForResolvedCall(resolved),
      ...(prepared.continuation ? { continuation: prepared.continuation } : {}),
      timeoutMs: grounded ? 180_000 : 120_000,
      onEvent,
      signal: ac.signal,
      } }),
    );
  } catch (err) {
    abortReservedTurn();
    const code = typeof err === "object" && err !== null && "code" in err &&
        typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: ProviderErrorCode }).code
      : "CLI_ERROR";
    sseSend(res, {
      type: "error",
      code,
      message: `provider request failed (${code})`,
    });
    inflight.delete(runId);
    res.end();
    return;
  }

  inflight.delete(runId);
  const durationMs = Date.now() - startedAt;

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
  }

  let persistenceError: ConversationContinuationConflictError | null = null;
  if (result.status === "ok") {
    const completionStore: ConversationContinuationStore = {
      ...continuationStore,
      completeTurn: ({ conversationId: id, expectedGeneration, binding: exact, continuation }) =>
        db.commitAssistantTurn({
          conversationId: id,
          expectedGeneration,
          provider: exact.provider,
          model: exact.model,
          promptBundleHash: exact.promptBundleHash,
          continuation,
          assistantMessage: {
            content: displayText,
            runId,
            usageJson: JSON.stringify(finalUsage),
            citationsJson: citations ? JSON.stringify(citations) : null,
          },
        }),
    };
    try {
      completeConversationTurn({
        prepared,
        binding,
        continuation: result.continuation,
        store: completionStore,
      });
      abortReservedTurn = null;
    } catch {
      abortReservedTurn?.();
      persistenceError = new ConversationContinuationConflictError();
    }
  } else {
    abortReservedTurn();
    if (!sawProviderError) {
      const code = result.errorCode ?? "CLI_ERROR";
      sseSend(res, {
        type: "error",
        code,
        message: `provider request failed (${code})`,
      });
    }
  }

  // ---- Log the run (extraction_runs) — every Claude call logged.
  db.logRun({
    provider: providerId,
    sessionId: conversationId,
    runId,
    kind: "chat",
    promptChars: dispatchMessage.length,
    inputTokens: finalUsage.inputTokens,
    cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
    cacheReadInputTokens: finalUsage.cacheReadInputTokens,
    outputTokens: finalUsage.outputTokens,
    costUsd: finalUsage.costUsd ?? null,
    durationMs,
    status: persistenceError ? "error" : result.status,
    errorCode: persistenceError?.code ?? result.errorCode ?? null,
    role: "chat",
    model: resolved.model,
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

  if (persistenceError) {
    sseSend(res, {
      type: "error",
      code: persistenceError.code,
      message: persistenceError.message,
    });
  } else if (result.status === "ok") {
    sseSend(res, {
      type: "done",
      usage: finalUsage,
      ...(finalStopReason ? { stopReason: finalStopReason } : {}),
    });
    if (grounded) sseSend(res, { type: "citations", citations: citations ?? [] });
  }

  res.end();
  } finally {
    abortReservedTurn?.();
    inflight.delete(runId);
    releaseConversation();
  }
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

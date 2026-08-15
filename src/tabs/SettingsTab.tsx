// Settings tab (Phase 0 §8). Beyond the placeholder copy it now carries a
// lightweight live indicator that polls GET /api/health and GET /api/quota so
// the user can see whether the worker sidecar is up and how much of the current
// token window has been used. Everything degrades gracefully when the worker is
// offline (dot goes red, numbers dash out) — no errors surface to the user.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelWhisperModel,
  cancelEmbeddingModel,
  deleteEmbeddingModel,
  deleteWhisperModel,
  downloadEmbeddingModel,
  downloadWhisperModel,
  getBrainInfo,
  getHealth,
  getLogsInfo,
  getMediaQueue,
  getMediaSettings,
  getMediaTools,
  getModels,
  getQuota,
  listRuns,
  MEDIA_CONCURRENCY_MAX,
  MEDIA_FRAME_INTERVAL_SEC_MAX,
  MEDIA_FRAME_MAX,
  MEDIA_IMAGE_BATCH_MAX,
  MEDIA_VIDEO_MAX_HEIGHT_MAX,
  MEDIA_VIDEO_MAX_HEIGHT_MIN,
  rescanMedia,
  revealBrain,
  revealLogs,
  getSemanticState,
  setMediaSettings,
  setSemanticEnabled,
  setModel,
  setProcessEnabled,
  type BrainInfo,
  type HealthInfo,
  type LogsInfo,
  type MediaQueue,
  type MediaSettings,
  type MediaToolState,
  type ModelInfo,
  type QuotaInfo,
  type RescanResult,
  type RescanType,
  type RoleInfo,
  type RunListItem,
  type SemanticState,
  type WhisperModelState,
  type WorkerClient,
} from "../lib/worker-client";
import {
  activateEmbeddingModel,
  benchmarkEmbeddingModel,
  cancelEmbeddingModelById,
  cancelEmbeddingSwap,
  deleteEmbeddingModelById,
  downloadEmbeddingModelById,
  getEmbeddingRegistry,
  type EmbeddingBenchmark,
  type EmbeddingModelRow,
  type EmbeddingModelsClient,
  type EmbeddingRegistry,
} from "../lib/embedding-models-client";

const POLL_MS = 5000;
/** Runs viewer refreshes on a lighter cadence than the health dot. */
const RUNS_POLL_MS = 8000;
/** The media backfill moves slowly; its counters don't need a fast poll. */
const MEDIA_QUEUE_POLL_MS = 8000;
/**
 * How often to re-read the toolchain WHILE a model is downloading. Outside a
 * download nothing on that card moves, and every read spawns two version
 * probes — so this timer only runs when there is progress to see.
 */
const TOOLS_POLL_MS = 1500;
/**
 * Runs per page. The viewer used to pull this many and call it the log; it now
 * pages through all of them, because a table nobody can reach the bottom of is
 * not a record of what the worker did.
 */
const RUNS_PAGE_SIZE = 50;
/** The role whose kill-switch turns off the app's only feature. */
const CHAT_ROLE = "chat";

interface SettingsTabProps {
  /**
   * Injected client (tests). Defaults to the real localhost calls. Everything
   * beyond `getHealth`/`getQuota` is optional so callers that only exercise the
   * health indicator (existing tests) stay valid; each card falls back to the
   * real localhost call when its method is omitted.
   */
  client?: Pick<WorkerClient, "getHealth" | "getQuota"> &
    Partial<
      Pick<
        WorkerClient,
        | "getModels"
        | "setModel"
        | "setProcessEnabled"
        | "getMediaSettings"
        | "setMediaSettings"
        | "getMediaQueue"
        | "rescanMedia"
        | "getMediaTools"
        | "downloadWhisperModel"
        | "cancelWhisperModel"
        | "deleteWhisperModel"
        | "getSemanticState"
        | "setSemanticEnabled"
        | "downloadEmbeddingModel"
        | "cancelEmbeddingModel"
        | "deleteEmbeddingModel"
        | "listRuns"
        | "getLogsInfo"
        | "revealLogs"
        | "getBrainInfo"
        | "revealBrain"
      >
    > &
    Partial<EmbeddingModelsClient>;
}

/** Group models by `family`, preserving first-seen family order and item order. */
function groupByFamily(models: ModelInfo[]): { family: string; items: ModelInfo[] }[] {
  const order: string[] = [];
  const byFamily = new Map<string, ModelInfo[]>();
  for (const m of models) {
    if (!byFamily.has(m.family)) {
      byFamily.set(m.family, []);
      order.push(m.family);
    }
    byFamily.get(m.family)!.push(m);
  }
  return order.map((family) => ({ family, items: byFamily.get(family)! }));
}

function fmt(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}

/** Human-readable run duration: `840 ms` / `3.2s` / `1m 12s`. */
function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/**
 * Money for a spend figure. A run that never reported a cost dashes out rather
 * than reading $0.00 — a killed run has real tokens and no cost number. Small
 * amounts keep four decimals: a single call costs cents, and rounding it to
 * $0.00 is the same kind of lie as reporting 17 input tokens.
 */
function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n > 0 && n < 0.1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Human-readable file size for the logs listing and the model catalogue. */
function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  // Whisper models run to gigabytes; "2951.6 MB" is a number nobody can read.
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Compact local timestamp for run/log rows (falls back to the raw string). */
function fmtTime(ts: string | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type ModelSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

type RescanState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: RescanResult }
  | { kind: "error"; message: string };

/** Left subnav entries — one per settings section, in page order. */
const SECTIONS = [
  { id: "worker", label: "Worker" },
  { id: "usage", label: "Usage" },
  { id: "models", label: "Models" },
  { id: "media", label: "Media" },
  { id: "transcription", label: "Transcription" },
  { id: "search", label: "Search" },
  { id: "runs", label: "Recent runs" },
  { id: "brain", label: "Brain wiki" },
  { id: "logs", label: "Logs" },
] as const;

/**
 * The media settings keys that are numbers, the one that is a choice, and
 * everything left over — the switches.
 */
const MEDIA_NUMBER_KEYS = [
  "rate_per_min",
  "concurrency",
  "image_batch",
  "video_frame_interval_sec",
  "video_frame_max",
  "video_max_height",
] as const;
type MediaNumberKey = (typeof MEDIA_NUMBER_KEYS)[number];
type MediaSwitchKey = Exclude<
  keyof MediaSettings,
  MediaNumberKey | "whisper_model"
>;

interface MediaSwitchDef {
  key: MediaSwitchKey;
  testId: string;
  label: string;
  /** Says what turning it on actually does, where that isn't obvious. */
  caption?: string;
  /**
   * A switch this one does nothing without. On but inert is the one state a
   * toggle cannot show by itself, so `note` is rendered when it happens.
   */
  requires?: { key: MediaSwitchKey; note: string };
}

/**
 * The media switches in display order. The three that are off by default each
 * spend tokens or reach the network on media somebody else chose, so their copy
 * says so plainly rather than leaving the user to find out from a bill.
 */
const MEDIA_SWITCH_GROUPS: { title?: string; switches: MediaSwitchDef[] }[] = [
  {
    switches: [
      {
        key: "describe_enabled",
        testId: "media-describe",
        label: "Describe media as it arrives",
      },
      {
        key: "backfill_enabled",
        testId: "media-backfill",
        label: "Work through media you already imported",
      },
    ],
  },
  {
    title: "What may be read",
    switches: [
      {
        key: "images_enabled",
        testId: "media-images",
        label: "Photos and stickers",
        caption:
          "The everyday case, and the cheapest — photos go to Claude several at a time, as many per call as you set below.",
      },
      {
        key: "video_enabled",
        testId: "media-video",
        label: "Videos",
        caption:
          "One still per video, one call each. On its own this looks at a single frame — more of them is the switch below, and the sound is under Transcription.",
      },
      {
        key: "video_frames_enabled",
        testId: "media-video-frames",
        label: "More than one frame per video",
        caption:
          "Takes a still every few seconds instead of one, up to the cap below, and sends the set in a single call so Claude can say what changes between them. It is still stills: nothing plays the video, and the sound is a separate switch under Transcription. More frames cost more per video.",
        requires: {
          key: "video_enabled",
          note: "Videos are switched off, so none is read and nothing is sampled. This does nothing until Videos above is on.",
        },
      },
      {
        key: "business_enabled",
        testId: "media-business",
        label: "Business and official-account chats",
        caption:
          "Catalogues, receipts, order cards and the pictures inside ads. Mostly marketing, and it is often the largest pile of media you have — off until you ask for it.",
      },
    ],
  },
  {
    title: "Links",
    switches: [
      {
        key: "link_scrape_enabled",
        testId: "media-link-scrape",
        label: "Fetch the pages that links point to",
        caption:
          "Downloads the page a link in a message points at and keeps its readable text so you can search it. A YouTube or Instagram link goes further: the clip itself is downloaded at the height set below, sampled and transcribed on this Mac, and then deleted. That is an outbound request to a URL somebody else chose — whoever sent the link can see it was opened, and when. No model is involved. Off by default for that reason.",
      },
    ],
  },
];

/**
 * The two transcription switches (v5 §3). They live in their own section
 * because nothing here reaches Claude: whisper runs on this Mac, so the cost is
 * wall-clock rather than tokens, and the caveats are about audio, not money.
 */
const TRANSCRIPTION_SWITCHES: MediaSwitchDef[] = [
  {
    key: "voice_notes_enabled",
    testId: "media-voice-notes",
    label: "Voice notes and audio attachments",
    caption:
      "Voice notes, plus the music and audio files people send. This is usually the large pile — a backlog of them takes hours of your Mac's time, though not a cent. Business and official-account chats stay out of it until their switch under Media is on.",
  },
  {
    key: "video_audio_enabled",
    testId: "media-video-audio",
    label: "The audio inside videos",
    caption:
      "Separate from the frames above, and separate from voice notes: a video can be transcribed without being looked at, and the other way round.",
  },
];

/** What a re-scan can be asked for, in the order the checkboxes appear. */
const RESCAN_TYPES: { type: RescanType; label: string }[] = [
  { type: "image", label: "Photos and stickers" },
  { type: "video", label: "Videos" },
  { type: "document", label: "Documents" },
  { type: "business", label: "Business chats" },
  { type: "link", label: "Links" },
  { type: "frames", label: "Video frames" },
  { type: "transcript", label: "Transcripts" },
];

/** Re-scan types that cost no tokens, so the confirm can say which is which. */
const FREE_RESCAN_TYPES: readonly RescanType[] = ["link", "transcript"];

/**
 * The numeric fields' drafts. Each keeps its own so a half-typed value isn't
 * persisted per keystroke; they commit on blur and then adopt whatever the
 * worker stored, because a number it clamped must not sit in the box looking
 * accepted.
 */
const emptyDrafts: Record<MediaNumberKey, string> = {
  rate_per_min: "",
  concurrency: "",
  image_batch: "",
  video_frame_interval_sec: "",
  video_frame_max: "",
  video_max_height: "",
};

function draftsFrom(s: MediaSettings): Record<MediaNumberKey, string> {
  return {
    rate_per_min: String(s.rate_per_min),
    concurrency: String(s.concurrency),
    image_batch: String(s.image_batch),
    video_frame_interval_sec: String(s.video_frame_interval_sec),
    video_frame_max: String(s.video_frame_max),
    video_max_height: String(s.video_max_height),
  };
}

/** iOS-style switch: visually-hidden native checkbox + styled track/knob. */
function Switch({
  checked,
  disabled,
  onChange,
  testId,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId: string;
  ariaLabel: string;
}) {
  return (
    <span className="settings__switch">
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <span className="settings__switch-track" aria-hidden="true">
        <span className="settings__switch-knob" />
      </span>
    </span>
  );
}

export function SettingsTab({ client }: SettingsTabProps = {}) {
  const getHealthFn = client?.getHealth ?? getHealth;
  const getQuotaFn = client?.getQuota ?? getQuota;
  const getModelsFn = client?.getModels ?? getModels;
  const setModelFn = client?.setModel ?? setModel;
  const setProcessEnabledFn = client?.setProcessEnabled ?? setProcessEnabled;
  const getMediaSettingsFn = client?.getMediaSettings ?? getMediaSettings;
  const setMediaSettingsFn = client?.setMediaSettings ?? setMediaSettings;
  const getMediaQueueFn = client?.getMediaQueue ?? getMediaQueue;
  const rescanMediaFn = client?.rescanMedia ?? rescanMedia;
  const getMediaToolsFn = client?.getMediaTools ?? getMediaTools;
  const downloadWhisperModelFn =
    client?.downloadWhisperModel ?? downloadWhisperModel;
  const cancelWhisperModelFn = client?.cancelWhisperModel ?? cancelWhisperModel;
  const deleteWhisperModelFn = client?.deleteWhisperModel ?? deleteWhisperModel;
  const getSemanticStateFn = client?.getSemanticState ?? getSemanticState;
  const setSemanticEnabledFn = client?.setSemanticEnabled ?? setSemanticEnabled;
  const downloadEmbeddingModelFn =
    client?.downloadEmbeddingModel ?? downloadEmbeddingModel;
  const cancelEmbeddingModelFn =
    client?.cancelEmbeddingModel ?? cancelEmbeddingModel;
  const deleteEmbeddingModelFn =
    client?.deleteEmbeddingModel ?? deleteEmbeddingModel;
  // ---- The encoder catalogue: four models, one active, swapped in place.
  const getEmbeddingRegistryFn =
    client?.getEmbeddingRegistry ?? getEmbeddingRegistry;
  const downloadEmbeddingModelByIdFn =
    client?.downloadEmbeddingModelById ?? downloadEmbeddingModelById;
  const cancelEmbeddingModelByIdFn =
    client?.cancelEmbeddingModelById ?? cancelEmbeddingModelById;
  const deleteEmbeddingModelByIdFn =
    client?.deleteEmbeddingModelById ?? deleteEmbeddingModelById;
  const activateEmbeddingModelFn =
    client?.activateEmbeddingModel ?? activateEmbeddingModel;
  const cancelEmbeddingSwapFn =
    client?.cancelEmbeddingSwap ?? cancelEmbeddingSwap;
  const benchmarkEmbeddingModelFn =
    client?.benchmarkEmbeddingModel ?? benchmarkEmbeddingModel;
  const listRunsFn = client?.listRuns ?? listRuns;
  const getLogsInfoFn = client?.getLogsInfo ?? getLogsInfo;
  const revealLogsFn = client?.revealLogs ?? revealLogs;
  const getBrainInfoFn = client?.getBrainInfo ?? getBrainInfo;
  const revealBrainFn = client?.revealBrain ?? revealBrain;

  const [online, setOnline] = useState<boolean | null>(null);
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const mounted = useRef(true);

  // Model picker state (loaded once on mount). `selections` is keyed by role so
  // one role's optimistic update / save state never clobbers another's.
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [roleSave, setRoleSave] = useState<Record<string, ModelSaveState>>({});
  // Per-role on/off flags (`enabledByRole`). A missing key defaults to enabled.
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const modelGroups = useMemo(() => groupByFamily(models ?? []), [models]);

  // Media reader settings (loaded once) + the describe backlog (polled). Each
  // number keeps its own draft so a half-typed value isn't persisted per
  // keystroke; they commit on blur.
  const [media, setMedia] = useState<MediaSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<MediaNumberKey, string>>(
    emptyDrafts,
  );
  const [mediaQueue, setMediaQueue] = useState<MediaQueue | null>(null);

  // The bundled toolchain + whisper model catalogue. `null` until the worker
  // answers; the model rows stay disabled until then rather than offering a
  // download of something whose state is unknown.
  const [tools, setTools] = useState<MediaToolState | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  // Searching by meaning: the switch, the encoder, and how far the index has
  // got. `null` until the worker answers, so the controls stay disabled rather
  // than offering to fetch 129 MB of something whose state is unknown.
  const [semantic, setSemantic] = useState<SemanticState | null>(null);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<EmbeddingRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [benchmarking, setBenchmarking] = useState<string | null>(null);

  // Re-scan picker. Nothing is selected up front and the run goes through a
  // confirm: this is the one control in Settings that starts model calls, and
  // it starts one per file.
  const [rescanSel, setRescanSel] = useState<RescanType[]>([]);
  const [rescanConfirm, setRescanConfirm] = useState(false);
  const [rescan, setRescan] = useState<RescanState>({ kind: "idle" });

  // Brain wiki folder (loaded once) — path + Open button.
  const [brain, setBrain] = useState<BrainInfo | null>(null);

  // Runs viewer (every LLM call, newest first). `null` = still loading; polls
  // lightly, pages on demand, and has a manual Refresh button.
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [runsHasMore, setRunsHasMore] = useState(false);
  const [runsRefreshing, setRunsRefreshing] = useState(false);
  const [runsPaging, setRunsPaging] = useState(false);
  // Whether the user has paged past the first page. The poll stops there: it
  // would drop the history they went looking for back to page one.
  const runsPagedRef = useRef(false);

  // Logs card.
  const [logs, setLogs] = useState<LogsInfo | null>(null);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();

    async function poll() {
      try {
        const h = await getHealthFn(controller.signal);
        if (!mounted.current) return;
        setOnline(Boolean(h.ok));
        setHealth(h);
        // Only pull quota when the worker answered health — avoids a second
        // failing request when it's plainly offline.
        try {
          const q = await getQuotaFn(controller.signal);
          if (mounted.current) setQuota(q);
        } catch {
          /* quota optional; leave last-known */
        }
      } catch {
        if (mounted.current) {
          setOnline(false);
          setHealth(null);
        }
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [getHealthFn, getQuotaFn]);

  // Load the model catalog + roles + current per-role selections once. Failure
  // is non-fatal — the card simply stays empty/disabled if the worker is
  // unreachable.
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    (async () => {
      try {
        const res = await getModelsFn(controller.signal);
        if (!live) return;
        setModels(res.models);
        setRoles(res.roles);
        setSelections(res.selections);
        setEnabled(res.enabledByRole ?? {});
      } catch {
        /* leave the picker empty; worker offline / not yet ready */
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [getModelsFn]);

  async function onRoleModelChange(role: string, next: string) {
    const prev = selections[role] ?? "";
    // Optimistically reflect the choice for this role, then persist. Keying by
    // role means a slow/failed save for one role can't disturb the others.
    setSelections((s) => ({ ...s, [role]: next }));
    setRoleSave((s) => ({ ...s, [role]: { kind: "saving" } }));
    try {
      const res = await setModelFn(role, next);
      if (!mounted.current) return;
      setSelections((s) => ({ ...s, [role]: res.selected }));
      setRoleSave((s) => ({ ...s, [role]: { kind: "saved" } }));
    } catch (err) {
      if (!mounted.current) return;
      // Revert this role on failure and show the worker's message.
      setSelections((s) => ({ ...s, [role]: prev }));
      setRoleSave((s) => ({
        ...s,
        [role]: {
          kind: "error",
          message: err instanceof Error ? err.message : "Could not save model",
        },
      }));
    }
  }

  // Flip one process's on/off toggle. Optimistic like the model-select: reflect
  // the choice immediately, persist, and revert on failure. Keyed by role so one
  // toggle's failure never disturbs another's.
  async function onToggleProcess(role: string, next: boolean) {
    const prev = enabled[role] ?? true;
    setEnabled((s) => ({ ...s, [role]: next }));
    try {
      const res = await setProcessEnabledFn(role, next);
      if (!mounted.current) return;
      setEnabled((s) => ({ ...s, [role]: res.enabled }));
    } catch {
      if (!mounted.current) return;
      setEnabled((s) => ({ ...s, [role]: prev }));
    }
  }

  // Media reader settings (loaded once). Same failure posture as the model
  // card: the controls stay disabled when the worker can't answer.
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    (async () => {
      try {
        const res = await getMediaSettingsFn(controller.signal);
        if (!live) return;
        setMedia(res);
        setDrafts(draftsFrom(res));
      } catch {
        /* leave the section disabled; worker offline / not yet ready */
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [getMediaSettingsFn]);

  // Describe backlog. Polled so the user can watch a backfill drain.
  useEffect(() => {
    const controller = new AbortController();

    async function poll() {
      try {
        const q = await getMediaQueueFn(controller.signal);
        if (mounted.current) setMediaQueue(q);
      } catch {
        /* keep the last-known counts */
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), MEDIA_QUEUE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [getMediaQueueFn]);

  // Flip one media switch. Optimistic like the process toggles: reflect the
  // choice, persist, adopt whatever the worker stored, revert on failure.
  async function onToggleMedia(key: MediaSwitchKey, next: boolean) {
    const prev = media;
    if (!prev) return;
    setMedia({ ...prev, [key]: next });
    try {
      const res = await setMediaSettingsFn({ [key]: next });
      if (!mounted.current) return;
      setMedia(res);
    } catch {
      if (!mounted.current) return;
      setMedia(prev);
    }
  }

  // Commit one numeric field. A non-numeric / below-minimum entry is not sent —
  // the field snaps back to the stored value instead. The worker clamps what it
  // does accept, so both drafts adopt its answer rather than what was typed: a
  // number it reduced must not sit in the box looking accepted.
  async function onCommitNumber(key: MediaNumberKey, min: number) {
    const prev = media;
    if (!prev) return;
    const snapBack = () =>
      setDrafts((d) => ({ ...d, [key]: String(prev[key]) }));
    const next = Number.parseInt(drafts[key], 10);
    if (!Number.isFinite(next) || next < min) {
      snapBack();
      return;
    }
    // Nothing to persist, but "012" still has to render as the stored 12.
    if (next === prev[key]) {
      snapBack();
      return;
    }
    try {
      const res = await setMediaSettingsFn({ [key]: next });
      if (!mounted.current) return;
      setMedia(res);
      setDrafts(draftsFrom(res));
    } catch {
      if (!mounted.current) return;
      snapBack();
    }
  }

  // The model rows the action routes hand back, folded into the loaded state.
  // They carry everything the card renders, so a download/delete lands without
  // waiting for the next poll.
  const applyModels = useCallback((models: WhisperModelState[]) => {
    setTools((t) => (t ? { ...t, models } : t));
  }, []);

  const refreshTools = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await getMediaToolsFn(signal);
        if (mounted.current) setTools(res);
      } catch {
        /* worker offline / not ready — the card stays as it was */
      }
    },
    [getMediaToolsFn],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshTools(controller.signal);
    return () => controller.abort();
  }, [refreshTools]);

  // Only poll while something is actually downloading: outside that nothing on
  // this card changes, and every read asks both binaries their version.
  const downloading = (tools?.models ?? []).some(
    (m) => m.download?.status === "downloading",
  );
  useEffect(() => {
    if (!downloading) return;
    const controller = new AbortController();
    const timer = setInterval(
      () => void refreshTools(controller.signal),
      TOOLS_POLL_MS,
    );
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [downloading, refreshTools]);

  /**
   * Point transcription at another model. Only a model already on disk can be
   * chosen — selecting one that is not here would leave every transcription
   * failing with "the model is not on this machine".
   */
  async function onSelectWhisperModel(id: string) {
    const prev = media;
    if (!prev) return;
    setMedia({ ...prev, whisper_model: id });
    setModelError(null);
    try {
      const res = await setMediaSettingsFn({ whisper_model: id });
      if (!mounted.current) return;
      setMedia(res);
      // `selected` lives on the model rows too, so they have to be re-read.
      void refreshTools();
    } catch (err) {
      if (!mounted.current) return;
      setMedia(prev);
      setModelError(
        err instanceof Error ? err.message : "Could not switch model",
      );
    }
  }

  async function onDownloadModel(id: string) {
    setModelError(null);
    try {
      const res = await downloadWhisperModelFn(id);
      if (mounted.current) applyModels(res.models);
    } catch (err) {
      if (!mounted.current) return;
      setModelError(
        err instanceof Error ? err.message : "Could not start the download",
      );
    }
  }

  async function onCancelModel(id: string) {
    try {
      const res = await cancelWhisperModelFn(id);
      if (mounted.current) applyModels(res.models);
    } catch {
      // The download either stopped or it did not; the next poll says which.
    }
  }

  // Deleting is refused for the bundled model and for the one transcription is
  // set to use, and the worker's reason is the only useful thing to show.
  async function onDeleteModel(id: string) {
    setModelError(null);
    try {
      const res = await deleteWhisperModelFn(id);
      if (mounted.current) applyModels(res.models);
    } catch (err) {
      if (!mounted.current) return;
      setModelError(
        err instanceof Error ? err.message : "Could not delete the model",
      );
    }
  }

  // ---- Searching by meaning -----------------------------------------------

  const refreshSemantic = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await getSemanticStateFn(signal);
        if (mounted.current) setSemantic(res);
      } catch {
        // Worker offline; the card shows its last-known state, or nothing.
      }
    },
    [getSemanticStateFn],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshSemantic(controller.signal);
    return () => controller.abort();
  }, [refreshSemantic]);

  // Poll only while there is something moving: a download in flight, or an
  // index still catching up. Idle, nothing on this card changes.
  const semanticBusy =
    semantic?.download?.status === "downloading" ||
    (semantic?.availability === "ready" && semantic.indexed < semantic.embeddable);
  useEffect(() => {
    if (!semanticBusy) return;
    const controller = new AbortController();
    const timer = setInterval(
      () => void refreshSemantic(controller.signal),
      TOOLS_POLL_MS,
    );
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [semanticBusy, refreshSemantic]);

  /** Every one of these answers with the whole state, so none of them guesses. */
  async function runSemantic(
    call: () => Promise<SemanticState>,
    failure: string,
  ): Promise<void> {
    setSemanticError(null);
    try {
      const res = await call();
      if (mounted.current) setSemantic(res);
    } catch (err) {
      if (!mounted.current) return;
      setSemanticError(err instanceof Error ? err.message : failure);
    }
  }

  // ---- The encoder catalogue ------------------------------------------------

  const refreshRegistry = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await getEmbeddingRegistryFn(signal);
        if (mounted.current) setRegistry(res);
      } catch {
        // Worker offline; the card shows its last-known state, or nothing.
      }
    },
    [getEmbeddingRegistryFn],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshRegistry(controller.signal);
    return () => controller.abort();
  }, [refreshRegistry]);

  // Poll only while something is moving: a download, or a swap building the
  // new index. Idle, nothing on this card changes.
  const registryBusy =
    registry?.models.some((m) => m.download?.status === "downloading") === true ||
    registry?.swap?.phase === "embedding" ||
    registry?.swap?.phase === "flipping";
  useEffect(() => {
    if (!registryBusy) return;
    const controller = new AbortController();
    const timer = setInterval(
      () => void refreshRegistry(controller.signal),
      TOOLS_POLL_MS,
    );
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [registryBusy, refreshRegistry]);

  /** Every registry call answers with the whole state, so none of them guesses. */
  async function runRegistry(
    call: () => Promise<EmbeddingRegistry>,
    failure: string,
  ): Promise<void> {
    setRegistryError(null);
    try {
      const res = await call();
      if (mounted.current) setRegistry(res);
      // The active model and the index counts moved; the card above reads them.
      void refreshSemantic();
    } catch (err) {
      if (!mounted.current) return;
      setRegistryError(err instanceof Error ? err.message : failure);
    }
  }

  async function onBenchmarkModel(id: string) {
    setRegistryError(null);
    setBenchmarking(id);
    try {
      const res = await benchmarkEmbeddingModelFn(id);
      if (mounted.current) setRegistry(res);
    } catch (err) {
      if (!mounted.current) return;
      setRegistryError(
        err instanceof Error ? err.message : "Could not run the benchmark",
      );
    } finally {
      if (mounted.current) setBenchmarking(null);
    }
  }

  function onToggleRescanType(type: RescanType, next: boolean) {
    setRescanSel((s) => (next ? [...s, type] : s.filter((t) => t !== type)));
    // A previous result describes a previous selection; drop it.
    setRescan({ kind: "idle" });
  }

  // Re-queue the chosen types. Failure is shown rather than swallowed — the
  // user asked for work to start, so silence would read as "it started".
  async function onRescan() {
    setRescanConfirm(false);
    setRescan({ kind: "running" });
    try {
      const result = await rescanMediaFn(rescanSel);
      if (!mounted.current) return;
      setRescan({ kind: "done", result });
    } catch (err) {
      if (!mounted.current) return;
      setRescan({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not start a re-scan",
      });
    }
  }

  // Pull the newest page, dropping any pages the user had loaded. Non-fatal on
  // failure (leave last-known); shared by the poll and the Refresh button.
  const refreshRuns = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const rows = await listRunsFn({ limit: RUNS_PAGE_SIZE }, signal);
        if (!mounted.current) return;
        setRuns(rows);
        // A full page back means there may be older ones; a short one is the end.
        setRunsHasMore(rows.length === RUNS_PAGE_SIZE);
        runsPagedRef.current = false;
      } catch {
        /* worker offline / not ready — keep whatever we had */
      }
    },
    [listRunsFn],
  );

  // The page after the one loaded. Offsets shift when a run is recorded
  // mid-read, so the seam is de-duped rather than trusted.
  async function onLoadMoreRuns() {
    if (runsPaging) return;
    const loaded = runs?.length ?? 0;
    setRunsPaging(true);
    runsPagedRef.current = true;
    try {
      const rows = await listRunsFn({
        limit: RUNS_PAGE_SIZE,
        offset: loaded,
      });
      if (!mounted.current) return;
      setRuns((prev) => {
        const seen = new Set((prev ?? []).map((r) => r.id));
        return [...(prev ?? []), ...rows.filter((r) => !seen.has(r.id))];
      });
      setRunsHasMore(rows.length === RUNS_PAGE_SIZE);
    } catch {
      // Leave the table as it is; the button can be pressed again. The page
      // never arrived, so the reader is still on the newest one and the poll
      // has nothing to pull out from under them.
      runsPagedRef.current = false;
    } finally {
      if (mounted.current) setRunsPaging(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setRunsRefreshing(true);
    void refreshRuns(controller.signal).finally(() => {
      if (mounted.current) setRunsRefreshing(false);
    });
    const timer = setInterval(() => {
      if (runsPagedRef.current) return;
      void refreshRuns(controller.signal);
    }, RUNS_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refreshRuns]);

  async function onRefreshRuns() {
    setRunsRefreshing(true);
    await refreshRuns();
    if (mounted.current) setRunsRefreshing(false);
  }

  // Logs directory + file listing (loaded once).
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    (async () => {
      try {
        const info = await getLogsInfoFn(controller.signal);
        if (live) setLogs(info);
      } catch {
        /* logs card stays empty when the worker is unreachable */
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [getLogsInfoFn]);

  // Brain wiki folder info (loaded once) — path + recursive file count.
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    (async () => {
      try {
        const info = await getBrainInfoFn(controller.signal);
        if (live) setBrain(info);
      } catch {
        /* brain card stays empty when the worker is unreachable */
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [getBrainInfoFn]);

  async function onOpenLogs() {
    try {
      await revealLogsFn();
    } catch {
      /* best-effort reveal; never surfaces an error */
    }
  }

  async function onOpenBrain() {
    try {
      await revealBrainFn();
    } catch {
      /* best-effort reveal; never surfaces an error */
    }
  }

  const dotClass =
    online === null
      ? "status-dot status-dot--unknown"
      : online
        ? "status-dot status-dot--online"
        : "status-dot status-dot--offline";

  const statusText =
    online === null ? "Checking…" : online ? "Online" : "Offline";

  function onNavClick(id: string) {
    setActiveSection(id);
    // Smooth-scroll the section into view (no-op in jsdom).
    document.getElementById(`settings-${id}`)?.scrollIntoView?.({
      behavior: "smooth",
      block: "start",
    });
  }

  return (
    <section className="panel panel--settings">
      <header className="panel__header">
        <h1 className="panel__title">Settings</h1>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav__items">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-nav__item${
                  activeSection === s.id ? " settings-nav__item--active" : ""
                }`}
                onClick={() => onNavClick(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="settings-nav__footer">
            <span className={dotClass} aria-hidden="true" />
            <span>
              SuperTwinV11{online && health?.version ? ` v${health.version}` : ""}
            </span>
          </div>
        </nav>

        <div className="settings">
        <section id="settings-worker" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Worker</h2>
            <span className="settings__status">
              <span className={dotClass} aria-hidden="true" />
              <span data-testid="worker-status">{statusText}</span>
            </span>
          </div>
          <p className="settings__section-desc">
            The local sidecar that talks to WhatsApp and Claude.
          </p>
          <dl className="settings__stats">
            <div className="settings__stat">
              <dt>Endpoint</dt>
              <dd>localhost:8011</dd>
            </div>
            <div className="settings__stat">
              <dt>Version</dt>
              <dd>{online && health?.version ? health.version : "—"}</dd>
            </div>
          </dl>
        </section>

        <section id="settings-usage" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Token usage</h2>
            {quota?.nearLimit && (
              <span className="settings__warn">Near limit</span>
            )}
          </div>
          <p className="settings__section-desc">
            Claude tokens spent in the current window, and what they cost. Most
            of a call is cache, which bills differently from fresh input, so
            each part is counted on its own.
          </p>

          <div className="settings__spend">
            <h3 className="settings__spend-title">Chat</h3>
            <SpendGrid
              prefix="quota"
              counts={online ? quota : null}
              billableNote="the weighted total the limit acts on, not a raw count"
            />
          </div>

          <div className="settings__spend">
            <h3 className="settings__spend-title">Media reading</h3>
            <SpendGrid
              prefix="media-spend"
              counts={online ? quota?.media : null}
              billableNote="weighted the same way, though no limit acts on it"
            />
            <p className="settings__note">
              Counted separately and never against the chat limit — reading a
              backlog of photos must not be able to lock you out of chat.
            </p>
          </div>
        </section>

        <section id="settings-models" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Models</h2>
          </div>
          <p className="settings__section-desc">
            Choose a Claude model per role. “Default” uses your Claude
            subscription default.
          </p>
          <div className="settings__model-roles">
            {roles.map((role) => {
              const save = roleSave[role.key] ?? { kind: "idle" };
              // A missing flag defaults to enabled (the worker seeds them true).
              const isOn = enabled[role.key] ?? true;
              return (
                <div
                  key={role.key}
                  className={`settings__model-role${
                    isOn ? "" : " settings__model-role--off"
                  }`}
                >
                  <div className="settings__model-role-head">
                    <label
                      className="settings__model-role-label"
                      htmlFor={`model-select-${role.key}`}
                    >
                      {role.label}
                    </label>
                    {save.kind === "saving" && (
                      <span className="settings__status">Saving…</span>
                    )}
                    {save.kind === "saved" && (
                      <span className="settings__status">Saved</span>
                    )}
                    {save.kind === "error" && (
                      <span
                        className="settings__warn"
                        data-testid={`model-error-${role.key}`}
                      >
                        {save.message}
                      </span>
                    )}
                  </div>
                  <p className="settings__model-role-caption">
                    {role.description}
                  </p>
                  <div className="settings__model-role-controls">
                    <select
                      id={`model-select-${role.key}`}
                      className="settings__select"
                      data-testid={`model-select-${role.key}`}
                      aria-label={`Claude model for ${role.label}`}
                      value={selections[role.key] ?? ""}
                      disabled={models === null || !isOn}
                      onChange={(e) =>
                        void onRoleModelChange(role.key, e.target.value)
                      }
                    >
                      {modelGroups.map((group) => (
                        <optgroup key={group.family} label={group.family}>
                          {group.items.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <label
                      className="settings__process-toggle"
                      title={`Turn ${role.label} ${isOn ? "off" : "on"}`}
                    >
                      <Switch
                        testId={`process-toggle-${role.key}`}
                        checked={isOn}
                        disabled={models === null}
                        onChange={(next) =>
                          void onToggleProcess(role.key, next)
                        }
                        ariaLabel={`${role.label} process enabled`}
                      />
                      <span className="settings__process-toggle-text">
                        {isOn ? "On" : "Off"}
                      </span>
                    </label>
                  </div>
                  {role.key === CHAT_ROLE && (
                    <p
                      className="settings__note settings__note--warn"
                      data-testid="chat-role-warning"
                    >
                      Chat is the only thing SuperTwinV11 does — turning it off
                      leaves the Chat tab locked.
                    </p>
                  )}
                  {role.future && (
                    <p className="settings__note settings__note--future">
                      Takes effect when task execution ships.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section id="settings-media" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Media</h2>
          </div>
          <p className="settings__section-desc">
            Send the photos, videos and documents in your chats to Claude so
            they can be searched and cited. Reading media costs tokens; the
            link switch below does not. Audio is transcribed separately, on
            this Mac — see Transcription.
          </p>
          <div className="settings__media-controls">
            {MEDIA_SWITCH_GROUPS.map((group, i) => (
              <div className="settings__media-group" key={group.title ?? i}>
                {group.title && (
                  <span className="settings__logs-label">{group.title}</span>
                )}
                {group.switches.map((s) => (
                  <MediaSwitchRow
                    key={s.key}
                    def={s}
                    media={media}
                    onToggle={(key, next) => void onToggleMedia(key, next)}
                  />
                ))}
              </div>
            ))}
            <div className="settings__media-numbers">
              <label className="settings__media-number">
                <span className="settings__logs-label">
                  Descriptions per minute
                </span>
                <input
                  type="number"
                  min={0}
                  className="settings__input"
                  data-testid="media-rate"
                  aria-label="Descriptions per minute"
                  value={drafts.rate_per_min}
                  disabled={media === null}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, rate_per_min: e.target.value }))
                  }
                  onBlur={() => void onCommitNumber("rate_per_min", 0)}
                />
              </label>
              <label className="settings__media-number">
                <span className="settings__logs-label">Reads at once</span>
                <input
                  type="number"
                  min={1}
                  max={MEDIA_CONCURRENCY_MAX}
                  className="settings__input"
                  data-testid="media-concurrency"
                  aria-label="Reads at once"
                  value={drafts.concurrency}
                  disabled={media === null}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, concurrency: e.target.value }))
                  }
                  onBlur={() => void onCommitNumber("concurrency", 1)}
                />
                <span className="settings__note settings__note--field">
                  How many reads run side by side. A batch of photos and a single
                  file each take one slot, and transcription still waits for
                  descriptions and chat. More of them drains a backlog faster and
                  spends the five-hour window faster; when Claude starts refusing,
                  the queue backs off rather than pushing {MEDIA_CONCURRENCY_MAX}{" "}
                  at it. Up to {MEDIA_CONCURRENCY_MAX}.
                </span>
              </label>
              <label className="settings__media-number">
                <span className="settings__logs-label">Photos per call</span>
                <input
                  type="number"
                  min={1}
                  max={MEDIA_IMAGE_BATCH_MAX}
                  className="settings__input"
                  data-testid="media-image-batch"
                  aria-label="Photos per call"
                  value={drafts.image_batch}
                  disabled={media === null}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, image_batch: e.target.value }))
                  }
                  onBlur={() => void onCommitNumber("image_batch", 1)}
                />
                <span className="settings__note settings__note--field">
                  How many photos share one call. Bigger is cheaper per photo —
                  most of what a call costs is the call itself. A batch that
                  comes back unreadable is read again one photo at a time, so
                  the largest sizes cost the most when they go wrong. Up to{" "}
                  {MEDIA_IMAGE_BATCH_MAX}.
                </span>
              </label>
              <label className="settings__media-number">
                <span className="settings__logs-label">
                  Seconds between frames
                </span>
                <input
                  type="number"
                  min={1}
                  max={MEDIA_FRAME_INTERVAL_SEC_MAX}
                  className="settings__input"
                  data-testid="media-frame-interval"
                  aria-label="Seconds between frames"
                  value={drafts.video_frame_interval_sec}
                  disabled={media === null || !media.video_frames_enabled}
                  onChange={(e) =>
                    setDrafts((d) => ({
                      ...d,
                      video_frame_interval_sec: e.target.value,
                    }))
                  }
                  onBlur={() =>
                    void onCommitNumber("video_frame_interval_sec", 1)
                  }
                />
                <span className="settings__note settings__note--field">
                  The frames are spread evenly across the whole clip, not taken
                  from its first seconds.
                </span>
              </label>
              <label className="settings__media-number">
                <span className="settings__logs-label">Frames per video</span>
                <input
                  type="number"
                  min={1}
                  max={MEDIA_FRAME_MAX}
                  className="settings__input"
                  data-testid="media-frame-max"
                  aria-label="Frames per video"
                  value={drafts.video_frame_max}
                  disabled={media === null || !media.video_frames_enabled}
                  onChange={(e) =>
                    setDrafts((d) => ({
                      ...d,
                      video_frame_max: e.target.value,
                    }))
                  }
                  onBlur={() => void onCommitNumber("video_frame_max", 1)}
                />
                <span className="settings__note settings__note--field">
                  The ceiling however long the video is — a ten-minute clip
                  still costs one call. Up to {MEDIA_FRAME_MAX}. A linked
                  YouTube or Instagram clip is sampled on these same two
                  numbers rather than a second set of its own.
                </span>
              </label>
              <label className="settings__media-number">
                <span className="settings__logs-label">Linked video height</span>
                <input
                  type="number"
                  min={MEDIA_VIDEO_MAX_HEIGHT_MIN}
                  max={MEDIA_VIDEO_MAX_HEIGHT_MAX}
                  step={16}
                  className="settings__input"
                  data-testid="media-video-max-height"
                  aria-label="Linked video height"
                  value={drafts.video_max_height}
                  disabled={media === null || !media.link_scrape_enabled}
                  onChange={(e) =>
                    setDrafts((d) => ({
                      ...d,
                      video_max_height: e.target.value,
                    }))
                  }
                  onBlur={() =>
                    void onCommitNumber(
                      "video_max_height",
                      MEDIA_VIDEO_MAX_HEIGHT_MIN,
                    )
                  }
                />
                <span className="settings__note settings__note--field">
                  The tallest a linked clip is fetched at, in pixels. A
                  download is the one case where the file is ours to choose:
                  taller costs bandwidth and time and nothing else, because a
                  still is scaled down anyway and whisper hears the sound
                  whatever the picture was. {MEDIA_VIDEO_MAX_HEIGHT_MIN}–
                  {MEDIA_VIDEO_MAX_HEIGHT_MAX}.
                </span>
              </label>
            </div>
          </div>
          <dl className="settings__stats settings__media-queue">
            <div className="settings__stat">
              <dt>Pending</dt>
              <dd data-testid="media-pending">{fmt(mediaQueue?.pending)}</dd>
            </div>
            <div className="settings__stat">
              <dt>Described</dt>
              <dd data-testid="media-done">{fmt(mediaQueue?.done)}</dd>
            </div>
            <div className="settings__stat">
              <dt>Unsupported</dt>
              <dd data-testid="media-unsupported">
                {fmt(mediaQueue?.unsupported)}
              </dd>
            </div>
            <div className="settings__stat">
              <dt>Failed</dt>
              <dd data-testid="media-error">{fmt(mediaQueue?.error)}</dd>
            </div>
          </dl>

          <div className="settings__rescan">
            <span className="settings__logs-label">Re-scan</span>
            <p className="settings__note">
              Throws away what was read before and reads it again. Media picked
              here goes back to Claude — a whole library is hundreds of calls —
              links are fetched again, and recordings are transcribed again on
              this Mac. That is why it is a button you press and not something
              the switches above do on their own.
            </p>
            <div className="settings__rescan-types">
              {RESCAN_TYPES.map(({ type, label }) => (
                <label className="settings__rescan-type" key={type}>
                  <input
                    type="checkbox"
                    data-testid={`rescan-${type}`}
                    checked={rescanSel.includes(type)}
                    disabled={rescan.kind === "running"}
                    onChange={(e) => onToggleRescanType(type, e.target.checked)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="wa-btn wa-btn--ghost"
              data-testid="rescan-run"
              disabled={rescanSel.length === 0 || rescan.kind === "running"}
              onClick={() => setRescanConfirm(true)}
            >
              {rescan.kind === "running" ? "Re-queueing…" : "Re-scan selected"}
            </button>
            {rescan.kind === "done" && (
              <p className="settings__note" data-testid="rescan-result">
                {rescan.result.media.toLocaleString()} media,{" "}
                {rescan.result.links.toLocaleString()} links,{" "}
                {rescan.result.transcripts.toLocaleString()} recordings and{" "}
                {rescan.result.frames.toLocaleString()} videos' frames queued to
                be read again.
              </p>
            )}
            {rescan.kind === "error" && (
              <p
                className="settings__note settings__note--warn"
                data-testid="rescan-error"
              >
                {rescan.message}
              </p>
            )}
          </div>
        </section>

        <section id="settings-transcription" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Transcription</h2>
          </div>
          <p className="settings__section-desc">
            Turn voice notes and the sound inside videos into text you can
            search. Whisper runs on this Mac: nothing is uploaded and no tokens
            are spent. What it costs instead is time — a long recording takes a
            while, and it always waits for photo descriptions and chat to
            finish first. The bundled model handles clear speech in Hindi,
            Marathi, English and the mix of them; the smaller ones are much
            weaker outside English. Whatever model you pick, it is unreliable
            on noisy audio, music and people talking over each other, and what
            it returns there is fluent text nobody said. Output that comes back
            empty, looping, or far too sparse for the length of the recording
            is thrown away and the recording marked unusable — but an invention
            that reads like ordinary speech is kept, so a transcript is a
            machine's reading and not a record of what was said.
          </p>

          <div className="settings__media-controls">
            <div className="settings__media-group">
              {TRANSCRIPTION_SWITCHES.map((s) => (
                <MediaSwitchRow
                  key={s.key}
                  def={s}
                  media={media}
                  onToggle={(key, next) => void onToggleMedia(key, next)}
                />
              ))}
            </div>
          </div>

          <ToolchainCard tools={tools} />

          <div className="settings__models">
            <span className="settings__logs-label">
              Audio Transcription Model Options
            </span>
            <p className="settings__note">
              Bigger models hear more and take longer. The one that ships with
              the app is the default; the rest download on demand and are kept
              outside the app, so an update never fetches them again. Only a
              model that is here can be selected.
            </p>
            {tools === null ? (
              <p className="settings__note">Loading…</p>
            ) : (
              <ul className="settings__model-list">
                {tools.models.map((m) => (
                  <WhisperModelRow
                    key={m.id}
                    model={m}
                    onSelect={() => void onSelectWhisperModel(m.id)}
                    onDownload={() => void onDownloadModel(m.id)}
                    onCancel={() => void onCancelModel(m.id)}
                    onDelete={() => void onDeleteModel(m.id)}
                  />
                ))}
              </ul>
            )}
            {modelError && (
              <p
                className="settings__note settings__note--warn"
                data-testid="whisper-model-error"
              >
                {modelError}
              </p>
            )}
            {tools && (
              <div className="settings__logs-dirbox">
                <span className="settings__logs-label">Downloads</span>
                <code className="settings__logs-dir">{tools.modelsDir}</code>
              </div>
            )}
          </div>
        </section>

        <section id="settings-search" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Search</h2>
          </div>
          <p className="settings__section-desc">
            Chat already searches your messages by word and by date, and that
            needs nothing here. This adds a third way of finding them: by
            meaning, so “did we book a restaurant” can reach “Restaurant
            booking to kar denge nahi?” — a line it shares no word with, in
            another language. It runs on this Mac; nothing is uploaded and no
            tokens are spent. It is a hint, not a lookup: it puts a few more
            messages in front of Claude and is at its best on paraphrase across
            Hindi, Marathi, English and the mix of them, and at its worst on
            short questions where nearly everything is equally close. Turning it
            off leaves search exactly as it was.
          </p>

          <SemanticCard
            state={semantic}
            error={semanticError}
            onToggle={(on) =>
              void runSemantic(
                () => setSemanticEnabledFn(on),
                "Could not change the setting",
              )
            }
            onDownload={() =>
              void runSemantic(
                downloadEmbeddingModelFn,
                "Could not start the download",
              )
            }
            onCancel={() =>
              void runSemantic(cancelEmbeddingModelFn, "Could not cancel")
            }
            onDelete={() =>
              void runSemantic(
                deleteEmbeddingModelFn,
                "Could not delete the model",
              )
            }
          />

          <EmbeddingModelsCard
            registry={registry}
            error={registryError}
            benchmarking={benchmarking}
            onDownload={(id) =>
              void runRegistry(
                () => downloadEmbeddingModelByIdFn(id),
                "Could not start the download",
              )
            }
            onCancelDownload={(id) =>
              void runRegistry(
                () => cancelEmbeddingModelByIdFn(id),
                "Could not cancel",
              )
            }
            onDelete={(id) =>
              void runRegistry(
                () => deleteEmbeddingModelByIdFn(id),
                "Could not delete the model",
              )
            }
            onActivate={(id) =>
              void runRegistry(
                () => activateEmbeddingModelFn(id),
                "Could not start the switch",
              )
            }
            onCancelSwap={() =>
              void runRegistry(
                cancelEmbeddingSwapFn,
                "Could not stop the switch",
              )
            }
            onBenchmark={(id) => void onBenchmarkModel(id)}
          />
        </section>

        <section
          id="settings-runs"
          className="settings__section settings__section--wide"
        >
          <div className="settings__section-head">
            <h2 className="settings__section-title">Recent runs</h2>
            <button
              type="button"
              className="wa-btn wa-btn--ghost settings__runs-refresh"
              onClick={() => void onRefreshRuns()}
              disabled={runsRefreshing}
            >
              {runsRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          <p className="settings__section-desc">
            Every LLM call the worker has made, newest first, {RUNS_PAGE_SIZE} at
            a time. Refresh returns to the newest; while you are further back
            nothing reloads underneath you.
          </p>
          {runs === null ? (
            <p className="settings__note">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="settings__note">No runs recorded yet.</p>
          ) : (
            <div
              className="settings__runs"
              role="region"
              aria-label="Recent runs"
            >
              <table className="settings__runs-table" data-testid="runs-table">
                <thead>
                  <tr>
                    <th>Process</th>
                    <th>Model</th>
                    <th className="settings__runs-num">Input</th>
                    <th className="settings__runs-num">Cache</th>
                    <th className="settings__runs-num">Output</th>
                    <th className="settings__runs-num">Cost</th>
                    <th className="settings__runs-num">Duration</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.process || "—"}</td>
                      <td>{r.model || "—"}</td>
                      <td className="settings__runs-num">
                        {fmt(r.input_tokens)}
                      </td>
                      {/* Fresh input alone reads ~3500x too small on a media
                          call, so the cache the call actually paid for sits
                          beside it, broken down on hover. */}
                      <td
                        className="settings__runs-num"
                        title={`${fmt(r.cache_creation_input_tokens)} written · ${fmt(
                          r.cache_read_input_tokens,
                        )} read`}
                      >
                        {fmt(
                          r.cache_creation_input_tokens + r.cache_read_input_tokens,
                        )}
                      </td>
                      <td className="settings__runs-num">
                        {fmt(r.output_tokens)}
                      </td>
                      <td className="settings__runs-num">
                        {fmtCost(r.cost_usd)}
                      </td>
                      <td className="settings__runs-num">
                        {fmtDuration(r.duration_ms)}
                      </td>
                      <td>
                        <span
                          className={`settings__run-status settings__run-status--${
                            r.status === "error" ? "error" : "ok"
                          }`}
                        >
                          {r.status || "—"}
                        </span>
                      </td>
                      <td>{fmtTime(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runs !== null && runs.length > 0 && (
            <div className="settings__runs-foot">
              <span className="settings__note" data-testid="runs-count">
                {runs.length.toLocaleString()}{" "}
                {runs.length === 1 ? "run" : "runs"} shown
                {runsHasMore ? "" : " — that is all of them"}
              </span>
              {runsHasMore && (
                <button
                  type="button"
                  className="wa-btn wa-btn--ghost"
                  data-testid="runs-load-more"
                  disabled={runsPaging}
                  onClick={() => void onLoadMoreRuns()}
                >
                  {runsPaging ? "Loading…" : `Load ${RUNS_PAGE_SIZE} more`}
                </button>
              )}
            </div>
          )}
        </section>

        <section id="settings-brain" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Brain wiki</h2>
            <button
              type="button"
              className="wa-btn wa-btn--ghost"
              data-testid="open-brain"
              onClick={() => void onOpenBrain()}
            >
              Open brain folder
            </button>
          </div>
          <p className="settings__section-desc">
            The markdown wiki SuperTwinV11 maintains about your life.
          </p>
          <div className="settings__logs-dirbox">
            <span className="settings__logs-label">Folder</span>
            <code className="settings__logs-dir">{brain?.dir ?? "—"}</code>
          </div>
          {brain && (
            <p className="settings__note settings__note--field">
              {brain.fileCount.toLocaleString()}{" "}
              {brain.fileCount === 1 ? "file" : "files"} in your brain.
            </p>
          )}
        </section>

        <section id="settings-logs" className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__section-title">Logs</h2>
            <button
              type="button"
              className="wa-btn wa-btn--ghost"
              data-testid="open-logs"
              onClick={() => void onOpenLogs()}
            >
              Open logs folder
            </button>
          </div>
          <div className="settings__logs-dirbox">
            <span className="settings__logs-label">Folder</span>
            <code className="settings__logs-dir">{logs?.dir ?? "—"}</code>
          </div>
          {logs && logs.files.length > 0 && (
            <ul className="settings__logs-files">
              {logs.files.map((f) => (
                <li key={f.name} className="settings__logs-file">
                  <span className="settings__logs-file-name">{f.name}</span>
                  <span className="settings__logs-file-meta">
                    {fmtBytes(f.size)} · {fmtTime(f.modified)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
      </div>

      {rescanConfirm && (
        <RescanConfirm
          types={rescanSel}
          onClose={() => setRescanConfirm(false)}
          onConfirm={() => void onRescan()}
        />
      )}
    </section>
  );
}

/** What one spender ran up in the window. Shared by the chat and media blocks. */
interface SpendCounts {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  billableTokens: number;
  costUsd?: number | null;
  runCount: number;
}

/**
 * The six figures that make up a bill, as a grid — in a row they read as a wall
 * of digits. Billable sits underneath as a secondary line: it is not a count of
 * anything that happened, it is the four above it re-weighted.
 */
function SpendGrid({
  prefix,
  counts,
  billableNote,
}: {
  prefix: string;
  counts: SpendCounts | null | undefined;
  billableNote: string;
}) {
  const cells: { testId: string; label: string; value: string }[] = [
    { testId: `${prefix}-input`, label: "Input", value: fmt(counts?.inputTokens) },
    {
      testId: `${prefix}-cache-write`,
      label: "Cached input",
      value: fmt(counts?.cacheCreationInputTokens),
    },
    {
      testId: `${prefix}-cache-read`,
      label: "Cache read",
      value: fmt(counts?.cacheReadInputTokens),
    },
    {
      testId: `${prefix}-output`,
      label: "Output",
      value: fmt(counts?.outputTokens),
    },
    {
      testId: `${prefix}-cost`,
      label: "Cost",
      // No counts at all is an offline dash; counts with no cost is a window
      // where nothing priced itself, which fmtCost already dashes rather than
      // calling free.
      value: counts ? fmtCost(counts.costUsd) : "—",
    },
    { testId: `${prefix}-runs`, label: "Runs", value: fmt(counts?.runCount) },
  ];
  return (
    <>
      <dl className="settings__stats settings__spend-grid">
        {cells.map((c) => (
          <div className="settings__stat" key={c.testId}>
            <dt>{c.label}</dt>
            <dd data-testid={c.testId}>{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="settings__spend-billable">
        <span data-testid={`${prefix}-billable`}>
          {fmt(counts?.billableTokens)}
        </span>{" "}
        billable — {billableNote}.
      </p>
    </>
  );
}

/**
 * One media/transcription switch with its caption. A switch whose `requires`
 * is off is left toggleable — the two can be turned on in either order — but it
 * says it is doing nothing, because a lit switch that does nothing is the one
 * thing this surface must never look like.
 */
function MediaSwitchRow({
  def,
  media,
  onToggle,
}: {
  def: MediaSwitchDef;
  media: MediaSettings | null;
  onToggle(key: MediaSwitchKey, next: boolean): void;
}) {
  const inert =
    def.requires !== undefined &&
    media !== null &&
    media[def.key] &&
    !media[def.requires.key];
  return (
    <div className="settings__media-switch">
      <label className="settings__notif">
        <Switch
          testId={def.testId}
          checked={media?.[def.key] ?? false}
          disabled={media === null}
          onChange={(next) => onToggle(def.key, next)}
          ariaLabel={def.label}
        />
        <span className="settings__notif-text">{def.label}</span>
      </label>
      {def.caption && (
        <p className="settings__note settings__note--switch">{def.caption}</p>
      )}
      {inert && def.requires && (
        <p
          className="settings__note settings__note--warn"
          data-testid={`${def.testId}-inert`}
        >
          {def.requires.note}
        </p>
      )}
    </div>
  );
}

/**
 * The two bundled binaries. Their version is read off the binaries themselves,
 * so a re-staged build reports what is actually there. Either one missing means
 * transcription cannot run at all, and saying so here is cheaper than letting
 * every recording fail with the same error.
 */
function ToolchainCard({ tools }: { tools: MediaToolState | null }) {
  const missing =
    tools !== null && (!tools.ffmpeg.present || !tools.whisper.present);
  const state = (b: { present: boolean; version: string | null }) =>
    !b.present ? "Missing" : (b.version ?? "Present");
  return (
    <>
      <dl className="settings__stats settings__toolchain">
        <div className="settings__stat">
          <dt>ffmpeg</dt>
          <dd data-testid="tool-ffmpeg">
            {tools ? state(tools.ffmpeg) : "—"}
          </dd>
        </div>
        <div className="settings__stat">
          <dt>whisper.cpp</dt>
          <dd data-testid="tool-whisper">
            {tools ? state(tools.whisper) : "—"}
          </dd>
        </div>
      </dl>
      {missing && (
        <p
          className="settings__note settings__note--warn"
          data-testid="toolchain-missing"
        >
          Part of the toolchain did not ship with this build, so nothing can be
          transcribed. Re-install the app.
        </p>
      )}
    </>
  );
}

/**
 * The encoder catalogue: four models, one of them active.
 *
 * Laid out like the transcription picker above — a radio to choose, the size
 * and state on one line, one action button — because they are the same kind of
 * choice and there is no reason for them to look like two.
 *
 * The one difference is what selecting does. A transcription model applies to
 * the NEXT recording; an encoder applies to every vector already stored, and
 * those were written in a space this one cannot read. So selecting starts a
 * rebuild rather than flipping a pointer, and the old index answers every
 * question until the new one is finished.
 */
function EmbeddingModelsCard({
  registry,
  error,
  benchmarking,
  onDownload,
  onCancelDownload,
  onDelete,
  onActivate,
  onCancelSwap,
  onBenchmark,
}: {
  registry: EmbeddingRegistry | null;
  error: string | null;
  benchmarking: string | null;
  onDownload(id: string): void;
  onCancelDownload(id: string): void;
  onDelete(id: string): void;
  onActivate(id: string): void;
  onCancelSwap(): void;
  onBenchmark(id: string): void;
}) {
  if (registry === null) return null;
  const swap = registry.swap;
  const swapping = swap?.phase === "embedding" || swap?.phase === "flipping";

  return (
    <div className="settings__models" data-testid="embedding-models-card">
      <span className="settings__logs-label">Search Model Options</span>
      <p className="settings__note">
        The one that ships with the app is the fastest and the smallest. The
        others are better at finding a message you half-remember, and cost disk
        and time to match. Switching rebuilds the index in the background on the
        new model — the old one keeps answering every question until the new one
        is finished, and then they are exchanged in a single step.
      </p>

      {swap && (
        <p
          className={`settings__note${
            swap.phase === "error" ? " settings__note--warn" : ""
          }`}
          data-testid="embedding-swap-status"
        >
          {swapping
            ? `Rebuilding the index on ${swap.toModel} — ${fmt(
                swap.embedded,
              )} of ${fmt(
                swap.total,
              )} messages. Search is still using ${swap.fromModel} and will keep doing so until this finishes.`
            : swap.phase === "done"
              ? `Switched to ${swap.toModel}: ${fmt(
                  swap.embedded,
                )} messages re-indexed.`
              : swap.phase === "cancelled"
                ? `Stopped. Nothing changed — ${swap.fromModel} is still the model in use.`
                : `Could not switch to ${swap.toModel} — ${
                    swap.error ?? "no reason given"
                  }. ${swap.fromModel} is still the model in use, unchanged.`}
          {swapping && (
            <>
              {" "}
              <button
                type="button"
                className="wa-btn wa-btn--ghost"
                data-testid="embedding-swap-cancel"
                onClick={onCancelSwap}
              >
                Stop
              </button>
            </>
          )}
        </p>
      )}

      <ul className="settings__model-list">
        {registry.models.map((m) => (
          <EmbeddingModelRowView
            key={m.id}
            model={m}
            swapping={swapping}
            benchmarking={benchmarking}
            onDownload={onDownload}
            onCancelDownload={onCancelDownload}
            onDelete={onDelete}
            onActivate={onActivate}
            onBenchmark={onBenchmark}
          />
        ))}
      </ul>

      {registry.benchmark && <BenchmarkCard result={registry.benchmark} />}

      {error && (
        <p
          className="settings__note settings__note--warn"
          data-testid="embedding-models-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One encoder. The radio mirrors the transcription rows: a model that is not on
 * disk cannot be chosen, because a selection pointing at nothing would fail
 * every search rather than one. It is also disabled mid-swap — the answer to
 * "switch again" while a rebuild is running is to wait for it, not to race it.
 */
function EmbeddingModelRowView({
  model,
  swapping,
  benchmarking,
  onDownload,
  onCancelDownload,
  onDelete,
  onActivate,
  onBenchmark,
}: {
  model: EmbeddingModelRow;
  swapping: boolean;
  benchmarking: string | null;
  onDownload(id: string): void;
  onCancelDownload(id: string): void;
  onDelete(id: string): void;
  onActivate(id: string): void;
  onBenchmark(id: string): void;
}) {
  const dl = model.download;
  const downloading = dl?.status === "downloading";
  const status = model.active
    ? `In use · ${fmt(model.indexed)} messages indexed`
    : model.bundled
      ? "Ships with the app"
      : downloading
        ? `Downloading — ${fmtBytes(dl.receivedBytes)} of ${fmtBytes(
            dl.totalBytes,
          )}`
        : dl?.status === "error"
          ? `Download failed — ${dl.error ?? "no reason given"}`
          : model.present
            ? "On this Mac"
            : "Not downloaded";

  return (
    <li
      className={`settings__model-item settings__model-item--stacked${
        model.active ? " settings__model-item--selected" : ""
      }`}
      data-testid={`embedding-model-${model.id}`}
    >
      <label className="settings__model-pick">
        <input
          type="radio"
          name="embedding-model"
          data-testid={`embedding-select-${model.id}`}
          checked={model.active}
          disabled={!model.present || swapping}
          onChange={() => onActivate(model.id)}
          aria-label={`Use ${model.label} for search by meaning`}
        />
        <span className="settings__model-name">
          {model.label}
          <span className="settings__model-tag">{model.dim}d</span>
          {model.bundled && <span className="settings__model-tag">bundled</span>}
          {model.recommended && !model.active && (
            <span className="settings__model-tag settings__model-tag--rec">
              Recommended
            </span>
          )}
        </span>
      </label>
      <span
        className="settings__model-status"
        data-testid={`embedding-model-status-${model.id}`}
      >
        {fmtBytes(model.bytes)} · {status}
      </span>
      {/* The model the user has heard of, when the runnable artifact is an
          export of it under another name. */}
      <span className="settings__note settings__note--switch">
        {model.upstream ? `${model.upstream} — ${model.note}` : model.note}
      </span>
      <span className="settings__model-actions">
        {downloading ? (
          <button
            type="button"
            className="wa-btn wa-btn--ghost"
            data-testid={`embedding-cancel-${model.id}`}
            onClick={() => onCancelDownload(model.id)}
          >
            Cancel
          </button>
        ) : !model.present ? (
          <button
            type="button"
            className="wa-btn wa-btn--ghost"
            data-testid={`embedding-download-${model.id}`}
            onClick={() => onDownload(model.id)}
          >
            Download
          </button>
        ) : model.active ? null : (
          <>
            <button
              type="button"
              className="wa-btn wa-btn--ghost"
              data-testid={`embedding-benchmark-${model.id}`}
              disabled={benchmarking !== null}
              onClick={() => onBenchmark(model.id)}
            >
              {benchmarking === model.id ? "Measuring…" : "Benchmark"}
            </button>
            {!model.bundled && (
              <button
                type="button"
                className="wa-btn wa-btn--ghost"
                data-testid={`embedding-delete-${model.id}`}
                onClick={() => onDelete(model.id)}
              >
                Delete
              </button>
            )}
          </>
        )}
      </span>
    </li>
  );
}

/**
 * What the benchmark measured, on this corpus, on this Mac.
 *
 * It reports agreement and speed and stops there. There are no labels in a
 * chat history — nobody has said which neighbour was the right one — so a card
 * that scored "quality" would be scoring its own guess and calling it a
 * measurement.
 */
function BenchmarkCard({ result }: { result: EmbeddingBenchmark }) {
  return (
    <div className="settings__benchmark" data-testid="embedding-benchmark-result">
      <span className="settings__logs-label">Measured on your messages</span>
      <p
        className="settings__benchmark-verdict"
        data-testid="embedding-benchmark-verdict"
      >
        {result.recommendation}
      </p>
      <dl className="settings__stats">
        <div className="settings__stat">
          <dt>Agreement</dt>
          <dd data-testid="embedding-benchmark-overlap">
            {Math.round(result.overlapAtK * 100)}% of the top {result.k}
          </dd>
        </div>
        <div className="settings__stat">
          <dt>In use</dt>
          <dd>{result.activeMsPerEvent.toFixed(1)} ms / message</dd>
        </div>
        <div className="settings__stat">
          <dt>Candidate</dt>
          <dd data-testid="embedding-benchmark-candidate-ms">
            {result.candidateMsPerEvent.toFixed(1)} ms / message
          </dd>
        </div>
        <div className="settings__stat">
          <dt>Sample</dt>
          <dd>
            {fmt(result.sampleSize)} messages · {fmt(result.probes)} probes
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * One whisper model: what it costs to fetch, whether it is here, and the one
 * action that applies to it. A model that is not on disk cannot be selected —
 * the radio is what enforces that, because a selection pointing at nothing
 * fails every recording rather than one.
 */
function WhisperModelRow({
  model,
  onSelect,
  onDownload,
  onCancel,
  onDelete,
}: {
  model: WhisperModelState;
  onSelect(): void;
  onDownload(): void;
  onCancel(): void;
  onDelete(): void;
}) {
  const dl = model.download;
  const downloading = dl?.status === "downloading";
  const status = downloading
    ? dl.totalBytes !== null
      ? `Downloading — ${fmtBytes(dl.receivedBytes)} of ${fmtBytes(dl.totalBytes)}`
      : `Downloading — ${fmtBytes(dl.receivedBytes)} so far`
    : dl?.status === "error"
      ? `Download failed — ${dl.error ?? "no reason given"}`
      : model.present
        ? model.bundled
          ? "Ships with the app"
          : "On this Mac"
        : "Not downloaded";

  return (
    <li
      className={`settings__model-item${
        model.selected ? " settings__model-item--selected" : ""
      }`}
      data-testid={`whisper-row-${model.id}`}
    >
      <label className="settings__model-pick">
        <input
          type="radio"
          name="whisper-model"
          data-testid={`whisper-select-${model.id}`}
          checked={model.selected}
          disabled={!model.present}
          onChange={onSelect}
          aria-label={`Use ${model.label} for transcription`}
        />
        <span className="settings__model-name">
          {model.label}
          {model.bundled && (
            <span className="settings__model-tag">bundled</span>
          )}
        </span>
      </label>
      <span className="settings__model-status" data-testid={`whisper-status-${model.id}`}>
        {fmtBytes(model.bytes)} · {status}
      </span>
      <span className="settings__model-actions">
        {downloading ? (
          <button
            type="button"
            className="wa-btn wa-btn--ghost"
            data-testid={`whisper-cancel-${model.id}`}
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : !model.present ? (
          <button
            type="button"
            className="wa-btn wa-btn--ghost"
            data-testid={`whisper-download-${model.id}`}
            onClick={onDownload}
          >
            Download
          </button>
        ) : model.bundled ? null : (
          <button
            type="button"
            className="wa-btn wa-btn--ghost"
            data-testid={`whisper-delete-${model.id}`}
            disabled={model.selected}
            title={
              model.selected
                ? "Select another model before deleting this one"
                : undefined
            }
            onClick={onDelete}
          >
            Delete
          </button>
        )}
      </span>
    </li>
  );
}

/**
 * Searching by meaning, and the three separate things that have to be true for
 * it to work: the switch is on, the encoder shipped with the app, and its
 * weights are downloaded. They are shown as three lines rather than one status
 * because only one of them is something the user can do anything about, and a
 * single "off" would hide which.
 */
function SemanticCard({
  state,
  error,
  onToggle,
  onDownload,
  onCancel,
  onDelete,
}: {
  state: SemanticState | null;
  error: string | null;
  onToggle(on: boolean): void;
  onDownload(): void;
  onCancel(): void;
  onDelete(): void;
}) {
  const dl = state?.download;
  const downloading = dl?.status === "downloading";
  // v7 §7: the encoder ships inside the app. There is then nothing to fetch and
  // nothing that may be removed — deleting out of the .app breaks its signature
  // — so the row states where it is and offers no action at all.
  const bundled = state?.bundled ?? false;
  const modelStatus = bundled
    ? "Inside the app"
    : downloading
      ? `Downloading — ${fmtBytes(dl.receivedBytes)} of ${fmtBytes(dl.totalBytes)}`
      : dl?.status === "error"
        ? `Download failed — ${dl.error ?? "no reason given"}`
        : state?.present
          ? "On this Mac"
          : "Not downloaded";

  // Ready is the one state where the index number means something; before that
  // a count of 0 would read as a failure rather than as "nothing has run yet".
  const indexing =
    state?.availability === "ready" && state.indexed < state.embeddable;

  return (
    <div className="settings__models" data-testid="semantic-card">
      <div className="settings__media-switch">
        <label className="settings__notif">
          <Switch
            testId="semantic-enabled"
            checked={state?.enabled ?? false}
            disabled={state === null}
            onChange={onToggle}
            ariaLabel="Search chats by meaning"
          />
          <span className="settings__notif-text">Search chats by meaning</span>
        </label>
        <p className="settings__note settings__note--switch">
          {bundled
            ? "The multilingual encoder it needs is already inside the app — nothing to fetch, and it works with no network at all."
            : "Needs a 129 MB multilingual encoder, downloaded below. Until that is here this stays off and nothing changes."}
        </p>
      </div>

      <ul className="settings__model-list">
        <li className="settings__model-item" data-testid="semantic-model-row">
          <span className="settings__model-name">
            {state?.model ?? "—"}
            {state && <span className="settings__model-tag">{state.dim}d</span>}
          </span>
          <span
            className="settings__model-status"
            data-testid="semantic-model-status"
          >
            {fmtBytes(state?.modelBytes)} · {modelStatus}
          </span>
          <span className="settings__model-actions">
            {state === null || bundled ? null : downloading ? (
              <button
                type="button"
                className="wa-btn wa-btn--ghost"
                data-testid="semantic-cancel"
                onClick={onCancel}
              >
                Cancel
              </button>
            ) : !state.present ? (
              <button
                type="button"
                className="wa-btn wa-btn--ghost"
                data-testid="semantic-download"
                onClick={onDownload}
              >
                Download
              </button>
            ) : (
              <button
                type="button"
                className="wa-btn wa-btn--ghost"
                data-testid="semantic-delete"
                onClick={onDelete}
              >
                Delete
              </button>
            )}
          </span>
        </li>
      </ul>

      <dl className="settings__stats settings__toolchain">
        <div className="settings__stat">
          <dt>Encoder</dt>
          <dd data-testid="semantic-runtime">
            {state === null
              ? "—"
              : state.runtimeInstalled
                ? "Ships with the app"
                : "Missing"}
          </dd>
        </div>
        <div className="settings__stat">
          <dt>Indexed</dt>
          <dd data-testid="semantic-indexed">
            {state === null
              ? "—"
              : state.availability !== "ready"
                ? "Not running"
                : `${fmt(state.indexed)} of ${fmt(state.embeddable)} messages`}
          </dd>
        </div>
      </dl>

      {state && state.availability !== "ready" && (
        // The one thing a switch cannot show by itself: on, and doing nothing.
        <p
          className={`settings__note${
            state.enabled ? " settings__note--warn" : ""
          }`}
          data-testid="semantic-reason"
        >
          {state.reason}
        </p>
      )}
      {indexing && (
        <p className="settings__note" data-testid="semantic-indexing">
          Working through your messages in the background. Search keeps working
          the whole time; it just reaches fewer of them until this finishes.
        </p>
      )}
      {state && !state.runtimeInstalled && (
        <p
          className="settings__note settings__note--warn"
          data-testid="semantic-runtime-missing"
        >
          The encoder did not ship with this build, so nothing can be indexed.
          Re-install the app.
        </p>
      )}
      {error && (
        <p
          className="settings__note settings__note--warn"
          data-testid="semantic-error"
        >
          {error}
        </p>
      )}
      {state && (
        <div className="settings__logs-dirbox">
          <span className="settings__logs-label">
            {bundled ? "Inside the app" : "Downloads"}
          </span>
          <code className="settings__logs-dir">{state.modelDir}</code>
        </div>
      )}
    </div>
  );
}

/**
 * Confirm before a re-scan. The dialog names the count it cannot know — the
 * worker only reports how many rows moved once it has moved them — so it says
 * what will happen instead of guessing a number.
 */
function RescanConfirm({
  types,
  onClose,
  onConfirm,
}: {
  types: RescanType[];
  onClose(): void;
  onConfirm(): void;
}) {
  const labels = RESCAN_TYPES.filter((t) => types.includes(t.type)).map(
    (t) => t.label,
  );
  // Each kind chosen pays in a different currency, so each says its own price:
  // tokens for media, an outbound request per link, wall clock for whisper. A
  // paragraph only appears when its kind is actually in the list.
  const readsMedia = types.some((t) => !FREE_RESCAN_TYPES.includes(t));
  const fetchesLinks = types.includes("link");
  const transcribes = types.includes("transcript");
  return (
    <div className="wa-modal" role="dialog" aria-modal="true" aria-label="Re-scan media">
      <div className="wa-modal__backdrop" onClick={onClose} />
      <div className="wa-modal__card">
        <h2 className="wa-modal__title">Re-scan {labels.join(", ")}?</h2>
        {readsMedia && (
          <p className="settings__note">
            Everything matching goes back into the queue and is sent to Claude
            again — photos several to a call, everything else one at a time —
            and it does not stop until the queue drains. Descriptions you
            already have are cleared first.
          </p>
        )}
        {fetchesLinks && (
          <p className="settings__note">
            Every link goes back into the queue and its page is fetched again.
            No model is involved, but each fetch is an outbound request the
            sender can see.
          </p>
        )}
        {transcribes && (
          <p className="settings__note">
            Recordings are transcribed again on this Mac. That spends no tokens,
            but a backlog of voice notes can run for hours.
          </p>
        )}
        <div className="wa-modal__actions">
          <button type="button" className="wa-btn wa-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="wa-btn wa-btn--primary"
            data-testid="rescan-confirm"
            onClick={onConfirm}
          >
            Re-scan
          </button>
        </div>
      </div>
    </div>
  );
}

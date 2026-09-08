// ===========================================================================
// Typed worker API client — build P1.7. One fetch wrapper, one function per
// route the minimal shell uses (P1.1 world-model reads + P1.7 review/
// corrections). Kept deliberately thin: the worker owns all logic.
// ===========================================================================

import { workerUrl } from "./config";

export interface SpaceRow {
  id: string;
  label: string;
  life_area: string | null;
  goal: string | null;
  status: string;
  horizon: string | null;
  permanence: string | null;
  cadence: string | null;
  exemplars_json: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string | null;
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  space_id: string | null;
  chapter_id: string | null;
  category: string | null;
  risk_class: string;
  owner: string | null;
  due: string | null;
  evidence_json: string | null;
  confidence: number | null;
}

export interface ClaimRow {
  id: string;
  claim_key: string;
  kind: string | null;
  text: string | null;
  confidence: number | null;
  stated_at: string;
  evidence_json?: string | null;
}

export interface DecisionView {
  id: string;
  runId: string | null;
  pass: string | null;
  action: string;
  reason: string | null;
  confidence: number | null;
  createdAt: string;
  oldJson: string | null;
  newJson: string | null;
  reversedAt: string | null;
  traceId: string | null;
}

export interface TraceRow {
  id: string;
  pass: string | null;
  model: string | null;
  prompt_version: string | null;
  caller: string | null;
  system_prompt: string | null;
  packed_context: string | null;
  raw_output: string | null;
  parsed_result: string | null;
  created_at: string;
}

export interface HomeData {
  today: TaskRow[];
  spaces: SpaceRow[];
  review: SpaceRow[];
  recent_understanding: ClaimRow[];
}

export type TargetKind = "task" | "space" | "episode" | "claim" | "stream" | "person";

export interface CorrectionResult {
  correction_id: string;
  status: "applied" | "pending";
  summary: string;
  decision_id: string | null;
}

// ---------------------------------------------------------------------------
// Failure shape (V6 P1 W3). Every read used to reject with a bare
// `Error("/api/x -> 500")`, so a caller could tell that SOMETHING went wrong
// and nothing else. The three failures a local worker actually has are not
// interchangeable — a worker that never came up is a different sentence to the
// user than a route that answered 404 — so the wrapper names which one it was
// and the UI renders the difference (components/LoadState.tsx).
// ---------------------------------------------------------------------------

/** Which of the three ways a worker read can fail. */
export type WorkerFailureKind =
  /** `fetch` itself rejected: nothing is listening, or the connection died. */
  | "unreachable"
  /** The worker answered, with a non-2xx status. */
  | "http"
  /** The worker answered 2xx with a body that is not JSON. */
  | "malformed";

export class WorkerError extends Error {
  readonly kind: WorkerFailureKind;
  readonly path: string;
  readonly status: number | null;
  constructor(kind: WorkerFailureKind, path: string, status: number | null, message: string) {
    super(message);
    this.name = "WorkerError";
    this.kind = kind;
    this.path = path;
    this.status = status;
  }
}

/** The exact words the UI uses when nothing is listening on the worker port. */
export const WORKER_UNREACHABLE = "worker unreachable";

/**
 * One honest sentence for a failed worker call. "worker unreachable" is
 * reserved for the case where it genuinely is — anything else names what
 * failed instead of blaming a process that answered.
 */
export function describeWorkerError(err: unknown): string {
  if (err instanceof WorkerError) {
    if (err.kind === "unreachable") return WORKER_UNREACHABLE;
    if (err.kind === "http") return `the worker answered ${err.status} for ${err.path}`;
    return `the worker's answer for ${err.path} wasn't readable`;
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(workerUrl(path), init);
  } catch (err) {
    throw new WorkerError(
      "unreachable",
      path,
      null,
      `${path} -> ${WORKER_UNREACHABLE}${err instanceof Error && err.message ? ` (${err.message})` : ""}`,
    );
  }
  // Message text is kept as `<path> -> <status>` so anything already reading
  // `.message` keeps reading the same thing.
  if (!res.ok) throw new WorkerError("http", path, res.status, `${path} -> ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new WorkerError("malformed", path, res.status, `${path} -> malformed response`);
  }
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const fetchHome = (): Promise<HomeData> => request("/api/home");

export interface HealthInfo {
  ok: boolean;
  version: string;
  builtThroughPhase: string;
}

export const fetchHealth = (): Promise<HealthInfo> => request("/api/health");

export const approveProposal = (id: string): Promise<{ space: SpaceRow; decision_id: string }> =>
  request(`/api/proposals/${encodeURIComponent(id)}/approve`, post());

export const rejectProposal = (id: string): Promise<{ space: SpaceRow; decision_id: string }> =>
  request(`/api/proposals/${encodeURIComponent(id)}/reject`, post());

export const fetchWhy = (kind: TargetKind, id: string): Promise<{ decisions: DecisionView[] }> =>
  request(`/api/decisions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);

export const fetchTrace = (id: string): Promise<{ trace: TraceRow }> =>
  request(`/api/trace/${encodeURIComponent(id)}`);

export const postCorrection = (req: {
  target: { kind: TargetKind; id: string };
  structured?: Record<string, unknown>;
  utterance?: string;
}): Promise<CorrectionResult> => request("/api/corrections", post(req));

export const undoCorrection = (id: string): Promise<{ undone: boolean }> =>
  request(`/api/corrections/${encodeURIComponent(id)}/undo`, post());

// ---- Task runs + approvals (P3.5, spec §14.6 / §11.4) ----------------------

export interface ExecutorResultView {
  result_type: string;
  data: Record<string, unknown>;
}

export interface EnvelopeView {
  status: "done" | "needs_input" | "needs_approval" | "partial";
  criteria: string[];
  attempts: { approach: string; outcome: string }[];
  result: ExecutorResultView | null;
  question: string | null;
  approval_request: string | null;
  gaps: string[];
  next: string | null;
}

export interface TaskRunView {
  run_id: string;
  envelope: EnvelopeView;
  invocations: { tool: string; status: string }[];
}

export interface TaskRunState {
  task: TaskRow;
  run: TaskRunView | null;
}

export const fetchTaskRun = (id: string): Promise<TaskRunState> =>
  request(`/api/tasks/${encodeURIComponent(id)}/run`);

export const executeTask = (
  id: string,
  approvalToken?: string,
): Promise<{ run_id: string; task_status: string; envelope: EnvelopeView }> =>
  request(
    `/api/tasks/${encodeURIComponent(id)}/execute`,
    post(approvalToken ? { approval_token: approvalToken } : {}),
  );

export const answerTask = (id: string, answer: string): Promise<TaskRunState> =>
  request(`/api/tasks/${encodeURIComponent(id)}/answer`, post({ answer }));

/**
 * Mint one single-use approval token — called ONLY on the Approve tap.
 *
 * V6 P1 S4.5: a SEND token must name what it approves. `bind` is the exact
 * recipient and the exact text the card displayed; the worker and the daemon
 * both refuse to send anything else with it, so a draft that changed between
 * the display and the tap is refused rather than sent unseen.
 */
export const mintApproval = (
  action: string,
  bind?: { to: string; text: string },
): Promise<{ token: string; action: string; expires_at: string }> =>
  request("/api/approvals/mint", post(bind ? { action, bind } : { action }));

/** The approved WhatsApp draft send: draft read server-side from the run. */
export const sendTaskDraft = (id: string, approvalToken: string): Promise<TaskRunState> =>
  request(`/api/tasks/${encodeURIComponent(id)}/send`, post({ approval_token: approvalToken }));

// ---- Screen source (P2.1, spec §4.2.2 / §4.3) ------------------------------

export interface ScreenStatus {
  running: boolean;
  state: string;
  paused?: boolean;
  pausedApps?: string[];
  /**
   * False while macOS Accessibility permission is missing. Since S6d this is
   * present on EVERY answer, including the one where the sidecar is not
   * running — without it the panel could not tell "blocked" from "empty".
   */
  permission?: boolean;
  /** Why, when `permission` is false: denied · binary-missing · timeout … */
  permissionReason?: string;
  permissionDetail?: string;
  /** True once the screen source has a connected consent row (gate 1). */
  consent?: boolean;
  /** ISO instant of the explicit "Record from now on" (gate 3), or null. */
  recordFrom?: string | null;
  drops?: Record<string, number>;
  snapshots?: number;
  /** Deep link into System Settings › Privacy & Security › Accessibility. */
  settingsUrl: string;
}

export const fetchScreenStatus = (): Promise<ScreenStatus> => request("/api/screen/status");

export const pauseScreen = (paused: boolean): Promise<ScreenStatus> =>
  request("/api/screen/pause", post({ paused }));

/** The Accessibility trust state. Reports; never asks. Cheap enough to poll. */
export interface ScreenPermission {
  granted: boolean;
  reason: string;
  detail?: string;
  /** True when the answer came from a run that actually asked macOS. */
  prompted?: boolean;
  settingsUrl: string;
}

export const fetchScreenPermission = (fresh = false): Promise<ScreenPermission> =>
  request(`/api/screen/permission${fresh ? "?fresh=1" : ""}`);

/**
 * ASK macOS for Accessibility (S6d/L4). This is the call that makes SuperTwin
 * appear in System Settings › Privacy & Security › Accessibility — before it,
 * the pane the deep link opens has no SuperTwin row and the permission simply
 * cannot be granted. `granted: false` with `prompted: true` is the normal
 * first answer: the row now exists, the user has yet to tick it.
 */
export const requestScreenPermission = (): Promise<ScreenPermission & { consent?: boolean }> =>
  request("/api/screen/request-permission", post({}));

/** Gate 3 — the explicit "Record from now on"; the sidecar spawns on this. */
export const startScreenRecording = (): Promise<{
  ok?: boolean;
  error?: string;
  recordFrom?: string;
  running?: boolean;
}> => request("/api/screen/record", post({}));

// ---- Freshness + Library (P2.4, spec §5.4 / §14.3.2) -----------------------

/** Worst-first; see worker/src/freshness for what each state means. */
export type FreshnessStatus =
  /** FIX-C5: the pipeline is stopped — spend latch, kill switch or breaker. */
  | "paused"
  | "catching_up"
  | "importing_history"
  | "up_to_date"
  | "no_data";

/** Why understanding is stopped (worker/src/freshness/hold.ts). */
export interface UnderstandingHold {
  kind: "kill-switch" | "budget" | "breaker";
  /** The chip's phrase — "understanding paused — spend ceiling reached". */
  label: string;
  /** One line of why, ending in what lifts it. */
  detail: string;
  since: string | null;
  /** Epoch ms it lifts on its own; null when only a human can lift it. */
  until_ms: number | null;
}

export interface SourceFreshness {
  source_id: string;
  captured_from: string | null;
  captured_to: string | null;
  /** Edges of what the twin has READ — events that carry an episode (FIX-C5). */
  understood_from: string | null;
  understood_to: string | null;
  event_count: number;
  /** Events inside the UNDERSTAND window: the denominator for progress. */
  understand_window_count?: number;
  /** Outside it: kept and searchable, never sent to a model. */
  archive_count?: number;
  understood_count: number;
  pending_count: number;
  pending_live_count: number;
  pending_backfill_count: number;
  /** Age of the oldest pending LIVE event; imported history is excluded. */
  lag_minutes: number | null;
  backfill_complete: boolean;
  understood_percent: number;
  label: string | null;
  status: FreshnessStatus;
  status_label: string;
  detail: string;
}

export interface FreshnessOverview {
  sources: SourceFreshness[];
  label: string | null;
  lag_minutes: number | null;
  status: FreshnessStatus;
  status_label: string;
  pending_live_count: number;
  pending_backfill_count: number;
  /** Null while understanding is running; otherwise why it is stopped. */
  hold?: UnderstandingHold | null;
}

export const fetchFreshness = (): Promise<FreshnessOverview> => request("/api/freshness");

// ---- Per-source status (V6 P1 S6d L6; Product_V6 §7.2) ---------------------
//
// The Library shows status PER SOURCE, inside that sub-tab's own panel. The
// cross-source overview above is a SUM — it prints a range no single source
// has and a backlog no single source carries — so a panel never reads it.

/** `not_connected` = no consent row at all; the rest are the row's own state. */
export type SourceConnectionState =
  | "connected"
  | "paused"
  | "disconnected"
  | "revoked"
  | "not_connected";

export interface SourceWindows {
  index_all: boolean;
  index_from: string | null;
  understand_from: string | null;
}

export interface SourceStatusView {
  source_id: string;
  connection: { state: SourceConnectionState; capturing: boolean; granted_at: string | null };
  windows: SourceWindows | null;
  /** The windows as one phrase — "index everything · understand from 7 Aug 2026". */
  window_label: string;
  coverage: {
    captured_from: string | null;
    captured_to: string | null;
    understood_from: string | null;
    understood_to: string | null;
    /** THIS source's own "Knows you: X → Y". */
    label: string | null;
  };
  progress: {
    status: FreshnessStatus;
    status_label: string;
    detail: string;
    /** The denominator of "X of N understood": events inside the window. */
    event_count: number;
    /** Everything the log holds for this source, archive rows included. */
    captured_count?: number;
    /** Events that carry an episode — what the twin has actually read. */
    understood_count: number;
    understood_percent: number;
    pending_live_count: number;
    /** THIS source's own backlog — never a sum. */
    pending_backfill_count: number;
    backfill_complete: boolean;
    lag_minutes: number | null;
  };
}

export const fetchSourceStatusView = (source: string): Promise<SourceStatusView> =>
  request(`/api/library/source-status?source=${encodeURIComponent(source)}`);

export interface ChatStreamRow {
  id: string;
  label: string | null;
  external_key: string;
  stream_kind: string | null;
  tier: string | null;
  category: string | null;
  capture_paused: number;
  knows_from: string | null;
  last_ts: string | null;
  today_count: number;
  event_count: number;
  /** Newest message preview for the conversation list (may be absent). */
  last_text?: string | null;
  last_kind?: string | null;
  last_from_me?: number | null;
}

export interface LibraryChats {
  source_id?: string;
  streams: ChatStreamRow[];
  event_count?: number;
}

export const fetchLibraryChats = (source?: string): Promise<LibraryChats> =>
  request(`/api/library/chats${source ? `?source=${encodeURIComponent(source)}` : ""}`);

export interface BrowserChainVisit {
  ts: string;
  url: string;
  title: string | null;
  dwell_ms: number;
}

export interface LibraryBrowser {
  domains_today: { domain: string; visits: number }[];
  chains: {
    stream_key: string;
    started_at: string;
    ended_at: string;
    visits: BrowserChainVisit[];
    space_label: string | null;
  }[];
  bookmarks: { ts: string; url: string; title: string | null; folder: string | null }[];
  /** Total browser events ever captured — 0 means "not connected yet". */
  event_count?: number;
}

export const fetchLibraryBrowser = (): Promise<LibraryBrowser> => request("/api/library/browser");

// ---- Browser SOURCE connect (V6 P1 S1.4) — /api/sources/browser/* ------------

export interface BrowserWindowCount {
  visits: number;
  bookmarks: number;
}

export interface BrowserProfileCounts {
  browser: "chrome" | "brave" | "arc" | "edge" | "comet" | "safari";
  browser_name: string;
  profile: string;
  label: string | null;
  history_path: string;
  bookmarks_path: string | null;
  readable: boolean;
  error: { code: "full-disk-access" | "locked" | "missing" | "unreadable"; message: string; settings_url?: string } | null;
  windows: Record<string, BrowserWindowCount>;
  total_visits: number;
  total_bookmarks: number;
  oldest_visit_ts: string | null;
  newest_visit_ts: string | null;
  plateau_window: string | null;
  retention_note: string | null;
}

export interface BrowserConsentView {
  id: string;
  state: "connected" | "paused" | "disconnected" | "revoked";
  granted_at: string;
  index_all: boolean;
  index_from: string | null;
  understand_from: string | null;
  profiles: string[];
  /** Visits the connect card measured per chosen profile, keyed by history path. */
  counts?: Record<string, number>;
  /** The card text stored verbatim at connect, when there is one. */
  card_text?: string | null;
}

export interface BrowserDiscovery {
  now: string;
  windows: string[];
  profiles: BrowserProfileCounts[];
  totals: Record<string, BrowserWindowCount>;
  needs_full_disk_access: boolean;
  full_disk_access_settings_url: string;
  disclosure: { scratch_dir: string; text: string };
  connected: boolean;
  consent: BrowserConsentView | null;
}

export interface BrowserSourceStatus {
  source: "browser";
  connected: boolean;
  running: boolean;
  consent: BrowserConsentView | null;
  event_count: number;
}

export interface BrowserConnectRequest {
  index_all?: boolean;
  index_from?: string | null;
  /** ISO floor; omit for the 30-day default; `null` sends nothing to the model yet. */
  understand_from?: string | null;
  /** History paths to import; empty = every profile found. */
  profiles?: string[];
  /** Visits the card measured per chosen profile, keyed by history path (S6d L5). */
  counts?: Record<string, number>;
  /** The card's own words, stored verbatim with the consent row. */
  card_text?: string;
}

/** One profile's place in the history import (worker adapters/browser/progress.ts). */
export interface BrowserProfileImport {
  history_path: string;
  browser: string;
  browser_name: string;
  profile: string;
  label: string | null;
  state: "pending" | "reading" | "done" | "failed";
  visits_read: number;
  events_written: number;
  expected_visits: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface BrowserImportProgress {
  /** False when no watcher has reported in this worker process. */
  known: boolean;
  reading: boolean;
  first_pass_done: boolean;
  profiles: BrowserProfileImport[];
  visits_read: number;
  events_written: number;
  expected_visits: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface BrowserImportView {
  source: "browser";
  connected: boolean;
  running: boolean;
  progress: BrowserImportProgress;
}

export interface BrowserConnectResult {
  ok: boolean;
  consent: BrowserConsentView | null;
  started: boolean;
  running: boolean;
  progress?: BrowserImportProgress;
}

export const fetchBrowserDiscovery = (): Promise<BrowserDiscovery> => request("/api/sources/browser/discover");
export const fetchBrowserSourceStatus = (): Promise<BrowserSourceStatus> => request("/api/sources/browser/status");
/** The cheap live read: the watcher's ledger, no aggregate over the event log. */
export const fetchBrowserImport = (): Promise<BrowserImportView> => request("/api/sources/browser/import");
export const connectBrowserSource = (body: BrowserConnectRequest = {}): Promise<BrowserConnectResult> =>
  request("/api/sources/browser/connect", post(body));

export interface ScreenSessionCard {
  stream_key: string;
  app: string;
  bundle_id?: string;
  doc?: string | null;
  started_at: string;
  ended_at: string;
  minutes: number;
  event_count: number;
}

export interface ScreenDocGroup {
  doc: string | null;
  minutes: number;
  event_count: number;
  sessions: ScreenSessionCard[];
}

export interface ScreenAppGroup {
  bundle_id: string;
  app: string;
  minutes: number;
  event_count: number;
  session_count: number;
  docs: ScreenDocGroup[];
}

export interface LibraryScreen {
  day: string;
  hours: number[];
  sessions: ScreenSessionCard[];
  /** Sessions rolled up by app (bundle id), then by document. */
  apps?: ScreenAppGroup[];
  paused: boolean;
  /** Total screen captures ever — 0 means "nothing captured yet". */
  event_count?: number;
}

export const fetchLibraryScreen = (day?: string): Promise<LibraryScreen> =>
  request(`/api/library/screen${day ? `?day=${encodeURIComponent(day)}` : ""}`);

export const pauseStream = (
  streamId: string,
  paused: boolean,
): Promise<{ stream_id: string; paused: boolean; decision_id: string | null }> =>
  request(`/api/library/streams/${encodeURIComponent(streamId)}/pause`, post({ paused }));

export interface CascadeReport {
  events_deleted: number;
  episodes_deleted: number;
  claim_versions_deleted: number;
  claims_deleted: number;
  tasks_deleted: number;
  decision_id: string | null;
}

export const deleteScreenSpan = (req: {
  start_ts: string;
  end_ts: string;
  stream_key?: string;
}): Promise<{ report: CascadeReport }> => request("/api/library/screen/delete", post(req));

// ---- Source connect + chat inbox (Library subtabs, spec §14.3.2) -----------

/** Import-range enum the source adapters accept (worker adapters/types.ts). */
export const IMPORT_RANGES = [
  "24h",
  "3d",
  "7d",
  "30d",
  "90d",
  "180d",
  "1y",
  "2y",
  "3y",
  "4y",
  "5y",
  "all",
] as const;

export type ImportRange = (typeof IMPORT_RANGES)[number];

export const RANGE_LABELS: Record<ImportRange, string> = {
  "24h": "last 24 hours",
  "3d": "last 3 days",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 3 months",
  "180d": "last 6 months",
  "1y": "last year",
  "2y": "last 2 years",
  "3y": "last 3 years",
  "4y": "last 4 years",
  "5y": "last 5 years",
  all: "everything WhatsApp will give",
};

export type SourceState =
  | "starting"
  | "need_pairing"
  | "pairing"
  | "connected"
  | "syncing"
  | "online"
  | "reconnecting"
  | "logged_out"
  | "error";

export interface SourceStatus {
  state: SourceState;
  paired: boolean;
  paused: boolean;
  pushName?: string;
  importDone?: boolean;
  importRange?: string;
  progress?: { chatsDone?: number; chatsTotal?: number; messages?: number; done?: boolean };
  lastError?: { code: string; message: string } | null;
}

export const fetchSourceStatus = (source: string): Promise<SourceStatus> =>
  request(`/api/sources/${encodeURIComponent(source)}/status`);

export const pairSource = (source: string): Promise<{ ok: boolean }> =>
  request(`/api/sources/${encodeURIComponent(source)}/pair`, post({}));

export const importSource = (source: string, range: ImportRange): Promise<{ ok: boolean }> =>
  request(`/api/sources/${encodeURIComponent(source)}/import`, post({ range }));

export const extendSource = (source: string, range: ImportRange): Promise<{ ok: boolean }> =>
  request(`/api/sources/${encodeURIComponent(source)}/extend`, post({ range }));

export const pauseSource = (source: string, paused: boolean): Promise<{ ok: boolean }> =>
  request(`/api/sources/${encodeURIComponent(source)}/pause`, post({ paused }));

// ---- Connect flow: measured counts → windows → confirm (V6 S1.5) ----------

/** What one window would import, measured by the daemon over what it holds. */
export interface WindowRow {
  range: ImportRange;
  chats: number;
  messages: number;
  /** Days the window spans (for `all`: the span of history actually received). */
  days: number;
  /** measured = bulk history arrived · so-far = bootstrap only, will rise · none = nothing yet */
  accuracy: "measured" | "so-far" | "none";
}

export interface SourceCounts {
  counts: {
    counts: Record<ImportRange, { chats: number; messages: number }>;
    chats: number;
    messages: number;
    oldestTs?: string;
    newestTs?: string;
    bufferedBatches: number;
    batches: number;
    syncTypes: string[];
    rangeInstalled: boolean;
    range?: ImportRange;
    pendingLive: number;
  };
  windows: WindowRow[];
  /** The honest lines under the numbers — facts from the daemon, never guesses. */
  caveats: string[];
}

/** `GET /api/sources/:id/counts` — read-only; installs no window, ingests nothing. */
export const fetchSourceCounts = (source: string): Promise<SourceCounts> =>
  request(`/api/sources/${encodeURIComponent(source)}/counts`);

export interface ConfirmSourceRequest {
  /** INDEX window — kept and searchable. */
  index: ImportRange;
  /** UNDERSTAND window — read by the model; null = nothing goes to the model. */
  understand: ImportRange | null;
  /** The card's text, stored verbatim in `decisions` (T4-10 / CNS-09). */
  card_text: string;
  counts?: SourceCounts["counts"];
}

export interface ConfirmSourceResponse {
  ok: boolean;
  consent: { id: string; source: string; state: string; indexAll: boolean; indexFrom: string | null; understandFrom: string | null; decisionId: string | null };
  decision_id: string;
}

/** `POST /api/sources/:id/confirm` — the yes: decision + consent, then the import starts. */
export const confirmSource = (source: string, req: ConfirmSourceRequest): Promise<ConfirmSourceResponse> =>
  request(`/api/sources/${encodeURIComponent(source)}/confirm`, post(req));

/** One message row of the chat pane (`/api/inbox/chats/:id/messages`). */
export interface InboxMessageRow {
  id: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  fromMe: boolean;
  actorName: string | null;
  mediaUrl?: string;
  mediaDescription?: string | null;
  transcript?: string | null;
  revokedAt?: string | null;
}

export const fetchChatMessages = (
  streamId: string,
  before?: string,
): Promise<InboxMessageRow[]> =>
  request(
    `/api/inbox/chats/${encodeURIComponent(streamId)}/messages${
      before ? `?before=${encodeURIComponent(before)}` : ""
    }`,
  );

export interface BrowserStatus {
  available: boolean;
  running: boolean;
  killSwitch: boolean;
  profileDir?: string;
  sessions?: { service: string; ok: boolean }[];
}

export const fetchBrowserStatus = (): Promise<BrowserStatus> => request("/api/browser/status");

/** Chromium's own "import from Chrome" UI — history, bookmarks, passwords. */
export const browserImportChrome = (): Promise<{ ok: boolean }> =>
  request("/api/browser/import-chrome", post({}));

// ---- Assist artifacts + nudges (P2.2/P2.3, spec §10.5 / §14.7) -------------

export type ArtifactStatus = "new" | "seen" | "dismissed" | "graduated" | "expired";

export interface ArtifactRow {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  bodyJson: string | null;
  intent: string | null;
  reasoning: string | null;
  spaceId: string | null;
  taskId: string | null;
  topicKey: string | null;
  producer: "assist" | "executor";
  status: ArtifactStatus;
  nudgedAt: string | null;
  seenAt: string | null;
  dismissedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface NeedsYouRow {
  id: string;
  title: string;
  space_id: string | null;
  risk_class?: string;
}

export interface TodayRow {
  id: string;
  title: string;
  due: string | null;
}

/** Everything the §14.7 menu-bar panel renders, in one read. */
export interface PanelData {
  needs_you: { approvals: NeedsYouRow[]; questions: NeedsYouRow[] };
  prepared: ArtifactRow[];
  older: ArtifactRow[];
  nudge: ArtifactRow | null;
  today: TodayRow[];
  capture_paused_until: string | null;
  /** Cards shown but not opened (V6 P1 S4.3). Absent on an older worker. */
  unread?: number;
}

export const fetchPanel = (): Promise<PanelData> => request("/api/assist/panel");

export const fetchNudge = (): Promise<{ artifact: ArtifactRow | null }> =>
  request("/api/assist/nudge");

export const fetchArtifacts = (status?: ArtifactStatus): Promise<{ artifacts: ArtifactRow[] }> =>
  request(`/api/artifacts${status ? `?status=${status}` : ""}`);

export const artifactSeen = (id: string): Promise<{ artifact: ArtifactRow }> =>
  request(`/api/artifacts/${encodeURIComponent(id)}/seen`, post());

export const artifactDismiss = (id: string): Promise<{ artifact: ArtifactRow }> =>
  request(`/api/artifacts/${encodeURIComponent(id)}/dismiss`, post());

export const artifactReopen = (id: string): Promise<{ artifact: ArtifactRow }> =>
  request(`/api/artifacts/${encodeURIComponent(id)}/reopen`, post());

export const artifactGraduate = (
  id: string,
): Promise<{ result: { status: string; taskId?: string }; artifact: ArtifactRow }> =>
  request(`/api/artifacts/${encodeURIComponent(id)}/graduate`, post());

export const artifactSignal = (id: string, signal: string): Promise<{ weight: number }> =>
  request(`/api/artifacts/${encodeURIComponent(id)}/signal`, post({ signal }));

export const pauseCapture = (minutes: number | null): Promise<{ capture_paused_until: string | null }> =>
  request("/api/assist/pause", post(minutes == null ? { until: null } : { minutes }));

// ---- The surface router (V6 P1 S4.3, Product_V6_Phase1 §18) ---------------
//
// `surface-router.v1` decides WHERE a finished artifact goes and in what
// order, never whether. The nudge window polls one path for the one card,
// the unread counter and the routed plan.

export type NudgeSurface = "card" | "panel" | "shelf" | "space" | "timeline" | "understanding";

export interface RoutedItemView {
  id: string;
  kind: string;
  spaceId: string | null;
  surfaces: NudgeSurface[];
  rank: number;
  mergedWith: string[];
  reason: string;
  blocked: boolean;
  housekeeping: boolean;
}

/** The one card: intent line · what I did · artifact peek. */
export interface NudgeCardView {
  id: string;
  kind: string;
  title: string;
  /** One line per merged item, joined by " · ". */
  line: string;
  peek: string | null;
  intent: string;
  spaceId: string | null;
  mergedWith: string[];
  autoCloseAtMs: number;
}

export interface NudgeView {
  presence: "mac_active" | "away";
  card: NudgeCardView | null;
  unread: number;
  /** 60 s by default; Settings › Assist › card duration. */
  cardDurationMs: number;
  routed: RoutedItemView[];
}

export const fetchSurfaceNudge = (): Promise<NudgeView> => request("/api/surfaces/nudge");

const nudgeVerb = (id: string, verb: string): Promise<{ unread: number; dismissals?: number }> =>
  request(`/api/surfaces/nudge/${encodeURIComponent(id)}/${verb}`, post());

/** The card went up — it counts as unread from this moment. */
export const nudgeShown = (id: string): Promise<{ unread: number }> => nudgeVerb(id, "shown");
/** Open — the dot clears everywhere. */
export const nudgeOpened = (id: string): Promise<{ unread: number }> => nudgeVerb(id, "opened");
/** Not now — ranks that kind down; the work stays in Prepared. */
export const nudgeNotNow = (id: string): Promise<{ unread: number; dismissals?: number }> => nudgeVerb(id, "not-now");
/** The 60-second close (or the ✕). Nothing is lost. */
export const nudgeAutoClose = (id: string): Promise<{ unread: number }> => nudgeVerb(id, "auto-close");

// ---- People + circles (P4.2, spec §7.3 / §14.6) ----------------------------

/** The nine relationship circles (spec §7.3.2) — mirror of the worker's list. */
export const CIRCLES = [
  "partner",
  "family",
  "close_friends",
  "friends",
  "coworkers",
  "important_services",
  "old_batchmates",
  "acquaintances",
  "businesses",
] as const;

export type Circle = (typeof CIRCLES)[number];

/** One row of the worker's `people` view (entities, merge-resolved). */
export interface PersonRow {
  id: string;
  name: string | null;
  subtype: string | null;
  circle: Circle | null;
  provisional: number;
  user_pinned: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface MergeQuestion {
  id: string;
  question: string;
}

export const fetchPeople = (): Promise<{ people: PersonRow[]; open_questions: MergeQuestion[] }> =>
  request("/api/people");

// ---- Identity gestures: merge / split by drag, undo always (V6 P1 S5.4) ----

/** One tombstone merged into a person — the chip a split drags back out. */
export interface AliasChip {
  id: string;
  name: string | null;
}

export interface DragResult {
  ok: boolean;
  action: "merge" | "split";
  summary: string;
  /** Hand this back to `undoPeopleDrag` — the inverse gesture. */
  undoId: string | null;
  winner: string | null;
  loser: string | null;
  refused?: string;
}

export const fetchPersonAliases = (): Promise<{ aliases: Record<string, AliasChip[]> }> =>
  request("/api/people/aliases");

export const mergePeople = (loser: string, winner: string): Promise<DragResult> =>
  request("/api/people/merge", post({ loser, winner }));

export const splitPerson = (entityId: string): Promise<DragResult> =>
  request("/api/people/split", post({ entity_id: entityId }));

export const undoPeopleDrag = (mutationId: string): Promise<{ ok: boolean; summary: string }> =>
  request("/api/people/undo", post({ mutation_id: mutationId }));

// ---- "Who I am" and the follow-up radar (V6 P1 S5.4 → R2 surfaces) ---------

/**
 * One line of the "Who I am" card. Product_V6 §8.3.2: built by PROCESSING,
 * never by a form — so every line carries the claim it reads from, its
 * evidence and its confidence, and "edit" means a correction on that claim.
 */
export interface WhoIAmLine {
  text: string;
  confidence: number | null;
  evidence: { event_ids: string[]; quote: string }[];
  /** The claim a correction targets; null for a line derived from circles/tone. */
  claimKey: string | null;
  kind: string | null;
  statedAt: string | null;
  source: "processing" | "circles" | "tone";
  editable: boolean;
}

export interface WhoIAmCardView {
  selfId: string;
  filledBy: "processing";
  basics: WhoIAmLine[];
  life: WhoIAmLine[];
  narrative: WhoIAmLine[];
  traits: WhoIAmLine[];
  voice: WhoIAmLine[];
  people: Record<string, { id: string; name: string | null }[]>;
  counts: { claims: number; people: number };
  empty: boolean;
  /** Printed while nothing has landed — "there is no form". */
  emptyNote: string | null;
}

export const fetchWhoIAm = (): Promise<WhoIAmCardView> => request("/api/people/who-i-am");

/** Who owes a reply, and who the user owes (Product_V6 §11.8.3, CRM-01/02). */
export interface RadarEntryView {
  personId: string | null;
  personName: string | null;
  circle: Circle | null;
  direction: "i_owe" | "they_owe";
  streamKey: string;
  streamId: string | null;
  isGroup: boolean;
  askedAt: string;
  askText: string;
  eventId: string;
  /** The circle default, or what this person learned. */
  leadDays: number;
  /** askedAt + leadDays — when the twin starts acting. */
  followUpAt: string;
  ageDays: number;
  overdue: boolean;
}

export const fetchRadar = (opts: { person?: string; now?: string } = {}): Promise<{ radar: RadarEntryView[] }> => {
  const q = new URLSearchParams();
  if (opts.person) q.set("person", opts.person);
  if (opts.now) q.set("now", opts.now);
  const qs = q.toString();
  return request(`/api/people/radar${qs ? `?${qs}` : ""}`);
};

/** Learn a lead time for one person; null falls back to the circle default. */
export const setRadarLead = (
  personId: string,
  days: number | null,
): Promise<{ person: string; radar_lead_days: number | null }> =>
  request(`/api/people/${encodeURIComponent(personId)}/radar-lead`, post({ days }));

/** One claim version as the worker's claims store serializes it. */
export interface ClaimVersionView {
  id: string;
  claimKey: string;
  kind: string | null;
  text: string | null;
  confidence: number | null;
  statedAt: string;
  validFrom: string | null;
  validTo: string | null;
  closedBy?: string | null;
  closedReason?: string | null;
  evidence?: { quote: string; event_ids: string[] }[];
}

export interface EdgeView {
  id: string;
  kind: string;
  subtype: string | null;
  srcEntityId: string;
  dstEntityId: string;
  status: string;
}

export interface PersonDetail {
  subject: string;
  circle: Circle | null;
  claims: ClaimVersionView[];
  edges: EdgeView[];
}

export const fetchPersonDetail = (id: string): Promise<PersonDetail> =>
  request(`/api/people/${encodeURIComponent(id)}/claims`);

export const fetchClaimHistory = (
  key: string,
): Promise<{ claim_key: string; active: ClaimVersionView | null; history: ClaimVersionView[] }> =>
  request(`/api/claims/${encodeURIComponent(key)}`);

export interface ToneProfileView {
  register: string | null;
  languageMix: string | null;
  emojiHabits: string | null;
  notes: string | null;
}

export const fetchTone = (personId: string): Promise<{ profile: ToneProfileView | null }> =>
  request(`/api/tone?person=${encodeURIComponent(personId)}`);

// ---- Timeline + grounded bar (P4.1, spec §14.3.1 / §14.8) ------------------

/** One rendered Timeline row — micro-events grouped by the worker. */
export interface TimelineRowView {
  id: string;
  ts: string;
  end_ts: string;
  source: string;
  kind: string | null;
  actor: string | null;
  chat: string | null;
  text: string;
  count: number;
  event_ids: string[];
  space_id: string | null;
  space_label: string | null;
}

export interface TimelinePageView {
  rows: TimelineRowView[];
  next_before: string | null;
}

export const fetchTimeline = (params?: {
  before?: string;
  source?: string;
  person?: string;
  space?: string;
  q?: string;
}): Promise<TimelinePageView> => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v) search.set(k, v);
  }
  const qs = search.toString();
  return request(`/api/timeline${qs ? `?${qs}` : ""}`);
};

export const fetchTimelineDays = (): Promise<{
  days: { day: string; count: number }[];
  sources: string[];
}> => request("/api/timeline/days");

export interface BarSearchView {
  events: { id: string; ts: string | null; actor: string | null; chat: string | null; snippet: string }[];
  spaces: { id: string; label: string }[];
}

export const barSearch = (q: string): Promise<BarSearchView> =>
  request(`/api/bar/search?q=${encodeURIComponent(q)}`);

/**
 * T0 type-ahead (S2.7, Product_V6 §22 rule 1): what the twin already holds
 * for a partial query — events, episodes, spaces (as `Space › Chapter`
 * paths), tasks, people, claims — local, no model, under 150 ms. A superset
 * of BarSearchView so the bar renders either.
 */
export interface TypeaheadView extends BarSearchView {
  query?: string;
  tokens?: string[];
  /** Worker-measured wall clock of the lookup. */
  took_ms?: number;
  /** Always 0. */
  model_calls?: number;
  events: {
    id: string;
    ts: string | null;
    actor: string | null;
    chat: string | null;
    snippet: string;
    /** Layer-1 archive row — how an archive-only hit is cited (RET-04). */
    archive_id?: string | null;
    /** Kept and searchable, never sent to the model; carries no episode. */
    searchable_only?: boolean;
    episode_id?: string | null;
  }[];
  spaces: { id: string; label: string; chapter_id?: string | null }[];
  episodes?: {
    id: string;
    summary: string;
    space_id: string | null;
    chapter_id: string | null;
    state: string;
    last_ts: string | null;
  }[];
  tasks?: { id: string; title: string; status: string; space_id: string | null }[];
  people?: { id: string; name: string }[];
  claims?: { claim_key: string; text: string; kind: string | null; subject_id: string | null }[];
}

export const barTypeahead = (q: string, limit?: number): Promise<TypeaheadView> =>
  request(`/api/bar/typeahead?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`);

export interface BarCitationView {
  n: number;
  kind: "event";
  id: string;
  label: string;
}

/**
 * The seven question classes route.v1 decides between (Product_V6_Phase1 §19.3).
 * `general` is the one answered without the record, and it is labelled as such.
 */
export type BarClass =
  | "lookup"
  | "aggregate"
  | "temporal"
  | "relational"
  | "multihop"
  | "absence"
  | "general"
  | "action"
  | "correction"
  | "search";

/** The coverage caveat: what the twin does NOT have over the asked range. */
export interface BarCaveatView {
  source: string;
  kind: string;
  /** One sentence, ready to print — "I only have WhatsApp back to Jan 2024". */
  text: string;
  floor: string | null;
  gap?: { from: string; to: string; note: string | null };
}

export interface BarAnswerView {
  answer: string;
  citations: BarCitationView[];
  grounded: boolean;
  refused_uncited: boolean;
  // ---- S5.5 fields the overlay renders (Product_V6_Phase1 §19.4/§19.5) ----
  /** The class the answer was served under. */
  class?: BarClass;
  /** Which of the five methods the answer rests on (BAR-04: "structured"). */
  method?: string;
  /** Aggregates: the exact value, never counted off the top-k. */
  value?: number | null;
  by_currency?: { currency: string | null; value: number; rows: number }[];
  /** Sufficiency, decided in code per class — not by the model. */
  partial?: boolean;
  /** What is missing, named. */
  gaps?: string[];
  coverage_caveat?: BarCaveatView | null;
  /** A general answer: "not from your data". */
  not_from_your_data?: boolean;
  results?: { id: string; kind: string; quote: string; why: string }[];
  scanned?: number;
  methods_ran?: string[];
}

/** A quick chip on the locked object (Product_V6_Phase1 §21). */
export interface BarChipView {
  label: string;
  structured: Record<string, unknown>;
}

/** What the thread locked to — what the bar just made, or what was open. */
export interface BarLockView {
  kind: TargetKind;
  id: string;
  label: string;
}

export interface BarActionView {
  status: "done" | "needs_input" | "failed";
  summary: string;
  question?: string;
  options?: { id: string; label: string }[];
  pending?: Record<string, unknown>;
  space_id?: string;
  task_id?: string;
  progress: string[];
}

export interface BarResponse {
  intent: "search" | "question" | "action" | "correction";
  thread_id: string;
  search?: BarSearchView;
  answer?: BarAnswerView;
  action?: BarActionView;
  summary?: string;
  /** S5.5: the class, the thread's lock and the chips that ride with it. */
  class?: BarClass;
  lock?: BarLockView | null;
  chips?: BarChipView[];
  model_calls?: number;
}

export const postBar = (req: {
  text?: string;
  thread_id?: string;
  answer?: { pending: Record<string, unknown>; space_id: string };
}): Promise<BarResponse> => request("/api/bar", post(req));

export interface BarThreadSummaryView {
  thread_id: string;
  title: string;
  last_ts: string;
  message_count: number;
}

export const fetchBarThreads = (): Promise<{ threads: BarThreadSummaryView[] }> =>
  request("/api/bar/threads");

export interface BarMessageView {
  event_id: string;
  thread_id: string;
  role: "user" | "twin";
  text: string;
  ts: string;
  intent: string | null;
  meta: Record<string, unknown> | null;
}

export const fetchBarThread = (id: string): Promise<{ thread_id: string; messages: BarMessageView[] }> =>
  request(`/api/bar/threads/${encodeURIComponent(id)}`);

// ---- Settings (P4.3, spec §14.9) -------------------------------------------

export interface GeneralSettings {
  hotkey_summon: string;
  hotkey_bar: string;
  launch_at_login: boolean;
  notifications_enabled: boolean;
  brief_times: string[];
  appearance: string;
  graduation_mode: "propose" | "auto";
}

export const fetchSettingsGeneral = (): Promise<GeneralSettings> =>
  request("/api/settings/general");
export const saveSettingsGeneral = (
  patch: Partial<GeneralSettings>,
): Promise<GeneralSettings> => request("/api/settings/general", post(patch));

export interface CaptureSettings {
  sources: Record<string, { paused: boolean }>;
  app_blocklist: string[];
  domain_blocklist: string[];
  /** V6 S1.7: the two lists the funnel enforces beside apps and sites. */
  chat_blocklist?: string[];
  sender_blocklist?: string[];
  pagetext_rules: string[];
  incognito: string;
}

export const fetchSettingsCapture = (): Promise<CaptureSettings> =>
  request("/api/settings/capture");
export const saveSettingsCapture = (
  patch: Partial<CaptureSettings>,
): Promise<CaptureSettings> => request("/api/settings/capture", post(patch));

export interface SourceStatusRow {
  source: string;
  streams: number;
  paused_streams: number;
  paused: boolean;
  import_done: boolean;
  last_event_at: string | null;
}

export const fetchSettingsSources = (): Promise<{ sources: SourceStatusRow[] }> =>
  request("/api/settings/sources");

// ---- Provider-aware intelligence settings (ChatGPT V2 §9.3 / P3-A) --------

/** The complete, closed provider set shipped by SuperTwin. */
export type ProviderId = "claude-local" | "chatgpt-oauth";
export type IntelligenceProviderId = ProviderId;

export type ProviderAuthStatus =
  | "ready"
  | "signed_out"
  | "expired"
  | "unavailable"
  | "degraded";

export interface IntelligenceProviderOption {
  id: IntelligenceProviderId;
  label: string;
  auth_state: ProviderAuthStatus;
}

export interface IntelligenceProviderSelection {
  selected: IntelligenceProviderId;
  options: IntelligenceProviderOption[];
}

export interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  hidden: boolean;
  inputModalities: Array<"text" | "image">;
  reasoningValues: string[];
  defaultReasoning: string | null;
  supportsTools: boolean;
  supportsHostTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsStructuredOutput: boolean;
  supportsStrictTools: boolean;
  supportsVerbosity: boolean;
  supportsPromptCacheKey: boolean;
  supportsPromptCacheOptions: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  billingLabel: string | null;
}

/** Frontend mirror of the provider-neutral worker catalogue. */
export interface ProviderModelCatalogue {
  providerId: ProviderId;
  mode: "discovered" | "cached" | "fallback";
  source: string;
  discoveredAt: string;
  revision: string;
  error: string | null;
  models: ProviderModel[];
}

/** Stable provider errors exposed by §7.1; never a raw upstream error. */
export type ProviderApiErrorCode =
  | "TIMEOUT"
  | "SPAWN_FAILED"
  | "CLI_ERROR"
  | "POISONED_SESSION"
  | "CANCELLED"
  | "QUOTA_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "MODEL_ACTIVITY_PAUSED"
  | "MAX_TURNS"
  | "BAD_REQUEST"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_UNAVAILABLE"
  | "CAPABILITY_UNSUPPORTED"
  | "BACKEND_UNSUPPORTED"
  | "RATE_LIMITED"
  | "TRANSPORT_ERROR";

export interface ProviderApiError {
  code: ProviderApiErrorCode;
  message: string;
}

export interface IntelligenceStepRow {
  key: string;
  /** Provider-aware fields from §9.3. */
  selected_model: string;
  recommended_model: string | null;
  reasoning: string | null;
  reasoning_values: string[];
  available: boolean;
  /** Legacy presentation aliases retained for the current shell migration. */
  label: string;
  group: string;
  recommended: string;
  selected: string;
  enabled: boolean;
  cost_7d_usd: number;
  calls_7d: number;
  /** The step's reasoning level, "off" unless someone raised it. */
  thinking?: string;
  /** What the SELECTED model offers. Empty = it has no reasoning dial. */
  thinking_levels?: string[];
  /** Golden categories a change to this step re-runs; null = the whole set (S5.6). */
  eval_categories?: string[] | null;
  /** A candidate for THIS step waiting on the golden set right now. */
  pending?: { model?: string; thinking?: string } | null;
}

/** One model the local `claude` can actually reach (worker discovery). */
export interface ModelOptionRow {
  id: string;
  label: string;
  family: string;
  alias: boolean;
  resolves_to: string | null;
  /** USD per million tokens. Null when the catalogue does not price it. */
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  thinking_levels: string[];
  default_thinking: string | null;
  effort: boolean;
  context_window: number | null;
}

export interface IntelligenceSettings {
  provider: IntelligenceProviderSelection;
  catalogue: ProviderModelCatalogue;
  /** Legacy Claude-shaped fields retained for one shell migration release. */
  default_model: string;
  default_thinking?: string;
  /** The 13.4.1 three-string list; kept only so an older shell still renders. */
  options: string[];
  /** Where the model list came from, and whether it is the live one. */
  discovery?: {
    mode: "discovered" | "cached" | "fallback";
    source: string;
    error: string | null;
    discovered_at: string;
  };
  models?: ModelOptionRow[];
  eval_gated: boolean;
  /** SET-02 — whether a change RUNS the golden set here, and the last / current run. */
  golden?: { runner_installed: boolean; runner_note: string | null; state: GoldenState };
  steps: IntelligenceStepRow[];
}

/**
 * The golden gate (worker settings/golden-gate.ts). A model or reasoning
 * change is PROPOSED; the set runs; only a green compare applies it.
 * "skipped" is the honest answer in a packaged build with no eval harness.
 */
export interface GoldenState {
  status: "idle" | "running" | "passed" | "blocked" | "error" | "skipped";
  started_at: string | null;
  finished_at: string | null;
  categories: string[] | null;
  step: string | null;
  candidate: { model?: string; thinking?: string } | null;
  applied: boolean;
  regressed: string[];
  summary: string | null;
  error: string | null;
  reason: string | null;
}

export const fetchSettingsIntelligence = (): Promise<IntelligenceSettings> =>
  request("/api/settings/intelligence");

export const saveIntelligenceProvider = (
  provider: IntelligenceProviderId,
): Promise<IntelligenceSettings> => request("/api/settings/provider", post({ provider }));

export const saveIntelligenceStep = (patch: {
  step: string;
  model?: string;
  thinking?: string;
  enabled?: boolean;
}): Promise<{ step: string; ok: boolean; gate: { status: string; state: GoldenState } | null }> =>
  request("/api/settings/intelligence", post(patch));

export const fetchGoldenState = (): Promise<{
  runner_installed: boolean;
  runner_note: string | null;
  state: GoldenState;
}> => request("/api/settings/golden");

export type ChatGptLoginState =
  | "idle"
  | "awaiting_browser"
  | "exchanging"
  | "signed_in"
  | "failed"
  | "cancelled"
  | "expired";

export interface ChatGptQuotaSummary {
  state: "unknown" | "available" | "limited" | "exhausted";
  reset_at: string | null;
}

export interface ChatGptCanaryResult {
  status: "unknown" | "passed" | "failed";
  checked_at: string | null;
  error: ProviderApiError | null;
}

/** Redacted provider status. This type deliberately has no credential fields. */
export interface ChatGptProviderStatus {
  signed_in: boolean;
  auth_state: ProviderAuthStatus;
  plan: string | null;
  quota: ChatGptQuotaSummary;
  token_expires_at: string | null;
  canary: ChatGptCanaryResult;
}

export interface ChatGptLoginStart {
  login_id: string;
  auth_url: string;
  expires_at: string;
}

export interface ChatGptLoginStatus {
  login_id: string | null;
  status: ChatGptLoginState;
  expires_at: string | null;
  error: ProviderApiErrorCode | null;
}

const CHATGPT_PROVIDER_PATH = "/api/providers/chatgpt-oauth";

export const fetchChatGptProviderStatus = (): Promise<ChatGptProviderStatus> =>
  request(`${CHATGPT_PROVIDER_PATH}/status`);

export const startChatGptLogin = (): Promise<ChatGptLoginStart> =>
  request(`${CHATGPT_PROVIDER_PATH}/login/start`, post());

export const fetchChatGptLoginStatus = (loginId: string): Promise<ChatGptLoginStatus> =>
  request(`${CHATGPT_PROVIDER_PATH}/login/status?login_id=${encodeURIComponent(loginId)}`);

export const cancelChatGptLogin = (loginId: string): Promise<{ cancelled: boolean }> =>
  request(`${CHATGPT_PROVIDER_PATH}/login/cancel`, post({ login_id: loginId }));

export const logoutChatGpt = (): Promise<{ signed_out: boolean }> =>
  request(`${CHATGPT_PROVIDER_PATH}/logout`, post());

/**
 * The manual golden run. It SPENDS — the worker refuses with 409 when no eval
 * harness is installed beside it, which is what keeps a packaged app (and any
 * test build) from ever reaching the model through this button.
 */
export const runGoldenSet = (body: {
  categories?: string[];
  wait?: boolean;
}): Promise<{ started: boolean; state: GoldenState }> =>
  request("/api/settings/golden/run", post(body));

// ---- Model files on disk: embeddings + whisper -----------------------------
//
// Both registries answer the same four questions per row — is it here, how big
// is it, is it the one in use, and is something being fetched right now — so
// the UI renders them through one component and this section types them the
// same way.

/** A fetch in flight for one model, or the failure the last attempt ended in. */
export interface ModelDownloadRow {
  status: "downloading" | "error";
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
  /** Embedding downloads are several files; this names the one in flight. */
  file?: string;
}

export interface EmbeddingModelRow {
  id: string;
  label: string;
  note?: string;
  dim: number;
  bytes: number;
  bundled: boolean;
  recommended: boolean;
  active: boolean;
  present: boolean;
  indexed: number;
  upstream?: string | null;
  download?: (ModelDownloadRow & { modelId: string }) | null;
  /** Bytes actually on disk right now, summed over the model's files. */
  files?: { path: string; bytes: number; present: boolean; bytesOnDisk: number | null }[];
}

export interface EmbeddingRegistry {
  active: string;
  /** What this build wants to be running (EmbeddingGemma 300M). */
  default?: string;
  models: EmbeddingModelRow[];
  swap: { phase: string; toModel?: string; embedded?: number; total?: number } | null;
  error?: string;
}

/**
 * POST a registry action and return the registry it answers with — INCLUDING
 * the refusal bodies (409: "that is the model the index is built on"). A
 * download button that swallowed those would leave the user staring at a row
 * that did not change and no reason why.
 */
async function registryPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(workerUrl(path), post(body));
  } catch (err) {
    throw new WorkerError(
      "unreachable",
      path,
      null,
      `${path} -> ${WORKER_UNREACHABLE}${err instanceof Error && err.message ? ` (${err.message})` : ""}`,
    );
  }
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !parsed.error) throw new WorkerError("http", path, res.status, `${path} -> ${res.status}`);
  return parsed;
}

export const fetchEmbeddingModels = (): Promise<EmbeddingRegistry> =>
  request("/api/retrieval/semantic/models");
export const downloadEmbeddingModel = (id: string): Promise<EmbeddingRegistry> =>
  registryPost("/api/retrieval/semantic/models/download", { id });
export const cancelEmbeddingModelDownload = (id: string): Promise<EmbeddingRegistry> =>
  registryPost("/api/retrieval/semantic/models/cancel", { id });
export const deleteEmbeddingModel = (id: string): Promise<EmbeddingRegistry> =>
  registryPost("/api/retrieval/semantic/models/delete", { id });
export const activateEmbeddingModel = (id: string): Promise<EmbeddingRegistry> =>
  registryPost("/api/retrieval/semantic/models/activate", { id });

export interface WhisperModelRow {
  id: string;
  label: string;
  bytes: number;
  bundled: boolean;
  present: boolean;
  bytesOnDisk: number | null;
  selected: boolean;
  download: (ModelDownloadRow & { id: string }) | null;
}

export interface MediaToolsReport {
  models: WhisperModelRow[];
  modelsDir: string;
  error?: string;
}

export const fetchMediaTools = (): Promise<MediaToolsReport> => request("/api/media/tools");
export const downloadWhisperModel = (id: string): Promise<MediaToolsReport> =>
  registryPost("/api/media/models/download", { id });
export const cancelWhisperModelDownload = (id: string): Promise<MediaToolsReport> =>
  registryPost("/api/media/models/cancel", { id });
export const deleteWhisperModel = (id: string): Promise<MediaToolsReport> =>
  registryPost("/api/media/models/delete", { id });

export interface MediaSettings {
  describe_enabled: boolean;
  backfill_enabled: boolean;
  images_enabled: boolean;
  video_enabled: boolean;
  business_enabled: boolean;
  link_scrape_enabled: boolean;
  video_frames_enabled: boolean;
  video_audio_enabled: boolean;
  voice_notes_enabled: boolean;
  rate_per_min: number;
  concurrency: number;
  video_frame_interval_sec: number;
  video_frame_max: number;
  video_max_height: number;
  whisper_model: string;
}

export const fetchSettingsMedia = (): Promise<MediaSettings> =>
  request("/api/settings/media");
export const saveSettingsMedia = (
  patch: Partial<MediaSettings>,
): Promise<MediaSettings> => request("/api/settings/media", post(patch));

export interface BehavioralRule {
  id: string;
  text: string;
  source: string;
  created_at: string;
}

export interface FreshnessWindow {
  idle_s: number;
  max_s: number;
}

export interface AssistSettings {
  enabled: boolean;
  /**
   * The retired INPUT-side knobs of the P2.2 watcher (novelty thresholds,
   * cooldown, quiet hours, per-context suppression). S4.4 moved the decision
   * to the OUTPUT side (`nudgeVerdict`) and Product_V6_Phase1 §18.2 is
   * explicit — "No quiet hours, no cap, no cooldown" — so the pane no longer
   * offers them and they are optional here: a worker that has finished
   * retiring `assist/` simply stops sending them.
   */
  thresholds?: Record<string, number>;
  cooldown_min?: number;
  quiet_hours?: { start: string; end: string };
  suppressed_contexts?: { topic_key: string; suppressed_until: string }[];
  // ---- the P1 §25 Assist fields (S5.6) ----
  /** Freshness = the cold window. The dispatcher re-reads it on its next tick. */
  freshness?: string;
  freshness_window?: FreshnessWindow;
  freshness_presets?: Record<string, FreshnessWindow>;
  burst?: { k: number; window_s: number };
  card_duration_s?: number;
  merge_window_s?: number;
  intent_floor?: number;
  /** Kinds "don't do this again" switched off — reversible. */
  blocked_kinds?: string[];
  behavioral_rules?: BehavioralRule[];
  /** Fields the worker would not accept, named one by one. */
  refused?: string[];
}

/** What a POST may carry. Everything is optional; the rest keeps its value. */
export interface AssistPatch {
  enabled?: boolean;
  thresholds?: Record<string, number>;
  cooldown_min?: number;
  quiet_hours?: { start: string; end: string };
  clear_suppressed?: boolean;
  freshness?: string;
  burst?: { k?: number; window_s?: number };
  card_duration_s?: number;
  merge_window_s?: number;
  intent_floor?: number;
  blocked_kinds?: string[];
  add_rule?: string;
  remove_rule?: string;
}

export const fetchSettingsAssist = (): Promise<AssistSettings> =>
  request("/api/settings/assist");
export const saveSettingsAssist = (patch: AssistPatch): Promise<AssistSettings> =>
  request("/api/settings/assist", post(patch));

// ---- Retrieval (P1 §25; the T2 rows are stored and served, hidden here) ----

export interface RetrievalSettings {
  agentic: boolean;
  t2: { hidden: boolean; hop_budget: number; time_budget_s: number };
  scan_row_limit: number;
  graph: { hops: number; fanout: number; default_hops: number; default_fanout: number };
  hubs: { entity_id: string; reason: string; degree: number | null; added_by: string | null }[];
  refused?: string[];
}

export interface RetrievalPatch {
  agentic?: boolean;
  scan_row_limit?: number;
  graph?: { hops?: number; fanout?: number };
  add_hub?: string;
  remove_hub?: string;
}

export const fetchSettingsRetrieval = (): Promise<RetrievalSettings> =>
  request("/api/settings/retrieval");
export const saveSettingsRetrieval = (patch: RetrievalPatch): Promise<RetrievalSettings> =>
  request("/api/settings/retrieval", post(patch));

// ---- AI Connector (P1 §25) -------------------------------------------------

export interface ConnectorDoor {
  door: string;
  label: string;
  status: "live" | "p3" | "local-only";
  detail: string | null;
  connected: boolean;
}

export interface ConnectorSettings {
  doors: ConnectorDoor[];
  fallback_order: string[];
  ceilings: {
    usd_per_call: number;
    usd_per_hour: number;
    usd_per_day: number;
    calls_per_hour: number;
    calls_per_day: number;
  };
  stop_all: boolean;
  refused?: string[];
}

export const fetchSettingsConnector = (): Promise<ConnectorSettings> =>
  request("/api/settings/connector");
export const saveSettingsConnector = (patch: {
  fallback_order?: string[];
}): Promise<ConnectorSettings> => request("/api/settings/connector", post(patch));

// ---- Calendar (P1 §25) -----------------------------------------------------
//
// Served by the worker's calendar lane (calendar/lead-time.ts), keyed by
// circle: plan means a space opens at T minus the lead time; wish means the
// date just shows on the people layer.

export interface CirclePolicy {
  mode: "plan" | "wish";
  leadDays: number;
}

export interface CalendarSettings {
  circles: Record<string, CirclePolicy>;
}

export const fetchSettingsCalendar = (): Promise<CalendarSettings> =>
  request("/api/settings/calendar");
export const saveSettingsCalendar = (
  circles: Record<string, Partial<CirclePolicy>>,
): Promise<CalendarSettings> => request("/api/settings/calendar", post({ circles }));

export interface GraduationSettings {
  mode: "propose" | "auto";
  /** What a fresh install does — "propose" (V6 P1 S5.1: graduates to auto after two clean weeks). */
  default_mode?: "propose" | "auto";
  reverted: boolean;
  required_days: number;
  consecutive_green: number;
  /** Proposals seen across the reported window (informational). */
  window_proposals?: number;
  /** Below this many, the over-creation percentage is noise, not a signal. */
  min_proposals?: number;
  window: {
    day: string;
    proposals: number;
    userRejections: number;
    overCreationPct: number | null;
    falseAutoMerge: number;
    gatesOk: boolean;
  }[];
}

export const fetchSettingsGraduation = (): Promise<GraduationSettings> =>
  request("/api/settings/graduation");
export const saveGraduationMode = (
  mode: "propose" | "auto",
): Promise<GraduationSettings> => request("/api/settings/graduation", post({ mode }));

export interface TraceIndexRow {
  id: string;
  run_id: string | null;
  pass: string | null;
  caller: string | null;
  model: string | null;
  prompt_version: string | null;
  repair_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  status: string | null;
  day: string | null;
  created_at: string | null;
}

export interface TracePassCost {
  pass: string;
  calls: number;
  cost_usd: number;
}

export const fetchTraces = (filter: {
  pass?: string;
  day?: string;
  run_id?: string;
  limit?: number;
  offset?: number;
}): Promise<{ traces: TraceIndexRow[]; costs: TracePassCost[] }> => {
  const q = new URLSearchParams();
  if (filter.pass) q.set("pass", filter.pass);
  if (filter.day) q.set("day", filter.day);
  if (filter.run_id) q.set("run_id", filter.run_id);
  if (filter.limit) q.set("limit", String(filter.limit));
  if (filter.offset) q.set("offset", String(filter.offset));
  return request(`/api/traces?${q.toString()}`);
};

export interface FullTraceRecord {
  trace_id: string;
  ts: string;
  run_id: string;
  pass: string;
  caller: string;
  model: string | null;
  prompt_version: string | null;
  system_prompt: unknown;
  packed_context: unknown;
  raw_output: unknown;
  parsed_result: unknown;
  repair_count: number;
  cost_usd: number | null;
  latency_ms: number;
  status: string;
}

export const fetchTraceFull = (
  id: string,
): Promise<{ trace: FullTraceRecord; compressed: boolean }> =>
  request(`/api/trace/${encodeURIComponent(id)}/full`);

export interface QuarantineRow {
  id: string;
  kind?: string;
  reason?: string;
  [k: string]: unknown;
}

export const fetchQuarantine = (): Promise<{ items: QuarantineRow[] }> =>
  request("/api/ops/quarantine");

/** One decision a run wrote, as the undo confirm step renders it. */
export interface RunUndoItem {
  decisionId: string;
  pass: string | null;
  targetKind: string;
  targetId: string;
  action: string;
  reason: string | null;
  createdAt: string;
  reversible: boolean;
  skipReason: string | null;
}

export interface RunUndoPreview {
  runId: string;
  items: RunUndoItem[];
  reversible: number;
  skipped: number;
}

export interface RunUndoResult extends RunUndoPreview {
  reversed: number;
}

/** READ-ONLY: what an undo of this run would revert. Nothing is changed. */
export const fetchRunUndoPreview = (runId: string): Promise<RunUndoPreview> =>
  request(`/api/ops/runs/${encodeURIComponent(runId)}/undo`);

/** DESTRUCTIVE: reverse-replays the run. Always show the preview first. */
export const undoRun = (runId: string): Promise<RunUndoResult> =>
  request(`/api/ops/runs/${encodeURIComponent(runId)}/undo`, post());

// ---- Runs: the run-level index, diff and quarantine (V6 P1 S5.6) -----------
//
// A trace is one model call; a RUN is the unit undo reverses and the unit
// §25 asks the pane to diff. Quarantined runs stay in the list and in the
// cost rollup — hiding one would hide real spend — and carry a flag.

export interface RunQuarantine {
  quarantined: boolean;
  at: string;
  reason: string | null;
}

export interface RunRow {
  id: string;
  kind: string | null;
  role: string | null;
  pass: string | null;
  origin: string | null;
  model: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number;
  input_tokens: number;
  cache_read: number;
  output_tokens: number;
  error_code: string | null;
  traces: number;
  decisions: number;
  reversed: number;
  quarantine: RunQuarantine | null;
}

export interface RunIndex {
  runs: RunRow[];
  costs: { pass: string; runs: number; cost_usd: number }[];
  total: number;
}

export interface RunDetail {
  run: RunRow;
  traces: {
    id: string;
    pass: string | null;
    caller: string | null;
    model: string | null;
    prompt_version: string | null;
    cost_usd: number | null;
    latency_ms: number | null;
    status: string | null;
    day: string | null;
    created_at: string | null;
  }[];
  decisions: {
    id: string;
    pass: string | null;
    target_kind: string;
    target_id: string;
    action: string;
    reason: string | null;
    created_at: string;
    reversed_at: string | null;
  }[];
  undo: RunUndoPreview;
}

export interface RunDiffTarget {
  target_kind: string;
  target_id: string;
  a_action: string | null;
  b_action: string | null;
}

export interface RunDiff {
  a: RunRow;
  b: RunRow;
  fields: { field: string; a: string | number | null; b: string | number | null; same: boolean }[];
  prompt_versions: { a: string[]; b: string[] };
  decisions: {
    only_a: RunDiffTarget[];
    only_b: RunDiffTarget[];
    changed: RunDiffTarget[];
    same: number;
  };
}

export const fetchRuns = (q: {
  pass?: string;
  day?: string;
  quarantined?: boolean;
  limit?: number;
} = {}): Promise<RunIndex> => {
  const p = new URLSearchParams();
  if (q.pass) p.set("pass", q.pass);
  if (q.day) p.set("day", q.day);
  if (q.quarantined !== undefined) p.set("quarantined", q.quarantined ? "1" : "0");
  if (q.limit) p.set("limit", String(q.limit));
  const qs = p.toString();
  return request(`/api/runs${qs ? `?${qs}` : ""}`);
};

export const fetchRun = (runId: string): Promise<RunDetail> =>
  request(`/api/runs/${encodeURIComponent(runId)}`);

export const fetchRunDiff = (a: string, b: string): Promise<RunDiff> =>
  request(`/api/runs/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);

/** Mark a run's output not-to-be-trusted, or release it. Reversible; not an undo. */
export const quarantineRun = (
  runId: string,
  quarantined: boolean,
  reason?: string,
): Promise<{ run_id: string; quarantine: RunQuarantine }> =>
  request(`/api/runs/${encodeURIComponent(runId)}/quarantine`, post({ quarantined, reason }));

// ---- Ops: lanes, spend, the kill switch (build item 4.4; V6 P1 S0.8) --------

/** The lanes the ops surface may pause — mirrors OPS_LANES in ops-routes.ts. */
export type OpsLane =
  | "llm:understanding"
  | "llm:enrichment"
  | "llm"
  | "transcribe"
  | "embed"
  | "ffmpeg"
  | "scrape";

export interface LaneState {
  lane: OpsLane;
  pausedForMs: number;
  paused: boolean;
  limit: number;
}

export const fetchOpsLanes = (): Promise<{ lanes: LaneState[] }> => request("/api/ops/lanes");

/**
 * Pause one lane by hand for `ms` (default five minutes server-side). There is
 * no cap: the lane stays paused exactly as long as asked (T0-13). For a stop
 * that survives restart, use setModelActivityPaused instead.
 */
export const pauseLane = (
  lane: OpsLane,
  ms?: number,
): Promise<{ ok: boolean; lane: OpsLane; pausedForMs: number }> =>
  request("/api/ops/lanes/pause", post(ms === undefined ? { lane } : { lane, ms }));

export const resumeLane = (lane: OpsLane): Promise<{ ok: boolean; lane: OpsLane; pausedForMs: number }> =>
  request("/api/ops/lanes/resume", post({ lane }));

export interface SpendWindow {
  calls: number;
  usd: number;
}

/** GET /api/ops/spend — the budget windows, the ceiling latch, the kill switch. */
export interface SpendStatus {
  trippedAt: string | null;
  trippedReason: string | null;
  /** ISO time "Stop all model activity" was switched on; null while running. */
  modelActivityPausedAt: string | null;
  hour: SpendWindow;
  day: SpendWindow;
  ceilings: {
    usdPerCall: number;
    usdPerHour: number;
    usdPerDay: number;
    callsPerHour: number;
    callsPerDay: number;
  };
}

export const fetchSpend = (): Promise<SpendStatus> => request("/api/ops/spend");

/** The kill switch. Persists across restart; nothing spawns until released. */
export const setModelActivityPaused = (paused: boolean): Promise<SpendStatus> =>
  request("/api/ops/model-activity", post({ paused }));

/** Operator reset of the budget ceiling latch. Does not touch the kill switch. */
export const resetBudgetLatch = (): Promise<SpendStatus> => request("/api/ops/budget/reset", post());

export interface UsageSummary {
  window: string;
  [k: string]: unknown;
}

export const fetchUsage = (window: "today" | "7d" | "30d"): Promise<UsageSummary> =>
  request(`/api/usage?window=${window}`);

export interface T3Status {
  last_run_at: string | null;
  last_report: {
    ranAt: string;
    crossLinks: number;
    claimVersionsCompressed: number;
    summariesQueued: number;
    ephemeralArchived: number;
  } | null;
  eval_regression_due: string | null;
}

export const fetchSettingsT3 = (): Promise<T3Status> => request("/api/settings/t3");

export interface DataSettings {
  home: string;
  storage: { db_bytes: number; traces_bytes: number; media_bytes: number; logs_bytes: number };
  events_per_source: { source: string; events: number }[];
  retention: { traces_days: number };
}

export const fetchSettingsData = (): Promise<DataSettings> => request("/api/settings/data");
export const saveTracesRetention = (
  days: number,
): Promise<{ retention: { traces_days: number } }> =>
  request("/api/settings/data/retention", post({ traces_days: days }));

// ---- V6 S1.8: confirm card + consent rows ----------------------------------

export type CardAccuracy = "exact" | "about" | "estimate ±40%" | "estimate ±30%";

export interface CardNumber {
  value: number | null;
  unit: "events" | "usd" | "seconds" | "bytes";
  accuracy: CardAccuracy;
  display: string;
  note: string | null;
}

export interface ConfirmCardData {
  version: string;
  source: string;
  indexAll: boolean;
  indexFrom: string | null;
  understandFrom: string | null;
  understandDays: number;
  indexDays: number | null;
  events: CardNumber;
  cost: CardNumber;
  time: CardNumber;
  disk: CardNumber;
  stopAskUsd: number;
  computedAt: string;
  text: string;
}

export interface CardCounts {
  index: number | null;
  understand: number | null;
  exact: boolean;
}

export interface ConsentWindowsRequest {
  source: string;
  index_all: boolean;
  index_from: string | null;
  understand_from: string | null;
  counts?: CardCounts | null;
  scope?: unknown;
}

export interface ConsentRowView {
  id: string;
  source: string;
  state: "connected" | "paused" | "disconnected" | "revoked";
  granted_at: string;
  granted_build: string | null;
  index_all: boolean;
  index_from: string | null;
  understand_from: string | null;
  decision_id: string | null;
  card_text: string | null;
}

export interface ConfirmConsentResult {
  consent: {
    id: string;
    source: string;
    state: string;
    index_all: boolean;
    index_from: string | null;
    understand_from: string | null;
    decision_id: string;
  };
  card: ConfirmCardData;
  decision_id: string;
  change: "granted" | "widened" | "shortened" | "unchanged";
  replayed: number;
  started: string;
}

export const previewConsentCard = (req: ConsentWindowsRequest): Promise<{ card: ConfirmCardData }> =>
  request("/api/consent/card", post(req));
export const confirmConsent = (req: ConsentWindowsRequest): Promise<ConfirmConsentResult> =>
  request("/api/consent/confirm", post(req));
export const fetchConsents = (): Promise<{ consents: ConsentRowView[] }> => request("/api/consent");

// ---- V6 S1.8: Library storage — two bars, two budgets --------------------------

export interface TierBar {
  events: number;
  bytes: number;
  from: string | null;
  to: string | null;
}

export interface SourceStorage {
  source: string;
  label: string;
  consent: {
    state: "connected" | "paused" | "disconnected" | "revoked";
    index_all: boolean;
    index_from: string | null;
    understand_from: string | null;
    decision_id: string | null;
  } | null;
  searchable: TierBar;
  /** What the twin has READ: events that carry an episode (FIX-C5). */
  understood: TierBar;
  /** The queue: inside the Understand window, model-bound, not read yet. */
  in_understand_window?: TierBar;
  searchable_only: TierBar & { label: "searchable-only"; note: string };
}

export interface DiskBudgets {
  events_bytes_per_year: number;
  media_bytes: number;
  media_retention_days: number;
}

export interface StorageOverview {
  disk: { free_bytes: number | null; total_bytes: number | null };
  used: { events_derived_bytes: number; media_bytes: number };
  budgets: DiskBudgets;
  sources: SourceStorage[];
  copy: { lead: string; searchable_only: string };
}

export const fetchLibraryStorage = (): Promise<StorageOverview> => request("/api/library/storage");
export const saveDiskBudgets = (patch: Partial<DiskBudgets>): Promise<{ budgets: DiskBudgets }> =>
  request("/api/library/budgets", post(patch));

// ---- Capture: filter lists, private moment, forget, verbs, tray state (V6 S1.7)

/** What the tray renders: the funnel's real answer per source, plus the pauses. */
export interface CaptureSourceState {
  source: string;
  consent: "connected" | "paused" | "disconnected" | "revoked" | null;
  running: boolean;
  capturing: boolean;
}

export interface CaptureState {
  /** Something can land in the log right now. */
  capturing: boolean;
  /** Sources admitted AND running (empty while a pause deadline is live). */
  recording: string[];
  admitted: string[];
  paused: boolean;
  private_until: string | null;
  quick_pause_until: string | null;
  private_moment_minutes: number;
  sources: CaptureSourceState[];
}

export const fetchCaptureState = (): Promise<CaptureState> => request("/api/capture/state");

/** One-click stop: pause every admitted source (consent flips first). */
export const stopAllCapture = (): Promise<{ ok: boolean; paused: string[]; state: CaptureState }> =>
  request("/api/capture/stop", post());

/** Fifteen minutes unless told otherwise; `{ end: true }` ends it early. */
export const startPrivateMoment = (
  minutes?: number,
): Promise<{ ok: boolean; private_until: string | null; state: CaptureState }> =>
  request("/api/capture/private-moment", post(minutes ? { minutes } : {}));

export const endPrivateMoment = (): Promise<{ ok: boolean; private_until: null; state: CaptureState }> =>
  request("/api/capture/private-moment", post({ end: true }));

/** The cascade's numbers as a dry run — what the confirm will do, exactly. */
export interface CascadePreview extends CascadeReport {
  spaces_touched: number;
  first_ts: string | null;
  last_ts: string | null;
}

export const previewForget = (minutes: number): Promise<{ preview: CascadePreview & { minutes: number } }> =>
  request("/api/capture/forget/preview", post({ minutes }));

export const forgetLastMinutes = (minutes: number): Promise<{ report: CascadeReport & { minutes: number } }> =>
  request("/api/capture/forget", post({ minutes }));

export interface SourceVerbOutcome {
  source: string;
  verb: "pause" | "resume" | "disconnect" | "delete";
  consent: { state: string } | null;
  captureAllowed: boolean;
  stopped: boolean;
  teardownError: string | null;
  decision_id: string | null;
}

export const pauseCaptureSource = (source: string): Promise<SourceVerbOutcome> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/pause`, post());
export const resumeCaptureSource = (source: string): Promise<SourceVerbOutcome> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/resume`, post());
export const disconnectCaptureSource = (source: string): Promise<SourceVerbOutcome> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/disconnect`, post());

export interface SourceDeletePreview extends CascadePreview {
  streams: number;
  actors: number;
}

export const previewDeleteSource = (source: string): Promise<{ preview: SourceDeletePreview }> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/delete/preview`, post());

export const deleteCaptureSource = (
  source: string,
): Promise<SourceVerbOutcome & { deleted: { events: number; streams: number; actors: number; cascade: CascadeReport } }> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/delete`, post());

/** Episodes understood before a shortened window (CNS-08), labelled. */
export interface OutsideWindowReview {
  source: string;
  understand_from: string | null;
  episodes: {
    id: string;
    space_id: string | null;
    summary: string | null;
    first_ts: string | null;
    last_ts: string | null;
    events: number;
    label: "outside-understand-window";
  }[];
  event_ids: string[];
}

export const fetchOutsideWindow = (source: string): Promise<OutsideWindowReview> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/outside-window`);
export const previewDeleteOutsideWindow = (
  source: string,
): Promise<{ preview: CascadePreview & { episodes: number } }> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/outside-window/preview`, post());
export const deleteOutsideWindow = (source: string): Promise<{ report: CascadeReport & { episodes: number } }> =>
  request(`/api/capture/sources/${encodeURIComponent(source)}/outside-window/delete`, post());

// ---------------------------------------------------------------------------
// Calendar — derived (V6 P1 S5.3; Product_V6_Phase1 §16, Product_V6 §11.9)
//
// Four layers over a day range, rendered at VIEW time by the worker: nothing
// relative is ever stored, so "in 3 days" is recomputed on every read. P1
// reads no external calendar and writes none back.
// ---------------------------------------------------------------------------

export const CALENDAR_LAYERS = ["my_events", "my_tasks", "twin_tasks", "people"] as const;
export type CalendarLayer = (typeof CALENDAR_LAYERS)[number];

export interface CalendarItemView {
  layer: CalendarLayer;
  kind: "event" | "rule_occurrence" | "task_due" | "twin_step" | "person_date" | "their_task";
  refId: string;
  title: string;
  at: string;
  day: string;
  allDay: boolean;
  /** tentative | confirmed (events) · the task's status · the plan's status. */
  status: string | null;
  /** Computed at paint: "today" · "in 3 days" · "2 days overdue". */
  relative: string;
  rendered: string;
  sourceTz: string | null;
  spaceId: string | null;
  spaceLabel: string | null;
  personEntityId: string | null;
  personName: string | null;
  /** The original words, when the item came from a phrase. */
  phrase: string | null;
  detail: Record<string, unknown>;
}

export interface CalendarViewResponse {
  from: string;
  to: string;
  tz: string;
  layers: CalendarLayer[];
  items: CalendarItemView[];
  counts: Record<CalendarLayer, number>;
}

export const fetchCalendar = (params: {
  from?: string;
  to?: string;
  layers?: readonly CalendarLayer[];
  tz?: string;
}): Promise<CalendarViewResponse> => {
  const q = new URLSearchParams();
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.layers && params.layers.length > 0) q.set("layers", params.layers.join(","));
  if (params.tz) q.set("tz", params.tz);
  const qs = q.toString();
  return request(`/api/calendar${qs ? `?${qs}` : ""}`);
};

export const confirmCalendarEvent = (id: string): Promise<{ event: { id: string; status: string } }> =>
  request(`/api/calendar/events/${encodeURIComponent(id)}/confirm`, post());
export const cancelCalendarEvent = (id: string): Promise<{ event: { id: string; status: string } }> =>
  request(`/api/calendar/events/${encodeURIComponent(id)}/cancel`, post());

export type CalendarSnoozeChoice = "next_week" | "10_days_before" | "3_days_before";

export const snoozeCalendarPlan = (
  planId: string,
  choice: CalendarSnoozeChoice,
): Promise<{ plan: { id: string; status: string; snoozed_until: string | null }; learned_lead_days: number }> =>
  request(`/api/calendar/plans/${encodeURIComponent(planId)}/snooze`, post({ choice }));
export const stopCalendarPlan = (planId: string): Promise<{ plan: { id: string; status: string } }> =>
  request(`/api/calendar/plans/${encodeURIComponent(planId)}/stop`, post());

export interface CalendarCirclePolicy {
  mode: "plan" | "wish";
  leadDays: number;
}

export const fetchCalendarSettings = (): Promise<{ circles: Record<string, CalendarCirclePolicy> }> =>
  request("/api/settings/calendar");
export const saveCalendarSettings = (
  circles: Record<string, Partial<CalendarCirclePolicy>>,
): Promise<{ circles: Record<string, CalendarCirclePolicy> }> =>
  request("/api/settings/calendar", post({ circles }));

// ---------------------------------------------------------------------------
// Spaces (V6 P1 S5.1) — the list by life area, the view with why-targets on
// every element, the sweep preview, wake, and the re-file drag.
// ---------------------------------------------------------------------------

/** A space row as the Spaces list serves it: the stored row plus its decorations. */
export interface SpaceListRow extends SpaceRow {
  area: string;
  summary: string | null;
  latest: string | null;
  latest_ts: string | null;
  born_via: "inferred" | "asked" | "woken" | null;
  task_count: number;
  next_action: string | null;
  freshness: string | null;
  people: string[];
}

export interface SpacesList {
  areas: { area: string; spaces: SpaceListRow[] }[];
  /** Dormant spaces, collapsed by default. */
  dormant: SpaceListRow[];
  /**
   * FIX-C7: proposals waiting in the Review queue. They are NOT in `areas` —
   * propose-only birth keeps them out until the user approves — so the list
   * carries their count, and the screen points at Review instead of claiming
   * there is nothing. Older workers omit the field; treat it as 0.
   */
  proposed_count?: number;
}

export interface SpaceBirthEvidence {
  quote: string;
  event_ids: string[];
  thread_id?: string | null;
}

export interface SpaceViewChapter {
  id: string;
  label: string;
  status: string;
  target_date: string | null;
  summary: string | null;
}

export interface SpaceViewTask {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string | null;
  due: string | null;
  chapter_id: string | null;
  evidence_json: string | null;
  confidence: number | null;
}

export interface SpaceViewEpisode {
  id: string;
  summary: string | null;
  state: string;
  first_ts: string | null;
  last_ts: string | null;
  chapter_id: string | null;
  stream_id: string | null;
  quotes: { event_id: string; ts: string | null; actor: string | null; text: string | null }[];
}

export interface SpaceEnrichment {
  id: string;
  kind: string;
  url: string;
  content_hash: string;
  summary: string | null;
  fetched_at: string;
  changed_at: string;
  fetch_count: number;
}

export interface SpaceView {
  space: SpaceRow & {
    summary: string | null;
    latest: string | null;
    latest_ts: string | null;
    plan_json: string | null;
    born_via: "inferred" | "asked" | "woken" | null;
    birth_evidence_json: string | null;
    bar_thread_id: string | null;
    dormant_at: string | null;
    woken_at: string | null;
  };
  area: string;
  plan: unknown;
  /** Chapters with a target date — [] when the goal has no stages. */
  milestones: SpaceViewChapter[];
  chapters: SpaceViewChapter[];
  tasks: SpaceViewTask[];
  follow_ups: { id: string; kind: string; payload: unknown; status: string; task_id: string | null }[];
  episodes: SpaceViewEpisode[];
  enrichments: SpaceEnrichment[];
  people: string[];
  birth: {
    via: "inferred" | "asked" | "woken" | null;
    evidence: SpaceBirthEvidence[];
    thread_id: string | null;
    woken_at: string | null;
  };
}

export interface SweepPreview {
  spaceId: string;
  count: number;
  items: { episodeId: string; summary: string | null; lastTs: string | null; source: "unsorted" | "log" }[];
  /** "will pull in 3 related items" — what the proposal card shows. */
  line: string;
}

/** The fourteen default life areas, plus the "Other" bucket the list ends with. */
export const LIFE_AREAS = [
  "Work",
  "Health",
  "Money",
  "Admin",
  "People",
  "Home",
  "Travel",
  "Shopping",
  "Content",
  "Learning",
  "Hobbies",
  "Events",
  "Community",
  "Safety",
] as const;
export const OTHER_AREA = "Other";

export const fetchSpacesList = (): Promise<SpacesList> => request("/api/spaces/list");
export const fetchSpaceView = (id: string): Promise<SpaceView> =>
  request(`/api/spaces/${encodeURIComponent(id)}/view`);
export const fetchSweepPreview = (id: string): Promise<SweepPreview> =>
  request(`/api/spaces/${encodeURIComponent(id)}/sweep-preview`);

export interface RefileOutcome {
  moved: boolean;
  decisionId: string | null;
  from: string | null;
  to: string | null;
  reason?: string;
}

/** The drag in the list: a space card dropped on another life area. */
export const refileSpace = (id: string, lifeArea: string): Promise<RefileOutcome> =>
  request(`/api/spaces/${encodeURIComponent(id)}/refile`, post({ life_area: lifeArea }));

/** The drag in the view: an episode dropped on another space (null → unsorted). */
export const refileEpisode = (
  spaceId: string,
  episodeId: string,
  toSpaceId: string | null,
): Promise<RefileOutcome> =>
  request(`/api/spaces/${encodeURIComponent(spaceId)}/refile`, post({ episode_id: episodeId, to_space_id: toSpaceId }));

export const wakeSpace = (id: string, signal = "user"): Promise<{ woke: boolean; reason?: string }> =>
  request(`/api/spaces/${encodeURIComponent(id)}/wake`, post({ signal }));

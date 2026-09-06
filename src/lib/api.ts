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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(workerUrl(path), init);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
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

/** Mint one single-use approval token — called ONLY on the Approve tap. */
export const mintApproval = (
  action: string,
): Promise<{ token: string; action: string; expires_at: string }> =>
  request("/api/approvals/mint", post({ action }));

/** The approved WhatsApp draft send: draft read server-side from the run. */
export const sendTaskDraft = (id: string, approvalToken: string): Promise<TaskRunState> =>
  request(`/api/tasks/${encodeURIComponent(id)}/send`, post({ approval_token: approvalToken }));

// ---- Screen source (P2.1, spec §4.2.2 / §4.3) ------------------------------

export interface ScreenStatus {
  running: boolean;
  state: string;
  paused?: boolean;
  pausedApps?: string[];
  /** False while macOS Accessibility permission is missing. */
  permission?: boolean;
  drops?: Record<string, number>;
  snapshots?: number;
  /** Deep link into System Settings › Privacy & Security › Accessibility. */
  settingsUrl: string;
}

export const fetchScreenStatus = (): Promise<ScreenStatus> => request("/api/screen/status");

export const pauseScreen = (paused: boolean): Promise<ScreenStatus> =>
  request("/api/screen/pause", post({ paused }));

// ---- Freshness + Library (P2.4, spec §5.4 / §14.3.2) -----------------------

/** Worst-first; see worker/src/freshness for what each state means. */
export type FreshnessStatus = "catching_up" | "importing_history" | "up_to_date" | "no_data";

export interface SourceFreshness {
  source_id: string;
  captured_from: string | null;
  captured_to: string | null;
  understood_from: string | null;
  understood_to: string | null;
  event_count: number;
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
}

export const fetchFreshness = (): Promise<FreshnessOverview> => request("/api/freshness");

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
}

export const fetchBrowserDiscovery = (): Promise<BrowserDiscovery> => request("/api/sources/browser/discover");
export const fetchBrowserSourceStatus = (): Promise<BrowserSourceStatus> => request("/api/sources/browser/status");
export const connectBrowserSource = (
  body: BrowserConnectRequest = {},
): Promise<{ ok: boolean; consent: BrowserConsentView | null; started: boolean; running: boolean }> =>
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

export interface BarAnswerView {
  answer: string;
  citations: BarCitationView[];
  grounded: boolean;
  refused_uncited: boolean;
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

export interface IntelligenceStepRow {
  key: string;
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
  steps: IntelligenceStepRow[];
}

export const fetchSettingsIntelligence = (): Promise<IntelligenceSettings> =>
  request("/api/settings/intelligence");
export const saveIntelligenceStep = (patch: {
  step: string;
  model?: string;
  thinking?: string;
  enabled?: boolean;
}): Promise<{ step: string; ok: boolean }> =>
  request("/api/settings/intelligence", post(patch));

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
  const res = await fetch(workerUrl(path), post(body));
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !parsed.error) throw new Error(`${path} -> ${res.status}`);
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

export interface AssistSettings {
  enabled: boolean;
  thresholds: Record<string, number>;
  cooldown_min: number;
  quiet_hours: { start: string; end: string };
  suppressed_contexts: { topic_key: string; suppressed_until: string }[];
}

export const fetchSettingsAssist = (): Promise<AssistSettings> =>
  request("/api/settings/assist");
export const saveSettingsAssist = (
  patch: Partial<AssistSettings> & { clear_suppressed?: boolean },
): Promise<AssistSettings> => request("/api/settings/assist", post(patch));

export interface GraduationSettings {
  mode: "propose" | "auto";
  /** What a fresh install does — "auto" since the auto-create default landed. */
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
  understood: TierBar;
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

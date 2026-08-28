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

export interface SourceFreshness {
  source_id: string;
  captured_from: string | null;
  captured_to: string | null;
  understood_from: string | null;
  understood_to: string | null;
  event_count: number;
  understood_count: number;
  pending_count: number;
  lag_minutes: number | null;
  backfill_complete: boolean;
  understood_percent: number;
  label: string | null;
  detail: string;
}

export interface FreshnessOverview {
  sources: SourceFreshness[];
  label: string | null;
  lag_minutes: number | null;
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
}

export const fetchLibraryChats = (): Promise<{ streams: ChatStreamRow[] }> =>
  request("/api/library/chats");

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
}

export const fetchLibraryBrowser = (): Promise<LibraryBrowser> => request("/api/library/browser");

export interface ScreenSessionCard {
  stream_key: string;
  app: string;
  started_at: string;
  ended_at: string;
  minutes: number;
  event_count: number;
}

export interface LibraryScreen {
  day: string;
  hours: number[];
  sessions: ScreenSessionCard[];
  paused: boolean;
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
}

export interface IntelligenceSettings {
  default_model: string;
  options: string[];
  eval_gated: boolean;
  steps: IntelligenceStepRow[];
}

export const fetchSettingsIntelligence = (): Promise<IntelligenceSettings> =>
  request("/api/settings/intelligence");
export const saveIntelligenceStep = (patch: {
  step: string;
  model?: string;
  enabled?: boolean;
}): Promise<{ step: string; ok: boolean }> =>
  request("/api/settings/intelligence", post(patch));

export interface EmbeddingModelRow {
  id: string;
  label: string;
  dim: number;
  bytes: number;
  bundled: boolean;
  recommended: boolean;
  active: boolean;
  present: boolean;
  indexed: number;
}

export const fetchEmbeddingModels = (): Promise<{
  active: string;
  models: EmbeddingModelRow[];
  swap: { phase: string; embedded?: number; total?: number } | null;
}> => request("/api/retrieval/semantic/models");

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
  reverted: boolean;
  required_days: number;
  consecutive_green: number;
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

export const undoRun = (runId: string): Promise<unknown> =>
  request(`/api/ops/runs/${encodeURIComponent(runId)}/undo`, post());

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

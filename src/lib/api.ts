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

export type TargetKind = "task" | "space" | "episode" | "claim" | "stream";

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

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

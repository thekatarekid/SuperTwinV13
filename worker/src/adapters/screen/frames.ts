// ===========================================================================
// screenwatch wire frames (build P2.1) — the NDJSON shapes the Swift sidecar
// (sources/screenwatch) emits on stdout, mirrored here at the adapter
// boundary. Discriminated by `t`, same discipline as the whatsapp-go
// protocol (docs/PHASE1_CONTRACT §1).
// ===========================================================================

/** What fired a capture (spec §4.2.2). */
export type ScreenTrigger =
  | "app_switch"
  | "window_switch"
  | "tab_switch"
  | "typing_pause"
  | "scroll_stop"
  | "heartbeat";

/** `t:"snapshot"` — a capture that passed the sidecar's privacy + dedup. */
export interface SnapshotFrame {
  t: "snapshot";
  ts: string;
  bundle_id: string;
  app_name: string;
  window_title: string;
  doc_key: string;
  /** `bundleId¦docKey` (spec §4.2.2). */
  stream_key: string;
  trigger: ScreenTrigger;
  tree_hash: string;
  content_hash: string;
  char_count: number;
  /** Diff against the stream's previous snapshot; full text on the first. */
  new_chars: string;
  /** Full distilled AX text of the frontmost window. */
  text: string;
  links: string[];
  files: string[];
}

/** `t:"drop"` — content-free privacy/pause drop notice (spec §4.3). */
export interface ScreenDropFrame {
  t: "drop";
  ts: string;
  reason: "private_window" | "password_manager" | "app_paused" | "paused";
  bundle_id: string;
}

/** `t:"ready"` / `t:"status"` / `t:"error"` control frames. */
export interface ScreenControlFrame {
  t: "ready" | "status" | "error";
  state?: string;
  mock?: string;
  bundle_id?: string;
  code?: string;
  message?: string;
}

export type ScreenFrame = SnapshotFrame | ScreenDropFrame | ScreenControlFrame;

/** Sidecar lifecycle states surfaced by the adapter. */
export type ScreenState =
  | "starting"
  | "need_permission"
  | "capturing"
  | "paused"
  | "reconnecting"
  | "error";

/** Structural guard for a parsed stdout line. */
export function isSnapshotFrame(v: unknown): v is SnapshotFrame {
  const o = v as Record<string, unknown> | null;
  return (
    !!o &&
    o["t"] === "snapshot" &&
    typeof o["ts"] === "string" &&
    typeof o["bundle_id"] === "string" &&
    typeof o["stream_key"] === "string" &&
    typeof o["content_hash"] === "string" &&
    typeof o["new_chars"] === "string" &&
    typeof o["text"] === "string"
  );
}

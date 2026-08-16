// ===========================================================================
// WhatsAppAdapter (docs/PHASE1_CONTRACT §0, §1, §2, §7).
//
// Owns the Go whatsmeow daemon as a supervised child process:
//   - resolves the daemon binary (env → bundled → dev paths),
//   - spawns it with --session-db / --media-dir / --log-level flags,
//   - frames NDJSON: line-buffered parse of stdout (one JSON object per line),
//     JSON-per-line writes to stdin for control commands,
//   - restart-on-crash with capped exponential backoff,
//   - graceful shutdown (send `shutdown`, then SIGTERM backstop).
//
// The spawn function is DEPENDENCY-INJECTED (SpawnFn) so tests pass a fake that
// returns a scripted process emitting a canned NDJSON stream through the exact
// same framing code.
// ===========================================================================

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { normalizeSourceEvent } from "../normalize.js";
import type { SourceAdapter } from "../source-adapter.js";
import type {
  Actor,
  AdapterStatus,
  Stream,
  DaemonProgress,
  HistorySyncPayload,
  Progress,
  Range,
  SourceEvent,
  SourceState,
  StatusUpdate,
} from "../types.js";

// ---- Injectable process abstraction ---------------------------------------
//
// We depend only on the small slice of ChildProcess we actually use, so a fake
// is trivial to build. `stdout`/`stderr` are readable streams emitting utf8/
// buffer chunks; `stdin` is writable; the process is an EventEmitter that emits
// "exit"/"error"; `kill` signals it.

export interface ChildLike extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  stdin: { write(chunk: string): void; end?(): void } | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  pid?: number;
}

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv },
) => ChildLike;

export interface WhatsAppAdapterOptions {
  /** Injected for tests; defaults to real child_process.spawn. */
  spawn?: SpawnFn;
  /** Explicit binary path (overrides resolution). */
  binPath?: string;
  /** Base home dir (default: SUPERTWIN_HOME or ~/SuperTwinV11). */
  home?: string;
  /** Pass --mock to the daemon (also honoured via SUPERTWIN_WHATSAPP_MOCK=1). */
  mock?: boolean;
  /** Backoff caps (ms) for restart-on-crash. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Disable auto-restart (tests that assert on a single exit). */
  autoRestart?: boolean;
  /** Log sink for daemon stderr / adapter diagnostics. */
  log?: (line: string) => void;
}

const SHUTDOWN_GRACE_MS = 3_000;

/**
 * One `seed_anchors` entry, in the daemon's wire shape (protocol.Anchor). Named
 * structurally rather than imported from the db layer so the adapter keeps
 * having no opinion about where anchors are stored.
 */
export interface AnchorLike {
  chat_jid: string;
  msg_id: string;
  from_me: boolean;
  ts: string;
}

// ---------------------------------------------------------------------------
// Binary resolution (contract §0):
//   SUPERTWIN_WHATSAPP_BIN → bundled bin/whatsapp-go (next to worker.cjs) →
//   repo dev path sources/whatsapp-go/whatsapp-go. First existing wins. If none
//   exist we still return the dev path so spawn fails loudly (surfaced as error,
//   not a crash) — the caller keeps serving the API.
// ---------------------------------------------------------------------------
export function resolveWhatsAppBin(explicit?: string): {
  bin: string;
  found: boolean;
} {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const env = process.env.SUPERTWIN_WHATSAPP_BIN;
  if (env) candidates.push(env);

  // Bundled: relative to the running module. In dev (tsx/vitest) __dirname is
  // worker/src/adapters/whatsapp; in prod the bundle places bin next to worker.cjs.
  // We probe a couple of plausible bundle locations.
  const here = moduleDir();
  candidates.push(join(here, "bin", "whatsapp-go"));
  candidates.push(join(here, "..", "..", "..", "bin", "whatsapp-go"));

  // Dev repo path: <repoRoot>/sources/whatsapp-go/whatsapp-go
  const repoRoot = join(here, "..", "..", "..", "..");
  candidates.push(join(repoRoot, "sources", "whatsapp-go", "whatsapp-go"));

  for (const c of candidates) {
    if (c && existsSync(c)) return { bin: c, found: true };
  }
  // Nothing on disk: return the dev path so a spawn attempt fails visibly.
  return {
    bin: join(repoRoot, "sources", "whatsapp-go", "whatsapp-go"),
    found: false,
  };
}

function moduleDir(): string {
  // ESM: derive from import.meta.url without top-level await.
  try {
    return dirname(new URL(import.meta.url).pathname);
  } catch {
    return process.cwd();
  }
}

function resolveHome(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.SUPERTWIN_HOME;
  if (env && env.trim().length) return env;
  return join(homedir(), "SuperTwinV11");
}

/**
 * Media dir the daemon writes into. Precedence mirrors the /api/media route's
 * mediaRoot() (SUPERTWIN_MEDIA_DIR → home/media) so daemon-written files always
 * land under the path the route serves from. `home` is the already-resolved
 * base (SUPERTWIN_HOME or ~/SuperTwinV11), used when no explicit media override.
 */
function resolveMediaDir(home: string): string {
  const override = process.env.SUPERTWIN_MEDIA_DIR;
  if (override && override.trim().length) return override;
  return join(home, "media");
}

// ---------------------------------------------------------------------------

export class WhatsAppAdapter implements SourceAdapter {
  readonly sourceId = "whatsapp";
  readonly sourceType = "whatsapp";

  private readonly spawnFn: SpawnFn;
  private readonly binPath?: string;
  private readonly home: string;
  private readonly mock: boolean;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly autoRestart: boolean;
  private readonly log: (line: string) => void;

  private child: ChildLike | null = null;
  private stdoutBuf = "";
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private killTimer: NodeJS.Timeout | null = null;
  /**
   * Set when a `logout`/relink command is sent (Rev 3 §R3.2). The daemon clears
   * its session and EXITS 0 intentionally; the next daemon exit is therefore
   * expected, not a crash. On that exit we clean-restart into pairing (reset
   * backoff, no scary error/reconnecting flap) and clear this flag.
   */
  private expectingLogoutExit = false;
  /** Commands queued while the daemon is not yet `ready`. */
  private pendingCommands: string[] = [];
  private ready = false;
  /**
   * The import range to (re)install in the daemon at connect via `set_range`, so
   * WhatsApp's automatic post-pairing history is filtered by it. Re-sent on every
   * daemon `ready` (a fresh/restarted daemon resets its in-memory range). Null on
   * a first pair with no chosen range — that history is buffered daemon-side until
   * the user picks a range in onboarding (then `import` installs it).
   */
  private installedRange: Range | null = null;
  /**
   * Supplies the daemon's back-pagination anchors (oldest message per chat) from
   * the worker's DB. The daemon's own `oldestPerChat` map is in-memory and is
   * filled only by messages flowing through the RUNNING process, so a restarted
   * daemon has none — and "Extend history" over zero anchors paginates nothing
   * and closes. whatsmeow's store cannot rebuild them (no message timestamps),
   * so this DB is the only durable source. Installed by the ingest layer, which
   * is the side that can read it.
   */
  private anchorProvider: (() => AnchorLike[]) | null = null;

  private status: AdapterStatus = {
    state: "starting",
    paired: false,
    paused: false,
  };

  private readonly eventCbs: Array<(e: SourceEvent) => void> = [];
  private readonly streamCbs: Array<(s: Stream) => void> = [];
  private readonly actorCbs: Array<(a: Actor) => void> = [];
  private readonly statusCbs: Array<(s: StatusUpdate) => void> = [];

  constructor(opts: WhatsAppAdapterOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.binPath = opts.binPath;
    this.home = resolveHome(opts.home);
    this.mock =
      opts.mock ?? process.env.SUPERTWIN_WHATSAPP_MOCK === "1";
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 15_000;
    this.autoRestart = opts.autoRestart ?? true;
    this.log = opts.log ?? (() => {});
  }

  // ---- SourceAdapter callbacks --------------------------------------------

  onEvent(cb: (e: SourceEvent) => void): void {
    this.eventCbs.push(cb);
  }
  onStream(cb: (s: Stream) => void): void {
    this.streamCbs.push(cb);
  }
  onActor(cb: (a: Actor) => void): void {
    this.actorCbs.push(cb);
  }
  onStatus(cb: (s: StatusUpdate) => void): void {
    this.statusCbs.push(cb);
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  /** Seed the paused flag from persisted app_state (kill-switch survives restart). */
  setPaused(paused: boolean): void {
    this.status = { ...this.status, paused };
  }

  // ---- Lifecycle ----------------------------------------------------------

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.spawnDaemon();
  }

  async startPairing(): Promise<void> {
    this.send({ cmd: "start_pairing" });
  }

  /**
   * Install the import range in the daemon without starting a run (`set_range`),
   * and remember it so it is re-installed on every daemon (re)start. Sent only
   * when ready; otherwise the `ready` handler installs it, so a fresh daemon has
   * the range BEFORE WhatsApp's automatic post-pairing history lands.
   */
  async setRange(range: Range): Promise<void> {
    this.installedRange = range;
    if (this.ready) this.send({ cmd: "set_range", range });
  }

  async backfill(range: Range): Promise<void> {
    // An explicit import supersedes any connect-time range, and must survive a
    // daemon restart mid-import, so remember it for re-install on `ready`.
    this.installedRange = range;
    this.send({ cmd: "import", range });
  }

  /**
   * Install the source of back-pagination anchors. Called by the ingest layer
   * (the side that can read the DB) before `connect()`. Optional: an adapter
   * without one simply seeds nothing, and the daemon falls back to whatever
   * anchors this session's own traffic produced.
   */
  setAnchorProvider(provider: () => AnchorLike[]): void {
    this.anchorProvider = provider;
  }

  /**
   * Send the worker's anchors to the daemon (`seed_anchors`). Sent on every
   * daemon `ready` — a restart empties its map — and again immediately before an
   * extend, since an extend has no history push of its own and can only work
   * from anchors that already exist. Sending nothing is a no-op, not an error:
   * a fresh install has no messages to anchor from yet.
   */
  private seedAnchors(): void {
    const anchors = this.anchorProvider?.() ?? [];
    if (anchors.length === 0) return;
    this.log(`[whatsapp] seeding ${anchors.length} back-pagination anchors`);
    this.send({ cmd: "seed_anchors", anchors });
  }

  async extend(range: Range): Promise<void> {
    this.installedRange = range;
    // Anchors FIRST: the daemon paginates from its anchor map, and an extend
    // that arrives before the map is filled has nothing to page from.
    this.seedAnchors();
    this.send({ cmd: "extend", range });
  }

  async pause(paused: boolean): Promise<void> {
    this.setPaused(paused);
    this.send({ cmd: paused ? "pause" : "resume" });
  }

  async logout(): Promise<void> {
    // The daemon clears its session on `logout` and exits 0 (Rev 3 §R3.1). Mark
    // the imminent exit as intentional so the supervisor restarts it cleanly
    // into pairing instead of flapping to error/reconnecting (Rev 3 §R3.2).
    this.expectingLogoutExit = true;
    this.send({ cmd: "logout" });
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;

    // Graceful: send `shutdown`, then SIGTERM as a backstop, SIGKILL if it hangs.
    this.send({ cmd: "shutdown" });
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (this.killTimer) {
          clearTimeout(this.killTimer);
          this.killTimer = null;
        }
        resolve();
      };
      child.once("exit", done);
      this.killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done();
      }, SHUTDOWN_GRACE_MS);
      this.killTimer.unref?.();
    });
    this.child = null;
  }

  // ---- Spawn + supervise --------------------------------------------------

  private spawnDaemon(): void {
    const { bin, found } = resolveWhatsAppBin(this.binPath);
    const args = this.daemonArgs();
    const env = { ...process.env };

    this.ready = false;
    this.stdoutBuf = "";

    let child: ChildLike;
    try {
      child = this.spawnFn(bin, args, { env });
    } catch (err) {
      this.emitStatus({
        type: "error",
        code: "SPAWN_FAILED",
        message: `failed to spawn whatsapp daemon (${bin}): ${
          (err as Error).message
        }`,
        fatal: !found,
      });
      this.setState("error", `spawn failed: ${(err as Error).message}`);
      this.scheduleRestart();
      return;
    }

    this.child = child;
    this.setState("starting");

    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.onStdout(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const line = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim();
      if (line) this.log(`[whatsapp-go] ${line}`);
    });
    child.on("error", (err: Error) => {
      // Process-level failure (ENOENT/EACCES on spawn, etc.). Surface it as an
      // error state so /status doesn't sit at "starting" forever (D2); the exit
      // handler still schedules a backoff restart.
      this.status = {
        ...this.status,
        lastError: { code: "CHILD_ERROR", message: err.message },
      };
      this.emitStatus({
        type: "error",
        code: "CHILD_ERROR",
        message: err.message,
        fatal: false,
      });
      this.setState("error", `child error: ${err.message}`);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.child = null;
      this.ready = false;
      this.log(
        `[whatsapp-go] exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (this.shuttingDown) return;
      // Intentional post-logout/relink exit (Rev 3 §R3.2): the daemon cleared its
      // session and exited 0 on purpose. Restart PROMPTLY into pairing without a
      // scary error/reconnecting flap. Reset backoff so it comes back fast, and
      // clear paired (session is gone) so /status reflects the logged-out device.
      if (this.expectingLogoutExit) {
        this.expectingLogoutExit = false;
        this.restartCount = 0;
        this.status = { ...this.status, paired: false, jid: undefined };
        this.setState("starting", "restarting after logout");
        this.cleanRestart();
        return;
      }
      // Unexpected exit — surface + restart with backoff.
      this.setState("reconnecting", `daemon exited (code ${code ?? "?"})`);
      this.scheduleRestart();
    });
  }

  private daemonArgs(): string[] {
    const sessionDb = join(this.home, "whatsapp", "whatsmeow.db");
    const mediaDir = join(resolveMediaDir(this.home), "whatsapp");
    const args = [
      "--session-db",
      sessionDb,
      "--media-dir",
      mediaDir,
      "--log-level",
      "info",
    ];
    if (this.mock) args.push("--mock");
    return args;
  }

  /**
   * Prompt, backoff-free restart after an INTENTIONAL post-logout exit
   * (Rev 3 §R3.2). Unlike scheduleRestart(), this does not apply exponential
   * backoff — a fresh session-less daemon should come back fast and land on
   * need_pairing so the UI can show the QR. Honours autoRestart/shuttingDown so
   * tests that disable auto-restart still assert on a single exit.
   */
  private cleanRestart(): void {
    if (!this.autoRestart || this.shuttingDown) return;
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      this.spawnDaemon();
    }, this.backoffBaseMs);
    this.restartTimer.unref?.();
  }

  private scheduleRestart(): void {
    if (!this.autoRestart || this.shuttingDown) return;
    if (this.restartTimer) return;
    const delay = Math.min(
      this.backoffMaxMs,
      this.backoffBaseMs * 2 ** this.restartCount,
    );
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      this.spawnDaemon();
    }, delay);
    this.restartTimer.unref?.();
  }

  // ---- NDJSON framing (stdout) --------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
    // Guard against an unbounded partial line.
    if (this.stdoutBuf.length > 1_000_000) this.stdoutBuf = "";
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not protocol JSON — treat as a log line.
      this.log(`[whatsapp-go:stdout] ${line}`);
      return;
    }
    const t = msg["t"];
    switch (t) {
      case "ready":
        this.ready = true;
        this.restartCount = 0; // healthy boot resets backoff
        this.flushPending();
        // Re-install the import range on the fresh daemon BEFORE it connects, so
        // WhatsApp's automatic post-pairing history is filtered by the user's
        // chosen window instead of buffered/defaulted (the daemon resets its
        // in-memory range on every restart). No-op on a first pair with no range.
        if (this.installedRange) this.send({ cmd: "set_range", range: this.installedRange });
        // A fresh daemon's anchor map is empty. Re-seed it from the worker's DB
        // so back-pagination survives the restart.
        this.seedAnchors();
        break;
      case "status":
        this.handleStatusMsg(msg);
        break;
      case "qr":
        this.emitStatus({
          type: "qr",
          code: String(msg["code"] ?? ""),
          timeoutS: Number(msg["timeout_s"] ?? 0),
        });
        this.setState("pairing");
        break;
      case "paired":
        this.status = {
          ...this.status,
          paired: true,
          jid: str(msg["jid"]),
          pushName: str(msg["push_name"]),
        };
        this.emitStatus({
          type: "paired",
          jid: String(msg["jid"] ?? ""),
          pushName: String(msg["push_name"] ?? ""),
        });
        break;
      case "channel":
        this.handleStreamMsg(msg);
        break;
      case "actor":
        this.handleActorMsg(msg);
        break;
      case "event":
        this.handleEventMsg(msg);
        break;
      case "progress":
        this.handleProgressMsg(msg);
        break;
      case "history_sync":
        this.handleHistorySyncMsg(msg);
        break;
      case "backfill_complete": {
        const range = (msg["range"] as Range) ?? "all";
        const chats = Number(msg["chats"] ?? 0);
        const messages = Number(msg["messages"] ?? 0);
        // Authoritative import-completion signal: pin a done backfill snapshot
        // so a polled /status reliably reports completion regardless of daemon
        // frame ordering (a trailing live-phase progress frame must not hide it).
        const total = this.status.progress?.chatsTotal ?? chats;
        this.status = {
          ...this.status,
          progress: {
            phase: "backfill",
            chatsDone: total,
            chatsTotal: total,
            messages,
            done: true,
            range,
          },
        };
        this.emitStatus({ type: "backfill_complete", range, chats, messages });
        break;
      }
      case "error":
        this.handleErrorMsg(msg);
        break;
      default:
        // Unknown `t` — ignore for forward-compat (contract §1).
        break;
    }
  }

  private handleStatusMsg(msg: Record<string, unknown>): void {
    const state = (msg["state"] as SourceState) ?? this.status.state;
    const jid = str(msg["jid"]);
    const pushName = str(msg["push_name"]);
    this.status = {
      ...this.status,
      state,
      ...(jid ? { jid } : {}),
      ...(pushName ? { pushName } : {}),
      paired: this.status.paired || state === "online" || state === "connected",
    };
    if (state === "logged_out") {
      this.status = { ...this.status, paired: false, jid: undefined };
    }
    this.emitStatus({
      type: "status",
      state,
      detail: str(msg["detail"]),
      jid,
      pushName,
    });
  }

  /**
   * The daemon still says `channel` on the wire — it is a whatsmeow-shaped
   * protocol and this adapter is the boundary the rename happens at (arch §3.3
   * leak 6). Nothing past this line calls a stream a channel.
   */
  private handleStreamMsg(msg: Record<string, unknown>): void {
    const c = msg["channel"] as Stream | undefined;
    if (!c || typeof c.source_ext_id !== "string") return;
    for (const cb of this.streamCbs) cb(c);
  }

  private handleActorMsg(msg: Record<string, unknown>): void {
    const a = msg["actor"] as Actor | undefined;
    if (!a || typeof a.source_ext_id !== "string") return;
    if (a.is_self && a.source_ext_id) {
      // Track the self JID so the writer can flag fromMe.
      this.status = { ...this.status, jid: this.status.jid ?? a.source_ext_id };
    }
    for (const cb of this.actorCbs) cb(a);
  }

  private handleEventMsg(msg: Record<string, unknown>): void {
    const raw = msg["event"] as (SourceEvent & { channel_ext_id?: string }) | undefined;
    if (!raw || typeof raw.external_id !== "string") return;
    // The daemon speaks `channel_ext_id`; the worker speaks `stream_ext_id`.
    // One line, at the boundary, and the old name never travels further.
    const e: SourceEvent = {
      ...raw,
      stream_ext_id: raw.stream_ext_id ?? raw.channel_ext_id ?? "",
    };
    // The daemon emits the §3 Event shape verbatim, including the §R5.3/§R5.4
    // threading fields — `reply_to` ({ external_id, text, actor_ext_id }) on
    // quoted replies and `reply_to_external_id` (TARGET id) + `text` (emoji) on
    // kind='reaction' events. Both are declared on SourceEvent, so they pass
    // straight through to the ingest writer, which maps them onto the event row.
    // Kill-switch: when paused, drop events client-side too (belt+suspenders;
    // the daemon should also stop, but we never ingest while paused).
    if (this.status.paused) return;
    // Non-content chatter (receipts, acks, typing, presence) never becomes a
    // row, and a timestamp from the future is clamped before anything can sort
    // on it (evals A-021…A-030).
    const normalized = normalizeSourceEvent(e);
    if (!normalized) {
      this.log(`[whatsapp] dropped non-content frame kind=${String(e.kind)}`);
      return;
    }
    for (const cb of this.eventCbs) cb(normalized);
  }

  private handleProgressMsg(msg: Record<string, unknown>): void {
    const raw = msg as unknown as DaemonProgress;
    const progress: Progress = {
      phase: raw.phase === "live" ? "live" : "backfill",
      chatsDone: Number(msg["chats_done"] ?? 0),
      chatsTotal: Number(msg["chats_total"] ?? 0),
      messages: Number(msg["messages"] ?? 0),
      done: Boolean(msg["done"]),
      range: msg["range"] as Range | undefined,
    };
    // Always forward the raw frame to live (SSE) subscribers.
    this.emitStatus({ type: "progress", progress });
    // Snapshot rule (D1): a trailing live-phase frame must NOT overwrite a
    // completed backfill in the polled /status snapshot, or onboarding would
    // never observe done:true. Keep the completed backfill pinned.
    const prev = this.status.progress;
    if (progress.phase === "live" && prev?.phase === "backfill" && prev.done) {
      return;
    }
    this.status = { ...this.status, progress };
  }

  /**
   * One HistorySync payload was processed daemon-side. WhatsApp pushes a linked
   * device's archive as one small INITIAL_BOOTSTRAP payload followed by twenty
   * to thirty FULL chunks; when the server declines the bulk re-upload only the
   * bootstrap arrives and the import "finishes" holding one message per chat.
   * These per-payload counters are the only thing that can tell the two apart
   * with certainty, so they are forwarded verbatim for the ingest side to judge.
   *
   * The frame is OPTIONAL: on a daemon that never emits it nothing arrives here
   * and detection falls back to the shape of what landed. Every field defaults
   * to 0/"" so a partial frame degrades instead of throwing.
   */
  private handleHistorySyncMsg(msg: Record<string, unknown>): void {
    const payload: HistorySyncPayload = {
      syncType: String(msg["sync_type"] ?? ""),
      ...(msg["progress"] === undefined
        ? {}
        : { progress: Number(msg["progress"]) || 0 }),
      chats: Number(msg["chats"] ?? 0),
      chatsInRange: Number(msg["chats_in_range"] ?? 0),
      messagesSeen: Number(msg["messages_seen"] ?? 0),
      messagesInRange: Number(msg["messages_in_range"] ?? 0),
      messagesEmitted: Number(msg["messages_emitted"] ?? 0),
      messagesFiltered: Number(msg["messages_filtered"] ?? 0),
      onDemand: Boolean(msg["on_demand"]),
    };
    this.log(
      `[whatsapp] history_sync ${payload.syncType || "?"} chats=${payload.chats} ` +
        `seen=${payload.messagesSeen} in_range=${payload.messagesInRange} ` +
        `emitted=${payload.messagesEmitted} filtered=${payload.messagesFiltered}`,
    );
    this.emitStatus({ type: "history_sync", payload });
  }

  private handleErrorMsg(msg: Record<string, unknown>): void {
    const code = String(msg["code"] ?? "ERROR");
    const message = String(msg["message"] ?? "");
    const fatal = Boolean(msg["fatal"]);
    this.status = { ...this.status, lastError: { code, message } };
    this.emitStatus({ type: "error", code, message, fatal });
    if (fatal) this.setState("error", message);
  }

  // ---- Commands (stdin) ---------------------------------------------------

  private send(cmd: Record<string, unknown>): void {
    const line = JSON.stringify(cmd) + "\n";
    if (!this.ready || !this.child?.stdin) {
      this.pendingCommands.push(line);
      return;
    }
    try {
      this.child.stdin.write(line);
    } catch {
      // stdin closed mid-write; queue for the next healthy daemon.
      this.pendingCommands.push(line);
    }
  }

  private flushPending(): void {
    if (!this.child?.stdin) return;
    const queued = this.pendingCommands;
    this.pendingCommands = [];
    for (const line of queued) {
      try {
        this.child.stdin.write(line);
      } catch {
        this.pendingCommands.push(line);
      }
    }
  }

  // ---- Status helpers -----------------------------------------------------

  private setState(state: SourceState, detail?: string): void {
    if (this.status.state === state) return;
    this.status = { ...this.status, state };
    this.emitStatus({ type: "status", state, detail });
  }

  private emitStatus(s: StatusUpdate): void {
    for (const cb of this.statusCbs) cb(s);
  }
}

// ---- Default spawn (real child process) -----------------------------------

const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const child = nodeSpawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env,
  });
  return child as unknown as ChildLike;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

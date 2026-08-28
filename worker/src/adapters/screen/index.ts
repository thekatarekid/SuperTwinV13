// ===========================================================================
// Screen watcher public surface (build P2.1).
//
// `startScreenWatcher()` is the production entrypoint worker boot calls:
// wires the single-writer sink, spawns + supervises the screenwatch sidecar,
// and never throws — a machine without the binary degrades to an error
// status while the worker keeps serving. The started adapter is registered
// module-level so the HTTP surface (server/screen-routes.ts) can read status
// and drive pause without boot-order plumbing.
// ===========================================================================

import { ScreenAdapter, type ScreenAdapterOptions } from "./adapter.js";
import { ScreenEventlogSink } from "./sink.js";

export {
  nodePrivacyVeto,
  PASSWORD_MANAGER_BUNDLE_PREFIXES,
  resolveScreenwatchBin,
  ScreenAdapter,
  type ChildLike,
  type ScreenAdapterOptions,
  type ScreenAdapterStatus,
  type SpawnFn,
} from "./adapter.js";
export {
  collectLinks,
  SCREEN_SOURCE_ID,
  screenEventHash,
  toScreenEnvelope,
  type PendingRef,
  type ScreenSnapshotPayload,
} from "./envelope.js";
export {
  isSnapshotFrame,
  type ScreenDropFrame,
  type ScreenFrame,
  type ScreenState,
  type ScreenTrigger,
  type SnapshotFrame,
} from "./frames.js";
export { MemoryScreenSink, ScreenEventlogSink, type ScreenEventSink } from "./sink.js";

let current: ScreenAdapter | null = null;

/** The running adapter (null before startScreenWatcher / in bare tests). */
export function getScreenAdapter(): ScreenAdapter | null {
  return current;
}

/**
 * Production wiring: spawn + supervise the sidecar, append `screen.snapshot`
 * events via the single-writer. Never throws; returns the adapter (connected).
 */
export function startScreenWatcher(opts: ScreenAdapterOptions = {}): ScreenAdapter {
  const log = opts.log ?? ((line: string) => console.error(line));
  const adapter = new ScreenAdapter({
    sink: opts.sink ?? new ScreenEventlogSink(log),
    log,
    ...opts,
  });
  current = adapter;
  void adapter.connect();
  return adapter;
}

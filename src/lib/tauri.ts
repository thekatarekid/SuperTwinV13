// ===========================================================================
// Tauri glue — build P1.7. The shell runs identically in a plain browser
// (dev server, vitest) and inside Tauri; everything Tauri-specific funnels
// through here behind a runtime check so tests never touch the IPC.
// ===========================================================================

/** True when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The app command (src-tauri/src/opener.rs) that hands a URL to the OS. */
const OPEN_EXTERNAL_COMMAND = "open_external";

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Open a URL outside the webview (P2.1: the Accessibility deep link into
 * System Settings).
 *
 * Inside Tauri this goes through the app's own `open_external` command, NOT
 * `shell.open()`: the shell plugin validates JS opens against an OpenScope
 * whose default regex only admits `mailto:` / `tel:` / `http(s)://`, so the
 * `x-apple.systempreferences:` deep link was rejected outright. The plugin is
 * still tried as a fallback (it works for ordinary web links).
 *
 * This REJECTS when nothing could open the URL. The previous version
 * swallowed every error and fell through to `window.open`, which is a silent
 * no-op for OS-scheme URLs in WKWebView — that is the whole reason "Open
 * System Settings" appeared to do nothing. Callers must render the failure.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const failures: string[] = [];
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke(OPEN_EXTERNAL_COMMAND, { url });
      return;
    } catch (err) {
      failures.push(`app opener: ${errorText(err)}`);
    }
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    } catch (err) {
      failures.push(`shell plugin: ${errorText(err)}`);
    }
    throw new Error(failures.join(" · "));
  }

  // Plain browser (dev server / tests): only web URLs can be handed to the
  // browser. window.open is inert for OS-scheme URLs, so say so rather than
  // pretending the click worked.
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `${url} can only be opened by the desktop app, not a browser tab`,
    );
  }
  try {
    window.open(url, "_blank", "noopener");
  } catch (err) {
    throw new Error(errorText(err));
  }
}

// ---- The Accessibility ASK (V6 P1 S6d / L4) --------------------------------

/** src-tauri/src/accessibility.rs — the ask and the prompt-free read. */
const REQUEST_ACCESSIBILITY_COMMAND = "request_accessibility";
const ACCESSIBILITY_STATUS_COMMAND = "accessibility_status";

export interface AccessibilityState {
  trusted: boolean;
  /** True when this call put the system dialog up (and created the row). */
  prompted: boolean;
}

/**
 * ASK macOS for the Accessibility permission — the call that makes SuperTwin
 * appear in System Settings › Privacy & Security › Accessibility.
 *
 * This runs in the HOST APP, not the sidecar, so the row carries the app's own
 * identity, name and icon, and so the same grant covers the app's own event tap
 * (the double-tap-right-⌘ summon). Returns null outside Tauri, and null when
 * the running shell predates the command — the caller then falls back to the
 * worker's POST /api/screen/request-permission, which asks through the
 * screenwatch sidecar and lands on the very same TCC row.
 *
 * `trusted: false` right after asking is normal: macOS creates the row and
 * shows its dialog asynchronously. Poll afterwards.
 */
export async function requestAccessibility(): Promise<AccessibilityState | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<AccessibilityState>(REQUEST_ACCESSIBILITY_COMMAND);
  } catch {
    return null;
  }
}

/** The prompt-free read of the same right. Null outside Tauri. */
export async function accessibilityStatus(): Promise<AccessibilityState | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<AccessibilityState>(ACCESSIBILITY_STATUS_COMMAND);
  } catch {
    return null;
  }
}

/**
 * Esc-dismiss (spec §14.1.2): hide the main window. The Rust side owns the
 * summon half (double-tap right-⌘ / ⌘⇧S). No-op outside Tauri.
 */
export async function hideMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  } catch {
    // Dismiss must never throw into the UI; worst case the window stays up.
  }
}

// ---- Menu bar tray + panel + nudge glue (P2.3, spec §14.7) -----------------

async function invokeTray(cmd: string, args?: Record<string, unknown>): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(cmd, args ?? {});
  } catch {
    // Tray IPC must never throw into the UI.
  }
}

/** Update the tray glyph: ◉ idle · ⏺ recording · ◔ processing · ● needs you (n) · ⏸ paused. */
export async function setTrayState(
  state: "idle" | "recording" | "processing" | "needs_you" | "paused",
  needsYou = 0,
): Promise<void> {
  await invokeTray("set_tray_state", { state, needsYou });
}

/**
 * Commands the Rust tray menu / hotkey emit for the panel to carry out
 * (V6 S1.7): the menu bar has no HTTP client, the panel does. Payload is the
 * bare command string. Returns an unlisten function; a no-op outside Tauri.
 */
export type TrayCommand = "private-moment" | "stop-capture" | "forget-10";
export const TRAY_COMMAND_EVENT = "supertwin:capture-command";

export async function onTrayCommand(cb: (cmd: TrayCommand) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<string>(TRAY_COMMAND_EVENT, (e) => {
      const cmd = e.payload;
      if (cmd === "private-moment" || cmd === "stop-capture" || cmd === "forget-10") cb(cmd);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

/** Show the transient top-right nudge card (one at a time, non-focusing). */
export async function showNudgeWindow(): Promise<void> {
  await invokeTray("show_nudge");
}

/** Hide the nudge card (auto-minimize or an action fired). */
export async function hideNudgeWindow(): Promise<void> {
  await invokeTray("hide_nudge");
}

/** Hide the menu-bar panel (Esc / after routing into the main window). */
export async function hidePanelWindow(): Promise<void> {
  await invokeTray("hide_panel");
}

/** Show + focus the main window (panel rows and the mini ask-bar route here). */
export async function openMainWindow(): Promise<void> {
  await invokeTray("open_main");
}

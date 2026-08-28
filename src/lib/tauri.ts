// ===========================================================================
// Tauri glue — build P1.7. The shell runs identically in a plain browser
// (dev server, vitest) and inside Tauri; everything Tauri-specific funnels
// through here behind a runtime check so tests never touch the IPC.
// ===========================================================================

/** True when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Open a URL outside the webview (P2.1: the Accessibility deep link into
 * System Settings). Inside Tauri this goes through the shell plugin (the
 * default capability includes `open`); in a plain browser it falls back to
 * window.open, which is inert for OS-scheme URLs — fine for dev.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    } catch {
      // fall through to window.open
    }
  }
  try {
    window.open(url, "_blank", "noopener");
  } catch {
    // opening must never throw into the UI
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

/** Update the tray glyph: ◉ idle · ◔ processing · ● needs you (n) · ⏸ paused. */
export async function setTrayState(
  state: "idle" | "processing" | "needs_you" | "paused",
  needsYou = 0,
): Promise<void> {
  await invokeTray("set_tray_state", { state, needsYou });
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

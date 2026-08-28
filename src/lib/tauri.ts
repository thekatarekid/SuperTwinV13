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

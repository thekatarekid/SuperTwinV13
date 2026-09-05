// SuperTwinV13 — menu bar tray + panel + nudge windows (build P2.3, spec §14.7).
//
// The tray is a TEMPLATE icon (monochrome, macOS re-tints it) with a state
// glyph rendered as the tray TITLE next to it:
//
//   ◉ idle · ⏺ recording · ◔ processing · ● needs you (n) · ⏸ capture paused
//
// Left-clicking the tray toggles the 360px glass PANEL window (label
// "panel"), which loads the same Vite bundle with `#panel` — the React side
// renders the §14.7 anatomy (Needs-you / Prepared / Today / ask-bar /
// quick-pause) and drives the tray state through the `set_tray_state` command
// as it polls the worker's REAL capture state (/api/capture/state — V6 S1.7,
// T4-9: the glyph is the funnel's answer, not an assist flag).
//
// Right-clicking opens the menu: "Private moment (15 min)", "Stop capture",
// "Forget last 10 min…", "Open SuperTwin". The shell has no HTTP client, so a
// menu item EMITS `supertwin:capture-command` with the command string and the
// panel (always alive, hidden) carries it out against the worker. The ⌘⇧P
// hotkey (hotkey.rs) emits the same private-moment command.
//
// The NUDGE window (label "nudge", top-right, one at a time) also always
// exists and stays hidden; its React half polls /api/assist/nudge and calls
// `show_nudge` / `hide_nudge` around the transient card (auto-minimize is the
// frontend's timer). Both windows are created lazily and never closed — hide,
// don't destroy, so state survives.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder,
};

const TRAY_ID: &str = "supertwin-tray";
pub const PANEL_LABEL: &str = "panel";
pub const NUDGE_LABEL: &str = "nudge";

const PANEL_WIDTH: f64 = 360.0;
const PANEL_HEIGHT: f64 = 540.0;
const NUDGE_WIDTH: f64 = 380.0;
const NUDGE_HEIGHT: f64 = 200.0;
const SCREEN_MARGIN: f64 = 12.0;

/// The event the tray menu / hotkey emit; the panel listens (lib/tauri.ts).
pub const CAPTURE_COMMAND_EVENT: &str = "supertwin:capture-command";
pub const CMD_PRIVATE_MOMENT: &str = "private-moment";
pub const CMD_STOP_CAPTURE: &str = "stop-capture";
pub const CMD_FORGET_10: &str = "forget-10";

const MENU_PRIVATE: &str = "tray-private-moment";
const MENU_STOP: &str = "tray-stop-capture";
const MENU_FORGET: &str = "tray-forget-10";
const MENU_OPEN: &str = "tray-open-main";

/// Emit a capture command for the panel to carry out. Also makes sure the
/// panel window exists (hidden is fine — its React app is polling).
pub fn emit_capture_command(app: &AppHandle, cmd: &str) {
    let _ = ensure_panel(app);
    if let Err(err) = app.emit(CAPTURE_COMMAND_EVENT, cmd.to_string()) {
        eprintln!("[supertwinv13] capture command emit failed ({cmd}): {err}");
    }
}

/// The §14.7 tray states (+ ⏺ recording, V6 S1.7), rendered as the tray title glyph.
pub fn glyph_for(state: &str, needs_you: u32) -> String {
    match state {
        "recording" => "⏺".to_string(),
        "processing" => "◔".to_string(),
        "needs_you" => {
            if needs_you > 1 {
                format!("● {needs_you}")
            } else {
                "●".to_string()
            }
        }
        "paused" => "⏸".to_string(),
        _ => "◉".to_string(),
    }
}

/// Ensure the panel window exists (hidden). Returns it.
fn ensure_panel(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(PANEL_LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("index.html#panel".into()))
        .title("SuperTwin")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build();
    match built {
        Ok(w) => {
            // Same liquid-glass treatment as the main window (best-effort).
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&w, NSVisualEffectMaterial::Popover, None, Some(16.0));
            }
            Some(w)
        }
        Err(err) => {
            eprintln!("[supertwinv13] panel window build failed: {err}");
            None
        }
    }
}

/// Ensure the nudge window exists (hidden). Non-activating: showing it never
/// steals focus from what the user is doing.
fn ensure_nudge(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(NUDGE_LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(app, NUDGE_LABEL, WebviewUrl::App("index.html#nudge".into()))
        .title("SuperTwin nudge")
        .inner_size(NUDGE_WIDTH, NUDGE_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(w) => {
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&w, NSVisualEffectMaterial::Popover, None, Some(16.0));
            }
            Some(w)
        }
        Err(err) => {
            eprintln!("[supertwinv13] nudge window build failed: {err}");
            None
        }
    }
}

/// Top-right logical position for a window of `width` on the primary monitor.
fn top_right(app: &AppHandle, width: f64) -> LogicalPosition<f64> {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        return LogicalPosition::new(size.width - width - SCREEN_MARGIN, SCREEN_MARGIN + 24.0);
    }
    LogicalPosition::new(SCREEN_MARGIN, SCREEN_MARGIN)
}

/// Toggle the panel under the tray icon (top-right fallback when the click
/// position is unknown).
pub fn toggle_panel(app: &AppHandle, at: Option<LogicalPosition<f64>>) {
    let Some(panel) = ensure_panel(app) else { return };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    let pos = at
        .map(|p| LogicalPosition::new(p.x - PANEL_WIDTH / 2.0, p.y + 8.0))
        .unwrap_or_else(|| top_right(app, PANEL_WIDTH));
    let _ = panel.set_position(pos);
    let _ = panel.show();
    let _ = panel.set_focus();
}

// ---------------------------------------------------------------------------
// Commands (the panel/nudge React apps call these)
// ---------------------------------------------------------------------------

/// Update the tray glyph: state ∈ idle|recording|processing|needs_you|paused.
#[tauri::command]
pub fn set_tray_state(app: AppHandle, state: String, needs_you: Option<u32>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(glyph_for(&state, needs_you.unwrap_or(0))));
        let _ = tray.set_tooltip(Some(tooltip_for(&state)));
    }
}

/// Hover text — says what the glyph means, in words.
pub fn tooltip_for(state: &str) -> &'static str {
    match state {
        "recording" => "SuperTwin — capturing (right-click to stop)",
        "paused" => "SuperTwin — capture paused",
        "processing" => "SuperTwin — processing",
        "needs_you" => "SuperTwin — needs you",
        _ => "SuperTwin",
    }
}

/// Show the transient nudge card, top-right, WITHOUT stealing focus.
#[tauri::command]
pub fn show_nudge(app: AppHandle) {
    let Some(nudge) = ensure_nudge(&app) else { return };
    let _ = nudge.set_position(top_right(&app, NUDGE_WIDTH));
    let _ = nudge.show();
}

/// Hide the nudge card (auto-minimize timer or an action fired).
#[tauri::command]
pub fn hide_nudge(app: AppHandle) {
    if let Some(nudge) = app.get_webview_window(NUDGE_LABEL) {
        let _ = nudge.hide();
    }
}

/// Hide the panel (Esc / after an action).
#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.hide();
    }
}

/// Open + focus the main window (panel rows and the mini ask-bar route here).
#[tauri::command]
pub fn open_main(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Build the tray icon + pre-create both auxiliary windows (hidden). Failures
/// log and continue: a machine without a status bar still runs the app.
pub fn setup(app: &AppHandle) {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"));
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon_as_template(true)
        .title("◉")
        .tooltip("SuperTwin")
        // Left click = panel; the menu is right-click only.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_PRIVATE => emit_capture_command(app, CMD_PRIVATE_MOMENT),
            MENU_STOP => emit_capture_command(app, CMD_STOP_CAPTURE),
            MENU_FORGET => emit_capture_command(app, CMD_FORGET_10),
            MENU_OPEN => open_main(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                let app = tray.app_handle();
                let scale = app
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .map(|m| m.scale_factor())
                    .unwrap_or(1.0);
                toggle_panel(app, Some(position.to_logical::<f64>(scale)));
            }
        });
    match icon {
        Ok(img) => builder = builder.icon(img),
        Err(err) => eprintln!("[supertwinv13] tray template icon unreadable: {err}"),
    }
    // The right-click menu (V6 S1.7): one click stops capture; the private
    // moment is fifteen minutes and not a setting.
    let menu = MenuItem::with_id(app, MENU_PRIVATE, "Private moment (15 min)\t⌘⇧P", true, None::<&str>)
        .and_then(|private| {
            let stop = MenuItem::with_id(app, MENU_STOP, "Stop capture", true, None::<&str>)?;
            let forget = MenuItem::with_id(app, MENU_FORGET, "Forget last 10 min…", true, None::<&str>)?;
            let open = MenuItem::with_id(app, MENU_OPEN, "Open SuperTwin", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            Menu::with_items(app, &[&private, &stop, &forget, &sep, &open])
        });
    match menu {
        Ok(m) => builder = builder.menu(&m),
        Err(err) => eprintln!("[supertwinv13] tray menu unavailable: {err}"),
    }
    if let Err(err) = builder.build(app) {
        eprintln!("[supertwinv13] tray unavailable: {err}");
    }

    // Pre-create the aux windows so first use is instant.
    let _ = ensure_panel(app);
    let _ = ensure_nudge(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyphs_cover_every_state_including_recording() {
        assert_eq!(glyph_for("idle", 0), "◉");
        assert_eq!(glyph_for("recording", 0), "⏺");
        assert_eq!(glyph_for("processing", 0), "◔");
        assert_eq!(glyph_for("needs_you", 1), "●");
        assert_eq!(glyph_for("needs_you", 3), "● 3");
        assert_eq!(glyph_for("paused", 0), "⏸");
        assert_eq!(glyph_for("anything-else", 0), "◉");
    }

    #[test]
    fn tooltips_name_the_state() {
        assert!(tooltip_for("recording").contains("capturing"));
        assert!(tooltip_for("paused").contains("paused"));
        assert_eq!(tooltip_for("idle"), "SuperTwin");
    }

    #[test]
    fn commands_match_the_panel_listener() {
        // lib/tauri.ts accepts exactly these three strings on this event.
        assert_eq!(CAPTURE_COMMAND_EVENT, "supertwin:capture-command");
        assert_eq!(CMD_PRIVATE_MOMENT, "private-moment");
        assert_eq!(CMD_STOP_CAPTURE, "stop-capture");
        assert_eq!(CMD_FORGET_10, "forget-10");
    }
}

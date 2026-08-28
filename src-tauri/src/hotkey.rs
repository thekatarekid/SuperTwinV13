// SuperTwinV13 — global summon hotkey (build P1.7, spec §14.1.2).
//
// The main window is summoned by DOUBLE-TAPPING the RIGHT ⌘ key. A bare
// modifier can't be a registered global shortcut, so on macOS we listen to
// `flagsChanged` events through a listen-only CGEventTap on a dedicated
// thread and run the tap-interval detection here in Rust: two right-⌘
// presses within the window (400 ms), with nothing else pressed in between,
// toggle the window.
//
// The detector itself is pure (`TapDetector`) and unit-tested; the event tap
// is the thin OS layer around it. If the tap can't be created (macOS
// Accessibility permission not granted yet) we log and continue — the
// registered fallback shortcut (⌘⇧S, spec §14.7) still summons the window.

use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Two taps within this window count as a double-tap (¬ a hold, ¬ two
/// deliberate presses). Matches the usual double-tap-modifier feel.
pub const DOUBLE_TAP_WINDOW: Duration = Duration::from_millis(400);

/// Pure double-tap detection over a monotonic clock the caller supplies.
/// `record_tap` returns true exactly when the tap COMPLETES a double-tap;
/// any other key pressed between taps must be reported via `reset` so
/// ⌘C / right-⌘-chords never summon the window.
pub struct TapDetector {
    window: Duration,
    last_tap: Option<Duration>,
}

impl TapDetector {
    pub fn new(window: Duration) -> Self {
        Self { window, last_tap: None }
    }

    /// A right-⌘ press at `now` (time since an arbitrary epoch).
    pub fn record_tap(&mut self, now: Duration) -> bool {
        let fired = match self.last_tap {
            Some(prev) => now >= prev && now - prev <= self.window,
            None => false,
        };
        // A completed double-tap consumes both taps (a triple-tap is one
        // summon + a fresh first tap, not two summons).
        self.last_tap = if fired { None } else { Some(now) };
        fired
    }

    /// Any other key/chord activity between taps cancels the pending tap.
    pub fn reset(&mut self) {
        self.last_tap = None;
    }
}

/// Show+focus the main window if hidden, hide it if visible (the summon
/// toggle). Esc-dismiss is the frontend's half: it calls window.hide().
pub fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Register the configurable fallback shortcut (⌘⇧S) through the global
/// shortcut plugin. Called from setup; failures log and continue.
pub fn register_fallback_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyS);
    let result = app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |handle, fired, event| {
                if fired == &shortcut && event.state() == ShortcutState::Pressed {
                    toggle_main_window(handle);
                }
            })
            .build(),
    );
    match result {
        Ok(()) => {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(err) = app.global_shortcut().register(shortcut) {
                eprintln!("[supertwinv13] fallback shortcut register failed: {err}");
            }
        }
        Err(err) => eprintln!("[supertwinv13] global-shortcut plugin init failed: {err}"),
    }
}

/// Start the right-⌘ double-tap listener (macOS). Spawns a dedicated thread
/// owning a listen-only CGEventTap + its runloop; on a completed double-tap
/// it toggles the main window on the main thread.
#[cfg(target_os = "macos")]
pub fn start_double_tap_listener(app: &AppHandle) {
    use std::time::Instant;

    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        EventField,
    };

    /// macOS virtual keycode for the RIGHT command key.
    const RIGHT_COMMAND_KEYCODE: i64 = 54;
    /// NX_DEVICERCMDKEYMASK — set while the right ⌘ key is physically down.
    const DEVICE_RIGHT_CMD_MASK: u64 = 0x0000_0010;

    let handle = app.clone();
    std::thread::Builder::new()
        .name("right-cmd-double-tap".into())
        .spawn(move || {
            let epoch = Instant::now();
            // The tap callback is `Fn`, so the detector lives behind a
            // RefCell; the callback only ever runs on this thread's runloop.
            let detector = std::cell::RefCell::new(TapDetector::new(DOUBLE_TAP_WINDOW));

            let tap = CGEventTap::new(
                CGEventTapLocation::HID,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
                move |_proxy, event_type, event| {
                    match event_type {
                        CGEventType::KeyDown => {
                            // A real keystroke between taps means a chord
                            // (right-⌘C…), not a summon.
                            detector.borrow_mut().reset();
                        }
                        CGEventType::FlagsChanged => {
                            let keycode =
                                event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                            if keycode == RIGHT_COMMAND_KEYCODE {
                                let flags = event.get_flags().bits();
                                let pressed = flags & DEVICE_RIGHT_CMD_MASK != 0;
                                if pressed && detector.borrow_mut().record_tap(epoch.elapsed()) {
                                    let h = handle.clone();
                                    // Window calls must run on the main thread.
                                    let _ = h.clone().run_on_main_thread(move || {
                                        toggle_main_window(&h);
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                    None // listen-only: never swallow or rewrite the event
                },
            );

            match tap {
                Ok(tap) => {
                    let current = CFRunLoop::get_current();
                    match tap.mach_port.create_runloop_source(0) {
                        Ok(source) => {
                            unsafe { current.add_source(&source, kCFRunLoopCommonModes) };
                            tap.enable();
                            println!("[supertwinv13] right-⌘ double-tap listener running");
                            CFRunLoop::run_current();
                        }
                        Err(_) => eprintln!(
                            "[supertwinv13] event tap runloop source failed — double-tap disabled"
                        ),
                    }
                }
                Err(_) => eprintln!(
                    "[supertwinv13] event tap unavailable (grant Accessibility permission) — \
                     double-tap right-⌘ disabled, ⌘⇧S still works"
                ),
            }
        })
        .expect("spawn hotkey listener thread");
}

#[cfg(not(target_os = "macos"))]
pub fn start_double_tap_listener(_app: &AppHandle) {
    // Double-tap right-⌘ is a macOS gesture; other platforms use ⌘⇧S only.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn two_taps_inside_the_window_fire() {
        let mut d = TapDetector::new(DOUBLE_TAP_WINDOW);
        assert!(!d.record_tap(ms(1000)));
        assert!(d.record_tap(ms(1300)));
    }

    #[test]
    fn slow_taps_do_not_fire() {
        let mut d = TapDetector::new(DOUBLE_TAP_WINDOW);
        assert!(!d.record_tap(ms(1000)));
        assert!(!d.record_tap(ms(1500))); // 500ms > 400ms window
        // …but that second tap starts a new sequence:
        assert!(d.record_tap(ms(1700)));
    }

    #[test]
    fn a_triple_tap_fires_once_and_restarts() {
        let mut d = TapDetector::new(DOUBLE_TAP_WINDOW);
        assert!(!d.record_tap(ms(0)));
        assert!(d.record_tap(ms(200)));
        assert!(!d.record_tap(ms(400))); // consumed — this is a fresh first tap
        assert!(d.record_tap(ms(600)));
    }

    #[test]
    fn an_interleaved_keystroke_cancels_the_pending_tap() {
        let mut d = TapDetector::new(DOUBLE_TAP_WINDOW);
        assert!(!d.record_tap(ms(0)));
        d.reset(); // right-⌘C chord
        assert!(!d.record_tap(ms(200)));
        assert!(d.record_tap(ms(300)));
    }
}

// ===========================================================================
// SuperTwinV13 — the macOS Accessibility permission ASK (V6 P1 S6d / L4).
//
// WHAT WAS BROKEN. SuperTwinV13 did not appear in System Settings › Privacy &
// Security › Accessibility at all — the pane the "Open System Settings" button
// deep-links to showed a long list of other apps and no SuperTwin row, so the
// permission could not be granted no matter what the user did, and screen
// capture could never start. The reason is that nothing in the tree ever
// ASKED. macOS adds an application to that list when a process calls
//
//     AXIsProcessTrustedWithOptions({ kAXTrustedCheckOptionPrompt: true })
//
// and at no other time. `AXIsProcessTrusted()` (which the sidecar called) is a
// read: it reports and registers nothing. A `CGEventTap` that fails for want
// of the right (hotkey.rs) registers nothing either — it just returns an
// error. So the app was invisible to TCC by construction.
//
// WHY THE HOST APP IS THE REQUESTING IDENTITY. TCC attributes an accessibility
// request to the RESPONSIBLE process, and a child inherits its parent's
// responsibility. Measured against the shipping 13.11.5 bundle with
// `responsibility_get_pid_responsible_for_pid`:
//
//     /Applications/SuperTwinV13.app/Contents/MacOS/supertwinv13  -> itself
//     Contents/MacOS/node          (the worker, child)            -> the app
//     Resources/worker/bin/whatsapp-go (sidecar, grandchild)      -> the app
//
// so every helper we spawn is already attributed to the app. Asking from HERE
// is therefore the same TCC row as asking from the sidecar, with two
// advantages: the row carries the app's own bundle identity, name and icon
// rather than a bare helper binary's, and this process needs the very same
// right for its own listen-only CGEventTap (the double-tap-right-⌘ summon in
// hotkey.rs, which has been silently disabled for exactly this reason).
// `screenwatch --request-permission` exists as the worker-side path and lands
// on the same row.
//
// WHEN IT ASKS. Only on an explicit user action — the "Allow screen capture"
// button in Library › Screen. Never at launch: an unprompted permission dialog
// on first run is precisely the thing this product does not do.
//
// NOTE ON AD-HOC SIGNING. This app is ad-hoc signed (no Team ID), so the TCC
// row is pinned to the build's cdhash and a NEW build reads as a different
// program: the grant does not survive an app update, and the stale row has to
// be removed (−) and re-added. `trusted()` reports the live truth on every
// poll, so the UI can say so instead of insisting the permission is on.
// ===========================================================================

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::base::Boolean;
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use core_foundation_sys::string::CFStringRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> Boolean;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> Boolean;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    /// Is this process (responsible: this app) trusted for Accessibility?
    /// A pure read — no dialog, no TCC row, safe to poll.
    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    /// ASK for Accessibility. Puts up the system dialog and — the point of the
    /// whole module — makes macOS list this app in the Accessibility pane.
    ///
    /// Returns the CURRENT trust state, which is `false` on a first ask: the
    /// call does not block on the dialog. The caller polls `trusted()` after.
    pub fn request() -> bool {
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let options =
                CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// Accessibility is a macOS concept; elsewhere there is nothing to gate.
    pub fn trusted() -> bool {
        true
    }
    pub fn request() -> bool {
        true
    }
}

/// The answer both commands return. `prompted` distinguishes "we asked and the
/// user has not ticked the row yet" from a plain read, so the UI can keep
/// polling with the right words instead of declaring failure.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccessibilityState {
    pub trusted: bool,
    pub prompted: bool,
}

/// Read the live trust state. No dialog. Cheap enough to poll every second.
#[tauri::command]
pub fn accessibility_status() -> AccessibilityState {
    AccessibilityState {
        trusted: imp::trusted(),
        prompted: false,
    }
}

/// Ask macOS for Accessibility — the call that creates the System Settings row.
///
/// Idempotent: once the row exists macOS stops showing the dialog, and the call
/// degrades into a read. Calling it when already trusted is a no-op that
/// returns `trusted: true`.
#[tauri::command]
pub fn request_accessibility() -> AccessibilityState {
    if imp::trusted() {
        return AccessibilityState {
            trusted: true,
            prompted: false,
        };
    }
    let trusted = imp::request();
    println!(
        "[supertwinv13] asked macOS for Accessibility (AXIsProcessTrustedWithOptions prompt) — trusted={trusted}"
    );
    AccessibilityState {
        trusted,
        prompted: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A read must never ask: `accessibility_status` is polled by the panel,
    /// and a dialog per poll would be unusable.
    #[test]
    fn status_never_reports_a_prompt() {
        assert!(!accessibility_status().prompted);
    }

    /// The command surface the UI invokes has to be registered, or the button
    /// silently falls through to the worker path and the ask never happens.
    #[test]
    fn both_commands_are_registered_on_the_builder() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("mod accessibility;"), "accessibility module must be declared");
        assert!(
            lib.contains("accessibility::request_accessibility"),
            "request_accessibility must be in tauri::generate_handler!"
        );
        assert!(
            lib.contains("accessibility::accessibility_status"),
            "accessibility_status must be in tauri::generate_handler!"
        );
    }

    /// The ask and the check must agree once the right is granted: whatever
    /// this machine's state is, `request()` on an already-trusted process is a
    /// read that returns true.
    #[test]
    fn asking_while_trusted_is_a_read() {
        if imp::trusted() {
            let state = request_accessibility();
            assert!(state.trusted);
            assert!(!state.prompted, "no dialog once the row is ticked");
        }
    }
}

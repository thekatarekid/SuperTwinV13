// ===========================================================================
// Accessibility permission modes (V6 P1 S6d / L4).
//
// WHY THIS FILE EXISTS. Until 13.11.5 the sidecar only ever called
// `AXIsProcessTrusted()` — "report, never ask". macOS adds an application to
// System Settings › Privacy & Security › Accessibility ONLY when a process
// asks, i.e. calls `AXIsProcessTrustedWithOptions` with
// `kAXTrustedCheckOptionPrompt: true`. A prompt-free check adds nothing, and
// a CGEventTap that fails for want of the right adds nothing either. So
// SuperTwin never appeared in that list, the deep link landed the user on a
// pane with no row to tick, and screen capture could never be granted. The
// missing call is the whole bug.
//
// WHICH IDENTITY ASKS. TCC attributes an accessibility request to the
// *responsible* process, not the calling one — a child inherits its parent's
// responsibility unless it disclaims. Measured on the shipping 13.11.5 app
// with `responsibility_get_pid_responsible_for_pid`:
//
//     SuperTwinV13.app (pid P)                 -> responsible P
//     Contents/MacOS/node (worker, child of P) -> responsible P
//     Resources/worker/bin/whatsapp-go         -> responsible P   (grandchild)
//
// so a `screenwatch` spawned by the worker is attributed to SuperTwinV13.app.
// Whoever asks, the row that appears is the APP, and ticking it makes
// `AXIsProcessTrusted()` true inside this sidecar. The host app asks too
// (src-tauri/src/accessibility.rs) because it needs the same right for its own
// CGEventTap; both requests land on one row.
//
// The parse lives here, away from ApplicationServices, so ./test.sh can
// exercise it with zero permissions.
// ===========================================================================

import Foundation

/// What a run of the binary should do about the Accessibility permission.
public enum PermissionMode: Equatable, Sendable {
    /// Normal run: capture (live) or replay (mock). Never touches the prompt.
    case capture
    /// `--check-permission`: report `AXIsProcessTrusted()` and exit. Asks nothing.
    case check
    /// `--request-permission`: ask via `AXIsProcessTrustedWithOptions(prompt:)`,
    /// report the answer and exit. This is the call that puts the app in the list.
    case request
}

public let checkPermissionFlag = "--check-permission"
public let requestPermissionFlag = "--request-permission"

/// Decide the permission mode from the argument list (argv without argv[0]).
///
/// `--request-permission` wins over `--check-permission` when both are given:
/// asking answers the check as a side effect, so the caller still gets a
/// truthful `granted`, and the stronger intent is the one to honour.
public func permissionMode(from args: [String]) -> PermissionMode {
    if args.contains(requestPermissionFlag) { return .request }
    if args.contains(checkPermissionFlag) { return .check }
    return .capture
}

/// The single frame either permission mode prints. `prompted` records whether
/// this run actually asked, so the worker can tell "granted" from "asked and
/// still waiting for the user to tick the row".
public func permissionFrame(granted: Bool, prompted: Bool) -> [String: String] {
    return [
        "t": "permission",
        "granted": granted ? "true" : "false",
        "prompted": prompted ? "true" : "false",
    ]
}

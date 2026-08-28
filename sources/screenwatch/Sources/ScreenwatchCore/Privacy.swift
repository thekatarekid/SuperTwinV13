// ===========================================================================
// Privacy filter (build P2.1, spec §4.3) — IN the sidecar, before anything
// is hashed, diffed, or written to stdout.
//
// Two hard rules:
//   1. Private/incognito windows (Safari / Chrome / Arc): dropped. Detected
//      via the browser's AX attribute when the live layer saw one, and via
//      window-title markers as the belt-and-suspenders fallback.
//   2. Password-manager windows: their AX text NEVER enters the log. Matched
//      by bundle-id prefix against a blocklist.
//
// Plus the runtime pause switches: global pause and per-app pause (stdin
// commands), both drop-before-processing.
// ===========================================================================

import Foundation

/// Bundle-id prefixes of password managers (lowercased). Prefix match so
/// helper/agent variants (`com.1password.1password-launcher`, …) are covered.
public let passwordManagerBundlePrefixes: [String] = [
    "com.1password.",
    "com.agilebits.onepassword",
    "com.bitwarden.",
    "com.lastpass.",
    "com.dashlane.",
    "com.apple.keychainaccess",
    "com.apple.passwords",
    "org.keepassxc.",
    "com.mseven.msecure",
    "in.sinew.enpass",
    "com.nordpass.",
    "com.roboform.",
    "com.keepersecurity.",
    "com.protonmail.pass",
]

/// Browsers whose window titles are checked for private-mode markers. Title
/// heuristics apply ONLY to browsers so a document that merely mentions
/// "incognito" in some other app is not dropped.
public let privateModeBrowserBundles: Set<String> = [
    "com.apple.safari",
    "com.apple.safaritechnologypreview",
    "com.google.chrome",
    "com.google.chrome.canary",
    "com.google.chrome.beta",
    "company.thebrowser.browser", // Arc
    "company.thebrowser.dia",
]

/// Lowercased substrings that mark a private window title in the browsers
/// above (Safari: "Private Browsing"; Chrome: "(Incognito)"; Arc: "Private").
public let privateWindowTitleMarkers: [String] = [
    "private browsing",
    "(incognito)",
    "incognito)",
    "(private)",
]

public struct PrivacyFilter: Sendable {
    /// Globally paused (stdin `pause`).
    public var paused: Bool = false
    /// Per-app pause set (stdin `pause_app` / `resume_app`), lowercased ids.
    public var pausedApps: Set<String> = []

    public init() {}

    public mutating func pauseApp(_ bundleId: String) {
        pausedApps.insert(bundleId.lowercased())
    }

    public mutating func resumeApp(_ bundleId: String) {
        pausedApps.remove(bundleId.lowercased())
    }

    /// The verdict on one raw capture. `nil` = allowed.
    public func dropReason(for capture: RawCapture) -> DropReason? {
        if paused { return .paused }
        let bundle = capture.bundleId.lowercased()
        if pausedApps.contains(bundle) { return .appPaused }
        if passwordManagerBundlePrefixes.contains(where: { bundle.hasPrefix($0) }) {
            return .passwordManager
        }
        if capture.axPrivate { return .privateWindow }
        if privateModeBrowserBundles.contains(bundle) {
            let title = capture.windowTitle.lowercased()
            if privateWindowTitleMarkers.contains(where: { title.contains($0) }) {
                return .privateWindow
            }
        }
        return nil
    }
}

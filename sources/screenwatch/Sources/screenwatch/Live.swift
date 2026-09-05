// ===========================================================================
// Live AX capture (build P2.1, spec §4.2.2) — the only file that touches
// Accessibility, NSWorkspace, and CGEventSource. All logic (privacy, dedup,
// diffing, keying) stays in ScreenwatchCore; this layer just OBSERVES and
// hands RawCaptures to the pipeline.
//
// Capture moments: app switch (NSWorkspace notification), window/tab switch
// (front-window identity polled), typing-pause and scroll-stop (CGEventSource
// input-age edges), and a heartbeat while a window stays active. Idle
// short-circuit: no input for `idleS` seconds ⇒ zero capture (spec: idle =
// zero capture).
//
// The AX walk is FULL-CONTENT (spec §4.2.2): every text/value/label the app
// exposes, visible or scrolled out — distillation happens at read time, not
// here. Bounded by node/depth caps so a pathological tree cannot wedge the
// sidecar.
// ===========================================================================

import AppKit
import ApplicationServices
import Foundation
import ScreenwatchCore

final class LiveWatcher {
    private let heartbeatS: Double
    private let idleS: Double
    private let process: (RawCapture) -> Void
    private let status: ([String: String]) -> Void

    private var timer: Timer?
    private var permissionGranted = false
    /// Identity of the last captured front window: bundleId¦docKey.
    private var lastStreamIdentity = ""
    private var lastCaptureAt = Date.distantPast
    /// Previous tick's input ages, for edge detection.
    private var prevKeyAge: Double = .infinity
    private var prevScrollAge: Double = .infinity
    /// Set when input happened after the last capture (so a typing-pause
    /// only fires when there was typing to pause from).
    private var sawTypingSinceCapture = false
    private var sawScrollSinceCapture = false

    init(
        heartbeatS: Double, idleS: Double,
        process: @escaping (RawCapture) -> Void,
        status: @escaping ([String: String]) -> Void
    ) {
        self.heartbeatS = heartbeatS
        self.idleS = idleS
        self.process = process
        self.status = status
    }

    func start() {
        permissionGranted = AXIsProcessTrusted()
        status([
            "t": "status",
            "state": permissionGranted ? "capturing" : "need_permission",
        ])
        // App activation is an immediate capture; everything else rides the
        // 1s tick below.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.captureNow(trigger: .appSwitch)
        }
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // ---- Tick: permission, idle, input edges, switches, heartbeat ---------

    private func tick() {
        if !permissionGranted {
            if AXIsProcessTrusted() {
                permissionGranted = true
                status(["t": "status", "state": "capturing"])
            } else {
                return
            }
        }

        let keyAge = inputAge(.keyDown)
        let scrollAge = inputAge(.scrollWheel)
        let moveAge = min(inputAge(.mouseMoved), inputAge(.leftMouseDown))
        let anyAge = min(keyAge, scrollAge, moveAge)
        defer {
            prevKeyAge = keyAge
            prevScrollAge = scrollAge
        }

        // Idle short-circuit: no input at all for idleS ⇒ zero capture.
        if anyAge > idleS { return }

        if keyAge < prevKeyAge { sawTypingSinceCapture = true }
        if scrollAge < prevScrollAge { sawScrollSinceCapture = true }

        // Typing-pause: the key-age crosses 2s upward with typing pending.
        if sawTypingSinceCapture, prevKeyAge < 2.0, keyAge >= 2.0 {
            captureNow(trigger: .typingPause)
            return
        }
        // Scroll-stop: the scroll-age crosses 1.5s upward with scrolling pending.
        if sawScrollSinceCapture, prevScrollAge < 1.5, scrollAge >= 1.5 {
            captureNow(trigger: .scrollStop)
            return
        }

        // Window/tab switch: front window identity changed since last capture.
        guard let front = frontWindowIdentity() else { return }
        let identity = streamKey(bundleId: front.bundleId, docKey: front.docKey)
        if identity != lastStreamIdentity {
            let isBrowser = privateModeBrowserBundles.contains(front.bundleId.lowercased())
            captureNow(trigger: isBrowser ? .tabSwitch : .windowSwitch)
            return
        }

        // Heartbeat while the window stays active (dedup keeps it silent
        // unless the content actually changed).
        if Date().timeIntervalSince(lastCaptureAt) >= heartbeatS {
            captureNow(trigger: .heartbeat)
        }
    }

    private func inputAge(_ type: CGEventType) -> Double {
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type)
    }

    // ---- Capture ----------------------------------------------------------

    private func captureNow(trigger: CaptureTrigger) {
        guard permissionGranted else { return }
        guard let raw = captureFrontmost(trigger: trigger) else { return }
        lastStreamIdentity = streamKey(bundleId: raw.bundleId, docKey: raw.docKey)
        lastCaptureAt = Date()
        sawTypingSinceCapture = false
        sawScrollSinceCapture = false
        process(raw)
    }

    private struct FrontWindow {
        var bundleId: String
        var appName: String
        var pid: pid_t
        var window: AXUIElement
        var title: String
        var docKey: String
        var axPrivate: Bool
    }

    private func frontWindowIdentity() -> FrontWindow? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleId = app.bundleIdentifier
        else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let window = copyElement(axApp, kAXFocusedWindowAttribute)
            ?? copyElement(axApp, kAXMainWindowAttribute)
        else { return nil }
        let title = copyString(window, kAXTitleAttribute) ?? ""
        // Private-mode AX attribute where the browser exposes one (Safari).
        let axPrivate = copyBool(window, "AXPrivateBrowsing") ?? false
        // Document identity: AXDocument (file path / URL), else the focused
        // web area's URL, else the window title, else a per-window fallback.
        // The old chain ended at the title, so every untitled window of an
        // app collapsed into ONE stream keyed `bundle¦` (V6 S1.6 / T6-16).
        var docKey = copyString(window, kAXDocumentAttribute) ?? ""
        if docKey.isEmpty { docKey = focusedWebURL(axApp) ?? "" }
        if docKey.isEmpty { docKey = title }
        if docKey.isEmpty { docKey = untitledDocKey(window) }
        return FrontWindow(
            bundleId: bundleId, appName: app.localizedName ?? bundleId,
            pid: app.processIdentifier, window: window, title: title,
            docKey: docKey, axPrivate: axPrivate
        )
    }

    private func captureFrontmost(trigger: CaptureTrigger) -> RawCapture? {
        guard let front = frontWindowIdentity() else { return nil }
        var walk = TreeWalk()
        walk.visit(front.window)
        let ts = ISO8601DateFormatter.shared.string(from: Date())
        return RawCapture(
            ts: ts,
            bundleId: front.bundleId,
            appName: front.appName,
            windowTitle: front.title,
            docKey: front.docKey,
            trigger: trigger,
            text: walk.texts.joined(separator: "\n"),
            links: walk.links,
            files: walk.files,
            axPrivate: front.axPrivate,
            roles: walk.roles
        )
    }

    /// Stable identity for a window that exposes no document, URL or title:
    /// its AXIdentifier when the app sets one, else the AX element's own
    /// identity (CFHash of an AXUIElement is stable for the same window
    /// within a process). Never "" — an empty doc key is not a stream.
    private func untitledDocKey(_ window: AXUIElement) -> String {
        if let ident = copyString(window, kAXIdentifierAttribute), !ident.isEmpty {
            return "untitled:" + ident
        }
        return "untitled:#" + String(CFHash(window))
    }

    private func focusedWebURL(_ axApp: AXUIElement) -> String? {
        guard let focused = copyElement(axApp, kAXFocusedUIElementAttribute) else { return nil }
        var node: AXUIElement? = focused
        var hops = 0
        while let n = node, hops < 30 {
            if let url = copyURL(n, "AXURL") { return url }
            node = copyElement(n, kAXParentAttribute)
            hops += 1
        }
        return nil
    }
}

// ---- Bounded full-content AX walk ------------------------------------------

private struct TreeWalk {
    var texts: [String] = []
    var links: [String] = []
    var files: [String] = []
    var roles: [String] = []
    private var nodes = 0
    private static let maxNodes = 4000
    private static let maxDepth = 48

    mutating func visit(_ el: AXUIElement, depth: Int = 0) {
        if nodes >= Self.maxNodes || depth > Self.maxDepth { return }
        nodes += 1
        roles.append(copyString(el, kAXRoleAttribute) ?? "?")
        for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                     kAXHelpAttribute, kAXPlaceholderValueAttribute] {
            if let s = copyString(el, attr), !s.isEmpty {
                texts.append(s)
            }
        }
        if let url = copyURL(el, "AXURL") {
            if url.hasPrefix("file:") {
                files.append(url)
            } else {
                links.append(url)
            }
        }
        if let children = copyElements(el, kAXChildrenAttribute) {
            for child in children {
                if nodes >= Self.maxNodes { break }
                visit(child, depth: depth + 1)
            }
        }
    }
}

// ---- Small AX attribute readers --------------------------------------------

private func copyRaw(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
    return err == .success ? value : nil
}

private func copyString(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = copyRaw(el, attr) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

private func copyBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    guard let v = copyRaw(el, attr) else { return nil }
    return (v as? NSNumber)?.boolValue
}

private func copyURL(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = copyRaw(el, attr) else { return nil }
    if let u = v as? URL { return u.absoluteString }
    if let s = v as? String { return s }
    return nil
}

private func copyElement(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
    guard let v = copyRaw(el, attr) else { return nil }
    guard CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

private func copyElements(_ el: AXUIElement, _ attr: String) -> [AXUIElement]? {
    guard let v = copyRaw(el, attr) else { return nil }
    guard let arr = v as? [AnyObject] else { return nil }
    return arr.compactMap { item in
        guard CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
        return (item as! AXUIElement)
    }
}

private extension ISO8601DateFormatter {
    static let shared: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

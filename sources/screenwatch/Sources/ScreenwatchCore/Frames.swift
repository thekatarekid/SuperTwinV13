// ===========================================================================
// NDJSON protocol frames (build P2.1).
//
// stdout carries one JSON object per line, discriminated by `t` — the same
// wire discipline as whatsapp-go (docs/PHASE1_CONTRACT §1). stdin carries
// commands discriminated by `cmd`. Diagnostics go to stderr only.
//
// A `drop` frame is deliberately CONTENT-FREE (spec §4.3): when a capture is
// dropped for privacy, nothing of what was on screen — title, text, doc key —
// may travel. Only the reason and the bundle id (needed for the per-app pause
// UI) go on the wire.
// ===========================================================================

import Foundation

/// One raw capture handed to the pipeline — by the live AX layer, or by a
/// mock fixture. This is the shape BEFORE privacy/dedup: it may contain
/// content that must never leave the sidecar.
public struct RawCapture: Codable, Sendable {
    /// Capture timestamp, ISO-8601 UTC. Fixtures carry their own.
    public var ts: String
    public var bundleId: String
    public var appName: String
    public var windowTitle: String
    /// Document identity within the app (file path, tab URL, or a stable
    /// fallback the live layer derived). Keys the stream: bundleId¦docKey.
    public var docKey: String
    /// What fired the capture.
    public var trigger: CaptureTrigger
    /// The full distilled AX text of the frontmost window (ALL text/value/
    /// label content the app exposes — spec §4.2.2 full-content capture).
    public var text: String
    /// Links (AXURL values) seen in the tree — fetched by reference later.
    public var links: [String]
    /// File paths (AXDocument / file URLs) seen in the tree.
    public var files: [String]
    /// True when the browser exposed a private/incognito AX attribute.
    public var axPrivate: Bool

    public init(
        ts: String, bundleId: String, appName: String, windowTitle: String,
        docKey: String, trigger: CaptureTrigger, text: String,
        links: [String] = [], files: [String] = [], axPrivate: Bool = false
    ) {
        self.ts = ts
        self.bundleId = bundleId
        self.appName = appName
        self.windowTitle = windowTitle
        self.docKey = docKey
        self.trigger = trigger
        self.text = text
        self.links = links
        self.files = files
        self.axPrivate = axPrivate
    }

    enum CodingKeys: String, CodingKey {
        case ts
        case bundleId = "bundle_id"
        case appName = "app_name"
        case windowTitle = "window_title"
        case docKey = "doc_key"
        case trigger
        case text
        case links
        case files
        case axPrivate = "ax_private"
    }
}

public enum CaptureTrigger: String, Codable, Sendable {
    case appSwitch = "app_switch"
    case windowSwitch = "window_switch"
    case tabSwitch = "tab_switch"
    case typingPause = "typing_pause"
    case scrollStop = "scroll_stop"
    case heartbeat
}

/// A snapshot that PASSED privacy + dedup — the only frame that carries
/// content out of the sidecar.
public struct SnapshotFrame: Codable, Sendable {
    public var t: String = "snapshot"
    public var ts: String
    public var bundleId: String
    public var appName: String
    public var windowTitle: String
    public var docKey: String
    /// `bundleId¦docKey` — the stream key (spec §4.2.2).
    public var streamKey: String
    public var trigger: CaptureTrigger
    /// Hash of the tree STRUCTURE (element kinds + order), content-blind.
    public var treeHash: String
    /// Hash of the full text content.
    public var contentHash: String
    /// Length of the full text this capture distilled.
    public var charCount: Int
    /// The DIFF against the previous snapshot of the same stream (spec
    /// §4.2.2 "store diffs"). Full text on the stream's first snapshot.
    public var newChars: String
    /// The full distilled text (assist + understanding read the same event).
    public var text: String
    public var links: [String]
    public var files: [String]

    enum CodingKeys: String, CodingKey {
        case t, ts, trigger, text, links, files
        case bundleId = "bundle_id"
        case appName = "app_name"
        case windowTitle = "window_title"
        case docKey = "doc_key"
        case streamKey = "stream_key"
        case treeHash = "tree_hash"
        case contentHash = "content_hash"
        case charCount = "char_count"
        case newChars = "new_chars"
    }
}

public enum DropReason: String, Codable, Sendable {
    case privateWindow = "private_window"
    case passwordManager = "password_manager"
    case appPaused = "app_paused"
    case paused
}

/// Content-free notice that a capture was dropped (observability only).
public struct DropFrame: Codable, Sendable {
    public var t: String = "drop"
    public var ts: String
    public var reason: DropReason
    public var bundleId: String

    enum CodingKeys: String, CodingKey {
        case t, ts, reason
        case bundleId = "bundle_id"
    }
}

// ---- Encoding --------------------------------------------------------------

/// One shared encoder: single-line output, stable key order, no HTML escaping
/// surprises. Every frame goes to stdout via `encodeLine`.
public enum Wire {
    public static func encodeLine<T: Encodable>(_ frame: T) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? enc.encode(frame),
              let s = String(data: data, encoding: .utf8)
        else { return "{\"t\":\"error\",\"code\":\"ENCODE_FAILED\"}" }
        return s
    }

    /// Simple ad-hoc frames (ready / status / error) built from a dictionary
    /// of strings — no content ever travels this path.
    public static func statusLine(_ fields: [String: String]) -> String {
        let body = fields.sorted { $0.key < $1.key }
            .map { "\"\($0.key)\":\"\(escape($0.value))\"" }
            .joined(separator: ",")
        return "{\(body)}"
    }

    private static func escape(_ s: String) -> String {
        var out = ""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            default: out.unicodeScalars.append(c)
            }
        }
        return out
    }
}

// ===========================================================================
// The capture pipeline (build P2.1): RawCapture → privacy → hash → dedup →
// SnapshotFrame | DropFrame | suppressed.
//
// Everything the sidecar emits flows through here — the live AX layer and
// the --mock fixture replay hand raw captures to the SAME Snapshotter, so a
// fixture run exercises exactly the privacy and dedup code that ships.
// ===========================================================================

import Foundation

/// The stream-key separator (spec §4.2.2): `bundleId¦docKey`.
public let streamKeySeparator = "\u{00A6}" // '¦'

public func streamKey(bundleId: String, docKey: String) -> String {
    return bundleId + streamKeySeparator + docKey
}

public enum PipelineOutput: Sendable {
    case snapshot(SnapshotFrame)
    case drop(DropFrame)
    /// Dedup suppressed it — nothing on the wire.
    case suppressed
}

public struct Snapshotter: Sendable {
    public var privacy = PrivacyFilter()
    private var deduper = Deduper()
    /// Injected tree-hasher: the live layer passes a structural walk hash;
    /// default derives a content-blind shape signature from the text.
    private let treeHasher: @Sendable (RawCapture) -> String

    public init(treeHasher: @escaping @Sendable (RawCapture) -> String = { textShapeSignature($0.text) }) {
        self.treeHasher = treeHasher
    }

    public mutating func process(_ raw: RawCapture) -> PipelineOutput {
        if let reason = privacy.dropReason(for: raw) {
            // Content-free by construction: only ts + reason + bundle id.
            return .drop(DropFrame(ts: raw.ts, reason: reason, bundleId: raw.bundleId))
        }
        let key = streamKey(bundleId: raw.bundleId, docKey: raw.docKey)
        let tree = treeHasher(raw)
        let content = sha256Hex(raw.text)
        switch deduper.check(streamKey: key, treeHash: tree, contentHash: content, text: raw.text) {
        case .duplicate:
            return .suppressed
        case .changed(let diff):
            return .snapshot(SnapshotFrame(
                ts: raw.ts,
                bundleId: raw.bundleId,
                appName: raw.appName,
                windowTitle: raw.windowTitle,
                docKey: raw.docKey,
                streamKey: key,
                trigger: raw.trigger,
                treeHash: tree,
                contentHash: content,
                charCount: raw.text.count,
                newChars: diff,
                text: raw.text,
                links: raw.links,
                files: raw.files
            ))
        }
    }
}

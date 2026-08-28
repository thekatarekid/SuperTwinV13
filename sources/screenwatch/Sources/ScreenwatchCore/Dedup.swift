// ===========================================================================
// Hashing, dedup, and `new_chars` diffing (build P2.1, spec §4.2.2).
//
// Two hashes per capture:
//   - contentHash: sha256 of the full distilled text — "did the words change".
//   - treeHash: sha256 of a content-blind structural signature — "did the
//     layout change". The live layer feeds a real element-kind walk; the mock
//     derives a line-shape signature from the text so fixtures exercise the
//     same code path.
//
// Dedup is PER STREAM (bundleId¦docKey): a capture whose tree hash AND
// content hash both match the stream's previous snapshot is suppressed —
// this is what keeps the heartbeat silent while a window sits still.
//
// `new_chars` is the middle of the new text after trimming the longest
// common prefix and suffix against the previous text — cheap, and exactly
// the "what changed" a reader wants from a typing-pause capture.
// ===========================================================================

import CommonCrypto
import Foundation

public func sha256Hex(_ s: String) -> String {
    // CommonCrypto rather than CryptoKit: CryptoKit's swiftinterface fails to
    // compile on a bare CommandLineTools install (SDK/compiler mismatch);
    // CommonCrypto is a plain C module and always builds.
    let bytes = Array(s.utf8)
    var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    _ = bytes.withUnsafeBytes { buf in
        CC_SHA256(buf.baseAddress, CC_LONG(bytes.count), &digest)
    }
    return digest.map { String(format: "%02x", $0) }.joined()
}

/// Content-blind structural signature of a text blob: per line, its length
/// bucket. Used by the mock/fixture path; the live layer hashes the actual
/// AX element-kind walk instead.
public func textShapeSignature(_ text: String) -> String {
    let shape = text.split(separator: "\n", omittingEmptySubsequences: false)
        .map { String($0.count / 8) }
        .joined(separator: ",")
    return sha256Hex("shape:" + shape)
}

/// Longest-common-prefix/suffix diff: what `new` contains that `old` did not.
/// Returns the full new text when there is no overlap (first snapshot).
public func newChars(old: String, new: String) -> String {
    if old.isEmpty { return new }
    let o = Array(old), n = Array(new)
    var p = 0
    while p < o.count, p < n.count, o[p] == n[p] { p += 1 }
    var s = 0
    while s < o.count - p, s < n.count - p, o[o.count - 1 - s] == n[n.count - 1 - s] { s += 1 }
    return String(n[p ..< (n.count - s)])
}

/// Per-stream last-snapshot memory: the dedup + diff state.
public struct StreamState: Sendable {
    public var treeHash: String
    public var contentHash: String
    public var text: String
}

public struct Deduper: Sendable {
    private var streams: [String: StreamState] = [:]

    public init() {}

    public enum Verdict: Sendable {
        /// Same tree + same content as the stream's previous snapshot.
        case duplicate
        /// Content changed; carry this diff.
        case changed(newChars: String)
    }

    public mutating func check(
        streamKey: String, treeHash: String, contentHash: String, text: String
    ) -> Verdict {
        let prev = streams[streamKey]
        if let prev, prev.treeHash == treeHash, prev.contentHash == contentHash {
            return .duplicate
        }
        let diff = newChars(old: prev?.text ?? "", new: text)
        streams[streamKey] = StreamState(treeHash: treeHash, contentHash: contentHash, text: text)
        return .changed(newChars: diff)
    }
}

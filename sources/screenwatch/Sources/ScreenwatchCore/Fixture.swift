// ===========================================================================
// Mock fixture replay (build P2.1) — the `--mock` mode's engine, mirroring
// whatsapp-go's mock: a JSON fixture of raw captures replayed through the
// REAL pipeline (privacy + dedup + diffing), so CI and the Node adapter's
// tests exercise the shipping code with zero Accessibility permission.
// ===========================================================================

import Foundation

public struct Fixture: Codable, Sendable {
    public var captures: [RawCapture]

    public init(captures: [RawCapture]) {
        self.captures = captures
    }
}

public enum FixtureError: Error, CustomStringConvertible {
    case unreadable(String)
    case invalid(String)

    public var description: String {
        switch self {
        case .unreadable(let p): return "fixture unreadable: \(p)"
        case .invalid(let m): return "fixture invalid: \(m)"
        }
    }
}

public func loadFixture(path: String) throws -> Fixture {
    guard let data = FileManager.default.contents(atPath: path) else {
        throw FixtureError.unreadable(path)
    }
    do {
        return try JSONDecoder().decode(Fixture.self, from: data)
    } catch {
        throw FixtureError.invalid(String(describing: error))
    }
}

/// A small built-in fixture (used when --fixture is absent): two interleaved
/// streams plus one private-window and one password-manager capture that MUST
/// be dropped — so even a bare `--mock` run proves the privacy path.
public func builtinFixture() -> Fixture {
    return Fixture(captures: [
        RawCapture(
            ts: "2026-08-28T10:00:00.000Z", bundleId: "com.apple.TextEdit",
            appName: "TextEdit", windowTitle: "notes.txt",
            docKey: "/Users/u/notes.txt", trigger: .appSwitch,
            text: "meeting notes\nagenda: budget"
        ),
        RawCapture(
            ts: "2026-08-28T10:00:20.000Z", bundleId: "com.google.Chrome",
            appName: "Chrome", windowTitle: "Docs — Roadmap",
            docKey: "https://docs.example.com/roadmap", trigger: .tabSwitch,
            text: "Roadmap Q3\nship the sidecar",
            links: ["https://docs.example.com/roadmap"]
        ),
        RawCapture(
            ts: "2026-08-28T10:00:40.000Z", bundleId: "com.apple.TextEdit",
            appName: "TextEdit", windowTitle: "notes.txt",
            docKey: "/Users/u/notes.txt", trigger: .typingPause,
            text: "meeting notes\nagenda: budget\naction: email finance"
        ),
        // Private window — must produce a drop frame, never content.
        RawCapture(
            ts: "2026-08-28T10:01:00.000Z", bundleId: "com.google.Chrome",
            appName: "Chrome", windowTitle: "secret plans (Incognito)",
            docKey: "https://secret.example.com", trigger: .tabSwitch,
            text: "SECRET-INCOGNITO-CONTENT", axPrivate: false
        ),
        // Password manager — must produce a drop frame, never content.
        RawCapture(
            ts: "2026-08-28T10:01:20.000Z", bundleId: "com.1password.1password",
            appName: "1Password", windowTitle: "Vault",
            docKey: "vault", trigger: .appSwitch,
            text: "SECRET-VAULT-PASSWORD-12345"
        ),
        // Unchanged heartbeat — dedup must suppress it.
        RawCapture(
            ts: "2026-08-28T10:01:40.000Z", bundleId: "com.apple.TextEdit",
            appName: "TextEdit", windowTitle: "notes.txt",
            docKey: "/Users/u/notes.txt", trigger: .heartbeat,
            text: "meeting notes\nagenda: budget\naction: email finance"
        ),
    ])
}

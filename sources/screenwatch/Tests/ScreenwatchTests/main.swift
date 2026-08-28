// ===========================================================================
// screenwatch unit tests (build P2.1) — a plain swiftc-built runner (this
// machine's CommandLineTools SPM manifest toolchain is broken, so XCTest is
// out; ./test.sh builds and runs this against ScreenwatchCore).
//
// Covers: privacy drops (HARD — dropped content must never appear in any
// emitted line), dedup + new_chars diffing, multitask stream keying
// (SEG-06-equivalent), fixture replay, and wire encoding.
// ===========================================================================

import Foundation
import ScreenwatchCore

var failures = 0
var checks = 0

func expect(_ cond: Bool, _ label: String, file: String = #file, line: Int = #line) {
    checks += 1
    if !cond {
        failures += 1
        print("FAIL: \(label) (\((file as NSString).lastPathComponent):\(line))")
    }
}

func expectEq<T: Equatable>(_ got: T, _ want: T, _ label: String, line: Int = #line) {
    expect(got == want, "\(label): got \(got), want \(want)", line: line)
}

func cap(
    bundle: String = "com.apple.TextEdit", title: String = "w", doc: String = "/a.txt",
    text: String, trigger: CaptureTrigger = .heartbeat, axPrivate: Bool = false
) -> RawCapture {
    return RawCapture(
        ts: "2026-08-28T10:00:00.000Z", bundleId: bundle, appName: "app",
        windowTitle: title, docKey: doc, trigger: trigger, text: text,
        axPrivate: axPrivate
    )
}

// ---- Privacy: password managers (hard) -------------------------------------

do {
    var s = Snapshotter()
    for bundle in [
        "com.1password.1password", "com.agilebits.onepassword7",
        "com.bitwarden.desktop", "com.lastpass.LastPass",
        "com.apple.Passwords", "org.keepassxc.keepassxc",
    ] {
        let out = s.process(cap(bundle: bundle, doc: "vault", text: "SECRET-99"))
        if case .drop(let frame) = out {
            expectEq(frame.reason, .passwordManager, "pw-manager reason \(bundle)")
            let line = Wire.encodeLine(frame)
            expect(!line.contains("SECRET-99"), "pw drop leaks text \(bundle)")
            expect(!line.contains("vault"), "pw drop leaks doc key \(bundle)")
        } else {
            expect(false, "pw-manager \(bundle) must be dropped")
        }
    }
}

// ---- Privacy: private windows (hard) ---------------------------------------

do {
    var s = Snapshotter()
    let cases: [(String, String)] = [
        ("com.apple.Safari", "Login — Private Browsing"),
        ("com.google.Chrome", "bank stuff (Incognito)"),
        ("company.thebrowser.Browser", "notes (Private)"),
    ]
    for (bundle, title) in cases {
        let out = s.process(cap(bundle: bundle, title: title, text: "HIDDEN-CONTENT"))
        if case .drop(let frame) = out {
            expectEq(frame.reason, .privateWindow, "private-window reason \(bundle)")
            expect(!Wire.encodeLine(frame).contains("HIDDEN-CONTENT"), "private drop leaks \(bundle)")
        } else {
            expect(false, "private window \(bundle) '\(title)' must be dropped")
        }
    }
    // AX private flag drops even without a title marker.
    if case .drop(let f) = s.process(cap(bundle: "com.apple.Safari", title: "no marker", text: "X", axPrivate: true)) {
        expectEq(f.reason, .privateWindow, "ax-private reason")
    } else {
        expect(false, "ax-private flag must drop")
    }
    // A non-browser mentioning "incognito" is NOT dropped.
    if case .snapshot = s.process(cap(title: "essay about incognito mode", text: "harmless")) {
    } else {
        expect(false, "non-browser incognito title must pass")
    }
}

// ---- Pause switches --------------------------------------------------------

do {
    var s = Snapshotter()
    s.privacy.paused = true
    if case .drop(let d) = s.process(cap(text: "x")) {
        expectEq(d.reason, .paused, "global pause reason")
    } else { expect(false, "paused must drop") }
    s.privacy.paused = false
    s.privacy.pauseApp("com.apple.Mail")
    if case .drop(let d) = s.process(cap(bundle: "com.apple.Mail", text: "x")) {
        expectEq(d.reason, .appPaused, "app pause reason")
    } else { expect(false, "app-paused must drop") }
    s.privacy.resumeApp("com.apple.Mail")
    if case .snapshot = s.process(cap(bundle: "com.apple.Mail", text: "x")) {
    } else { expect(false, "resumed app must pass") }
}

// ---- Dedup + diffing -------------------------------------------------------

do {
    var s = Snapshotter()
    if case .snapshot(let first) = s.process(cap(text: "line one\nline two")) {
        expectEq(first.newChars, "line one\nline two", "first snapshot carries full text")
    } else { expect(false, "first must emit") }
    if case .suppressed = s.process(cap(text: "line one\nline two")) {
    } else { expect(false, "identical recapture must be suppressed") }
    if case .snapshot(let second) = s.process(cap(text: "line one\ninserted\nline two")) {
        expectEq(second.newChars, "inserted\n", "new_chars diff")
        expectEq(second.charCount, "line one\ninserted\nline two".count, "char_count")
    } else { expect(false, "changed content must emit") }
}

// ---- Multitask keying (SEG-06-equivalent) ----------------------------------

do {
    var s = Snapshotter()
    guard case .snapshot(let a1) = s.process(cap(doc: "/a.txt", text: "alpha")),
          case .snapshot(let b1) = s.process(cap(doc: "/b.txt", text: "bravo"))
    else { expect(false, "interleaved first captures must emit"); exit(1) }
    expectEq(a1.streamKey, "com.apple.TextEdit\u{00A6}/a.txt", "stream key a")
    expectEq(b1.streamKey, "com.apple.TextEdit\u{00A6}/b.txt", "stream key b")
    expect(a1.streamKey != b1.streamKey, "streams must be distinct")

    // Returning to /a.txt unchanged is suppressed PER STREAM, even though
    // /b.txt was captured in between.
    if case .suppressed = s.process(cap(doc: "/a.txt", text: "alpha")) {
    } else { expect(false, "unchanged return must be suppressed per stream") }

    // A change diffs against the stream's OWN previous text.
    if case .snapshot(let a2) = s.process(cap(doc: "/a.txt", text: "alpha beta")) {
        expectEq(a2.newChars, " beta", "per-stream diff")
    } else { expect(false, "changed /a.txt must emit") }

    // Same doc key in a different app is a different stream.
    if case .snapshot(let c1) = s.process(cap(bundle: "com.microsoft.VSCode", doc: "/a.txt", text: "alpha")) {
        expectEq(c1.streamKey, "com.microsoft.VSCode\u{00A6}/a.txt", "app-scoped key")
        expectEq(c1.newChars, "alpha", "fresh stream carries full text")
    } else { expect(false, "other app must be its own stream") }
}

// ---- Builtin fixture replay (hard privacy end-to-end) ----------------------

do {
    var s = Snapshotter()
    var snapshots: [SnapshotFrame] = []
    var drops: [DropFrame] = []
    var suppressed = 0
    for raw in builtinFixture().captures {
        switch s.process(raw) {
        case .snapshot(let f): snapshots.append(f)
        case .drop(let f): drops.append(f)
        case .suppressed: suppressed += 1
        }
    }
    expectEq(snapshots.count, 3, "fixture snapshots")
    expectEq(drops.count, 2, "fixture drops")
    expectEq(suppressed, 1, "fixture suppressed heartbeat")
    expectEq(Set(drops.map(\.reason)), Set([.privateWindow, .passwordManager]), "fixture drop reasons")
    let allLines = snapshots.map { Wire.encodeLine($0) } + drops.map { Wire.encodeLine($0) }
    for line in allLines {
        expect(!line.contains("SECRET-INCOGNITO-CONTENT"), "fixture leaks incognito content")
        expect(!line.contains("SECRET-VAULT-PASSWORD"), "fixture leaks vault content")
    }
}

// ---- Wire encoding ---------------------------------------------------------

do {
    var s = Snapshotter()
    if case .snapshot(let f) = s.process(cap(text: "two\nlines")) {
        let line = Wire.encodeLine(f)
        expect(!line.contains("\n"), "wire line must be single-line")
        if let parsed = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] {
            expectEq(parsed["t"] as? String ?? "", "snapshot", "wire t")
            expectEq(parsed["text"] as? String ?? "", "two\nlines", "wire text roundtrip")
            expectEq(parsed["stream_key"] as? String ?? "", "com.apple.TextEdit\u{00A6}/a.txt", "wire stream_key")
            expectEq(parsed["trigger"] as? String ?? "", "heartbeat", "wire trigger")
        } else {
            expect(false, "wire line must parse as JSON")
        }
    } else { expect(false, "snapshot expected") }
    let status = Wire.statusLine(["t": "status", "state": "capturing"])
    expectEq(status, "{\"state\":\"capturing\",\"t\":\"status\"}", "status line")
}

// ---- Fixture file loads ----------------------------------------------------

do {
    // The repo fixture (used by the Node adapter's mock tests) must parse.
    let dir = URL(fileURLWithPath: #file) // Tests/ScreenwatchTests/main.swift
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let path = dir.appendingPathComponent("fixtures/basic.json").path
    do {
        let f = try loadFixture(path: path)
        expect(f.captures.count >= 6, "repo fixture has captures")
    } catch {
        expect(false, "repo fixture failed to load: \(error)")
    }
}

print(failures == 0 ? "OK: \(checks) checks passed" : "FAILED: \(failures)/\(checks) checks failed")
exit(failures == 0 ? 0 : 1)

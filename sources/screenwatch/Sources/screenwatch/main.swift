// ===========================================================================
// screenwatch CLI (build P2.1) — the screen recorder sidecar.
//
// NDJSON frames on stdout, commands on stdin, diagnostics on stderr —
// exactly the whatsapp-go sidecar discipline. Modes:
//   - default: live AX capture (requires Accessibility permission; until
//     granted the sidecar sits in `need_permission` and polls).
//   - --mock [--fixture <path>]: replay a JSON fixture through the REAL
//     pipeline (privacy + dedup) with zero permissions, for CI and the Node
//     adapter's tests.
//   - --check-permission: print one frame
//     {"t":"permission","granted":"true"|"false"} (AXIsProcessTrusted) and
//     exit 0. Captures nothing, observes nothing. The worker's screen connect
//     flow (V6 P1 S1.3 / T4-3, T4-8) probes Accessibility with this BEFORE the
//     user's explicit "Record from now on", so the capturing sidecar is never
//     spawned just to find out whether it may capture.
//
// stdin commands: {"cmd":"pause"} {"cmd":"resume"}
//                 {"cmd":"pause_app","bundle_id":…} {"cmd":"resume_app",…}
//                 {"cmd":"shutdown"}
// ===========================================================================

import ApplicationServices
import Foundation
import ScreenwatchCore

func logErr(_ s: String) {
    FileHandle.standardError.write(Data(("screenwatch " + s + "\n").utf8))
}

func emit(_ line: String) {
    print(line)
    // stdout may be a pipe: flush every frame so the supervisor sees it now.
    fflush(stdout)
}

func emitOutput(_ out: PipelineOutput) {
    switch out {
    case .snapshot(let f): emit(Wire.encodeLine(f))
    case .drop(let f): emit(Wire.encodeLine(f))
    case .suppressed: break
    }
}

// ---- Args ------------------------------------------------------------------

var mockMode = ProcessInfo.processInfo.environment["SUPERTWIN_SCREENWATCH_MOCK"] == "1"
var checkPermissionOnly = false
var fixturePath: String? = nil
var heartbeatS: Double = 60
var idleS: Double = 120

var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let a = args.removeFirst()
    switch a {
    case "--mock": mockMode = true
    case "--check-permission": checkPermissionOnly = true
    case "--fixture": fixturePath = args.isEmpty ? nil : args.removeFirst()
    case "--heartbeat-s": heartbeatS = Double(args.isEmpty ? "" : args.removeFirst()) ?? 60
    case "--idle-s": idleS = Double(args.isEmpty ? "" : args.removeFirst()) ?? 120
    case "--log-level": _ = args.isEmpty ? "" : args.removeFirst() // accepted for parity
    default: logErr("ignoring unknown flag \(a)")
    }
}

// ---- Permission probe (no capture, no run loop) ----------------------------

if checkPermissionOnly {
    // AXIsProcessTrusted() without the prompt option: report, never ask. The
    // deep link to System Settings is the UI's job (screen-routes.ts).
    let granted = AXIsProcessTrusted()
    emit(Wire.statusLine(["t": "permission", "granted": granted ? "true" : "false"]))
    exit(0)
}

// ---- Shared pipeline + command loop ---------------------------------------

/// Everything runs on this serial queue: captures, commands, emissions.
let work = DispatchQueue(label: "screenwatch.pipeline")
var snapshotter = Snapshotter()
var shuttingDown = false

func handleCommand(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = obj["cmd"] as? String
    else {
        logErr("ignoring non-command stdin line")
        return
    }
    switch cmd {
    case "pause":
        snapshotter.privacy.paused = true
        emit(Wire.statusLine(["t": "status", "state": "paused"]))
    case "resume":
        snapshotter.privacy.paused = false
        emit(Wire.statusLine(["t": "status", "state": "capturing"]))
    case "pause_app":
        if let b = obj["bundle_id"] as? String {
            snapshotter.privacy.pauseApp(b)
            emit(Wire.statusLine(["t": "status", "state": "app_paused", "bundle_id": b]))
        }
    case "resume_app":
        if let b = obj["bundle_id"] as? String {
            snapshotter.privacy.resumeApp(b)
            emit(Wire.statusLine(["t": "status", "state": "app_resumed", "bundle_id": b]))
        }
    case "shutdown":
        shuttingDown = true
        emit(Wire.statusLine(["t": "status", "state": "shutting_down"]))
        exit(0)
    default:
        logErr("ignoring unknown cmd \(cmd)")
    }
}

// stdin reader thread: EOF = supervisor is gone = exit clean. In mock mode
// this starts AFTER the fixture replay, so a piped `shutdown` cannot race
// ahead of the frames a test is waiting for.
func startStdinLoop() {
    let t = Thread {
        while let line = readLine(strippingNewline: true) {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.isEmpty { continue }
            work.sync { handleCommand(l) }
        }
        logErr("stdin closed — exiting")
        exit(0)
    }
    t.start()
}

emit(Wire.statusLine(["t": "ready", "mock": mockMode ? "true" : "false"]))

// ---- Mock mode -------------------------------------------------------------

if mockMode {
    let fixture: Fixture
    if let p = fixturePath {
        do {
            fixture = try loadFixture(path: p)
            logErr("loaded fixture \(p) (\(fixture.captures.count) captures)")
        } catch {
            logErr("\(error)")
            emit(Wire.statusLine(["t": "error", "code": "FIXTURE_INVALID", "message": String(describing: error)]))
            exit(2)
        }
    } else {
        fixture = builtinFixture()
    }
    work.sync {
        emit(Wire.statusLine(["t": "status", "state": "capturing"]))
        for raw in fixture.captures {
            emitOutput(snapshotter.process(raw))
        }
        emit(Wire.statusLine(["t": "status", "state": "fixture_done"]))
    }
    // Stay alive for commands until shutdown/EOF (mirrors the live daemon).
    startStdinLoop()
    dispatchMain()
}

// ---- Live mode -------------------------------------------------------------

startStdinLoop()
let live = LiveWatcher(
    heartbeatS: heartbeatS,
    idleS: idleS,
    process: { raw in
        work.sync { emitOutput(snapshotter.process(raw)) }
    },
    status: { fields in
        work.sync { emit(Wire.statusLine(fields)) }
    }
)
live.start()
RunLoop.main.run()

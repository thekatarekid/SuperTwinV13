// SuperTwinV13 — Tauri 2 application entry (library crate).
//
// Phase 0 scope: wire up the shell plugin, open the single window that loads the
// Vite/React UI, and manage the Node worker **sidecar lifecycle** (§9):
//   * on `.setup()`, spawn the worker as a child process (dev: `npm run worker`
//     with cwd = repo root, which runs `tsx worker/src/index.ts`),
//   * stream its stdout; when a line contains `WORKER_READY`, log it and emit a
//     Tauri `worker-ready` event to the frontend,
//   * store the child handle in managed state and KILL it on app exit so no
//     orphaned worker survives (WindowEvent::Destroyed + RunEvent::Exit).
//
// Defensive by design: if the spawn fails we log and continue running — the UI
// polls `/api/health` and simply shows the worker as offline until it appears.
//
// Two spawn profiles (see `build_worker_command`):
//   * DEV (`debug_assertions`): `npm run worker` (tsx) with cwd = repo root.
//   * RELEASE: the bundled `node` sidecar runs the bundled `worker.cjs` from
//     `Resources/worker/` — fully self-contained, no repo/npm/tsx/node on host.
// Neither profile clears the environment: the sidecar inherits the app's full
// Finder/launchd env so the child `claude` can read its Keychain OAuth token
// (which requires USER + LOGNAME + HOME to be present).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// P1.7 — summon hotkey (double-tap right-⌘ + ⌘⇧S fallback) and window toggle.
mod hotkey;
// P2.1 — hand a URL to the OS (the Accessibility System Settings deep link).
// The JS `shell.open()` scope rejects `x-apple.systempreferences:`; see opener.rs.
mod opener;
// P2.3 — menu bar tray (◉◔●⏸), 360px glass panel, transient nudge window.
mod tray;

/// Roll the worker log over to `worker.log.old` if it already exceeds ~5 MB, so
/// it never grows unbounded across many app launches. Best-effort: any IO error
/// is swallowed (a failed rotation must never keep the app from starting).
const WORKER_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Resolve the worker home dir the same way the worker itself does: honour
/// `SUPERTWIN_HOME` (if set and non-blank), else default to `~/SuperTwinV13`. This
/// keeps `worker.log` next to the worker's db/brain/media. Returns `None` only
/// if neither is resolvable (no HOME, no override) — logging is then skipped.
fn worker_home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("SUPERTWIN_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    // Mirror `homedir()`/`join(home, "SuperTwinV13")` on the worker side.
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("SuperTwinV13"))
}

/// Open `~/SuperTwinV13/worker.log` (or `$SUPERTWIN_HOME/worker.log`) in append
/// mode, creating the dir if missing and rotating an oversized file to
/// `worker.log.old` first. Returns `None` on any failure — the caller then just
/// runs without a log file (stdout/stderr forwarding is unaffected).
fn open_worker_log() -> Option<File> {
    let dir = worker_home_dir()?;
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let path = dir.join("worker.log");
    // Best-effort rotate when the existing log is already too big.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > WORKER_LOG_MAX_BYTES {
            let _ = fs::rename(&path, dir.join("worker.log.old"));
        }
    }
    OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// Milliseconds-since-epoch prefix for a log line. Cheap, dependency-free, and
/// good enough to correlate worker output with the `extraction_runs` table.
fn log_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append a single timestamped line to the shared worker log. Never panics:
/// lock poisoning and IO errors are both swallowed so logging can never take
/// the app down.
fn append_worker_log(log: &Arc<Mutex<Option<File>>>, tag: &str, line: &str) {
    if let Ok(mut guard) = log.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = writeln!(file, "{} {} {}", log_timestamp_millis(), tag, line);
        }
    }
}

/// Holds the worker child so the exit hooks can take + kill it exactly once.
/// `Option` because the handle is consumed by `CommandChild::kill(self)`.
#[derive(Default)]
struct WorkerProcess(Mutex<Option<CommandChild>>);

impl WorkerProcess {
    /// Kill the worker if it is still running. Safe to call more than once.
    fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
                println!("[supertwinv13] worker sidecar killed on app exit");
            }
        }
    }
}

/// Resolve the repo root (the parent of this `src-tauri` crate) for dev-mode
/// spawning. `CARGO_MANIFEST_DIR` points at `src-tauri/` at compile time.
#[cfg(debug_assertions)]
fn repo_root() -> std::path::PathBuf {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| manifest.to_path_buf())
}

/// Build the worker `Command` for DEV: `npm run worker`
/// (→ `npm run dev -w @supertwinv13/worker` → tsx) with cwd = repo root. Running
/// through npm keeps us aligned with the repo's scripts and avoids hard-coding
/// an absolute path to tsx/node. Inherits the full app environment (needed so
/// the child claude can read its Keychain OAuth token via USER/LOGNAME/HOME).
#[cfg(debug_assertions)]
fn build_worker_command(app: &tauri::AppHandle) -> Result<Command, String> {
    Ok(app
        .shell()
        .command("npm")
        .args(["run", "worker"])
        .current_dir(repo_root()))
}

/// Build the worker `Command` for RELEASE: run the bundled `worker.cjs` with the
/// bundled `node` sidecar (externalBin `binaries/node`). Both are shipped inside
/// the .app — `worker.cjs` at `Resources/worker/worker.cjs`, the node binary
/// alongside the main executable — so nothing on the host (repo, npm, tsx, node)
/// is required. We do NOT clear the environment: the sidecar inherits the app's
/// full Finder/launchd environment so `claude` can reach its Keychain OAuth
/// token (which needs USER + LOGNAME + HOME present).
#[cfg(not(debug_assertions))]
fn build_worker_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let worker_dir = app
        .path()
        .resolve("worker", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("could not resolve bundled worker dir: {e}"))?;
    let worker_cjs = worker_dir.join("worker.cjs");
    // The Go WhatsApp daemon ships inside the worker bundle at
    // `Resources/worker/bin/whatsapp-go`. The esbuild CJS bundle resolves the
    // daemon relative to the worker's CWD, so we (a) run the worker with
    // cwd = the worker resource dir AND (b) pass the absolute daemon path
    // explicitly via SUPERTWIN_WHATSAPP_BIN — belt-and-suspenders, so the
    // resolution is cwd-independent either way.
    let daemon_bin = worker_dir.join("bin").join("whatsapp-go");

    Ok(app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("could not create node sidecar command: {e}"))?
        .args([worker_cjs.to_string_lossy().to_string()])
        .current_dir(worker_dir.clone())
        .env(
            "SUPERTWIN_WHATSAPP_BIN",
            daemon_bin.to_string_lossy().to_string(),
        ))
}

/// Spawn the Node worker and wire up its stdout → `worker-ready` emission.
/// Returns the `CommandChild` on success so the caller can stash it in state.
/// The command itself is profile-specific (see `build_worker_command`); the
/// readiness detection + child bookkeeping below are identical for dev/release.
fn spawn_worker(app: &tauri::AppHandle) -> Result<CommandChild, String> {
    let command = build_worker_command(app)?;

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    // Open the persistent worker log up front. For a Finder-launched .app,
    // stdout/stderr go nowhere, so this file is the only durable record of the
    // worker's output (see the extraction-failure post-mortem). Best-effort:
    // `None` means we simply don't persist — forwarding still happens.
    let log = Arc::new(Mutex::new(open_worker_log()));
    append_worker_log(&log, "[supertwinv13]", "worker sidecar spawned");

    // Drain the child's event stream on the async runtime: forward stdout to the
    // log, watch for the readiness line, and note early termination. Every line
    // is both forwarded (println!/eprintln! — so `open -o` capture still works)
    // AND appended to worker.log with a timestamp.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut announced_ready = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        println!("[worker] {line}");
                        append_worker_log(&log, "[worker]", line);
                    }
                    if !announced_ready && line.contains("WORKER_READY") {
                        announced_ready = true;
                        println!("[supertwinv13] worker sidecar reported ready: {line}");
                        // Best-effort notify the frontend; ignore emit errors.
                        let _ = handle.emit("worker-ready", line.to_string());
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        eprintln!("[worker:err] {line}");
                        append_worker_log(&log, "[worker:err]", line);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let msg = format!(
                        "worker sidecar terminated (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    eprintln!("[supertwinv13] {msg}");
                    append_worker_log(&log, "[supertwinv13]", &msg);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(WorkerProcess::default())
        .invoke_handler(tauri::generate_handler![
            opener::open_external,
            tray::set_tray_state,
            tray::show_nudge,
            tray::hide_nudge,
            tray::hide_panel,
            tray::open_main,
        ])
        .setup(|app| {
            // Spawn the Node worker and hold its handle so it can be killed on
            // exit. Defensive — a spawn failure logs and continues; the UI polls
            // /api/health and retries. Dev runs `npm run worker`; release runs
            // the bundled node sidecar on the bundled worker.cjs.
            let handle = app.handle();
            match spawn_worker(handle) {
                Ok(child) => {
                    if let Some(state) = handle.try_state::<WorkerProcess>() {
                        *state.0.lock().unwrap() = Some(child);
                    }
                    println!("[supertwinv13] worker sidecar spawned");
                }
                Err(err) => {
                    // Do not fail app startup — chat just stays offline until the
                    // worker is reachable.
                    eprintln!("[supertwinv13] failed to spawn worker sidecar: {err}");
                }
            }

            // P1.7 window chrome: translucent liquid glass. The window is
            // transparent (tauri.conf.json) and macOS vibrancy paints the
            // frosted material the CSS backdrop-filters sit on. Best-effort:
            // a failure logs and the CSS fallback background takes over.
            #[cfg(target_os = "macos")]
            if let Some(window) = handle.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                if let Err(err) =
                    apply_vibrancy(&window, NSVisualEffectMaterial::UnderWindowBackground, None, Some(16.0))
                {
                    eprintln!("[supertwinv13] vibrancy unavailable: {err}");
                }
            }

            // P1.7 summon: double-tap right-⌘ (event tap) + ⌘⇧S fallback.
            hotkey::register_fallback_shortcut(handle);
            hotkey::start_double_tap_listener(handle);

            // P2.3 menu bar: template-icon tray (◉◔●⏸) + the 360px glass
            // panel + the transient nudge window. Best-effort — a failure
            // logs and the main window still runs.
            tray::setup(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run the event loop with a kill-switch: tear the worker down on the last
    // window's destruction and again on the loop's exit (belt and suspenders so
    // no orphaned worker survives any exit path).
    app.run(|handle, event| match event {
        RunEvent::WindowEvent {
            event: WindowEvent::Destroyed,
            ..
        } => {
            if let Some(state) = handle.try_state::<WorkerProcess>() {
                state.kill();
            }
        }
        RunEvent::Exit => {
            if let Some(state) = handle.try_state::<WorkerProcess>() {
                state.kill();
            }
        }
        _ => {}
    });
}

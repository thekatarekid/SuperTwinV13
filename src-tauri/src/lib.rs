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
// Both profiles rebuild the inherited environment after removing runtime and
// dynamic-loader injection variables. Ordinary app state (including HOME,
// USER, LOGNAME, PATH, and SUPERTWIN_HOME) remains available to the worker.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// S6d/L4 — the Accessibility ASK. AXIsProcessTrustedWithOptions(prompt) is the
// only call that makes macOS list this app in Privacy & Security ›
// Accessibility; without it there was no row to tick. See accessibility.rs.
mod accessibility;
// P1.7 — summon hotkey (double-tap right-⌘ + ⌘⇧S fallback) and window toggle.
mod hotkey;
mod keychain_broker;
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
#[derive(Clone, Default)]
struct WorkerProcess {
    child: Arc<Mutex<Option<CommandChild>>>,
    broker: Arc<Mutex<Option<keychain_broker::BrokerActor>>>,
}

impl WorkerProcess {
    fn install(&self, child: CommandChild, broker: keychain_broker::BrokerActor) -> Result<(), String> {
        let mut guard = self.child.lock().map_err(|_| "worker state lock failed".to_string())?;
        if guard.is_some() { return Err("worker already running".into()); }
        *guard = Some(child);
        *self.broker.lock().map_err(|_| "broker state lock failed".to_string())? = Some(broker);
        Ok(())
    }

    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self.child.lock().map_err(|_| "worker state lock failed".to_string())?;
        guard.as_mut().ok_or_else(|| "worker is unavailable".to_string())?
            .write(bytes).map_err(|_| "worker pipe write failed".to_string())
    }

    fn broker_request(&self, line: String) -> Result<std::sync::mpsc::Receiver<
        Result<String, keychain_broker::BrokerError>>, String> {
        let guard = self.broker.lock().map_err(|_| "broker state lock failed".to_string())?;
        guard.as_ref().ok_or_else(|| "credential broker is unavailable".to_string())?
            .request(line).map_err(|_| "credential broker refused a frame".to_string())
    }

    /// Kill the worker if it is still running. Safe to call more than once.
    fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
                println!("[supertwinv13] worker sidecar killed on app exit");
            }
        }
        if let Ok(mut guard) = self.broker.lock() {
            if let Some(mut broker) = guard.take() { broker.shutdown(); }
        }
    }
}

/// Environment prefixes whose values can make Node/npm or the platform loader
/// execute attacker-selected code before `worker.cjs` starts. Matching is ASCII
/// case-insensitive so the policy remains conservative on case-insensitive
/// platforms and when npm normalizes configuration keys.
const BLOCKED_WORKER_ENV_PREFIXES: &[&str] = &["NODE_", "NPM_CONFIG_", "DYLD_", "LD_"];

/// Other language/runtime startup hooks that can reach worker subprocesses.
/// These are deliberately narrow: ordinary desktop environment such as HOME,
/// USER, LOGNAME, PATH, locale, and SUPERTWIN_* configuration is preserved.
const BLOCKED_WORKER_ENV_KEYS: &[&str] = &[
    "BASH_ENV",
    "BASHOPTS",
    "CDPATH",
    "ENV",
    "GLOBIGNORE",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "OPENSSL_CONF",
    "OPENSSL_MODULES",
    "PERL5LIB",
    "PERL5OPT",
    "PYTHONHOME",
    "PYTHONPATH",
    "RUBYLIB",
    "RUBYOPT",
    "SHELLOPTS",
    "ZDOTDIR",
    "_JAVA_OPTIONS",
    "_RLD_LIST",
];

fn is_blocked_worker_env_key(key: &OsStr) -> bool {
    let normalized = key.to_string_lossy().to_ascii_uppercase();
    BLOCKED_WORKER_ENV_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
        || BLOCKED_WORKER_ENV_KEYS.contains(&normalized.as_str())
}

fn sanitize_worker_environment<I>(environment: I) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    environment
        .into_iter()
        .filter(|(key, _)| !is_blocked_worker_env_key(key))
        .collect()
}

fn inherited_worker_environment() -> Vec<(OsString, OsString)> {
    sanitize_worker_environment(std::env::vars_os())
}

#[derive(Debug, PartialEq, Eq)]
enum WorkerStdoutLine {
    Broker(String),
    Log(String),
}

#[derive(Default)]
struct WorkerStdoutDemux {
    buffer: Vec<u8>,
}

impl WorkerStdoutDemux {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<WorkerStdoutLine>, ()> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 1024 * 1024 { return Err(()); }
        let mut lines = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let raw = self.buffer.drain(..=newline).collect::<Vec<_>>();
            let line = std::str::from_utf8(&raw[..raw.len().saturating_sub(1)]).map_err(|_| ())?;
            if line.starts_with(keychain_broker::REQUEST_PREFIX) {
                lines.push(WorkerStdoutLine::Broker(line.to_string()));
            } else if line.contains(keychain_broker::REQUEST_PREFIX) {
                // Never surface an ambiguously framed line to logging: its tail
                // may be a valid credential request containing secret bytes.
                return Err(());
            } else {
                lines.push(WorkerStdoutLine::Log(line.to_string()));
            }
        }
        Ok(lines)
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
/// an absolute path to tsx/node. Rebuilds the inherited environment without
/// runtime-loader injection hooks while retaining normal app configuration.
#[cfg(debug_assertions)]
fn build_worker_command(app: &tauri::AppHandle) -> Result<Command, String> {
    // The DEV profile runs the LIVE worker script (real home, port 8013): the
    // default `npm run worker` is the scratch-home dev worker (S0.2, T0-5).
    Ok(app
        .shell()
        .command("npm")
        .env_clear()
        .envs(inherited_worker_environment())
        .args(["run", "worker:live"])
        .current_dir(repo_root())
        .env("NODE_ENV", "development")
        .env("SUPERTWIN_DEV_ORIGIN", "http://localhost:1420")
        // Home guard token (worker/src/home-guard.ts, S0.2): the worker refuses
        // to boot against ~/SuperTwinV13 unless the app launched it.
        .env("SUPERTWIN_LAUNCHED_BY", "app"))
}

/// Build the worker `Command` for RELEASE: run the bundled `worker.cjs` with the
/// bundled `node` sidecar (externalBin `binaries/node`). Both are shipped inside
/// the .app — `worker.cjs` at `Resources/worker/worker.cjs`, the node binary
/// alongside the main executable — so nothing on the host (repo, npm, tsx, node)
/// is required. The sidecar receives the ordinary Finder/launchd environment but
/// not runtime-loader injection hooks; USER, LOGNAME, HOME, and SUPERTWIN_HOME
/// therefore remain available where configured.
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
        .env_clear()
        .envs(inherited_worker_environment())
        .args([worker_cjs.to_string_lossy().to_string()])
        .current_dir(worker_dir.clone())
        .env("NODE_ENV", "production")
        .env(
            "SUPERTWIN_WHATSAPP_BIN",
            daemon_bin.to_string_lossy().to_string(),
        )
        // Home guard token (worker/src/home-guard.ts, S0.2): the worker refuses
        // to boot against ~/SuperTwinV13 unless the app launched it.
        .env("SUPERTWIN_LAUNCHED_BY", "app"))
}

/// Spawn the Node worker and wire up its stdout → `worker-ready` emission.
/// Installs the child and its private credential broker in shared lifecycle
/// state. The command itself is profile-specific; readiness detection and
/// teardown are identical for dev/release.
fn spawn_worker(app: &tauri::AppHandle, process: WorkerProcess) -> Result<(), String> {
    use keychain_broker::{account_for_home, BrokerActor};

    let home = worker_home_dir().ok_or_else(|| "worker home is unavailable".to_string())?;
    let account = account_for_home(&home).map_err(|_| "worker Keychain scope is invalid".to_string())?;
    let (broker, hello) = BrokerActor::start(account)
        .map_err(|_| "worker credential broker could not start".to_string())?;
    let command = build_worker_command(app)?.set_raw_out(true);

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    process.install(child, broker)?;
    if process.write(hello.as_bytes()).is_err() {
        process.kill();
        return Err("worker credential broker handshake failed".into());
    }

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
    let broker_process = process.clone();
    tauri::async_runtime::spawn(async move {
        let mut announced_ready = false;
        let mut stdout_demux = WorkerStdoutDemux::default();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let lines = match stdout_demux.push(&bytes) {
                        Ok(lines) => lines,
                        Err(()) => {
                            append_worker_log(&log, "[supertwinv13]", "worker stdout framing was refused");
                            broker_process.kill();
                            return;
                        }
                    };
                    for output in lines {
                        let line = match output {
                            WorkerStdoutLine::Broker(line) => {
                                let receiver = match broker_process.broker_request(line) {
                                Ok(receiver) => receiver,
                                Err(_) => {
                                    append_worker_log(&log, "[supertwinv13]", "credential broker refused a frame");
                                    broker_process.kill();
                                    return;
                                }
                                };
                                let response = tauri::async_runtime::spawn_blocking(move || receiver.recv()).await;
                                match response {
                                Ok(Ok(Ok(response))) if broker_process.write(response.as_bytes()).is_ok() => {}
                                _ => {
                                    append_worker_log(&log, "[supertwinv13]", "credential broker operation failed");
                                    broker_process.kill();
                                    return;
                                }
                                }
                                continue;
                            }
                            WorkerStdoutLine::Log(line) => line,
                        };
                        if !line.is_empty() {
                            println!("[worker] {line}");
                            append_worker_log(&log, "[worker]", &line);
                        }
                        if !announced_ready && line.contains("WORKER_READY") {
                            announced_ready = true;
                            println!("[supertwinv13] worker sidecar reported ready: {line}");
                            let _ = handle.emit("worker-ready", line.to_string());
                        }
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
                    broker_process.kill();
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(WorkerProcess::default())
        .invoke_handler(tauri::generate_handler![
            opener::open_external,
            accessibility::accessibility_status,
            accessibility::request_accessibility,
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
            let worker_state = handle.try_state::<WorkerProcess>().map(|state| state.inner().clone());
            match worker_state.ok_or_else(|| "worker process state unavailable".to_string())
                .and_then(|state| spawn_worker(handle, state)) {
                Ok(()) => {
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

#[cfg(test)]
mod tests {
    use super::{is_blocked_worker_env_key, sanitize_worker_environment, WorkerStdoutDemux, WorkerStdoutLine};
    use std::ffi::{OsStr, OsString};

    fn environment(entries: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        entries
            .iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect()
    }

    #[test]
    fn blocks_node_npm_and_dynamic_loader_injection() {
        for key in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "node_repl_external_module",
            "npm_config_node_options",
            "NPM_CONFIG_SCRIPT_SHELL",
            "DYLD_INSERT_LIBRARIES",
            "dyld_library_path",
            "LD_PRELOAD",
            "ld_library_path",
        ] {
            assert!(
                is_blocked_worker_env_key(OsStr::new(key)),
                "expected {key} to be blocked"
            );
        }
    }

    #[test]
    fn blocks_subprocess_runtime_startup_hooks() {
        for key in [
            "BASH_ENV",
            "ENV",
            "ZDOTDIR",
            "OPENSSL_CONF",
            "OPENSSL_MODULES",
            "PYTHONPATH",
            "PYTHONHOME",
            "PERL5OPT",
            "PERL5LIB",
            "RUBYOPT",
            "RUBYLIB",
            "JAVA_TOOL_OPTIONS",
            "_JAVA_OPTIONS",
            "JDK_JAVA_OPTIONS",
        ] {
            assert!(
                is_blocked_worker_env_key(OsStr::new(key)),
                "expected {key} to be blocked"
            );
        }
    }

    #[test]
    fn preserves_worker_home_and_ordinary_app_environment() {
        let sanitized = sanitize_worker_environment(environment(&[
            ("HOME", "/Users/test"),
            ("USER", "test"),
            ("LOGNAME", "test"),
            ("PATH", "/usr/bin:/bin"),
            ("LANG", "en_US.UTF-8"),
            ("SUPERTWIN_HOME", "/tmp/supertwin-home"),
            ("SUPERTWIN_FEATURE_FLAG", "enabled"),
            ("NODE_OPTIONS", "--require=/tmp/inject.js"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/inject.dylib"),
            ("BASH_ENV", "/tmp/inject.sh"),
        ]));

        assert_eq!(
            sanitized,
            environment(&[
                ("HOME", "/Users/test"),
                ("USER", "test"),
                ("LOGNAME", "test"),
                ("PATH", "/usr/bin:/bin"),
                ("LANG", "en_US.UTF-8"),
                ("SUPERTWIN_HOME", "/tmp/supertwin-home"),
                ("SUPERTWIN_FEATURE_FLAG", "enabled"),
            ])
        );
    }

    #[test]
    fn demuxes_arbitrary_chunks_without_exposing_broker_frames_as_logs() {
        let wire = format!("normal\n{}c2VjcmV0LWJvZHk\nWORKER_READY port=8013\n",
            crate::keychain_broker::REQUEST_PREFIX);
        for split in 0..=wire.len() {
            let mut demux = WorkerStdoutDemux::default();
            let mut output = demux.push(&wire.as_bytes()[..split]).unwrap();
            output.extend(demux.push(&wire.as_bytes()[split..]).unwrap());
            assert_eq!(output, vec![
                WorkerStdoutLine::Log("normal".into()),
                WorkerStdoutLine::Broker(format!("{}c2VjcmV0LWJvZHk", crate::keychain_broker::REQUEST_PREFIX)),
                WorkerStdoutLine::Log("WORKER_READY port=8013".into()),
            ]);
            assert!(!output.iter().any(|line| matches!(line, WorkerStdoutLine::Log(value) if value.contains("c2Vj"))));
        }
        let mut demux = WorkerStdoutDemux::default();
        assert!(demux.push(format!("partial{}c2VjcmV0\n", crate::keychain_broker::REQUEST_PREFIX).as_bytes()).is_err());
    }
}

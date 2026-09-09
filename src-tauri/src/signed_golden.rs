#[cfg(not(debug_assertions))]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(not(debug_assertions))]
use std::{fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Write}, os::{fd::AsRawFd,
    unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt}}, path::{Path, PathBuf}, process::{Command, Stdio}};
#[cfg(not(debug_assertions))]
use crate::keychain_broker::{account_for_home, BrokerActor, GoldenBrokerOptions, REQUEST_PREFIX};

#[cfg(not(debug_assertions))]
const DECLARATION_PREFIX: &str = "SUPERTWIN_SIGNED_GOLDEN_DECLARATION_V1 ";
#[cfg(not(debug_assertions))]
const APPROVAL_PREFIX: &str = "SUPERTWIN_SIGNED_GOLDEN_APPROVAL_V1 ";
#[cfg(not(debug_assertions))]
const RESULT_PREFIX: &str = "SUPERTWIN_SIGNED_GOLDEN_RESULT_V1 ";
const MAX_DECLARATION_BYTES: usize = 128 * 1024;
#[cfg(not(debug_assertions))]
const GOLDEN_TEAM_ID: &str = env!("SUPERTWIN_GOLDEN_TEAM_ID");
#[used]
static GOLDEN_TEAM_ID_ARTIFACT_MARKER: &str = concat!("SUPERTWIN_GOLDEN_TEAM_ID=", env!("SUPERTWIN_GOLDEN_TEAM_ID"));
#[cfg(not(debug_assertions))]
const MAX_FRAME_BYTES: usize = MAX_DECLARATION_BYTES * 2 + 128;

#[cfg(not(debug_assertions))]
fn read_bounded_line<R: BufRead>(reader: &mut R) -> Result<Option<String>, &'static str> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|_| "signed ChatGPT golden worker pipe failed")?;
        if available.is_empty() {
            if bytes.is_empty() { return Ok(None); }
            break;
        }
        let take = available.iter().position(|byte| *byte == b'\n').map_or(available.len(), |index| index + 1);
        if bytes.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err("signed ChatGPT golden worker frame was oversized");
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if bytes.last() == Some(&b'\n') { bytes.pop(); if bytes.last() == Some(&b'\r') { bytes.pop(); } break; }
    }
    String::from_utf8(bytes).map(Some).map_err(|_| "signed ChatGPT golden worker frame was invalid")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedGoldenLaunch {
    pub account_fingerprint: String,
    pub executor_model: String,
    pub judge_model: String,
}

fn safe_model(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.as_bytes()[0].is_ascii_alphanumeric() &&
        value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub fn parse_launch(args: &[String]) -> Result<Option<SignedGoldenLaunch>, &'static str> {
    if !args.iter().any(|value| value == "--signed-chatgpt-golden") { return Ok(None); }
    if args.len() != 7 || args.first().map(String::as_str) != Some("--signed-chatgpt-golden") {
        return Err("signed ChatGPT golden launch arguments are invalid");
    }
    let mut fingerprint = None; let mut executor = None; let mut judge = None;
    for pair in args[1..].chunks_exact(2) {
        match pair[0].as_str() {
            "--account-fingerprint" if fingerprint.is_none() => fingerprint = Some(pair[1].clone()),
            "--executor-model" if executor.is_none() => executor = Some(pair[1].clone()),
            "--judge-model" if judge.is_none() => judge = Some(pair[1].clone()),
            _ => return Err("signed ChatGPT golden launch arguments are invalid"),
        }
    }
    let result = SignedGoldenLaunch { account_fingerprint: fingerprint.ok_or("signed ChatGPT golden launch arguments are invalid")?,
        executor_model: executor.ok_or("signed ChatGPT golden launch arguments are invalid")?,
        judge_model: judge.ok_or("signed ChatGPT golden launch arguments are invalid")? };
    if result.account_fingerprint.len() != 12 || !result.account_fingerprint.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) ||
        !safe_model(&result.executor_model) || !safe_model(&result.judge_model) {
        return Err("signed ChatGPT golden launch arguments are invalid");
    }
    Ok(Some(result))
}

#[cfg(not(debug_assertions))]
fn fresh_directory(root: &Path, prefix: &str) -> Result<PathBuf, &'static str> {
    for _ in 0..16 {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| "signed ChatGPT golden scratch creation failed")?;
        let path = root.join(format!("{prefix}{}", hex::encode(random)));
        let mut builder = fs::DirBuilder::new(); builder.mode(0o700);
        match builder.create(&path) {
            Ok(()) => return fs::canonicalize(path).map_err(|_| "signed ChatGPT golden scratch creation failed"),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("signed ChatGPT golden scratch creation failed"),
        }
    }
    Err("signed ChatGPT golden scratch creation failed")
}

#[cfg(not(debug_assertions))]
struct ScratchDirectory(PathBuf);
#[cfg(not(debug_assertions))]
impl Drop for ScratchDirectory {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[cfg(not(debug_assertions))]
fn sha256_file(path: &Path) -> Result<String, &'static str> {
    let bytes = fs::read(path).map_err(|_| "signed ChatGPT golden bundle is unavailable")?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

#[cfg(not(debug_assertions))]
fn recovery_directory() -> Result<PathBuf, &'static str> {
    let home = std::env::var_os("HOME").ok_or("signed ChatGPT golden recovery scope is unavailable")?;
    let home = fs::canonicalize(home).map_err(|_| "signed ChatGPT golden recovery scope is unavailable")?;
    if !home.is_absolute() || home == Path::new("/") { return Err("signed ChatGPT golden recovery scope is unavailable"); }
    let library = home.join("Library");
    let app_support = library.join("Application Support");
    for ancestor in [&library, &app_support] {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| "signed ChatGPT golden recovery scope is unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("signed ChatGPT golden recovery scope is unavailable");
        }
    }
    let app_root = app_support.join("com.supertwin.v13");
    if !app_root.exists() { let mut builder = fs::DirBuilder::new(); builder.mode(0o700);
        builder.create(&app_root).map_err(|_| "signed ChatGPT golden recovery scope is unavailable")?; }
    let recovery = app_root.join("golden-recovery");
    if !recovery.exists() {
        let mut builder = fs::DirBuilder::new(); builder.mode(0o700);
        builder.create(&recovery).map_err(|_| "signed ChatGPT golden recovery scope is unavailable")?;
    }
    for private in [&app_root, &recovery] {
        let metadata = fs::symlink_metadata(private).map_err(|_| "signed ChatGPT golden recovery scope is unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() } ||
            metadata.mode() & 0o077 != 0 { return Err("signed ChatGPT golden recovery scope is unavailable"); }
    }
    let canonical = fs::canonicalize(&recovery).map_err(|_| "signed ChatGPT golden recovery scope is unavailable")?;
    if canonical != recovery { return Err("signed ChatGPT golden recovery scope is unavailable"); }
    Ok(canonical)
}

#[cfg(not(debug_assertions))]
fn acquire_ceremony_lease(root: &Path) -> Result<File, &'static str> {
    let path = root.join("ceremony.lock");
    let file = OpenOptions::new().read(true).write(true).create(true).mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(path)
        .map_err(|_| "another signed ChatGPT golden ceremony may be active")?;
    let metadata = file.metadata().map_err(|_| "another signed ChatGPT golden ceremony may be active")?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 ||
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("another signed ChatGPT golden ceremony may be active");
    }
    Ok(file)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
extern "C" {
    fn supertwin_signed_app_valid(path: *const std::os::raw::c_char, team: *const std::os::raw::c_char) -> i32;
    fn supertwin_confirm_golden(bytes: *const u8, length: usize) -> i32;
}

#[cfg(not(debug_assertions))]
fn validate_signed_app(path: &Path) -> bool {
    #[cfg(not(target_os = "macos"))] { let _ = path; false }
    #[cfg(target_os = "macos")] {
        use std::ffi::CString;
        let Ok(value) = CString::new(path.to_string_lossy().as_bytes()) else { return false; };
        let Ok(team) = CString::new(GOLDEN_TEAM_ID) else { return false; };
        !GOLDEN_TEAM_ID.is_empty() && unsafe { supertwin_signed_app_valid(value.as_ptr(), team.as_ptr()) == 1 }
    }
}

#[cfg(not(debug_assertions))]
fn confirm(declaration: &[u8]) -> bool {
    #[cfg(not(target_os = "macos"))] { let _ = declaration; false }
    #[cfg(target_os = "macos")] { unsafe { supertwin_confirm_golden(declaration.as_ptr(), declaration.len()) == 1 } }
}

fn validate_declaration(bytes: &[u8], stage: usize, config: &SignedGoldenLaunch,
                        bundle_sha: &str) -> Result<String, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_DECLARATION_BYTES { return Err("signed golden declaration was invalid"); }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "signed golden declaration was invalid")?;
    let object = value.as_object().ok_or("signed golden declaration was invalid")?;
    let authorization = object.get("authorization_id").and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        .ok_or("signed golden declaration was invalid")?;
    let has_exact_keys = |expected: &[&str]| object.len() == expected.len() &&
        expected.iter().all(|key| object.contains_key(*key));
    let mode = object.get("mode").and_then(Value::as_str).unwrap_or_default();
    let common = object.get("bundle_sha256").and_then(Value::as_str) == Some(bundle_sha) &&
        object.get("app_version").and_then(Value::as_str).is_some_and(|v| {
            let parts = v.split('.').collect::<Vec<_>>(); parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        });
    let login_ok = stage == 0 && has_exact_keys(&["mode", "app_version", "expected_account_fingerprint",
        "eval_home_identity", "bundle_sha256", "endpoints", "oauth_contract", "models", "quota", "refresh", "inference", "retries",
        "authorization_id"]) && mode == "P6-F signed-app ChatGPT OAuth" &&
        object.get("expected_account_fingerprint").and_then(Value::as_str) == Some(&config.account_fingerprint) &&
        ["models", "quota", "refresh", "inference", "retries"].iter().all(|key| object.get(*key) == Some(&Value::from(0))) &&
        object.get("eval_home_identity").and_then(Value::as_object).is_some_and(|identity| identity.len() == 3 &&
            identity.get("dev").is_some_and(Value::is_u64) && identity.get("ino").is_some_and(Value::is_u64) &&
            identity.get("mode").and_then(Value::as_str) == Some("0700")) &&
        object.get("endpoints") == Some(&serde_json::json!({
            "authorize": {"method":"GET", "url":"https://auth.openai.com/oauth/authorize", "calls":1},
            "callback": {"method":"GET", "url":"http://localhost:1455/auth/callback", "calls":1},
            "token": {"method":"POST", "url":"https://auth.openai.com/oauth/token", "calls":1}
        })) && object.get("oauth_contract") == Some(&serde_json::json!({
            "client_id":"app_EMoamEEZ73f0CkXaXp7hrann", "scope":"openid profile email offline_access",
            "redirect_uri":"http://localhost:1455/auth/callback", "response_type":"code", "code_challenge_method":"S256",
            "originator":"supertwinv13", "id_token_add_organizations":"true", "codex_cli_simplified_flow":"true",
            "token_content_type":"application/x-www-form-urlencoded", "token_accept":"application/json", "redirect":"error"
        }));
    let run_ok = stage == 1 && has_exact_keys(&["mode", "app_version", "provider", "executor_model", "judge_model",
        "expected_account_fingerprint", "fixture_sha256", "baseline_sha256", "gate_source_sha256", "code_identity_sha256", "bundle_sha256",
        "broker_binding_sha256", "absolute_physical_call_ceiling", "cases", "nominal_no_repair_physical_calls",
        "repairs_and_401_retries_are_counted", "inference_endpoint", "metadata_endpoint_call_ceilings", "oauth_actuals",
        "compatibility_canary", "cost", "authorization_id"]) && mode == "P6-F provider golden" &&
        object.get("provider").and_then(Value::as_str) == Some("chatgpt-oauth") &&
        object.get("executor_model").and_then(Value::as_str) == Some(&config.executor_model) &&
        object.get("judge_model").and_then(Value::as_str) == Some(&config.judge_model) &&
        object.get("expected_account_fingerprint").and_then(Value::as_str) == Some(&config.account_fingerprint) &&
        ["fixture_sha256", "baseline_sha256", "gate_source_sha256", "code_identity_sha256", "broker_binding_sha256"].iter().all(|key|
            object.get(*key).and_then(Value::as_str).is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))) &&
        object.get("absolute_physical_call_ceiling") == Some(&Value::from(696)) &&
        object.get("cases") == Some(&serde_json::json!({"live":116,"code":162})) &&
        object.get("nominal_no_repair_physical_calls") == Some(&Value::from(232)) &&
        object.get("repairs_and_401_retries_are_counted") == Some(&Value::Bool(true)) &&
        object.get("compatibility_canary").and_then(Value::as_str) == Some("suppressed_zero_calls") &&
        object.get("oauth_actuals") == Some(&serde_json::json!({"navigation":1,"callback":1,"token":1,"retries":0})) &&
        object.get("cost").and_then(Value::as_str) == Some("unknown") &&
        object.get("inference_endpoint") == Some(&serde_json::json!({"method":"POST","url":"https://chatgpt.com/backend-api/codex/responses"})) &&
        object.get("metadata_endpoint_call_ceilings") == Some(&serde_json::json!({
            "models":{"method":"GET","url":"https://chatgpt.com/backend-api/codex/models?client_version=1.0.0","calls":1},
            "quota":{"method":"GET","url":"https://chatgpt.com/backend-api/wham/usage","calls":697},
            "refresh":{"method":"POST","url":"https://auth.openai.com/oauth/token","calls":1394}
        }));
    if !common || (!login_ok && !run_ok) {
        return Err("signed golden declaration was invalid");
    }
    let mut unsigned = object.clone(); unsigned.remove("authorization_id");
    let expected = hex::encode(Sha256::digest(serde_json::to_vec(&Value::Object(unsigned))
        .map_err(|_| "signed golden declaration was invalid")?));
    if expected != authorization { return Err("signed golden declaration was invalid"); }
    Ok(authorization.to_string())
}

fn validate_result(value: &Value, config: &SignedGoldenLaunch, bundle_sha: &str,
                   run_authorization: &str) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("signed ChatGPT golden result was invalid")?;
    let counters = object.get("counters").and_then(Value::as_object).ok_or("signed ChatGPT golden result was invalid")?;
    let integer_keys = ["physical", "executor", "judgeInitial", "judgeRepair", "http401Retries", "models", "quota", "refresh"];
    let physical = counters.get("physical").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let executor = counters.get("executor").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let judge_initial = counters.get("judgeInitial").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let judge_repair = counters.get("judgeRepair").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let retries = counters.get("http401Retries").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let result_keys = ["code", "provider", "executor_model", "judge_model", "run_authorization_id", "bundle_sha256",
        "fixture_sha256", "baseline_sha256", "code_identity_sha256", "oauth_actuals", "counters", "cleanup_proven"];
    if object.len() != result_keys.len() || !result_keys.iter().all(|key| object.contains_key(*key)) ||
        object.get("cleanup_proven") != Some(&Value::Bool(true)) ||
        !matches!(object.get("code").and_then(Value::as_i64), Some(0 | 1)) || counters.len() != 9 ||
        object.get("provider").and_then(Value::as_str) != Some("chatgpt-oauth") ||
        object.get("executor_model").and_then(Value::as_str) != Some(&config.executor_model) ||
        object.get("judge_model").and_then(Value::as_str) != Some(&config.judge_model) ||
        object.get("run_authorization_id").and_then(Value::as_str) != Some(run_authorization) ||
        object.get("oauth_actuals") != Some(&serde_json::json!({"navigation":1,"callback":1,"token":1,"retries":0})) ||
        object.get("bundle_sha256").and_then(Value::as_str) != Some(bundle_sha) ||
        ["run_authorization_id", "fixture_sha256", "baseline_sha256", "code_identity_sha256"].iter().any(|key|
            !object.get(*key).and_then(Value::as_str).is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))) ||
        integer_keys.iter().any(|key| !counters.get(*key).is_some_and(Value::is_u64)) ||
        counters.get("claudeUsd").and_then(Value::as_f64) != Some(0.0) || physical > 696 || executor > 232 ||
        judge_initial > 232 || judge_repair > 232 || physical != executor.saturating_add(judge_initial).saturating_add(judge_repair) ||
        retries > physical || counters.get("models").and_then(Value::as_u64).unwrap_or(u64::MAX) > 1 ||
        counters.get("quota").and_then(Value::as_u64).unwrap_or(u64::MAX) > 697 ||
        counters.get("refresh").and_then(Value::as_u64).unwrap_or(u64::MAX) > 1394 {
        return Err("signed ChatGPT golden result was invalid");
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn run_release(config: SignedGoldenLaunch) -> Result<i32, &'static str> {
    if GOLDEN_TEAM_ID.is_empty() { return Err("signed ChatGPT golden requires a Developer ID Team configuration"); }
    let executable = std::env::current_exe().map_err(|_| "signed ChatGPT golden app identity is unavailable")?;
    let macos = executable.parent().ok_or("signed ChatGPT golden app identity is unavailable")?;
    let contents = macos.parent().ok_or("signed ChatGPT golden app identity is unavailable")?;
    let app_root = contents.parent().ok_or("signed ChatGPT golden app identity is unavailable")?;
    if app_root.extension().and_then(|value| value.to_str()) != Some("app") || !validate_signed_app(app_root) {
        return Err("signed ChatGPT golden requires a valid packaged app");
    }
    let worker = contents.join("Resources/worker");
    let node = macos.join("node"); let golden = worker.join("golden.cjs");
    let bundle_sha = sha256_file(&golden)?;
    let recovery_root = recovery_directory()?;
    let _ceremony_lease = acquire_ceremony_lease(&recovery_root)?;
    let receipt = recovery_root.join("receipt.json");
    BrokerActor::recover_golden(&receipt)
        .map_err(|_| "signed ChatGPT golden crash recovery is unproven")?;
    let temp = fs::canonicalize(std::env::temp_dir()).map_err(|_| "signed ChatGPT golden scratch creation failed")?;
    let eval_home = fresh_directory(&temp, "supertwin-signed-golden-")?;
    let _scratch = ScratchDirectory(eval_home.clone());
    let account = account_for_home(&eval_home).map_err(|_| "signed ChatGPT golden Keychain scope is invalid")?;
    let (mut broker, hello) = BrokerActor::start_golden(account, GoldenBrokerOptions {
        expected_account_fingerprint: config.account_fingerprint.clone(), receipt_path: receipt,
    }).map_err(|_| "signed ChatGPT golden broker could not start")?;
    let metadata = fs::metadata(&eval_home).map_err(|_| "signed ChatGPT golden scratch identity is unavailable")?;
    let mut child = Command::new(node).arg(&golden).args(["--signed-chatgpt-golden", "--eval-home"])
        .arg(&eval_home).args(["--account-fingerprint", &config.account_fingerprint,
            "--executor-model", &config.executor_model, "--judge-model", &config.judge_model,
            "--bundle-sha256", &bundle_sha, "--eval-home-dev", &metadata.dev().to_string(),
            "--eval-home-ino", &metadata.ino().to_string()])
        .current_dir(&worker).env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .envs(std::env::vars_os().filter(|(key, _)| matches!(key.to_str(),
            Some("HOME" | "USER" | "LOGNAME" | "LANG" | "LC_ALL" | "TMPDIR"))))
        .env("NODE_ENV", "production").env("SUPERTWIN_SIGNED_GOLDEN_BROKER", "1")
        .env("SUPERTWIN_GOLDEN_BUNDLE_ROOT", &worker)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "signed ChatGPT golden worker could not start")?;
    let mut input = child.stdin.take().ok_or("signed ChatGPT golden worker pipe failed")?;
    input.write_all(hello.as_bytes()).map_err(|_| "signed ChatGPT golden worker pipe failed")?;
    let output = child.stdout.take().ok_or("signed ChatGPT golden worker pipe failed")?;
    let result = (|| {
        let mut stage = 0usize;
        let mut run_authorization: Option<String> = None;
        let mut terminal_evidence: Option<Value> = None;
        let mut reader = BufReader::new(output);
        while let Some(line) = read_bounded_line(&mut reader)? {
            if line.starts_with(REQUEST_PREFIX) {
                let receiver = broker.request(line).map_err(|_| "signed ChatGPT golden broker refused a frame")?;
                let response = receiver.recv().map_err(|_| "signed ChatGPT golden broker failed")?
                    .map_err(|_| "signed ChatGPT golden broker failed")?;
                input.write_all(response.as_bytes()).map_err(|_| "signed ChatGPT golden worker pipe failed")?;
            } else if let Some(encoded) = line.strip_prefix(DECLARATION_PREFIX) {
                if stage >= 2 || encoded.len() > MAX_DECLARATION_BYTES * 2 { return Err("signed golden declaration was invalid"); }
                let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "signed golden declaration was invalid")?;
                if URL_SAFE_NO_PAD.encode(&bytes) != encoded { return Err("signed golden declaration was invalid"); }
                if !validate_signed_app(app_root) { return Err("signed ChatGPT golden app identity changed"); }
                let authorization = validate_declaration(&bytes, stage, &config, &bundle_sha)?;
                if !confirm(&bytes) { return Err("signed ChatGPT golden owner declined"); }
                input.write_all(format!("{APPROVAL_PREFIX}{authorization}\n").as_bytes())
                    .map_err(|_| "signed ChatGPT golden worker pipe failed")?;
                if stage == 1 { run_authorization = Some(authorization.clone()); }
                stage += 1;
            } else if let Some(encoded) = line.strip_prefix(RESULT_PREFIX) {
                if terminal_evidence.is_some() || encoded.len() > MAX_DECLARATION_BYTES * 2 {
                    return Err("signed ChatGPT golden result was invalid");
                }
                let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "signed ChatGPT golden result was invalid")?;
                if URL_SAFE_NO_PAD.encode(&bytes) != encoded { return Err("signed ChatGPT golden result was invalid"); }
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| "signed ChatGPT golden result was invalid")?;
                validate_result(&value, &config, &bundle_sha,
                    run_authorization.as_deref().ok_or("signed ChatGPT golden result was invalid")?)?;
                terminal_evidence = Some(value);
            }
        }
        let status = child.wait().map_err(|_| "signed ChatGPT golden worker did not terminate")?;
        let evidence = terminal_evidence.ok_or("signed ChatGPT golden execution failed")?;
        let evidence_code = evidence.get("code").and_then(Value::as_i64).unwrap_or(2) as i32;
        if stage != 2 || !matches!(status.code(), Some(0 | 1)) || status.code() != Some(evidence_code) {
            return Err("signed ChatGPT golden execution failed");
        }
        Ok((evidence_code, evidence))
    })();
    if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
    let cleanup = broker.shutdown();
    if cleanup.is_err() { return Err("signed ChatGPT golden credential cleanup is unproven"); }
    let (code, evidence) = result?;
    println!("signed ChatGPT golden result: {evidence}");
    Ok(code)
}

pub fn maybe_run(args: &[String]) -> Option<i32> {
    let parsed = match parse_launch(args) {
        Ok(None) => return None,
        Ok(Some(value)) => value,
        Err(message) => { eprintln!("{message}"); return Some(2); }
    };
    #[cfg(debug_assertions)] { let _ = parsed; eprintln!("signed ChatGPT golden requires a packaged release app"); Some(2) }
    #[cfg(not(debug_assertions))] {
        Some(match run_release(parsed) { Ok(code) => code, Err(message) => { eprintln!("{message}"); 2 } })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_mode_is_closed_and_models_are_safe() {
        let args = vec!["--signed-chatgpt-golden", "--account-fingerprint", "aabbccddeeff",
            "--executor-model", "gpt-5.6-sol", "--judge-model", "gpt-5.6-sol"].into_iter().map(str::to_string).collect::<Vec<_>>();
        assert!(parse_launch(&args).unwrap().is_some());
        let mut duplicate = args.clone(); duplicate[5] = "--executor-model".into();
        assert!(parse_launch(&duplicate).is_err());
        let mut unsafe_model = args; unsafe_model[4] = "gpt\npoison".into();
        assert!(parse_launch(&unsafe_model).is_err());
        assert_eq!(parse_launch(&["ordinary".into()]).unwrap(), None);
    }

    #[test]
    fn declarations_bind_exact_stage_models_budget_and_canonical_authorization() {
        let config = SignedGoldenLaunch { account_fingerprint: "aabbccddeeff".into(),
            executor_model: "gpt-5.6-sol".into(), judge_model: "gpt-5.6-sol".into() };
        let mut unsigned = serde_json::json!({ "mode":"P6-F provider golden", "provider":"chatgpt-oauth",
            "app_version":"13.12.2", "executor_model":"gpt-5.6-sol", "judge_model":"gpt-5.6-sol",
            "expected_account_fingerprint":"aabbccddeeff", "fixture_sha256":"f".repeat(64),
            "baseline_sha256":"a".repeat(64), "gate_source_sha256":"c".repeat(64),
            "code_identity_sha256":"d".repeat(64), "bundle_sha256":"b".repeat(64),
            "broker_binding_sha256":"e".repeat(64), "absolute_physical_call_ceiling":696,
            "cases":{"live":116,"code":162}, "nominal_no_repair_physical_calls":232,
            "repairs_and_401_retries_are_counted":true,
            "inference_endpoint":{"method":"POST","url":"https://chatgpt.com/backend-api/codex/responses"},
            "metadata_endpoint_call_ceilings":{
                "models":{"method":"GET","url":"https://chatgpt.com/backend-api/codex/models?client_version=1.0.0","calls":1},
                "quota":{"method":"GET","url":"https://chatgpt.com/backend-api/wham/usage","calls":697},
                "refresh":{"method":"POST","url":"https://auth.openai.com/oauth/token","calls":1394}},
            "oauth_actuals":{"navigation":1,"callback":1,"token":1,"retries":0},
            "compatibility_canary":"suppressed_zero_calls", "cost":"unknown" });
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(&unsigned).unwrap()));
        unsigned.as_object_mut().unwrap().insert("authorization_id".into(), Value::String(digest.clone()));
        assert_eq!(validate_declaration(&serde_json::to_vec(&unsigned).unwrap(), 1, &config, &"b".repeat(64)).unwrap(), digest);
        unsigned.as_object_mut().unwrap().insert("absolute_physical_call_ceiling".into(), Value::from(697));
        assert!(validate_declaration(&serde_json::to_vec(&unsigned).unwrap(), 1, &config, &"b".repeat(64)).is_err());
    }

    #[test]
    fn terminal_evidence_binds_oauth_actuals_models_authorization_and_bounds() {
        let config = SignedGoldenLaunch { account_fingerprint: "aabbccddeeff".into(),
            executor_model: "gpt-5.6-sol".into(), judge_model: "gpt-5.6-sol".into() };
        let mut value = serde_json::json!({"code":0,"provider":"chatgpt-oauth","executor_model":"gpt-5.6-sol",
            "judge_model":"gpt-5.6-sol","run_authorization_id":"a".repeat(64),"bundle_sha256":"b".repeat(64),
            "fixture_sha256":"c".repeat(64),"baseline_sha256":"d".repeat(64),"code_identity_sha256":"e".repeat(64),
            "oauth_actuals":{"navigation":1,"callback":1,"token":1,"retries":0},"cleanup_proven":true,
            "counters":{"physical":2,"executor":1,"judgeInitial":1,"judgeRepair":0,"http401Retries":0,
                "claudeUsd":0,"models":1,"quota":2,"refresh":0}});
        assert!(validate_result(&value, &config, &"b".repeat(64), &"a".repeat(64)).is_ok());
        value["oauth_actuals"]["retries"] = Value::from(1);
        assert!(validate_result(&value, &config, &"b".repeat(64), &"a".repeat(64)).is_err());
    }

    #[test]
    fn native_requirement_is_developer_id_application_and_team_bound() {
        let source = include_str!("keychain_broker_bridge.m");
        assert!(source.contains("anchor apple generic and identifier \\\"com.supertwin.v13\\\""));
        assert!(source.contains("certificate leaf[subject.OU]"));
        assert!(source.contains("certificate 1[field.1.2.840.113635.100.6.1.13] exists"));
    }
}

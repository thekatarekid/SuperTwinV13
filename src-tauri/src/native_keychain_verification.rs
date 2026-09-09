use serde::{Deserialize, Serialize};
use std::ffi::OsString;
#[cfg(not(debug_assertions))]
use sha2::{Digest, Sha256};
#[cfg(not(debug_assertions))]
use std::{ffi::CString, fs::{self, File, OpenOptions}, io::{Read, Write}, os::{fd::AsRawFd,
    unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt}}, path::{Path, PathBuf}, process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering}, thread, time::{Duration, Instant}};
#[cfg(not(debug_assertions))]
use crate::keychain_broker::{account_for_home, BrokerActor, GoldenBrokerOptions};

pub const NATIVE_VERIFY_FLAG: &str = "--verify-native-keychain";
pub const NATIVE_VERIFY_ADHOC_FLAG: &str = "--allow-temp-adhoc-resign";
const COPY_FLAG: &str = "--native-keychain-copy-phase";
#[cfg(not(debug_assertions))]
const TEAM_ID: &str = env!("SUPERTWIN_GOLDEN_TEAM_ID");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SigningMode { DeveloperId, LocalAdhoc }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeVerificationLaunch { pub signing_mode: SigningMode }

pub fn parse_launch(args: &[String], developer_id_available: bool)
    -> Result<Option<NativeVerificationLaunch>, &'static str> {
    if !args.iter().any(|value| value == NATIVE_VERIFY_FLAG) { return Ok(None); }
    if args.first().map(String::as_str) != Some(NATIVE_VERIFY_FLAG) || args.len() > 2 {
        return Err("native Keychain verification launch arguments are invalid");
    }
    let adhoc = args.get(1).map(String::as_str) == Some(NATIVE_VERIFY_ADHOC_FLAG);
    if args.len() == 2 && !adhoc { return Err("native Keychain verification launch arguments are invalid"); }
    Ok(Some(NativeVerificationLaunch { signing_mode: if adhoc { SigningMode::LocalAdhoc }
        else if developer_id_available { SigningMode::DeveloperId }
        else { return Err("native Keychain verification requires Developer ID signing or explicit local-only ad-hoc mode"); } }))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AclEvidence {
    pub allow_all_applications: bool,
    pub trusted_application_count: u64,
    pub authorization_count: u64,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeVerificationEvidence {
    pub status: &'static str,
    pub signing_mode: SigningMode,
    pub local_only: bool,
    pub network_calls: u8,
    pub browser_calls: u8,
    pub oauth_calls: u8,
    pub metadata_calls: u8,
    pub inference_calls: u8,
    pub source_app_untouched: bool,
    pub copied_app_access: bool,
    pub acl_unchanged: bool,
    pub removed_and_absent: bool,
    pub high_level_steps: NativeVerificationSteps,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeVerificationSteps {
    pub owner_confirmations: u8,
    pub recovery_checks: u8,
    pub source_identity_checks: u8,
    pub dummy_creates: u8,
    pub dummy_digest_reads: u8,
    pub acl_snapshots: u8,
    pub dummy_deletes: u8,
    pub absence_proofs: u8,
    pub app_copies: u8,
    pub temporary_resigns: u8,
    pub broker_handoffs: u8,
    pub broker_resumes: u8,
}

fn expected_steps() -> NativeVerificationSteps {
    NativeVerificationSteps { owner_confirmations:2,recovery_checks:1,source_identity_checks:2,
        dummy_creates:1,dummy_digest_reads:2,acl_snapshots:3,dummy_deletes:1,absence_proofs:1,
        app_copies:1,temporary_resigns:1,broker_handoffs:2,broker_resumes:2 }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopyOperationOutcome { pub digest:String, pub digest_reads:u8, pub acl_snapshots:u8,
    pub app_copies:u8, pub temporary_resigns:u8, pub broker_handoffs:u8, pub broker_resumes:u8 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupOutcome { pub dummy_deletes:u8, pub absence_proofs:u8 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationError { Refused, Identity, Broker, Acl, Copy, Cleanup, Cancelled, Timeout }

pub trait NativeVerificationOps {
    fn approve(&mut self, declaration: &[u8]) -> Result<bool, VerificationError>;
    fn recover(&mut self) -> Result<(), VerificationError>;
    fn source_identity(&mut self) -> Result<String, VerificationError>;
    fn create_dummy(&mut self) -> Result<String, VerificationError>;
    fn read_dummy_digest(&mut self) -> Result<String, VerificationError>;
    fn acl_evidence(&mut self) -> Result<AclEvidence, VerificationError>;
    fn approve_acl(&mut self, evidence: &AclEvidence) -> Result<bool, VerificationError>;
    fn copy_resign_verify_and_read(&mut self, expected_digest: &str) -> Result<CopyOperationOutcome, VerificationError>;
    fn cleanup_and_prove_absent(&mut self) -> Result<CleanupOutcome, VerificationError>;
    fn cancelled(&self) -> bool { false }
}

fn safe_digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }

pub fn declaration(mode: SigningMode) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "mode":"P6-D broker-native Keychain verification", "signing_mode":mode,
        "local_only":matches!(mode, SigningMode::LocalAdhoc),
        "high_level_steps":expected_steps(),
        "counter_semantics":"instrumented ceremony boundaries; not raw Security.framework query counts",
        "network":0,"browser":0,"oauth":0,"metadata":0,"inference":0,"retries":0,
        "data":"cryptographically-random dummy credential only", "cleanup":"exact broker-owned item and scratch copy"
    })).expect("closed declaration")
}

pub fn run_ceremony<O: NativeVerificationOps>(mode: SigningMode, operations: &mut O)
    -> Result<NativeVerificationEvidence, VerificationError> {
    let ensure_active = |operations: &O| if operations.cancelled() { Err(VerificationError::Cancelled) } else { Ok(()) };
    let mut steps = NativeVerificationSteps { owner_confirmations:0,recovery_checks:0,source_identity_checks:0,
        dummy_creates:0,dummy_digest_reads:0,acl_snapshots:0,dummy_deletes:0,absence_proofs:0,
        app_copies:0,temporary_resigns:0,broker_handoffs:0,broker_resumes:0 };
    let declaration = declaration(mode);
    ensure_active(operations)?;
    if !operations.approve(&declaration)? { return Err(VerificationError::Refused); }
    steps.owner_confirmations += 1;
    ensure_active(operations)?;
    operations.recover()?;
    steps.recovery_checks += 1;
    ensure_active(operations)?;
    let source_before = operations.source_identity()?;
    steps.source_identity_checks += 1;
    if !safe_digest(&source_before) { return Err(VerificationError::Identity); }
    let mut created = false;
    let mut acl_for_confirmation = None;
    let run = (|| {
        created = true;
        let created_digest = operations.create_dummy()?;
        steps.dummy_creates += 1;
        ensure_active(operations)?;
        if !safe_digest(&created_digest) || operations.read_dummy_digest()? != created_digest { return Err(VerificationError::Broker); }
        steps.dummy_digest_reads += 1;
        ensure_active(operations)?;
        let acl_before = operations.acl_evidence()?;
        steps.acl_snapshots += 1;
        if acl_before.allow_all_applications || !safe_digest(&acl_before.fingerprint) || acl_before.authorization_count == 0 {
            return Err(VerificationError::Acl);
        }
        let copied = operations.copy_resign_verify_and_read(&created_digest)?;
        if copied.digest != created_digest { return Err(VerificationError::Copy); }
        steps.dummy_digest_reads = steps.dummy_digest_reads.checked_add(copied.digest_reads).ok_or(VerificationError::Identity)?;
        steps.acl_snapshots = steps.acl_snapshots.checked_add(copied.acl_snapshots).ok_or(VerificationError::Identity)?;
        steps.app_copies = copied.app_copies;
        steps.temporary_resigns = copied.temporary_resigns;
        steps.broker_handoffs = copied.broker_handoffs;
        steps.broker_resumes = copied.broker_resumes;
        ensure_active(operations)?;
        let acl_after = operations.acl_evidence()?;
        steps.acl_snapshots += 1;
        if acl_after != acl_before { return Err(VerificationError::Acl); }
        if operations.source_identity()? != source_before { return Err(VerificationError::Identity); }
        steps.source_identity_checks += 1;
        acl_for_confirmation = Some(acl_before);
        Ok(())
    })();
    let cleanup = if created { operations.cleanup_and_prove_absent() } else { Ok(CleanupOutcome{dummy_deletes:0,absence_proofs:0}) };
    let cleanup = cleanup.map_err(|_| VerificationError::Cleanup)?;
    steps.dummy_deletes = cleanup.dummy_deletes;
    steps.absence_proofs = cleanup.absence_proofs;
    run?;
    let mut before_final_confirmation = expected_steps();
    before_final_confirmation.owner_confirmations = 1;
    if steps != before_final_confirmation { return Err(VerificationError::Identity); }
    ensure_active(operations)?;
    if !operations.approve_acl(acl_for_confirmation.as_ref().ok_or(VerificationError::Acl)?)? {
        return Err(VerificationError::Refused);
    }
    steps.owner_confirmations += 1;
    ensure_active(operations)?;
    if steps != expected_steps() { return Err(VerificationError::Identity); }
    Ok(NativeVerificationEvidence { status:"passed", signing_mode:mode,
        local_only:matches!(mode, SigningMode::LocalAdhoc), network_calls:0, browser_calls:0, oauth_calls:0,
        metadata_calls:0, inference_calls:0, source_app_untouched:true, copied_app_access:true,
        acl_unchanged:true, removed_and_absent:true, high_level_steps:steps })
}

fn allowed_subprocess_environment(source: impl IntoIterator<Item=(OsString, OsString)>) -> Vec<(OsString, OsString)> {
    source.into_iter().filter(|(key, _)| matches!(key.to_str(),
        Some("HOME" | "USER" | "LOGNAME" | "LANG" | "LC_ALL" | "TMPDIR"))).collect()
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
extern "C" {
    fn supertwin_signed_app_valid(path: *const std::os::raw::c_char, team: *const std::os::raw::c_char) -> i32;
    fn supertwin_native_verification_app_valid(path: *const std::os::raw::c_char) -> i32;
    fn supertwin_confirm_native_verification(bytes: *const u8, length: usize) -> i32;
}

#[cfg(not(debug_assertions))]
fn app_valid(path: &Path, mode: SigningMode) -> bool {
    #[cfg(not(target_os = "macos"))] { let _ = (path, mode); false }
    #[cfg(target_os = "macos")] {
        let Ok(path) = CString::new(path.to_string_lossy().as_bytes()) else { return false; };
        match mode {
            SigningMode::LocalAdhoc => unsafe { supertwin_native_verification_app_valid(path.as_ptr()) == 1 },
            SigningMode::DeveloperId => {
                let Ok(team) = CString::new(TEAM_ID) else { return false; };
                !TEAM_ID.is_empty() && unsafe { supertwin_signed_app_valid(path.as_ptr(), team.as_ptr()) == 1 }
            }
        }
    }
}

#[cfg(not(debug_assertions))]
fn native_confirm(bytes: &[u8]) -> bool {
    #[cfg(not(target_os = "macos"))] { let _ = bytes; false }
    #[cfg(target_os = "macos")] { unsafe { supertwin_confirm_native_verification(bytes.as_ptr(), bytes.len()) == 1 } }
}

#[cfg(not(debug_assertions))]
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(not(debug_assertions))]
extern "C" fn request_cancel(_: libc::c_int) { CANCEL_REQUESTED.store(true, Ordering::SeqCst); }

#[cfg(not(debug_assertions))]
fn install_cancellation() -> Result<(), VerificationError> {
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    let handler = request_cancel as *const () as libc::sighandler_t;
    if unsafe { libc::signal(libc::SIGINT, handler) } == libc::SIG_ERR
        || unsafe { libc::signal(libc::SIGTERM, handler) } == libc::SIG_ERR {
        return Err(VerificationError::Identity);
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn run_command(executable: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, VerificationError> {
    let mut child = Command::new(executable);
    child.args(args).env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .envs(allowed_subprocess_environment(std::env::vars_os()))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = child.spawn().map_err(|_| VerificationError::Copy)?;
    if let Some(mut stdin) = child.stdin.take() { if let Some(value) = input { stdin.write_all(value).map_err(|_| VerificationError::Copy)?; } }
    let stdout = child.stdout.take().ok_or(VerificationError::Copy)?;
    let stderr = child.stderr.take().ok_or(VerificationError::Copy)?;
    let out = thread::spawn(move || { let mut bytes=Vec::new(); stdout.take(131_073).read_to_end(&mut bytes).map(|_| bytes) });
    let err = thread::spawn(move || { let mut bytes=Vec::new(); stderr.take(131_073).read_to_end(&mut bytes).map(|_| bytes) });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| VerificationError::Copy)? { break status; }
        if CANCEL_REQUESTED.load(Ordering::SeqCst) { let _=child.kill(); let _=child.wait(); return Err(VerificationError::Cancelled); }
        if started.elapsed() > Duration::from_secs(30) { let _=child.kill(); let _=child.wait(); return Err(VerificationError::Timeout); }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = out.join().map_err(|_| VerificationError::Copy)?.map_err(|_| VerificationError::Copy)?;
    let stderr = err.join().map_err(|_| VerificationError::Copy)?.map_err(|_| VerificationError::Copy)?;
    if !status.success() || stdout.len()>131_072 || stderr.len()>131_072 { return Err(VerificationError::Copy); }
    let mut combined=stdout; combined.extend_from_slice(&stderr); Ok(combined)
}

#[cfg(not(debug_assertions))]
fn recovery_root() -> Result<PathBuf, VerificationError> {
    let home = fs::canonicalize(std::env::var_os("HOME").ok_or(VerificationError::Identity)?)
        .map_err(|_| VerificationError::Identity)?;
    let support = home.join("Library/Application Support");
    let app = support.join("com.supertwin.v13");
    if !app.exists() { let mut builder=fs::DirBuilder::new(); builder.mode(0o700); builder.create(&app).map_err(|_| VerificationError::Identity)?; }
    let root=app.join("native-keychain-verification");
    if !root.exists() { let mut builder=fs::DirBuilder::new(); builder.mode(0o700); builder.create(&root).map_err(|_| VerificationError::Identity)?; }
    for path in [&app,&root] { let m=fs::symlink_metadata(path).map_err(|_| VerificationError::Identity)?;
        if !m.is_dir() || m.file_type().is_symlink() || m.uid()!=unsafe{libc::geteuid()} || m.mode()&0o077!=0 { return Err(VerificationError::Identity); } }
    let canonical=fs::canonicalize(&root).map_err(|_| VerificationError::Identity)?;
    if canonical!=root { return Err(VerificationError::Identity); } Ok(canonical)
}

#[cfg(not(debug_assertions))]
fn acquire_global_lease(root:&Path)->Result<File,VerificationError>{
    let file=OpenOptions::new().read(true).write(true).create(true).mode(0o600)
        .custom_flags(libc::O_CLOEXEC|libc::O_NOFOLLOW).open(root.join("ceremony.lock")).map_err(|_|VerificationError::Identity)?;
    let m=file.metadata().map_err(|_|VerificationError::Identity)?;
    if !m.is_file()||m.uid()!=unsafe{libc::geteuid()}||m.mode()&0o077!=0||unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0{return Err(VerificationError::Identity)} Ok(file)
}

#[cfg(not(debug_assertions))]
fn fresh_dir(root:&Path,prefix:&str)->Result<PathBuf,VerificationError>{
    for _ in 0..16 { let mut random=[0u8;16]; getrandom::fill(&mut random).map_err(|_|VerificationError::Identity)?;
        let path=root.join(format!("{prefix}{}",hex::encode(random))); let mut builder=fs::DirBuilder::new();builder.mode(0o700);
        match builder.create(&path){Ok(())=>return fs::canonicalize(path).map_err(|_|VerificationError::Identity),Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,Err(_)=>return Err(VerificationError::Identity)} }
    Err(VerificationError::Identity)
}

#[cfg(not(debug_assertions))]
struct Scratch(PathBuf);
#[cfg(not(debug_assertions))]
impl Drop for Scratch { fn drop(&mut self){let _=fs::remove_dir_all(&self.0);} }

#[cfg(not(debug_assertions))]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyEvidence { outcome:CopyOperationOutcome, acl:AclEvidence }

#[cfg(not(debug_assertions))]
struct SystemOps {
    mode:SigningMode, source_app:PathBuf, recovery:PathBuf,
    receipt:PathBuf, lease:Option<File>, scratch:Option<Scratch>, eval_home:Option<PathBuf>, copy:Option<PathBuf>,
    actor:Option<BrokerActor>, envelope:Vec<u8>, expected_digest:String, source_authority:Option<String>, acl_before:Option<AclEvidence>,
}

#[cfg(not(debug_assertions))]
impl SystemOps {
    fn new(mode:SigningMode)->Result<Self,VerificationError>{
        let source_exe=std::env::current_exe().map_err(|_|VerificationError::Identity)?;
        let source_app=source_exe.parent().and_then(Path::parent).and_then(Path::parent).map(Path::to_path_buf).ok_or(VerificationError::Identity)?;
        if source_app.extension().and_then(|v|v.to_str())!=Some("app")||!app_valid(&source_app,mode){return Err(VerificationError::Identity)}
        Ok(Self{mode,source_app,recovery:PathBuf::new(),receipt:PathBuf::new(),lease:None,scratch:None,eval_home:None,copy:None,actor:None,envelope:Vec::new(),expected_digest:String::new(),source_authority:None,acl_before:None})
    }
    fn actor(&self)->Result<&BrokerActor,VerificationError>{self.actor.as_ref().ok_or(VerificationError::Broker)}
    fn signature(&mut self,path:&Path)->Result<String,VerificationError>{
        if !app_valid(path,self.mode){return Err(VerificationError::Identity)}
        run_command(Path::new("/usr/bin/codesign"),&["--verify","--deep","--strict",path.to_str().ok_or(VerificationError::Identity)?],None)?;
        let bytes=run_command(Path::new("/usr/bin/codesign"),&["-dv","--verbose=4",path.to_str().ok_or(VerificationError::Identity)?],None)?;
        let text=String::from_utf8_lossy(&bytes);
        if self.mode==SigningMode::DeveloperId { self.source_authority=text.lines().find_map(|l|l.strip_prefix("Authority=Developer ID Application:")).map(|v|format!("Developer ID Application:{v}"));
            if self.source_authority.is_none(){return Err(VerificationError::Identity)} }
        Ok(hex::encode(Sha256::digest(&bytes)))
    }
}

#[cfg(not(debug_assertions))]
impl NativeVerificationOps for SystemOps {
    fn approve(&mut self,d:&[u8])->Result<bool,VerificationError>{Ok(native_confirm(d))}
    fn recover(&mut self)->Result<(),VerificationError>{
        self.recovery=recovery_root()?; self.lease=Some(acquire_global_lease(&self.recovery)?); self.receipt=self.recovery.join("receipt.json");
        BrokerActor::recover_golden(&self.receipt).map_err(|_|VerificationError::Cleanup)?;
        let temp=fs::canonicalize(std::env::temp_dir()).map_err(|_|VerificationError::Identity)?;
        let root=fresh_dir(&temp,"supertwin-native-keychain-")?; self.scratch=Some(Scratch(root.clone()));
        let eval=fresh_dir(&root,"home-")?; let copy=root.join("SuperTwinV13.app"); self.eval_home=Some(eval.clone()); self.copy=Some(copy);
        let mut random=[0u8;32];getrandom::fill(&mut random).map_err(|_|VerificationError::Broker)?;
        let account_id=format!("native-dummy-{}",hex::encode(&random[..16])); let fingerprint=hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        self.envelope=serde_json::to_vec(&serde_json::json!({"version":1,"current":{"accessToken":format!("dummy-access-{}",hex::encode(random)),"refreshToken":format!("dummy-refresh-{}",hex::encode(Sha256::digest(random))),"expiresAtMs":4102444800000u64,"accountId":account_id}})).map_err(|_|VerificationError::Broker)?;
        self.expected_digest=hex::encode(Sha256::digest(&self.envelope));
        let account=account_for_home(&eval).map_err(|_|VerificationError::Identity)?;
        self.actor=Some(BrokerActor::start_golden(account,GoldenBrokerOptions{expected_account_fingerprint:fingerprint,receipt_path:self.receipt.clone()}).map_err(|_|VerificationError::Broker)?.0); Ok(())
    }
    fn source_identity(&mut self)->Result<String,VerificationError>{let path=self.source_app.clone();self.signature(&path)}
    fn create_dummy(&mut self)->Result<String,VerificationError>{self.actor()?.local_golden_upsert(self.envelope.clone()).map_err(|_|VerificationError::Broker)?;Ok(self.expected_digest.clone())}
    fn read_dummy_digest(&mut self)->Result<String,VerificationError>{self.actor()?.local_golden_read_digest().map_err(|_|VerificationError::Broker)}
    fn acl_evidence(&mut self)->Result<AclEvidence,VerificationError>{let a=self.actor()?.local_golden_acl_snapshot().map_err(|_|VerificationError::Acl)?;let a=AclEvidence{allow_all_applications:a.allow_all_applications,trusted_application_count:a.trusted_application_count,authorization_count:a.authorization_count,fingerprint:a.fingerprint};if self.acl_before.is_none(){self.acl_before=Some(a.clone())}Ok(a)}
    fn approve_acl(&mut self,e:&AclEvidence)->Result<bool,VerificationError>{let bytes=serde_json::to_vec(&serde_json::json!({"mode":"P6-D targeted ACL confirmation","acl":e})).map_err(|_|VerificationError::Acl)?;Ok(native_confirm(&bytes))}
    fn copy_resign_verify_and_read(&mut self,expected:&str)->Result<CopyOperationOutcome,VerificationError>{
        let source=self.source_app.to_str().ok_or(VerificationError::Copy)?;let copy=self.copy.as_ref().ok_or(VerificationError::Copy)?.to_str().ok_or(VerificationError::Copy)?;
        run_command(Path::new("/usr/bin/codesign"),&["--verify","--deep","--strict",source],None)?;
        run_command(Path::new("/usr/bin/ditto"),&["--noqtn",source,copy],None)?;
        let identity=match self.mode{SigningMode::LocalAdhoc=>"-".to_string(),SigningMode::DeveloperId=>self.source_authority.clone().ok_or(VerificationError::Identity)?};
        run_command(Path::new("/usr/bin/codesign"),&["--force","--deep","--sign",&identity,"--timestamp=none",copy],None)?;
        run_command(Path::new("/usr/bin/codesign"),&["--verify","--deep","--strict",copy],None)?;
        if !app_valid(Path::new(copy),self.mode){return Err(VerificationError::Identity)}
        self.actor.as_mut().ok_or(VerificationError::Broker)?.handoff_golden().map_err(|_|VerificationError::Broker)?;self.actor=None;
        let executable=Path::new(copy).join("Contents/MacOS/supertwinv13");
        let output=run_command(&executable,&[COPY_FLAG,match self.mode{SigningMode::LocalAdhoc=>"local-adhoc",SigningMode::DeveloperId=>"developer-id"}],Some(expected.as_bytes()))?;
        let evidence:CopyEvidence=serde_json::from_slice(&output).map_err(|_|VerificationError::Copy)?;
        if evidence.outcome.digest!=expected||Some(&evidence.acl)!=self.acl_before.as_ref(){return Err(VerificationError::Copy)}
        self.actor=Some(BrokerActor::resume_golden(&self.receipt).map_err(|_|VerificationError::Broker)?.0);
        Ok(CopyOperationOutcome{digest:evidence.outcome.digest,digest_reads:evidence.outcome.digest_reads,
            acl_snapshots:evidence.outcome.acl_snapshots,app_copies:1,temporary_resigns:1,
            broker_handoffs:evidence.outcome.broker_handoffs+1,broker_resumes:evidence.outcome.broker_resumes+1})
    }
    fn cleanup_and_prove_absent(&mut self)->Result<CleanupOutcome,VerificationError>{
        if self.actor.is_none() {
            self.actor=Some(BrokerActor::resume_golden(&self.receipt).map_err(|_|VerificationError::Cleanup)?.0);
        }
        let actor=self.actor.as_mut().ok_or(VerificationError::Cleanup)?;actor.local_golden_delete().map_err(|_|VerificationError::Cleanup)?;
        if actor.local_golden_exists().map_err(|_|VerificationError::Cleanup)?{return Err(VerificationError::Cleanup)} actor.shutdown().map_err(|_|VerificationError::Cleanup)?;self.actor=None;self.envelope.fill(0);Ok(CleanupOutcome{dummy_deletes:1,absence_proofs:1})
    }
    fn cancelled(&self)->bool{CANCEL_REQUESTED.load(Ordering::SeqCst)}
}

#[cfg(not(debug_assertions))]
fn run_copy_phase(mode:SigningMode)->Result<i32,VerificationError>{
    let recovery=recovery_root()?;let receipt=recovery.join("receipt.json");let mut input=String::new();std::io::stdin().take(65).read_to_string(&mut input).map_err(|_|VerificationError::Copy)?;
    let expected=input.trim();if !safe_digest(expected){return Err(VerificationError::Copy)}
    let executable=std::env::current_exe().map_err(|_|VerificationError::Identity)?;let app=executable.parent().and_then(Path::parent).and_then(Path::parent).ok_or(VerificationError::Identity)?;
    if !app_valid(app,mode){return Err(VerificationError::Identity)} let (mut actor,_)=BrokerActor::resume_golden(&receipt).map_err(|_|VerificationError::Broker)?;
    let digest=actor.local_golden_read_digest().map_err(|_|VerificationError::Broker)?;let a=actor.local_golden_acl_snapshot().map_err(|_|VerificationError::Acl)?;
    if digest!=expected{return Err(VerificationError::Broker)} actor.handoff_golden().map_err(|_|VerificationError::Broker)?;
    let evidence=CopyEvidence{outcome:CopyOperationOutcome{digest,digest_reads:1,acl_snapshots:1,
        app_copies:0,temporary_resigns:0,broker_handoffs:1,broker_resumes:1},
        acl:AclEvidence{allow_all_applications:a.allow_all_applications,trusted_application_count:a.trusted_application_count,authorization_count:a.authorization_count,fingerprint:a.fingerprint}};
    let bytes=serde_json::to_vec(&evidence).map_err(|_|VerificationError::Copy)?;std::io::stdout().write_all(&bytes).map_err(|_|VerificationError::Copy)?;Ok(0)
}

pub fn maybe_run(args:&[String])->Option<i32>{
    if args.first().map(String::as_str)==Some(COPY_FLAG){
        #[cfg(debug_assertions)]{return Some(2)}
        #[cfg(not(debug_assertions))]{let mode=match args{[_,m] if m=="local-adhoc"=>SigningMode::LocalAdhoc,[_,m] if m=="developer-id"=>SigningMode::DeveloperId,_=>return Some(2)};if install_cancellation().is_err(){return Some(2)}return Some(run_copy_phase(mode).unwrap_or(2));}
    }
    let parsed=match parse_launch(args,!TEAM_ID_FOR_PARSE.is_empty()){Ok(None)=>return None,Ok(Some(v))=>v,Err(e)=>{eprintln!("{e}");return Some(2)}};
    #[cfg(debug_assertions)]{let _=parsed;eprintln!("native Keychain verification requires a packaged app");Some(2)}
    #[cfg(not(debug_assertions))]{if install_cancellation().is_err(){return Some(2)}Some(match SystemOps::new(parsed.signing_mode).and_then(|mut ops|run_ceremony(parsed.signing_mode,&mut ops)){Ok(e)=>{println!("{}",serde_json::to_string(&e).unwrap_or_default());0},Err(_)=>{eprintln!("native Keychain verification failed; cleanup may require the next signed-app launch");2}})}
}

#[cfg(debug_assertions)] const TEAM_ID_FOR_PARSE:&str="";
#[cfg(not(debug_assertions))] const TEAM_ID_FOR_PARSE:&str=TEAM_ID;

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake { approve: bool, created: bool, cleaned: bool, cancelled:bool,
        cancel_after_create:bool, copy_error:Option<VerificationError>, drift_copy_steps:bool, source_reads:u8,
        acl_reads:u8, calls:Vec<&'static str> }
    impl NativeVerificationOps for Fake {
        fn approve(&mut self, d:&[u8])->Result<bool,VerificationError>{self.calls.push("approve"); assert!(!String::from_utf8_lossy(d).contains("token"));Ok(self.approve)}
        fn recover(&mut self)->Result<(),VerificationError>{self.calls.push("recover");Ok(())}
        fn source_identity(&mut self)->Result<String,VerificationError>{self.source_reads+=1;Ok("a".repeat(64))}
        fn create_dummy(&mut self)->Result<String,VerificationError>{self.created=true;if self.cancel_after_create{self.cancelled=true}Ok("b".repeat(64))}
        fn read_dummy_digest(&mut self)->Result<String,VerificationError>{Ok("b".repeat(64))}
        fn acl_evidence(&mut self)->Result<AclEvidence,VerificationError>{self.acl_reads+=1;Ok(AclEvidence{allow_all_applications:false,trusted_application_count:1,authorization_count:1,fingerprint:"c".repeat(64)})}
        fn approve_acl(&mut self,_:&AclEvidence)->Result<bool,VerificationError>{self.calls.push("final_approval");Ok(true)}
        fn copy_resign_verify_and_read(&mut self,_:&str)->Result<CopyOperationOutcome,VerificationError>{if let Some(error)=self.copy_error.take(){return Err(error)}Ok(CopyOperationOutcome{digest:"b".repeat(64),digest_reads:1,acl_snapshots:if self.drift_copy_steps{0}else{1},app_copies:1,temporary_resigns:1,broker_handoffs:2,broker_resumes:2})}
        fn cleanup_and_prove_absent(&mut self)->Result<CleanupOutcome,VerificationError>{self.calls.push("cleanup");self.cleaned=true;Ok(CleanupOutcome{dummy_deletes:1,absence_proofs:1})}
        fn cancelled(&self)->bool{self.cancelled}
    }
    #[test] fn launch_is_closed_and_adhoc_is_explicit(){assert_eq!(parse_launch(&[NATIVE_VERIFY_FLAG.into()],false),Err("native Keychain verification requires Developer ID signing or explicit local-only ad-hoc mode"));assert!(parse_launch(&[NATIVE_VERIFY_FLAG.into(),NATIVE_VERIFY_ADHOC_FLAG.into()],false).unwrap().is_some());assert!(parse_launch(&[NATIVE_VERIFY_FLAG.into(),"bad".into()],true).is_err());}
    #[test] fn approval_precedes_every_operation_and_evidence_is_zero_network(){let mut f=Fake{approve:true,..Default::default()};let e=run_ceremony(SigningMode::LocalAdhoc,&mut f).unwrap();assert_eq!(f.calls.first(),Some(&"approve"));assert!(f.created&&f.cleaned);assert!(e.local_only);assert_eq!(e.network_calls,0);assert_eq!(e.high_level_steps.acl_snapshots,3);assert_eq!(e.high_level_steps.dummy_digest_reads,2);assert!(f.calls.iter().position(|v|*v=="cleanup").unwrap()<f.calls.iter().position(|v|*v=="final_approval").unwrap());}
    #[test] fn refusal_is_zero_operation(){let mut f=Fake::default();assert_eq!(run_ceremony(SigningMode::DeveloperId,&mut f),Err(VerificationError::Refused));assert!(!f.created);}
    #[test] fn post_create_cancellation_settles_into_cleanup(){let mut f=Fake{approve:true,cancel_after_create:true,..Default::default()};assert_eq!(run_ceremony(SigningMode::DeveloperId,&mut f),Err(VerificationError::Cancelled));assert!(f.created&&f.cleaned);}
    #[test] fn subprocess_timeout_still_cleans(){let mut f=Fake{approve:true,copy_error:Some(VerificationError::Timeout),..Default::default()};assert_eq!(run_ceremony(SigningMode::DeveloperId,&mut f),Err(VerificationError::Timeout));assert!(f.created&&f.cleaned);}
    #[test] fn hostile_subprocess_environment_is_closed(){let actual=allowed_subprocess_environment([
        (OsString::from("HOME"),OsString::from("/safe")),
        (OsString::from("DYLD_INSERT_LIBRARIES"),OsString::from("/evil")),
        (OsString::from("NODE_OPTIONS"),OsString::from("--require=/evil")),
        (OsString::from("PATH"),OsString::from("/evil")),
        (OsString::from("TMPDIR"),OsString::from("/tmp")),
    ]);assert_eq!(actual,vec![(OsString::from("HOME"),OsString::from("/safe")),(OsString::from("TMPDIR"),OsString::from("/tmp"))]);}
    #[test] fn declaration_counts_child_acl_snapshot_and_exact_high_level_operations(){let value:serde_json::Value=serde_json::from_slice(&declaration(SigningMode::LocalAdhoc)).unwrap();assert_eq!(value["high_level_steps"]["acl_snapshots"],3);assert_eq!(value["high_level_steps"]["dummy_digest_reads"],2);assert_eq!(value["high_level_steps"]["recovery_checks"],1);assert!(value["counter_semantics"].as_str().unwrap().contains("not raw Security.framework"));}
    #[test] fn instrumented_step_drift_fails_after_cleanup_without_final_modal(){let mut f=Fake{approve:true,drift_copy_steps:true,..Default::default()};assert_eq!(run_ceremony(SigningMode::DeveloperId,&mut f),Err(VerificationError::Identity));assert!(f.cleaned);assert!(!f.calls.contains(&"final_approval"));}
    #[test] fn source_identity_revalidates_the_sealed_bundle_before_inspection(){let source=include_str!("native_keychain_verification.rs");let signature=source.split("fn signature").nth(1).unwrap().split("}\n}").next().unwrap();assert!(signature.contains("app_valid(path,self.mode)"));assert!(signature.contains("\"--verify\",\"--deep\",\"--strict\""));assert!(signature.contains("\"-dv\",\"--verbose=4\""));}
}

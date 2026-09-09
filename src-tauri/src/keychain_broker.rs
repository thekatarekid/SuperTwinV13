use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};

pub const REQUEST_PREFIX: &str = "SUPERTWIN_KEYCHAIN_REQUEST_V1 ";
pub const RESPONSE_PREFIX: &str = "SUPERTWIN_KEYCHAIN_RESPONSE_V1 ";
pub const HELLO_PREFIX: &str = "SUPERTWIN_KEYCHAIN_HELLO_V1 ";
const PROTOCOL: &str = "supertwin-keychain-broker-v1";
const MAX_FRAME_BYTES: usize = 768 * 1024;
const MAX_INPUT_BYTES: usize = 128 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_RECEIPT_BYTES: usize = 16 * 1024;
const SERVICE: &str = "SuperTwinV13 ChatGPT OAuth";

#[derive(Debug)]
pub enum BrokerError {
    InvalidFrame,
    Backend,
    RecoveryRequired,
}

impl std::fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidFrame => "invalid credential broker frame",
            Self::Backend => "credential broker backend failed",
            Self::RecoveryRequired => "credential broker cleanup is required",
        })
    }
}

impl std::error::Error for BrokerError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireEnvelope {
    protocol: String,
    id: u64,
    body: String,
    mac: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrokerRequest {
    operation: BrokerOperation,
    #[serde(default)]
    input: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BrokerOperation {
    Exists,
    Read,
    Upsert,
    Delete,
    Binding,
}

impl BrokerOperation {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Exists => "exists",
            Self::Read => "read",
            Self::Upsert => "upsert",
            Self::Delete => "delete",
            Self::Binding => "binding",
        }
    }
}

#[derive(Debug, Serialize)]
struct BrokerResponse<'a> {
    code: i32,
    stdout: &'a str,
}

#[derive(Debug, Serialize)]
struct WireResponse {
    protocol: &'static str,
    id: u64,
    body: String,
    mac: String,
}

pub trait CredentialBackend: Send + Sync + 'static {
    fn execute(
        &self,
        operation: &str,
        account: &str,
        label: Option<&str>,
        persistent_ref: Option<&str>,
        input: Option<&[u8]>,
    ) -> Result<(i32, Vec<u8>), ()>;
}

#[derive(Debug, Clone)]
pub struct GoldenBrokerOptions {
    pub expected_account_fingerprint: String,
    pub receipt_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GoldenReceipt {
    schema: u8,
    account: String,
    label: String,
    expected_account_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    persistent_ref: Option<String>,
}

#[derive(Debug)]
struct GoldenScope {
    receipt: GoldenReceipt,
    receipt_path: PathBuf,
}

#[derive(Debug)]
enum BrokerScope {
    Normal,
    Golden(GoldenScope),
}

#[derive(Default)]
pub struct NativeCredentialBackend;

#[cfg(target_os = "macos")]
extern "C" {
    fn supertwin_keychain_execute(
        operation: *const std::os::raw::c_char,
        account: *const std::os::raw::c_char,
        label: *const std::os::raw::c_char,
        persistent_ref: *const std::os::raw::c_char,
        input: *const u8,
        input_len: usize,
        output: *mut *mut u8,
        output_len: *mut usize,
    ) -> i32;
    fn supertwin_keychain_free(pointer: *mut std::ffi::c_void);
}

impl CredentialBackend for NativeCredentialBackend {
    fn execute(
        &self,
        operation: &str,
        account: &str,
        label: Option<&str>,
        persistent_ref: Option<&str>,
        input: Option<&[u8]>,
    ) -> Result<(i32, Vec<u8>), ()> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (operation, account, label, persistent_ref, input);
            return Err(());
        }
        #[cfg(target_os = "macos")]
        {
            let operation = CString::new(operation).map_err(|_| ())?;
            let account = CString::new(account).map_err(|_| ())?;
            let label = label.map(CString::new).transpose().map_err(|_| ())?;
            let persistent_ref = persistent_ref.map(CString::new).transpose().map_err(|_| ())?;
            let bytes = input.unwrap_or_default();
            let mut output = std::ptr::null_mut();
            let mut output_len = 0usize;
            // SAFETY: all pointers remain live for the call. The Objective-C bridge
            // allocates output with calloc and transfers ownership to us.
            let code = unsafe {
                supertwin_keychain_execute(
                    operation.as_ptr(), account.as_ptr(),
                    label.as_ref().map_or(std::ptr::null(), |value| value.as_ptr()),
                    persistent_ref.as_ref().map_or(std::ptr::null(), |value| value.as_ptr()),
                    bytes.as_ptr(), bytes.len(), &mut output, &mut output_len,
                )
            };
            if output_len > MAX_OUTPUT_BYTES || (output_len > 0 && output.is_null()) {
                if !output.is_null() { unsafe { supertwin_keychain_free(output.cast()) }; }
                return Err(());
            }
            let copied = if output_len == 0 { Vec::new() } else {
                // SAFETY: bridge returned output_len initialized bytes.
                unsafe { std::slice::from_raw_parts(output, output_len).to_vec() }
            };
            if !output.is_null() { unsafe { supertwin_keychain_free(output.cast()) }; }
            Ok((code, copied))
        }
    }
}

pub struct BrokerSession<B: CredentialBackend> {
    secret: [u8; 32],
    session: String,
    account: String,
    next_id: u64,
    backend: B,
    scope: BrokerScope,
    _account_lease: Option<File>,
}

impl<B: CredentialBackend> Drop for BrokerSession<B> {
    fn drop(&mut self) {
        let _ = self.cleanup_golden();
        self.secret.fill(0);
        self.session.clear();
    }
}

fn fixed_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() { return false; }
    left.iter().zip(right).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

fn message_mac(secret: &[u8; 32], direction: &[u8], id: u64, body: &[u8]) -> String {
    let mut inner_key = [0x36u8; 64];
    let mut outer_key = [0x5cu8; 64];
    for index in 0..secret.len() {
        inner_key[index] ^= secret[index];
        outer_key[index] ^= secret[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_key);
    inner.update(b"supertwin-keychain-broker-v1\0");
    inner.update(direction);
    inner.update([0]);
    inner.update(id.to_be_bytes());
    inner.update(body);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_key);
    outer.update(inner_digest);
    inner_key.fill(0); outer_key.fill(0);
    hex::encode(outer.finalize())
}

pub fn account_for_home(home: &Path) -> Result<String, BrokerError> {
    if !home.is_absolute() { return Err(BrokerError::InvalidFrame); }
    let mut normalized = std::path::PathBuf::from("/");
    for component in home.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            std::path::Component::ParentDir => { normalized.pop(); }
            std::path::Component::Normal(value) => normalized.push(value),
            std::path::Component::Prefix(_) => return Err(BrokerError::InvalidFrame),
        }
    }
    let text = normalized.to_str().ok_or(BrokerError::InvalidFrame)?;
    if text.is_empty() || text.len() > 16 * 1024 { return Err(BrokerError::InvalidFrame); }
    let digest = Sha256::digest(text.as_bytes());
    Ok(format!("supertwin.chatgpt-oauth.{}", hex::encode(digest)[..16].to_string()))
}

fn acquire_account_lease(account: &str) -> Result<File, BrokerError> {
    let suffix = account.strip_prefix("supertwin.chatgpt-oauth.").ok_or(BrokerError::InvalidFrame)?;
    let path = format!("/tmp/com.supertwinv13.keychain.{}.{}.lock", unsafe { libc::geteuid() }, suffix);
    let file = OpenOptions::new().read(true).write(true).create(true).mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(path).map_err(|_| BrokerError::Backend)?;
    let metadata = file.metadata().map_err(|_| BrokerError::Backend)?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(BrokerError::Backend);
    }
    // Hold one account lease for the complete app/worker lifetime. A second app
    // instance cannot interleave refresh read/write/reconciliation sequences.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(BrokerError::Backend);
    }
    Ok(file)
}

fn safe_account(value: &str) -> bool {
    value.strip_prefix("supertwin.chatgpt-oauth.").is_some_and(|suffix|
        suffix.len() == 16 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn safe_fingerprint(value: &str) -> bool {
    value.len() == 12 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn safe_label(value: &str) -> bool {
    value.strip_prefix("SuperTwinV13 golden ").is_some_and(|suffix|
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn safe_persistent_ref(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && value.bytes().all(|byte|
        byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn receipt_parent(path: &Path) -> Result<&Path, BrokerError> {
    if !path.is_absolute() || path.file_name().is_none() { return Err(BrokerError::InvalidFrame); }
    let parent = path.parent().ok_or(BrokerError::InvalidFrame)?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| BrokerError::Backend)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() ||
        metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(BrokerError::Backend);
    }
    Ok(parent)
}

fn validate_receipt(receipt: &GoldenReceipt) -> Result<(), BrokerError> {
    if receipt.schema != 1 || !safe_account(&receipt.account) || !safe_label(&receipt.label) ||
        !safe_fingerprint(&receipt.expected_account_fingerprint) ||
        receipt.persistent_ref.as_deref().is_some_and(|value| !safe_persistent_ref(value)) {
        return Err(BrokerError::InvalidFrame);
    }
    Ok(())
}

fn read_receipt(path: &Path) -> Result<Option<GoldenReceipt>, BrokerError> {
    receipt_parent(path)?;
    let mut file = match OpenOptions::new().read(true).custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(BrokerError::Backend),
    };
    let metadata = file.metadata().map_err(|_| BrokerError::Backend)?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 ||
        metadata.len() as usize > MAX_RECEIPT_BYTES {
        return Err(BrokerError::Backend);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(|_| BrokerError::Backend)?;
    if bytes.is_empty() || bytes.len() > MAX_RECEIPT_BYTES { return Err(BrokerError::InvalidFrame); }
    let receipt: GoldenReceipt = serde_json::from_slice(&bytes).map_err(|_| BrokerError::InvalidFrame)?;
    validate_receipt(&receipt)?;
    Ok(Some(receipt))
}

fn write_receipt(path: &Path, receipt: &GoldenReceipt) -> Result<(), BrokerError> {
    validate_receipt(receipt)?;
    let parent = receipt_parent(path)?;
    let bytes = serde_json::to_vec(receipt).map_err(|_| BrokerError::Backend)?;
    if bytes.len() > MAX_RECEIPT_BYTES { return Err(BrokerError::Backend); }
    let name = path.file_name().and_then(|value| value.to_str()).ok_or(BrokerError::InvalidFrame)?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| BrokerError::Backend)?;
    let temporary = parent.join(format!(".{name}.{}.tmp", hex::encode(nonce)));
    let write_result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(&temporary).map_err(|_| BrokerError::Backend)?;
        file.write_all(&bytes).map_err(|_| BrokerError::Backend)?;
        file.sync_all().map_err(|_| BrokerError::Backend)?;
        let metadata = file.metadata().map_err(|_| BrokerError::Backend)?;
        if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(BrokerError::Backend);
        }
        if path.exists() {
            let current = fs::symlink_metadata(path).map_err(|_| BrokerError::Backend)?;
            if !current.is_file() || current.file_type().is_symlink() ||
                current.uid() != unsafe { libc::geteuid() } || current.mode() & 0o077 != 0 {
                return Err(BrokerError::Backend);
            }
        }
        fs::rename(&temporary, path).map_err(|_| BrokerError::Backend)?;
        File::open(parent).and_then(|directory| directory.sync_all()).map_err(|_| BrokerError::Backend)
    })();
    if write_result.is_err() { let _ = fs::remove_file(&temporary); }
    write_result
}

fn remove_receipt(path: &Path) -> Result<(), BrokerError> {
    receipt_parent(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() &&
            metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0 => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        _ => return Err(BrokerError::Backend),
    }
    fs::remove_file(path).map_err(|_| BrokerError::Backend)?;
    File::open(path.parent().ok_or(BrokerError::InvalidFrame)?)
        .and_then(|directory| directory.sync_all()).map_err(|_| BrokerError::Backend)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DurablePair {
    access_token: String,
    refresh_token: String,
    expires_at_ms: u64,
    account_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DurableEnvelope {
    version: u8,
    current: DurablePair,
    #[serde(default)]
    previous: Option<DurablePair>,
}

fn validate_pair(pair: &DurablePair, expected_fingerprint: &str) -> Result<(), BrokerError> {
    if pair.access_token.is_empty() || pair.access_token.len() > 64 * 1024 ||
        pair.refresh_token.is_empty() || pair.refresh_token.len() > 64 * 1024 || pair.expires_at_ms == 0 ||
        pair.account_id.is_empty() || pair.account_id.len() > 4 * 1024 || pair.account_id.chars().any(char::is_control) ||
        hex::encode(Sha256::digest(pair.account_id.as_bytes()))[..12] != *expected_fingerprint {
        return Err(BrokerError::InvalidFrame);
    }
    Ok(())
}

fn account_id_from_envelope(bytes: &[u8], expected_fingerprint: &str) -> Result<String, BrokerError> {
    let envelope: DurableEnvelope = serde_json::from_slice(bytes).map_err(|_| BrokerError::InvalidFrame)?;
    if envelope.version != 1 { return Err(BrokerError::InvalidFrame); }
    validate_pair(&envelope.current, expected_fingerprint)?;
    if let Some(previous) = envelope.previous.as_ref() { validate_pair(previous, expected_fingerprint)?; }
    Ok(envelope.current.account_id)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnedBinding {
    service: String,
    account: String,
    label: String,
    persistent_ref: String,
    value_base64: String,
}

struct ValidatedBinding {
    persistent_ref: String,
    value: Vec<u8>,
    account_id: String,
}

fn parse_binding(bytes: &[u8], receipt: &GoldenReceipt) -> Result<ValidatedBinding, BrokerError> {
    let binding: OwnedBinding = serde_json::from_slice(bytes).map_err(|_| BrokerError::Backend)?;
    if binding.service != SERVICE || binding.account != receipt.account || binding.label != receipt.label ||
        !safe_persistent_ref(&binding.persistent_ref) {
        return Err(BrokerError::RecoveryRequired);
    }
    let value = STANDARD.decode(&binding.value_base64).map_err(|_| BrokerError::Backend)?;
    if STANDARD.encode(&value) != binding.value_base64 || value.is_empty() || value.len() > MAX_INPUT_BYTES {
        return Err(BrokerError::Backend);
    }
    let account_id = account_id_from_envelope(&value, &receipt.expected_account_fingerprint)
        .map_err(|_| BrokerError::RecoveryRequired)?;
    Ok(ValidatedBinding { persistent_ref: binding.persistent_ref, value, account_id })
}

fn load_golden_binding<B: CredentialBackend>(backend: &B, receipt: &GoldenReceipt)
    -> Result<Option<ValidatedBinding>, BrokerError> {
    let operation = if receipt.persistent_ref.is_some() { "read-ref" } else { "lookup-owned" };
    let (code, output) = backend.execute(operation, &receipt.account, Some(&receipt.label),
        receipt.persistent_ref.as_deref(), None).map_err(|_| BrokerError::RecoveryRequired)?;
    if code == 44 { return Ok(None); }
    if code != 0 { return Err(BrokerError::RecoveryRequired); }
    let binding = parse_binding(&output, receipt)?;
    if receipt.persistent_ref.as_deref().is_some_and(|value| value != binding.persistent_ref) {
        return Err(BrokerError::RecoveryRequired);
    }
    Ok(Some(binding))
}

fn cleanup_golden_scope<B: CredentialBackend>(backend: &B, scope: &mut GoldenScope) -> Result<(), BrokerError> {
    let Some(binding) = load_golden_binding(backend, &scope.receipt)? else {
        remove_receipt(&scope.receipt_path)?;
        scope.receipt.persistent_ref = None;
        return Ok(());
    };
    if scope.receipt.persistent_ref.is_none() {
        scope.receipt.persistent_ref = Some(binding.persistent_ref.clone());
        write_receipt(&scope.receipt_path, &scope.receipt)?;
    }
    let (code, output) = backend.execute("delete-owned-ref", &scope.receipt.account,
        Some(&scope.receipt.label), Some(&binding.persistent_ref), Some(binding.account_id.as_bytes()))
        .map_err(|_| BrokerError::RecoveryRequired)?;
    if !output.is_empty() || (code != 0 && code != 44) { return Err(BrokerError::RecoveryRequired); }
    if load_golden_binding(backend, &scope.receipt)?.is_some() { return Err(BrokerError::RecoveryRequired); }
    remove_receipt(&scope.receipt_path)?;
    scope.receipt.persistent_ref = None;
    Ok(())
}

fn recover_golden_with<B: CredentialBackend>(receipt_path: &Path, backend: &B) -> Result<(), BrokerError> {
    receipt_parent(receipt_path)?;
    let Some(receipt) = read_receipt(receipt_path)? else { return Ok(()); };
    if !safe_account(&receipt.account) || !safe_fingerprint(&receipt.expected_account_fingerprint) {
        return Err(BrokerError::RecoveryRequired);
    }
    let mut scope = GoldenScope { receipt, receipt_path: receipt_path.to_path_buf() };
    cleanup_golden_scope(backend, &mut scope)
}

impl<B: CredentialBackend> BrokerSession<B> {
    pub fn new(account: String, backend: B) -> Result<Self, BrokerError> {
        if !safe_account(&account) { return Err(BrokerError::InvalidFrame); }
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| BrokerError::Backend)?;
        let lease = acquire_account_lease(&account)?;
        Ok(Self { session: hex::encode(secret), secret, account, next_id: 1, backend, scope: BrokerScope::Normal,
            _account_lease: Some(lease) })
    }

    pub fn new_golden(account: String, backend: B, options: GoldenBrokerOptions) -> Result<Self, BrokerError> {
        if !safe_account(&account) || !safe_fingerprint(&options.expected_account_fingerprint) {
            return Err(BrokerError::InvalidFrame);
        }
        receipt_parent(&options.receipt_path)?;
        let lease = acquire_account_lease(&account)?;
        if let Some(receipt) = read_receipt(&options.receipt_path)? {
            if receipt.account != account { return Err(BrokerError::RecoveryRequired); }
            let mut stale = GoldenScope { receipt, receipt_path: options.receipt_path.clone() };
            cleanup_golden_scope(&backend, &mut stale)?;
        }
        let mut ownership = [0u8; 16];
        getrandom::fill(&mut ownership).map_err(|_| BrokerError::Backend)?;
        let scope = GoldenScope {
            receipt: GoldenReceipt { schema: 1, account: account.clone(),
                label: format!("SuperTwinV13 golden {}", hex::encode(ownership)),
                expected_account_fingerprint: options.expected_account_fingerprint, persistent_ref: None },
            receipt_path: options.receipt_path,
        };
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| BrokerError::Backend)?;
        Ok(Self { session: hex::encode(secret), secret, account, next_id: 1, backend,
            scope: BrokerScope::Golden(scope), _account_lease: Some(lease) })
    }

    #[cfg(test)]
    fn with_secret(account: String, backend: B, secret: [u8; 32]) -> Self {
        Self { session: hex::encode(secret), secret, account, next_id: 1, backend,
            scope: BrokerScope::Normal, _account_lease: None }
    }

    #[cfg(test)]
    fn with_secret_golden(account: String, backend: B, secret: [u8; 32], options: GoldenBrokerOptions)
        -> Result<Self, BrokerError> {
        if !safe_account(&account) || !safe_fingerprint(&options.expected_account_fingerprint) {
            return Err(BrokerError::InvalidFrame);
        }
        if let Some(receipt) = read_receipt(&options.receipt_path)? {
            if receipt.account != account { return Err(BrokerError::RecoveryRequired); }
            let mut stale = GoldenScope { receipt, receipt_path: options.receipt_path.clone() };
            cleanup_golden_scope(&backend, &mut stale)?;
        }
        let label = "SuperTwinV13 golden 11111111111111111111111111111111".to_string();
        Ok(Self { session: hex::encode(secret), secret, account: account.clone(), next_id: 1, backend,
            scope: BrokerScope::Golden(GoldenScope { receipt: GoldenReceipt { schema: 1, account, label,
                expected_account_fingerprint: options.expected_account_fingerprint, persistent_ref: None },
                receipt_path: options.receipt_path }), _account_lease: None })
    }

    pub fn hello(&self) -> String {
        format!("{HELLO_PREFIX}{}\n", self.session)
    }

    pub fn cleanup_golden(&mut self) -> Result<(), BrokerError> {
        let BrokerScope::Golden(scope) = &mut self.scope else { return Ok(()); };
        cleanup_golden_scope(&self.backend, scope)
    }

    fn execute_golden(&mut self, operation: &BrokerOperation, input: Option<&[u8]>)
        -> Result<(i32, Vec<u8>), BrokerError> {
        let BrokerScope::Golden(scope) = &mut self.scope else { return Err(BrokerError::InvalidFrame); };
        match operation {
            BrokerOperation::Exists => {
                let exists = load_golden_binding(&self.backend, &scope.receipt)?.is_some();
                Ok((if exists { 0 } else { 44 }, Vec::new()))
            }
            BrokerOperation::Read => {
                let binding = load_golden_binding(&self.backend, &scope.receipt)?
                    .ok_or(BrokerError::RecoveryRequired)?;
                Ok((0, binding.value))
            }
            BrokerOperation::Upsert => {
                let value = input.ok_or(BrokerError::InvalidFrame)?;
                account_id_from_envelope(value, &scope.receipt.expected_account_fingerprint)?;
                if let Some(persistent_ref) = scope.receipt.persistent_ref.clone() {
                    let (code, output) = self.backend.execute("update-owned-ref", &scope.receipt.account,
                        Some(&scope.receipt.label), Some(&persistent_ref), Some(value))
                        .map_err(|_| BrokerError::RecoveryRequired)?;
                    if code != 0 || !output.is_empty() { return Err(BrokerError::RecoveryRequired); }
                    let binding = load_golden_binding(&self.backend, &scope.receipt)?
                        .ok_or(BrokerError::RecoveryRequired)?;
                    if binding.value != value { return Err(BrokerError::RecoveryRequired); }
                } else {
                    // The armed receipt closes the SecItemAdd-success/process-crash
                    // window: recovery can locate the unique Rust-generated label
                    // even before the persistent reference has been journalled.
                    write_receipt(&scope.receipt_path, &scope.receipt)?;
                    let (code, output) = self.backend.execute("create", &scope.receipt.account,
                        Some(&scope.receipt.label), None, Some(value))
                        .map_err(|_| BrokerError::RecoveryRequired)?;
                    if code != 0 { return Err(BrokerError::RecoveryRequired); }
                    let persistent_ref = String::from_utf8(output).map_err(|_| BrokerError::RecoveryRequired)?;
                    if !safe_persistent_ref(&persistent_ref) { return Err(BrokerError::RecoveryRequired); }
                    scope.receipt.persistent_ref = Some(persistent_ref);
                    write_receipt(&scope.receipt_path, &scope.receipt)?;
                    let binding = load_golden_binding(&self.backend, &scope.receipt)?
                        .ok_or(BrokerError::RecoveryRequired)?;
                    if binding.value != value { return Err(BrokerError::RecoveryRequired); }
                }
                let digest = scope.receipt.persistent_ref.as_ref()
                    .map(|value| hex::encode(Sha256::digest(value.as_bytes())))
                    .ok_or(BrokerError::RecoveryRequired)?;
                Ok((0, digest.into_bytes()))
            }
            BrokerOperation::Delete => {
                cleanup_golden_scope(&self.backend, scope)?;
                Ok((0, Vec::new()))
            }
            BrokerOperation::Binding => Ok(match scope.receipt.persistent_ref.as_ref() {
                Some(value) => (0, hex::encode(Sha256::digest(value.as_bytes())).into_bytes()),
                None => (44, Vec::new()),
            }),
        }
    }

    pub fn handle_line(&mut self, line: &str) -> Result<String, BrokerError> {
        let encoded = line.strip_prefix(REQUEST_PREFIX).ok_or(BrokerError::InvalidFrame)?;
        if encoded.is_empty() || encoded.len() > MAX_FRAME_BYTES || !encoded.bytes().all(|byte|
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
            return Err(BrokerError::InvalidFrame);
        }
        let wire_bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| BrokerError::InvalidFrame)?;
        if URL_SAFE_NO_PAD.encode(&wire_bytes) != encoded { return Err(BrokerError::InvalidFrame); }
        if wire_bytes.len() > MAX_FRAME_BYTES { return Err(BrokerError::InvalidFrame); }
        let wire: WireEnvelope = serde_json::from_slice(&wire_bytes).map_err(|_| BrokerError::InvalidFrame)?;
        if wire.protocol != PROTOCOL || wire.id != self.next_id ||
            wire.mac.len() != 64 || !wire.mac.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(BrokerError::InvalidFrame);
        }
        let body = URL_SAFE_NO_PAD.decode(&wire.body).map_err(|_| BrokerError::InvalidFrame)?;
        let expected_mac = message_mac(&self.secret, b"request", wire.id, &body);
        if !fixed_equal(wire.mac.as_bytes(), expected_mac.as_bytes()) { return Err(BrokerError::InvalidFrame); }
        let request: BrokerRequest = serde_json::from_slice(&body).map_err(|_| BrokerError::InvalidFrame)?;
        let input = match request.operation {
            BrokerOperation::Upsert => {
                let value = request.input.as_deref().ok_or(BrokerError::InvalidFrame)?;
                if value.is_empty() || value.len() > MAX_INPUT_BYTES { return Err(BrokerError::InvalidFrame); }
                Some(value.as_bytes())
            }
            _ if request.input.is_some() => return Err(BrokerError::InvalidFrame),
            _ => None,
        };
        // Consume the sequence before touching the backend: a lost response can
        // never replay a mutation.
        self.next_id = self.next_id.checked_add(1).ok_or(BrokerError::InvalidFrame)?;
        let (code, output) = match &self.scope {
            BrokerScope::Normal if matches!(request.operation, BrokerOperation::Binding) => {
                return Err(BrokerError::InvalidFrame);
            }
            BrokerScope::Normal => self.backend.execute(request.operation.as_str(), &self.account, None, None, input)
                .map_err(|_| BrokerError::Backend)?,
            BrokerScope::Golden(_) => self.execute_golden(&request.operation, input)?,
        };
        if ![0, 1, 44, 45, 64, 65, 66].contains(&code) || output.len() > MAX_OUTPUT_BYTES ||
            (code != 0 && !output.is_empty()) { return Err(BrokerError::Backend); }
        let stdout = String::from_utf8(output).map_err(|_| BrokerError::Backend)?;
        let response_body = serde_json::to_vec(&BrokerResponse { code, stdout: &stdout })
            .map_err(|_| BrokerError::Backend)?;
        let response = WireResponse { protocol: PROTOCOL, id: wire.id,
            body: URL_SAFE_NO_PAD.encode(&response_body),
            mac: message_mac(&self.secret, b"response", wire.id, &response_body) };
        let frame = serde_json::to_vec(&response).map_err(|_| BrokerError::Backend)?;
        Ok(format!("{RESPONSE_PREFIX}{}\n", URL_SAFE_NO_PAD.encode(frame)))
    }
}

enum ActorMessage {
    Request(String, SyncSender<Result<String, BrokerError>>),
    Shutdown,
}

pub struct BrokerActor {
    sender: SyncSender<ActorMessage>,
    thread: Option<JoinHandle<Result<(), BrokerError>>>,
}

impl BrokerActor {
    pub fn start(account: String) -> Result<(Self, String), BrokerError> {
        let session = BrokerSession::new(account, NativeCredentialBackend)?;
        Self::start_session(session)
    }

    pub fn start_golden(account: String, options: GoldenBrokerOptions) -> Result<(Self, String), BrokerError> {
        let session = BrokerSession::new_golden(account, NativeCredentialBackend, options)?;
        Self::start_session(session)
    }

    /// Recover a prior crash receipt before a new random eval-home/account is
    /// selected. The receipt contains no tokens; its exact recorded account,
    /// label and persistent ref are revalidated by Security.framework before
    /// deletion and absence proof.
    pub fn recover_golden(receipt_path: &Path) -> Result<(), BrokerError> {
        receipt_parent(receipt_path)?;
        let Some(receipt) = read_receipt(receipt_path)? else { return Ok(()); };
        if !safe_account(&receipt.account) || !safe_fingerprint(&receipt.expected_account_fingerprint) {
            return Err(BrokerError::RecoveryRequired);
        }
        let _lease = acquire_account_lease(&receipt.account)?;
        recover_golden_with(receipt_path, &NativeCredentialBackend)
    }

    fn start_session<B: CredentialBackend>(session: BrokerSession<B>) -> Result<(Self, String), BrokerError> {
        let hello = session.hello();
        let (sender, receiver) = mpsc::sync_channel::<ActorMessage>(8);
        let thread = thread::Builder::new().name("supertwin-keychain-broker".into()).spawn(move || {
            let mut session = session;
            let mut terminal = Ok(());
            while let Ok(message) = receiver.recv() {
                match message {
                    ActorMessage::Request(line, response) => {
                        let _ = response.send(session.handle_line(&line));
                    }
                    ActorMessage::Shutdown => {
                        terminal = session.cleanup_golden();
                        break;
                    }
                }
            }
            terminal
        }).map_err(|_| BrokerError::Backend)?;
        Ok((Self { sender, thread: Some(thread) }, hello))
    }

    pub fn request(&self, line: String) -> Result<Receiver<Result<String, BrokerError>>, BrokerError> {
        let (response, receiver) = mpsc::sync_channel(1);
        self.sender.try_send(ActorMessage::Request(line, response)).map_err(|_| BrokerError::Backend)?;
        Ok(receiver)
    }

    pub fn shutdown(&mut self) -> Result<(), BrokerError> {
        // Security.framework queries explicitly disable authentication UI, so
        // they are expected to settle without waiting for an owner prompt. Do
        // not pretend a mutation was cancelled: join the serialized actor and
        // keep the app alive until the current operation has actually settled.
        let _ = self.sender.send(ActorMessage::Shutdown);
        if let Some(thread) = self.thread.take() { return thread.join().map_err(|_| BrokerError::Backend)?; }
        Ok(())
    }
}

impl Drop for BrokerActor {
    fn drop(&mut self) { let _ = self.shutdown(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    #[derive(Clone, Default)]
    struct FakeBackend(Arc<Mutex<Vec<(String, String, Option<Vec<u8>>)>>>);
    impl CredentialBackend for FakeBackend {
        fn execute(&self, operation: &str, account: &str, _: Option<&str>, _: Option<&str>,
            input: Option<&[u8]>) -> Result<(i32, Vec<u8>), ()> {
            self.0.lock().unwrap().push((operation.into(), account.into(), input.map(<[u8]>::to_vec)));
            Ok((if operation == "read" { 0 } else { 44 }, if operation == "read" { b"secret".to_vec() } else { vec![] }))
        }
    }

    fn request(secret: &[u8; 32], id: u64, body: &[u8]) -> String {
        let wire = serde_json::json!({ "protocol": PROTOCOL, "id": id,
            "body": URL_SAFE_NO_PAD.encode(body), "mac": message_mac(secret, b"request", id, body) });
        format!("{REQUEST_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&wire).unwrap()))
    }

    fn response_body(frame: &str) -> serde_json::Value {
        let encoded = frame.trim_end().strip_prefix(RESPONSE_PREFIX).unwrap();
        let wire: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        let body = URL_SAFE_NO_PAD.decode(wire["body"].as_str().unwrap()).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn durable(account_id: &str, token: &str) -> String {
        serde_json::json!({ "version": 1, "current": { "accessToken": token,
            "refreshToken": format!("refresh-{token}"), "expiresAtMs": 1_900_000_000_000u64,
            "accountId": account_id } }).to_string()
    }

    fn test_receipt(name: &str) -> PathBuf {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let root = std::env::temp_dir().join(format!("supertwin-golden-broker-{name}-{}-{}",
            std::process::id(), hex::encode(nonce)));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        root.join("receipt.json")
    }

    #[derive(Clone)]
    struct GoldenFakeBackend(Arc<Mutex<GoldenFakeState>>);

    #[derive(Clone)]
    struct GoldenFakeItem { account: String, label: String, persistent_ref: String, value: Vec<u8> }

    #[derive(Default)]
    struct GoldenFakeState { item: Option<GoldenFakeItem>, operations: Vec<String>, fail_after_create: bool }

    impl GoldenFakeBackend {
        fn new() -> Self { Self(Arc::new(Mutex::new(GoldenFakeState::default()))) }
        fn fail_after_create(&self) { self.0.lock().unwrap().fail_after_create = true; }
    }

    impl CredentialBackend for GoldenFakeBackend {
        fn execute(&self, operation: &str, account: &str, label: Option<&str>, persistent_ref: Option<&str>,
            input: Option<&[u8]>) -> Result<(i32, Vec<u8>), ()> {
            let mut state = self.0.lock().unwrap();
            state.operations.push(operation.into());
            match operation {
                "create" => {
                    if state.item.is_some() { return Ok((45, Vec::new())); }
                    let item = GoldenFakeItem { account: account.into(), label: label.ok_or(())?.into(),
                        persistent_ref: "cGVyc2lzdGVudC1yZWY".into(), value: input.ok_or(())?.to_vec() };
                    state.item = Some(item.clone());
                    if state.fail_after_create { state.fail_after_create = false; return Err(()); }
                    Ok((0, item.persistent_ref.into_bytes()))
                }
                "lookup-owned" | "read-ref" => {
                    let Some(item) = state.item.as_ref() else { return Ok((44, Vec::new())); };
                    if item.account != account || Some(item.label.as_str()) != label ||
                        persistent_ref.is_some_and(|value| value != item.persistent_ref) {
                        return Ok((44, Vec::new()));
                    }
                    let frame = serde_json::json!({ "service": SERVICE, "account": item.account,
                        "label": item.label, "persistent_ref": item.persistent_ref,
                        "value_base64": STANDARD.encode(&item.value) });
                    Ok((0, serde_json::to_vec(&frame).unwrap()))
                }
                "update-owned-ref" => {
                    let Some(item) = state.item.as_mut() else { return Ok((44, Vec::new())); };
                    if item.account != account || Some(item.label.as_str()) != label ||
                        Some(item.persistent_ref.as_str()) != persistent_ref { return Ok((44, Vec::new())); }
                    item.value = input.ok_or(())?.to_vec();
                    Ok((0, Vec::new()))
                }
                "delete-owned-ref" => {
                    let Some(item) = state.item.as_ref() else { return Ok((44, Vec::new())); };
                    if item.account != account || Some(item.label.as_str()) != label ||
                        Some(item.persistent_ref.as_str()) != persistent_ref { return Ok((44, Vec::new())); }
                    let envelope: serde_json::Value = serde_json::from_slice(&item.value).map_err(|_| ())?;
                    if envelope["current"]["accountId"].as_str().map(str::as_bytes) != input { return Ok((66, Vec::new())); }
                    state.item = None;
                    Ok((0, Vec::new()))
                }
                _ => Err(()),
            }
        }
    }

    #[test]
    fn authenticates_sequences_and_never_exposes_backend_output_in_logs() {
        let secret = [7u8; 32];
        let backend = FakeBackend::default();
        let mut broker = BrokerSession::with_secret("supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret);
        let line = request(&secret, 1, br#"{"operation":"read"}"#);
        let response = broker.handle_line(&line).unwrap();
        assert!(response.starts_with(RESPONSE_PREFIX));
        assert!(!response.contains("secret"));
        assert_eq!(backend.0.lock().unwrap().len(), 1);
        assert!(broker.handle_line(&line).is_err());
        assert_eq!(backend.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn rejects_bad_mac_unknown_fields_inputs_and_oversize_before_backend() {
        let secret = [8u8; 32];
        let backend = FakeBackend::default();
        for body in [br#"{"operation":"read","input":"x"}"#.as_slice(),
            br#"{"operation":"other"}"#.as_slice(), br#"{"operation":"read","extra":1}"#.as_slice()] {
            let mut broker = BrokerSession::with_secret("supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret);
            assert!(broker.handle_line(&request(&secret, 1, body)).is_err());
        }
        let mut broker = BrokerSession::with_secret("supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret);
        let mut bad = request(&secret, 1, br#"{"operation":"read"}"#);
        bad.pop(); bad.push('A');
        assert!(broker.handle_line(&bad).is_err());
        assert!(backend.0.lock().unwrap().is_empty());
    }

    #[test]
    fn derives_the_same_closed_account_namespace_from_an_absolute_home() {
        assert_eq!(account_for_home(Path::new("/tmp/example")).unwrap(),
            "supertwin.chatgpt-oauth.f33aa9244af53b88");
        assert_eq!(account_for_home(Path::new("/tmp/./a/../example")).unwrap(),
            "supertwin.chatgpt-oauth.f33aa9244af53b88");
        assert!(account_for_home(Path::new("relative")).is_err());
    }

    #[test]
    fn golden_scope_owns_create_binding_rotation_read_and_exact_cleanup() {
        let secret = [10u8; 32];
        let account = "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".to_string();
        let account_id = "golden-account";
        let fingerprint = hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        let receipt = test_receipt("lifecycle");
        let backend = GoldenFakeBackend::new();
        let mut broker = BrokerSession::with_secret_golden(account, backend.clone(), secret,
            GoldenBrokerOptions { expected_account_fingerprint: fingerprint, receipt_path: receipt.clone() }).unwrap();
        let first = durable(account_id, "access-secret-one");
        let created = response_body(&broker.handle_line(&request(&secret, 1,
            serde_json::json!({ "operation": "upsert", "input": first }).to_string().as_bytes())).unwrap());
        let digest = created["stdout"].as_str().unwrap();
        assert_eq!(created["code"], 0);
        assert_eq!(digest.len(), 64);
        assert_ne!(digest, "cGVyc2lzdGVudC1yZWY");
        let receipt_bytes = fs::read(&receipt).unwrap();
        let receipt_mode = fs::metadata(&receipt).unwrap().permissions().mode() & 0o777;
        assert_eq!(receipt_mode, 0o600);
        let receipt_text = String::from_utf8(receipt_bytes).unwrap();
        assert!(!receipt_text.contains("access-secret-one"));
        assert!(!receipt_text.contains(account_id));

        let binding = response_body(&broker.handle_line(&request(&secret, 2, br#"{"operation":"binding"}"#)).unwrap());
        assert_eq!(binding["stdout"], digest);
        let read = response_body(&broker.handle_line(&request(&secret, 3, br#"{"operation":"read"}"#)).unwrap());
        assert_eq!(read["stdout"], first);

        let second = durable(account_id, "access-secret-two");
        broker.handle_line(&request(&secret, 4,
            serde_json::json!({ "operation": "upsert", "input": second }).to_string().as_bytes())).unwrap();
        let read = response_body(&broker.handle_line(&request(&secret, 5, br#"{"operation":"read"}"#)).unwrap());
        assert_eq!(read["stdout"], second);
        broker.handle_line(&request(&secret, 6, br#"{"operation":"delete"}"#)).unwrap();
        assert!(!receipt.exists());
        assert!(backend.0.lock().unwrap().item.is_none());
        let absent = response_body(&broker.handle_line(&request(&secret, 7, br#"{"operation":"exists"}"#)).unwrap());
        assert_eq!(absent["code"], 44);
        fs::remove_dir(receipt.parent().unwrap()).unwrap();
    }

    #[test]
    fn golden_scope_rejects_wrong_account_before_durable_create() {
        let secret = [11u8; 32];
        let receipt = test_receipt("fingerprint");
        let backend = GoldenFakeBackend::new();
        let mut broker = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret,
            GoldenBrokerOptions { expected_account_fingerprint: "0".repeat(12), receipt_path: receipt.clone() }).unwrap();
        let body = serde_json::json!({ "operation": "upsert", "input": durable("wrong-account", "secret") });
        assert!(matches!(broker.handle_line(&request(&secret, 1, body.to_string().as_bytes())),
            Err(BrokerError::InvalidFrame)));
        assert!(!receipt.exists());
        assert!(backend.0.lock().unwrap().item.is_none());
        assert!(backend.0.lock().unwrap().operations.is_empty());
        drop(broker);
        fs::remove_dir(receipt.parent().unwrap()).unwrap();
    }

    #[test]
    fn golden_startup_recovers_a_ref_bound_crash_before_new_work() {
        let secret = [12u8; 32];
        let receipt = test_receipt("recovery-ref");
        let backend = GoldenFakeBackend::new();
        let account_id = "recovery-account";
        let fingerprint = hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        let options = GoldenBrokerOptions { expected_account_fingerprint: fingerprint,
            receipt_path: receipt.clone() };
        let mut crashed = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret, options.clone()).unwrap();
        let body = serde_json::json!({ "operation": "upsert", "input": durable(account_id, "crash-secret") });
        crashed.handle_line(&request(&secret, 1, body.to_string().as_bytes())).unwrap();
        std::mem::forget(crashed);
        assert!(receipt.exists());
        assert!(backend.0.lock().unwrap().item.is_some());

        let recovered = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), [13u8; 32], options).unwrap();
        assert!(!receipt.exists());
        assert!(backend.0.lock().unwrap().item.is_none());
        let operations = backend.0.lock().unwrap().operations.clone();
        assert!(operations.windows(2).any(|pair| pair == ["delete-owned-ref", "read-ref"]));
        drop(recovered);
        fs::remove_dir(receipt.parent().unwrap()).unwrap();
    }

    #[test]
    fn recovery_precedes_selection_of_a_new_random_home_account() {
        let receipt = test_receipt("recovery-cross-account");
        let backend = GoldenFakeBackend::new();
        let account_id = "old-run-account";
        let fingerprint = hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        let mut crashed = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), [21u8; 32],
            GoldenBrokerOptions { expected_account_fingerprint: fingerprint.clone(), receipt_path: receipt.clone() }).unwrap();
        let body = serde_json::json!({ "operation": "upsert", "input": durable(account_id, "old-secret") });
        crashed.handle_line(&request(&[21u8; 32], 1, body.to_string().as_bytes())).unwrap();
        std::mem::forget(crashed);
        recover_golden_with(&receipt, &backend).unwrap();
        assert!(!receipt.exists());
        assert!(backend.0.lock().unwrap().item.is_none());
        let next = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.bbbbbbbbbbbbbbbb".into(), backend, [22u8; 32],
            GoldenBrokerOptions { expected_account_fingerprint: fingerprint, receipt_path: receipt.clone() }).unwrap();
        drop(next);
        fs::remove_dir(receipt.parent().unwrap()).unwrap();
    }

    #[test]
    fn golden_startup_recovers_an_armed_create_with_no_persisted_ref() {
        let secret = [14u8; 32];
        let receipt = test_receipt("recovery-armed");
        let backend = GoldenFakeBackend::new();
        backend.fail_after_create();
        let account_id = "armed-account";
        let fingerprint = hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        let options = GoldenBrokerOptions { expected_account_fingerprint: fingerprint,
            receipt_path: receipt.clone() };
        let mut crashed = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret, options.clone()).unwrap();
        let body = serde_json::json!({ "operation": "upsert", "input": durable(account_id, "armed-secret") });
        assert!(matches!(crashed.handle_line(&request(&secret, 1, body.to_string().as_bytes())),
            Err(BrokerError::RecoveryRequired)));
        std::mem::forget(crashed);
        let armed = fs::read_to_string(&receipt).unwrap();
        assert!(!armed.contains("persistent_ref"));
        assert!(!armed.contains("armed-secret"));

        let recovered = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), [15u8; 32], options).unwrap();
        assert!(!receipt.exists());
        assert!(backend.0.lock().unwrap().item.is_none());
        let operations = backend.0.lock().unwrap().operations.clone();
        assert!(operations.windows(3).any(|items|
            items == ["lookup-owned", "delete-owned-ref", "read-ref"]));
        drop(recovered);
        fs::remove_dir(receipt.parent().unwrap()).unwrap();
    }

    #[test]
    fn golden_drop_cleans_and_proves_absence() {
        let secret = [17u8; 32];
        let receipt = test_receipt("drop-cleanup");
        let backend = GoldenFakeBackend::new();
        let account_id = "drop-account";
        let fingerprint = hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        {
            let mut broker = BrokerSession::with_secret_golden(
                "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret,
                GoldenBrokerOptions { expected_account_fingerprint: fingerprint, receipt_path: receipt.clone() }).unwrap();
            let body = serde_json::json!({ "operation": "upsert", "input": durable(account_id, "drop-secret") });
            broker.handle_line(&request(&secret, 1, body.to_string().as_bytes())).unwrap();
        }
        assert!(backend.0.lock().unwrap().item.is_none());
        assert!(!receipt.exists());
        fs::remove_dir(receipt.parent().unwrap()).unwrap();
    }

    #[test]
    fn golden_recovery_never_deletes_an_identity_mismatch() {
        let secret = [18u8; 32];
        let receipt = test_receipt("recovery-mismatch");
        let backend = GoldenFakeBackend::new();
        let account_id = "protected-account";
        let fingerprint = hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        let options = GoldenBrokerOptions { expected_account_fingerprint: fingerprint,
            receipt_path: receipt.clone() };
        let mut crashed = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret, options.clone()).unwrap();
        let body = serde_json::json!({ "operation": "upsert", "input": durable(account_id, "protected-secret") });
        crashed.handle_line(&request(&secret, 1, body.to_string().as_bytes())).unwrap();
        std::mem::forget(crashed);
        let mut stale: GoldenReceipt = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        stale.expected_account_fingerprint = "0".repeat(12);
        write_receipt(&receipt, &stale).unwrap();

        assert!(matches!(BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), [19u8; 32], options),
            Err(BrokerError::RecoveryRequired)));
        assert!(receipt.exists());
        assert!(backend.0.lock().unwrap().item.is_some());
        // Restore the exact receipt so the test itself exits without leaving
        // credential-like fake state behind.
        stale.expected_account_fingerprint = hex::encode(Sha256::digest(account_id.as_bytes()))[..12].to_string();
        write_receipt(&receipt, &stale).unwrap();
        let recovered = BrokerSession::with_secret_golden(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), [20u8; 32],
            GoldenBrokerOptions { expected_account_fingerprint: stale.expected_account_fingerprint.clone(),
                receipt_path: receipt.clone() }).unwrap();
        drop(recovered);
        fs::remove_dir(receipt.parent().unwrap()).unwrap();
    }

    #[test]
    fn normal_scope_rejects_golden_binding_without_backend_access() {
        let secret = [16u8; 32];
        let backend = FakeBackend::default();
        let mut broker = BrokerSession::with_secret(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(), backend.clone(), secret);
        assert!(matches!(broker.handle_line(&request(&secret, 1, br#"{"operation":"binding"}"#)),
            Err(BrokerError::InvalidFrame)));
        assert!(backend.0.lock().unwrap().is_empty());
    }

    #[test]
    fn shutdown_waits_for_a_stalled_backend_to_settle() {
        struct StalledBackend {
            entered: SyncSender<()>,
            release: Arc<(Mutex<bool>, Condvar)>,
        }
        impl CredentialBackend for StalledBackend {
            fn execute(&self, _: &str, _: &str, _: Option<&str>, _: Option<&str>,
                _: Option<&[u8]>) -> Result<(i32, Vec<u8>), ()> {
                let _ = self.entered.send(());
                let (lock, wake) = &*self.release;
                let mut released = lock.lock().unwrap();
                while !*released { released = wake.wait(released).unwrap(); }
                Ok((0, b"settled".to_vec()))
            }
        }
        let secret = [9u8; 32];
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let session = BrokerSession::with_secret(
            "supertwin.chatgpt-oauth.aaaaaaaaaaaaaaaa".into(),
            StalledBackend { entered: entered_tx, release: release.clone() }, secret,
        );
        let (actor, _) = BrokerActor::start_session(session).unwrap();
        let response = actor.request(request(&secret, 1, br#"{"operation":"read"}"#)).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut actor = actor;
            let _ = actor.shutdown();
            let _ = done_tx.send(());
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(25)).is_err());
        let (lock, wake) = &*release;
        *lock.lock().unwrap() = true;
        wake.notify_all();
        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(response.recv_timeout(Duration::from_secs(1)).unwrap().is_ok());
    }
}

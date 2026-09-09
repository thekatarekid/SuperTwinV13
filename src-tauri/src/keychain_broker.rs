use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};

pub const REQUEST_PREFIX: &str = "SUPERTWIN_KEYCHAIN_REQUEST_V1 ";
pub const RESPONSE_PREFIX: &str = "SUPERTWIN_KEYCHAIN_RESPONSE_V1 ";
pub const HELLO_PREFIX: &str = "SUPERTWIN_KEYCHAIN_HELLO_V1 ";
const PROTOCOL: &str = "supertwin-keychain-broker-v1";
const MAX_FRAME_BYTES: usize = 768 * 1024;
const MAX_INPUT_BYTES: usize = 128 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug)]
pub enum BrokerError {
    InvalidFrame,
    Backend,
}

impl std::fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidFrame => "invalid credential broker frame",
            Self::Backend => "credential broker backend failed",
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
}

impl BrokerOperation {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Exists => "exists",
            Self::Read => "read",
            Self::Upsert => "upsert",
            Self::Delete => "delete",
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
    fn execute(&self, operation: &str, account: &str, input: Option<&[u8]>) -> Result<(i32, Vec<u8>), ()>;
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
    fn execute(&self, operation: &str, account: &str, input: Option<&[u8]>) -> Result<(i32, Vec<u8>), ()> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (operation, account, input);
            return Err(());
        }
        #[cfg(target_os = "macos")]
        {
            let operation = CString::new(operation).map_err(|_| ())?;
            let account = CString::new(account).map_err(|_| ())?;
            let bytes = input.unwrap_or_default();
            let mut output = std::ptr::null_mut();
            let mut output_len = 0usize;
            // SAFETY: all pointers remain live for the call. The Objective-C bridge
            // allocates output with calloc and transfers ownership to us.
            let code = unsafe {
                supertwin_keychain_execute(
                    operation.as_ptr(), account.as_ptr(), std::ptr::null(), std::ptr::null(),
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
    _account_lease: Option<File>,
}

impl<B: CredentialBackend> Drop for BrokerSession<B> {
    fn drop(&mut self) {
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

impl<B: CredentialBackend> BrokerSession<B> {
    pub fn new(account: String, backend: B) -> Result<Self, BrokerError> {
        let suffix = account.strip_prefix("supertwin.chatgpt-oauth.").ok_or(BrokerError::InvalidFrame)?;
        if suffix.len() != 16 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
            return Err(BrokerError::InvalidFrame);
        }
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| BrokerError::Backend)?;
        let lease = acquire_account_lease(&account)?;
        Ok(Self { session: hex::encode(secret), secret, account, next_id: 1, backend,
            _account_lease: Some(lease) })
    }

    #[cfg(test)]
    fn with_secret(account: String, backend: B, secret: [u8; 32]) -> Self {
        Self { session: hex::encode(secret), secret, account, next_id: 1, backend, _account_lease: None }
    }

    pub fn hello(&self) -> String {
        format!("{HELLO_PREFIX}{}\n", self.session)
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
        if URL_SAFE_NO_PAD.encode(&body) != wire.body { return Err(BrokerError::InvalidFrame); }
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
        let (code, output) = self.backend.execute(request.operation.as_str(), &self.account, input)
            .map_err(|_| BrokerError::Backend)?;
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
    thread: Option<JoinHandle<()>>,
}

impl BrokerActor {
    pub fn start(account: String) -> Result<(Self, String), BrokerError> {
        let session = BrokerSession::new(account, NativeCredentialBackend)?;
        Self::start_session(session)
    }

    fn start_session<B: CredentialBackend>(session: BrokerSession<B>) -> Result<(Self, String), BrokerError> {
        let hello = session.hello();
        let (sender, receiver) = mpsc::sync_channel::<ActorMessage>(8);
        let thread = thread::Builder::new().name("supertwin-keychain-broker".into()).spawn(move || {
            let mut session = session;
            while let Ok(message) = receiver.recv() {
                match message {
                    ActorMessage::Request(line, response) => {
                        let _ = response.send(session.handle_line(&line));
                    }
                    ActorMessage::Shutdown => break,
                }
            }
        }).map_err(|_| BrokerError::Backend)?;
        Ok((Self { sender, thread: Some(thread) }, hello))
    }

    pub fn request(&self, line: String) -> Result<Receiver<Result<String, BrokerError>>, BrokerError> {
        let (response, receiver) = mpsc::sync_channel(1);
        self.sender.try_send(ActorMessage::Request(line, response)).map_err(|_| BrokerError::Backend)?;
        Ok(receiver)
    }

    pub fn shutdown(&mut self) {
        // Security.framework queries explicitly disable authentication UI, so
        // they are expected to settle without waiting for an owner prompt. Do
        // not pretend a mutation was cancelled: join the serialized actor and
        // keep the app alive until the current operation has actually settled.
        let _ = self.sender.send(ActorMessage::Shutdown);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

impl Drop for BrokerActor {
    fn drop(&mut self) { self.shutdown(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    #[derive(Clone, Default)]
    struct FakeBackend(Arc<Mutex<Vec<(String, String, Option<Vec<u8>>)>>>);
    impl CredentialBackend for FakeBackend {
        fn execute(&self, operation: &str, account: &str, input: Option<&[u8]>) -> Result<(i32, Vec<u8>), ()> {
            self.0.lock().unwrap().push((operation.into(), account.into(), input.map(<[u8]>::to_vec)));
            Ok((if operation == "read" { 0 } else { 44 }, if operation == "read" { b"secret".to_vec() } else { vec![] }))
        }
    }

    fn request(secret: &[u8; 32], id: u64, body: &[u8]) -> String {
        let wire = serde_json::json!({ "protocol": PROTOCOL, "id": id,
            "body": URL_SAFE_NO_PAD.encode(body), "mac": message_mac(secret, b"request", id, body) });
        format!("{REQUEST_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&wire).unwrap()))
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
    fn shutdown_waits_for_a_stalled_backend_to_settle() {
        struct StalledBackend {
            entered: SyncSender<()>,
            release: Arc<(Mutex<bool>, Condvar)>,
        }
        impl CredentialBackend for StalledBackend {
            fn execute(&self, _: &str, _: &str, _: Option<&[u8]>) -> Result<(i32, Vec<u8>), ()> {
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
            actor.shutdown();
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

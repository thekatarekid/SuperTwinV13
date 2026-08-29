// SuperTwinV13 — handing a URL to the OS (spec §4.2.2 Accessibility onboarding).
//
// WHY THIS IS AN APP COMMAND AND NOT A BARE JS `shell.open()`
// ----------------------------------------------------------
// `open` called from JS goes through the shell plugin's OpenScope, whose
// DEFAULT validation regex is
//
//     ^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+
//
// (tauri-plugin-shell `open_scope()`, used whenever `plugins > shell > open`
// is unset — which it is here). The Accessibility deep link
//
//     x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility
//
// does not match that regex, so the IPC call was *rejected* every time. The
// old JS helper swallowed the rejection and fell through to `window.open`,
// which is inert for OS-scheme URLs inside WKWebView. Net effect in the
// packaged 13.4.1 app: "Open System Settings" did nothing, silently.
//
// The Rust-side `ShellExt::open` passes `None` for the scope (see
// `tauri_plugin_shell::open::open`), so it is not subject to that regex, and
// app-defined commands are not subject to the capability ACL either. We keep
// our own allow-list below instead of opening anything the webview asks for.

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// The only URL prefixes the shell will hand to the operating system.
/// Deliberately tight: the System Settings deep links this app needs, plus
/// ordinary web/mail links. Anything else is refused with a visible error.
const ALLOWED_PREFIXES: &[&str] = &[
    "x-apple.systempreferences:",
    "https://",
    "http://",
    "mailto:",
];

/// The Accessibility pane deep link. The worker serves this same string on
/// `/api/screen/status` (`ACCESSIBILITY_SETTINGS_URL`); it is duplicated here
/// only so the Rust tests can assert the allow-list actually admits it.
#[cfg(test)]
pub const ACCESSIBILITY_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// Is this URL one we are willing to pass to the OS opener?
///
/// Rejects flag-like strings (`--enable-debugging`, `-i`) and anything with
/// whitespace or control characters, both of which are the documented hazard
/// of widening an open-scope beyond `http(s)`.
pub fn is_allowed_url(url: &str) -> bool {
    if url.is_empty() || url.starts_with('-') {
        return false;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    ALLOWED_PREFIXES
        .iter()
        .any(|prefix| url.len() > prefix.len() && url[..prefix.len()].eq_ignore_ascii_case(prefix))
}

/// Open `url` outside the webview. Returns a human-readable `Err` string on
/// every failure path so the UI can render it instead of silently no-op'ing.
pub fn open_external_url(app: &AppHandle, url: &str) -> Result<(), String> {
    if !is_allowed_url(url) {
        return Err(format!("refused to open {url:?}: not an allow-listed URL"));
    }

    let mut failures: Vec<String> = Vec::new();

    // Primary: the shell plugin's Rust API (scope-free — see the header note).
    #[allow(deprecated)]
    match app.shell().open(url.to_string(), None) {
        Ok(()) => return Ok(()),
        Err(err) => failures.push(format!("shell plugin: {err}")),
    }

    // Belt-and-braces on macOS: LaunchServices directly. `open` resolves the
    // handler for the `x-apple.systempreferences` scheme (System Settings).
    #[cfg(target_os = "macos")]
    match std::process::Command::new("/usr/bin/open").arg(url).status() {
        Ok(status) if status.success() => return Ok(()),
        Ok(status) => failures.push(format!("/usr/bin/open exited with {status}")),
        Err(err) => failures.push(format!("/usr/bin/open: {err}")),
    }

    Err(failures.join("; "))
}

/// IPC entry point used by `openExternal()` in `src/lib/tauri.ts`.
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    open_external_url(&app, &url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_accessibility_deep_link_is_allow_listed() {
        assert!(is_allowed_url(ACCESSIBILITY_SETTINGS_URL));
        // Case-insensitive scheme, per RFC 3986.
        assert!(is_allowed_url(
            "X-Apple.SystemPreferences:com.apple.preference.security?Privacy_Accessibility"
        ));
    }

    #[test]
    fn web_and_mail_urls_are_allow_listed() {
        assert!(is_allowed_url("https://supertwin.local/help"));
        assert!(is_allowed_url("http://localhost:8013/api/health"));
        assert!(is_allowed_url("mailto:someone@example.com"));
    }

    #[test]
    fn everything_else_is_refused() {
        assert!(!is_allowed_url(""));
        assert!(!is_allowed_url("x-apple.systempreferences:")); // scheme only
        assert!(!is_allowed_url("https://")); // scheme only
        assert!(!is_allowed_url("--enable-debugging"));
        assert!(!is_allowed_url("-i"));
        assert!(!is_allowed_url("file:///etc/passwd"));
        assert!(!is_allowed_url("/usr/bin/rm"));
        assert!(!is_allowed_url("javascript:alert(1)"));
        assert!(!is_allowed_url("https://example.com/a b")); // whitespace
        assert!(!is_allowed_url("https://example.com/\nrm")); // control char
    }

    /// The regression this whole module exists for: the shell plugin's DEFAULT
    /// JS open-scope only admits mailto/tel/http(s), so routing the deep link
    /// through `shell.open()` from the webview can never work. If someone
    /// re-points `openExternal` at the plugin, this is the reason it breaks.
    #[test]
    fn the_default_js_open_scope_could_never_admit_the_deep_link() {
        let admitted_by_default_scope = ["mailto:", "tel:", "http://", "https://"]
            .iter()
            .any(|p| ACCESSIBILITY_SETTINGS_URL.starts_with(p));
        assert!(!admitted_by_default_scope);
    }

    /// Rust-side wiring check: the shell plugin is registered, this command is
    /// in the invoke handler, and the capability grants shell open + spawn.
    #[test]
    fn the_plugin_command_and_capability_are_registered() {
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("tauri_plugin_shell::init()"),
            "shell plugin must be registered on the Tauri builder"
        );
        assert!(
            lib.contains("opener::open_external"),
            "open_external must be in tauri::generate_handler!"
        );
        assert!(lib.contains("mod opener;"), "opener module must be declared");

        let capability = include_str!("../capabilities/default.json");
        assert!(
            capability.contains("\"shell:allow-open\""),
            "capabilities/default.json must grant shell:allow-open"
        );
        assert!(
            capability.contains("\"shell:allow-spawn\""),
            "capabilities/default.json must still grant shell:allow-spawn (worker sidecar)"
        );
    }
}

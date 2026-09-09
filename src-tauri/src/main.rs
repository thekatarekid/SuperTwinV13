// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(code) = supertwinv13_lib::maybe_run_native_keychain_verification(&args) {
        std::process::exit(code);
    }
    if let Some(code) = supertwinv13_lib::maybe_run_signed_golden(&args) {
        std::process::exit(code);
    }
    supertwinv13_lib::run()
}

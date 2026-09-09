use std::{env, path::PathBuf, process::Command};

fn build_keychain_bridge() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("keychain_broker_bridge.o");
    let archive = out.join("libsupertwin_keychain_broker.a");
    let source = PathBuf::from("src/keychain_broker_bridge.m");
    let compile = Command::new("/usr/bin/clang")
        .args(["-fobjc-arc", "-c", "-mmacosx-version-min=13.0"])
        .arg(&source).arg("-o").arg(&object).status().expect("run clang");
    assert!(compile.success(), "Keychain broker bridge compilation failed");
    let package = Command::new("/usr/bin/libtool")
        .arg("-static").arg("-o").arg(&archive).arg(&object)
        .status().expect("run libtool");
    assert!(package.success(), "Keychain broker bridge archive failed");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=supertwin_keychain_broker");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rerun-if-changed={}", source.display());
}

fn main() {
    build_keychain_bridge();
    tauri_build::build()
}

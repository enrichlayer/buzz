//! Build-time provenance. Kept dependency-free so its contract can be tested directly.
use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn git(root: &Path, args: &[&str]) -> Option<String> {
    // An unpacked archive inside another checkout must not inherit that repo's identity.
    let top = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(root)
        .output()
        .ok()?;
    if !top.status.success()
        || Path::new(String::from_utf8_lossy(&top.stdout).trim())
            .canonicalize()
            .ok()
            != root.canonicalize().ok()
    {
        return None;
    }
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn next_number(now: u128, previous: u128) -> u128 {
    now.max(previous + 1)
}

/// Embed build identity and register the source inputs that invalidate it.
pub fn emit() {
    let root = Path::new("../..");
    // Watch all tracked build inputs, including frontend assets and lockfiles.
    // Watching only build.rs leaves a stale identity after frontend-only edits.
    if let Some(files) = git(root, &["ls-files"]) {
        for file in files.lines() {
            println!("cargo:rerun-if-changed=../../{file}");
        }
    }
    for directory in ["../src", "src", "../public"] {
        println!("cargo:rerun-if-changed={directory}");
    }
    for name in ["HEAD", "index", "packed-refs"] {
        if let Some(path) = git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", name],
        ) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    if let Some(reference) = git(root, &["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git(
            root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                &reference,
            ],
        ) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    let revision = git(root, &["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(root, &["status", "--porcelain", "--untracked-files=normal"])
        .map(|status| {
            if status.is_empty() {
                "clean"
            } else {
                "modified"
            }
        })
        .unwrap_or("unknown");
    let out = std::env::var_os("OUT_DIR").unwrap_or_else(|| panic!("OUT_DIR is required"));
    let counter = Path::new(&out).join("buzz-build-number");
    let previous = fs::read_to_string(&counter)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let number = next_number(now, previous);
    fs::write(counter, number.to_string())
        .unwrap_or_else(|error| panic!("cannot persist Buzz build number: {error}"));
    println!("cargo:rustc-env=BUZZ_BUILD_NUMBER={number}");
    println!("cargo:rustc-env=BUZZ_BUILD_TIME_MS={now}");
    println!("cargo:rustc-env=BUZZ_BUILD_REVISION={revision}");
    println!("cargo:rustc-env=BUZZ_BUILD_SOURCE_STATE={dirty}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_numbers_advance_even_with_a_stalled_or_reversed_clock() {
        assert_eq!(next_number(100, 0), 100);
        assert_eq!(next_number(100, 100), 101);
        assert_eq!(next_number(99, 101), 102);
        assert_eq!(next_number(200, 102), 200);
    }
}

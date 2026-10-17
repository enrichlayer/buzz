//! Build-time provenance. Kept dependency-free so its contract can be tested directly.
use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

/// Repository-relative inputs of the desktop app. Only these rerun the generator
/// and count toward `modified`; edits elsewhere in the monorepo leave the identity alone.
const WATCHED_INPUTS: &[&str] = &[
    "desktop/index.html",
    "desktop/package.json",
    "desktop/postcss.config.js",
    "desktop/public",
    "desktop/src",
    "desktop/tailwind.config.js",
    "desktop/tsconfig.json",
    "desktop/vite.config.ts",
    "desktop/src-tauri/Cargo.lock",
    "desktop/src-tauri/Cargo.toml",
    "desktop/src-tauri/build.rs",
    "desktop/src-tauri/build_version.rs",
    "desktop/src-tauri/capabilities",
    "desktop/src-tauri/crates",
    "desktop/src-tauri/resources",
    "desktop/src-tauri/src",
    "desktop/src-tauri/tauri.conf.json",
    "pnpm-lock.yaml",
];

/// Files the release workflow rewrites (set-version-from-tag.mjs, then
/// `cargo update --workspace`) before building. A diff that only changes their
/// version lines is release stamping, not modified source.
const VERSION_STAMPED: &[&str] = &[
    "desktop/package.json",
    "desktop/src-tauri/Cargo.lock",
    "desktop/src-tauri/Cargo.toml",
    "desktop/src-tauri/tauri.conf.json",
];

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
        // `git status` must not refresh the watched index, or every build reruns.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned()
    })
}

fn next_number(now: u128, previous: u128) -> u128 {
    now.max(previous + 1)
}

/// Reuse the previous number while the recorded inputs are unchanged, so a
/// rerun without a source change does not force a new identity and recompile.
fn build_number(now: u128, previous: Option<(u128, &str)>, inputs: &str) -> u128 {
    match previous {
        Some((number, recorded)) if recorded == inputs => number,
        Some((number, _)) => next_number(now, number),
        None => next_number(now, 0),
    }
}

/// True when every changed line of a `git diff -U0` is a version assignment.
fn only_version_lines(diff: &str) -> bool {
    diff.lines()
        .filter(|line| {
            !line.starts_with("+++") && !line.starts_with("---") && {
                line.starts_with('+') || line.starts_with('-')
            }
        })
        .all(|line| {
            let line = line[1..].trim();
            let value = line
                .strip_prefix("\"version\": \"")
                .map(|rest| rest.trim_end_matches(','))
                .or_else(|| line.strip_prefix("version = \""));
            value.is_some_and(|value| {
                value
                    .strip_suffix('"')
                    .is_some_and(|version| !version.is_empty() && !version.contains('"'))
            })
        })
}

/// Classify `git status --porcelain` output, forgiving version-only release stamps.
fn source_state(status: &str, stamped_diff: impl Fn(&str) -> Option<String>) -> &'static str {
    let modified = status.lines().any(|entry| {
        let (code, path) = entry.split_at(entry.len().min(3));
        let restamped = VERSION_STAMPED.contains(&path)
            && !code.trim().is_empty()
            && code.trim().chars().all(|c| c == 'M')
            && stamped_diff(path).is_some_and(|diff| only_version_lines(&diff));
        !restamped
    });
    if modified {
        "modified"
    } else {
        "clean"
    }
}

/// Stable FNV-1a digest over the watched files' paths and contents.
fn digest_inputs(root: &Path) -> String {
    fn visit(path: &Path, relative: &str, hash: &mut u64) {
        let mut feed = |bytes: &[u8]| {
            for byte in bytes {
                *hash = (*hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
            }
        };
        if path.is_dir() {
            let mut entries: Vec<_> = fs::read_dir(path)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|e| e.file_name())
                        .collect()
                })
                .unwrap_or_default();
            entries.sort();
            for name in entries {
                let name = name.to_string_lossy();
                visit(&path.join(&*name), &format!("{relative}/{name}"), hash);
            }
        } else if let Ok(contents) = fs::read(path) {
            feed(relative.as_bytes());
            feed(&[0]);
            feed(&contents);
            feed(&[0]);
        }
    }
    let mut hash = 0xcbf2_9ce4_8422_2325;
    for input in WATCHED_INPUTS {
        visit(&root.join(input), input, &mut hash);
    }
    format!("{hash:016x}")
}

/// Embed build identity and register the source inputs that invalidate it.
pub fn emit() {
    let root = Path::new("../..");
    // Watch the desktop app's inputs, including frontend assets and lockfiles.
    // A missing path would rerun on every build, so register only existing ones.
    for input in WATCHED_INPUTS {
        if root.join(input).exists() {
            println!("cargo:rerun-if-changed=../../{input}");
        }
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
    let mut status_args = vec!["status", "--porcelain", "--untracked-files=normal", "--"];
    status_args.extend(WATCHED_INPUTS);
    let dirty = git(root, &status_args)
        .map(|status| {
            source_state(&status, |path| {
                git(
                    root,
                    &[
                        "diff",
                        "HEAD",
                        "--no-ext-diff",
                        "--no-color",
                        "-U0",
                        "--",
                        path,
                    ],
                )
            })
        })
        .unwrap_or("unknown");
    let out = std::env::var_os("OUT_DIR").unwrap_or_else(|| panic!("OUT_DIR is required"));
    let counter = Path::new(&out).join("buzz-build-number");
    let recorded = Path::new(&out).join("buzz-build-inputs");
    let inputs = format!("{revision}\n{dirty}\n{}\n", digest_inputs(root));
    let previous_number = fs::read_to_string(&counter)
        .ok()
        .and_then(|value| value.parse().ok());
    let previous_inputs = fs::read_to_string(&recorded).unwrap_or_default();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let number = build_number(
        now,
        previous_number.map(|number| (number, previous_inputs.as_str())),
        &inputs,
    );
    fs::write(&counter, number.to_string())
        .and_then(|()| fs::write(&recorded, &inputs))
        .unwrap_or_else(|error| panic!("cannot persist Buzz build number: {error}"));
    println!("cargo:rustc-env=BUZZ_BUILD_NUMBER={number}");
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

    #[test]
    fn build_numbers_advance_only_when_recorded_inputs_change() {
        assert_eq!(build_number(100, None, "a"), 100);
        assert_eq!(build_number(500, Some((100, "a")), "a"), 100);
        assert_eq!(build_number(500, Some((100, "a")), "b"), 500);
        assert_eq!(build_number(50, Some((100, "a")), "b"), 101);
    }

    #[test]
    fn version_only_diffs_are_release_stamps() {
        let json = "--- a/desktop/package.json\n+++ b/desktop/package.json\n@@ -4 +4 @@\n-  \"version\": \"0.5.26\",\n+  \"version\": \"1.2.3-beta.1\",\n";
        let toml = "@@ -9 +9 @@\n-version = \"0.5.26\"\n+version = \"1.2.3\"\n";
        assert!(only_version_lines(json));
        assert!(only_version_lines(toml));
        assert!(!only_version_lines(
            "@@ -4 +4 @@\n-  \"name\": \"buzz\",\n+  \"name\": \"fork\",\n"
        ));
        assert!(!only_version_lines(&format!("{toml}+serde = \"1\"\n")));
        assert!(!only_version_lines(
            "@@ -9 +9 @@\n-version = \"0.5.26\"\n+version = \"1\" # x\n"
        ));
    }

    #[test]
    fn source_state_forgives_release_stamping_only() {
        let stamp =
            |_: &str| Some("@@ -3 +3 @@\n-version = \"0.5.26\"\n+version = \"1.0.0\"\n".to_owned());
        let edit =
            |_: &str| Some("@@ -3 +3 @@\n-edition = \"2021\"\n+edition = \"2024\"\n".to_owned());
        assert_eq!(source_state("", stamp), "clean");
        let stamped = " M desktop/package.json\n M desktop/src-tauri/Cargo.toml\nM  desktop/src-tauri/Cargo.lock\n";
        assert_eq!(source_state(stamped, stamp), "clean");
        assert_eq!(source_state(stamped, edit), "modified");
        assert_eq!(source_state(stamped, |_| None), "modified");
        assert_eq!(source_state(" M desktop/src/app.ts\n", stamp), "modified");
        assert_eq!(source_state("?? desktop/package.json\n", stamp), "modified");
        assert_eq!(
            source_state(" D desktop/src-tauri/Cargo.toml\n", stamp),
            "modified"
        );
    }
}

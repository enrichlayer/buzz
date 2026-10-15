#!/usr/bin/env bash
# DEV-12976: exercise the production nextest scheduling contract with real processes.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/buzz-postgres-isolation.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/src" "$fixture_root/scripts" "$fixture_root/.config" "$fixture_root/active"
cp "$repo_root/rust-toolchain.toml" "$fixture_root/rust-toolchain.toml"
cp "$repo_root/.config/nextest.toml" "$fixture_root/.config/nextest.toml"
# Only database provisioning is replaced. The real scheduler reads the actual
# production profile and runs each fixture test in its own process.
printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture_root/scripts/postgres-test-setup.sh"
printf '#!/usr/bin/env bash\nexec "$@"\n' > "$fixture_root/scripts/postgres-test-wrapper.sh"
chmod +x "$fixture_root/scripts/"*.sh
cat > "$fixture_root/Cargo.toml" <<'TOML'
[package]
name = "postgres-isolation-fixture"
version = "0.0.0"
edition = "2021"
TOML
cat > "$fixture_root/src/lib.rs" <<'RS'
#[cfg(test)]
mod postgres_tests {
    use std::{fs, path::PathBuf, thread, time::{Duration, Instant}};
    fn root() -> PathBuf {
        PathBuf::from(std::env::var("BUZZ_ISOLATION_FIXTURE").expect("fixture root"))
    }
    fn ordinary() {
        let root = root();
        let own = root.join("active").join(std::process::id().to_string());
        fs::write(&own, "ordinary backend").expect("register backend");
        let end = Instant::now() + Duration::from_millis(500);
        while Instant::now() < end {
            assert!(!root.join("global").exists(), "ordinary test overlaps cluster-global probe");
            if fs::read_dir(root.join("active")).expect("backends").count() > 1 {
                fs::write(root.join("parallel-observed"), "yes").expect("record parallelism");
            }
            thread::sleep(Duration::from_millis(5));
        }
        fs::remove_file(own).expect("unregister backend");
    }
    #[test] #[ignore = "requires Postgres"] fn ordinary_a() { ordinary(); }
    #[test] #[ignore = "requires Postgres"] fn ordinary_b() { ordinary(); }
    #[test] #[ignore = "requires Postgres"] fn ordinary_c() { ordinary(); }
    #[test] #[ignore = "requires Postgres"] fn ordinary_d() { ordinary(); }
    #[test]
    #[ignore = "requires Postgres"]
    fn cluster_global_probe() {
        let root = root();
        fs::write(root.join("global"), "probe").expect("register probe");
        let end = Instant::now() + Duration::from_millis(500);
        while Instant::now() < end {
            assert_eq!(fs::read_dir(root.join("active")).expect("backends").count(), 0,
                "cluster-global probe overlaps ordinary backends");
            thread::sleep(Duration::from_millis(5));
        }
        fs::remove_file(root.join("global")).expect("unregister probe");
    }
}
RS
(
  cd "$fixture_root"
  BUZZ_ISOLATION_FIXTURE="$fixture_root" CARGO_TARGET_DIR="$fixture_root/target" CARGO_BUILD_JOBS=1 \
    cargo nextest run --profile postgres-ci --run-ignored ignored-only --no-fail-fast
)
test -s "$fixture_root/parallel-observed"
echo 'Cluster-global probes run alone; ordinary PostgreSQL tests retain parallelism'

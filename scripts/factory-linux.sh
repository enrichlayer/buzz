#!/usr/bin/env bash
# Run inside an admitted Buzz Factory workspace, never as a host fallback.
set -euo pipefail
[[ "$(uname -s)" == Linux && "$PWD" == /workspace/* ]] || {
  echo 'Buzz Linux validation requires a remote Factory workspace' >&2
  exit 1
}
. ./bin/activate-hermit
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-4}"
# Ephemeral validation has no later incremental build to reuse. Debug symbols
# and incremental objects exhausted the guest before the test verdict could be
# retained; assertions and the existing dev/test optimization levels stay intact.
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_TEST_DEBUG=0
case "${1:-}" in
  setup)
    for tool in cc pkg-config cmake python3; do
      command -v "$tool" >/dev/null || { echo "Factory image missing $tool" >&2; exit 1; }
    done
    pkg-config --exists openssl
    just desktop-install-ci
    ;;
  check)
    mkdir -p .tmp/factory-artifacts
    # Own this target directory exclusively: never clean a caller/shared cache.
    CARGO_TARGET_DIR="$(mktemp -d "$PWD/.tmp/factory-target.XXXXXX")"
    export CARGO_TARGET_DIR
    # Pipefail preserves the first failing check in the remote exit receipt.
    {
      df -Pk "$PWD"
      node --test desktop/scripts/build-enrichlayer-release-config.test.mjs
      python3 scripts/test-enrichlayer-updater.py
      python3 scripts/test-buzz-r2.py
      python3 scripts/test-factory-linux.py
      just fmt-check clippy test-unit desktop-check desktop-test desktop-build web-build
      du -sk "$CARGO_TARGET_DIR"
      # Release compilation uses another profile. Retire this run's completed
      # check/test objects before allocating release objects in the same guest.
      cargo clean --target-dir "$CARGO_TARGET_DIR"
      df -Pk "$PWD"
      cargo build --locked --release -p buzz-relay -p buzz-cli
      tar -czf .tmp/factory-artifacts/buzz-linux.tar.gz -C "$CARGO_TARGET_DIR/release" buzz-relay buzz
      du -sk "$CARGO_TARGET_DIR"
      df -Pk "$PWD"
    } 2>&1 | tee .tmp/factory-artifacts/validation.log
    ;;
  *) echo 'Usage: scripts/factory-linux.sh setup|check' >&2; exit 2 ;;
esac

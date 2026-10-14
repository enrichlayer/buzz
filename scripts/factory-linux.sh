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
report_storage() {
  df -Pk "$PWD"
  # Keep diagnostics bounded even if a filesystem walk stalls. These are
  # read-only sizes; only this run's unique target is ever cleaned below.
  timeout 10 du -sk "$CARGO_TARGET_DIR" "$HOME/.cargo" "$HOME/.cache/hermit" 2>/dev/null ||
    echo 'Some cache size diagnostics unavailable'
}
report_failure() {
  local status="$1"
  if (( status != 0 )); then
    # Factory retains a bounded stderr tail separately from the build stream.
    # Put the actual Rust assertions there after later passing test output.
    python3 scripts/factory-failure-summary.py .tmp/factory-artifacts/validation.log >&2 ||
      echo 'Factory failure summary unavailable; original exit status retained' >&2
    report_storage >&2 || true
  fi
  exit "$status"
}
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
    trap 'report_failure $?' EXIT
    # Pipefail preserves the first failing check in the remote exit receipt.
    {
      report_storage
      node --test desktop/scripts/build-enrichlayer-release-config.test.mjs
      python3 scripts/test-enrichlayer-updater.py
      python3 scripts/test-buzz-r2.py
      python3 scripts/test-factory-linux.py
      just fmt-check clippy
      report_storage
      # Clippy metadata need not coexist with every unit-test binary. Retire
      # only this run's completed lint phase before allocating the test phase.
      cargo clean --target-dir "$CARGO_TARGET_DIR"
      report_storage
      just test-unit desktop-check desktop-test desktop-build web-build
      report_storage
      # Release compilation uses another profile. Retire this run's completed
      # check/test objects before allocating release objects in the same guest.
      cargo clean --target-dir "$CARGO_TARGET_DIR"
      report_storage
      cargo build --locked --release -p buzz-relay -p buzz-cli
      tar -czf .tmp/factory-artifacts/buzz-linux.tar.gz -C "$CARGO_TARGET_DIR/release" buzz-relay buzz
      report_storage
    } 2>&1 | tee .tmp/factory-artifacts/validation.log
    ;;
  *) echo 'Usage: scripts/factory-linux.sh setup|check' >&2; exit 2 ;;
esac

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
    # Pipefail preserves the first failing check in the remote exit receipt.
    {
      node --test desktop/scripts/build-enrichlayer-release-config.test.mjs
      python3 scripts/test-enrichlayer-updater.py
      python3 scripts/test-buzz-r2.py
      just fmt-check clippy test-unit desktop-check desktop-test desktop-build web-build
      cargo build --locked --release -p buzz-relay -p buzz-cli
      tar -czf .tmp/factory-artifacts/buzz-linux.tar.gz -C target/release buzz-relay buzz
    } 2>&1 | tee .tmp/factory-artifacts/validation.log
    ;;
  *) echo 'Usage: scripts/factory-linux.sh setup|check' >&2; exit 2 ;;
esac

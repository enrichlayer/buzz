#!/usr/bin/env bash
# Build a standalone local demo app, preserving existing Buzz installations.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin ]] || { echo 'This installer supports macOS only. On other platforms run: node scripts/local-install.mjs start' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || { echo 'Refusing modified checkout; preserve/commit changes first.' >&2; exit 1; }
refuse_running() {
  if pgrep -f "Buzz Local Coding.app/Contents/MacOS" >/dev/null; then
    echo 'Buzz Local Coding is running. Quit it (including its helper processes) and run the installer again.' >&2
    exit 1
  fi
}
refuse_running
# One installer at a time: concurrent runs could delete each other's backup
# before a failed placement restores it. macOS has no flock. A symlink whose
# target is the holder PID is created atomically together with its owner, so
# no lock can exist without a PID to check, and a crash leaves a dead PID that
# the next run recovers.
LOCK="$HOME/Applications/.buzz-local-install.lock"
mkdir -p "$HOME/Applications"
acquire_lock() { ln -s "$$" "$LOCK" 2>/dev/null && [[ "$(readlink "$LOCK" 2>/dev/null)" == "$$" ]]; }
release_lock() { if [[ "$(readlink "$LOCK" 2>/dev/null)" == "$$" ]]; then rm -f "$LOCK"; fi; }
if ! acquire_lock; then
  if [[ -L "$LOCK" ]]; then
    holder="$(readlink "$LOCK" 2>/dev/null || true)"
  elif [[ -d "$LOCK" ]]; then
    # Directory lock from an earlier version of this installer.
    holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  else
    echo "Unexpected file at $LOCK; remove it if no installer is running." >&2
    exit 1
  fi
  if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null && ps -p "$holder" -o args= 2>/dev/null | grep -q "install-local-macos"; then
    echo "Another Buzz Local Coding install is running (pid $holder). Wait for it to finish." >&2
    exit 1
  fi
  # The previous holder exited without releasing; take the lock over.
  rm -rf "$LOCK"
  acquire_lock || { echo "Could not acquire $LOCK; another install just started." >&2; exit 1; }
fi
trap release_lock EXIT
. ./bin/activate-hermit
pnpm install --frozen-lockfile
TARGET="$(rustc -vV | sed -n 's/^host: //p')"
ROOT_TARGET="${BUZZ_LOCAL_ROOT_TARGET:-$ROOT/target}"
DESKTOP_TARGET="${BUZZ_LOCAL_DESKTOP_TARGET:-$ROOT/desktop/src-tauri/target}"
CARGO_TARGET_DIR="$ROOT_TARGET" cargo build --locked -p buzz-acp -p buzz-agent -p buzz-backend-kubernetes -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli
mkdir -p desktop/src-tauri/binaries
for binary in buzz-acp buzz-agent buzz-backend-kubernetes buzz-dev-mcp git-credential-nostr buzz; do
  cp "$ROOT_TARGET/debug/$binary" "desktop/src-tauri/binaries/$binary-$TARGET"
  chmod +x "desktop/src-tauri/binaries/$binary-$TARGET"
done
CONFIG="$(mktemp "${TMPDIR:-/tmp}/buzz-local-config.XXXXXX")"
trap 'release_lock; rm -f "$CONFIG"' EXIT
# Stable lane identity: updates retain this lane's profile, never production's.
node desktop/scripts/demo-build-config.mjs 'Local Coding' "$CONFIG" 0000000000000001 >/dev/null
cd desktop
BUZZ_BUILD_DEMO_SLUG=local-coding-0000000000000001 CARGO_TARGET_DIR="$DESKTOP_TARGET" pnpm tauri build --debug --bundles app --config "$CONFIG"
APP="$DESKTOP_TARGET/debug/bundle/macos/Buzz Local Coding.app"
[[ -d "$APP" ]] || { echo "Expected app missing: $APP" >&2; exit 1; }
DEST="$HOME/Applications/Buzz Local Coding.app"
mkdir -p "$HOME/Applications"
STAGED="$(mktemp -d "$HOME/Applications/.buzz-local-install.XXXXXX")"
trap 'release_lock; rm -f "$CONFIG"; if [[ -d "$STAGED" ]]; then echo "Staged build retained for recovery: $STAGED" >&2; fi' EXIT
ditto "$APP" "$STAGED/Buzz Local Coding.app"
BUNDLE="$STAGED/Buzz Local Coding.app"
# Sign nested code first, without entitlements: camera, microphone and
# disable-library-validation belong to the app executable only. Helpers keep
# the default (non-hardened) ad-hoc signature. Signing the bundle last re-signs
# its main executable with the entitlements under the hardened runtime;
# disable-library-validation lets it load MeshLLM's ad-hoc/unsigned runtimes.
for nested in "$BUNDLE"/Contents/Frameworks/* "$BUNDLE"/Contents/MacOS/*; do
  if [[ -e "$nested" ]]; then codesign --force --sign - "$nested"; fi
done
codesign --force --sign - --options runtime --entitlements "$ROOT/desktop/src-tauri/Entitlements.plist" "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"
refuse_running
BACKUP=""
if [[ -e "$DEST" ]]; then
  BACKUP="$(mktemp -d "$HOME/Applications/.buzz-local-backup.XXXXXX")"
  mv "$DEST" "$BACKUP/Buzz Local Coding.app"
  echo "Previous app preserved at $BACKUP/Buzz Local Coding.app"
fi
if ! mv "$STAGED/Buzz Local Coding.app" "$DEST"; then
  if [[ -n "$BACKUP" ]]; then
    mv "$BACKUP/Buzz Local Coding.app" "$DEST"
    # The restore emptied the backup; drop it so an empty directory is not
    # mistaken for a kept backup by the pruning pass below.
    rmdir "$BACKUP" 2>/dev/null || true
  fi
  echo "Install failed; previous app restored when available." >&2
  exit 1
fi
rmdir "$STAGED"
echo "Installed: $DEST"
# Keep only the newest backup; older ones are superseded copies of earlier
# installs. Only directories this installer could have produced (empty, or
# holding exactly the app bundle) are candidates; anything else is left alone.
installer_backup() {
  [[ -d "$1" && ! -L "$1" ]] || return 1
  local entries
  entries="$(ls -A "$1")"
  [[ -z "$entries" || ( "$entries" == "Buzz Local Coding.app" && -d "$1/Buzz Local Coding.app" ) ]]
}
KEEP="$BACKUP"
if [[ -z "$KEEP" ]]; then
  for old in "$HOME"/Applications/.buzz-local-backup.*; do
    if installer_backup "$old" && [[ -d "$old/Buzz Local Coding.app" ]] && [[ -z "$KEEP" || "$old" -nt "$KEEP" ]]; then KEEP="$old"; fi
  done
fi
for old in "$HOME"/Applications/.buzz-local-backup.*; do
  if [[ "$old" != "$KEEP" ]] && installer_backup "$old"; then rm -rf "$old"; fi
done
if [[ -n "$KEEP" && -d "$KEEP" ]]; then
  echo "Latest previous app backup: $KEEP/Buzz Local Coding.app (older backups removed)"
fi
echo 'Open this app explicitly. This ad-hoc signed local build is not a notarized release or auto-update installation.'

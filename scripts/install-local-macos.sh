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
# before a failed placement restores it. mkdir is atomic; macOS has no flock.
LOCK="$HOME/Applications/.buzz-local-install.lock"
mkdir -p "$HOME/Applications"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ -z "$holder" ]]; then
    # mkdir won the lock before its holder could publish the PID. Never steal
    # an empty lock directory: the owner is still inside the acquisition window.
    echo "Another Buzz Local Coding install is acquiring the installer lock. Wait for it to finish." >&2
    exit 1
  fi
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    echo "Another Buzz Local Coding install is running (pid $holder). Wait for it to finish." >&2
    exit 1
  fi
  # The previous holder exited without releasing; take the lock over.
  rm -rf "$LOCK"
  mkdir "$LOCK" || { echo "Could not acquire $LOCK; another install just started." >&2; exit 1; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
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
trap 'rm -rf "$LOCK"; rm -f "$CONFIG"' EXIT
# Stable lane identity: updates retain this lane's profile, never production's.
node desktop/scripts/demo-build-config.mjs 'Local Coding' "$CONFIG" 0000000000000001 >/dev/null
cd desktop
BUZZ_BUILD_DEMO_SLUG=local-coding-0000000000000001 CARGO_TARGET_DIR="$DESKTOP_TARGET" pnpm tauri build --debug --bundles app --config "$CONFIG"
APP="$DESKTOP_TARGET/debug/bundle/macos/Buzz Local Coding.app"
[[ -d "$APP" ]] || { echo "Expected app missing: $APP" >&2; exit 1; }
DEST="$HOME/Applications/Buzz Local Coding.app"
mkdir -p "$HOME/Applications"
STAGED="$(mktemp -d "$HOME/Applications/.buzz-local-install.XXXXXX")"
trap 'rm -rf "$LOCK"; rm -f "$CONFIG"; if [[ -d "$STAGED" ]]; then echo "Staged build retained for recovery: $STAGED" >&2; fi' EXIT
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
  if [[ -n "$BACKUP" ]]; then mv "$BACKUP/Buzz Local Coding.app" "$DEST"; fi
  echo "Install failed; previous app restored when available." >&2
  exit 1
fi
rmdir "$STAGED"
echo "Installed: $DEST"
# Keep only the newest backup; older ones are superseded copies of earlier installs.
KEEP="$BACKUP"
if [[ -z "$KEEP" ]]; then
  for old in "$HOME"/Applications/.buzz-local-backup.*; do
    if [[ -d "$old" && ( -z "$KEEP" || "$old" -nt "$KEEP" ) ]]; then KEEP="$old"; fi
  done
fi
for old in "$HOME"/Applications/.buzz-local-backup.*; do
  if [[ -d "$old" && "$old" != "$KEEP" ]]; then rm -rf "$old"; fi
done
if [[ -n "$KEEP" && -d "$KEEP" ]]; then
  echo "Latest previous app backup: $KEEP/Buzz Local Coding.app (older backups removed)"
fi
echo 'Open this app explicitly. This ad-hoc signed local build is not a notarized release or auto-update installation.'

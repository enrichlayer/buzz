#!/usr/bin/env bash
# Build a standalone local demo app, preserving existing Buzz installations.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin ]] || { echo 'This installer supports macOS. Use local-install.mjs start on other platforms.' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || { echo 'Refusing modified checkout; preserve/commit changes first.' >&2; exit 1; }
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
trap 'rm -f "$CONFIG"' EXIT
# Stable lane identity: updates retain this lane's profile, never production's.
node desktop/scripts/demo-build-config.mjs 'Local Coding' "$CONFIG" 0000000000000001 >/dev/null
cd desktop
BUZZ_BUILD_DEMO_SLUG=local-coding-0000000000000001 CARGO_TARGET_DIR="$DESKTOP_TARGET" pnpm tauri build --debug --bundles app --config "$CONFIG"
APP="$DESKTOP_TARGET/debug/bundle/macos/Buzz Local Coding.app"
[[ -d "$APP" ]] || { echo "Expected app missing: $APP" >&2; exit 1; }
DEST="$HOME/Applications/Buzz Local Coding.app"
mkdir -p "$HOME/Applications"
STAGED="$(mktemp -d "$HOME/Applications/.buzz-local-install.XXXXXX")"
trap 'rm -f "$CONFIG"; if [[ -d "$STAGED" ]]; then echo "Staged build retained for recovery: $STAGED" >&2; fi' EXIT
ditto "$APP" "$STAGED/Buzz Local Coding.app"
codesign --force --deep --sign - --entitlements "$ROOT/desktop/src-tauri/Entitlements.plist" "$STAGED/Buzz Local Coding.app"
codesign --verify --deep --strict "$STAGED/Buzz Local Coding.app"
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
echo 'Open this app explicitly. This ad-hoc signed local build is not a notarized release or auto-update installation.'

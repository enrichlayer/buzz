#!/usr/bin/env bash
# Install a verified cumulative candidate without changing account storage.
set -euo pipefail

[[ $# == 1 && -d "$1/Contents" ]] || {
  echo "Usage: $0 <verified-el-buzz.app>" >&2; exit 2;
}
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
source_app="$(cd "$1" && pwd -P)"
destination="$HOME/Applications/el-buzz.app"
identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/Contents/Info.plist")"
[[ "$identifier" == com.enrichlayer.buzz ]] || {
  echo "Refusing a candidate that changes the daily account namespace: $identifier" >&2; exit 1;
}
[[ "$source_app" != "$destination" ]] || {
  echo "Provide a separately staged candidate, not the installed app." >&2; exit 1;
}
if /bin/ps -axo comm= | /usr/bin/awk -v prefix="$destination/Contents/" 'index($0, prefix) == 1 { found=1 } END { exit !found }'; then
  echo "Quit el-buzz and its helpers before updating." >&2; exit 1;
fi
/usr/bin/codesign --verify --deep --strict "$source_app"
"$script_dir/sign-macos-local.sh" --identity >/dev/null
mkdir -p "$HOME/Applications"
stage="$(mktemp -d "$HOME/Applications/.el-buzz-install.XXXXXX")"
backup=""
installed=false
placed=false
cleanup() {
  if [[ "$installed" != true ]]; then
    if [[ "$placed" == true && -e "$destination" ]]; then
      mv "$destination" "$stage/rejected.app"
    fi
    if [[ -n "$backup" ]]; then
      mv "$backup" "$destination"
    fi
  fi
  # This directory contains only this invocation's disposable staged bundle.
  rm -rf "$stage"
}
trap cleanup EXIT
/usr/bin/ditto "$source_app" "$stage/el-buzz.app"
"$script_dir/sign-macos-local.sh" "$stage/el-buzz.app"
if [[ -e "$destination" ]]; then
  backup_root="$HOME/Library/Application Support/BuzzLocalSigning/backups"
  mkdir -p "$backup_root"
  chmod 700 "$backup_root"
  backup_dir="$(mktemp -d "$backup_root/install.XXXXXX")"
  backup="$backup_dir/el-buzz.app"
  mv "$destination" "$backup"
fi
mv "$stage/el-buzz.app" "$destination"
placed=true
/usr/bin/codesign --verify --deep --strict "$destination"
installed=true
printf 'Installed: %s\n' "$destination"
[[ -z "$backup" ]] || printf 'Previous app retained: %s\n' "$backup"
printf 'Account data and Keychain items were not changed.\n'

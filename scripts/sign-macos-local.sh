#!/usr/bin/env bash
# Local development signing only. Does not change Keychain item permissions.
set -euo pipefail

identity_file="${BUZZ_LOCAL_SIGNING_IDENTITY_FILE:-$HOME/.config/buzz/local-signing-identity}"
identity="${BUZZ_LOCAL_SIGNING_IDENTITY:-}"
if [[ -z "$identity" && -f "$identity_file" ]]; then
  identity="$(cat "$identity_file")"
fi
if [[ "${1:-}" == --identity ]]; then
  [[ -n "$identity" ]] || exit 1
  printf '%s\n' "$identity"
  exit 0
fi
[[ $# == 1 && "$1" == *.app && -d "$1/Contents" ]] || {
  echo "Usage: $0 <stopped-Buzz.app> | --identity" >&2; exit 2;
}
[[ "$identity" =~ ^[[:xdigit:]]{40}$ ]] || {
  echo "Configure a certificate SHA-1 in $identity_file; ad-hoc signing is not a stable identity." >&2
  exit 1
}
app="$(cd "$1" && pwd -P)"
identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")"
[[ "$identifier" =~ ^[A-Za-z0-9.-]+$ && "$identifier" == *buzz* ]] || {
  echo "Refusing a non-Buzz bundle identifier: $identifier" >&2; exit 1;
}
if /bin/ps -axo comm= | /usr/bin/awk -v prefix="$app/Contents/" 'index($0, prefix) == 1 { found=1 } END { exit !found }'; then
  echo "Quit this app and its helpers before signing: $app" >&2
  exit 1
fi
# Validate the configured identity before touching any executable.
/usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -Fq "$identity" || {
  echo "Configured signing identity is unavailable: $identity" >&2; exit 1;
}
# Sign nested Mach-O files first. Keep their entitlements/runtime flags, but
# replace linker-generated hash identities with stable bundle-scoped names.
while IFS= read -r -d '' executable; do
  if /usr/bin/file -b "$executable" | /usr/bin/grep -q 'Mach-O'; then
    relative="${executable#"$app/Contents/"}"
    /usr/bin/codesign --force --sign "$identity" --timestamp=none \
      --preserve-metadata=entitlements,flags \
      --identifier "$identifier.$relative" "$executable"
  fi
done < <(/usr/bin/find "$app/Contents" -type f -print0)
/usr/bin/codesign --force --sign "$identity" --timestamp=none \
  --preserve-metadata=entitlements,flags --identifier "$identifier" "$app"
/usr/bin/codesign --verify --deep --strict "$app"
/usr/bin/codesign -d -r- "$app"

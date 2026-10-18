#!/usr/bin/env bash
# Real Security.framework test with synthetic credentials and no auth dialogs.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/buzz-signing-proof.XXXXXX")"
cleanup() {
  /usr/bin/security delete-keychain "$work/proof.keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
app="$work/Buzz Proof.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.enrichlayer.buzz.signing-proof</string>
<key>CFBundleExecutable</key><string>proof</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
cat > "$work/proof.c" <<'C'
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status) return 3;
    SecKeychainRef keychain = NULL;
    if (strcmp(argv[1], "create") == 0) {
        status = SecKeychainCreate(argv[2], 9, "test-only", false, NULL, &keychain);
        if (!status) status = SecKeychainAddGenericPassword(keychain, 10, "buzz-proof", 5, "dummy", 9, "synthetic", NULL);
    } else {
        status = SecKeychainOpen(argv[2], &keychain);
        if (!status) status = SecKeychainUnlock(keychain, 9, "test-only", true);
        UInt32 length = 0;
        void *data = NULL;
        if (!status) status = SecKeychainFindGenericPassword(keychain, 10, "buzz-proof", 5, "dummy", &length, &data, NULL);
        if (!status && (length != 9 || memcmp(data, "synthetic", 9))) status = -1;
        if (data) SecKeychainItemFreeContent(NULL, data);
    }
    if (keychain) CFRelease(keychain);
    printf("build=%d status=%d\n", BUILD_VERSION, (int)status);
    return status == 0 ? 0 : 1;
}
C
build() {
  /usr/bin/xcrun clang -Wno-deprecated-declarations -DBUILD_VERSION="$1" \
    "$work/proof.c" -framework Security -framework CoreFoundation \
    -o "$app/Contents/MacOS/proof"
}
build 1
"$script_dir/sign-macos-local.sh" "$app"
first_hash="$(shasum -a 256 "$app/Contents/MacOS/proof")"
first_requirement="$(codesign -d -r- "$app" 2>&1 | sed -n '/^designated =>/p')"
"$app/Contents/MacOS/proof" create "$work/proof.keychain"
build 2
"$script_dir/sign-macos-local.sh" "$app"
second_hash="$(shasum -a 256 "$app/Contents/MacOS/proof")"
second_requirement="$(codesign -d -r- "$app" 2>&1 | sed -n '/^designated =>/p')"
[[ "$first_hash" != "$second_hash" && -n "$first_requirement" && "$first_requirement" == "$second_requirement" ]]
"$app/Contents/MacOS/proof" read "$work/proof.keychain"
echo 'PASS: changed executable retained its identity and read the existing item without UI.'
codesign --force --sign - "$app"
if "$app/Contents/MacOS/proof" read "$work/proof.keychain"; then
  echo 'FAIL: ad-hoc replacement unexpectedly accessed the item' >&2
  exit 1
fi
echo 'PASS: ad-hoc replacement was denied access to the same item.'

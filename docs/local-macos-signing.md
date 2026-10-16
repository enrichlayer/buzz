# Stable local macOS signing

## One daily el-buzz

The cumulative fork retains `com.enrichlayer.buzz`, the release Keychain service
`buzz-desktop`, the `.buzz` agent namespace, and `buzz://` deep links. Build in
release mode without either demo-slug environment variable. The macOS candidate
workflow composes the el-buzz branding with the fork release configuration;
branding must not create another identity.

After the candidate archive and its source/CI receipts have been verified, quit
the daily app and install the extracted bundle with:

```sh
./scripts/install-macos-local.sh /absolute/path/to/el-buzz.app
```

This uses the same persistent local signer on every update and installs to
`~/Applications/el-buzz.app`. The prior installed bundle is retained for rollback;
no account files or Keychain entries are migrated or removed. Launch that one
path. Retire older daily launch targets only after native account and feature
verification. The in-app updater currently consumes remotely signed artifacts;
it does not apply this local certificate. Until the release signing path provides
the same stable identity, use this installer for local candidate updates.

## Signing identity

Ad-hoc signatures identify an exact executable hash. Rebuilding a local Buzz
app can therefore invalidate its remembered Keychain authorization. A persistent
code-signing certificate plus an unchanged bundle identifier gives successive
builds the same designated requirement.

Create a dedicated self-signed **Code Signing** identity in Keychain Access
(Certificate Assistant → Create a Certificate). Keep that identity across
builds. If necessary, trust that certificate for **Code Signing** in the user
keychain; do not enable unrelated SSL trust or grant all apps access to secrets.
Find its SHA-1 with `security find-identity -v -p codesigning` and save the
40-character fingerprint in `~/.config/buzz/local-signing-identity`. Alternatively
set `BUZZ_LOCAL_SIGNING_IDENTITY` to the fingerprint.

Quit the target app and its helpers, then sign the completed bundle:

```sh
./scripts/sign-macos-local.sh "$HOME/Applications/Buzz Review.app"
```

The script preserves existing entitlements and runtime flags, signs nested
Mach-O files, assigns a stable identity derived from `CFBundleIdentifier`, and
verifies the bundle. Use it on a staged copy first. Never modify a running app's
executable. Local signing does not provide Apple notarization or modify the
application's Keychain item ACLs.

`just desktop-demo-build` and macOS `just desktop-release-build` use this identity
when configured and otherwise retain their existing behavior. Other packaging/install workflows must run
this command after their final bundle modification and before launch. Official
release signing remains separate. Distinct demo builds intentionally generate
new bundle identifiers and Keychain namespaces; a new namespace still requires
its own authorization. For repeated local validation, retain the existing
validation bundle identifier and Keychain service.

After switching from ad-hoc signing, enter the login Keychain password and click
**Always Allow** once per existing item/app identity. Then replace the app with a
different build signed by the same certificate and retaining the same bundle
identifier. Opening the same Keychain item should no longer prompt. Restarting
only the unchanged build does not test this regression.

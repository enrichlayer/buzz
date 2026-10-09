# Enrich Layer desktop updates

Our fork merges `block/buzz/main` into `enrichlayer/buzz/main` through reviewed
pull requests. Release tags are `el-desktop-vX.Y.Z`; upstream's `desktop-v*`
workflow and Block signing credentials are independent.

The first release lane builds signed, notarized macOS apps for Apple Silicon
and Intel, retaining Mesh LLM support. Windows and Linux keep their upstream
build tooling; this fork's updater feed currently advertises macOS only.

## Provision once

The dedicated updater key is backed up at Vault path
`secret/buzz/desktop-updater` (fields `private-key` and `public-key`). Read and
reuse it; do not regenerate it for ordinary releases. The initial key has no
passphrase, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is empty. Do not reuse Block's key or put private keys in git.
Generate the pair with `pnpm --dir desktop tauri signer generate --help` and
follow the CLI's file-output options. Store the private key and its password in
Vault, then configure these repository Actions secrets:

- `BUZZ_UPDATER_PUBLIC_KEY`
- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `APPLE_CERTIFICATE` (base64 Developer ID Application certificate with private key)
- `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`

Apple credentials must belong to our authorized Developer account. The workflow
fails before building when required credentials are absent. Tauri signs and
notarizes the app directly; it does not call Block's signing service.

The app identifier is `com.enrichlayer.buzz`. Install the first fork build
manually; upstream and local builds without this updater configuration cannot
bootstrap themselves onto our feed. The new bundle identity can require
reauthorizing OS permissions. Back up the existing Buzz profile before testing;
do not assume OS-keychain data automatically migrates between bundle identities.

## Release and promote

1. Merge the reviewed source change to our main branch.
2. Choose a new stable version greater than the last promoted fork version.
   Create `el-desktop-vX.Y.Z` on that main commit through the authorized release
   process. Never move or reuse a published tag. Local build labels are owned by
   DEV-12462 and do not by themselves publish updater versions.
3. The **Enrich Layer Desktop Release** workflow builds both architectures,
   verifies Apple signatures and notarization, and publishes installers plus
   `updater-manifest.json` on the versioned release. A failed draft can be retried;
   a published release is never overwritten by the workflow.
4. Install and exercise each published architecture. Verify the running version,
   community connection and agent launch. Then run **Promote Enrich Layer Desktop
   Update** from `main` with the exact tested version.
5. From an older fork release, check for updates, install, relaunch and confirm the
   new version. Record this runtime result separately from build and CI success.

The feed is
`https://github.com/enrichlayer/buzz/releases/download/buzz-desktop-latest/latest.json`.
Promotion rejects foreign URLs, missing architectures/assets/signatures, draft release candidates,
downgrades and a same-version manifest change. A higher patch is the recovery
path for a bad release; updater clients do not downgrade. Immutable
`promotion-X.Y.Z.json` records preserve the attempted version before feed replacement.
An interrupted first promotion resumes its draft on the same source commit; an
interrupted replacement resumes from its record, including after `latest.json`
was deleted. Rerun the same promotion instead of deleting its recovery records.

## Validation

Run `node --test desktop/scripts/build-enrichlayer-release-config.test.mjs` and
`python3 scripts/test-enrichlayer-updater.py`. These validate configuration and
manifest guards, not Apple notarization or a real in-app update. Those require
the configured credentials, both release builds and the install checks above.

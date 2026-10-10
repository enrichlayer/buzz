# Enrich Layer Buzz builds and updates

Our fork owns its updater key and R2 download origin. Central Buzz release
credentials and feeds are never used. Build work runs remotely: Linux checks
and binaries in an admitted Factory workspace, native macOS validation and
release packaging on GitHub macOS runners. A laptop orchestrates the work.

## Storage and credentials

Infrastructure change DEV-12632 manages two Cloudflare R2 buckets:

- `buzz-builds`: private build artifacts, keyed by source SHA, run, attempt and
  platform. `artifacts.json` is written last and records SHA-256 and size for
  every artifact. Fetch verifies every file and rejects platform collisions.
- `buzz-releases`: public immutable installers and signed updater archives at
  `https://buzz-downloads.enrichlayer.com/releases/X.Y.Z/`. `release.json` records
  the source commit and verified artifact hashes only after public readback.

The S3 endpoint is
`https://fc42fab64b7a71c11ced03fee83fe27d.r2.cloudflarestorage.com`.
Create bucket-scoped **account** credentials after the infrastructure CI apply;
store `access-key-id` and `secret-access-key` at `secret/r2/buzz-builds` and
`secret/r2/buzz-releases` in Verticalint Vault. Configure encrypted repository
secrets `BUZZ_BUILD_R2_ACCESS_KEY_ID`, `BUZZ_BUILD_R2_SECRET_ACCESS_KEY`,
`BUZZ_RELEASE_R2_ACCESS_KEY_ID`, `BUZZ_RELEASE_R2_SECRET_ACCESS_KEY`. Keep these
credentials out of logs, artifacts, source and fork pull-request execution.

The dedicated Tauri updater key already lives at `secret/buzz/desktop-updater`
(`private-key`, `public-key`, `repository`). Reuse it; do not regenerate it.
Actions uses `TAURI_SIGNING_PRIVATE_KEY` and `BUZZ_UPDATER_PUBLIC_KEY`. The
initial key has an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Apple Developer enrollment is not yet available. The signed release workflow
requires `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY` (Developer ID Application), `APPLE_ID`,
`APPLE_PASSWORD` and `APPLE_TEAM_ID`. It fails before building if any are absent.
The remote validation workflow can build/test native code without publishing a
signed app or a production updater feed.

## Remote validation

The Tools Factory profile must admit `enrichlayer/buzz` before creating its
workspace. A refusal is not permission to run under another repository identity.
Run `el-git factory run --repo https://github.com/enrichlayer/buzz --mr 6
--issue DEV-12467` against the exact published candidate SHA. The profile invokes
`scripts/factory-linux.sh setup` and `check`. Inspect the terminal validation
receipt; admission or transport success alone is not a passing build. Mutable
GitHub workspace authoring is not enabled by this profile. The script runs Rust and
frontend validation and builds Linux relay/CLI binaries. macOS native tests and
mobile checks remain separate gates; Linux unit tests do not substitute for
Postgres/Redis integration coverage.

Factory exports `.tmp/factory-artifacts/` before sandbox teardown. The controller
resolves `secret/r2/buzz-builds` from Verticalint Vault and supplies short-lived,
object-specific upload/download URLs; bucket credentials never enter the sandbox.
Each binary and log is downloaded again and checksum-verified before Factory
records an `r2://buzz-builds/linux/SOURCE_SHA/RUN_ID/artifacts.json` receipt.
Export failure prevents a successful validation attestation. The catalog binds
filenames to their content-addressed object keys and hashes.

To retrieve a completed run on an authorized remote runner, install
`scripts/buzz-r2-requirements.txt` in a virtualenv and run:

```sh
python3 scripts/buzz-r2.py fetch-build linux/SOURCE_SHA/RUN_ID verified
```

**Enrich Layer Remote macOS Validation** runs on arm64 and Intel macOS runners,
builds/tests native desktop code and verifies a private R2 artifact round trip.
Before this new workflow is present on the default branch, dispatch the existing
`macos-intel-canary.yml` workflow with `--ref` set to the candidate branch. In our
fork it delegates to the same two-platform validation workflow; upstream keeps
its existing Intel canary job. Wait until the dedicated R2 secrets are configured
before dispatching.

It does not need Apple credentials. **Enrich Layer Desktop Release** uses those
same remote platforms for signed and notarized distributable apps.

## Release and promote

1. Merge reviewed source to our main branch. Choose a stable version greater
   than the last promoted version and create immutable `el-desktop-vX.Y.Z` at
   that main commit. Never move a published tag.
2. The release workflow builds both architectures, verifies Apple signing and
   notarization, and uploads each platform to private R2. The publisher fetches
   and checksum-verifies both catalogs, then publishes immutable public assets.
   Retrying identical files is safe; changing an existing version is refused.
3. Install and exercise each architecture. Check version, community connection
   and agent launch. Then dispatch **Promote Enrich Layer Desktop Update** from
   `main` with the exact tested version.
4. Promotion checks source tag, signatures and private/public SHA-256 readback,
   writes an immutable promotion record and conditionally replaces `latest.json`.
   Concurrent writes fail rather than overwrite another promotion. The old feed
   survives failed writes; retry the same version. Downgrades and changed
   same-version manifests are refused.
5. From an older fork release, check for updates, install, relaunch and verify
   the version. Record agent and human runtime results separately from CI.

The feed is `https://buzz-downloads.enrichlayer.com/latest.json`, served with
`Cache-Control: no-store`; versioned assets have immutable cache headers. Do not
add a CDN rule that overrides the feed's cache policy. A higher patch version is
the recovery path for a bad release; clients do not downgrade.

The bundle identifier is `com.enrichlayer.buzz`. Install the first fork build
manually; upstream/local builds cannot bootstrap onto this feed. Back up the
existing profile and check OS permissions/keychain behavior across identities.
DEV-12462 separately owns visible local build versions.

## Verification and local cleanup

Focused checks are `node --test desktop/scripts/build-enrichlayer-release-config.test.mjs`,
`python3 scripts/test-enrichlayer-updater.py`, `python3 scripts/test-buzz-r2.py`
and actionlint for the Enrich Layer workflows. These do not establish a live
R2 deployment, completed remote build, notarization or successful app update.

Before deleting local caches, retain exact-head remote Linux and both macOS
success receipts, R2 catalog hashes and independent download verification.
Inventory each cache's owner and active processes. Delete only rebuildable
cache directories owned by this task after those gates pass. Preserve all
worktrees, uncommitted source, installed applications, credentials and peer-owned
caches. Never remove the shared `BuzzBuild.sparsebundle` wholesale. Until the
remote gates pass, local cache cleanup remains pending.

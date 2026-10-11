# Enrich Layer desktop releases

The team uses macOS (Apple Silicon and Intel), Windows x64 and Linux x64
AppImage. Mac builds are ad-hoc signed, without an Apple Developer account or
notarization. Windows installers have no publisher certificate. All updater
artifacts retain Tauri signatures from our own key. See the
[user installation and update guide](enrichlayer-buzz-user-guide.md).

## Automated release flow

After `CI` or `Enrich Layer Updater Checks` completes on a push to `main`,
**Enrich Layer Automatic Release** checks the latest main commit. Both workflows
must have succeeded for that exact commit, and other selected main workflows
must have completed without failure. Existing external check runs and commit
statuses on the source and PR head must also be successful. While a required
workflow, another main workflow or an external check is still running, or when
the commit is not a PR merge, the run is a green no-op: the next workflow
completion or the hourly retry re-evaluates it. A failed or missing-review
gate turns the run red. Already-promoted sources are not rebuilt, and a
published but unpromoted release is promoted from its existing assets without
rebuilding. Superseded commits are skipped.

The source must be the merge commit of exactly one main PR with:

- an `APPROVED` review on the PR's final head commit from someone other than
  the PR author: a collaborator with write, maintain or admin access, or the
  `enrichlayer-el-bot[bot]` reviewer app;
- no reviewer whose latest review requests changes, and no draft state.

Dismissed reviews and approvals of an earlier head are ignored, not counted.
The PR-body `buzz-review-completed` attestation from [AGENTS.md](../AGENTS.md)
remains required by the review process and release gate. It records the existing
human-test requirement and never substitutes for independent approval. A direct main push,
self-approval or missing checks cannot release. The workflow gate applies even
when branch protection is not configured.

The coordinator reserves `el-desktop-vX.Y.Z` at that source commit. It increments
the patch above the highest existing fork tag or checked-in stable app version.
Retries reuse the same source's tag; published tags must never move.
The reusable build workflow is called directly, so it does not rely on a
`GITHUB_TOKEN` tag push triggering another workflow.

Remote GitHub runners build both Macs, Windows NSIS and Linux AppImage. Linux
retains the upstream AppImage repair/resigning step; Mac/Linux retain Mesh LLM
build support. Windows follows the upstream Windows feature set. Local build
volumes are not used by this release pipeline.

Only a complete successful platform set reaches publication. Immediately before
publication, the gate rechecks current main, checks and review evidence. A new
main commit or withdrawn approval prevents an old candidate from shipping.
Installers and updater archives are published immutably to R2. A GitHub release
links to those downloads, then the R2 updater feed is promoted automatically. No extra per-release operator
approval is required after those gates. Clients download automatically and wait
for the user's **Restart to update** action before installing/relaunching.

## One-time repository setup

Inherited container workflows publish into this repository's GHCR namespace:
`ghcr.io/enrichlayer/buzz`, `buzz-sprig` and `buzz-push-gateway`. The repository
variables `GHCR_IMAGE`, `GHCR_SPRIG_IMAGE` and `GHCR_GATEWAY_IMAGE` can override
those destinations. Do not point them at Block's namespace. Sprig creates its
`sprig-latest` prerelease on first publication; an unavailable release-list API
remains a failure. These workflows still build and validate their artifacts,
and their failures continue to stop desktop rollout.

Reuse the updater key already backed up at `secret/buzz/desktop-updater` in
Verticalint Vault. Do not regenerate it during ordinary releases. No Apple
credentials are required. `signingIdentity: "-"` enables ad-hoc signing;
never disable updater signature verification to work around OS prompts.

The workflows reference three GitHub Environments, which a maintainer must create
before the first release (a job that names a missing Environment creates an
unprotected one):

| Environment | Used by | Deployment branches and tags | Secrets |
| --- | --- | --- | --- |
| `desktop-release` | public Mac/Linux/Windows builds and `publish` | branch `main`, tag `el-desktop-v*` | `BUZZ_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty for the existing unencrypted key) |
| `desktop-candidate` | private Mac/Linux/Windows candidates | exact reviewed candidate branch | existing updater key/public key/password and private-build R2 credentials only |
| `desktop-promote` | **Promote Enrich Layer Desktop Update**, automatic `promote` | branch `main` | `BUZZ_RELEASE_R2_ACCESS_KEY_ID`, `BUZZ_RELEASE_R2_SECRET_ACCESS_KEY` |

Move the three secrets from repository secrets into `desktop-release` and then
delete the repository-level copies, so a workflow on any other branch cannot
read them. Inside a job, the private key is passed only to the steps that run
the Tauri bundler or re-sign the repaired AppImage. Private builds use a separate
`desktop-candidate` Environment, allowing only the explicitly reviewed candidate
branch (`codex/DEV-12467-team-release` for initial validation). Give it the same
existing updater key and private-build R2 credentials, never public-release R2
credentials. Remove that branch allowance after acceptance; never allow every
branch. This separates credential access without adding per-release human
approval. Public-release branch restrictions stay unchanged.

Place R2 build credentials in `desktop-candidate` and `desktop-release`.
Public-release R2 credentials belong only in `desktop-release` and
`desktop-promote`. Retain the existing scoped keys; do not regenerate them.

Enable Actions in the fork and merge this workflow and its dependency changes
through the normal review process. The automatic workflow only runs from main.
A draft PR is preparation, not a live release or installed update.

If pushes produce no Actions runs even though the permissions API says enabled,
try a workflow dispatch and inspect its error. GitHub can disable an active fork
because of inherited workflow usage. A maintainer must open the repository's
Actions page and use its re-enable control; enabling an individual workflow
alone does not clear that repository state. Confirm a new run is accepted,
then inspect its actual jobs and results before claiming CI has passed.

The app identifier is `com.enrichlayer.buzz`; first installs and profile/OS
permission migration need explicit testing. Reviewers must exercise a real
browser-downloaded installer and an older-to-newer update on each supported
platform before claiming end-to-end acceptance. Build success is separate proof.

## Recovery and rollback

Rerun **Enrich Layer Automatic Release** from main after fixing an operational
failure or completing a delayed review. It rechecks all gates and reuses the
reserved tag. API failures propagate; they never mean first release or approval.
Before public upload, a private `release-inputs/X.Y.Z.json` receipt pins the
source and the successful artifact prefix for each platform. Later workflow
runs reuse those bytes even if newly rebuilt binaries differ. This also repairs
partial uploads without overwriting published files. Already-promoted sources
are skipped; announcement or feed failures resume from the same immutable inputs.

The feed is
`https://buzz-downloads.enrichlayer.com/latest.json`.
Promotion requires every platform and signature, only our versioned asset URLs,
and matching source/tag identity. A durable promotion journal prevents a failed
feed replacement from losing its version floor. Older versions and changed
same-version manifests are rejected. Both automatic and manual promotion share
a concurrency group. The manual recovery workflow retains the same review gate
and accepts a release whose source is an ancestor of current main, so a tested
release can still be promoted after later merges; the downgrade refusal still
applies.

For a bad release, publish a fixed higher version. Do not overwrite artifacts,
reuse a tag, silently downgrade clients or rotate the updater key. Installation
issues go to DEV-12467 with exact version/platform and reproducible evidence.

Run focused validation:

```sh
node --test desktop/scripts/build-enrichlayer-release-config.test.mjs
python3 scripts/test-enrichlayer-release-gate.py
python3 scripts/test-enrichlayer-publish.py
python3 scripts/test-enrichlayer-updater.py
python3 scripts/test-buzz-r2.py
actionlint .github/workflows/enrichlayer-*.yml .github/workflows/_enrichlayer-*.yml
```

Signing behavior follows [Tauri's macOS guidance](https://v2.tauri.app/distribute/sign/macos/)
and [updater signature requirements](https://v2.tauri.app/plugin/updater/).

## Remote validation and R2 setup

DEV-12632 manages `buzz-builds` (private) and `buzz-releases` (public) in
Cloudflare R2. Infrastructure !2984 must finish its existing gated provisioning
before credentials or downloads can work. The S3 endpoint is
`https://fc42fab64b7a71c11ced03fee83fe27d.r2.cloudflarestorage.com`.
Store bucket-scoped account credentials as `access-key-id` and
`secret-access-key` at `secret/r2/buzz-builds` and `secret/r2/buzz-releases` in
Verticalint Vault. Configure encrypted repository secrets
`BUZZ_BUILD_R2_ACCESS_KEY_ID`, `BUZZ_BUILD_R2_SECRET_ACCESS_KEY`,
`BUZZ_RELEASE_R2_ACCESS_KEY_ID`, and `BUZZ_RELEASE_R2_SECRET_ACCESS_KEY`.
Do not put credentials in source, logs, artifacts or fork PR execution.

Build catalogs bind every artifact to its SHA-256 and size and are written last.
Private paths include source SHA, run, attempt and platform. Publication fetches
and verifies each successful job's actual prefix, including mixed retry attempts.
`release.json` is written only after public artifact readback. Promotion verifies
source tag, all four platform signatures and private/public hashes, then uses an
atomic conditional replacement for `latest.json`. Feed responses use `no-store`;
versioned assets are immutable. Do not override that feed cache policy in a CDN.

The admitted Tools Factory profile runs Linux source checks and relay/CLI builds:

```sh
el-git factory run --repo https://github.com/enrichlayer/buzz --mr 8 --issue DEV-12467
```

Inspect the terminal receipt against the exact PR SHA. Admission or transport
success is not validation. The profile runs `scripts/factory-linux.sh`, exports
`.tmp/factory-artifacts/` before teardown, then independently downloads and checks
the files. The controller supplies object-specific URLs; bucket credentials do
not enter the sandbox. Artifacts use
`r2://buzz-builds/linux/SOURCE_SHA/RUN_ID/attempt-N/artifacts.json`.
Mutable GitHub authoring is not supported by this Factory profile. Linux checks
do not replace native Mac/mobile tests or Postgres/Redis integration coverage.

Before merge, dispatch the existing `macos-intel-canary.yml` workflow on the
candidate branch with `candidate_version=X.Y.Z`. For this fork it calls the same
four-platform packaging workflow with `publish: false`. It uses the production
app identity, ad-hoc Mac signing, updater key and feed configuration, but stores
artifacts only in private R2. No tag, public release or feed change occurs.
Choose a candidate version suitable for the installed older-to-newer test;
record the source SHA and artifact hashes alongside the test result.
An empty candidate version instead runs the separate native Mac validation app,
which has no updater and cannot prove production update behavior.

On an authorized runner, use `bash scripts/run-buzz-r2.sh fetch-build PREFIX DIR`
with credentials supplied through the environment to retrieve private candidates.
The helper installs its pinned SDK into a runner-temporary virtualenv. Candidate
installation, community connection, agent launch, download and consent/restart
must be exercised on both Mac architectures, Windows and Linux AppImage. Record
agent results and the human's confirmation separately from CI before adding the
repository review attestation. The production publish path always rechecks that
attestation and exact-main CI; the private candidate path cannot publish.

Do not delete local caches until exact-head Linux and both Mac remote receipts,
R2 catalog hashes and independent download verification exist. Inventory owners
and active processes first; preserve source, worktrees, installed apps, credentials,
peer caches and the shared BuzzBuild sparsebundle. No cleanup is implied by a
successful source test.

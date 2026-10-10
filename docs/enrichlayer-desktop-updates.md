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
must have completed without failure. An incomplete/missing check fails closed;
the second workflow completion retries the gate. An hourly retry also catches
delayed reviews or other workflows finishing later. Already-promoted sources
are not rebuilt. Superseded commits are skipped.

The source must be the merge commit of a main PR with:

- the `buzz-review-completed` attestation required by [AGENTS.md](../AGENTS.md),
  covering agent review/exercise and the required human test;
- any GitHub approvals still applying to the current PR head;
- no outstanding changes-requested review and no draft state.

This does not waive review or human testing. A direct main push, stale review,
dismissed approval, missing attestation, or missing checks cannot release.
Buzz agent reviews normally arrive as comments; the repository attestation
covers those reviews and human acceptance. No additional human approval round
is introduced by this automation.
The workflow gate applies even when branch protection is not configured.

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
The versioned GitHub release is populated as a draft, then published and
promoted to the updater feed automatically. No extra per-release operator
approval is required after those gates. Clients download automatically and wait
for the user's **Restart to update** action before installing/relaunching.

## One-time repository setup

Reuse the updater key already backed up at `secret/buzz/desktop-updater` in
Verticalint Vault. Do not regenerate it during ordinary releases. Set Actions
secrets `BUZZ_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty for the existing unencrypted key).
No Apple credentials are required. `signingIdentity: "-"` enables ad-hoc signing;
never disable updater signature verification to work around OS prompts.

Enable Actions in the fork and merge this workflow and its dependency changes
through the normal review process. The automatic workflow only runs from main.
A draft PR is preparation, not a live release or installed update.

The app identifier is `com.enrichlayer.buzz`; first installs and profile/OS
permission migration need explicit testing. Reviewers must exercise a real
browser-downloaded installer and an older-to-newer update on each supported
platform before claiming end-to-end acceptance. Build success is separate proof.

## Recovery and rollback

Rerun **Enrich Layer Automatic Release** from main after fixing an operational
failure or completing a delayed review. It rechecks all gates and reuses the
reserved tag. API failures propagate; they never mean first release or approval.
Draft releases can resume uploads. Already-published binaries are immutable:
a retry uses the existing release and resumes feed promotion.

The feed is
`https://github.com/enrichlayer/buzz/releases/download/buzz-desktop-latest/latest.json`.
Promotion requires every platform and signature, only our versioned asset URLs,
and matching source/tag identity. A durable promotion journal prevents a failed
feed replacement from losing its version floor. Older versions and changed
same-version manifests are rejected. Both automatic and manual promotion share
a concurrency group. The manual recovery workflow retains the same review gate.

For a bad release, publish a fixed higher version. Do not overwrite artifacts,
reuse a tag, silently downgrade clients or rotate the updater key. Installation
issues go to DEV-12467 with exact version/platform and reproducible evidence.

Run focused validation:

```sh
node --test desktop/scripts/build-enrichlayer-release-config.test.mjs
python3 scripts/test-enrichlayer-release-gate.py
python3 scripts/test-enrichlayer-publish.py
python3 scripts/test-enrichlayer-updater.py
actionlint .github/workflows/enrichlayer-*.yml
```

Signing behavior follows [Tauri's macOS guidance](https://v2.tauri.app/distribute/sign/macos/)
and [updater signature requirements](https://v2.tauri.app/plugin/updater/).

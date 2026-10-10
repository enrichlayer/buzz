# Install and update Enrich Layer Buzz

Enrich Layer Buzz is our custom desktop app for macOS, Windows, and Linux.
Get it from [our releases](https://github.com/enrichlayer/buzz/releases), using
an `el-desktop-v…` release. Builds from `block/buzz` do not include our changes.
If there is no published installer for your computer, the release is not ready;
source archives and CI artifacts are not team installers.

## Choose your download

| Computer | Download |
| --- | --- |
| Mac with an Apple chip (M1 or newer) | `Buzz_VERSION_darwin-aarch64.dmg` |
| Mac with an Intel processor | `Buzz_VERSION_darwin-x86_64.dmg` |
| Windows with an Intel/AMD 64-bit processor | `Buzz_VERSION_windows-x86_64-setup.exe` |
| Linux with an Intel/AMD 64-bit processor | `Buzz_VERSION_linux-x86_64.AppImage` |

`VERSION` is the release number. Mac's **About This Mac** shows its chip or
processor. Windows and Linux ARM installers are not currently provided.
The Linux build targets Ubuntu 24.04 and compatible systems; compatibility with
other distributions needs testing. Use AppImage for automatic updates.

## Install for the first time

If you already use upstream Buzz or a local development build, back up your
profile and ensure you can recover your identity before switching. Our app has
its own application identifier; profiles, keychain entries and OS permissions
may not transfer automatically. Do not delete your previous profile to fix a
login problem. Never send someone your private identity key.

### Mac

Open the `.dmg`, drag Buzz into **Applications**, and launch it from there.
Eject the installer afterward; do not run Buzz from the disk image.

Our initial Mac builds use ad-hoc signing. They are **not Apple notarized** and
do not have an Apple-verified developer identity. macOS may block the first
launch. After verifying that you downloaded our release, open **System Settings
→ Privacy & Security → Open Anyway**, then confirm. Follow
[Apple's per-app instructions](https://support.apple.com/102445).
Do not disable Gatekeeper for your whole Mac. A managed work Mac may require
help from its administrator.

### Windows

Run the downloaded `-setup.exe` installer and follow its prompts. Our initial
Windows installer does not have a Windows publisher certificate; Windows may
show an unknown-publisher or SmartScreen prompt. Verify the source and filename
before proceeding. On a managed work computer, ask its administrator if policy
blocks installation; do not turn off system-wide protection.

### Linux

Save the `.AppImage` in a permanent folder you can write to, make it executable
using your file manager's permissions settings, then launch it. Alternatively,
run `chmod +x` on the specific downloaded file in a terminal.

Keep the file in that writable location so Buzz can replace it during an update.
If your distribution reports missing AppImage/FUSE dependencies, follow its
package documentation or ask the team for help. `.deb`, `.rpm`, source builds,
and extracted AppImages are not the supported automatic-update installation.

## Join the team

Connect to `https://verticalint.communities.buzz.xyz` using your own Buzz
identity. Join the public **factory-orchestrator** channel to follow Factory
intake, decisions, progress and outcomes as the integration is enabled. Public
here means discoverable by community members. An empty channel is not proof that
the Factory feed is connected; the rollout must be verified separately.

## Updates and restarting

After a version passes the required checks and reviews, our release automation
builds all supported installers and publishes the update to the team. Buzz
checks for updates and downloads them in the background.

A downloaded update does **not** restart Buzz automatically. Choose **Restart to
update** when you are ready. You can dismiss the notification and keep working;
return to Settings to apply it later. Save your work and finish active calls or
local agent work before restarting. We do not promise active local work survives
an application restart.

Buzz verifies update signatures using our own release key. This verification is
separate from Apple's notarization or Windows publisher verification and remains
enabled on all platforms. The first custom build must be installed manually;
an upstream/development build will not automatically switch to our update feed.

## If something goes wrong

- **No update appears:** confirm that you installed an Enrich Layer release,
  check your connection, and use the update check in Settings. A failed release
  check or review keeps the previous version available.
- **Download or installation fails:** use **Retry** in Settings. Record the
  installed version, operating system and displayed error for the maintainer.
  Do not share identity keys or tokens in a report.
- **A new version causes a regression:** report it and retain your profile.
  Automatic downgrades are disabled; the team can release a corrected version
  with a higher number. A manual downgrade needs maintainer guidance because
  newer profile data might not work with older builds.

Initial installation and updates must be exercised on each supported platform
before this rollout is considered verified. See the
[maintainer release guide](enrichlayer-desktop-updates.md) for delivery gates.

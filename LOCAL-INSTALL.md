# Enrich Layer Buzz coding demo: local setup

Use **enrichlayer/buzz**, not the upstream Block installer. A higher marketing
version does not guarantee that the coding features are present. The demo channel
is `codex/buzz-local-install`; record its exact commit before building.
This branch is the local coding-demo channel, separate from the signed release channel.

## Prerequisites

This local installer is supported on macOS. Install Git, Bash, Python 3,
Hermit (the repository's pinned Rust/Node/pnpm/just toolchain), and Xcode Command
Line Tools. This desktop-only path does not require Docker, a local relay,
migrations, or a new `.env`. Linux/Windows installation is not validated by this
workflow; consult the upstream platform instructions rather than assuming this
installer supports them.

## Install and launch

Clone the published local-install branch:

```bash
git clone --branch codex/buzz-local-install https://github.com/enrichlayer/buzz.git buzz-local
cd buzz-local
. ./bin/activate-hermit
node scripts/local-install.mjs check
node scripts/local-install.mjs install   # macOS: standalone app in ~/Applications
# Or: node scripts/local-install.mjs start  # development session, terminal stays open
```

The macOS installer builds a stable, isolated **Buzz Local Coding.app**, ad-hoc
signs it, and installs it in `~/Applications`. It preserves an existing copy in
a uniquely named backup directory before replacing it. It does not overwrite
regular Buzz or Buzz Dev, migrate their identity, or configure signed automatic
updates. Quit the previous Local Coding instance before replacing/reopening it.
The installed app can run without the development terminal.

The development `start` command runs from its own checkout regardless of your shell directory. It
refuses a modified checkout, installs the frozen dependency lockfile, and runs
`just desktop-standalone`, which builds the app and matching agent CLI together.
Keep the terminal open while using this development app. This is a local launch,
not a signed `.app` installer or an automatic update subscription. No existing
Buzz profile is deleted, no identity is copied, and no agent access is granted.
Join your existing `verticalint` community using your own identity/invitation.
Use the instance launched by this terminal, not an older `/Applications/Buzz.app`.

## Install the coding cards

```bash
node scripts/local-install.mjs plugins
```

In **Settings → Plugins**, choose each printed JSON file and Install. Review,
Feedback, Runbook and Session demo require stable 1.x versions (minimum 1.0.0).
The compatibility panel lists Missing, Disabled, Incompatible or Ready. The
preexisting `test.session-card` renderer is also accepted. An unrelated renderer
using the same fence is flagged for review. Do not remove a renderer blindly;
use Update only when you intend to replace that same plugin ID. Plugins are
local to each desktop. These manifests compose drafts/copy text, never send
messages or execute commands. If a renderer is absent, chat preserves source and
shows a setup notice.

## Know what is installed and whether it is current

**Settings → Updates → Installed build and coding demo channel** reads the
running binary's metadata through DEV-12462's `get_app_build_info` API. Copy build
info when reporting a problem. Older binaries say identity is unavailable rather
than guessing from the current checkout. The existing native identity owner
provides version, build number, revision and modified-source state. The build date is captured at compilation; automatic signed distribution remains with DEV-12467.

**Check demo channel** compares that embedded revision with the configured demo
branch on GitHub. Exact clean matches say Current. A different revision says
Different, because it might be ahead, behind or diverged; modified builds cannot
claim Current. HTTP/authentication, timeout and offline errors say Unable to
check. This is an explicit public GitHub request; it sends no Buzz identity or
credentials. A private repository may require using the authenticated Git CLI
check instead. No failure is interpreted as up-to-date.

`node scripts/local-install.mjs check` compares the checkout only. It never proves
that an already-running app contains those files. To adopt a chosen reviewed
revision, stop this development app, preserve any local edits, then:

```bash
git fetch origin
git log --oneline HEAD..origin/codex/buzz-local-install
git merge --ff-only origin/codex/buzz-local-install
node scripts/local-install.mjs install
# Or use start again for a terminal-backed development session.
```

A divergent checkout refuses the fast-forward; resolve it deliberately, without
resetting someone else's work. After relaunch, compare the copied installed
revision to `git rev-parse HEAD`. A rebuild is required for native metadata;
frontend hot reload alone is not a new installed binary.

## Signed releases are a separate channel

DEV-12467 / PR #6 owns the independent Enrich Layer signed updater. Its first
manual installation, Apple signing, feed promotion and real install/update
acceptance are still pending; these local commands do not complete those steps.
The native identity API reuses DEV-12462’s existing implementation, with its original checkout preserved. Older native binaries deliberately show identity unavailable. No source freshness check grants merge or release
approval.

## Demo acceptance

Open `coding-steering-test` → “Full coding-plugin tour”. Check the four cards,
Mermaid, native diff, source-linked feedback and question answers. Explicitly
mention the agent to steer it. Charles's channel membership does not grant access
to another person's coding host. Verify his client and his messages separately
from owner-operated tests. Human permission cards depend on the configured
adapter; automatic approval is not a human approval test.

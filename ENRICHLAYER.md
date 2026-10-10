# Enrich Layer Buzz

Our shared source is [enrichlayer/buzz](https://github.com/enrichlayer/buzz), a
fork of [block/buzz](https://github.com/block/buzz). It is already a monorepo:
`desktop/`, `mobile/`, `web/`, `crates/`, and `deploy/` ship together. Custom
desktop cards, coding transcripts, annotations and CLI changes belong here.
Factory scheduling and its Buzz transport remain in Tools, where their existing
owners, database contracts and deployment pipeline live.

## Team setup

```sh
git clone https://github.com/enrichlayer/buzz.git
cd buzz
. ./bin/activate-hermit
just setup
just dev
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites and local service
configuration. Use the team's existing community URL to join the shared
workspace. Development setup does not create a production team community.
Keep personal keys, Vault credentials, `.env`, logs and database files outside
version control.

For non-developers, the entry point is our
[GitHub Releases page](https://github.com/enrichlayer/buzz/releases). Use an
`el-desktop-v…` installer for macOS (Apple Silicon or Intel), Windows x64, or
Linux x64 AppImage when available. Do not install an upstream binary expecting
our custom features. The rollout is owned by
[DEV-12467](https://linear.app/verticalint/issue/DEV-12467/).

The agreed initial Mac distribution uses ad-hoc signing without Apple
notarization or a paid Developer account. All platforms retain cryptographic
updater signatures from our own key. Reviewed releases with passing checks roll
out automatically; Buzz downloads the update and asks before restarting.
The first custom build must be installed manually. See the
[user installation guide](https://github.com/enrichlayer/buzz/blob/main/docs/enrichlayer-buzz-user-guide.md)
once the release changes reach main. A draft release PR does not establish a
published installer or a working installed update.

## One local entry point

On the maintainer workstation, the canonical folder is
`/Users/ytspar/git/enrichlayer/buzz`. Its ignored `local-workspaces/` directory
links to the existing feature and review checkouts, including those on the
BuzzBuild volume. These are working copies of this same GitHub monorepo, not
independent projects to import as submodules or copied source trees.

The original paths are retained because running native apps, Codex chats and
build caches can depend on them. The links do not merge branches. Use the PR
state to tell what is delivered; a local demo binary can contain unmerged work.
New teammates need only the single clone above. Do not commit workstation links.

Current separately reviewed work:

| Work | Source |
| --- | --- |
| Coding transcripts, plugins and verified CLI transport | [PR #4](https://github.com/enrichlayer/buzz/pull/4) |
| Floating annotations | [PR #5](https://github.com/enrichlayer/buzz/pull/5) |
| Upstream integration and desktop updater | [PR #6](https://github.com/enrichlayer/buzz/pull/6) |
| Visible build identity | [DEV-12462](https://linear.app/verticalint/issue/DEV-12462/) |

## Keeping the fork current

`Sync central Buzz` runs daily at 02:23 UTC (09:23 Bangkok) and can be started
manually from Actions on `main`. It fetches `block/buzz/main`, preserves our
history and any maintainer fixes on `codex/upstream-sync`, and opens a draft PR.
It never force-pushes, merges the PR, installs an app or promotes a release.
Conflicts produce a failed run and one updated GitHub issue with the affected
paths. Resolve the sync branch, push it, and rerun. Other failures remain failed
Actions runs; inspect them rather than treating absence of a PR as success.

The schedule becomes active only after this workflow is merged to `main` and
enabled in the fork's Actions settings. Allow Actions to create pull requests.
The built-in token can create the draft, but its PR workflow runs may require
**Approve workflows to run**. For unattended CI, configure `BUZZ_SYNC_TOKEN`
using an authorized repository-scoped bot token with contents, workflows and
pull-request write access (plus issues write for conflict tracking).
See [GitHub's token event rules](https://docs.github.com/en/actions/concepts/security/github_token).
Public-repository schedules can be disabled after 60 days without activity;
see [GitHub's schedule rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

The workflow runs the trusted sync script copied from our main branch before
the merge, and does not execute newly fetched source with its write token.
CI and the repository's agent/human acceptance checks remain required on the
resulting PR head. Routine upstream synchronization is separate from shipping
a new app release to teammates.

Run the merge regression suite with:

```sh
python3 scripts/test-enrichlayer-upstream-sync.py
```

## Factory Orchestrator in Buzz

The selected destination is the public **factory-orchestrator** channel in
`https://verticalint.communities.buzz.xyz`, channel ID
`134f0c59-68f7-45bb-a7d8-2bb5fe7026ed`. Creation and public visibility were
verified on 10 October 2026. Public means discoverable within the community;
creating the channel does not connect the Factory feed.

The existing bridge is owned by
[DEV-10851](https://linear.app/verticalint/issue/DEV-10851/), with
[Tools MR !6704](https://gitlab.com/vertical-int/tools/-/merge_requests/6704) and
[Control Panel MR !1972](https://gitlab.com/vertical-int/enrich-layer/el-lander/-/merge_requests/1972).
Both are draft with successful head pipelines as of 10 October 2026; production
rollout is not enabled. Deploy the compatible Control Panel parser before
enabling Tools emitters. Buzz PR #4 supplies the verified CLI transport.

The legacy Linear mirror only shows issue status changes. It is not evidence
that Factory intake, decisions, execution or outcomes are visible. The existing
bridge covers repository-bound agent coordination events; full intake and
decision visibility must also cover the authoritative mailbox and decision log.
Use one issue thread with concise progress, outcome and evidence links. Preserve
pending, ignored, failed and needs-human states. Do not copy raw payloads,
credentials or private code into the hosted community, and do not grant control
authority merely because a sender can post a Buzz message.

Acceptance requires a real intake item, its dispatch/decision, agent progress,
and terminal result appearing in Buzz with stable correlation. Then restart the
bridge and verify no missing or duplicate events. A passing source test or
pre-existing `fleet-status` channel does not establish this live result.

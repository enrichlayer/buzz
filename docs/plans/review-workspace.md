# Review workspace extension

Extends the existing Projects review surface in line with VISION_PROJECTS.md:
review discussion remains signed, queryable Buzz events alongside the code.

Evidence paths under `test-results/`, `.tmp/` and `verified-dev-state/` below
refer to local verification receipts, not files distributed in this repository.

## Comparison with Codiff

[Codiff](https://github.com/nkzw-tech/codiff) provides a local Git review app,
diff search, layout switching, viewed-file controls, and inline comments on
GitHub PRs and GitLab MRs. Its README also documents generated walkthroughs and
definition navigation. This change brings the requested review interactions
into Buzz's existing Projects surface. Discussion replies and state are stored
as Buzz events so they can survive independently of GitLab. Importing existing
GitLab discussions, synchronizing MR state, and migrating merge/CI policy remain
separate migration work; this change does not claim that parity.

## Behavior

- Unified and split layouts share one hunk parser. Both old and new sides have
  comment anchors; replacement blocks align without inventing source lines.
  Split view initially collapses the file tree to make room for code. A file
  selector and Show file tree keep every file reachable.
- Literal, case-insensitive diff search navigates matching source lines across
  files within the filename filter. Enter/Shift+Enter and Next/Previous wrap;
  Escape clears. Binary metadata is excluded. Truncated patches explicitly say
  that search only covers loaded lines.
- Viewed-file progress is local to the device, community, identity, repository,
  review and head. A SHA-256 digest of the actual file diffs also invalidates
  progress when the comparison changes. The last 50 review/revision scopes are
  retained (at most 2,000 files per scope). This is personal progress, not approval.
  Failed persistence leaves the checkbox unchanged and exposes a retry/recovery
  message. Corrupt saved data is preserved until explicitly cleared.
- Each line comment starts a separate discussion, even at the same anchor.
  Replies reference that discussion root. Resolution never grants approval or
  clears a request for changes. The starter, PR author or repository owner may
  resolve/reopen; other participants may reply. Resolved threads remain visible.
- Earlier-revision discussions retain their commit, side and line. General and
  unloaded-location discussions remain reachable below the diff. New commits do
  not reattach old discussion to unrelated lines.

## Event contract

Reuse kind 1 comments, the existing Buzz/NIP-34 review convention; no new HTTP
endpoint or event kind. This intentionally retains the current format while
VISION_PROJECTS.md targets NIP-22 kind 1111; that migration also requires relay
support. Every reply/status operation carries:

- `e` with the PR ID and `root` marker, for existing review-history queries;
- a separate `e` with the discussion starter's ID and `reply` marker;
- the repository `a` address;
- the starter's `c` commit and optional `file`/`side`/`line` anchor;
- `t=review-thread-resolve` or `t=review-thread-reopen` for state changes.

All reply markers point to the discussion starter, giving a flat conversation
without recursive traversal. Projected replies must match repository, commit and
anchor. State projection additionally validates the signer. States order by
`created_at`, then event ID; local writes advance beyond the latest observed
state timestamp. Untrusted status assertions do not control the discussion.
Existing clients can still read these events as ordinary comments.

## Validation and defect ledger

Owner for this implementation and its validation: the current Buzz review task.

| Finding | Disposition | Evidence / validation |
| --- | --- | --- |
| Header-like changed code and no-newline markers could corrupt line numbering | Fixed in the shared parser | `projectDiffRows.test.mjs` binds parsing, split alignment and search anchors |
| Mock review IDs change on reload, making progress tests visit a different review | Fixed test setup with an explicitly identified review | `project-review-workspace.spec.ts` reloads that same review |
| A failed save could falsely appear viewed/resolved or discard a reply | No optimistic success; errors propagate and draft remains | Storage unit tests and browser rejection tests |
| Old-side context comments could disappear when returning to unified mode | Unified rows retain both context-side anchors | Shared renderer; focused browser regression |
| Old or unloaded anchors could hide the only discussion controls | Retained under Other discussions | Shared projection/renderer; live new-head test |
| Cancel in the reply form could submit the draft | Fixed with an explicit button type | Browser regression asserts no signed event and retained draft |
| Docker unavailable; OrbStack startup failed with `Post http://vmrpc: EOF` | Resolved for local verification after restart; used isolated PostgreSQL/Redis and a dedicated MinIO container | Relay passed the object-store conformance probe with 32 writers, 3 rounds, zero transport drops |
| Live fixture had only a repository, and queried navigation before it rendered | Fixture now publishes the project announcement and awaits its repository link | Live browser fixture follows the real Projects navigation contract |

The 47 focused model/storage/parser/mutation tests passed. The two-identity live
relay browser test passed: it exercised split/search/viewed progress, published
a line comment and reply, resolved from the PR author's separate session,
reopened from the repository owner's session, then published a new head and
verified progress reset and retained historical discussion. An independent
relay query returned four discussion events with valid signatures. Evidence is
saved in `test-results/review-workspace/` (live screenshot, event JSON, runner
log, and relay startup log). All five focused mock browser journeys passed on
the final build, including Cancel, rejection/retry, storage failure, old-side
context discussions, and the existing inline-comment workflow. TypeScript,
targeted Biome checks, the E2E production frontend build, and `git diff --check`
passed. The isolated relay, PostgreSQL, Redis and MinIO services were stopped
after verification.
No production migration, merge or deployment is part of this change.

## Reproduce

Activate Hermit, then run from `desktop/`:

```sh
node --import ./test-loader.mjs --experimental-strip-types --test \
  src/features/projects/reviewThreads.test.mjs \
  src/features/projects/reviewViewedFiles.test.mjs \
  src/features/projects/lib/projectDiffRows.test.mjs \
  src/features/projects/projectPullRequests.test.mjs
pnpm test:e2e:smoke project-review-workspace.spec.ts
BUZZ_E2E_RELAY_URL=http://localhost:13039 pnpm test:e2e:integration \
  project-review-workspace.live.spec.ts
```

The live test requires an isolated seeded local relay. It uses two test identities
and checks signed-event persistence and cross-client reads. Native IPC is bridged:
Git diff loading uses the existing deterministic bridge fixture. This proves the
changed review renderer and real relay discussion path, not a native Git fetch,
installed app upgrade, or full GitLab migration.

The local proof used PostgreSQL on 15439, Redis on 16389, MinIO on 19000,
and the relay at `http://localhost:13039`. Seed with
`BUZZ_COMMUNITY_HOST=localhost:13039`; start the relay with
`BUZZ_RECONCILE_CHANNELS=true` so channel discovery events are generated.
Use `BUZZ_REQUIRE_AUTH_TOKEN=false` only on an isolated loopback test relay;
the fixture uses the repository's public test identities and verifies signatures.
Object-store admission stays enabled.

## Human verification

In the development build, enable Projects and open a repository's Review tab,
select a review, and expand Files changed:

1. Choose Split. Add separate comments to the Before and After sides.
2. Search a term appearing in two files; use Enter and Shift+Enter to navigate.
3. Mark a file Viewed and reload that same review; it should stay viewed.
4. Reply to a discussion, resolve it, then reopen it. In a second identity's
   session, reopen the review and confirm the same replies and state.
5. Publish a new review head: viewed progress resets, and the original discussion
   remains available under Other discussions with its Earlier revision label.

Human verification, full repository CI and PR readiness are separate gates; this
document does not attest that they have been completed.

## Installed native app proof — 2026-10-14

Exercised the installed `/Users/ytspar/Applications/Buzz Dev.app` (0.5.26)
with this checkout's production frontend, served by its existing localhost:30339
frontend server. No E2E bridge or Git IPC mock was loaded. The native binary was
unchanged. Its real Git fetch/diff commands accessed the isolated local relay's
smart HTTP Git repository, authenticated with the public development identities.
This verifies the changed frontend against the installed native shell; it does
not attest a newly packaged release or production GitLab migration.

The real `native-review-proof` repository contains three commits:

- Base: `7eea0c179c38fe215a555b78927d07648af8d81f`.
- Initial review: `7062d3c7793a8ca2901e80bd68030aa86107791f`.
- Follow-up: `6950b4470d2e64eed6599f46b6dd6d9bda624148`.

Both `main` and `review-discounts` were pushed through the relay's real Git HTTP
surface. The installed app rendered the actual two-file diff (+6/-3), then fetched
the follow-up commit and rendered its added zero-quantity guard (+7/-3).

Native UI verification used two distinct signing identities sequentially in the
installed app, with the original user's app state isolated and preserved:

1. Owner selected Split, searched `total`, used Shift+Enter to wrap from match
   1/10 in `src/price.ts` to 10/10 in `src/receipt.ts`, then Enter and Escape.
2. Owner marked `src/price.ts` Viewed and posted on Before line 2. Cmd+R retained
   both the comment and viewed progress.
3. Author opened that same review: progress was 0 viewed. Author cancelled a
   drafted reply, reopened it with its content retained, sent it, and resolved
   the owner's thread.
4. Owner reopened the app: its viewed mark remained and the author's reply and
   Resolved state were present. Owner reopened the discussion.
5. Author opened the review after a real new commit was pushed and announced:
   the reopened discussion remained under Other discussions, labelled Earlier
   revision with its original commit, side and line.
6. Owner opened the new head: viewed progress reset; the new guard appeared in
   the actual diff. A second inline comment posted on After line 3 of that head.
7. An independent relay query found exactly five discussion events: two inline
   roots, one reply, resolve and reopen. All five signatures verified, with the
   expected two pubkeys, repository address, root/reply references, and Git
   commit/file/side/line tags. Cancel produced no extra event.

Evidence: `test-results/review-native/` contains six distinct native screenshots
and accessibility captures, `signed-discussion-events.json`, `revision.json`,
`fixture.json`, original Git diff/commits, native app/relay logs, and
`restoration.json`. The scratch repository and launchers are preserved under
`.tmp/review-native/`; the final test state and production frontend are under
`verified-dev-state/`. The original Buzz Dev frontend and account directories
were restored, and the app visibly reopened as `ytspar` in `verticalint`.

### Native proof defect ledger

| Finding | Disposition, owner and next action | Validation |
| --- | --- | --- |
| Live fixture used a mock channel UUID; real Git ACL returned repository not found | Fixed by this task: use the deterministic general-channel UUID from `setup-desktop-test-data.sh`, also corrected in the live browser spec | Real authenticated push, native fetch and two revisions succeeded |
| Native HTTP connected to IPv4 localhost while the temporary relay listened only on IPv6 | Fixed by this task: bind this loopback fixture to 127.0.0.1 | Native Git diff loaded for both users |
| Git credential helper path containing spaces was parsed incorrectly | Fixed fixture setup by this task: use a no-space helper path | Both Git pushes succeeded |
| Fresh local native build encountered ExFAT AppleDouble `._default.toml` invalid UTF-8 | Avoided for this proof using the already installed native shell and production frontend. Build/cache migration remains owned by DEV-13015, “Move Buzz builds to remote boxes”; next action is its remote build pilot. No further heavy local build was started | Installed-shell native Git and event flow passed; fresh packaged build remains unverified |
| Native UI actions and signed-event persistence | No product defect reproduced in this run; no additional product patch required | Full scoped flow above passed; human verification and repository-wide CI remain separate pending gates |

The existing reply-Cancel fix was specifically rechecked in the native app.
No source commit, PR handoff, merge or deployment was performed by this proof.

The isolated relay, PostgreSQL, Redis and MinIO services were stopped after the
run; their data and Git repository were retained. Screenshot hashes were all
distinct. The corrected live-spec fixture passed Biome, and `git diff --check`
passed after documenting this run.


## Native coding-session access

The coding thread is the primary entry point for work produced in that session.
A persistent **Review changes** section below the thread root shows each linked
review's title, repository, branch, latest trusted commit and state, plus the
Linear issue link. It opens the existing full Projects review workspace. The
review's origin action opens the exact coding thread again. Projects and copied
`buzz://pr` links remain additional entry points into that same review.

The association is in the signed kind:1618 review, not a chat-message parser or
an observer transcript. A session can produce several reviews, including work
across repositories. No live agent is needed to rediscover them after relaunch.
The UI uses its current community and identity, scopes discovery to channel and
thread, and refreshes while focused. It rejects ambiguous metadata and exposes
query failures and bounded-history limits instead of reporting an empty result.

The review already carries repository `a`, head `c`, optional `merge-base`, and
branch metadata. Session reviews additionally carry:

- `e`: canonical thread-root event ID, empty relay hint, marker `buzz-session`.
  This is distinct from NIP-10 root/reply and NIP-34 revision references.
- `h`: the originating channel, using the existing origin convention.
- `r`: canonical HTTPS Linear issue URL, marker `linear-issue`, when supplied.

These are author-signed associations. They do not grant channel/repository
access, verify issue ownership, sync Linear status, or authorize a merge.
The CLI checks that the canonical thread exists in the named channel before
publishing the review and association in one event. It rejects conflicts with
harness-supplied thread/channel context. DMs never automatically export their
thread or channel coordinates.

### Agent workflow

Thread-scoped coding sessions pass their canonical root to session MCP tools
through `BUZZ_GIT_ORIGIN_THREAD_ID` alongside the existing channel provenance.
Native shell tools that do not inherit MCP environment variables must pass the
explicit thread/channel flags below. MCP
server environment templates cannot override or retain another session's
origin. The coding instructions tell agents to include the exact Linear issue
URL when the task has one:

```sh
buzz pr open --repo-owner "$REPO_OWNER" --repo-id "$REPO_ID" \
  --subject "Implement issue" --commit "$(git rev-parse HEAD)" \
  --clone "$CLONE_URL" --branch-name "$BRANCH" \
  --linear-issue "$LINEAR_ISSUE_URL"
```

Outside a thread-scoped harness, add `--thread "$THREAD_ROOT_ID" --channel
"$CHANNEL_ID"`. Channel-scoped sessions cannot safely guess which thread owns a
review; they must supply that explicit context. No branch-name or prose parsing
is used to infer the issue. Existing reviews without these tags still work from
Projects and their links, but are not silently attached to a coding thread.

Discover reviews with `buzz pr list --repo-owner "$REPO_OWNER" --repo-id
"$REPO_ID" --thread "$THREAD_ROOT_ID"`; read the signed record with `buzz pr get
--event "$REVIEW_ID"`. Subsequent commits use `buzz pr update` on the same review
ID, preserving the issue/thread association and earlier anchored discussions.
The existing review workspace supplies split view, diff search, viewed tracking,
and comment/reply/resolve/reopen. This extension does not invent a separate
session-specific copy of those controls.

### Session integration validation

- `threadReviews.test.mjs` exercises production relay-query composition,
  channel/thread isolation, trusted head updates, metadata validation, caps,
  and errors.
- `ThreadReviewList.test.mjs` renders and clicks the production UI: exact commit,
  Linear issue and native review navigation, including malformed coordinates.
- `pr_session.rs` tests call the production open command against HTTP fixtures,
  verify its signed event, and prove invalid thread roots never publish.
- Harness tests verify thread provenance and clearing across reused MCP configs.
- Remote full CI run 38719020960 and paired native build 38721389273 passed
  at `ad09660f41a8c291a051437676590a014664d5dd`. Installed native testing
  demonstrated normal Keychain launch and Quit, a managed coding session
  publishing its review with DEV-13099, two users exchanging and resolving/
  reopening comments, and a real new commit updating that review. After cold
  restart, the association, discussions and per-user viewed progress persisted.
  Local receipts: `test-results/review-normal-launch/repair/README.md`.
- Final independent review identified additional subprocess, history and
  provenance repairs. Their changed-head validation is tracked separately;
  the receipts above apply only to the named revision. Human acceptance is
  still pending. These are private unsigned validation packages, not a release.

## Review bundles (stacked pull requests)

A Factory jj workspace can author several related Linear issues as one stack:
one pull request per issue, each targeting the one below it, all pushed from the
same workspace. GitLab sees independent merge requests; Buzz needs an identity
for the stack so reviewers, the Orchestrator and the desktop can treat it as one
unit of review. That identity is the review bundle.

The contract reuses the labelled kind:1 convention above; no new event kind.

- **Bundle root**: a kind:1 note with exactly one role label `t=review-bundle`,
  the repository `a` address, a `subject`, and one `["e", <pr-id>, "", "bundle-member"]`
  per member pull request in stack order (base first). At least two members.
  Optional per member `["bookmark", <pr-id>, <jj-bookmark>]`; optional
  `["workspace", <factory-workspace-id>]`; the Linear issue `r` tag; `p` tags
  for the repo owner and the requested reviewers. A member listed twice, or a
  bookmark for a pull request outside the bundle, makes the note malformed.
- **Bundle verdict**: a kind:1 note with `["e", <bundle-id>, "", "root"]`, the
  repository `a` address, exactly one of `t=bundle-approval` or
  `t=bundle-changes-requested`, and one `["member-head", <pr-id>, <commit>]`
  per reviewed member pinning the head it covers. Optional
  `["e", <note-id>, "", "member-verdict"]` tags point at the per-member
  `approval` / `changes-requested` notes the reviewer posted on the member
  pull requests, so the GitLab-facing path stays unchanged. A verdict is current
  only while every pinned member still sits at its pinned head; a later push to
  any member needs a new verdict. Trusted signers are the same as for
  pull-request verdicts: a requested reviewer or the repo owner.
- **Mirrored roots**: a pull request opened for a GitLab merge request carries
  `["r", <merge-request-url>, "mirror-of"]` (`buzz pr open --mirror-of`). Such a
  root may also carry its Linear issue `r` tag without a session thread, because
  the issue is the stack's administrative identity rather than a conversation.

Readers: `desktop/src/features/projects/reviewBundles.ts` parses roots and
verdicts and checks head coverage; `crates/buzz-cli/src/commands/pr_bundle.rs`
emits them.

### External reviewer posting (CLI)

A reviewer that is not a Buzz client (the Tools reviewer worker, an agent in a
Factory workspace) posts review content through `buzz-cli` with its own keys:

```
buzz pr request-review --repo-owner <hex> --repo-id <d> --pr <id> --reviewer <hex>...
buzz pr comment  --repo-owner <hex> --repo-id <d> --pr <id> --commit <head> \
                 [--file <path> --side old|new --line <n>] [--reply-to <starter>] --body …
buzz pr review   --repo-owner <hex> --repo-id <d> --pr <id> --commit <head> \
                 --approve | --request-changes [--body …]
buzz pr bundle open   --repo-owner <hex> --repo-id <d> --subject … \
                      --member <pr-id>[:<bookmark>] --member … [--reviewer <hex>] \
                      [--workspace <id>] [--linear-issue <url>]
buzz pr bundle review --repo-owner <hex> --repo-id <d> --bundle <id> \
                      --member-head <pr-id>:<commit> … --approve | --request-changes \
                      [--member-verdict <note-id>] [--body …]
buzz pr bundle get    --repo-owner <hex> --repo-id <d> --bundle <id>
```

Every command emits the tags the desktop validates (`e … root`, `a`, `c`,
`file`/`side`/`line`, `p`), so a note the CLI posts projects exactly like one
the app posts. Inline comments require `--commit`; verdicts require the head
they cover. Who may post is still decided by the reader: a verdict from a key
that is neither a requested reviewer nor the repo owner is readable but does
not change review state.


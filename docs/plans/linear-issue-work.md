# Linear-backed issue work

Tracking: [DEV-13285](https://linear.app/verticalint/issue/DEV-13285/).
Initial authorized source scope: **Tools and standardization**, in the
`verticalint` Linear workspace. PR #28 remains a separate final-test candidate.
The user selected a **private channel for themselves first**. No source issues
have been published to a relay yet; the installed owner app created the private destination and its member list showed only the owner. Membership must be rechecked at publication.

## Product contract

Linear owns planning. Buzz presents the same work and owns the conversation,
agent execution and code review around it. The task is the entry point:

`Linear issue → Buzz task → coding threads / agent sessions → commits → reviews`

Every arrow supports return navigation. Multiple sessions and revisions belong
to the same issue; they do not create duplicate tasks. A task shows its acceptance
criteria, dependencies, current work, review state and source freshness. Opening
another task must never reuse the previous task's agent conversation.

Keep these facts separate: Linear workflow state, agent running/idle/failed,
CI results at a commit, review decision at a commit, merge, and human acceptance.
None implies another. Initially edits to planning metadata happen in Linear.

## Structure to preserve

Linear workspaces contain teams with their own workflows. Projects can span
teams; initiatives group projects; milestones organize a project's issues;
cycles belong to teams. Preserve source UUIDs as identity and identifiers/URLs
as display/navigation. Do not infer identity from a title, branch or issue-number
prefix. Retain existing parent/child and related/blocked-by relationships.

The preferred local workflow uses projects, milestones and related issues with
explicit dependencies, and one issue per branch/MR. Deep nesting is supported
when present, not invented during import. A Linear project is not a repository:
tasks must remain usable before a repository or branch has been selected.

This extends VISION_PROJECTS.md's repository-group model. Do not create fake Git
repositories merely to make imported planning tasks fit the existing UI.

## Existing seams and missing behavior

- PR #28 signs a review's canonical coding-thread and optional Linear URL. It
  renders a review card in that thread. This is an author's association, not a
  verified Linear task, its status, or a permission grant.
- Native Tasks currently reduces NIP-34 kind 1621 issues grouped by repository.
  No Linear importer or shared Linear task identity is present.
- Projects agent chat currently persists its opener by repository; selecting
  another task can therefore resume unrelated work. Both persistence and React
  remount identity need the selected work item.
- Tools' DEV-10851 mailbox bridge already groups agent activity by issue. Reuse
  its recorded thread identities; do not guess a thread from nearby messages.
- Control Panel has Linear issue upserts and a daily Temporal snapshot workflow.
  DEV-8739 owns its stale mirror. Source inspection found a watermark advance
  after a bounded-but-incomplete scan and snapshot success after refresh failure.
  It is not a trusted sync source until the owning repair is validated.

## Sync contract

Use one configured integration identity and an explicit source-project to Buzz
community/channel mapping. Keep credentials in the existing secret store; never
embed personal API keys in the desktop bundle or borrow a user's Nostr key.
Authorization to read Linear does not by itself authorize publishing its private
records into a wider Buzz audience. Verify the destination membership first.

Use el-linear's profile-aware API boundary to read source data. A first sync
enumerates the selected project and its issues to exhaustion. Preserve full
descriptions, team workflow names/types, priority, labels, assignment references,
milestone, cycle and relationships. Bound each activity, but persist continuation
cursors and do not mark an incomplete scan fresh. Source timestamps and an
integration receipt identify what was observed and when.

Publish idempotent signed updates with stable source identities. Persist pending
publication before attempting it; acknowledge and checkpoint only after accepted
events. Restart/retry must neither duplicate tasks nor discard work. Reconcile
periodically to recover missed notifications. Archive/removal requires a complete,
authorized source observation; absence from a failed or truncated page is not a
deletion. Out-of-order updates cannot overwrite newer source state. Show stale
data with a visible retry/error state, never as authoritative success.

Webhooks can accelerate reconciliation after the polling path is proven. Validate
signature, timestamp and organization, durably enqueue before acknowledgement,
and deduplicate delivery IDs. Use the existing worker platform, not an agent that
must remain in an open chat or an unmanaged loop on the maintainer's Mac.

## Delivery and acceptance

1. Bind task-specific coding conversations and durable issue references.
2. Mirror the selected Linear project and tasks without requiring a repository.
3. Connect task → existing/new coding thread → agent session → commit/review,
   including return navigation, source freshness and failure recovery.
4. Run the sync through the remote worker, exercise source updates and restart,
   package remotely, and validate the installed two-user flow.

Tests bind production reducers, publish/checkpoint boundaries and navigation.
Prove replay, paging exhaustion, failed reads/writes, changed source metadata,
wrong workspace/signer, revoked access, and two tasks in the same repository.
Human acceptance remains explicit. This initial mirror does not attest parity
with all Linear administration, reporting or integration features.

## Implementation status

- Source enumeration completed against the real project: 4,722 issues, all pages
  consumed, including archived records. The private snapshot stays in ignored
  local evidence, not source control.
- Task/review conversation persistence is scoped by work-item identity, community
  and signer. Task detail context now includes bounded acceptance criteria and a
  native return link in the same signed opener.
- Mirror records use channel-scoped addressable kinds 30623 (project) and 30624
  (task). Their d-tag includes channel, organization and source entity UUIDs.
  Repository selection is not part of planning identity. These kinds require
  relay deployment before publication.
- `buzz linear sign-record` and `publish-record` provide the integration transport.
  The publisher checks the private destination, signer, exact acknowledgement and
  current replaceable head. It does not borrow a desktop identity.
- `scripts/linear-sync.mjs` is one bounded scheduler activity, not a background
  Mac loop. The SQLite process lock releases on crash; filesystem checkpoints
  retain exact signed retries, source versions, failure health and complete-scan
  receipts. Initial/periodic full enumeration precedes delta publication.
- Native Projects/Tasks lists and source detail are implemented with stable deep links, complete-list bounds and source freshness. A signed task association on the thread opener is inherited by CLI reviews and resolves back to the native task. Frontend regressions pass; installed feature proof is pending.
- The private destination exists in the pilot, with only the owner observed in its membership. No records have been published and no integration identity has been added.
- Remaining: remote Rust/relay validation, deployed worker and integration identity, remote packaging and installed acceptance.

## Defect and acceptance ledger

| Item | Disposition and owner / next action | Evidence and validation |
|---|---|---|
| Two tasks reused a repository conversation | Fixed in DEV-13285; this branch owns rollout | Scope regression tests pass; native validation pending |
| Agent only received task title/status | Description and return link added; this branch owns rollout | Bounded context and hostile-text regressions pass |
| Control Panel snapshot can advance after incomplete/failed refresh | Existing DEV-8739 owns mirror repair; not used as sync input | Source inspection; no live repair claim |
| Source enumeration truncation risk | Fail closed on pagination, identity, deadline or size failures | Eight source tests and real 4,722-issue scan pass |
| Lost publication acknowledgement / worker crash | Exact signed outbox, fsync checkpoints and crash-released writer lock | Retry, contention and killed-process recovery tests pass |
| Missing source issue mistaken for deletion | Complete scan emits out-of-scope projection, clears copied body; restoration supported | Retraction/restoration regression passes |
| New event transport and relay access | Implemented, remote validation pending | Core contract and routing tests authored; no local Rust build |
| CLI command inventory omitted the new linear group | Fixed expected inventory after remote test failure; next remote run validates | First CI compiled the new transport, then failed the explicit command inventory test |
| Native mirror UI and durable deployed sync | Active DEV-13285 work, owned by this agent | Not delivered, no live publication or sync claim |
| PR #28 final test | Existing PR remains draft for the user | Full CI and paired native packages green; installed two-user proof complete |

## Sources inspected

- [Linear concepts](https://linear.app/docs/conceptual-model)
- [Linear projects](https://linear.app/docs/projects)
- [Linear pagination](https://linear.app/developers/pagination)
- [Linear webhooks](https://linear.app/developers/webhooks)
- el-linear: `src/commands/issues/tree.ts`, issue/project/milestone APIs.
- el-lander: `knowledge-base/internal/customer-support/tools/linear/project-based-issue-structure-example.mdx`;
  `apps/control-panel/src/app/api/linear/route.ts`;
  `apps/control-panel/src/lib/linear-snapshot.ts`;
  `pkgs/el-control-panel-worker/src/snapshot-workflows.ts`.
- Tools: `cli/el-bot/src/buzz-fleet-bridge.ts`,
  `cli/linear-ledger/src/ledger.ts`, `cli/agent-graph/src/linear-topology.ts`.

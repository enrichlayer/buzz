# DEV-12832 evidence ledger

Observed 2026-10-12. This is an implementation and partial runtime record, not
acceptance of the complete fleet flow.

## Provisioning and source validation

- `cargo test -p buzz-cli agent_enrollment --jobs 2`: 8 passed. Includes partial
  publication recovery, concurrent identity creation, private files, signed
  membership checks and revoked membership after original history is pruned.
  The HTTP test exercises the actual CLI implementation over a local fixture
  relay. It is not a production agent test.
- `cargo build -p buzz-cli --jobs 2`: passed.
- After preserving the original display name on runtime reuse, `cargo fmt
  --all --check`, all 502 `buzz-cli` library tests, and `cargo build -p buzz-cli`
  passed. These are CLI checks; repository-wide CI remains pending.
- Factory workspace `5d4a3a229378d00d8f473625c15554bf49e9aa6637545d8fea4851ca3f68366b`
  at Tools base `2eee0fc626b2088dcee90073eefed0f84681bdb0`: dependency build passed.
- In that workspace, `pnpm --filter @el/tools-factory-worker exec vitest run
  src/buzz-runtime-enrollment.test.ts src/autopilot/pi-author.test.ts`: 32 passed.
- In that workspace, `pnpm --filter @el/tools-factory-worker exec tsc --noEmit
  -p tsconfig.json`: passed (`meta.exitCode: 0`).
- Factory tests cover the actual Pi author entry point, pre-spawn enrollment
  failure, scoped credential injection, and the CLI subprocess boundary. Their
  provider spawners and enrollment CLI are fixtures, not live Factory runs.
- The common enrollment helper has since moved into `el-telemetry`, and local
  enrollment now follows an accepted presence heartbeat. Its latest focused
  suite has 38 passing tests, including native Claude/Codex/Pi identity
  resolution. The telemetry build passed. The relocated Pi author suite has
  22 passing tests; Herdr credential/supervisor tests have 39 passing tests.
  Full package typechecks passed for el-git, Factory worker and Computer
  workspace. The initial scoped formatting report was incomplete: CI later
  found formatting errors in the Computer, worker and el-git packages. The
  checkpoint below corrects those errors and reruns each exact package lint.
- Author-agent review found a journal replay scope defect: ownership/signature
  checks did not bind the stored command's channel and target. The fix checks
  exact provisioning kinds/tags and has a regression against a differently
  scoped, valid owner-signed event. All 503 CLI library tests and the CLI build
  passed after the repair.
- `just ci` was started. Workspace clippy and desktop frontend checks passed
  before the task's remaining CI process was stopped during Tauri clippy to
  avoid exhausting the laptop disk (4.6 GiB free). Only this task's disposable
  Tauri target cache was removed; free space then measured 5.4 GiB. Full CI is
  incomplete, and no pass is inferred for its remaining lanes.

## Real local enrollment

The enrollment command used the native `CODEX_THREAD_ID` of the implementing
Codex session. It minted an agent identity under the existing Orchestrator
owner and verified the relay-signed membership snapshot. An independent read
using the previously installed Buzz CLI and only the new agent credential
confirmed its profile and channel membership.

| Field | Value |
|---|---|
| Runtime | `01a12f38-bcd6-7560-ac93-c4c395e31212` |
| Agent pubkey | `3bb9df659695d52cb5689d64b1d6c730f02d00ee9980c4b013234b5c6d98e423` |
| Owner pubkey | `6016de04433e9d99a36370d0f97c0ae070e93faa22159bc28fc057c00976bbb6` |
| Channel | `134f0c59-68f7-45bb-a7d8-2bb5fe7026ed` (`factory-orchestrator`) |
| Profile event | `8e35f72bd8b7e2d52b0727438524c42c5310d35200bc5213acfe73d2a4f18bbc` |
| Directory event | `169275f3f3def8b229c5df85c189c3382c35fc015d76d3c590eb532e9ee455e1` |
| Membership command | `e44b981b5a3c160de2783d971e9aaad677b2eb5ef12d6e5bbaed051c96519993` |

This invocation proves live provisioning for a real session. It does not prove
automatic native-hook enrollment, presence, incoming message delivery, a peer
action, or restart recovery in production.

### Telemetry lifecycle and outbound message

The remotely built telemetry candidate subsequently ran `presence ping` under
the same native `CODEX_THREAD_ID`. After the real telemetry endpoint accepted
the heartbeat at `2026-10-12T10:26:29.714Z`, it automatically reused the same
Buzz identity and recorded enrollment at `2026-10-12T10:26:33.727Z`. The
independently installed `el-telemetry presence ls --format summary` showed one
active Codex session on DEV-12832 in the owned Buzz worktree.

Using the candidate's `buzz exec` adapter, this runtime published event
`b13ca821d683e1cf5b80cbc73216d017775caab49fa109c01a073494fd82641a` in
`factory-orchestrator`. A separate read through the previously installed Buzz
CLI returned that event under the enrolled pubkey. An independent `nostr-tools/pure` verification confirmed its canonical ID,
Schnorr signature, expected author and channel. A freshly parsed copy with altered
content was rejected. The public receipt is in
[fleet-local-signature-proof.json](fleet-local-signature-proof.json).
This verifies the retrieved local event; the accepted production transport
and remote consumption still require their own runtime receipts.

This proves automatic enrollment following a real presence heartbeat and an
outbound message from the local agent. It is a scoped compiled-candidate run,
not a managed Tools release or a newly observed native SessionStart hook. No
remote peer response is included in this receipt.

The independently queried profile `nico` has pubkey
`2426e90807d1652f60febea5042bc2ba18899e12fbc439d8a7e5429354e6287c`, already a
member of this channel. No Nico-authored acceptance request has been observed.

## Open acceptance work

### Tools checkpoint 2, 2026-10-12 11:47 UTC

Draft [Tools !7600](https://gitlab.com/vertical-int/tools/-/merge_requests/7600)
has a new accepted Factory checkpoint at
`7d4098c1452a8ebbf1f4286f93f112c5877e67f8` (pushed and independently verified by the Factory publisher).
Pipeline [2938522022](https://gitlab.com/vertical-int/tools/-/pipelines/2938522022)
failed the remaining Computer rollout-contract and generated CLI-index checks.
Worker checks, all four worker test shards, MCP bootstrap tests and the actual
foundation/application image build passed. Full CI has not passed.
It adds explicitly addressed, verified Buzz context to the existing Pi RPC
mailbox. Pending messages are saved before delivery; only Pi's durable
transcript confirms consumption. A queued-only acknowledgement remains
retryable and does not emit a durable delivery receipt. JSON-escaped content
is bounded before persistence, with a restart regression.

Validation: 59 Pi/RPC tests, worker typecheck, 58 Computer tests, Computer
typecheck, all three affected package lint commands, the el-git build and four
real MCP bootstrap tests passed in the owned Factory workspace. Commit secret
scans and checkpoint debt guards passed. These tests use simulated Pi provider
processes; they are not live Herdr-based Factory Pi evidence.

The initial CI pipeline failed on package formatting, a missing `attach-buzz.ts`
entry in the foundation application's build-context inventory, and one MCP
handshake timeout. Formatting and the file inventory are fixed. The handshake
passed on focused rerun in 6.2 seconds and the next full CI run. The real Docker
image build also passed. The remaining omissions were the new container input
in rollout classification, both CI predicates, protocol digest and the test
inventory, plus stale CLI discovery data. Repair commit
`d414a380c8b1ba3ac2ddb6db71cf29fa4fd69e16` passes 368 deployment/attach tests,
the complete canonical artifact build and the generated CLI-index check
(49 programs, 898 commands). Its six-file diff and commit secret scan pass.
Checkpoint 3 accepted the exact repair commit with passing debt guards. Factory
pushed and verified its landed SHA. Full current-head pipeline
[2938736717](https://gitlab.com/vertical-int/tools/-/pipelines/2938736717) passed.
The current MR head remains `d414a380c8b1ba3ac2ddb6db71cf29fa4fd69e16`,
with no merge conflicts; the draft is not merged or deployed.

Two native Buzz pre-push attempts exhausted safe laptop build capacity and
were stopped. Neither completed a push. Only this task's disposable build
caches were removed, and the verified CLI was preserved. DEV-12632 has admitted
Buzz MR validation, but mutable GitHub workspace authoring remains unsupported;
this does not yet provide a publication path for the unpushed CLI branch.
The user directed the agent to run the requested CLI replay. It passed with
`enrollment_verified: true`, the same identity and all three original event IDs.
This is agent-executed verification, not a claim that the human ran the command.
The user will not be asked to repeat that check.

The first workspace generation was suspended at checkpoint 2. Factory verified
its named sandbox was destroyed and no longer assigned or running. Generation 2
is now suspended at checkpoint 3 after those repairs were pushed. Factory
physically verified its named sandbox destroyed, not assigned and not running. After the user unlocked the Mac, native Buzz Dev showed the exact agent
profile, runtime description, membership activity and original outbound event
`b13ca821d683e1cf5b80cbc73216d017775caab49fa109c01a073494fd82641a`.
The profile was offline and its thread had no replies. The empty Channels tab
was consistent with viewer-scoped discovery: the signed-in viewer had not
joined factory-orchestrator. No membership was changed for this check.
See [the replay and UI receipt](fleet-enrollment-replay-proof.json).

| Item | Owner and next action | State |
|---|---|---|
| CLI prerequisite review and CI | DEV-12836: publish the reviewed draft and complete required CI | 503 CLI tests pass; requested agent replay and native profile check pass; full Buzz CI remains incomplete at 1.0 GiB free disk |
| Local and Herdr automatic lifecycle enrollment | DEV-12832: wire and exercise actual launch/attach paths | Pending |
| Factory Pi runtime | DEV-12832: reviewed worker integration with an enrollment-capable immutable CLI, then actual task-loop run and receipt | Source tested; deployment and live run pending |
| Verified production transport | DEV-12830 existing owner: accepted CLI/image and configuration through normal deployment gates | Peer-owned rollout pending; PR #4 remains open with failed CI, Tools !7590 remains draft with passing CI |
| Orchestrator signing-key isolation | DEV-12830 existing owner is repairing model subprocess inheritance before enabling the feed; reconcile delegated runtime injection against that repair before rollout | Active peer repair |
| Four shared Tools roles | DEV-12832: Factory-owned inbound request execution and same-thread replies | Pending |
| Three-way coordination | DEV-12832: signed request/receipt/action/reply correlation for all three cohorts | Pending |
| Nico with laptop agents stopped | DEV-12832 plus Nico's own authenticated action once ready; record stopped runtimes and useful same-thread result | Pending |
| Restart continuity and duplicate requests | DEV-12832: live restart and replay after all runtime paths are active | Pending |
| AgentGraph lifecycle projection | DEV-12832: local outbox now has zero files; verify the server-side projection independently | Readback pending |

The existing four laptop-hosted Tools identities have not been archived or
deleted by this work. No production worker deployment, full repository CI,
human testing, or three-runtime acceptance is claimed.


### Publication continuation

The user authorized removal of the inactive
`~/.cache/buzz-version-build/native-target` cache through the linked visibility
chat. A fresh `lsof +D` found no open files before deletion. The deletion receipt
recorded 1,000,783,872 physical bytes reclaimed and 17,624,150,016 bytes available;
other concurrent disk changes are not attributed to this cleanup.

The compact full `just ci` run began with two Cargo jobs, debug information and
incremental output disabled. It was interrupted during workspace Clippy to
serialize work with the transport browser repair. Its build cache is retained;
this is an incomplete check, not a pass.

PR #4 CI repair now has an isolated worktree. Thirteen affected transcript
captures pass after reusing its existing unpublished capture-mode correction.
Seven retained-composer regressions reproduced; the thread-keyed activity
provider remount is being repaired without weakening those assertions. Hosted
CI and publication remain pending.

The current Factory source contract accepts only Claude/Codex for Herdr attach,
while its task-loop Pi lane launches the Pi binary directly. The Herdr-based Pi
runtime requested by the user still needs a verified launch path; the raw Pi
RPC tests do not satisfy that provenance requirement.

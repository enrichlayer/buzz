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
  workspace. Scoped Biome formatting/checks passed with optional literal-key
  suggestions.
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
CLI returned that event under the enrolled pubkey. Its canonical content hash
matches its ID and its signature is present; independent signature verification
through the accepted transport remains part of the full acceptance run.

This proves automatic enrollment following a real presence heartbeat and an
outbound message from the local agent. It is a scoped compiled-candidate run,
not a managed Tools release or a newly observed native SessionStart hook. No
remote peer response is included in this receipt.

The independently queried profile `nico` has pubkey
`2426e90807d1652f60febea5042bc2ba18899e12fbc439d8a7e5429354e6287c`, already a
member of this channel. No Nico-authored acceptance request has been observed.

## Open acceptance work

| Item | Owner and next action | State |
|---|---|---|
| CLI prerequisite review and CI | DEV-12836: publish the reviewed draft, obtain explicit human command verification and complete required CI | 503 CLI tests pass; full CI and human confirmation pending |
| Local and Herdr automatic lifecycle enrollment | DEV-12832: wire and exercise actual launch/attach paths | Pending |
| Factory Pi runtime | DEV-12832: reviewed worker integration with an enrollment-capable immutable CLI, then actual task-loop run and receipt | Source tested; deployment and live run pending |
| Verified production transport | DEV-12830 existing owner: accepted CLI/image and configuration through normal deployment gates | Peer-owned rollout pending |
| Orchestrator signing-key isolation | DEV-12830 existing owner is repairing model subprocess inheritance before enabling the feed; reconcile delegated runtime injection against that repair before rollout | Active peer repair |
| Four shared Tools roles | DEV-12832: Factory-owned inbound request execution and same-thread replies | Pending |
| Three-way coordination | DEV-12832: signed request/receipt/action/reply correlation for all three cohorts | Pending |
| Nico with laptop agents stopped | DEV-12832 plus Nico's own authenticated action once ready; record stopped runtimes and useful same-thread result | Pending |
| Restart continuity and duplicate requests | DEV-12832: live restart and replay after all runtime paths are active | Pending |
| AgentGraph lifecycle projection | Existing durable replay retained the failed append; SSH master check succeeded; verify queue drain | Pending |

The existing four laptop-hosted Tools identities have not been archived or
deleted by this work. No production worker deployment, full repository CI,
human testing, or three-runtime acceptance is claimed.

# Steering improvements validation — October 13, 2026

Initial validation base: `b76fa2102cc9acd01ac1a059f05eae855b3489d5`, isolated
`agent-steering-regression` worktree. The first table records that snapshot;
PR-base validation is recorded separately below.

| Check | Actual result |
| --- | --- |
| Desktop unit phase | 6,882 passed, 0 failed |
| Initial parallel DOM phase | 138 passed, 16 failed, all in admin-console actions |
| Admin-console file with unchanged persona component | 25 passed, 0 failed |
| Full DOM phase with concurrency 1, changed component restored | 154 passed, 0 failed |
| Desktop typecheck | Exit 0 |
| Production persona component server render | Guidance and accessible description assertions passed |
| Persona-editor Playwright flow in installed Chrome | 1 passed; checks rendered guidance and aria-describedby |
| Deterministic adapter protocol | Initialize, held prompt, steering acknowledgement, release and exit 0 passed |
| Python Ruff and syntax | Passed |
| Diff whitespace check | Passed |
| New packaged real-relay rerun | Both filtering modes passed; runner exit 0; both harnesses and successful relay exit 0 |
| Signed event verification | Four readbacks passed canonical ID and independent BIP340 Schnorr checks |
| Fixture cleanup | containers_removed true, errors empty; subsequent Docker listing found no fixture containers |

The E2E frontend was built in E2E mode. Its final build reported success; the
wrapper process was interrupted after that build, so its process exit 143 is
not represented as a successful command exit. The subsequent browser check
used the generated artifact on a separate preview port. The default Playwright
Chromium revision was missing; installed Chrome was used with a fresh profile.

## Dispositions

- UI guidance: implemented beside Conversation context, qualified as default
  channel behavior and connected to the control's accessible description.
  Browser and server-render checks passed. Owner: this change; no next repair.
- Regression fixture: stored in the repository, with explicit prerequisites,
  signed readbacks, captured real subscriptions and adapter input, bounded waits,
  cleanup and response-duration recording. Static and adapter checks passed.
  Live packaged run passed in both modes using freshly built local binaries.
  Owner: this change; no next repair.
- Reaction diagnostics: investigation found accepted server receipts for every
  captured reaction. Three followed the local timeout diagnostics. Evidence is
  preserved in `agent-steering-reaction-receipts.json`; no speculative retry or
  timeout change was made. If further work is needed, the ACP reaction owner
  should compare direct and proxied request duration and signed readbacks.
- Parallel DOM failures: not reproduced in the unchanged isolated baseline or
  the serial full DOM suite. Cause remains unknown. Proposed owner: desktop
  admin-console test maintenance; next diagnostic is a controlled parallel
  reproduction, outside this agent-steering change.
- OrbStack: initial startup attempts failed with `vmrpc: EOF`; local VM logs
  reported `scon host bridge failed: vmnet start timed out`, followed by a
  signal-11 VM-manager exit. Quitting and reopening the application restored
  `orb status` to Running and Docker server 29.8.2 responded. No network
  settings or VM data were reset. The underlying startup failure cause remains
  unknown. Owner: this run; recovery and packaged regression are complete.
- Runner compatibility: the first packaged attempt exposed `datetime.UTC` on
  Python 3.10. Restored `datetime.timezone.utc` and `asyncio.TimeoutError`, and
  added a bounded HTTP timeout. Python 3.10 syntax, timeout-contract and Ruff
  checks passed. Owner: this change; no next repair.
- Build prerequisites: the earlier experiment binaries were absent. An offline
  build failed because the pinned rust-s3 source was not cached. A normal
  current-source build with dependency fetching completed with exit 0; no source
  or lockfile workaround was applied.

No routing behavior, author admission, or idle-session wake policy was changed.

## Packaged live run

Evidence: `test-results/agent-steering/RUN_20261013T110133_879526/`.
See its `DELIVERY_TRACE.md`, `transport.jsonl`, both adapter JSONL files,
both signed-event JSON files and `SIGNATURE_CHECK.txt`.

Command: `/Users/ytspar/miniconda3/bin/python3 scripts/test-agent-steering.py`.
Binaries were built from the base HEAD with
`cargo build -p buzz-relay -p buzz-acp -p buzz-cli -j 2` (exit 0).
The transport records the SHA-256 of all three binaries. Runner SHA-256:
`6469ba6d6dd72625781061ceab671194b1842ed3bfcd0970aa575e8e0ac5579c`.

| Mode | Plain relay EVENT / adapter steering | Mention relay EVENT / adapter steering |
| --- | --- | --- |
| Default mentions | 0 / 0 | 1 / 1 |
| Mention filter disabled | 1 / 1 | 1 / 1 |

All four probes were accepted and read back with signatures from the real relay.
Default channel REQ carried both `#h` and `#p`; disabled mode carried `#h`
without `#p`. Membership notification subscriptions retained their own `#p`
in both modes. Each case held a real adapter prompt active until its assertions
completed, and harness logs recorded successful steering acknowledgements.
This proves the tested admission/delivery path, not historical deployed
configuration or a real LLM's response to steering.

Earlier packaged attempts failed: Python 3.10 UTC compatibility; absent prior
binaries; a 30-second Docker startup deadline; PostgreSQL initialization beyond
90 seconds; and relay startup pool acquisition timeout. Their evidence remains
in separate run folders. The runner now records readiness and interrupted
commands, uses bounded longer fixture deadlines and a 512 MiB ephemeral
PostgreSQL tmpfs, and permits at most three relay startup attempts only for the
observed pool timeout. In the successful run, startup attempt 1 failed with that
error and attempt 2 passed. Production database timeouts and relay conformance
checks remain unchanged. Cleanup succeeded for the failed container runs and
the successful run.

## PR preparation snapshot

The steering-only change was moved onto fork main
`bdb04759ebfdd3d90620945bc88d8985b1b66dd6`, excluding unrelated ancestry.
Review findings and their dispositions are in [agent-steering-review.md](agent-steering-review.md).
Exact manual steps are in [agent-steering-human-testing.md](agent-steering-human-testing.md).

- Typecheck: exit 0.
- Desktop lint/text-size/pubkey checks: exit 0; two warnings in unchanged files.
  The first lint attempt found an unformatted temporary Playwright config;
  formatting it resolved the error. That temporary file was removed.
- File-size gates: exit 0, including all 10 policy tests.
- Fresh E2E frontend build: exit 0; persona-editor test in installed Chrome:
  one test passed, including rendered guidance and accessible description.
- Full desktop package suite on the PR base: 6,877 unit tests and 160 DOM
  tests passed, zero failures, command exit 0. The historical parallel DOM
  failures did not recur in this run.
- Stricter packaged relay fixture: both modes passed, runner exit 0; both
  harnesses and relay exit 0; startup attempt 1 succeeded; cleanup succeeded
  and a subsequent Docker listing found no fixture containers.
- Four fresh signed readbacks passed independent `nostr-tools` signature and
  canonical-ID checks. Complete committed raw evidence, exact filters and
  adapter traffic: [delivery trace](evidence/agent-steering/2026-10-13/DELIVERY_TRACE.md).
- Full repository check was still running at this snapshot. It was restarted
  with two Cargo jobs after stopping only this task's initially unbounded
  dispatcher; no check was bypassed. Publication-time status belongs in the PR.
- Human testing: pending explicit confirmation; draft publication only.

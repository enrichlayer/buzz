# Native command, permission and fallback validation

2026-10-09. Validated locally on codex/DEV-11526-buzz-output-modes before publication. Native app and runner rebuilt; Keychain startup resolved. CI, review, merge and deployment are separate from these checks.

| Finding | Disposition and evidence | Owner / next action | Result |
|---|---|---|---|
| Permission decisions and terminal launcher | Real Claude waited for Allow once; probe file absent before approval and present after. Subsequent request denied. Terminal opened at agent cwd without executing a command. | This task: complete | Native Computer Use; 20 Rust permission and earlier 8 browser tests |
| Manual terminal result | Actual readback command, output and exit 0 posted through the form. Human attribution and changed-command disclosure visible. | This task: implemented. Agent continuation pending behind a separate annotation permission request. | Native Result shared and human receipt verified; continuation not claimed |
| Direct !command | Signed owner intent executes before model session; actual output becomes next-turn context | This task: complete | Native Claude and Codex both named exact stdout, trailing newline and exit 0 without rerunning |
| Nonzero exit, Stop, replay and bounds | Durable claims and receipts; process-group cancellation; bounded output/deadline; signature/recipient/channel validation | This task: complete | Native exit 7, Stop on sleep, app restart retention; 4 Rust shell tests |
| Nested direct-command result | Result now uses canonical thread root | This task: fixed | Native Codex integrated result visible |
| False completion and overwritten permissions | Partial updates retain pending state; unfinished publication remains an action; permission correlation scoped by worker/session/turn and request | This task: fixed | 85 focused command/transcript/summary tests pass, including concurrent ID reuse |
| Invisible effective policy | Render runner-observed adapter mode | This task: complete | Native Claude adapter-default and Codex adapter-agent labels visible |
| Claude weekly quota stopped coding task | Manually handed identical bounded task to Codex | This task: fallback complete | Codex added only shellCommand.acceptance.test.mjs; its 2 cases pass independently |
| Automatic account fallback | Tools documents shared fallback seats; Buzz exposes a trusted launch-prefix seam. Automatic selection was not established here. | Host-launcher integration: proposed next work; no credentials changed | Unknown; do not claim automatic failover |
| HMR unavailable editor focus | Initialization/destruction guard; reload restored view | This task: guarded | Subsequent native navigation, typing and send passed; no stress-test claim |
| Browser test used production build without mock bridge | Rebuild in e2e mode | This task: corrected setup | Final report /tmp/buzz-manual-result-browser-final.json; initial timeout was setup failure |

TypeScript and production frontend build passed. Plugin schema/store: 13 passed. Transcript reducer: 1,000 events / 500 items in 16 ms on this host; not a rendered scrolling benchmark. Large-chunk build warning is an optimization observation.

Logs: /tmp/buzz-shell-final-regression.log, /tmp/buzz-shell-rust-final.log, /tmp/buzz-shell-ts-complete.log, /tmp/buzz-shell-frontend-build.log, /tmp/buzz-plugin-regression.log, /tmp/buzz-transcript-benchmark.log.

Native screenshots: /tmp/buzz-permission-terminal-live.png, /tmp/buzz-bang-claude-context-live.png, /tmp/buzz-bang-failure-live.png, /tmp/buzz-bang-stop-live.png, /tmp/buzz-codex-fallback-complete.png, /tmp/buzz-codex-bash-context-complete.png, /tmp/buzz-manual-terminal-result-shared.png.

Unchanged plugin hot-update proof: docs/plans/agent-session-validation.md. Existing fleet adapter/hook proof: dashboard steps 4–7 and /tmp/buzz-native-hook-proof/receipt.md. These later receipts supersede older pending notes in docs/plans/agent-fleet-transport-validation.md. No fresh fleet deployment or merge status is claimed.

Final browser manual-result regression: expected=1, unexpected=0, flaky=0. The initial assertion required opening the new reply thread before checking its body; corrected. Rust formatting and git diff --check pass. Scoped typography/design decisions: docs/plans/direct-command-design-validation.md.

Publication preflight caught and repaired two regression-suite integration gaps: the isolated send-flow harness did not import the new shell-command parser, and three activity-headline assertions still expected the previous publication label. The harness now uses the real parser, and the assertions cover the intended “Posting reply” receipt. All 87 targeted presentation, draft-authority and cancellation tests pass with the repository test loader. An initial ad-hoc invocation omitted that loader and failed module resolution; it is not a product failure. The new permission-policy component's optional-chain lint advisory was also resolved. The full native pre-push hooks must pass before publication; their receipt is recorded in the PR.

The first full pre-push Rust run completed 83/84 steps; the `cargo test -p buzz-dev-mcp` process crashed with signal 11 after compilation and before a test-run banner. An unchanged isolated rerun passed (78 unit and 2 integration tests, plus doc tests). This is a non-reproduced execution failure, not a claim that the initial gate passed; the complete push gate is rerun. Receipt: `/tmp/buzz-dev-mcp-publish-retry.log`.

The second full push attempt passed frontend and native desktop gates and the MCP step, but the ACP keepalive fixture failed once under concurrent load (354 ms elapsed) and passed on its second invocation. Its 50 ms emission interval previously had only a 100 ms idle budget. The fixture now allows 1 s idle and requires at least 1.5 s survival, so removing keepalive resets still fails while subprocess scheduling has headroom. The targeted test passed in 2.2 s. Production timeout logic is unchanged; the complete gate is rerun. Receipt: `/tmp/buzz-keepalive-publish-repair.log`.

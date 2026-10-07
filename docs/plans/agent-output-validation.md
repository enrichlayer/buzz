# DEV-11526 validation record

Worktree: `buzz-session-plugins`, branch `codex/DEV-11526-buzz-output-modes`,
based on `c70c1a28fd9934641afff5a72518def5fbf5d72b`.

## Completed checks

- 51 focused frontend tests: configuration submission, edit/copy/catalog
  propagation, Tauri mapping, session projection, summary attention filtering,
  legacy defaults, and immutable detail display.
- TypeScript check and `build:e2e` passed.
- Authored patch and new files passed a Gitleaks scan with default detection
  rules enabled. Three full-file matches were unchanged baseline test fixtures
  in sample-agent, hostile-event, and shared launch-fixture tests; none was
  introduced by this change.
- Final combined Playwright run passed all eight cases in 48.1 seconds: three
  output-mode cases (attention visibility/detail toggle, decorated legacy full,
  persona save/reopen) and five question-card cases (keyboard submission, answer
  races, live remote answer, malformed fallback, and cancellation).
- Seven runner output-mode tests passed.
- All local CI stages are covered by the broad run and affected reruns below.
  Infrastructure/credential-dependent ignored tests remain excluded. The final
  fix diff also passed Gitleaks with default rules and `git diff --check`.
- Seven native output-mode tests and one behavior-request publication test passed.
- Independent backend review found no actionable defect in persistence,
  snapshots/catalog propagation, restart comparison, local/provider environment
  authority, shared prompt assembly, or retained observer emission.
- Rebuilt native desktop and runner binaries, installed them into Buzz Dev, and
  relaunched the app through Computer Use. Summary saved, survived reopening the
  editor, and correctly required an agent restart.
- Live native Summary test in `agent-question-test`, thread
  `016114a4750bd027367bce464c9a32ffb969f94d7d0f3da5f2efd85008468b30`:
  AskUserQuestion remained visible; OAuth plus Web, Mobile, and Other: Desktop
  submitted with Command-Enter; the card showed Answered by You and the agent
  confirmed all choices. Show details revealed retained expandable tool calls;
  Show summary returned to eight routine updates hidden.

## Defect and validation ledger

| Item | Disposition and evidence | Owner / next action |
| --- | --- | --- |
| Browser assertions used raw tool titles | Fixed to assert semantic displayed output; two cases passed | Closed |
| New test absent from smoke allowlist | Registered in Playwright config; both cases executed | Closed |
| Tool-classified permission/error could be hidden without failure flags | Filter retains attention classes regardless of item type; regression passed | Closed |
| Native Computer Use initially returned app-server exit | Reconnected via explicit `.app` path; native UI inspected | Closed |
| Native test compile required sidecars | Copied existing real sidecars; rebuilt runner and native desktop passed and were installed | Closed |
| File-size ratchet reports two existing oversized Rust fixture files grew | Fixed by removing redundant fixture comments; all surface ratchets and 10 policy tests passed | Closed |
| Additional checks refused during critical host memory pressure | Later admitted; file-size checks, final frontend build, and combined browser suite passed without bypass | Closed |
| Playwright wrapper expected a Vitest summary for the third case | Re-ran through direct Playwright binary; all eight tests and managed wrapper passed | Workflow resolved; classifier repair tracked as DEV-11549 (Tools, Todo, assigned Yury; unattended authoring intake next) |
| Native save, restart, and summary interaction | Passed in rebuilt Buzz Dev through Computer Use, including answered card, confirmation, and detail toggle | Closed |
| Provider launch helper exceeded Clippy argument limit | Grouped session/output in typed AcpLaunchPolicies; default and mesh-llm native Clippy passed, then seven output-mode and one behavior-publication test passed | Closed |
| Full repository CI stages | Retry passed repository formatting/lint/static checks, 84 Rust suites, 6,853 desktop Node tests, 144 mounted tests, protected-feature build matrix, and web build. Native library finished 3,420 passed / 3 failed / 19 ignored; the three stale expectations below were repaired and passed their exact reruns. Remaining native targets passed (terminal 91, CSP 7, mixer 3; release-only terminal test ignored). Mobile passed 2,785 tests / 4 skipped plus 3 unconfigured-build cases; recipe checks passed 5/5 | Complete through component receipts after the failed run; not a claim that the original just ci exited successfully. Unchanged passing stages reused |
| Native expectations omitted output mode | Updated strict serialized-field mutation matrix, exact catalog IPC publication for Full/Summary, and shared provider launch fixture. All three formerly failing native tests passed; shared backend fixture consumer passed 4/4; rustfmt passed | Closed |
| Pre-push recovery test | Fixed fixture CPU sensitivity: serialize a single 16 MiB string instead of eight million integers within the outer 15-second watchdog. Real stalled socket, production 10-second timeout, loss retention and retry pacing are unchanged. Exact test passed four runs (10.49–10.58 seconds); rustfmt passed | Closed; normal pre-push retry passed all application lanes at 17eb517, including 3,423 native library tests / 19 ignored. Shared timing repair remains owned by DEV-11618. |
| GitHub fork image builds | Public gateway and relay cache guards treated same-fork PRs as authorized to export upstream Block GHCR cache. Registry rejected the writes. Added canonical-owner guard for fixed gateway cache and canonical-owner-or-explicit-image guard for relay cache; all builds and read-only cache use remain. actionlint, relay workflow contract and event/override truth tables passed | Closed; both relay architectures and both gateway architectures passed on published d37cef4. |
| Summary toggle retained Commands/Mode from previous harness sessions | Fixed duplicate React turn keys by including the stable session-run anchor. 58 focused unit tests, TypeScript/build:e2e and 3 browser tests passed. Parent independently toggled native Full → Summary: metadata appeared only in Full, while Answered by You and OAuth / Web / Mobile / Desktop remained visible | Closed |
| Native commit hooks | bd05340 created with DCO signoff; Rust/Tauri formatting, Biome, and commit-msg hooks passed with no source auto-fixes | Closed |
| Human acceptance | Pending | Maintainer follows agent-output-modes.md before PR readiness |

Fleet bridge and peer-context implementation are separate Tools work in the
owned Factory workspace `3419e185b8fe232d5ce5bb9bfd9cd2dc844bd5050be9c5025a648d5d8760a675`.
DEV-10851 and DEV-10852 remain in progress; these frontend receipts do not
establish live fleet delivery, deployment, or shared-context acceptance.

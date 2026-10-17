# Segmented choices in plugins and agent settings

Tracking: [DEV-12463](https://linear.app/verticalint/issue/DEV-12463/)

The implementation is isolated on `codex/DEV-12463-segmented-choices`, based on
`5ae03ed` from the existing output-mode branch. It does not include the separate
floating-annotation, version, or updater changes.

## Behavior

- Plugin select fields opt in with `presentation: "segmented"`. Legacy manifests
  and explicit `dropdown` fields retain their current appearance. The review-card
  example now opts in for Approve / Needs changes.
- Conversation context, Agent output, and Who can send instructions use the same
  segmented button style as the transcript view selector when their labels fit.
- Both effort field implementations keep the complete option set and permit up
  to four choices, including inherited/default and unavailable values. Larger or
  wider sets retain their existing dropdown.
- Selection preserves exact values and existing state/save handlers. Choosing a
  plugin option does not copy, compose, or send. Arrow keys and Home/End select
  enabled options; resizing retains the value and keyboard focus.
- Models, providers, harnesses, destinations, questions, and permission actions
  retain their existing controls.

## Validation

- 57 focused tests passed: plugin parsing/rendering/storage, shared choice
  behavior, instruction-access contract, effort capability/default conversion,
  and the existing instance Save/Cancel behavior tests.
- After adding focus retention, all four adaptive-control tests passed again.
- Package-local Biome check passed for all 15 changed/new code and test files.
- Full `pnpm build:e2e` passed, including TypeScript and the Vite build.
- All seven Chromium browser scenarios passed together again on October 10
  after adding the required animation waits before screenshots.
- Browser checks cover installation/update/disable/removal, keyboard selection,
  explicit composition without sending, narrow-width fallback, 200% root text
  size without card overflow, and saving/reopening output, conversation context,
  and instruction audience. Existing transcript, question, and permission checks
  also pass. The agent browser test checks the audience warnings before saving
  Only me.
- `git diff --check` passed.

All heavy commands ran through `el-deck resource run` from the desktop directory.
The browser run used an isolated static server at port 4187 so it did not reuse
another worktree's application. The local rerun configuration is retained under
`desktop/test-results/segmented-playwright.config.ts`.

Local screenshots inspected (generated artifacts, not repository files):

- `desktop/test-results/segmented-choices/agent-settings.png`
- `desktop/test-results/runtime-session-plugins/installed.png`

The 200% test establishes overflow and value retention with DOM assertions; its
full-card screenshot is clipped by the app's thread scroll viewport and is not
used as visual approval evidence.

The browser suite uses the repository's E2E IPC bridge and representative data.
It can establish rendered interaction and payload behavior, not live relay or
native-agent execution. No native installation, release or deployment is part
of this change.

## Defect ledger

| Finding | Disposition and evidence | Owner / next action | Validation |
|---|---|---|---|
| Effort dropdown labels are typed as ReactNode | Narrowed this generated, string-only option list for the shared selector | DEV-12463 implementation; resolved | TypeScript build passed |
| Keyboard focus could disappear when width changes the control | Restore focus to the selected button or fallback dropdown without changing the value | DEV-12463 implementation | Resize/value/focus test passed |
| Focus restoration initially matched the first button | Prefer the selected button before considering a fallback focus target | DEV-12463 implementation | Focus test passed |
| Initial formatter invocation encountered nested root configs | Ran checks from the desktop package directory | This session, resolved | Package-local Biome check passed |
| Plugin action and long text overflow at 200% text size | Allow wrapping within the card and constrain controls to its width | DEV-12463 implementation; resolved | Final plugin browser suite passed all 3 scenarios |
| Host storage exhausted during final validation | Source and dependencies are on BuzzBuild; guarded cache cleanup reclaimed 2.5 GB with no worktree deletion | This session; interrupted checks retried after checking capacity | Build and browser retry passed; ENOSPC attempts are not counted as passes |
| Pre-publication Rust checks approached build-volume capacity | Stopped this task's CI/push runners before exhaustion; replace this run's cold compiler outputs with private copy-on-write clones of the existing Buzz caches | DEV-12463 publication session; rerun normal checks and hooks | Interrupted runs are not passes; final outcomes belong in the PR |

## Publication review

The change is stacked on open PR #4 (`codex/DEV-11526-buzz-output-modes`) so its
diff contains only DEV-12463. Review against the product vision and the repository
review rules found no remaining concrete blockers in the selector change.
Minimalism, elegance and correctness: 9/10 each. The change preserves the runtime
catalog authority, saved values, explicit submission and access-policy handlers.

The pre-PR `just ci` run and commit/push hooks are recorded in the PR with their
actual outcomes. Human testing has not been confirmed; the PR must remain draft
and must not carry the completed-review attestation. No native installation or
release is implied. DEV-12463 remains In Progress through publication and review.

Human verification: in the changed build, edit an agent's Advanced settings,
choose Each thread and Summary, save, then reopen and verify both stay selected.
Try Selected people and Anyone and check their existing access warnings. Install
the updated review-card example, change Decision with arrow keys, narrow its
panel, and confirm the selected value survives the dropdown fallback. Selection
alone must not compose or send; Add to composer should create only a draft.

# Interactive agent threads: validation

Tracking: [DEV-11398](https://linear.app/verticalint/issue/DEV-11398/).
Base: `c950739` on the existing agent-question runner branch. This change is
stacked on that work; it does not attest the earlier PRs as merged.

## Native app evidence

Computer Use drove Buzz Dev against the new desktop source and the verticalint
community, in the private `agent-question-test` channel.

- Existing answered and cancelled question cards remained visible.
- The same thread displayed archived ACP activity with collapsed tool rows.
- Installed `test.session-card` version 1.0.0 through Settings > Plugins without
  rebuilding the app. A message using its fence rendered code and an accordion.
- Expanded command details and composed feedback through its form. The text
  appeared in the thread composer without being sent.
- Updated the manifest to 1.1.0 through Settings. The existing message changed
  its heading to “Updated without rebuilding”. The unsent composer draft survived.
- Selected a paragraph in the agent's published reply, opened Comment on selected
  text, and sent an annotation. The resulting reply quoted the selection with
  its source event ID and revision digest. The agent responded in the same
  thread confirming Desktop, Web, Mobile, and OAuth. The unrelated draft remained.

- Switched the test agent to Each thread, asked a new question, and pressed the
  thread's Stop. The card changed to “Question cancelled” and Stop disabled.
  The existing five-second cancellation drain fallback replaced the subprocess;
  a subsequent message received “Recovery confirmed” in the same thread.

These are observations from native Computer Use, not mocked relay assertions.
Browser annotation tests separately inspect the native send-command payload:
recipient, channel, parent, root, immutable quote, source revision, and line range.
Mock mode does not prove real cryptographic signing.

## Validation ledger

| Finding or check | State | Owner and next action |
| --- | --- | --- |
| Scoped cancellation must not stop a sibling thread | Fixed: 43 observer tests, including three scoped cancellation cases; ten acknowledgement tests passed. Native card cancellation and subsequent recovery passed | Parent: complete |
| Annotation model and DOM capture/retry | Model and DOM capture tests plus browser code/prose annotation flow passed | Annotation worker and parent: complete |
| Required checkbox accepted without enforcement | Fixed and independently verified; three renderer tests passed | Runtime plugin worker: complete |
| Stale window overwrites another plugin snapshot | Fixed: Web Locks and durable reread; 13 schema/store tests passed. Native fallback is restricted to the sole main-window writer | Runtime plugin worker: complete |
| Stop exposed for channel-policy and DM scopes | Fixed and independently verified; scope policy tests passed | Session worker: complete |
| Per-agent archive hydration repeats channel work | Fixed and independently verified; shared loader unit coverage and corrected two-agent E2E passed | Parent: complete |
| Long transcript loses its prompt anchor | Fixed: bounded Load older recovery; selector regression passed | Session worker: complete |
| Archive fetch failure is invisible | Fixed: generation-safe inline error and retry; mounted-hook tests passed | Session worker: complete |
| Mixed-thread batch attributed to a single thread | Fixed: mixed turns fail closed; focused regression passed | Session worker: complete |
| TypeScript narrowing in mixed-turn guard | Fixed; final combined build:e2e and TypeScript passed | Parent: complete |
| Combined focused unit suite | 120/120 passed | Parent: complete |
| Combined browser regression | 17/18 passed in combined run; the archive fixture was corrected and passed its focused rerun (all 18 covered) | Parent: complete |
| Renderer and annotation DOM tests | 5/5 passed on final source | Parent: complete |
| Staged secrets | 155 KB scanned with default rules; no leaks; high-entropy synthetic positive control detected | Parent: complete |
| Changed frontend formatting | 44 changed files passed Biome | Parent: complete; runtime E2E spec checked separately |
| ACP lint | Pinned Rust 1.95 clippy for buzz-acp, all targets, passed with warnings denied. An initial retry mixed a Homebrew clippy binary with pinned rustc; correcting PATH resolved it | Parent: complete |
| Native pre-commit hooks | Missing hooks restored with just hooks; rust-fmt and desktop-fix passed, no source changes | Parent: complete |
| Full repository CI | Incomplete: registry HTTP 500s recovered, but host pressure became critical (new jobs refused with exit 75). Parent stopped the owned full compile with SIGTERM; exit 143, result unknown | DEV-11398 / parent: retry full just ci and publication hooks when host admission is healthy |
| Independent review | Non-authored slices reviewed; all reported blockers fixed and verified | Cross-review workers: complete |
| Human testing of new features | Pending | Maintainer: exact steps supplied at draft PR handoff |

No merge, human testing, or release is claimed by this document.

## Human verification in Buzz Dev

1. Open `agent-question-test`, then a Question Test thread. Expand a collapsed
   tool row and confirm its command/output is readable.
2. Select text in an agent reply or code block. Choose **Comment on selected
   text** (or Command/Ctrl+Shift+M), add feedback, and submit. Confirm the quoted
   source and feedback appear in the same thread and reach Question Test.
3. Open **Settings > Plugins**. The live `test.session-card` is installed. Disable
   it, return to its message in the earlier test thread, and confirm readable
   source replaces the card. Re-enable it and confirm the card returns.
4. In the card, enter feedback and choose **Add to composer**. Confirm it fills
   the draft without sending. Preserve or deliberately discard that test draft.
5. Ask Question Test to use AskUserQuestion. Answer once; on another turn choose
   **Stop** and confirm **Question cancelled**. A new prompt must still work.

The repository requires explicit human confirmation before review-ready status
(`AGENTS.md`, Before opening a PR, item 3). This remains unconfirmed.

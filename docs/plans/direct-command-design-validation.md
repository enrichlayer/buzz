# Coding command and permission interaction decisions

The integrated conversation remains primary. Human commands show a Bash-mode hint before sending, then a signed result with host directory, literal command, stdout/stderr and exit status. The next model turn can read the result. Execution does not implicitly start a model turn.

Permission decisions say Approval sent or Denial sent; tool completion is separate. Policy comes from the actual runner session. Manual terminal launch opens only the working directory. Its result form records the command actually run, output and exit status, labels the result as human-reported, and discloses changes from the original request. Native Computer Use verified these controls.

The typography correction follows the prior Impeccable review: transcript body 16/26, captured prose and quotes 15/24, code 14/22, receipts 13/20 at default scale. Scoped tokens derive from `--buzz-type-rem`, retaining font preference and zoom scaling. Ordinary channel preferences remain unchanged. Reading measure stays at 75ch; compact receipts and three-line quote previews remain. The native Codex result and follow-up were visually inspected after the change. Narrow-name wrapping, 200% zoom and screen-reader auditing are not established by this pass.

Status fixes prevent pending updates from saying Ran, prevent unfinished publication from displaying an empty sent message, and keep concurrent permission decisions distinct. Direct-command outcomes appear in the canonical thread.

Claude hit a weekly-limit response during the coding task. A manually selected Codex agent completed the same bounded task and added two acceptance tests, independently verified passing. This establishes manual cross-harness fallback, not automatic account selection. Automatic handoff should name the replacement, preserve context and pending approvals, and avoid replaying side effects.

The disposition ledger and evidence paths are in `docs/plans/command-permission-validation.md`. Prior plugin hot-update and fleet-hook receipts are reused for unchanged behavior only. No fresh merge or deployment claim is made.

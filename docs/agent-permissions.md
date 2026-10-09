# Agent permission cards

The terminal-result form records **Command you ran**, output and exit status.
Edit the command if you ran a narrower or corrected action. The posted message
discloses that change and identifies the output as human-reported. Commands are
bounded to 4,000 UTF-8 bytes and output to 16,000 bytes.

During a channel turn, an ACP `session/request_permission` becomes an inline
permission card in the same thread. This is a built-in specialization of the
`buzz.agent_prompt` artifact plugin. It requires the updated desktop renderer
and `buzz-acp` runner; installing a presentation-only plugin cannot grant access
to a running harness.

## Decisions and manual execution

The card shows the literal command (or complete tool request), working directory,
and **Allow once** / **Deny**. Only the configured agent owner can decide. Allow
once sends the adapter's original `allow_once` option ID; Deny sends its
`reject_once` option ID, or cancellation if that option is absent. Neither button
grants operating-system privileges or supplies missing credentials.

An answered card says **Approval sent** or **Denial sent**. This confirms the
published decision, not successful tool execution; completion belongs in the
transcript. Stop, an abandoned request, or the turn's hard time limit cancels
the pending request. The ordinary idle timeout pauses while waiting for a card.

For a command the human needs to run, expand **Handle this in a terminal**:

1. Deny a still-pending request before running it manually, to avoid duplicates.
2. Copy the command and open a terminal, review it, then execute it yourself.
3. After denying the request, use **Return your terminal result** to enter output
   and an exit status (0–255). **Share result with agent** posts as you in the
   same thread and asks the agent to continue. The receipt explicitly identifies
   human-supplied output; it is not independently verified execution evidence.

**Open local terminal** validates the current workspace owner, that the agent is
managed locally on this device, and that the requested absolute directory exists.
It opens that directory without inserting or executing the proposed command.
The directory comes from the tool request, falling back to the runner's working
directory. It is not a remote terminal or a reconstruction of the harness's shell
environment. Remote agents require a terminal on their own host. The card does
not collect passwords, import shell output automatically, or turn a chat reply
into approval.

## Harness configuration

Cards appear only when the harness actually emits a permission request. Existing
agents keep their configured policy; the runner's historical default is
`BUZZ_ACP_PERMISSION_MODE=bypass-permissions`. Set the agent's environment value
to `default` and restart it to use the harness's normal permission behavior.
The harness can still permit safe tools according to its own settings. Modes
such as `dont-ask` can deny tools without emitting a request. Unattended/local
tasks outside channel conversations retain their existing permission handling.

The session UI displays the policy reported at session creation, or says that
the adapter did not report it. This is runtime evidence rather than a frontend
guess based on the harness name. Permission decisions remain distinct transcript
items even when several requests occur in one turn; partial tool updates retain
their previous status until an actual completion event arrives.

For a command you want to run directly and share with the model, see
[human Bash commands](direct-shell-commands.md).

## Binding and validation

The runner pins the original signed artifact, channel, artifact identifier,
request/session identifiers, tool payload and owner. It accepts only a valid
owner-signed update whose `prev` references that original artifact and whose
request content is unchanged. Answers from other members, altered commands,
stale answers and free-text answers do not authorize execution. A malformed
request, missing owner or second concurrent card is cancelled instead of being
implicitly approved.

Tests cover owner decisions over real ACP stdio with a test relay, cancellation,
tampering, UI state/keyboard access, and literal local-path validation. Browser
preview offers a clearly marked sample permission card; it cannot prove native
terminal behavior or a real harness's continuation.

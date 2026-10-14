# Agent output modes

Tracking: [DEV-11526](https://linear.app/verticalint/issue/DEV-11526/).

An agent definition selects `full` or `summary`, independently of its harness,
model, provider, and execution location. Existing definitions default to `full`.

- **Full output** preserves the harness's available user-visible replies and
  captured activity, using the existing code highlighting and tool disclosure.
- **Summary** asks the harness for concise progress and outcome messages. It
  distinguishes observed evidence from pending or unverified work. The session
  view hides routine tool and progress rows while retaining replies,
  permissions, and failures.
- **Show details** reveals the captured transcript for the current conversation.
  It changes presentation only: it does not save a different agent policy,
  rewrite messages, or discard observer events.

Questions and their answer/cancel cards remain in the normal thread timeline.
The output setting is not an access control: existing observer and channel
permissions still govern access. Existing archive retention and size limits
still apply; selecting full output cannot recover content a harness did not
emit or activity outside retention.

The definition carries the mode through catalog publication, duplication, agent
and team snapshots, adoption, and launch configuration. Native serialization
uses `output_mode`; frontend types use `outputMode`. Missing legacy values mean
full. Malformed supplied native values are rejected. Full defaults are omitted
from portable definition JSON to preserve legacy content hashes.

Launch policy sets `BUZZ_ACP_OUTPUT_MODE` after user environment variables.
The variable is reserved against persona environment overrides. Local and
provider-backed launch use the same effective policy. A changed definition
participates in the existing restart-required comparison. A running process
uses its launch-time instructions until restarted.

The runner layers summary guidance into its shared standing context, including
when a custom base prompt is used or the base prompt is disabled. Full mode
leaves existing prompt bytes unchanged. Neither mode filters observer emission.

## Fleet coordination

Fleet announcements have a separate concise policy. A full-output engineering
agent does not copy its complete session into a common fleet channel.

Tools work is tracked by [DEV-10851](https://linear.app/verticalint/issue/DEV-10851/)
and [DEV-10852](https://linear.app/verticalint/issue/DEV-10852/). The planned bridge
will project existing coordination events into Buzz and route authorized feedback
through the orchestrator. It is not yet validated or deployed. Factory dispatch
claims, run identity, custody, and releases remain
authoritative. A disconnected Buzz client must not free an issue or workspace.

## Human acceptance

1. Edit a local agent definition, expand Advanced, and set **Agent output** to
   **Summary**. Save, reopen, and verify the selection persisted.
2. Restart the agent if its profile requests it. Ask it to inspect something
   and report the result. Verify its reply is concise and the thread offers
   **Show details** when routine activity was captured.
3. Toggle details and summary. Confirm the original tool activity remains
   available, and code is still highlighted.
4. Ask an interactive question and answer it. Confirm the question remains
   actionable in summary mode. A failed tool or turn must remain visible too.
5. Switch to **Full output**, restart if required, and verify the ordinary
   decorated activity view is restored.

Agent-run test receipts and any pending checks are recorded separately. Human
confirmation is required before marking the PR ready under the repository's
contributor rules.

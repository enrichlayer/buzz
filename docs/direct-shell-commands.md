# Human Bash commands in agent threads

Address one agent and begin the message with `!`, for example `!pwd` or
`!cd /path/to/project && git status --short`. A verified agent address chip may
precede the command. The composer shows Bash mode before sending.

The runner executes `/bin/bash -c` directly on the **agent host**, in the
runner's working directory. This does not ask the model to choose or run a tool.
Each command starts a fresh shell: `cd` and exported variables do not persist.
Interactive commands and stdin are unsupported. Commands inherit the runner's
environment and operating-system access; this does not elevate privileges.

The result is a signed thread message containing the command, working directory,
stdout, stderr and exit status. Ask the agent about it in your next message;
ordinary thread context includes the actual result. The direct command does not
automatically spend a model turn. Output is shared with everyone who can read
the thread, so do not print credentials or other secrets.

Stop cancels the command and its process group. A 120-second deadline also
stops descendants that keep output pipes open. Capture is bounded to 4,000 bytes
per stream; truncation is disclosed. Cancellation and timeout receipts currently
report the stop reason rather than partial output. Commands are limited to
16,000 bytes and Unix hosts. `!cancel`, `!rotate` and `!shutdown` retain their
existing session-control meanings.

Execution requires explicit `buzz.shell` version-1 metadata, a valid signature
from the configured owner, one exact agent recipient, and the exact channel.
Unmarked historical chat is never executable. New requests older than ten
minutes are rejected. A durable claim is written before spawning; replay returns
the stored receipt instead of executing again. If the runner died after claiming
but before recording a result, Buzz reports an uncertain outcome and does not
rerun it. Receipts live under `~/.buzz/shell-receipts/<agent>/<event>.json` on the
agent host. Commands queue behind the current turn and cannot become native
model steering input.

The initial implementation requires the updated desktop and runner. Declarative
presentation plugins cannot introduce new host execution privileges.

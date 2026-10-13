# Human testing: channel steering

Human verification is pending. Agent results do not complete this step.
Use a checkout of the PR branch, not an installed app from another revision.

## Real relay and deterministic adapter

Use Python 3.10 or newer. From the repository root:

```sh
. ./bin/activate-hermit
cargo build -p buzz-relay -p buzz-acp -p buzz-cli -j 2
python3 -m venv .scratch/steering-venv
.scratch/steering-venv/bin/python -m pip install -r scripts/agent-steering-requirements.txt
docker version --format '{{.Server.Version}}'
docker pull postgres:17
docker pull redis:7
docker pull --platform linux/amd64 ghcr.io/block/buzz-minio@sha256:71f235d6aa0c39517b9864d8524546607ccdde40b83742e0dd8d4fb52b3be6dd
.scratch/steering-venv/bin/python scripts/test-agent-steering.py
```

The pull commands are prerequisites; the runner itself does not pull images.
Already-cached images may be reused. Keep assertions enabled; do not use `-O`.
The runner creates its own isolated loopback services and uses public fixture
identities, so no production relay credentials are needed.

Working looks like:

1. The command prints an `EVIDENCE_DIR` and two JSON results with `pass: true`,
   then exits 0.
2. `mentions-default` has one initial `session/prompt` and one
   `_session/steering` containing `MENTION_THREAD_PROBE`; no adapter call contains
   `PLAIN_THREAD_PROBE`.
3. `mention-filter-disabled` has one initial prompt and two steering calls,
   first `PLAIN_THREAD_PROBE`, then `MENTION_THREAD_PROBE`, in the same session.
4. In that evidence directory, `transport.jsonl` records the actual channel REQ:
   default has the agent's `#p` plus channel `#h`; disabled mode has `#h` without
   `#p`. The membership-notification REQ retains its own `#p` in both modes.
5. Both `*.signed-events.json` files contain the accepted plain and mention
   events, including full IDs, tags and signatures. The adapter JSONL captures
   requests and responses; harness logs show successful steering acknowledgements.
6. The final transport record is `cleanup_complete` with
   `containers_removed: true` and `errors: []`. Check the isolated fixtures are
   gone with `docker ps -a --filter name=buzz_steering --format '{{.Names}}'`.

If startup retries occur, inspect the per-attempt relay logs. A failed command,
assertion, timeout, nonzero exit or cleanup error is a failure, even if an earlier
case printed `pass: true`.

## Persona editor

Using the repository's configured local-development environment, run `just dev`
from this PR checkout (see CONTRIBUTING.md for infrastructure and `.env` setup).
In the resulting desktop app:

1. Open Agents, open one of your editable agents, and choose Edit.
2. Expand Advanced and locate Conversation context.
3. Read the adjacent guidance: with default settings, mention the agent to steer
   current channel work; plain thread replies do not steer the current turn and
   may appear as context on a later mention.
4. Focus Conversation context with the keyboard. Its accessible description
   must include both context-isolation help and the steering guidance.
5. Switch between Channel and Thread context. The isolation description changes;
   the qualified steering guidance remains visible. Cancel the editor.

Report the tested PR revision, relay runner exit/results, evidence directory,
and whether the desktop guidance/accessibility steps passed. Do not mark human
verification complete until that explicit report exists. This regression proves
transport and ACP delivery; it does not assert that a real LLM obeys the input.

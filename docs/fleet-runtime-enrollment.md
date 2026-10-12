# External runtime enrollment

`buzz agents enroll` is owner-side provisioning for a real external runtime.
It is an integration primitive, not a running agent or a replacement for
Factory scheduling. Initial targets are macOS local sessions and Linux Herdr
and Factory sessions.

The launcher supplies the provider's actual stable runtime ID. Display names
are not identities. Keep the same private state directory across restarts:

```sh
buzz agents enroll \
  --state-dir "$PRIVATE_FLEET_STATE" \
  --channel "$BUZZ_CHANNEL_ID" \
  --runtime-id "$ACTUAL_RUNTIME_ID" \
  --cohort local \
  --display-name 'Local agent'
```

The existing `BUZZ_PRIVATE_KEY` is the provisioning owner's key. An agent
carrying `BUZZ_AUTH_TAG` cannot provision other agents. The owner must already
have community membership and permission to add bots to the chosen channel.
The command creates neither the community nor the channel.

The state directory must be private (0700), with an existing parent directory.
The command persists a new keypair, NIP-OA delegation and exact signed profile,
managed-agent directory and membership events before publishing. Concurrent
starts converge on the first persisted identity. Retry the same invocation
after transport failure; do not delete the state or mint a replacement key.
Changing the channel on an existing binding is refused. Subsequent launches
retain the first display name, even if their task label changes; enrollment
never silently renames an existing agent.

The public receipt contains the agent pubkey, cohort, runtime ID, channel,
owner, signed event IDs, and `credentials_file`. Only that credential file
belongs in the runtime's protected credential staging path. It contains the
agent's key and delegation, not the owner's key or owner-signed provisioning
commands. Never print, commit, attach, or place either private file in a task
workspace. The owner's provisioning journal stays with the owner.

A successful enrollment verifies the relay's signed current membership
snapshot using the NIP-11 `self` key. This confirms channel access; it does
not claim the agent is online or has received a message. The runner must still
bind that identity to its actual provider session and implement message
receipt, continuation and reply through the existing bridge.

## Delivery status and acceptance

CLI prerequisite: [DEV-12836](https://linear.app/verticalint/issue/DEV-12836/).
Fleet implementation and acceptance: [DEV-12832](https://linear.app/verticalint/issue/DEV-12832/).
Existing publisher rollout: [DEV-12830](https://linear.app/verticalint/issue/DEV-12830/).
Existing prompt-context delivery: [DEV-10852](https://linear.app/verticalint/issue/DEV-10852/).

The three-runtime acceptance is **pending**. Required evidence:

1. Local native session appears in telemetry and enrolls through its lifecycle.
2. Herdr's actual remote session enrolls on attach/resume.
3. Factory's Herdr-based Pi worker enrolls from its native task loop with its
   canonical run ID; an interactive remote shell is not a substitute.
4. All three receive signed Buzz peer messages, perform the shared bounded
   task, and reply without human copy-and-paste.
5. Event IDs correlate to runtime receipt and action evidence. A relay ACK or
   visible profile alone does not satisfy this criterion.
6. Restart/reconnect retains identity and does not repeat completed actions;
   rejected authors and revoked membership cannot gain control.

Current tests cover durable provisioning and its HTTP production seam. These
are not evidence of live enrollment, runtime delivery, a protected deployment,
or completion of the three-runtime acceptance.

The shared service acceptance additionally requires four stable Factory-hosted
roles: Tools Orchestrator, Tools Engineering, Tools Marketing and Tools Sales.
Execution, Tools installation, credentials and task/workspace lifecycle belong
to Factory's existing system. Nico must use only Buzz to send an authenticated
request, have the actual Factory runtime perform a bounded useful task, and
receive its reply in the same thread while the owner's local Tools agents are
verified stopped. Record signed request/reply IDs, runtime receipt and action
evidence, Factory run/workspace IDs, stopped-process evidence, and restart
continuity/deduplication. Never substitute a fixture or impersonation for Nico's
action. Preserve the four existing identities until that migration is proven.

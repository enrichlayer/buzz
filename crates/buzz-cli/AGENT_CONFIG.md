# Declarative OpenRig enrollment

`buzz agents config` binds durable Buzz identities to existing OpenRig seats.
It uses the current relay and its Postgres event store. It never launches a
process or changes a rig. The existing protected runtime operator owns the
handoff, canonical spec validation, runtime policy and deployment.

The strict JSON manifest contains public configuration. Keep credentials out
of it. Unknown fields, including inline credentials, environment maps, shell
commands and purported runtime receipts, are rejected. This is a structural
guard, not detection of secrets pasted into arbitrary text fields.

```json
{
  "version": 1,
  "relay": "https://buzz.example.com",
  "owner": "<64-character-owner-public-key>",
  "channel": "<existing-shared-channel-uuid>",
  "runtime": {
    "cohort": "openrig",
    "rig_id": "<existing-rig-id>",
    "rig_spec": {"path": "engineering.rig.yaml", "sha256": "<sha256>"},
    "agent_specs": [{"path": "manager.agent.yaml", "sha256": "<sha256>"}]
  },
  "agents": [{
    "key": "engineering-manager",
    "seat": "engineering.manager",
    "runtime_id": "<stable-runtime-id-from-existing-enrollment>",
    "display_name": "Engineering Manager",
    "adoption": {"expected_pubkey": "<verified-existing-agent-public-key>"},
    "invocation": {
      "respond_to": "allowlist",
      "allowlist": ["<authorized-teammate-public-key>"]
    }
  }]
}
```

All placeholders must be replaced before validation. Spec paths are relative
to the manifest directory and must remain contained there. Pin the SHA-256 of
each exact file (`shasum -a 256 <file>`). AgentSpec and RigSpec remain OpenRig's
canonical schemas: models, effort, roles, prompts, pods, edges and lifecycle
belong there. This CLI checks the reference bytes and the Buzz wrapper; it
does **not** claim those specs passed OpenRig's canonical validator or that
`seat` exists. The protected operator must verify the spec import closure,
profile/runtime resolution and exact qualified seat before using a handoff.

There are 1–64 agents and 1–64 AgentSpec references. Manifests are bounded to
128 KiB and each referenced spec to 1 MiB. A state directory retains at most
1024 entries before refusing new intents; no recovery evidence is deleted
automatically. The operator must reconcile/archive old state deliberately.

For a genuinely new identity, set `adoption` to `null`. For an existing
identity, supply the exact public key and use the **existing private enrollment
state directory**. A public directory snapshot or matching name cannot recover
or adopt a private identity. The first apply records an immutable stable key,
public key, community, owner, channel, cohort, runtime ID, rig ID and seat.
Changing those bindings or losing a recorded journal refuses replacement.
Original display names are preserved. Configuring another state directory is
not a migration procedure; keep the original private state under its owner.

```sh
# Local only: no credentials, network requests or file creation.
buzz agents config validate --file agents.json

# Owner credentials come through Buzz's existing CLI authentication.
# Reuse the existing private (0700) enrollment directory; do not copy keys into
# a checkout, manifest, screenshot, runtime prompt or public handoff.
buzz agents config plan --file agents.json --state-dir /private/enrollment
# Save plan_sha256 from this output, inspect the plan, then:
buzz agents config apply --file agents.json --state-dir /private/enrollment \
  --plan '<plan_sha256>'
buzz agents config status --file agents.json --state-dir /private/enrollment
```

Planning and status are read-only and require the expected owner and community.
Delegated agents cannot provision or change the configuration. Apply obtains an
exclusive local file lock, re-reads the plan, and refuses a stale digest before
publishing. Identity and exact signed event intents are persisted before their
network writes. Rerun `plan` after any partial failure, then `apply` the fresh
digest: it resumes the same identity and exact pending policy event. It does
not replay completed provisioning when membership was revoked or the directory
was removed. A conflicting pending policy retains its journal for owner
inspection rather than generating another event automatically.

Desired state is separate from an application generation. After A completes,
applying B and then returning to A under a fresh approved plan creates a new
intent bound to B's current head. Exact pending intents remain fenced: changing
the desired configuration cannot discard an unconfirmed publication. Completed
readback history is synced before the active progress pointer advances.

An apply can publish a prefix before a later step fails. There is no distributed
transaction across Nostr events. NIP-33 also has no conditional write: apply
checks the current directory immediately before publication and requires exact
signed head readback afterward. Keep one publishing owner; a concurrent writer
can be detected but cannot be made atomic by this command. Durable journals
retain every effect needed for reconciliation. Permissions protect against
other accounts; they do not isolate processes running as the same user.

`configuration_applied: true` means the Buzz profile, current membership and
requested directory policy were read back and a signed handoff was recorded.
The output separately leaves canonical spec validation, protected runtime,
effective runtime policy, presence and messaging evidence pending/unknown.
Status never imports a caller-supplied runtime receipt or promotes the local
handoff into runtime proof. `handoff_current` reports whether the latest signed
handoff still names the current directory, profile and membership heads; a fresh
plan/apply records updated heads without republishing an already matching policy.

## Invocation policy

Choose `owner-only`, `allowlist` or `anyone` explicitly. `allowlist` requires
1–64 distinct public keys; other modes require an empty list. Channel ACLs
still apply. Directory visibility is not permission to invoke an agent.

For an ACP runtime the protected operator must project the signed directory
policy into `BUZZ_ACP_RESPOND_TO` and `BUZZ_ACP_RESPOND_TO_ALLOWLIST`, respecting
`BUZZ_ACP_ALLOWED_RESPOND_TO`, and verify the effective values on the next body.
Changing the directory does not change a running ACP gate or prove revocation.
Native OpenRig seats require their existing host request authorization path;
ACP flags do not control a native seat. ACP DMs remain owner/sibling-only even
when channel invocation uses `anyone` or `allowlist`. Use a qualified shared
channel for team operation. Do not assume the operator feed is that channel.

## Protected-host handoff contract

Apply writes an immutable signed generation in
`config-<manifest_sha256>-<handoff_sha256>.handoff.json`, then atomically updates
the latest copy at `config-<manifest_sha256>.handoff.json` in private state.
The output's `handoff_generation_file` and `handoff_sha256` identify the exact
generation for managed custody; earlier signed generations remain intact:

```text
{
  handoff: {
    version: 1,
    operation: "openrig-runtime-handoff",
    manifest_sha256, relay, owner, channel,
    runtime: {cohort, rig_id, rig_spec, agent_specs},
    membership_event,
    agents: [{key, seat, runtime_id, pubkey, display_name,
              invocation, policy_sha256, directory_event, profile_event,
              enrollment_events: {profile, directory, membership}}],
    verification: {canonical_spec_validation: "pending_protected_operator",
                   protected_runtime: "pending_protected_operator",
                   effective_runtime_policy: "pending_protected_operator",
                   presence: "unknown", messaging_evidence: "not_verified"}
  },
  authorization: <owner-signed Nostr event>
}
```

`authorization` is a standard kind:1 signed note retained **locally only**. Its
content is the exact JSON handoff and its sole tag is
`["t", "buzz-agent-config-handoff-v1"]`. No new relay event kind or HTTP
endpoint is introduced. `policy_sha256` hashes compact JSON serialization of
`invocation` with field order `respond_to`, `allowlist`; `manifest_sha256`
hashes this CLI's normalized typed manifest serialization, not the source JSON
whitespace. Preserve the original manifest through the existing custody path
when the protected host needs to recompute that digest. The persisted
`config-<manifest_sha256>.intent.json` contains those exact normalized bytes.
`handoff_sha256` hashes the UTF-8 bytes of `authorization.content`, so the host
can verify the generation without reproducing JSON field ordering.

The protected operator must:

1. Obtain the envelope through its existing managed custody path. Verify the
   signature, kind, tag/domain and exact content, then compare its owner,
   community, channel, rig, identity bindings and digests to **independently
   authorized expected scope**. A public artifact and its self-declared owner
   are not arbitrary launch or policy authority. No owner key is handed over.
2. Run OpenRig's canonical validators and check the complete referenced import
   closure, seat bindings, model/effort, allowed request authors and existing
   deployment/recovery holds. Reject stale or conflicting generations.
3. Independently read the signed Buzz profile, owner-authored directory and
   relay-authored channel membership. The enrollment membership ID is the
   original add-member command; `membership_event` is the current signed
   kind:39002 materialized state. Do not confuse either with presence.
4. Use the existing protected lifecycle owner and managed runtime adapter. Keep
   existing keys, rig, durable Postgres state and original identities. Deliver
   only the enrolled runtime credential through its existing private custody;
   never stage the owner-signed provisioning journal into native seats.
5. Produce independent effective-policy and runtime evidence. Exercise an
   authorized non-owner teammate's same-thread reply, a denied author,
   delegation/adjudication, same-identity restart and manager reporting through
   the existing parent pilot acceptance work. A deploy ACK is insufficient.

This first CLI slice has no protected-host receipt ingestion protocol. The
existing operator owns live qualification and reports those results separately.
Do not perform a live apply against placeholder or unqualified channels.

## Offline handoff verification

A protected host can verify the public contract with no relay credentials,
network calls or enrollment-state reads/writes:

```sh
buzz agents config verify-handoff --file agents.json \
  --handoff config-<manifest_sha256>-<handoff_sha256>.handoff.json \
  --expected expected-public-scope.json
```

The operator supplies `expected-public-scope.json` independently through existing
managed custody. Do not derive its authority or generation pins from an untrusted
handoff, filename or directory lookup. Its strict schema is:

```json
{
  "version": 1,
  "relay": "https://buzz.example.com",
  "owner": "<expected-owner-pubkey>",
  "channel": "<existing-channel-uuid>",
  "cohort": "openrig",
  "rig_id": "<existing-rig-id>",
  "handoff_sha256": "<selected-signed-content-sha256>",
  "authorization_event_id": "<selected-authorization-event-id>",
  "agents": [{
    "key": "engineering-manager",
    "seat": "engineering.manager",
    "runtime_id": "<qualified-runtime-id>",
    "pubkey": "<independently-qualified-buzz-public-key>"
  }]
}
```

The scope must name exactly the configured Buzz communicators, with normalized
relay/channel values and no extra fields. A single manager is sufficient. Private
pod workers need no Buzz identity. Existing Buzz identities require exact adoption
and retained custody; genuinely first enrollment may use `adoption: null` after
the operator qualifies absence/custody and then independently verifies the new
key through the existing enrollment path. This verifier never provisions a key
and cannot establish that absence or credential ownership itself.

The command checks exact spec file bytes, normalized typed manifest and policy
digests, Nostr event ID/signature, kind/domain, complete signed payload and selected
identity/scope/generation equality. Expected scope is bounded to 128 KiB, handoff
envelopes to 512 KiB; existing manifest/spec bounds still apply. It hashes the
original UTF-8 signed content, so host JSON serialization cannot change its
generation identity. It emits `signed_configuration_verified`, digests and the
minimal public identity/policy/head projection.

Verification is **offline**: canonical imports/models/effort, native custody,
current signed relay heads, stale/replay activation fencing, runtime and effective
policy remain pending or not verified in the output. A pinned generation can be
historical. No author classification, mention authority, recovery release or
activation follows from this command. The existing protected owner performs those
checks and atomically binds the selected generation in its host authorization
path. The command adds no runtime receipt ingestion protocol.

## Authenticated signed head verification

After offline verification, the same public inputs can be checked against the
independently selected community through the existing authenticated Buzz client:

```sh
buzz agents config verify-heads --file agents.json \
  --handoff config-<manifest_sha256>-<handoff_sha256>.handoff.json \
  --expected expected-public-scope.json
```

Use the existing managed reader credential and normal CLI auth configuration.
An enrolled manager can read this state; the owner provisioning key is not
required. The command takes no enrollment state directory and does not read or
write enrollment journals, enroll identities, publish events or launch anything.
It performs the unchanged offline checks first and requires the authenticated
client's relay URL to equal the independently pinned community URL before reads.

It uses existing strong queries to obtain the selected agent's signed kind:0
profile, the **expected owner's** kind:30177 directory and the relay's kind:39002
channel membership. The relay signing key is resolved through the existing
community URL's relay-info read. Every head must have a valid event ID/signature,
expected author/kind/address, and the exact ID selected by the handoff. Missing or
ambiguous responses fail. Both the owner and every configured communicator must
remain channel members. Directory policy must exactly match the manifest's
`respond_to` and ordered allowlist, with its existing name/parallelism checks.
This checks the public policy; it does not classify allowlisted keys as humans,
peers or mention targets, or establish native effective policy. Existing producer
policy modes are preserved; a native requirement for finite author authority
still requires the protected host's finite policy qualification.

Success adds `current_signed_heads_match: true`, `observed_heads` with exact
verified membership/profile/directory IDs and authors, and
`verification.current_heads: "matched_sequential_strong_reads"`. The signed
artifact remains unchanged. These are sequential observations, not an atomic
relay snapshot: a head can change after its read. The selected digest proves
artifact authenticity and selection, not recency or replay prevention.
`generation_freshness` remains `not_verified`; native custody, canonical native
spec/import validation, runtime, effective policy and activation remain pending.
The existing protected owner must revalidate the relevant authority and bind
the chosen generation atomically in its activation/request authorization path.
This command adds no activation store, recovery release or runtime receipt.

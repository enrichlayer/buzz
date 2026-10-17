# Factory-hosted Buzz pilot

This is a separate, closed-membership relay at `wss://buzz-pilot.enrichlayer.com`.
It uses Factory's persistent-service pattern: `infractl` packages, Podman
Quadlets, systemd, Vault, and managed Cloudflare Tunnel ingress on
`ovh-us-east-vin-1b`. Factory Computer workspaces remain the place for temporary
authoring and validation; their expiring previews are not the shared relay.

Desktop/mobile clients and remote agents connect to the same relay. The web
content bundled in the relay is the repository browser, not the desktop chat
application. This pilot does not migrate the existing team community or agents.

## Storage and resource placement

| Data | Location |
| --- | --- |
| Published relay images | Existing remote GitHub Actions build and GHCR |
| Build intermediates and desktop releases | Existing DEV-12632 R2 workflow |
| Events and membership | Dedicated remote Postgres volume |
| Pub/sub and Redis persistence | Dedicated remote Redis volume |
| Git working storage | Dedicated remote Podman volume |
| Media and object storage | Private `buzz-pilot-media` R2 bucket |

No image build, image pull, Postgres, Redis, or Docker daemon is needed on the
laptop. The package caps the three containers at 3.5 CPUs and 3.375 GiB total;
these are limits, not measured consumption. This is a single-host pilot, not an
HA service. Volumes survive package removal but are not a backup. Before storing
irreplaceable data, arrange and restore-test off-host Postgres and git backups.

## Admission and configuration

Use the existing `.github/workflows/docker.yml` release image and qualification
receipt. Verify its provenance and deployment-eligibility attestations against
`enrichlayer/buzz`, that workflow, the exact source revision, and the exact OCI
digest. A successful build alone is not the deployment-eligibility receipt.
Supply full digest references, never tags, for Buzz, Postgres 17 and Redis 7.
Use the Debian Redis variant (uid 999); its data volume is owned by that uid.
The controller verifies all three running container image IDs and the relay's
intrinsic `/_status` source revision after startup.

Provision the bucket through `operations/infrastructure` OpenTofu CI. Do not
enable a public R2 domain. Create a bucket-scoped object read/write credential
and store it at `secret/r2/buzz-pilot-media` with fields `endpoint`,
`access-key-id`, and `secret-access-key`. Do not reuse build or release tokens.

Create `secret/service/buzz-relay-pilot/runtime` through Vault's create-only
write path, with these fields:

- `owner-public-key`: the agreed operator's 64-character hex Nostr public key.
- `relay-private-key`: stable Nostr signing key, separate from the owner's key.
- `git-hook-secret`, `postgres-password`, `redis-password`: independent random
  32-byte values, encoded as 64 lowercase hex characters.

Store a dedicated GHCR pull-only identity's Podman auth JSON under field
`auth-json` at `secret/service/buzz-relay-pilot/registry`. It must contain only
the `ghcr.io` entry. This root-only file stays on the host, outside containers.
Never deploy a human's general GitHub token or the CI publishing token.

Use secret input over stdin, not shell arguments. Preserve these records across
re-deployments. Changing a database password in Vault does not rotate the
password inside an initialized Postgres volume; perform a coordinated database
rotation before changing the package environment.

## Apply through infrastructure tooling

Use the canonical infrastructure Nix environment and normal reviewed deploy
path. The package entrypoint is `.deploy/manifest.yaml`; its defaults are loaded
from `.deploy/defaults/main.yaml`. Supply these nonsecret deployment variables:

```yaml
buzz_pilot_image: ghcr.io/enrichlayer/buzz@sha256:<verified-release-digest>
buzz_pilot_source_sha: <full-source-commit>
buzz_pilot_postgres_image: docker.io/library/postgres@sha256:<verified-17-digest>
buzz_pilot_redis_image: docker.io/library/redis@sha256:<verified-7-debian-digest>
```

`infractl` renders the package with Vault lookups and applies it to the manifest's
host. Rendered bundles contain secrets: keep them in the normal protected
deployment transport, never commit them or publish them as CI artifacts.
The post-install controller validates configuration, pulls all images before
restarting any services, starts dependencies, waits for readiness, and verifies
identity. It has a 510-second overall budget within the package hook's 540 seconds.
A failed deployment remains failed; inspect its package record and service
journals, repair the cause, and reapply the same admitted configuration.

Only after private startup verification, create ingress with the existing
`infractl tunnel create .deploy/tunnel.yaml` workflow. Its `access: false` is
specific to this new Nostr service: native clients authenticate using signed
Nostr events and relay membership. Do not change the Factory dashboard's Access
policy. Postgres, Redis, health and metrics have no host port mappings; the
relay origin binds only `127.0.0.1:13415`.

## Membership and connection

The configured owner is bootstrapped by the relay. Add each approved human or
agent public key through the existing admin command. Serialize these commands
to avoid concurrent membership snapshot writes:

```bash
sudo flock /run/buzz-relay-pilot-membership.lock \
  podman exec buzz-relay-pilot buzz-admin add-member --pubkey <approved-public-key>
sudo podman exec buzz-relay-pilot buzz-admin list-members
```

Add the pilot URL as a community in Buzz. Agents use their own existing key
custody and `BUZZ_RELAY_URL=https://buzz-pilot.enrichlayer.com`; never distribute
the relay or owner signing key. A successfully authenticated connection still
needs community/channel membership for channel reads and writes.

## Acceptance, recovery, and review

Run `python deploy/factory/test_pilot.py` with Jinja2 3.1.6 and PyYAML 6.0.3.
The dedicated GitHub workflow runs these deployment-contract tests. They do not
prove a live deployment, external WSS, R2 authorization, or restart persistence.
Record the following separately before calling the pilot usable:

1. Source-bound CI, image attestations, remote package apply and native identity.
2. External TLS/NIP-11 and a signed NIP-42 WebSocket connection.
3. An admitted agent publishes and reads a message in its test channel; an
   unregistered key cannot publish or read private channel history.
4. An admitted user uploads and downloads a small fixture through Blossom; an
   unauthorized user cannot fetch it. Delete only the fixture created by this test.
5. Restart the relay and dependencies, reconnect, and read the same message and
   fixture. Record stable relay identity and remote resource use.
6. A human connects their own client and repeats the message flow. Keep the PR
   draft until the repository's review and human-testing checklist is satisfied.

To recover, reapply the previous reviewed package with its admitted image
digests, stable secrets and the same volumes. Schema migrations can make an
older binary incompatible: restore a tested backup into separate recovery
volumes when needed, rather than downgrading a live database blindly. Package
removal stops services and preserves data; withdraw the managed tunnel when
retiring the pilot. Never prune shared-host images or volumes as part of this
deployment.

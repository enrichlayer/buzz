# Linear project sync worker

This worker runs `scripts/linear-sync.mjs` on Temporal. Source data and the signed
outbox stay on the worker's private persistent volume. Workflow history contains
only counts and observation timestamps. The worker does not write to Linear.

The initial scope is DEV-13285: Tools and standardization, mirrored to the
owner's private Buzz channel. Deployment and real-source acceptance are pending;
adding this package does not start a worker or copy issues.

## Runtime contract

- Build `workers/linear-sync/Dockerfile` on Linux through the Linear Sync Worker
  GitHub workflow. Admit the resulting digest and exact source revision before
  deployment; a `review-*` image is a candidate, not a production release.
- Run one worker on the pilot's managed remote host with a persistent volume at
  `/data`, owned by uid 1000. Never run replicas with separate outbox volumes on
  the same queue. The SQLite writer lock also serializes overlapping processes
  sharing this volume; process death releases the lock.
- Mount a read-only JSON config at `/config/sync.json`, mode 0600, with `profile`,
  `workspace`, `projectId`, `relay` (HTTPS origin), `channel`, `signer` (dedicated
  integration pubkey), `directory` (`/data/outbox`) and optional `maxRecords`
  (default 250). These are explicit identities, never inferred from titles.
- Supply `BUZZ_LINEAR_CONFIG_FILE`, `LINEAR_API_TOKEN`, `BUZZ_PRIVATE_KEY`,
  `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, and `TASK_QUEUE` through the protected
  service environment. Use a dedicated read-only Linear credential and a separate
  Buzz publisher key in Vault. Never export an installed desktop identity.
- Provision the integration's community and private-channel membership through
  the normal authorized admin/owner flow before publishing. Private visibility
  alone does not establish the intended audience; read back the member list.

Use an isolated queue such as `buzz-linear-dev13285-private`. Activity concurrency
is one. Each activity has a 21-minute deadline (15-minute bounded source scan plus
bounded publication) and cancellation reaches child CLI processes. Retries are
bounded to three attempts. Each workflow drains at most 200 batches, then fails
visibly with its outbox retained. Shutdown is recoverable through that same outbox.

## Schedule and acceptance

The `.deploy/manifest.yaml` package uses the pilot's existing infractl/Quadlet
pattern on `ovh-us-east-vin-1b`; it does not modify the relay package. It requires
the admitted `buzz_linear_sync_image` digest, `buzz_linear_sync_signer`, and
dedicated Vault runtime/registry records. Provision them through the normal
credential and membership flow. The service has a read-only root filesystem,
bounded resources and crash restart rate, and a separate persistent volume.
Apply through the reviewed infrastructure tooling; verify image identity and the
isolated Temporal poller afterward. No deployment or credential is created by CI.

Set `BUZZ_LINEAR_SCHEDULE_ID` equal to the queue and run
`node schedule.cjs create-paused` inside the managed container. This creates a
paused 15-minute schedule and refuses to overwrite an existing one. The schedule
skips overlaps and has a 24-hour execution budget. A failed run stays failed;
the next scheduled run resumes its durable outbox.

Before unpausing, trigger one run through the normal Temporal operator tooling.
Verify the actual destination records, source issue count, source update, exact
event replay after interruption, persisted restart, and denial for a second Buzz
user who is not a member. Inspect the worker's `health.json` privately. Then
exercise task → coding thread → commit/review → task in the updated native app.
Only after those checks should the operator unpause this isolated schedule.

Keep the existing relay and desktop release owners in control of their artifacts.
The relay must support kinds 30623 and 30624 before this worker can publish.

## Tests

`npm ci --ignore-scripts` in this directory, then `npm test` checks configuration.
`npm run test:temporal` runs a real Temporal test server and validates activity
retry, continuation and private-output projection. Run these in remote CI.
The source/outbox tests also run there, including killed-process recovery.
These tests do not establish live Linear credentials, Buzz membership, deployed
sync, or installed-app acceptance.

Reference: [Temporal TypeScript guide](https://docs.temporal.io/develop/typescript).
